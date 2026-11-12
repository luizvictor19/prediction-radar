-- Issue 59: drop the closed months of the radar series that were archived to
-- Storage, to bring the database under the Free plan quota (500 MB per
-- project, summed across the organization).
--
-- What leaves the database: polymarket_snapshots_p202608, _p202609 and
-- _p202610, 4,493,352 rows, 881.9 MB of heap and index out of a 1,509 MB
-- database (measured 2026-11-12 03:39 UTC). DROP gives the files back at
-- once; no VACUUM is needed for this part.
--
-- Nothing live reads these months: v_radar and v_minhas_posicoes look back at
-- most 7 days + 1 hour, src/eval/ reads no snapshot, and no open bet or leg
-- had its latest price before 2026-11-01 (there were none open, 2026-11-12).
--
-- Where it went: bucket `arquivo-frio`, prefix `2026-11-12/`, one gzip'd
-- data-only dump per partition (`supabase db dump --data-only --use-copy`),
-- plus `manifest.v2.json` with rows, bytes and sha256 of each file and part.
-- The Free plan caps a Storage object at 50 MB, so the September and October
-- files are stored as 45 MiB parts. A second copy, plus a full logical dump of
-- the schema and of every public table taken before any step, lives on the
-- owner's machine in ~/arquivo-frio-radar/2026-11-12/. Checked on 2026-11-12
-- before this file was written:
--   * rows in each dump equal an exact count(*) in this database;
--   * every file and part downloaded back from the bucket matches its
--     manifest sha256, and the rejoined files decompress to the same rows.
--
-- Restoring one month: create the partition again
--   create table public.polymarket_snapshots_p202609 partition of
--     public.polymarket_snapshots
--     for values from ('2026-09-01 00:00:00+00') to ('2026-10-01 00:00:00+00');
-- then `cat FILE.part* | gunzip | psql <db-url>` (or `gunzip -c FILE` when
-- there are no parts).
--
-- Nothing else depends on these partitions (2026-11-12 04:20 UTC): pg_depend
-- shows only their own primary key and foreign key, no public function body
-- (prosrc) names them, and `git grep` over src/, web/src/ and scripts/ finds
-- none. manage_polymarket_snapshot_partitions creates only the current month
-- plus its lookahead, so these months do not come back.
--
-- One DO block, so a single raise aborts every drop. It first recounts each
-- partition and refuses if one holds MORE rows than its archive: such a row
-- was written after the export and would exist nowhere else. Fewer rows is
-- safe (the archive is a superset), and so is a missing or empty partition,
-- which is what a fresh local stack (`npm run test:db`) has.
--
-- Locks: the recount reads the three partitions under ACCESS SHARE, which
-- blocks no reader or writer. Dropping a partition takes ACCESS EXCLUSIVE on
-- the parent polymarket_snapshots until commit, which is right after the last
-- drop; the radar collector writes there every 15 minutes. lock_timeout makes
-- the block give up instead of queueing behind a long read.

do $archive$
declare
  expected constant jsonb := '{
    "polymarket_snapshots_p202608": 1117633,
    "polymarket_snapshots_p202609": 1664054,
    "polymarket_snapshots_p202610": 1711665
  }';
  t      text;
  actual bigint;
begin
  perform set_config('lock_timeout', '10s', true);

  for t in select jsonb_object_keys(expected) loop
    continue when to_regclass(format('public.%I', t)) is null;
    execute format('select count(*) from public.%I', t) into actual;
    if actual > (expected ->> t)::bigint then
      raise exception 'issue 59: % has % rows, the archive has only %; nothing dropped',
        t, actual, expected ->> t;
    end if;
  end loop;

  for t in select jsonb_object_keys(expected) loop
    execute format('drop table if exists public.%I', t);
  end loop;
end
$archive$;
