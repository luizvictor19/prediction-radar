-- Database and WAL size, for the daily `retention_job` log (issue 51, child of 50).
--
-- Why: the Supabase disk autoscaled from 8 GB to 12 GB and nothing in the
-- project had recorded size over time, so the date of the jump could not be
-- recovered. `retention_job` calls this once a day and stores both numbers in
-- its `system_logs` metadata, which that table's retention never deletes.
--
-- Read-only and cheap: `pg_database_size` reads file sizes, `pg_ls_waldir`
-- lists the WAL directory (65 files on 2026-11-04). No user table is scanned.
--
-- Permission, measured 2026-11-04 on the linked project: the `postgres` role,
-- which owns what migrations create, is NOT superuser, but is a member of
-- `pg_monitor` and has `execute` on `pg_ls_waldir()` and
-- `pg_database_size(name)`. `security definer` runs the body as that owner, so
-- `service_role` does not need `pg_monitor` itself.
--
-- The same body, run read-only that day at 20:28 UTC, returned
-- database_bytes = 3,576,433,811 and wal_bytes = 1,073,742,197.

create or replace function public.database_disk_usage ()
  returns table (database_bytes bigint, wal_bytes bigint)
  language sql
  stable
  security definer
  set search_path = public
  as $function$
  select pg_database_size(current_database())::bigint,
         (select coalesce(sum(w.size), 0)::bigint from pg_ls_waldir() w);
$function$;

comment on function public.database_disk_usage() is
  'Database and WAL size in bytes, logged daily by retention_job. Autoscale fires at 90% of the disk: 7.2 GB on an 8 GB disk. Issue 51.';

revoke all on function public.database_disk_usage()
  from public, anon, authenticated;

grant execute on function public.database_disk_usage()
  to service_role;

-- Check after apply (read-only):
--
--   select * from public.database_disk_usage();
--   -- expected: one row, database_bytes ~3.5e9 and wal_bytes ~1e9 as of 2026-11
