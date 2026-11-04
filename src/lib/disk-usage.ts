/**
 * Database and WAL size, read once a day by `retention_job`.
 *
 * Exists because the Supabase disk autoscaled from 8 GB to 12 GB and nothing in
 * the project had recorded size over time, so the jump could not be dated
 * (issue 50). The numbers go into the `retention_job` row of `system_logs`,
 * which that table's own retention never deletes, so the series does not age
 * out.
 *
 * Read-only. A missing function, an error or an odd shape yields `null` in the
 * field: this is a probe inside a cleanup job, and it must never fail the job.
 */

export const DISK_USAGE_RPC = 'database_disk_usage';

export type DiskUsage = {
  database_bytes: number | null;
  wal_bytes: number | null;
};

/** The slice of `supabase.rpc` this probe needs, so tests can stand in for it. */
export type DiskUsageRpc = (
  fn: string,
) => PromiseLike<{ data: unknown; error: { message: string } | null }>;

const EMPTY: DiskUsage = { database_bytes: null, wal_bytes: null };

/** PostgREST may send bigint as a string; anything not a finite number is null. */
function toBytes(value: unknown): number | null {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}

export async function probeDiskUsage(rpc: DiskUsageRpc): Promise<DiskUsage> {
  try {
    const { data, error } = await rpc(DISK_USAGE_RPC);
    if (error) return EMPTY;

    const row: unknown = Array.isArray(data) ? data[0] : data;
    if (row === null || typeof row !== 'object') return EMPTY;

    const r = row as Record<string, unknown>;
    return { database_bytes: toBytes(r.database_bytes), wal_bytes: toBytes(r.wal_bytes) };
  } catch {
    return EMPTY;
  }
}
