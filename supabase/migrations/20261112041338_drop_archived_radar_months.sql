-- Issue 59: drop the closed months of the radar series that were archived to
-- Storage. The Free plan quota is 500 MB of database per project, summed
-- across the organization (two projects here, so ~1 GB), and averaged over
-- the billing cycle.
--
-- What leaves the database: polymarket_snapshots_p202608, _p202609 and
-- _p202610, 4,493,352 rows, 881.9 MB of heap and index out of a 1,509 MB
-- database (measured 2026-11-12 03:39 UTC). DROP gives the files back at
-- once; no VACUUM is needed for this part. With the index drop in
-- 20261112041340 the database lands near 595 MB, and near 480 MB after the
-- owner's VACUUM FULL of the bloated tables (issue 59).
--
-- Who reads these months, measured 2026-11-12:
--   * v_radar and v_minhas_posicoes: the 1 h, 24 h and 7 d anchors are
--     bounded (the widest window is 7 d +/- 6 h before the latest price), but
--     the latest price itself ("agora") is `order by captured_at desc limit 1`
--     with no bound. 279 of the 1,206 active radar_tracked markets have their
--     latest snapshot before 2026-11-01: they left the 800-market roster and
--     are no longer collected. After this drop their row stays (left join)
--     with a null price instead of a photo 12 to 90 days old.
--   * bot positions, notify and the resolved detector's CLV read the latest
--     price of a bet or leg with no lower bound. No bet or leg was open, so
--     none of them loses a price.
--   * the generic detectors (early-market, hype-reality-gap) read unbounded
--     history too, and are off (`generic_detectors_enabled = false`).
--   * src/eval/ reads no snapshot.
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
-- Restoring one month:
--   1. After this drop, a row with a captured_at in that month lands in
--      polymarket_snapshots_default, and creating the partition fails while
--      such a row is there. Check first:
--        select count(*) from public.polymarket_snapshots_default
--         where captured_at >= '2026-09-01' and captured_at < '2026-10-01';
--      If it is not zero, copy those rows aside, delete them from the default
--      partition, and insert them again after step 2.
--   2. create table public.polymarket_snapshots_p202609 partition of
--        public.polymarket_snapshots
--        for values from ('2026-09-01 00:00:00+00') to ('2026-10-01 00:00:00+00');
--   3. `cat FILE.part* | gunzip | psql <db-url>` (or `gunzip -c FILE` when
--      there are no parts).
--
-- Nothing else depends on these partitions (2026-11-12 04:20 UTC): pg_depend
-- shows only their own primary key and foreign key, no public function body
-- (prosrc) names them, and `git grep` over src/, web/src/ and scripts/ finds
-- none. manage_polymarket_snapshot_partitions creates only the current month
-- plus its lookahead, so these months do not come back.
--
-- One DO block, so a single raise aborts every drop. Each partition is first
-- locked in SHARE mode, which blocks INSERT, UPDATE and DELETE on it until
-- commit, so the recount and the drop see the same rows. The block refuses if
-- a partition holds MORE rows than its archive: such a row was written after
-- the export and would exist nowhere else. Fewer rows is safe (the archive is
-- a superset), and so is a missing or empty partition, which is what a fresh
-- local stack (`npm run test:db`) has.
--
-- Locks: an INSERT into the parent locks only the partition it routes to, so
-- the SHARE locks on closed months do not block the collector's writes into
-- November. The recount reads ~450 MB of heap. Dropping a partition then
-- takes ACCESS EXCLUSIVE on the parent polymarket_snapshots until commit,
-- which is right after the last drop. While that request waits behind an
-- in-flight read or write, every new query on the parent queues behind it.
-- lock_timeout caps that wait at 10 s, and then the block gives up and drops
-- nothing.

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
    execute format('lock table public.%I in share mode', t);
    execute format('select count(*) from public.%I', t) into actual;
    if actual > (expected ->> t)::bigint then
      raise exception 'issue 59: % tem % linhas e o arquivo só tem %; nada foi apagado',
        t, actual, expected ->> t;
    end if;
  end loop;

  for t in select jsonb_object_keys(expected) loop
    execute format('drop table if exists public.%I', t);
  end loop;
end
$archive$;
