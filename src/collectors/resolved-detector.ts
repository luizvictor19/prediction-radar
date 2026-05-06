import { supabase } from '../lib/supabase.js';
import { logEvent } from '../lib/logger.js';
import { adjustCash } from '../lib/bankroll.js';
import type { GammaMarket } from '../types/index.js';

const GAMMA_URL = process.env['POLYMARKET_GAMMA_URL'] ?? 'https://gamma-api.polymarket.com';
const FETCH_TIMEOUT_MS = 8_000;

type ResolutionResult =
  | { kind: 'win'; winnerOutcome: string }
  | { kind: 'void' }
  | { kind: 'unresolved' };

function parseResolution(market: GammaMarket): ResolutionResult {
  if (!market.closed) return { kind: 'unresolved' };

  const umaStatus = (market as unknown as { umaResolutionStatus?: string }).umaResolutionStatus;
  if (umaStatus !== 'resolved') return { kind: 'unresolved' };

  const prices = JSON.parse(market.outcomePrices) as string[];
  const outcomes = JSON.parse(market.outcomes) as string[];

  if (prices.length !== 2 || outcomes.length !== 2) return { kind: 'unresolved' };

  if (prices[0] === '0.5' && prices[1] === '0.5') return { kind: 'void' };

  const winnerIdx = prices.findIndex(p => p === '1');
  if (winnerIdx === -1) return { kind: 'unresolved' };

  return { kind: 'win', winnerOutcome: outcomes[winnerIdx]! };
}

