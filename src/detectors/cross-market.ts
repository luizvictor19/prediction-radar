import type { CrossMarketSignalMetadata } from '../types/index.js';
import { supabase } from '../lib/supabase.js';
import { getSystemConfig } from '../lib/config.js';
import { logEvent } from '../lib/logger.js';
import { getFeeRate, calculateExpectedEdgePct } from '../lib/fees.js';

interface EventRow {
  id: string;
  polymarket_id: string;
  title: string;
  outcomes: { values: string[]; prices: string[] } | null;
  end_date: string | null;
  polymarket_category: string | null;
  polymarket_fee_rate: number | null;
}

interface ExistingSignal {
  id: string;
  metadata: CrossMarketSignalMetadata;
}

export async function runCrossMarketIntraDetector(): Promise<void> {
  const start = Date.now();
  const config = await getSystemConfig();

  const {
    cross_market_log_threshold: logThreshold,
    cross_market_dedup_window_minutes: dedupWindowMinutes,
    min_expected_edge_pct: minEdgePct,
    log_expected_edge_pct: logEdgePct,
  } = config;

  const { data: events, error: fetchError } = await supabase
    .from('events')
    .select('id, polymarket_id, title, outcomes, end_date, polymarket_category, polymarket_fee_rate')
    .eq('status', 'active')
    .eq('tracked', true)
    .gt('end_date', new Date().toISOString());

  if (fetchError) {
    await logEvent({
      component: 'cross_market_detector',
      status: 'error',
      message: `Failed to fetch events: ${fetchError.message}`,
      metadata: { error: fetchError.message },
    });
    return;
  }

  const eligibleEvents = (events ?? []).filter((e) => {
    const o = e.outcomes as EventRow['outcomes'];
    return o?.values && Array.isArray(o.values) && o.values.length >= 2;
  }) as EventRow[];

  let total = eligibleEvents.length;
  let flagged = 0;
  let highConfidence = 0;
  let deduped = 0;

  for (const event of eligibleEvents) {
    const outcomes = event.outcomes!;

    let prices: number[];
    try {
      prices = outcomes.prices.map((p) => {
        const n = Number(p);
        if (isNaN(n)) throw new Error(`Non-numeric price: ${p}`);
        return n;
      });
    } catch (parseErr) {
      const msg = parseErr instanceof Error ? parseErr.message : String(parseErr);
      await logEvent({
        component: 'cross_market_detector',
        status: 'error',
        message: `Skipping event ${event.id} — price parse error: ${msg}`,
        metadata: { event_id: event.id, title: event.title },
      });
      total--;
      continue;
    }

    if (prices.length !== outcomes.values.length || prices.length === 0) {
      await logEvent({
        component: 'cross_market_detector',
        status: 'error',
        message: `Skipping event ${event.id} — outcomes/prices length mismatch`,
        metadata: { event_id: event.id, values_len: outcomes.values.length, prices_len: prices.length },
      });
      total--;
      continue;
    }

    const priceSum = prices.reduce((a, b) => a + b, 0);
    const deviation = Math.abs(priceSum - 1.0);

    if (deviation < logThreshold) continue;

    // Fee-adjusted edge — prefer rate captured from API at collection time
    const feeRate = getFeeRate(event.polymarket_category, event.polymarket_fee_rate);
    // For intra-market: treat all outcome prices as "yes prices" for fee estimation
    const expectedEdgePct = calculateExpectedEdgePct(priceSum, feeRate, prices);

    if (expectedEdgePct < logEdgePct) continue;

    flagged++;
    const confidenceScore =
      expectedEdgePct < minEdgePct ? 0 : Math.min(1.0, deviation / 0.15);
    if (confidenceScore > 0 && deviation >= config.cross_market_high_confidence_threshold) highConfidence++;

    const direction: 'over' | 'under' = priceSum > 1.0 ? 'over' : 'under';
    const outcomeDetails = outcomes.values.map((name, i) => ({ name, price: prices[i]! }));
    const now = new Date().toISOString();

    const outcomeList = outcomeDetails.map((o) => `${o.name} ${(o.price * 100).toFixed(1)}%`).join(', ');
    const directionLabel = direction === 'over' ? 'Sobrepreço' : 'Subpreço';
    const reasoning = `Market '${event.title}' soma ${(priceSum * 100).toFixed(2)}% (desvio ${(deviation * 100).toFixed(2)}%, edge líquido ${expectedEdgePct.toFixed(2)}%). Outcomes: ${outcomeList}. ${directionLabel}.`;

    const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();
    const dedupCutoff = new Date(Date.now() - dedupWindowMinutes * 60 * 1000).toISOString();

    // Dedup check
    const { data: existing, error: dedupError } = await supabase
      .from('detected_signals')
      .select('id, metadata')
      .eq('event_id', event.id)
      .eq('signal_type', 'cross_market_intra')
      .eq('dismissed', false)
      .eq('acted_on', false)
      .gte('created_at', dedupCutoff)
      .limit(1)
      .maybeSingle();

    if (dedupError) {
      await logEvent({
        component: 'cross_market_detector',
        status: 'error',
        message: `Dedup query failed for event ${event.id}: ${dedupError.message}`,
        metadata: { event_id: event.id, error: dedupError.message },
      });
      continue;
    }

    if (existing) {
      deduped++;
      const prevMeta = (existing.metadata ?? {}) as Partial<CrossMarketSignalMetadata>;
      const updatedMeta: CrossMarketSignalMetadata = {
        price_sum: priceSum,
        deviation,
        polymarket_category: event.polymarket_category,
        fee_rate: feeRate,
        expected_edge_pct: expectedEdgePct,
        direction,
        outcomes: outcomeDetails,
        detection_count: (prevMeta.detection_count ?? 1) + 1,
        last_seen_at: now,
      };

      await supabase
        .from('detected_signals')
        .update({ confidence_score: confidenceScore, metadata: updatedMeta })
        .eq('id', existing.id);
    } else {
      const metadata: CrossMarketSignalMetadata = {
        price_sum: priceSum,
        deviation,
        polymarket_category: event.polymarket_category,
        fee_rate: feeRate,
        expected_edge_pct: expectedEdgePct,
        direction,
        outcomes: outcomeDetails,
        detection_count: 1,
        last_seen_at: now,
      };

      await supabase.from('detected_signals').insert({
        event_id: event.id,
        signal_type: 'cross_market_intra',
        confidence_score: confidenceScore,
        reasoning,
        metadata,
        suggested_outcome: null,
        suggested_stake_pct: null,
        expires_at: expiresAt,
      });
    }
  }

  await logEvent({
    component: 'cross_market_detector',
    status: 'success',
    message: `Evaluated ${total} events, ${flagged} flagged, ${highConfidence} high-confidence, ${deduped} deduped`,
    metadata: {
      total,
      flagged,
      high_confidence: highConfidence,
      deduped,
      duration_ms: Date.now() - start,
    },
  });
}
