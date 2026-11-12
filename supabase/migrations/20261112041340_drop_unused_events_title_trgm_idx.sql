-- Issue 59: drop events_title_trgm_idx, a GIN trigram index on events.title
-- that nothing uses.
--
-- 32.3 MB, 0 scans in pg_stat_user_indexes since the 2026-11-04 Postgres
-- upgrade (measured 2026-11-12 03:39 UTC). No `ilike`, `like`, similarity call
-- or text search exists in src/, web/src/ or scripts/, and no public function
-- body names the index. It also makes every insert into events pay for a GIN
-- update, as 20260804165019_events_discovered_via.sql already noted.
--
-- The pg_trgm extension stays: dropping it is a separate decision.
--
-- Rebuild if a title search ever needs it:
--   create index events_title_trgm_idx on public.events
--     using gin (title public.gin_trgm_ops);
--
-- Lock: DROP INDEX takes ACCESS EXCLUSIVE on events for the catalog change
-- only. lock_timeout makes it give up instead of queueing behind a long read.
-- It is set inside a DO block so it holds whatever the runner's transaction
-- mode, as in 20261104221251_drop_archived_cold_tables.sql.

do $drop$
begin
  perform set_config('lock_timeout', '10s', true);
  drop index if exists public.events_title_trgm_idx;
end
$drop$;
