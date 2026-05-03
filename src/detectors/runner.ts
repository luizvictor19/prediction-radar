import { runCrossMarketIntraDetector } from './cross-market.js';
import { runCrossMarketInterDetector } from './cross-market-inter.js';
import { runCalendarDrivenDetector } from './calendar-driven.js';
import { runStaleSignalsCleanup } from '../jobs/cleanup-stale-signals.js';
import { supabase } from '../lib/supabase.js';
import { logEvent } from '../lib/logger.js';

type DetectorFn = () => Promise<void>;

const ACTIVE_DETECTORS: Array<{ name: string; fn: DetectorFn }> = [
  { name: 'cross_market_intra', fn: runCrossMarketIntraDetector },
  { name: 'cross_market_inter', fn: runCrossMarketInterDetector },
  { name: 'calendar_driven', fn: runCalendarDrivenDetector },
  { name: 'cleanup_stale_signals', fn: runStaleSignalsCleanup },
  // { name: 'hype_reality_gap', fn: runHypeRealityGapDetector },
];

async function dismissStaleSignals(): Promise<void> {
  // = detector freshness window
  const cutoff = new Date(Date.now() - 15 * 60 * 1000).toISOString();

  const { data: stale, error: selErr } = await supabase
    .from('detected_signals')
    .select('id, signal_type, metadata')
    .in('signal_type', ['cross_market_inter', 'cross_market_intra', 'calendar_driven'])
    .eq('dismissed', false)
    .eq('acted_on', false)
    .filter('metadata->>last_seen_at', 'lt', cutoff);

  if (selErr) {
    await logEvent({
      component: 'detector_runner',
      status: 'error',
      message: `dismissStaleSignals select failed: ${selErr.message}`,
    });
    return;
  }

  if (!stale || stale.length === 0) return;

  const ids = stale.map(s => s.id);
  const { error: updErr } = await supabase
    .from('detected_signals')
    .update({ dismissed: true })
    .in('id', ids);

  if (updErr) {
    await logEvent({
      component: 'detector_runner',
      status: 'error',
      message: `dismissStaleSignals update failed: ${updErr.message}`,
    });
    return;
  }

  await logEvent({
    component: 'detector_runner',
    status: 'success',
    message: `Dismissed ${ids.length} stale signal(s) (last_seen_at < ${cutoff})`,
  });
}

export async function runAllDetectors(): Promise<void> {
  const start = Date.now();
  const results: Array<{ name: string; success: boolean; error?: string }> = [];

  for (const detector of ACTIVE_DETECTORS) {
    try {
      await detector.fn();
      results.push({ name: detector.name, success: true });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      results.push({ name: detector.name, success: false, error: msg });
      await logEvent({
        component: 'detector_runner',
        status: 'error',
        message: `Detector ${detector.name} failed: ${msg}`,
        metadata: { detector: detector.name, error: msg },
      });
    }
  }

  try {
    await dismissStaleSignals();
  } catch (err) {
    console.error('[detector_runner] dismissStaleSignals failed:', err);
  }

  const duration = Date.now() - start;
  await logEvent({
    component: 'detector_runner',
    status: results.every((r) => r.success) ? 'success' : 'partial',
    message: `Ran ${results.length} detectors in ${duration}ms`,
    metadata: { results, duration_ms: duration },
  });
}
