import { supabase } from '../lib/supabase.js';
import { fetchActiveMarkets } from '../lib/polymarket-api.js';
import { categorizeMarket, logCategorizerStats } from './categorizer.js';
import { gammaToEvent } from '../lib/normalize.js';
import { getSystemConfig } from '../lib/config.js';
import { logEvent } from '../lib/logger.js';
import { detectResolvedMarkets } from './resolved-detector.js';
import type { GammaMarket } from '../types/index.js';

const MAX_DAYS_TO_RESOLUTION = 90;
// Polymarket Gamma API has a hard limit of 100 markets per page,
// even when limit > 100 is requested. Confirmed empirically 2026-05-14.
const PAGE_SIZE = 100;

const SORT_STRATEGIES: Array<{ name: string; order: string; ascending: boolean }> = [
  { name: 'volume24hr_desc', order: 'volume24hr', ascending: false },
  { name: 'endDate_asc', order: 'endDate', ascending: true },
  { name: 'liquidity_desc', order: 'liquidity', ascending: false },
];

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

export async function collectAll(): Promise<void> {
  console.log('[collector] Starting collection pass...');
  const startMs = Date.now();

  const config = await getSystemConfig();
  const minVolume24h = config.collector_min_volume_24h ?? 10000;
  const minLiquidity = config.collector_min_liquidity ?? 20000;
  const excludedCategories = config.excluded_categories ?? [];

  const { data: openLegs } = await supabase
    .from('my_bet_legs')
    .select('event_id')
    .is('closed_at', null);

  const protectedEventIds = new Set(
    (openLegs ?? []).map(l => l.event_id as string | null).filter(Boolean) as string[],
  );

  const { data: protectedEvents } = await supabase
    .from('events')
    .select('polymarket_id')
    .in('id', [...protectedEventIds]);

  const protectedPolymarketIds = new Set(
    (protectedEvents ?? []).map(e => e.polymarket_id as string | null).filter(Boolean) as string[],
  );

  const seenPolymarketIds = new Set<string>();
  const processedPolymarketIds = new Set<string>();

  let totalScanned = 0;
  let totalUpserted = 0;
  let totalSnapshots = 0;
  let totalPages = 0;
  let totalErrors = 0;
  let skippedLowVolumeIsolated = 0;
  let includedNegRiskLowVolume = 0;
  let skippedLiquidity = 0;
  let skippedExcluded = 0;
  let protectedIncluded = 0;
  let skippedDeduped = 0;

  for (const strategy of SORT_STRATEGIES) {
    console.log(`[collector] Starting pass: ${strategy.name}`);
    let offset = 0;
    let pagesThisStrategy = 0;

    while (true) {
      const markets = await fetchActiveMarkets({
        limit: PAGE_SIZE,
        offset,
        order: strategy.order,
        ascending: strategy.ascending,
      });
      pagesThisStrategy++;
      totalPages++;

      if (markets.length === 0) break;

      for (const market of markets) {
        // Closed markets must not be marked as "seen" so the auto-resolver can pick them up
        if (!market.closed) {
          seenPolymarketIds.add(market.id);
        }

        // Skip if already processed in a previous sort strategy
        if (processedPolymarketIds.has(market.id)) {
          skippedDeduped++;
          continue;
        }

        if (!passesBaseFilters(market)) continue;

        const isProtected = protectedPolymarketIds.has(market.id);

        const volume24h = Number(market.volume24hr ?? market.volume24hrClob ?? 0);
        if (volume24h < minVolume24h && !isProtected) {
          if (!market.negRiskMarketID) {
            skippedLowVolumeIsolated++;
            continue;
          }
          includedNegRiskLowVolume++;
        }

        const liquidity = Number(market.liquidityNum ?? market.liquidity ?? 0);
        if (liquidity < minLiquidity && !isProtected) {
          skippedLiquidity++;
          continue;
        }

        if (isProtected) protectedIncluded++;

        const feeType = market.feeType ?? null;
        if (feeType && excludedCategories.length > 0 && excludedCategories.includes(feeType)) {
          skippedExcluded++;
          continue;
        }

        // Mark as processed before upsert so other sort strategies skip it
        processedPolymarketIds.add(market.id);

        const { category, sub_category } = categorizeMarket(market);
        const event = { ...gammaToEvent(market, category), sub_category };

        const { data: eventRow, error: upsertErr } = await supabase
          .from('events')
          .upsert(event, { onConflict: 'polymarket_id', ignoreDuplicates: false })
          .select('id, outcomes')
          .single();

        if (upsertErr || !eventRow) {
          console.error(`[collector] Upsert failed for ${market.id}:`, upsertErr?.message);
          totalErrors++;
          continue;
        }

        totalUpserted++;

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
          totalErrors++;
        } else {
          totalSnapshots += 2;
        }
      }

      totalScanned += markets.length;
      offset += markets.length;

      if (totalPages % 5 === 0) {
        await new Promise(resolve => setTimeout(resolve, 500));
      }

      if (pagesThisStrategy >= 1000) {
        console.warn(`[collector] Reached pagination cap for ${strategy.name}`);
        break;
      }
    }

    console.log(`[collector] Completed ${strategy.name}: ${pagesThisStrategy} pages`);
  }

  const durationMs = Date.now() - startMs;
  const status = totalErrors === 0 ? 'success' : totalUpserted > 0 ? 'partial' : 'error';

  await logEvent({
    component: 'collector',
    status,
    message: `Scanned ${totalScanned} (${totalPages} pages, ${SORT_STRATEGIES.length} sorts), upserted ${totalUpserted} events, ${totalSnapshots} snapshots, ${skippedDeduped} deduped`,
    metadata: {
      scanned: totalScanned,
      pages: totalPages,
      sorts: SORT_STRATEGIES.length,
      upserted_events: totalUpserted,
      upserted_snapshots: totalSnapshots,
      skipped_deduped: skippedDeduped,
      duration_ms: durationMs,
      errors_count: totalErrors,
      skipped_low_volume_isolated: skippedLowVolumeIsolated,
      included_neg_risk_low_volume: includedNegRiskLowVolume,
      skipped_low_liquidity: skippedLiquidity,
      skipped_excluded_category: skippedExcluded,
      protected_included: protectedIncluded,
    },
  });

  await detectResolvedMarkets(seenPolymarketIds);

  await logCategorizerStats();

  console.log(`[collector] Done. Scanned ${totalScanned} across ${SORT_STRATEGIES.length} sorts, upserted ${totalUpserted} events, ${totalSnapshots} snapshots.`);
}
