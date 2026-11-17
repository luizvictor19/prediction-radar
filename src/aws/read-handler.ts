import { DigestError, estimateCostUsd, runDigest, type DigestResult } from '../digest/digest.js';
import type { RecordOutcome } from '../digest/persist.js';
import { buildDigestRows, type DigestRows } from '../digest/rows.js';
import type { MarketToDigest } from '../digest/store.js';
import type { CompletionResult, LlmClient } from '../llm/client.js';
import { DEFAULT_MODEL_ROUTES, routeFor, type ModelRoute } from '../llm/registry.js';
import { captureCalls } from './capture.js';
import {
  ConditionalCheckFailed,
  monthOf,
  readingKey,
  type RawReading,
  type RecordStore,
} from './record-store.js';

/**
 * One reading of one rule, as one Lambda invocation (issue 93, PR 2 of issue 86).
 *
 * The order is the design (plan on issue 86, Decisions):
 *
 * 1. Check Supabase: the reading is already there (`ALREADY_DONE`), or the rule
 *    text changed since the plan handler saw it (`STALE`).
 * 2. Check DynamoDB: a raw item for this exact key means an earlier attempt of
 *    this same task already paid. Replay it instead of calling the model.
 * 3. Check the monthly cap, then call the model.
 * 4. Put the raw item (conditional) and add its cost to the month's counter,
 *    whether the output is valid or not: an invalid output was billed too.
 * 5. Write the reading to Supabase in one transaction (`recordDigest`).
 *
 * A failure in step 5 throws, so Step Functions retries the task, and the retry
 * reaches step 2 and replays: the model is called at most once per input. Model
 * and validation failures are returned as reason codes, not thrown, so they
 * are not retried: the market stays in the queue and the next run reads it.
 */

export interface ReadInput {
  event_id: string;
  sha256: string;
  /** The run's start instant (ISO), from the Step Functions input. Part of the raw item key. */
  run_started_at: string;
  model: string;
  prompt_version: string;
  timeout_ms: number;
}

export type ReadReason =
  | 'OK'
  | 'ALREADY_DONE'
  | 'REPLAYED'
  | 'STALE'
  | 'SCHEMA_INVALID'
  | 'TRUNCATED'
  | 'BUDGET'
  | 'TIMEOUT'
  | 'REFUSED'
  | 'MODEL_ERROR'
  | 'CONFIG_ERROR'
  | 'INCOMPLETE';

export interface ReadResult {
  reason: ReadReason;
  event_id: string;
  sha256: string;
  cost_usd: number | null;
  /**
   * Traps the guard removed (passage not in the rule, too short, repeated),
   * `null` when no output was parsed.
   */
  pruned: number | null;
}

/**
 * What Supabase says about this reading before anything is paid.
 *
 * `todo` carries the market as it is NOW, so the text sent to the model is the
 * one whose hash the plan saw, checked, and not a later edit.
 */
export type ReadingCheck =
  | { status: 'done' }
  | { status: 'stale' }
  | { status: 'todo'; market: MarketToDigest };

export interface ReadDeps {
  checkReading(key: {
    eventId: string;
    sha256: string;
    model: string;
    promptVersion: string;
  }): Promise<ReadingCheck>;
  store: RecordStore;
  clientForRoute(route: ModelRoute): LlmClient;
  persist(rows: DigestRows): Promise<RecordOutcome>;
  monthlyCapUsd: number;
  routes?: Readonly<Record<string, string>>;
  now?: () => Date;
  log?: (line: string) => void;
}

const COMPONENT = 'aws_digest_read';

class Deadline extends Error {}

function withDeadline<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Deadline()), ms);
  });
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer));
}

/**
 * Maps the digest failure codes onto the causes an operator acts on.
 *
 * `truncated` is its own code and not `BUDGET` (the experiment of PR 82 merged
 * them): truncation asks for a larger token ceiling, an exhausted cap asks for
 * money or patience. One code for both would send the operator to the wrong fix.
 */
export function reasonFor(code: DigestError['code']): ReadReason {
  switch (code) {
    case 'truncated':
      return 'TRUNCATED';
    case 'refusal':
      return 'REFUSED';
    case 'api_error':
      return 'MODEL_ERROR';
    case 'unknown_model':
    case 'unknown_prompt':
    case 'unknown_provider':
      return 'CONFIG_ERROR';
    case 'not_json':
    case 'schema':
    case 'sem_resolve_sim':
    case 'severidade_invalida':
    case 'tipo_invalido':
    case 'opiniao':
    case 'no_text':
      return 'SCHEMA_INVALID';
  }
}

function isWellFormed(input: ReadInput): boolean {
  const texts = [
    input.event_id,
    input.sha256,
    input.run_started_at,
    input.model,
    input.prompt_version,
  ];
  return (
    texts.every((t) => typeof t === 'string' && t.length > 0) &&
    Number.isFinite(input.timeout_ms) &&
    input.timeout_ms > 0
  );
}

