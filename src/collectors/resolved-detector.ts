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

/**
 * Detect resolution via sustained extreme price in DB snapshots.
 *
 * Necessary because Polymarket returns closed=false for markets that are part
 * of a group with multiple sub-resolutions. The price already reflects the
 * outcome but the individual market never becomes closed.
 */
async function detectResolutionByPrice(eventId: string): Promise<ResolutionResult> {
  const sixHoursAgo = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();

  const { data: snapshots } = await supabase
    .from('polymarket_snapshots')
    .select('outcome, best_bid, best_ask, captured_at')
    .eq('event_id', eventId)
    .gte('captured_at', sixHoursAgo)
    .order('captured_at', { ascending: false });

  if (!snapshots || snapshots.length < 6) {
    return { kind: 'unresolved' };
  }

  const byOutcome = new Map<string, Array<{ best_bid: number | null; best_ask: number | null }>>();
  for (const s of snapshots) {
    const arr = byOutcome.get(s.outcome) ?? [];
    arr.push({ best_bid: s.best_bid, best_ask: s.best_ask });
    byOutcome.set(s.outcome, arr);
  }

  if (byOutcome.size !== 2) return { kind: 'unresolved' };

  const outcomes = Array.from(byOutcome.keys());

  for (const candidateWinner of outcomes) {
    const winnerSnaps = byOutcome.get(candidateWinner)!;
    const loser = outcomes.find(o => o !== candidateWinner)!;
    const loserSnaps = byOutcome.get(loser)!;

    if (winnerSnaps.length < 3 || loserSnaps.length < 3) continue;

    const winnerExtreme = winnerSnaps.every(s => {
      const bid = s.best_bid;
      return bid != null && bid >= 0.99;
    });

    const loserExtreme = loserSnaps.every(s => {
      const ask = s.best_ask;
      return ask != null && ask <= 0.01;
    });

    if (winnerExtreme && loserExtreme) {
      return { kind: 'win', winnerOutcome: candidateWinner };
    }
  }

  return { kind: 'unresolved' };
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

  // Etapa 1: events com leg aberta (prioritários — sempre incluir, sem limit)
  const { data: openLegEvents } = await supabase
    .from('my_bet_legs')
    .select('event_id')
    .is('closed_at', null);

  const openLegEventIds = (openLegEvents ?? [])
    .map(l => l.event_id as string | null)
    .filter(Boolean) as string[];

  const { data: priorityCandidates } = openLegEventIds.length > 0
    ? await supabase
        .from('events')
        .select('id, polymarket_id, title, end_date, status')
        .in('id', openLegEventIds)
        .in('status', ['active', 'closed_manual'])
        .gte('end_date', cutoff90d)
        .lte('end_date', cutoffFuture30d)
    : { data: [] as { id: string; polymarket_id: string; title: string; end_date: string | null; status: string }[] };

  // Etapa 2: outros candidates (limit 500, ordenados por end_date asc)
  const priorityIds = new Set((priorityCandidates ?? []).map(p => p.id));

  const { data: normalCandidates, error: candErr } = await supabase
    .from('events')
    .select('id, polymarket_id, title, end_date, status')
    .in('status', ['active', 'closed_manual'])
    .gte('end_date', cutoff90d)
    .lte('end_date', cutoffFuture30d)
    .order('end_date', { ascending: true })
    .limit(500);

  if (candErr) {
    await logEvent({
      component: 'resolved_detector',
      status: 'error',
      message: `query candidates failed: ${candErr.message}`,
    });
    return;
  }

  // Merge: prioritários + normais (sem duplicar)
  const candidates = [
    ...(priorityCandidates ?? []),
    ...(normalCandidates ?? []).filter(c => !priorityIds.has(c.id)),
  ];

  const missing = candidates.filter(c => !seenPolymarketIds.has(c.polymarket_id));

  if (missing.length === 0) {
    await logEvent({
      component: 'resolved_detector',
      status: 'success',
      message: `no missing events to check (${candidates.length} active)`,
    });
    return;
  }

  const priorityEventIds = priorityIds;

  const priorityMissing = missing.filter(e => priorityEventIds.has(e.id));
  const normalMissing = missing.filter(e => !priorityEventIds.has(e.id));

  const normalToProcess = normalMissing.slice(0, MAX_PER_CYCLE);
  const skippedDueToLimit = normalMissing.length - normalToProcess.length;

  const toProcess = [...priorityMissing, ...normalToProcess];

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
        // For events with open legs, also check if resolved via sustained extreme price.
        // Necessary because market groups with multi-resolutions never have closed=true
        // on individual sub-markets until the entire group resolves.
        const isPriority = priorityEventIds.has(event.id);

        if (isPriority) {
          const priceResolution = await detectResolutionByPrice(event.id);
          if (priceResolution.kind === 'win') {
            const resolvedAt = new Date().toISOString();
            const updateData: Record<string, unknown> = {
              status: 'resolved',
              resolved_at: resolvedAt,
              resolved_outcome: priceResolution.winnerOutcome,
            };

            const { data: updated, error: updErr } = await supabase
              .from('events')
              .update(updateData)
              .eq('id', event.id)
              .in('status', ['active', 'closed_manual'])
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
              priceResolution,
              resolvedAt,
            );

            resolvedCount++;
            totalLegsClosed += closed;
            totalPayout += payout_total;

            await logEvent({
              component: 'resolved_detector',
              status: 'success',
              message: `event ${event.id} (${event.title.slice(0, 60)}) detected as resolved by sustained extreme price: ${priceResolution.winnerOutcome}, closed ${closed} leg(s), payout $${payout_total.toFixed(2)}`,
            });
            continue;
          }
        }

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
        .in('status', ['active', 'closed_manual'])
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
    message: `checked ${toProcess.length}/${missing.length} missing events (${priorityMissing.length} priority, ${normalToProcess.length} normal): ${resolvedCount} resolved, ${voidCount} void, ${unresolvedCount} pending UMA, ${stillOpenCount} still open, ${fetchErrors} fetch errors. ${skippedDueToLimit > 0 ? `${skippedDueToLimit} skipped (limit ${MAX_PER_CYCLE}). ` : ''}Closed ${totalLegsClosed} legs, payout total $${totalPayout.toFixed(2)} in ${durationMs}ms`,
  });
}
