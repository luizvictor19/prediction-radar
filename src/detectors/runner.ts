import { runCrossMarketIntraDetector } from './cross-market.js';
import { logEvent } from '../lib/logger.js';

type DetectorFn = () => Promise<void>;

const ACTIVE_DETECTORS: Array<{ name: string; fn: DetectorFn }> = [
  { name: 'cross_market_intra', fn: runCrossMarketIntraDetector },
  // { name: 'calendar_driven', fn: runCalendarDrivenDetector },
  // { name: 'hype_reality_gap', fn: runHypeRealityGapDetector },
];

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

  const duration = Date.now() - start;
  await logEvent({
    component: 'detector_runner',
    status: results.every((r) => r.success) ? 'success' : 'partial',
    message: `Ran ${results.length} detectors in ${duration}ms`,
    metadata: { results, duration_ms: duration },
  });
}
