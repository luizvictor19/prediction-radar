import { supabase } from '../lib/supabase.js';
import { fetchActiveMarkets } from '../lib/polymarket-api.js';
import { categorizeMarket, logCategorizerStats } from './categorizer.js';
import { gammaToEvent } from '../lib/normalize.js';
import { getSystemConfig } from '../lib/config.js';
import { logEvent } from '../lib/logger.js';
import { detectResolvedMarkets } from './resolved-detector.js';
import { batchInsert, batchUpsert, DEFAULT_CHUNK_SIZE, EVENTS_CHUNK_SIZE } from '../lib/batch-write.js';
import { CycleLock } from '../lib/cycle-lock.js';
import type { GammaMarket } from '../types/index.js';

const MAX_DAYS_TO_RESOLUTION = 90;
// Polymarket Gamma API has a hard limit of 100 markets per page,
// even when limit > 100 is requested. Confirmed empirically 2026-05-14.
const PAGE_SIZE = 100;
// Markets are buffered across pages and written in one round-trip per batch.
const FLUSH_THRESHOLD = DEFAULT_CHUNK_SIZE;

interface PendingMarket {
  polymarketId: string;
  event: Record<string, unknown>;
  volume24h: number;
  best_bid: number | null;
  best_ask: number | null;
  mid_price: number | null;
  spread: number | null;
}

interface UpsertedEvent {
  id: string;
  polymarket_id: string;
  outcomes: { values?: string[] } | null;
}

function buildSnapshotPair(pending: PendingMarket, event: UpsertedEvent): Record<string, unknown>[] {
  const outcomeNames = event.outcomes?.values ?? ['Yes', 'No'];
  const firstOutcome = outcomeNames[0] ?? 'Yes';
  const secondOutcome = outcomeNames[1] ?? 'No';
  const { best_bid, best_ask, mid_price, spread, volume24h } = pending;

  return [
    {
      event_id: event.id,
      outcome: firstOutcome,
      best_bid,
      best_ask,
      mid_price,
      spread,
      bid_depth: null,
      ask_depth: null,
      volume_24h: volume24h,
    },
    {
      event_id: event.id,
      outcome: secondOutcome,
      best_bid: best_ask !== null ? 1 - best_ask : null,
      best_ask: best_bid !== null ? 1 - best_bid : null,
      mid_price: mid_price !== null ? 1 - mid_price : null,
      spread,
      bid_depth: null,
      ask_depth: null,
      volume_24h: volume24h,
    },
  ];
}

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

const cycleLock = new CycleLock();

