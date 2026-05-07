import { supabase } from '../lib/supabase.js';
import { logEvent } from '../lib/logger.js';

const STALE_THRESHOLD_MS = 60 * 60 * 1000; // 1h

interface SignalRow {
  id: string;
  event_id: string | null;
  signal_type: string;
  metadata: Record<string, unknown> | null;
}

interface MemberRef {
  event_id: string;
}

export async function runStaleSignalsCleanup(): Promise<void> {
  const start = Date.now();
  const stalenessThreshold = new Date(Date.now() - STALE_THRESHOLD_MS).toISOString();

  const { data: signals, error: sigErr } = await supabase
    .from('detected_signals')
    .select('id, event_id, signal_type, metadata')
    .eq('dismissed', false)
    .eq('acted_on', false);

  if (sigErr) {
    await logEvent({
      component: 'cleanup_stale_signals',
      status: 'error',
      message: `Failed to fetch active signals: ${sigErr.message}`,
    });
    return;
  }

  const rows = (signals ?? []) as SignalRow[];
  if (rows.length === 0) {
    await logEvent({
      component: 'cleanup_stale_signals',
      status: 'success',
      message: `No active signals to check.`,
      metadata: { duration_ms: Date.now() - start },
    });
    return;
  }

  const eventIdsToCheck = new Set<string>();
  for (const s of rows) {
    if (s.event_id) eventIdsToCheck.add(s.event_id);

    const members = (s.metadata as { members?: MemberRef[] })?.members;
    if (Array.isArray(members)) {
      for (const m of members) {
        if (m.event_id) eventIdsToCheck.add(m.event_id);
      }
    }
  }

  if (eventIdsToCheck.size === 0) {
    await logEvent({
      component: 'cleanup_stale_signals',
      status: 'success',
      message: `No event_ids to check.`,
    });
    return;
  }

  const { data: recentSnaps, error: snapErr } = await supabase
    .from('polymarket_snapshots')
    .select('event_id')
    .in('event_id', Array.from(eventIdsToCheck))
    .gte('captured_at', stalenessThreshold);

  if (snapErr) {
    await logEvent({
      component: 'cleanup_stale_signals',
      status: 'error',
      message: `Failed to fetch recent snapshots: ${snapErr.message}`,
    });
    return;
  }

  const liveEventIds = new Set((recentSnaps ?? []).map((s) => s.event_id as string));

  const signalsToDismiss: string[] = [];
  for (const s of rows) {
    let isStale = false;

    if (s.event_id) {
      isStale = !liveEventIds.has(s.event_id);
    } else {
      const members = (s.metadata as { members?: MemberRef[] })?.members ?? [];
      isStale = members.some((m) => !liveEventIds.has(m.event_id));
    }

    if (isStale) signalsToDismiss.push(s.id);
  }

  // === LOG TEMPORÁRIO PRA DEBUG ===
  await logEvent({
    component: 'cleanup_stale_signals',
    status: 'success',
    message: `DEBUG: events_to_check=${eventIdsToCheck.size}, live_events=${liveEventIds.size}, recent_snaps_returned=${recentSnaps?.length ?? 0}, will_dismiss=${signalsToDismiss.length}`,
  });

  const dismissReasonSummary: Record<string, number> = {};
  for (const s of rows) {
    if (!signalsToDismiss.includes(s.id)) continue;

    let reason: string;
    if (s.event_id) {
      reason = `single_event_not_live(type=${s.signal_type})`;
    } else {
      const members = (s.metadata as { members?: MemberRef[] })?.members ?? [];
      const missingMembers = members.filter(m => !liveEventIds.has(m.event_id));
      reason = `members_stale(type=${s.signal_type}, missing=${missingMembers.length}/${members.length})`;
    }
    dismissReasonSummary[reason] = (dismissReasonSummary[reason] ?? 0) + 1;
  }

  if (Object.keys(dismissReasonSummary).length > 0) {
    await logEvent({
      component: 'cleanup_stale_signals',
      status: 'success',
      message: `DEBUG dismiss_reasons: ${JSON.stringify(dismissReasonSummary)}`,
    });
  }
  // === FIM LOG TEMPORÁRIO ===

  if (signalsToDismiss.length > 0) {
    const { error: updateErr } = await supabase
      .from('detected_signals')
      .update({ dismissed: true })
      .in('id', signalsToDismiss);

    if (updateErr) {
      await logEvent({
        component: 'cleanup_stale_signals',
        status: 'error',
        message: `Failed to dismiss ${signalsToDismiss.length} signals: ${updateErr.message}`,
      });
      return;
    }
  }

  await logEvent({
    component: 'cleanup_stale_signals',
    status: 'success',
    message: `Checked ${rows.length} active signals, dismissed ${signalsToDismiss.length} stale.`,
    metadata: {
      checked: rows.length,
      dismissed: signalsToDismiss.length,
      duration_ms: Date.now() - start,
    },
  });
}
