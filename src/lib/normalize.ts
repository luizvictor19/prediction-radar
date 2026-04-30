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
    volume_total: market.volumeNum,
    volume_24h: market.volume24hr,
    liquidity: market.liquidityNum,
    end_date: market.endDate,
    status: market.closed ? 'resolved' : market.active ? 'active' : 'inactive',
    resolved_outcome: null,
    tracked: true,
  };
}
