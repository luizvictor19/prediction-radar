// Stub — implemented in Week 7-8 per roadmap
import type { DetectedSignal } from '../types/index.js';
import { logEvent } from '../lib/logger.js';

export async function detectHypeRealityGap(): Promise<DetectedSignal[]> {
  await logEvent({ component: 'detector.hype-reality-gap', status: 'success', message: 'Stub — not yet implemented' });
  return [];
}
