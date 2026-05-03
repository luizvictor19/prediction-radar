import type { CalendarDrivenSignalMetadata } from '../types/index.js';
import { supabase } from '../lib/supabase.js';
import { getSystemConfig } from '../lib/config.js';
import { logEvent } from '../lib/logger.js';

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
}

export async function runCalendarDrivenDetector(): Promise<void> {
  const start = Date.now();
  const config = await getSystemConfig();

  const { cross_market_dedup_window_minutes: dedupWindowMinutes, collector_min_volume_24h: minVolume } = config;

  const now = new Date();
  const sevenDaysOut = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();

  const { data: events, error: fetchError } = await supabase
    .from('events')
    .select('id, title, polymarket_category, is_ai_tech, volume_24h, end_date')
    .eq('status', 'active')
    .eq('tracked', true)
    .gt('end_date', now.toISOString())
    .lte('end_date', sevenDaysOut)
    .gte('volume_24h', minVolume);

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

  let marketsEvaluated = 0;
  let flaggedCount = 0;
  let dedupedCount = 0;
  let skippedLowSnapshots = 0;
  let skippedHighVolatility = 0;

  const dedupCutoff = new Date(now.getTime() - dedupWindowMinutes * 60 * 1000).toISOString();
  const snapshotCutoff = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();

  for (const event of rows) {
    marketsEvaluated++;

    const { data: snapshots, error: snapErr } = await supabase
      .from('polymarket_snapshots')
      .select('mid_price, captured_at')
      .eq('event_id', event.id)
      .eq('outcome', 'Yes')
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

    flaggedCount++;

    const currentYesPrice = validPrices[validPrices.length - 1]!;
    const daysUntil = (new Date(event.end_date).getTime() - now.getTime()) / (1000 * 60 * 60 * 24);
    const confidenceScore = Math.min(1.0, (0.005 - vol) / 0.005 + 0.5);
    const volume24h = event.volume_24h ?? 0;
    const nowIso = now.toISOString();
    const expiresAt = new Date(now.getTime() + 30 * 60 * 1000).toISOString();

    const reasoning =
      `Market resolve em ${Math.round(daysUntil)} dias. ` +
      `Preço Yes estável em ${currentYesPrice.toFixed(2)} últimas 24h (volatilidade ${(vol * 100).toFixed(2)}pp). ` +
      `Volume 24h: $${volume24h.toFixed(0)}. ` +
      `Avaliar tese fundamental antes de operar.`;

    // Dedup: por event_id + signal_type dentro da janela
    const { data: existing, error: dedupErr } = await supabase
      .from('detected_signals')
      .select('id, metadata')
      .eq('signal_type', 'calendar_driven')
      .eq('event_id', event.id)
      .eq('dismissed', false)
      .eq('acted_on', false)
      .gte('created_at', dedupCutoff)
      .limit(1)
      .maybeSingle();

    if (dedupErr) {
      await logEvent({
        component: 'calendar_driven_detector',
        status: 'error',
        message: `Dedup query failed for event ${event.id}: ${dedupErr.message}`,
        metadata: { event_id: event.id, error: dedupErr.message },
      });
      continue;
    }

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

      await supabase
        .from('detected_signals')
        .update({ confidence_score: confidenceScore, metadata: updatedMeta })
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

      await supabase.from('detected_signals').insert({
        event_id: event.id,
        signal_type: 'calendar_driven',
        confidence_score: confidenceScore,
        reasoning,
        metadata,
        suggested_outcome: null,
        suggested_stake_pct: null,
        expires_at: expiresAt,
        alerted: false,
      });
    }
  }

  await logEvent({
    component: 'calendar_driven_detector',
    status: 'success',
    message: `Evaluated ${marketsEvaluated} markets, ${flaggedCount} flagged, ${dedupedCount} deduped, ${skippedLowSnapshots} skipped_low_snapshots, ${skippedHighVolatility} skipped_high_volatility`,
    metadata: {
      markets_evaluated: marketsEvaluated,
      flagged: flaggedCount,
      deduped: dedupedCount,
      skipped_low_snapshots: skippedLowSnapshots,
      skipped_high_volatility: skippedHighVolatility,
      duration_ms: Date.now() - start,
    },
  });
}