function replayClient(stored: RawReading): LlmClient {
  return {
    complete: (): Promise<CompletionResult> =>
      Promise.resolve({
        text: stored.raw_text,
        stop: stored.stop,
        usage: {
          input: stored.tokens_input,
          output: stored.tokens_output,
          cacheRead: stored.tokens_cache_read,
          cacheWrite: stored.tokens_cache_write,
        },
      }),
  };
}

export function createReadHandler(deps: ReadDeps): (input: ReadInput) => Promise<ReadResult> {
  const routes = deps.routes ?? DEFAULT_MODEL_ROUTES;
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? ((line: string) => console.log(line));

  return async (input) => {
    const startedAt = Date.now();
    let cost: number | null = null;
    let replayed = false;
    let pruned: number | null = null;

    const finish = (reason: ReadReason): ReadResult => {
      log(
        JSON.stringify({
          component: COMPONENT,
          reason,
          event_id: input.event_id,
          sha256: input.sha256,
          model: input.model,
          prompt_version: input.prompt_version,
          replayed,
          pruned,
          cost_usd: cost,
          latency_ms: Date.now() - startedAt,
        }),
      );
      return { reason, event_id: input.event_id, sha256: input.sha256, cost_usd: cost, pruned };
    };

    if (!isWellFormed(input)) return finish('CONFIG_ERROR');
    const route = routeFor(input.model, routes);
    if (route === null) return finish('CONFIG_ERROR');

    const check = await deps.checkReading({
      eventId: input.event_id,
      sha256: input.sha256,
      model: input.model,
      promptVersion: input.prompt_version,
    });
    if (check.status === 'done') return finish('ALREADY_DONE');
    if (check.status === 'stale') return finish('STALE');
    const market = check.market;

    const digestOf = (client: LlmClient): Promise<DigestResult> =>
      runDigest({
        model: input.model,
        promptVersion: input.prompt_version,
        timeoutMs: input.timeout_ms,
        client,
        input: market.input,
      });

    const key = readingKey(input.sha256, input.run_started_at, input.event_id);
    const stored = await deps.store.getReading(key);

    let result: DigestResult;
    if (stored !== null) {
      replayed = true;
      try {
        result = await digestOf(replayClient(stored));
      } catch (err) {
        if (err instanceof DigestError) return finish(reasonFor(err.code));
        throw err;
      }
      result = { ...result, latencyMs: stored.latency_ms };
    } else {
      const month = monthOf(now());
      if ((await deps.store.readSpend(month)) >= deps.monthlyCapUsd) return finish('BUDGET');

      const capture = captureCalls(deps.clientForRoute(route));
      let failure: unknown = null;
      let digested: DigestResult | null = null;
      try {
        digested = await withDeadline(digestOf(capture.client), input.timeout_ms);
      } catch (err) {
        failure = err;
      }

      const call = capture.calls()[0];
      if (call !== undefined) {
        cost = estimateCostUsd(input.model, call.completion.usage);
        try {
          await deps.store.putReading({
            ...key,
            event_id: input.event_id,
            sha256: input.sha256,
            model: input.model,
            route: `${route.provider}:${route.modelId}`,
            prompt_version: input.prompt_version,
            raw_text: call.completion.text,
            stop: call.completion.stop,
            tokens_input: call.completion.usage.input,
            tokens_output: call.completion.usage.output,
            tokens_cache_read: call.completion.usage.cacheRead,
            tokens_cache_write: call.completion.usage.cacheWrite,
            cost_usd: cost,
            latency_ms: call.latencyMs,
            recorded_at: now().toISOString(),
          });
        } catch (err) {
          // Another attempt of this same task wrote the key first. Its output is
          // kept; this call was still paid, so its cost is still counted below.
          if (!(err instanceof ConditionalCheckFailed)) throw err;
        }
        await deps.store.addSpend(month, cost ?? 0);
      }

      if (failure instanceof Deadline) return finish('TIMEOUT');
      if (failure instanceof DigestError) return finish(reasonFor(failure.code));
      if (failure !== null) return finish('MODEL_ERROR');
      if (digested === null) return finish('MODEL_ERROR');
      result = digested;
    }
    pruned =
      result.descartes.trechoInexistente +
      result.descartes.trechoRepetido +
      result.descartes.trechoCurto;

    const outcome = await deps.persist(
      buildDigestRows(market, result, input.prompt_version, input.model, 1),
    );
    if (outcome === 'duplicate') return finish('ALREADY_DONE');
    if (outcome === 'incomplete') return finish('INCOMPLETE');
    return finish(replayed ? 'REPLAYED' : 'OK');
  };
}