async function fetchMarketWithTimeout(polymarketId: string): Promise<GammaMarket | null> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(`${GAMMA_URL}/markets/${polymarketId}`, { signal: controller.signal });
    if (!res.ok) return null;
    return await res.json() as GammaMarket;
  } catch {
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function closeLegsForResolvedEvent(
  eventId: string,
  resolution: { kind: 'win'; winnerOutcome: string } | { kind: 'void' },
  resolvedAt: string,
): Promise<{ closed: number; payout_total: number }> {
  const { data: legs, error: legsErr } = await supabase
    .from('my_bet_legs')
    .select('id, bet_id, outcome, entry_price, stake_usd, shares')
    .eq('event_id', eventId)
    .is('closed_at', null);

  if (legsErr || !legs || legs.length === 0) {
    return { closed: 0, payout_total: 0 };
  }

  let closed = 0;
  let payoutTotal = 0;
  const affectedBetIds = new Set<string>();

  for (const leg of legs) {
    let result: 'win' | 'loss' | 'void';
    let resolutionPrice: number | null;
    let pnlUsd: number;
    let payout: number;

    if (resolution.kind === 'void') {
      result = 'void';
      resolutionPrice = null;
      pnlUsd = 0;
      payout = leg.stake_usd;
    } else {
      const won = leg.outcome === resolution.winnerOutcome;
      if (won) {
        result = 'win';
        resolutionPrice = 1.0;
        const shares = leg.shares ?? (leg.stake_usd / leg.entry_price);
        pnlUsd = (1.0 - leg.entry_price) * shares;
        payout = shares * 1.0;
      } else {
        result = 'loss';
        resolutionPrice = 0.0;
        pnlUsd = -leg.stake_usd;
        payout = 0;
      }
    }

    const { data: clvSnap } = await supabase
      .from('polymarket_snapshots')
      .select('mid_price')
      .eq('event_id', eventId)
      .eq('outcome', leg.outcome)
      .lte('captured_at', resolvedAt)
      .order('captured_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    const clv = clvSnap?.mid_price ?? null;

    const { error: updErr } = await supabase
      .from('my_bet_legs')
      .update({
        result,
        resolution_price: resolutionPrice,
        pnl_usd: pnlUsd,
        clv,
        closed_at: resolvedAt,
      })
      .eq('id', leg.id)
      .is('closed_at', null);

    if (updErr) {
      await logEvent({
        component: 'resolved_detector',
        status: 'error',
        message: `failed to close leg ${leg.id}: ${updErr.message}`,
      });
      continue;
    }

    if (payout > 0) {
      await adjustCash(payout);
      payoutTotal += payout;
    }

    affectedBetIds.add(leg.bet_id);
    closed++;
  }

  for (const betId of affectedBetIds) {
    const { count: openLegs } = await supabase
      .from('my_bet_legs')
      .select('id', { count: 'exact', head: true })
      .eq('bet_id', betId)
      .is('closed_at', null);

    if (openLegs === 0) {
      await supabase
        .from('my_bets')
        .update({ closed_at: resolvedAt })
        .eq('id', betId);
    }
  }

  return { closed, payout_total: payoutTotal };
}

const RESOLVED_DETECTOR_TIMEOUT_MS = 60_000;
const MAX_PER_CYCLE = 50;

export async function detectResolvedMarkets(seenPolymarketIds: Set<string>): Promise<void> {
  const timeoutPromise = new Promise<void>((_, reject) =>
    setTimeout(() => reject(new Error('resolved_detector timeout 60s')), RESOLVED_DETECTOR_TIMEOUT_MS),
  );

  try {
    await Promise.race([_detectResolvedMarkets(seenPolymarketIds), timeoutPromise]);
  } catch (err) {
    await logEvent({
      component: 'resolved_detector',
      status: 'error',
      message: `unexpected error: ${String(err)}`,
    });
  }
}

async function _detectResolvedMarkets(seenPolymarketIds: Set<string>): Promise<void> {
  const startedAt = Date.now();

  const cutoff90d = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
  const cutoffFuture30d = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

  const { data: candidates, error: candErr } = await supabase
    .from('events')
    .select('id, polymarket_id, title, end_date')
    .eq('status', 'active')
    .gte('end_date', cutoff90d)
    .lte('end_date', cutoffFuture30d)
    .limit(500);

  if (candErr || !candidates) {
    await logEvent({
      component: 'resolved_detector',
      status: 'error',
      message: `query candidates failed: ${candErr?.message}`,
    });
    return;
  }

  const missing = candidates.filter(c => !seenPolymarketIds.has(c.polymarket_id));

  if (missing.length === 0) {
    await logEvent({
      component: 'resolved_detector',
      status: 'success',
      message: `no missing events to check (${candidates.length} active)`,
    });
    return;
  }

  const toProcess = missing.slice(0, MAX_PER_CYCLE);
  const skippedDueToLimit = missing.length - toProcess.length;

  let resolvedCount = 0;
  let voidCount = 0;
  let totalLegsClosed = 0;
  let totalPayout = 0;
  let unresolvedCount = 0;
  let stillOpenCount = 0;
  let fetchErrors = 0;

  for (const event of toProcess) {
      const market = await fetchMarketWithTimeout(event.polymarket_id);
      if (!market) {
        fetchErrors++;
        continue;
      }

      if (!market.closed) {
        await logEvent({
          component: 'resolved_detector',
          status: 'partial',
          message: `event ${event.id} (${event.title.slice(0, 60)}) sumiu do feed mas closed=false (liquidez/pausa?), ignorando`,
        });
        stillOpenCount++;
        continue;
      }

      const resolution = parseResolution(market);
      if (resolution.kind === 'unresolved') {
        unresolvedCount++;
        continue;
      }

      const umaEndDate = (market as unknown as { umaEndDate?: string }).umaEndDate
        ?? new Date().toISOString();

      const updateData: Record<string, unknown> = {
        status: 'resolved',
        resolved_at: umaEndDate,
      };
      if (resolution.kind === 'win') {
        updateData['resolved_outcome'] = resolution.winnerOutcome;
      }

      const { data: updated, error: updErr } = await supabase
        .from('events')
        .update(updateData)
        .eq('id', event.id)
        .eq('status', 'active')
        .select('id')
        .maybeSingle();

      if (updErr || !updated) {
        if (updErr) {
          await logEvent({
            component: 'resolved_detector',
            status: 'error',
            message: `event update failed for ${event.id}: ${updErr.message}`,
          });
        }
        continue;
      }

      const { closed, payout_total } = await closeLegsForResolvedEvent(
        event.id,
        resolution,
        umaEndDate,
      );

      if (resolution.kind === 'void') voidCount++;
      else resolvedCount++;

      totalLegsClosed += closed;
      totalPayout += payout_total;

      await logEvent({
        component: 'resolved_detector',
        status: 'success',
        message: `event ${event.id} (${event.title.slice(0, 60)}) resolved as ${resolution.kind === 'void' ? 'void' : resolution.winnerOutcome}, closed ${closed} leg(s), payout $${payout_total.toFixed(2)}`,
      });
    }

  const durationMs = Date.now() - startedAt;
  await logEvent({
    component: 'resolved_detector',
    status: 'success',
    message: `checked ${toProcess.length}/${missing.length} missing events: ${resolvedCount} resolved, ${voidCount} void, ${unresolvedCount} pending UMA, ${stillOpenCount} still open, ${fetchErrors} fetch errors. ${skippedDueToLimit > 0 ? `${skippedDueToLimit} skipped (limit ${MAX_PER_CYCLE}). ` : ''}Closed ${totalLegsClosed} legs, payout total $${totalPayout.toFixed(2)} in ${durationMs}ms`,
  });
}
