import { supabase } from '../lib/supabase.js';
import { getSystemConfig } from '../lib/config.js';
import { logEvent } from '../lib/logger.js';

export async function runRetentionJob(): Promise<void> {
  const start = Date.now();
  const config = await getSystemConfig();

  const { snapshot_retention_days, system_logs_retention_days } = config;

  const snapshotCutoff = new Date(
    Date.now() - snapshot_retention_days * 24 * 60 * 60 * 1000
  ).toISOString();
  const logCutoff = new Date(
    Date.now() - system_logs_retention_days * 24 * 60 * 60 * 1000
  ).toISOString();

  const { count: snapshotCount, error: snapshotError } = await supabase
    .from('polymarket_snapshots')
    .delete({ count: 'exact' })
    .lt('captured_at', snapshotCutoff);

  if (snapshotError) {
    await logEvent({
      component: 'retention_job',
      status: 'error',
      message: `Failed to delete snapshots: ${snapshotError.message}`,
      metadata: { error: snapshotError.message },
    });
    return;
  }

  const { count: logCount, error: logError } = await supabase
    .from('system_logs')
    .delete({ count: 'exact' })
    .lt('created_at', logCutoff)
    .neq('component', 'retention_job');

  if (logError) {
    await logEvent({
      component: 'retention_job',
      status: 'error',
      message: `Failed to delete logs: ${logError.message}`,
      metadata: { error: logError.message },
    });
    return;
  }

  // Delete snapshots from finalized events regardless of age
  let finalizedSnapshotCount = 0;
  const { data: finalizedEvents } = await supabase
    .from('events')
    .select('id')
    .in('status', ['resolved', 'closed_manual', 'inactive']);

  if (finalizedEvents && finalizedEvents.length > 0) {
    const finalizedIds = finalizedEvents.map(e => e.id);
    const { count, error: finalErr } = await supabase
      .from('polymarket_snapshots')
      .delete({ count: 'exact' })
      .in('event_id', finalizedIds);

    if (finalErr) {
      await logEvent({
        component: 'retention_job',
        status: 'error',
        message: `Failed to delete finalized event snapshots: ${finalErr.message}`,
        metadata: { error: finalErr.message },
      });
    } else {
      finalizedSnapshotCount = count ?? 0;
    }
  }

  await logEvent({
    component: 'retention_job',
    status: 'success',
    message: `Deleted ${snapshotCount ?? 0} old snapshots, ${finalizedSnapshotCount} from finalized events, ${logCount ?? 0} logs`,
    metadata: {
      snapshots_deleted: snapshotCount ?? 0,
      finalized_snapshots_deleted: finalizedSnapshotCount,
      logs_deleted: logCount ?? 0,
      snapshot_retention_days,
      system_logs_retention_days,
      duration_ms: Date.now() - start,
    },
  });
}
