/**
 * Rule digestion as one stateless, Lambda-shaped step.
 *
 * Input `{ rule_text, headline }`, output `{ reason, sha256, findings, pruned }`.
 * The model call and the guard are the production ones (`runDigest`, which runs
 * `parseDigest`): this file adds only what a function boundary needs.
 *
 * - A deadline enforced here, not trusted to the client.
 * - One reason code per outcome, so a dashboard can count failures by cause.
 * - One JSON log line per call.
 * - A write only when the reading is valid.
 *
 * The split the slice demonstrates: the model proposes traps; code decides what
 * survives (schema, closed severity list, verbatim passage, no outcome opinion)
 * and what gets written. Nothing the model returns is executed or trusted as an
 * instruction.
 */
import { DigestError, hashDescription, runDigest } from '../../src/digest/digest.js';
import type { LlmClient } from '../../src/llm/client.js';
import {
  ConditionalCheckFailed,
  partitionKey,
  sortKey,
  type DigestFinding,
  type RecordStore,
} from './store.js';

export interface DigestEvent {
  rule_text: string;
  headline: string;
}

export type ReasonCode =
  | 'OK'
  | 'SCHEMA_INVALID'
  | 'BUDGET'
  | 'TIMEOUT'
  | 'REFUSED'
  | 'MODEL_ERROR'
  | 'CONFIG_ERROR'
  | 'STORE_CONFLICT';

export interface DigestResponse {
  reason: ReasonCode;
  sha256: string;
  findings: DigestFinding[];
  /** Traps the guard removed: passage missing from the rule, too short, or repeated. */
  pruned: number;
}

export interface HandlerDeps {
  /** The model client for a rule. The replay keys on the hash; a live client ignores it. */
  clientFor: (sha256: string) => LlmClient;
  store: RecordStore;
  timeoutMs: number;
  /** The model whose price table bounds the spend. Recordings come from this one. */
  model?: string;
  promptVersion?: string;
  now?: () => Date;
  log?: (line: string) => void;
}

const COMPONENT = 'aws_digest_slice';

class Deadline extends Error {}

/** Maps the production failure codes onto the few causes an operator acts on. */
export function reasonFor(code: DigestError['code']): ReasonCode {
  switch (code) {
    case 'truncated':
      return 'BUDGET';
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

function withDeadline<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Deadline()), ms);
  });
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer));
}

function prunedCount(d: {
  trechoInexistente: number;
  trechoRepetido: number;
  trechoCurto: number;
}) {
  return d.trechoInexistente + d.trechoRepetido + d.trechoCurto;
}

export function createHandler(deps: HandlerDeps): (event: DigestEvent) => Promise<DigestResponse> {
  const model = deps.model ?? 'deepseek-v4-flash';
  const promptVersion = deps.promptVersion ?? 'v4';
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? ((line: string) => console.error(line));

  return async (event) => {
    const sha256 = hashDescription(event.rule_text);
    const startedAt = Date.now();
    let tokens: { input: number | null; output: number | null } = { input: null, output: null };

    const finish = (reason: ReasonCode, findings: DigestFinding[], pruned: number) => {
      log(
        JSON.stringify({
          component: COMPONENT,
          reason,
          sha256,
          latency_ms: Date.now() - startedAt,
          tokens,
          findings: findings.length,
          pruned,
        }),
      );
      return { reason, sha256, findings, pruned };
    };

    let result;
    try {
      result = await withDeadline(
        runDigest({
          model,
          promptVersion,
          timeoutMs: deps.timeoutMs,
          client: deps.clientFor(sha256),
          input: {
            question: event.headline,
            description: event.rule_text,
            slug: null,
            endDate: null,
            outcomes: null,
          },
        }),
        deps.timeoutMs,
      );
    } catch (err) {
      if (err instanceof Deadline) return finish('TIMEOUT', [], 0);
      if (err instanceof DigestError) return finish(reasonFor(err.code), [], 0);
      return finish('MODEL_ERROR', [], 0);
    }

    tokens = { input: result.usage.input, output: result.usage.output };
    const findings: DigestFinding[] = result.output.pegadinhas.map((p) => ({
      severidade: p.severidade,
      trecho: p.trecho,
      texto: p.texto,
    }));
    const pruned = prunedCount(result.descartes);

    try {
      await deps.store.put({
        PK: partitionKey(sha256),
        SK: sortKey(now()),
        model,
        prompt_version: promptVersion,
        headline: event.headline,
        findings,
        pruned,
        tokens_input: result.usage.input,
        tokens_output: result.usage.output,
        cost_usd: result.costUsd,
      });
    } catch (err) {
      if (err instanceof ConditionalCheckFailed) return finish('STORE_CONFLICT', findings, pruned);
      throw err;
    }

    return finish('OK', findings, pruned);
  };
}
