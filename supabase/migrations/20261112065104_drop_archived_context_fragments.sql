-- Issue 63: drop context_fragments, archived to Drive, to bring the
-- organization under the Free plan quota (0.5 GB for the whole organization,
-- dashboard 2026-11-12: 0.51 / 0.5 GB).
--
-- What leaves: public.context_fragments, 33,787 rows written 2026-08-06 to
-- 2026-08-14 by the esports enricher (off since the 2026-08-14 pivot),
-- 50.4 MB of the 494 MB database (measured 2026-11-12).
--
-- Where it went: gdrive:prediction-radar-arquivo-frio/esports-frio-2026-11-12/
-- context_fragments.sql.gz (sha256 353cd4c8c718023097a6a21647771e0c8a05bafd
-- 4dc806885c3774d85c053b8f, 8,355,351 bytes), a data-only dump with the
-- setval lines removed. Its 33,787 rows equal an exact count(*) in this
-- database, and rclone check --download found 0 differences. A second copy
-- lives in ~/arquivo-frio-radar/esports-frio-2026-11-12/ on the owner's
-- machine. Restoring: recreate the table from 20260806211531, then
-- `gunzip -c FILE | psql <db-url>`.
--
-- Who depended on it (2026-11-12):
--   * analysis_claims.fragment_id: a foreign key with ON DELETE SET NULL. The
--     claim keeps its quoted text by design (comment on that column), so the
--     key is dropped and the ids stay as they are, pointing into the archive.
--     src/eval/dataset.ts reads analysis_claims, not the fragments.
--   * the context_fragments_guard trigger: dropped with the table; its
--     function is dropped here.
--   * run_context_fragment_retention(integer): no caller in src/, scripts/
--     or any job ("Nenhum job chama" in 20260806211531). Dropped.
--   * no view; src/ only names the table in a config comment and a type.
--
-- One DO block, so a raise aborts everything. The table is locked in SHARE
-- mode before the recount, so count and drop see the same rows; more rows
-- than the archive refuses, fewer or none passes (a fresh local stack).

do $archive$
declare
  expected constant bigint := 33787;
  actual bigint;
begin
  perform set_config('lock_timeout', '10s', true);

  if to_regclass('public.context_fragments') is not null then
    lock table public.context_fragments in share mode;
    select count(*) into actual from public.context_fragments;
    if actual > expected then
      raise exception 'issue 63: context_fragments tem % linhas e o arquivo só tem %; nada foi apagado',
        actual, expected;
    end if;

    alter table if exists public.analysis_claims
      drop constraint if exists analysis_claims_fragment_id_fkey;
    drop table public.context_fragments;
  end if;

  drop function if exists public.context_fragments_guard();
  drop function if exists public.run_context_fragment_retention(integer);
end
$archive$;
