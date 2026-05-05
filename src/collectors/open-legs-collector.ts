import { supabase } from '../lib/supabase.js';
import { logEvent } from '../lib/logger.js';
import type { GammaMarket } from '../types/index.js';

const GAMMA_URL = process.env['POLYMARKET_GAMMA_URL'] ?? 'https://gamma-api.polymarket.com';

let isRunning = false;

export async function collectOpenLegMarkets(): Promise<void> {
  if (isRunning) return;
  isRunning = true;
  try {
    await _collect();
  } finally {
    isRunning = false;
  }
}

async function _collect(): Promise<void> {
  const startedAt = Date.now();

  try {
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

    const polymarketIds = [...new Set(legs.map(l => l.events.polymarket_id))];

    let snapshotsInserted = 0;
    let fetchErrors = 0;

    await Promise.all(polymarketIds.map(async (pmId) => {
      try {
        const res = await fetch(`${GAMMA_URL}/markets/${pmId}`);
        if (!res.ok) {
          fetchErrors++;
          return;
        }
        const market = await res.json() as GammaMarket;

        if (market.closed) return;

        const { data: evt } = await supabase
          .from('events')
          .select('id, outcomes')
          .eq('polymarket_id', pmId)
          .single();

        if (!evt) return;

        const outcomes = JSON.parse(market.outcomes) as string[];
        if (outcomes.length < 2) return;

        const { bestBid, bestAsk, spread } = market;
        if (bestBid == null || bestAsk == null) return;

        const midPrimary = (bestBid + bestAsk) / 2;
        const midSecondary = 1 - midPrimary;
        const capturedAt = new Date().toISOString();
        const volume24h = market.volume24hr ?? null;

        const rows = [
          {
            event_id: evt.id,
            outcome: outcomes[0],
            best_bid: bestBid,
            best_ask: bestAsk,
            mid_price: midPrimary,
            spread,
            volume_24h: volume24h,
            captured_at: capturedAt,
          },
          {
            event_id: evt.id,
            outcome: outcomes[1],
            best_bid: 1 - bestAsk,
            best_ask: 1 - bestBid,
            mid_price: midSecondary,
            spread,
            volume_24h: volume24h,
            captured_at: capturedAt,
          },
        ];

        const { error: insertErr } = await supabase.from('polymarket_snapshots').insert(rows);
        if (insertErr) {
          fetchErrors++;
        } else {
          snapshotsInserted += 2;
        }
      } catch {
        fetchErrors++;
      }
    }));

    const durationMs = Date.now() - startedAt;
    await logEvent({
      component: 'open_legs_collector',
      status: 'success',
      message: `collected ${snapshotsInserted} snapshots from ${polymarketIds.length} markets (${fetchErrors} errors) in ${durationMs}ms`,
    });
  } catch (err) {
    await logEvent({ component: 'open_legs_collector', status: 'error', message: String(err) });
  }
}
