import { hasTerminalStatus } from '../lib/market-status.js';

/**
 * Who enters the queue that PAYS for a model call, and who stays out.
 *
 * Moved from `scripts/lib/fila-digestao.ts` (issue 93) so the scheduled run in
 * `src/aws/` filters with the same function as the manual script, without
 * `src/` importing from `scripts/`. The old path re-exports everything here,
 * and keeps the Portuguese names its callers in `scripts/` use; the
 * names here follow the `src/` rule (English).
 *
 * This module imports no database client, so it is testable without a network.
 */

/** The least this module needs to know about a market. */
export interface FilterableMarket {
  eventId: string;
  status: string | null;
}

export interface QueueSplit<T> {
  digestible: T[];
  /** How many left, by status. A discard nobody counts is lost coverage. */
  discarded: Map<string, number>;
}

/** The bucket label for a market with no readable status. */
export const NO_STATUS = '(nulo/ausente)';

/**
 * Removes the markets whose outcome already arrived.
 *
 * Returns the count of what left together with what stayed: the
 * `(nulo/ausente)` bucket exists for the day a value outside the known
 * vocabulary shows up. It is NOT discarded (see `hasTerminalStatus`), but it is
 * counted, because a new value in `events.status` is news and must not arrive
 * as silence.
 */
export function filterDigestible<T extends FilterableMarket>(markets: readonly T[]): QueueSplit<T> {
  const digestible: T[] = [];
  const discarded = new Map<string, number>();

  for (const market of markets) {
    if (hasTerminalStatus(market.status)) {
      const label = market.status ?? NO_STATUS;
      discarded.set(label, (discarded.get(label) ?? 0) + 1);
      continue;
    }
    digestible.push(market);
  }

  return { digestible, discarded };
}
