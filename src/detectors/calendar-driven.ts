// Stub — implemented in Week 3-4 per roadmap
import type { DetectedSignal } from '../types/index.js';
import { logEvent } from '../lib/logger.js';

export async function detectCalendarDriven(): Promise<DetectedSignal[]> {
  await logEvent({ component: 'detector.calendar-driven', status: 'success', message: 'Stub — not yet implemented' });
  return [];
}
