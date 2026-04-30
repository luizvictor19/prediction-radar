import type { DetectedSignal, Event } from '../types/index.js';

export function buildDailyReportPrompt(signals: DetectedSignal[], events: Event[]): string {
  const eventMap = new Map(events.map((e) => [e.id, e]));

  const signalSummaries = signals.map((s) => {
    const event = eventMap.get(s.event_id);
    return `- [${s.signal_type}] ${event?.title ?? s.event_id}: confidence ${s.confidence_score.toFixed(2)}, outcome: ${s.suggested_outcome ?? 'N/A'}. ${s.reasoning ?? ''}`;
  });

  return `You are an assistant analyzing prediction market signals for AI and Big Tech markets.

Today's active signals (${new Date().toISOString().slice(0, 10)}):
${signalSummaries.length > 0 ? signalSummaries.join('\n') : 'No signals today.'}

Provide a concise daily briefing (max 300 words) covering:
1. Which signals look most actionable and why
2. Any patterns or themes across signals
3. Key risks or caveats to consider

Be direct and analytical. No fluff.`;
}
