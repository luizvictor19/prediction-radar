import type { GammaMarket, Event, MarketCategory } from '../types/index.js';

export function gammaToEvent(market: GammaMarket, category: MarketCategory = 'other'): Omit<Event, 'id' | 'created_at' | 'updated_at'> {
  return {
    polymarket_id: market.id,
    slug: market.slug,
    title: market.title,
    category,
    sub_category: null,
    description: market.description,
    outcomes: { values: market.outcomes },
    volume_total: market.volume,
    volume_24h: market.volume24hr,
    liquidity: market.liquidity,
    end_date: market.endDateIso,
    status: market.closed ? 'resolved' : market.active ? 'active' : 'inactive',
    resolved_outcome: null,
    tracked: true,
  };
}
