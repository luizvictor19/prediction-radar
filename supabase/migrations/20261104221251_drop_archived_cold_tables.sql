-- Issue 54: drop the cold tables that were archived to Storage.
--
-- What leaves the database: the ten esports_snapshots partitions from
-- 2026-08-05 to 2026-08-14 (esports collection is off since the 2026-08-14
-- pivot) and polymarket_snapshots_legado (the pre-partition table kept by
-- 20260814014541). About 1.98 GB of the 3.41 GB database, measured 2026-11-04.
--
-- Where it went: bucket `arquivo-frio`, prefix `2026-11-04/`, one gzip'd
-- data-only dump per table (`supabase db dump --data-only --use-copy`), plus a
-- `manifest.json` with table, rows, bytes and sha256. A second copy lives on
-- the owner's machine. Checked on 2026-11-04 before this file was written:
--   * rows in every dump equal an exact count(*) in this database
--     (14,348,674 in total);
--   * every file downloaded back from the bucket matches its manifest sha256.
--
-- Restoring one table: create it again (a partition of esports_snapshots for
-- that day, or the legado table), then `gunzip -c FILE | psql <db-url>`.
--
-- Nothing else depends on these tables: no view, function body, incoming
-- foreign key or publication (catalog read, 2026-11-04 22:12 UTC). The parent
-- esports_snapshots and its default partition stay. manage_esports_partitions
-- only creates the coming days and drops expired ones, so it is unaffected.
--
-- The guard below recounts every table and refuses to drop anything if one
-- holds MORE rows than its archive: such a row was written after the export
-- and would exist nowhere else. Fewer rows is safe (the archive is a
-- superset), and so is a missing or empty table, which is what a fresh local
-- stack (`npm run test:db`) has: nothing there is archived data. It is a
-- full scan of cold tables (about 1.9 GB) that nothing writes to, so it costs
-- time, not contention.

do $guard$
declare
  expected constant jsonb := '{
    "esports_snapshots_p20260805": 322598,
    "esports_snapshots_p20260806": 919234,
    "esports_snapshots_p20260807": 1808586,
    "esports_snapshots_p20260808": 1941504,
    "esports_snapshots_p20260809": 2037408,
    "esports_snapshots_p20260810": 1580278,
    "esports_snapshots_p20260811": 1747824,
    "esports_snapshots_p20260812": 1917692,
    "esports_snapshots_p20260813": 1902786,
    "esports_snapshots_p20260814": 79036,
    "polymarket_snapshots_legado": 91728
  }';
  t      text;
  actual bigint;
begin
  for t in select jsonb_object_keys(expected) loop
    continue when to_regclass(format('public.%I', t)) is null;
    execute format('select count(*) from public.%I', t) into actual;
    if actual > (expected ->> t)::bigint then
      raise exception 'issue 54: % has % rows, the archive has only %; nothing dropped',
        t, actual, expected ->> t;
    end if;
  end loop;
end
$guard$;

drop table if exists public.esports_snapshots_p20260805;
drop table if exists public.esports_snapshots_p20260806;
drop table if exists public.esports_snapshots_p20260807;
drop table if exists public.esports_snapshots_p20260808;
drop table if exists public.esports_snapshots_p20260809;
drop table if exists public.esports_snapshots_p20260810;
drop table if exists public.esports_snapshots_p20260811;
drop table if exists public.esports_snapshots_p20260812;
drop table if exists public.esports_snapshots_p20260813;
drop table if exists public.esports_snapshots_p20260814;

drop table if exists public.polymarket_snapshots_legado;
