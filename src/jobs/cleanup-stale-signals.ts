import { supabase } from '../lib/supabase.js';
import { logEvent } from '../lib/logger.js';
import { getSystemConfig } from '../lib/config.js';

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
  const config = await getSystemConfig();
  const STALE_THRESHOLD_MS = config.stale_cleanup_threshold_hours * 60 * 60 * 1000;
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

  // Verificar cada event individualmente em batches paralelos.
  // Query única com .in() trunca em 1000 rows (Supabase default) — com 66+
  // events e ~40 snaps/h cada, ultrapassa o limite e liveEventIds fica incompleto.
  const eventIdsArr = Array.from(eventIdsToCheck);
  const liveEventIds = new Set<string>();
  const BATCH_SIZE = 100;

  for (let i = 0; i < eventIdsArr.length; i += BATCH_SIZE) {
    const batch = eventIdsArr.slice(i, i + BATCH_SIZE);
    const checks = await Promise.all(
      batch.map(async (eventId) => {
        const { data } = await supabase
          .from('polymarket_snapshots')
          .select('event_id')
          .eq('event_id', eventId)
          .gte('captured_at', stalenessThreshold)
          .limit(1)
          .maybeSingle();
        return data ? eventId : null;
      })
    );
    for (const eventId of checks) {
      if (eventId) liveEventIds.add(eventId);
    }
  }

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
