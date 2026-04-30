import { supabase } from '../lib/supabase.js';
import { fetchActiveMarkets } from '../lib/polymarket-api.js';
import { categorizeMarket, isRelevantMarket } from './categorizer.js';
import { gammaToEvent } from '../lib/normalize.js';
import type { GammaMarket } from '../types/index.js';

const MIN_VOLUME_24H = 5000;
const MAX_DAYS_TO_RESOLUTION = 90;
const MIN_DAYS_TO_RESOLUTION = 7;

function isWithinResolutionWindow(endDate: string): boolean {
  const end = new Date(endDate);
  const now = new Date();
  const days = (end.getTime() - now.getTime()) / (1000 * 60 * 60 * 24);
  return days >= MIN_DAYS_TO_RESOLUTION && days <= MAX_DAYS_TO_RESOLUTION;
}

function passesLocalFilters(market: GammaMarket): boolean {
  if (!market.question?.trim()) {
    console.warn(`[collector] Skipping market ${market.id}: missing question`);
    return false;
  }
  if (!market.active || market.closed) return false;
  if (market.volume24hr < MIN_VOLUME_24H) return false;
  if (!isWithinResolutionWindow(market.endDate)) return false;
  if (!isRelevantMarket(market)) return false;
  return true;
}

// Single pass: fetch all active markets from Gamma, filter locally,
// upsert events, and write snapshots — no CLOB API calls needed.
export async function collectAll(): Promise<void> {
  console.log('[collector] Starting collection pass...');

  let offset = 0;
  let scanned = 0;
  let upserted = 0;
  let snapshots = 0;

  while (true) {
    const markets = await fetchActiveMarkets({ limit: 500, offset });
    if (markets.length === 0) break;

    for (const market of markets) {
      if (!passesLocalFilters(market)) continue;

      const { category, sub_category } = categorizeMarket(market);
      const event = { ...gammaToEvent(market, category), sub_category };

      const { data: eventRow, error: upsertErr } = await supabase
        .from('events')
        .upsert(event, { onConflict: 'polymarket_id', ignoreDuplicates: false })
        .select('id, outcomes')
        .single();

      if (upsertErr || !eventRow) {
        console.error(`[collector] Upsert failed for ${market.id}:`, upsertErr?.message);
        continue;
      }

      upserted++;

      const outcomes = eventRow.outcomes as { values?: string[] } | null;
      const firstOutcome = outcomes?.values?.[0] ?? 'Yes';

      const best_bid = market.bestBid || null;
      const best_ask = market.bestAsk || null;
      const mid_price = best_bid && best_ask ? (best_bid + best_ask) / 2 : null;

      const { error: snapErr } = await supabase.from('polymarket_snapshots').insert({
        event_id: eventRow.id,
        outcome: firstOutcome,
        best_bid,
        best_ask,
        mid_price,
        spread: market.spread || null,
        bid_depth: null,
        ask_depth: null,
        volume_24h: market.volume24hr,
      });

      if (snapErr) {
        console.error(`[collector] Snapshot failed for ${market.id}:`, snapErr.message);
      } else {
        snapshots++;
      }
    }

    scanned += markets.length;
    offset += markets.length;

    if (markets.length < 500) break;
  }

  console.log(`[collector] Done. Scanned ${scanned}, upserted ${upserted} events, ${snapshots} snapshots.`);
}
