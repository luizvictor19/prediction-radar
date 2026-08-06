import type { GammaMarket, Event, MarketCategory } from '../types/index.js';
import { categorizeMarket } from '../collectors/categorizer.js';

/**
 * O horário real da partida (spec 000, item 7).
 *
 * Três campos medidos na Gamma em 2026-08-06, sobre 171 markets de esports:
 *
 *   gameStartTime        171/171, mas no formato '2026-08-06 18:30:00+00'
 *   eventStartTime       111/171 — só o market da série costuma trazer
 *   events[0].startTime  171/171, em ISO
 *
 * Daí a ordem: o campo com cobertura total primeiro, o ISO como rede.
 *
 * A normalização não é cosmética. `'2026-08-06 18:30:00+00'` não é ISO-8601, e
 * o que a spec do JS garante fora de ISO é nada — cada motor decide. O V8 parseia,
 * mas gravar assim deixaria o valor voltar do banco num formato e da API noutro,
 * com a comparação de faixa dependendo de qual dos dois chegou primeiro.
 */
export function gammaGameStartTime(market: GammaMarket): string | null {
  const raw = market.gameStartTime ?? market.eventStartTime ?? market.events?.[0]?.startTime ?? null;
  if (!raw) return null;

  let ms = Date.parse(raw);
  if (Number.isNaN(ms)) {
    // Reescreve o formato da Gamma em ISO e tenta de novo: ' ' -> 'T' e o
    // offset curto ('+00') completado para '+00:00'.
    ms = Date.parse(raw.replace(' ', 'T').replace(/([+-]\d{2})$/, '$1:00'));
  }

  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

export function gammaToEvent(market: GammaMarket, category: MarketCategory = 'other'): Omit<Event, 'id' | 'created_at' | 'updated_at'> {
  const outcomeValues: string[] = JSON.parse(market.outcomes);
  const outcomePriceValues: string[] = JSON.parse(market.outcomePrices);

  // feeType is the canonical Polymarket category (e.g. "politics_fees", "sports_fees_v2")
  const polymarketCategory = market.feeType ?? null;
  // feeSchedule.rate is the authoritative fee rate from the API
  const polymarketFeeRate = market.feeSchedule?.rate ?? null;

  // Internal categorizer becomes a flag only — true if market is AI/Tech-related
  const { category: internalCategory } = categorizeMarket(market);
  const isAiTech = internalCategory !== 'other';

  return {
    polymarket_id: market.id,
    slug: market.slug,
    title: market.question,
    category,
    sub_category: null,
    polymarket_category: polymarketCategory,
    polymarket_fee_rate: polymarketFeeRate,
    is_ai_tech: isAiTech,
    description: market.description,
    outcomes: { values: outcomeValues, prices: outcomePriceValues },
    volume_total: Number(market.volumeNum ?? market.volume ?? 0),
    volume_24h: Number(market.volume24hr ?? market.volume24hrClob ?? 0),
    liquidity: Number(market.liquidityNum ?? market.liquidity ?? 0),
    end_date: market.endDate,
    game_start_time: gammaGameStartTime(market),
    status: market.closed ? 'resolved' : market.active ? 'active' : 'inactive',
    resolved_outcome: null,
    tracked: true,
    neg_risk_market_id: market.negRiskMarketID ?? null,
    series_id: market.series?.[0]?.id ?? null,
    series_slug: market.series?.[0]?.slug ?? null,
    series_recurrence: market.series?.[0]?.recurrence ?? null,
    event_group_slug: market.events?.[0]?.slug ?? null,
    event_metadata: market.eventMetadata ?? null,
    sports_market_type: market.sportsMarketType ?? null,
    line: market.line ?? null,
  };
}
