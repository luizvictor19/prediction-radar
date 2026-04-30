// Stub — implemented in Week 5-6 per roadmap
import type { DetectedSignal } from '../types/index.js';
import { logEvent } from '../lib/logger.js';

export async function detectCrossMarket(): Promise<DetectedSignal[]> {
  await logEvent({ component: 'detector.cross-market', status: 'success', message: 'Stub — not yet implemented' });
  return [];
}
