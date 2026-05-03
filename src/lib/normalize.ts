import type { GammaMarket, Event, MarketCategory } from '../types/index.js';
import { categorizeMarket } from '../collectors/categorizer.js';

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
    status: market.closed ? 'resolved' : market.active ? 'active' : 'inactive',
    resolved_outcome: null,
    tracked: true,
    neg_risk_market_id: market.negRiskMarketID ?? null,
    series_id: market.series?.[0]?.id ?? null,
    series_slug: market.series?.[0]?.slug ?? null,
    series_recurrence: market.series?.[0]?.recurrence ?? null,
    event_group_slug: market.events?.[0]?.slug ?? null,
    event_metadata: market.eventMetadata ?? null,
  };
}
