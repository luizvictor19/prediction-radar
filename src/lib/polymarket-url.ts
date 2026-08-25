/**
 * The single place that turns the slugs in `events` into a Polymarket URL.
 *
 * It is a module and not two copies because it already WAS two copies, and they
 * had diverged: `src/bot/handlers/signals.ts` built `/event/<event_group_slug>`
 * while `web/src/lib/formato.ts` built `/event/<slug>`. The second one is a
 * market slug in an event path, and it answered 404 for 956 of the 1,024 active
 * markets of the roster. Nobody noticed until a link broke in the operator's
 * hand.
 *
 * ## The two columns are not interchangeable
 *
 * They come from different objects of the Gamma API, and `src/lib/normalize.ts`
 * is where that is decided:
 *
 *   events.slug              <- market.slug             (:118)  a MARKET slug
 *   events.event_group_slug  <- market.events[0].slug   (:142)  an EVENT slug
 *
 * `polymarket.com/event/<slug>` is an event path. Feeding it a market slug
 * works only when the event holds a single market and the two slugs happen to
 * coincide -- 68 of the 1,024. For the other 956 it is a 404.
 *
 * ## Measured, 25/08/2026, 55 markets (40 divergent + 15 coincident)
 *
 *   /event/<slug>            opened 15/55  -- 0/40 divergent, 15/15 coincident
 *   /event/<grupo>           opened 55/55  -- but lands on the EVENT listing
 *   /event/<grupo>/<slug>    opened 55/55  -- and on the right market, 55/55
 *   /market/<slug>           opened 55/55  -- and on the right market
 *
 * Recompute with `npx tsx scripts/medicoes/url-polymarket.ts`.
 *
 * ## Why the rule is shaped the way it is
 *
 * `/event/<grupo>/<slug>` is the primary because it is the form the Polymarket
 * docs describe AND the only one measured to land on the specific market. The
 * event path alone is not good enough: for a multi-outcome event it hands the
 * operator a list of twenty markets right after they finished reading the rule
 * for one of them.
 *
 * `/market/<slug>` is the fallback and not the primary because it is NOT in the
 * docs. It works today -- 55/55, measured, not assumed -- but undocumented
 * surface can be withdrawn without notice, so it carries the case the primary
 * cannot serve rather than the whole load.
 *
 * The coincident case needs no branch of its own: when both slugs are equal the
 * primary becomes `/event/<slug>/<slug>`, and that opened 15/15. Special-casing
 * it would add a branch that the measurement says is not there.
 *
 * A missing slug returns null, and the caller shows no link. That is deliberate
 * and it is the reason there is no "when in doubt, guess the event path" arm: a
 * link that 404s costs more than an absent one, because it teaches the operator
 * that the screen's links cannot be trusted.
 */

const BASE = 'https://polymarket.com';

/** Blank is absent. A `''` slug would otherwise build `/market/`, a live 404. */
function presente(valor: string | null | undefined): string | null {
  const limpo = valor?.trim();
  return limpo ? limpo : null;
}

/**
 * The URL for a market, or null when there is no way to address it.
 *
 * @param marketSlug     `events.slug` -- the MARKET slug.
 * @param eventGroupSlug `events.event_group_slug` -- the parent EVENT slug.
 */
export function polymarketUrl(
  marketSlug: string | null | undefined,
  eventGroupSlug: string | null | undefined,
): string | null {
  const market = presente(marketSlug);
  if (market === null) return null;

  const eventGroup = presente(eventGroupSlug);
  if (eventGroup === null) return `${BASE}/market/${market}`;

  return `${BASE}/event/${eventGroup}/${market}`;
}