export async function collectAll(): Promise<void> {
  const lockToken = cycleLock.tryAcquire();

  if (!lockToken) {
    const heldForMs = cycleLock.heldForMs() ?? 0;
    console.log('[collector] Previous run still in progress, skipping this tick');
    await logEvent({
      component: 'collector',
      status: 'partial',
      message: 'Skipped: previous run still in progress',
      metadata: { previous_cycle_running_for_ms: heldForMs },
    });
    return;
  }

  if (lockToken.staleTakeoverMs !== null) {
    const stuckMinutes = Math.round(lockToken.staleTakeoverMs / 60000);
    console.warn(`[collector] Previous cycle stuck for ${stuckMinutes}min — assuming dead, starting a new one`);
    await logEvent({
      component: 'collector',
      status: 'partial',
      message: `WARNING: previous cycle stuck for ${stuckMinutes}min — assumed dead, starting a new one`,
      metadata: { stuck_for_ms: lockToken.staleTakeoverMs },
    });
  }

  console.log('[collector] Starting collection pass...');
  const startMs = Date.now();

  // Contadores de progresso ficam fora do try para que o log de erro possa
  // dizer até onde o ciclo chegou antes de morrer.
  let offset = 0;
  let pageCount = 0;
  let scanned = 0;
  let upserted = 0;
  let snapshots = 0;
  let errorsCount = 0;
  let skippedLowVolumeIsolated = 0;
  let includedNegRiskLowVolume = 0;
  let skippedLiquidity = 0;
  let skippedExcluded = 0;
  let protectedIncluded = 0;
  let skippedDuplicate = 0;
  const writeErrors: string[] = [];

  try {
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

    // A same market can surface on two pages when the volume ranking shifts
    // mid-scan. Enqueueing it twice would break the batch upsert:
    // ON CONFLICT DO UPDATE cannot touch the same row twice in one statement.
    const queuedPolymarketIds = new Set<string>();
    let pending: PendingMarket[] = [];

    async function flushPending(): Promise<void> {
      if (pending.length === 0) return;
      const batch = pending;
      pending = [];

      const eventsResult = await batchUpsert<UpsertedEvent>(
        'events',
        batch.map(p => p.event),
        {
          onConflict: 'polymarket_id',
          select: 'id, polymarket_id, outcomes',
          chunkSize: EVENTS_CHUNK_SIZE,
          label: 'collector',
        },
      );

      upserted += eventsResult.rows.length;
      errorsCount += eventsResult.failedRows;
      writeErrors.push(...eventsResult.errors);

      const eventByPolymarketId = new Map(eventsResult.rows.map(row => [row.polymarket_id, row]));

      const snapshotRows: Record<string, unknown>[] = [];
      for (const p of batch) {
        const event = eventByPolymarketId.get(p.polymarketId);
        // Missing means the event chunk failed — no id to hang a snapshot on.
        if (!event) continue;
        snapshotRows.push(...buildSnapshotPair(p, event));
      }

      if (snapshotRows.length === 0) return;

      const snapResult = await batchInsert('polymarket_snapshots', snapshotRows, { label: 'collector' });
      snapshots += snapResult.written;
      errorsCount += snapResult.failedRows;
      writeErrors.push(...snapResult.errors);
    }

    // O flush vai no finally: se a paginação lançar (HTTP 4xx/5xx da Gamma,
    // socket derrubado), os até 500 markets já preparados são gravados em vez
    // de descartados junto com a exceção.
    try {
      while (true) {
        const markets = await fetchActiveMarkets({
          limit: PAGE_SIZE,
          offset,
          order: 'volume24hr',
          ascending: false,
        });
        pageCount++;

        if (markets.length === 0) break;

        for (const market of markets) {
          // Closed markets must not be marked as "seen" so the auto-resolver can pick them up
          if (!market.closed) {
            seenPolymarketIds.add(market.id);
          }

          if (!passesBaseFilters(market)) continue;

          if (queuedPolymarketIds.has(market.id)) {
            skippedDuplicate++;
            continue;
          }

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

          const { category, sub_category } = categorizeMarket(market);
          const event = { ...gammaToEvent(market, category), sub_category };

          const best_bid = market.bestBid || null;
          const best_ask = market.bestAsk || null;

          queuedPolymarketIds.add(market.id);
          pending.push({
            polymarketId: market.id,
            event,
            volume24h,
            best_bid,
            best_ask,
            mid_price: best_bid && best_ask ? (best_bid + best_ask) / 2 : null,
            spread: market.spread || null,
          });

          if (pending.length >= FLUSH_THRESHOLD) await flushPending();
        }

        scanned += markets.length;
        offset += markets.length;

        if (pageCount % 5 === 0) {
          await new Promise(resolve => setTimeout(resolve, 500));
        }

        if (pageCount >= 100) {
          console.warn('[collector] Reached safety cap of 100 pages (10k markets)');
          break;
        }
      }
    } finally {
      // batchInsert/batchUpsert nunca lançam, então este flush não mascara
      // a exceção original que está subindo.
      await flushPending();
    }

    const durationMs = Date.now() - startMs;
    const status = errorsCount === 0 ? 'success' : upserted > 0 ? 'partial' : 'error';

    await logEvent({
      component: 'collector',
      status,
      message: `Scanned ${scanned} (${pageCount} pages, sorted by volume), upserted ${upserted} events, ${snapshots} snapshots`,
      metadata: {
        scanned,
        pages: pageCount,
        upserted_events: upserted,
        upserted_snapshots: snapshots,
        duration_ms: durationMs,
        errors_count: errorsCount,
        skipped_low_volume_isolated: skippedLowVolumeIsolated,
        included_neg_risk_low_volume: includedNegRiskLowVolume,
        skipped_low_liquidity: skippedLiquidity,
        skipped_excluded_category: skippedExcluded,
        skipped_duplicate: skippedDuplicate,
        protected_included: protectedIncluded,
        write_errors: writeErrors.length > 0 ? writeErrors.slice(0, 10) : null,
      },
    });

    await detectResolvedMarkets(seenPolymarketIds);

    await logCategorizerStats();

    console.log(`[collector] Done. Scanned ${scanned}, upserted ${upserted} events, ${snapshots} snapshots.`);
  } catch (err) {
    // O .catch() do cron só faz console.error. Sem este log, um ciclo que morre
    // no meio não deixa rastro em system_logs — que é onde o diagnóstico é feito.
    // Os dados já preparados não se perdem: o flush roda no finally da paginação.
    await logEvent({
      component: 'collector',
      status: 'error',
      message: `Cycle failed after ${pageCount} pages: ${err instanceof Error ? err.message : String(err)}`,
      metadata: {
        error: String(err),
        pages: pageCount,
        scanned,
        upserted_events: upserted,
        upserted_snapshots: snapshots,
        duration_ms: Date.now() - startMs,
      },
    });
    throw err;
  } finally {
    cycleLock.release(lockToken);
  }
}
