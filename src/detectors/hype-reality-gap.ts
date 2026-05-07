import { supabase } from '../lib/supabase.js';
import { logEvent } from '../lib/logger.js';
import type { DetectedSignalInsert } from '../types/index.js';

const MOMENTUM_WINDOW_MS = 60 * 60 * 1000;
const MOMENTUM_THRESHOLD_PCT = 10;
const MOMENTUM_ABS_MIN = 0.03;
const LIQUIDITY_RATIO_THRESHOLD = 5;
const PRICE_STABLE_PCT = 3;
const SIGNAL_TTL_MS = 30 * 60 * 1000;

interface MomentumData {
  triggered: boolean;
  price_change_pct: number;
  from: number;
  to: number;
}

interface LiquidityData {
  triggered: boolean;
  volume_ratio: number;
  current_volume_1h: number;
  baseline_hourly: number;
  price_change_pct: number;
}

export async function runHypeRealityGapDetector(): Promise<void> {
  const startedAt = Date.now();

  let evaluated = 0;
  let flaggedMomentum = 0;
  let flaggedLiquidity = 0;
  let flaggedBoth = 0;
  let skippedNoData = 0;
  let skippedTailMarkets = 0;
  let deduped = 0;
  let cooldownDismissed = 0;

  try {
    const { data: events, error: eventsErr } = await supabase
      .from('events')
      .select('id, polymarket_id, title, outcomes, volume_24h, polymarket_category, end_date')
      .eq('status', 'active')
      .eq('tracked', true)
      .gte('volume_24h', 5000)
      .gt('end_date', new Date().toISOString());

    if (eventsErr || !events) {
      await logEvent({ component: 'hype_reality_gap_detector', status: 'error', message: `query failed: ${eventsErr?.message}` });
      return;
    }

    for (const event of events) {
      evaluated++;

      const outcomes = (event.outcomes as { values?: string[] })?.values ?? ['Yes', 'No'];
      const primaryOutcome = outcomes[0] ?? 'Yes';

      const { data: currentSnap } = await supabase
        .from('polymarket_snapshots')
        .select('mid_price, volume_24h, captured_at')
        .eq('event_id', event.id)
        .eq('outcome', primaryOutcome)
        .order('captured_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (!currentSnap || currentSnap.mid_price === null || currentSnap.volume_24h === null) {
        skippedNoData++;
        continue;
      }

      if (currentSnap.mid_price < 0.05 || currentSnap.mid_price > 0.95) {
        skippedTailMarkets++;
        continue;
      }

      const oneHourAgo = new Date(Date.now() - MOMENTUM_WINDOW_MS).toISOString();
      const { data: pastSnap } = await supabase
        .from('polymarket_snapshots')
        .select('mid_price, volume_24h, captured_at')
        .eq('event_id', event.id)
        .eq('outcome', primaryOutcome)
        .lte('captured_at', oneHourAgo)
        .order('captured_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (!pastSnap || pastSnap.mid_price === null || pastSnap.volume_24h === null) {
        skippedNoData++;
        continue;
      }

      const priceChangePct = Math.abs(currentSnap.mid_price - pastSnap.mid_price) / pastSnap.mid_price * 100;
      const priceChangeAbs = Math.abs(currentSnap.mid_price - pastSnap.mid_price);
      const momentum: MomentumData = {
        triggered: priceChangePct >= MOMENTUM_THRESHOLD_PCT && priceChangeAbs >= MOMENTUM_ABS_MIN,
        price_change_pct: priceChangePct,
        from: pastSnap.mid_price,
        to: currentSnap.mid_price,
      };

      const volume_1h = Math.max(0, currentSnap.volume_24h - pastSnap.volume_24h);
      const baseline_hourly = Math.max(0.001, (currentSnap.volume_24h - volume_1h) / 23);
      const liquidity_ratio = volume_1h / baseline_hourly;

      const liquidity: LiquidityData = {
        triggered: liquidity_ratio >= LIQUIDITY_RATIO_THRESHOLD && priceChangePct < PRICE_STABLE_PCT,
        volume_ratio: liquidity_ratio,
        current_volume_1h: volume_1h,
        baseline_hourly,
        price_change_pct: priceChangePct,
      };

      if (!momentum.triggered && !liquidity.triggered) continue;

      // Cooldown de 1h após dismiss: se sinal desse event foi descartado nos últimos 60min, não cria novo
      const dismissCooldownIso = new Date(Date.now() - 60 * 60 * 1000).toISOString();
      const { data: recentDismiss } = await supabase
        .from('detected_signals')
        .select('id')
        .eq('event_id', event.id)
        .eq('signal_type', 'hype_reality_gap')
        .eq('dismissed', true)
        .gte('user_dismissed_at', dismissCooldownIso)
        .order('user_dismissed_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (recentDismiss) {
        cooldownDismissed++;
        continue;
      }

      // Dedup: existe sinal ativo (não dismissed, não acted_on, não expirado) nesse event?
      const nowIso = new Date().toISOString();
      const { data: activeSignal } = await supabase
        .from('detected_signals')
        .select('id, metadata')
        .eq('event_id', event.id)
        .eq('signal_type', 'hype_reality_gap')
        .eq('dismissed', false)
        .eq('acted_on', false)
        .gt('expires_at', nowIso)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      const triggerTypes: string[] = [];
      if (momentum.triggered) triggerTypes.push('momentum');
      if (liquidity.triggered) triggerTypes.push('liquidity');

      if (activeSignal) {
        const existingMeta = (activeSignal.metadata as Record<string, unknown>) ?? {};
        const detectionCount = ((existingMeta['detection_count'] as number) ?? 1) + 1;

        const secondaryOutcome = outcomes[1] ?? 'No';

        await supabase
          .from('detected_signals')
          .update({
            metadata: {
              ...existingMeta,
              trigger_types: triggerTypes,
              momentum,
              liquidity,
              current_price: currentSnap.mid_price,
              primary_outcome: primaryOutcome,
              secondary_outcome: secondaryOutcome,
              detection_count: detectionCount,
              last_seen_at: new Date().toISOString(),
            },
            expires_at: new Date(Date.now() + SIGNAL_TTL_MS).toISOString(),
          })
          .eq('id', activeSignal.id);

        deduped++;
        continue;
      }

      const confidence = momentum.triggered && liquidity.triggered ? 0.8 : (momentum.triggered ? 0.65 : 0.6);

      const secondaryOutcome = outcomes[1] ?? 'No';

      const insert: DetectedSignalInsert = {
        event_id: event.id,
        signal_type: 'hype_reality_gap',
        confidence_score: confidence,
        reasoning: `Hype/Reality Gap detected: ${triggerTypes.join(' + ')}`,
        metadata: {
          trigger_types: triggerTypes,
          momentum,
          liquidity,
          current_price: currentSnap.mid_price,
          primary_outcome: primaryOutcome,
          secondary_outcome: secondaryOutcome,
          polymarket_category: event.polymarket_category,
          detection_count: 1,
          last_seen_at: new Date().toISOString(),
        },
        suggested_outcome: null,
        suggested_stake_pct: null,
        expires_at: new Date(Date.now() + SIGNAL_TTL_MS).toISOString(),
      };

      await supabase.from('detected_signals').insert(insert);

      if (momentum.triggered && liquidity.triggered) flaggedBoth++;
      else if (momentum.triggered) flaggedMomentum++;
      else flaggedLiquidity++;
    }

    const durationMs = Date.now() - startedAt;
    await logEvent({
      component: 'hype_reality_gap_detector',
      status: 'success',
      message: `Evaluated ${evaluated} markets: ${flaggedMomentum} momentum, ${flaggedLiquidity} liquidity, ${flaggedBoth} both, ${deduped} deduped, ${cooldownDismissed} cooldown_dismiss, ${skippedNoData} no_data, ${skippedTailMarkets} tail in ${durationMs}ms`,
    });
  } catch (err) {
    await logEvent({
      component: 'hype_reality_gap_detector',
      status: 'error',
      message: `unexpected error: ${String(err)}`,
    });
  }
}
