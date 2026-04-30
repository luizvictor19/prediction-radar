import { supabase } from '../lib/supabase.js';
import { fetchActiveMarkets, fetchOrderbook } from '../lib/polymarket-api.js';
import { categorizeMarket, isRelevantMarket } from './categorizer.js';
import { gammaToEvent } from '../lib/normalize.js';

const MIN_VOLUME_24H = 5000;
const MAX_DAYS_TO_RESOLUTION = 90;
const MIN_DAYS_TO_RESOLUTION = 7;

function isWithinResolutionWindow(endDate: string | null): boolean {
  if (!endDate) return false;
  const end = new Date(endDate);
  const now = new Date();
  const days = (end.getTime() - now.getTime()) / (1000 * 60 * 60 * 24);
  return days >= MIN_DAYS_TO_RESOLUTION && days <= MAX_DAYS_TO_RESOLUTION;
}

export async function collectMarkets(): Promise<void> {
  console.log('[collector] Starting market collection...');

  let offset = 0;
  let total = 0;
  let upserted = 0;

  while (true) {
    const markets = await fetchActiveMarkets({ limit: 100, offset, minVolume24h: MIN_VOLUME_24H });
    if (markets.length === 0) break;

    for (const market of markets) {
      if (!isRelevantMarket(market)) continue;
      if (!isWithinResolutionWindow(market.endDateIso)) continue;

      const { category, sub_category } = categorizeMarket(market);
      const event = { ...gammaToEvent(market, category), sub_category };

      const { error } = await supabase
        .from('events')
        .upsert(event, { onConflict: 'polymarket_id', ignoreDuplicates: false });

      if (error) {
        console.error(`[collector] Failed to upsert ${market.id}:`, error.message);
      } else {
        upserted++;
      }
    }

    total += markets.length;
    offset += markets.length;

    if (markets.length < 100) break;
  }

  console.log(`[collector] Done. Scanned ${total}, upserted ${upserted} relevant markets.`);
}

export async function collectSnapshots(): Promise<void> {
  console.log('[collector] Collecting orderbook snapshots...');

  const { data: events, error } = await supabase
    .from('events')
    .select('id, polymarket_id, outcomes')
    .eq('status', 'active')
    .eq('tracked', true);

  if (error || !events) {
    console.error('[collector] Failed to fetch events:', error?.message);
    return;
  }

  for (const event of events) {
    const outcomes = event.outcomes as { values?: string[] } | null;
    if (!outcomes?.values?.length) continue;

    try {
      const ob = await fetchOrderbook(event.polymarket_id);
      const bids = ob.bids.map((b) => parseFloat(b.price));
      const asks = ob.asks.map((a) => parseFloat(a.price));

      const best_bid = bids.length > 0 ? Math.max(...bids) : null;
      const best_ask = asks.length > 0 ? Math.min(...asks) : null;
      const mid_price = best_bid && best_ask ? (best_bid + best_ask) / 2 : null;
      const spread = best_bid && best_ask ? best_ask - best_bid : null;

      await supabase.from('polymarket_snapshots').insert({
        event_id: event.id,
        outcome: outcomes.values[0] ?? 'YES',
        best_bid,
        best_ask,
        mid_price,
        spread,
        bid_depth: null,
        ask_depth: null,
        volume_24h: null,
      });
    } catch (err) {
      console.error(`[collector] Snapshot failed for ${event.polymarket_id}:`, err);
    }
  }

  console.log(`[collector] Snapshots collected for ${events.length} events.`);
}
