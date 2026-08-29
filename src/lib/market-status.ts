/**
 * The `events.status` vocabulary, in one place.
 *
 * `events.status` is `text default 'active'` with no NOT NULL and no CHECK
 * (`supabase/migrations/001_initial_schema.sql:15`), so the set of values is a
 * convention held by whoever writes it and not a constraint held by the
 * database. Four values are written today: `active` (`src/lib/normalize.ts:132`),
 * `resolved` (`src/collectors/resolved-detector.ts:604` and `:665`), `inactive`
 * (`scripts/backfill-neg-risk-ids.ts:60`) and `closed_manual`
 * (`src/bot/handlers/positions.ts:55`).
 *
 * This module is the first stone of the single definition issue #31 asks for.
 * It carries only the predicate issue #4 needed. The other copies move here as
 * they are reconciled, which is why this file is in `src/lib/` next to
 * `slug-prefixes.ts` and `polymarket-url.ts`, the two predicates that were
 * already extracted for the same reason.
 */

/** Statuses that mean the market itself is over. */
export const TERMINAL_STATUSES = ['resolved', 'inactive'] as const;

/**
 * Whether the market itself is over, so paying to read its rule again buys
 * nothing.
 *
 * This asks whether the status is KNOWN to be terminal, and never whether it is
 * known to be open. The direction is the whole point: callers use this to
 * REMOVE work, and over a free-text nullable column `status === 'active'` would
 * silently drop NULL and any historical value outside the four written today,
 * sending the unknown to the discarded side. Here the unknown is kept, and a
 * market is only dropped on a value that was recognised.
 *
 * `closed_manual` is deliberately NOT terminal. It records the owner closing
 * their own position (`src/bot/handlers/positions.ts:43-58`); the market itself
 * stays open and trading on Polymarket, and its rule still decides money.
 */
export function hasTerminalStatus(status: string | null | undefined): boolean {
  if (status === null || status === undefined) return false;
  return (TERMINAL_STATUSES as readonly string[]).includes(status);
}
