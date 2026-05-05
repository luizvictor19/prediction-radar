import { supabase } from '../lib/supabase.js';
import { fetchActiveMarkets } from '../lib/polymarket-api.js';
import { categorizeMarket, logCategorizerStats } from './categorizer.js';
import { gammaToEvent } from '../lib/normalize.js';
import { getSystemConfig } from '../lib/config.js';
import { logEvent } from '../lib/logger.js';
import type { GammaMarket } from '../types/index.js';

const MAX_DAYS_TO_RESOLUTION = 90;

function isWithinResolutionWindow(endDate: string): boolean {
  const end = new Date(endDate);
  const now = new Date();
  const days = (end.getTime() - now.getTime()) / (1000 * 60 * 60 * 24);
  return days > 0 && days <= MAX_DAYS_TO_RESOLUTION;
}

function passesBaseFilters(market: GammaMarket): boolean {
  if (!market.question?.trim()) return false;
  if (!market.active || market.closed) return false;
  if (!isWithinResolutionWindow(market.endDate)) return false;
  return true;
}

// Single pass: fetch all active markets from Gamma, filter by volume/liquidity/window,
// upsert events, and write snapshots — no CLOB API calls needed.
export async function collectAll(): Promise<void> {
  console.log('[collector] Starting collection pass...');
  const startMs = Date.now();

  const config = await getSystemConfig();
  const minVolume24h = config.collector_min_volume_24h ?? 10000;
  const minLiquidity = config.collector_min_liquidity ?? 20000;
  const excludedCategories = config.excluded_categories ?? [];

  let offset = 0;
  let scanned = 0;
  let upserted = 0;
  let snapshots = 0;
  let errorsCount = 0;
  let skippedLowVolumeIsolated = 0;
  let includedNegRiskLowVolume = 0;
  let skippedLiquidity = 0;
  let skippedExcluded = 0;

  while (true) {
    const markets = await fetchActiveMarkets({ limit: 500, offset });
    if (markets.length === 0) break;

    for (const market of markets) {
      if (!passesBaseFilters(market)) continue;

      const volume24h = Number(market.volume24hr ?? market.volume24hrClob ?? 0);
      if (volume24h < minVolume24h) {
        if (!market.negRiskMarketID) {
          skippedLowVolumeIsolated++;
          continue;
        }
        includedNegRiskLowVolume++;
      }

      const liquidity = Number(market.liquidityNum ?? market.liquidity ?? 0);
      if (liquidity < minLiquidity) {
        skippedLiquidity++;
        continue;
      }

      // Apply excluded_categories filter (uses polymarket feeType)
      const feeType = market.feeType ?? null;
      if (feeType && excludedCategories.length > 0 && excludedCategories.includes(feeType)) {
        skippedExcluded++;
        continue;
      }

      const { category, sub_category } = categorizeMarket(market);
      const event = { ...gammaToEvent(market, category), sub_category };

      const { data: eventRow, error: upsertErr } = await supabase
        .from('events')
        .upsert(event, { onConflict: 'polymarket_id', ignoreDuplicates: false })
        .select('id, outcomes')
        .single();

      if (upsertErr || !eventRow) {
        console.error(`[collector] Upsert failed for ${market.id}:`, upsertErr?.message);
        errorsCount++;
        continue;
      }

      upserted++;

      const outcomes = eventRow.outcomes as { values?: string[] } | null;
      const outcomeNames = outcomes?.values ?? ['Yes', 'No'];
      const firstOutcome = outcomeNames[0] ?? 'Yes';
      const secondOutcome = outcomeNames[1] ?? 'No';

      const best_bid = market.bestBid || null;
      const best_ask = market.bestAsk || null;
      const mid_price = best_bid && best_ask ? (best_bid + best_ask) / 2 : null;
      const spread = market.spread || null;

      const firstSnapshot = {
        event_id: eventRow.id,
        outcome: firstOutcome,
        best_bid,
        best_ask,
        mid_price,
        spread,
        bid_depth: null,
        ask_depth: null,
        volume_24h: volume24h,
      };

      const secondSnapshot = {
        event_id: eventRow.id,
        outcome: secondOutcome,
        best_bid: best_ask !== null ? 1 - best_ask : null,
        best_ask: best_bid !== null ? 1 - best_bid : null,
        mid_price: mid_price !== null ? 1 - mid_price : null,
        spread,
        bid_depth: null,
        ask_depth: null,
        volume_24h: volume24h,
      };

      const { error: snapErr } = await supabase
        .from('polymarket_snapshots')
        .insert([firstSnapshot, secondSnapshot]);

      if (snapErr) {
        console.error(`[collector] Snapshot failed for ${market.id}:`, snapErr.message);
        errorsCount++;
      } else {
        snapshots += 2;
      }
    }

    scanned += markets.length;
    offset += markets.length;

    if (markets.length < 500) break;
  }

  const durationMs = Date.now() - startMs;
  const status = errorsCount === 0 ? 'success' : upserted > 0 ? 'partial' : 'error';

  await logEvent({
    component: 'collector',
    status,
    message: `Scanned ${scanned}, upserted ${upserted} events, ${snapshots} snapshots`,
    metadata: {
      scanned,
      upserted_events: upserted,
      upserted_snapshots: snapshots,
      duration_ms: durationMs,
      errors_count: errorsCount,
      skipped_low_volume_isolated: skippedLowVolumeIsolated,
      included_neg_risk_low_volume: includedNegRiskLowVolume,
      skipped_low_liquidity: skippedLiquidity,
      skipped_excluded_category: skippedExcluded,
    },
  });

  await logCategorizerStats();

  console.log(`[collector] Done. Scanned ${scanned}, upserted ${upserted} events, ${snapshots} snapshots.`);
}
