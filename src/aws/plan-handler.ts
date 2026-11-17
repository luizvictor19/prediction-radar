import { createHash } from 'node:crypto';

import { hashDescription, knownModel } from '../digest/digest.js';
import { jaDigerido, type DigestedIndex } from '../digest/leituras.js';
import { filterDigestible } from '../digest/queue.js';
import type { MarketToDigest } from '../digest/store.js';
import { DEFAULT_MODEL_ROUTES, routeFor } from '../llm/registry.js';
import { monthOf } from './record-store.js';

/**
 * Builds one scheduled run of the digestion (issue 93, PR 2 of issue 86).
 *
 * It decides WHAT to read and pays for nothing: config, route, the month's
 * spend, the roster, the terminal-status filter, what this model and prompt
 * version already read, and a cap per run. The read handler gets the list as
 * the Step Functions Map input.
 *
 * Model, prompt version and timeout are fixed here, once per run, and travel in
 * every item: a config change in the middle of a run must not make half of it
 * read with one model and half with another.
 */

export interface DigestConfig {
  model: string;
  promptVersion: string;
  timeoutMs: number;
}

export interface PlanInput {
  /** The execution start instant, from the scheduler. The clock is the fallback. */
  run_started_at?: string;
}

export interface PlanItem {
  event_id: string;
  sha256: string;
}

export interface PlanResult {
  reason: 'OK' | 'CONFIG_ERROR' | 'BUDGET';
  run_started_at: string;
  model: string;
  prompt_version: string;
  timeout_ms: number;
  items: PlanItem[];
}

export interface PlanDeps {
  readConfig(): Promise<DigestConfig>;
  readSpend(month: string): Promise<number>;
  readMarkets(): Promise<MarketToDigest[]>;
  readDigested(): Promise<DigestedIndex>;
  monthlyCapUsd: number;
  /** At most this many readings per run. 100 keeps a run near 6 minutes. */
  maxItems?: number;
  routes?: Readonly<Record<string, string>>;
  now?: () => Date;
  log?: (line: string) => void;
}

const COMPONENT = 'aws_digest_plan';
const DEFAULT_MAX_ITEMS = 100;

/**
 * The order in which pending markets enter a run: a hash of the run's UTC day
 * and the event id.
 *
 * Not id order. A market whose reading keeps failing (invalid output,
 * truncation, refusal) is never written, so it stays pending; in a fixed order
 * 100 of them at the front would take every run and nothing behind them would
 * ever be read. A different order per day lets the rest through. Same day,
 * same order, so a retried plan task builds the same list.
 */
function rotationKey(day: string, eventId: string): string {
  return createHash('sha256').update(`${day}|${eventId}`).digest('hex');
}

function runStart(input: PlanInput, now: () => Date): string {
  const given = input.run_started_at;
  if (typeof given === 'string' && !Number.isNaN(Date.parse(given))) return given;
  return now().toISOString();
}

export function createPlanHandler(deps: PlanDeps): (input: PlanInput) => Promise<PlanResult> {
  const routes = deps.routes ?? DEFAULT_MODEL_ROUTES;
  const maxItems = deps.maxItems ?? DEFAULT_MAX_ITEMS;
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? ((line: string) => console.log(line));

  return async (input) => {
    const config = await deps.readConfig();
    const base = {
      run_started_at: runStart(input ?? {}, now),
      model: config.model,
      prompt_version: config.promptVersion,
      timeout_ms: config.timeoutMs,
    };

    const finish = (reason: PlanResult['reason'], items: PlanItem[], counts: object) => {
      log(
        JSON.stringify({ component: COMPONENT, reason, ...base, items: items.length, ...counts }),
      );
      return { reason, ...base, items };
    };

    // No route or no price: stop before reading anything else. Without a price
    // there is no spend to count, and without a count the cap is not a cap.
    if (routeFor(config.model, routes) === null || !knownModel(config.model)) {
      return finish('CONFIG_ERROR', [], {});
    }

    const spent = await deps.readSpend(monthOf(now()));
    if (spent >= deps.monthlyCapUsd) return finish('BUDGET', [], { spent_usd: spent });

    const [markets, digested] = await Promise.all([deps.readMarkets(), deps.readDigested()]);
    // `readDigested` answers `tabelaExiste: false` on ANY read error, with
    // whatever pages it got. The table exists in production, so here that flag
    // means a partial index, and a plan built on it would send already-read
    // markets to be read again. Failing the run is the honest outcome.
    if (!digested.tabelaExiste) {
      throw new Error(
        'leitura de market_rule_digests falhou: o índice do que já foi lido veio incompleto',
      );
    }
    const { digestible, discarded } = filterDigestible(markets);

    const pending: PlanItem[] = [];
    let alreadyRead = 0;
    for (const market of digestible) {
      const sha256 = hashDescription(market.input.description);
      const key = {
        eventId: market.eventId,
        descriptionSha256: sha256,
        model: config.model,
        promptVersion: config.promptVersion,
      };
      if (jaDigerido(digested, key)) {
        alreadyRead += 1;
        continue;
      }
      pending.push({ event_id: market.eventId, sha256 });
    }

    const day = base.run_started_at.slice(0, 10);
    const ordered = pending
      .map((item) => ({ item, key: rotationKey(day, item.event_id) }))
      .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
      .map(({ item }) => item);
    const items = ordered.slice(0, maxItems);
    return finish('OK', items, {
      spent_usd: spent,
      roster: markets.length,
      descartados_por_status: Object.fromEntries(discarded),
      ja_lidos: alreadyRead,
      fora_do_corte: pending.length - items.length,
    });
  };
}
