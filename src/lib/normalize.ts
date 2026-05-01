import type { GammaMarket, Event, MarketCategory } from '../types/index.js';

export function gammaToEvent(market: GammaMarket, category: MarketCategory = 'other'): Omit<Event, 'id' | 'created_at' | 'updated_at'> {
  const outcomeValues: string[] = JSON.parse(market.outcomes);
  const outcomePriceValues: string[] = JSON.parse(market.outcomePrices);

  return {
    polymarket_id: market.id,
    slug: market.slug,
    title: market.question,
    category,
    sub_category: null,
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
    event_metadata: market.eventMetadata ?? null,
  };
}
