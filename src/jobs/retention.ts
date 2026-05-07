import { supabase } from '../lib/supabase.js';
import { getSystemConfig } from '../lib/config.js';
import { logEvent } from '../lib/logger.js';

const RETENTION_HOURS = 24;

export async function runRetentionJob(): Promise<void> {
  const startedAt = Date.now();

  // Snapshots: delegate to SQL function to avoid client .in() limits
  const { data, error: rpcError } = await supabase.rpc('run_snapshot_retention', {
    retention_hours: RETENTION_HOURS,
  });

  if (rpcError) {
    await logEvent({
      component: 'retention_job',
      status: 'error',
      message: `RPC failed: ${rpcError.message}`,
    });
    return;
  }

  const result = data as { old_deleted: number; finalized_deleted: number };

  // Logs: client delete is fine (no UUID list, just timestamp filter)
  const config = await getSystemConfig();
  const logCutoff = new Date(
    Date.now() - config.system_logs_retention_days * 24 * 60 * 60 * 1000,
  ).toISOString();

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
    });
    return;
  }

  const durationMs = Date.now() - startedAt;
  await logEvent({
    component: 'retention_job',
    status: 'success',
    message: `Deleted ${result.old_deleted ?? 0} old (>${RETENTION_HOURS}h) + ${result.finalized_deleted ?? 0} from finalized events + ${logCount ?? 0} logs in ${durationMs}ms`,
    metadata: {
      old_deleted: result.old_deleted ?? 0,
      finalized_deleted: result.finalized_deleted ?? 0,
      logs_deleted: logCount ?? 0,
      duration_ms: durationMs,
    },
  });
}
