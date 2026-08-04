import type { CalendarDrivenSignalMetadata } from '../types/index.js';
import { supabase } from '../lib/supabase.js';
import { getSystemConfig } from '../lib/config.js';
import { logEvent } from '../lib/logger.js';
import { batchInsert } from '../lib/batch-write.js';

function stddev(values: number[]): number {
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

interface EventRow {
  id: string;
  title: string;
  polymarket_category: string | null;
  is_ai_tech: boolean;
  volume_24h: number | null;
  end_date: string;
  outcomes: { values?: string[]; prices?: string[] } | null;
  sports_market_type: string | null;
  line: number | null;
}

export async function runCalendarDrivenDetector(): Promise<void> {
  const start = Date.now();
  const config = await getSystemConfig();

  const {
    collector_min_volume_24h: minVolume,
    signal_cooldown_minutes: cooldownMinutes,
  } = config;

  const now = new Date();
  const sevenDaysOut = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();

  const { data: events, error: fetchError } = await supabase
    .from('events')
    .select('id, title, polymarket_category, is_ai_tech, volume_24h, end_date, outcomes, sports_market_type, line')
    .eq('status', 'active')
    .eq('tracked', true)
    .gt('end_date', now.toISOString())
    .lte('end_date', sevenDaysOut)
    .gte('volume_24h', minVolume)
    .is('neg_risk_market_id', null);

  if (fetchError) {
    await logEvent({
      component: 'calendar_driven_detector',
      status: 'error',
      message: `Failed to fetch events: ${fetchError.message}`,
      metadata: { error: fetchError.message },
    });
    return;
  }

  const rows = (events ?? []) as EventRow[];

  // Staleness filter: discard events with no snapshot in the last 30 min
  const stalenessThreshold = new Date(now.getTime() - 30 * 60 * 1000).toISOString();
  const eventIds = rows.map((e) => e.id);
  let liveRows = rows;
  let skippedStale = 0;
  if (eventIds.length > 0) {
    const { data: recentSnaps, error: staleErr } = await supabase
      .from('polymarket_snapshots')
      .select('event_id')
      .in('event_id', eventIds)
      .gte('captured_at', stalenessThreshold);

    if (staleErr) {
      await logEvent({
        component: 'calendar_driven_detector',
        status: 'error',
        message: `Staleness check query failed: ${staleErr.message}`,
        metadata: { error: staleErr.message },
      });
    } else {
      const liveEventIds = new Set((recentSnaps ?? []).map((s) => s.event_id as string));
      liveRows = rows.filter((e) => liveEventIds.has(e.id));
      skippedStale = rows.length - liveRows.length;
    }
  }

  let marketsEvaluated = 0;
  let flaggedCount = 0;
  let dedupedCount = 0;
  let skippedLowSnapshots = 0;
  let skippedHighVolatility = 0;
  let skippedMalformedOutcomes = 0;
  let skippedExtremePrice = 0;
  let skippedCooldown = 0;

  // Sinais novos vão para um buffer e são gravados em um insert só no fim do ciclo.
  const pendingSignals: Record<string, unknown>[] = [];

  const PRICE_EXTREME_LOW = 0.05;
  const PRICE_EXTREME_HIGH = 0.95;

  const snapshotCutoff = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();

  for (const event of liveRows) {
    marketsEvaluated++;

    // Cooldown pós-dismiss manual: pula events com sinal calendar_driven
    // dismissado manualmente nos últimos cooldownMinutes.
    // IMPORTANTE: só dismiss manual (user_dismissed_at IS NOT NULL).
    // Auto-dismiss pelo runner não bloqueia recriação.
    const cooldownThreshold = new Date(now.getTime() - cooldownMinutes * 60 * 1000).toISOString();
    const { data: recentDismiss, error: cooldownErr } = await supabase
      .from('detected_signals')
      .select('id, user_dismissed_at')
      .eq('signal_type', 'calendar_driven')
      .eq('event_id', event.id)
      .not('user_dismissed_at', 'is', null)
      .gte('user_dismissed_at', cooldownThreshold)
      .limit(1)
      .maybeSingle();

    if (cooldownErr) {
      await logEvent({
        component: 'calendar_driven_detector',
        status: 'error',
        message: `Cooldown query failed for event ${event.id}: ${cooldownErr.message}`,
        metadata: { event_id: event.id, error: cooldownErr.message },
      });
      // Em caso de erro, segue (fail-open) — melhor processar que pular silenciosamente
    } else if (recentDismiss) {
      skippedCooldown++;
      continue;
    }

    const yesSideName = event.outcomes?.values?.[0];
    if (!yesSideName) {
      await logEvent({
        component: 'calendar_driven_detector',
        status: 'partial',
        message: `Event ${event.id} skipped: malformed outcomes (no values[0])`,
        metadata: { event_id: event.id, outcomes: event.outcomes },
      });
      skippedMalformedOutcomes++;
      continue;
    }

    const { data: snapshots, error: snapErr } = await supabase
      .from('polymarket_snapshots')
      .select('mid_price, captured_at')
      .eq('event_id', event.id)
      .eq('outcome', yesSideName)
      .gt('captured_at', snapshotCutoff)
      .order('captured_at', { ascending: true });

    if (snapErr) {
      await logEvent({
        component: 'calendar_driven_detector',
        status: 'error',
        message: `Snapshot query failed for event ${event.id}: ${snapErr.message}`,
        metadata: { event_id: event.id, error: snapErr.message },
      });
      continue;
    }

    const validPrices = (snapshots ?? [])
      .map((s) => s.mid_price as number | null)
      .filter((p): p is number => p !== null);

    if (validPrices.length < 5) {
      await logEvent({
        component: 'calendar_driven_detector',
        status: 'partial',
        message: `Event ${event.id} skipped: only ${validPrices.length} valid snapshots (need >= 5)`,
        metadata: { event_id: event.id, snapshot_count: validPrices.length },
      });
      skippedLowSnapshots++;
      continue;
    }

    const vol = stddev(validPrices);

    if (vol >= 0.005) {
      skippedHighVolatility++;
      continue;
    }

    const lastPrice = validPrices[validPrices.length - 1]!;
    if (lastPrice <= PRICE_EXTREME_LOW || lastPrice >= PRICE_EXTREME_HIGH) {
      skippedExtremePrice++;
      continue;
    }

    flaggedCount++;

    const currentYesPrice = validPrices[validPrices.length - 1]!;
    const daysUntil = (new Date(event.end_date).getTime() - now.getTime()) / (1000 * 60 * 60 * 24);
    const confidenceScore = Math.min(1.0, (0.005 - vol) / 0.005 + 0.5);
    const volume24h = event.volume_24h ?? 0;
    const nowIso = now.toISOString();
    const expiresAt = event.end_date;

    const reasoning =
      `Market resolve em ${Math.round(daysUntil)} dias. ` +
      `Preço Yes estável em ${currentYesPrice.toFixed(2)} últimas 24h (volatilidade ${(vol * 100).toFixed(2)}pp). ` +
      `Volume 24h: $${volume24h.toFixed(0)}. ` +
      `Avaliar tese fundamental antes de operar.`;

    // Dedup: por event_id + signal_type dentro da janela
    const { data: existingRows, error: dedupErr } = await supabase
      .from('detected_signals')
      .select('id, metadata, created_at, acted_on')
      .eq('signal_type', 'calendar_driven')
      .eq('event_id', event.id)
      .eq('dismissed', false)
      .order('created_at', { ascending: false });

    if (dedupErr) {
      await logEvent({
        component: 'calendar_driven_detector',
        status: 'error',
        message: `Dedup query failed for event ${event.id}: ${dedupErr.message}`,
        metadata: { event_id: event.id, error: dedupErr.message },
      });
      continue;
    }

    const existing = (existingRows ?? [])[0] ?? null;

    if ((existingRows ?? []).length > 1) {
      const olderIds = (existingRows ?? []).slice(1).map(r => r.id);
      await supabase
        .from('detected_signals')
        .update({ dismissed: true })
        .in('id', olderIds);

      await logEvent({
        component: 'calendar_driven_detector',
        status: 'partial',
        message: `Auto-dismissed ${olderIds.length} duplicate signal(s) for event ${event.id}`,
        metadata: { event_id: event.id, dismissed_ids: olderIds },
      });
    }

    // Verificar se há bet aberta no evento
    const { data: openBets, error: openBetsErr } = await supabase
      .from('my_bets')
      .select('id')
      .eq('event_id', event.id)
      .is('closed_at', null)
      .limit(1);

    const hasOpenBet = !openBetsErr && (openBets ?? []).length > 0;

    if (existing) {
      dedupedCount++;
      const prevMeta = (existing.metadata ?? {}) as Partial<CalendarDrivenSignalMetadata>;
      const updatedMeta: CalendarDrivenSignalMetadata = {
        end_date: event.end_date,
        days_until_resolution: daysUntil,
        current_yes_price: currentYesPrice,
        volatility_24h: vol,
        snapshot_count: validPrices.length,
        volume_24h: volume24h,
        polymarket_category: event.polymarket_category,
        is_ai_tech: event.is_ai_tech,
        detection_count: (prevMeta.detection_count ?? 1) + 1,
        last_seen_at: nowIso,
      };

      const updateData: Record<string, unknown> = {
        confidence_score: confidenceScore,
        metadata: updatedMeta,
        expires_at: expiresAt,
      };

      if (hasOpenBet && !(existing as { acted_on: boolean }).acted_on) {
        updateData['acted_on'] = true;
      }

      await supabase
        .from('detected_signals')
        .update(updateData)
        .eq('id', existing.id);
    } else {
      const metadata: CalendarDrivenSignalMetadata = {
        end_date: event.end_date,
        days_until_resolution: daysUntil,
        current_yes_price: currentYesPrice,
        volatility_24h: vol,
        snapshot_count: validPrices.length,
        volume_24h: volume24h,
        polymarket_category: event.polymarket_category,
        is_ai_tech: event.is_ai_tech,
        detection_count: 1,
        last_seen_at: nowIso,
      };

      pendingSignals.push({
        event_id: event.id,
        signal_type: 'calendar_driven',
        confidence_score: confidenceScore,
        reasoning,
        metadata,
        suggested_outcome: null,
        suggested_stake_pct: null,
        expires_at: expiresAt,
        alerted: hasOpenBet,
        acted_on: hasOpenBet,
      });
    }
  }

  const signalsResult = await batchInsert('detected_signals', pendingSignals, {
    label: 'calendar_driven_detector',
  });

  await logEvent({
    component: 'calendar_driven_detector',
    status: signalsResult.errors.length > 0 ? 'partial' : 'success',
    message: `Evaluated ${marketsEvaluated} markets, ${flaggedCount} flagged, ${dedupedCount} deduped, ${skippedLowSnapshots} skipped_low_snapshots, ${skippedHighVolatility} skipped_high_volatility, ${skippedMalformedOutcomes} skipped_malformed_outcomes, ${skippedStale} skipped_stale, ${skippedExtremePrice} skipped_extreme_price, ${skippedCooldown} skipped_cooldown`,
    metadata: {
      markets_evaluated: marketsEvaluated,
      flagged: flaggedCount,
      deduped: dedupedCount,
      skipped_low_snapshots: skippedLowSnapshots,
      skipped_high_volatility: skippedHighVolatility,
      skipped_malformed_outcomes: skippedMalformedOutcomes,
      skipped_stale: skippedStale,
      skipped_extreme_price: skippedExtremePrice,
      skipped_cooldown: skippedCooldown,
      signals_inserted: signalsResult.written,
      duration_ms: Date.now() - start,
      write_errors: signalsResult.errors.length > 0 ? signalsResult.errors : null,
    },
  });
}
