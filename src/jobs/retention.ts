import { supabase } from '../lib/supabase.js';
import { getSystemConfig } from '../lib/config.js';
import { logEvent } from '../lib/logger.js';

export async function runRetentionJob(): Promise<void> {
  const startedAt = Date.now();
  const config = await getSystemConfig();
  const retentionHours = config.snapshot_retention_days * 24;

  const BATCH_SIZE = 5000;
  const MAX_BATCHES = 200; // safety cap: 1M rows máximo por job

  let oldDeleted = 0;
  let finalizedDeleted = 0;

  // Deleta snapshots antigos em batches
  for (let i = 0; i < MAX_BATCHES; i++) {
    const { data, error } = await supabase.rpc('run_snapshot_retention_batch', {
      delete_type: 'old',
      retention_hours: retentionHours,
      batch_size: BATCH_SIZE,
    });

    if (error) {
      await logEvent({
        component: 'retention_job',
        status: 'error',
        message: `Batch 'old' failed at iteration ${i}: ${error.message}`,
      });
      return;
    }

    const deleted = (data as number) ?? 0;
    oldDeleted += deleted;
    if (deleted < BATCH_SIZE) break;
  }

  // Deleta snapshots de events finalizados em batches
  for (let i = 0; i < MAX_BATCHES; i++) {
    const { data, error } = await supabase.rpc('run_snapshot_retention_batch', {
      delete_type: 'finalized',
      retention_hours: retentionHours,
      batch_size: BATCH_SIZE,
    });

    if (error) {
      await logEvent({
        component: 'retention_job',
        status: 'error',
        message: `Batch 'finalized' failed at iteration ${i}: ${error.message}`,
      });
      return;
    }

    const deleted = (data as number) ?? 0;
    finalizedDeleted += deleted;
    if (deleted < BATCH_SIZE) break;
  }

  const result = { old_deleted: oldDeleted, finalized_deleted: finalizedDeleted };

  // Logs: client delete is fine (no UUID list, just timestamp filter)
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
    message: `Deleted ${result.old_deleted ?? 0} old (>${retentionHours}h) + ${result.finalized_deleted ?? 0} from finalized events + ${logCount ?? 0} logs in ${durationMs}ms`,
    metadata: {
      old_deleted: result.old_deleted ?? 0,
      finalized_deleted: result.finalized_deleted ?? 0,
      logs_deleted: logCount ?? 0,
      duration_ms: durationMs,
    },
  });
}
