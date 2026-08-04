import { supabase } from '../lib/supabase.js';
import { logEvent } from '../lib/logger.js';
import { batchInsert } from '../lib/batch-write.js';
import type { GammaMarket } from '../types/index.js';

const GAMMA_URL = process.env['POLYMARKET_GAMMA_URL'] ?? 'https://gamma-api.polymarket.com';
const FETCH_TIMEOUT_MS = 8_000;
const CYCLE_TIMEOUT_MS = 25_000;

let isRunning = false;

export async function collectOpenLegMarkets(): Promise<void> {
  if (isRunning) {
    await logEvent({
      component: 'open_legs_collector',
      status: 'partial',
      message: 'previous cycle still running, skipping this tick',
    });
    return;
  }
  isRunning = true;

  const cyclePromise = _collect();
  const timeoutPromise = new Promise<void>((_, reject) =>
    setTimeout(() => reject(new Error('cycle timeout 25s')), CYCLE_TIMEOUT_MS),
  );

  try {
    await Promise.race([cyclePromise, timeoutPromise]);
  } catch (err) {
    await logEvent({ component: 'open_legs_collector', status: 'error', message: String(err) });
  } finally {
    isRunning = false;
  }
}

async function _collect(): Promise<void> {
  const startedAt = Date.now();

  const { data: legsData, error: legsErr } = await supabase
    .from('my_bet_legs')
    .select('event_id, events!inner(polymarket_id)')
    .is('closed_at', null);

  if (legsErr) {
    await logEvent({ component: 'open_legs_collector', status: 'error', message: `query failed: ${legsErr.message}` });
    return;
  }

  const legs = (legsData ?? []) as unknown as Array<{ event_id: string; events: { polymarket_id: string } }>;
  if (legs.length === 0) return;

  // O join já traz o event_id: dispensa um SELECT em events por market.
  const eventIdByPolymarketId = new Map(legs.map(l => [l.events.polymarket_id, l.event_id]));
  const polymarketIds = [...eventIdByPolymarketId.keys()];

  let fetchErrors = 0;
  const snapshotRows: Record<string, unknown>[] = [];

  await Promise.all(polymarketIds.map(async (pmId) => {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
      let res: Response;
      try {
        res = await fetch(`${GAMMA_URL}/markets/${pmId}`, { signal: controller.signal });
      } finally {
        clearTimeout(timeoutId);
      }

      if (!res.ok) {
        fetchErrors++;
        return;
      }
      const market = await res.json() as GammaMarket;

      if (market.closed) return;

      const eventId = eventIdByPolymarketId.get(pmId);
      if (!eventId) return;

      const outcomes = JSON.parse(market.outcomes) as string[];
      const [primary, secondary] = outcomes;
      if (primary == null || secondary == null) return;

      const { bestBid, bestAsk, spread } = market;

      // Calculate mid only when both sides are present. Save snapshot regardless,
      // so we don't lose visibility on markets approaching resolution (one side
      // often loses liquidity right before resolving).
      const midPrimary = bestBid != null && bestAsk != null ? (bestBid + bestAsk) / 2 : null;
      const midSecondary = midPrimary != null ? 1 - midPrimary : null;
      const capturedAt = new Date().toISOString();
      const volume24h = market.volume24hr ?? null;

      snapshotRows.push(
        {
          event_id: eventId,
          outcome: primary,
          best_bid: bestBid,
          best_ask: bestAsk,
          mid_price: midPrimary,
          spread,
          volume_24h: volume24h,
          captured_at: capturedAt,
        },
        {
          event_id: eventId,
          outcome: secondary,
          best_bid: bestAsk != null ? 1 - bestAsk : null,
          best_ask: bestBid != null ? 1 - bestBid : null,
          mid_price: midSecondary,
          spread,
          volume_24h: volume24h,
          captured_at: capturedAt,
        },
      );
    } catch {
      fetchErrors++;
    }
  }));

  // captured_at é fixado por market no fetch, então um único insert no fim do
  // ciclo não distorce a série temporal.
  const snapResult = await batchInsert('polymarket_snapshots', snapshotRows, { label: 'open_legs' });
  const snapshotsInserted = snapResult.written;

  const durationMs = Date.now() - startedAt;
  await logEvent({
    component: 'open_legs_collector',
    status: snapResult.errors.length > 0 ? 'partial' : 'success',
    message: `collected ${snapshotsInserted} snapshots from ${polymarketIds.length} markets (${fetchErrors} errors) in ${durationMs}ms`,
    metadata: snapResult.errors.length > 0 ? { write_errors: snapResult.errors.slice(0, 10) } : undefined,
  });
}
