-- Issue 63: delete the events that are off the radar and referenced by
-- nothing, archived to Drive first, to keep the organization under the Free
-- plan quota (0.5 GB for the whole organization).
--
-- What leaves: rows of public.events that
--   * are not radar_tracked,
--   * have no row in my_bets, my_bet_legs, detected_signals,
--     market_match_links, market_rule_digests, ai_analyses or
--     polymarket_snapshots,
--   * were last updated before the dump started (2026-11-12 07:10:25.83801
--     UTC), so every deleted row is in the archive as it is here.
-- Measured 2026-11-12 07:14 UTC with that exact predicate: 106,084 rows, about
-- 137 MB of row data, of 141,262 events. 57,405 of them are still 'active' on
-- Polymarket. They are markets the old discovery collector stored and nothing
-- uses: the radar picks candidates from the Gamma API (radar-collector.ts,
-- fetchMarketsByTag) and upserts them, so a market that becomes a candidate
-- again is inserted again.
--
-- Where it went: gdrive:prediction-radar-arquivo-frio/events-2026-11-12/
-- events.sql.gz (sha256 0763e52ecc96eda1d681a3c76841cab5a7f6dd27208c2449231b
-- f64814f890c2, 34,705,805 bytes), every row of events (141,262, equal to
-- count(*) before and after the dump), setval lines removed; rclone check
-- --download found 0 differences. Second copy in
-- ~/arquivo-frio-radar/events-2026-11-12/. Restoring the deleted rows: load
-- the file into a scratch copy of the table and insert the ids missing here.
--
-- DELETE alone does not shrink the table: the owner runs VACUUM FULL
-- public.events afterwards (it cannot run inside a migration).
--
-- Why the temporary index: four foreign keys into events are ON DELETE
-- CASCADE, and detected_signals.event_id has no index, so each deleted event
-- would scan detected_signals (31,187 rows). The index is dropped at the end.
--
-- Guard: the rows are counted with the same predicate right before the
-- delete; more than the 106,084 measured refuses and deletes nothing. Fewer
-- (some got a reference or a newer update since) is safe. A fresh local stack
-- has no such rows and passes.
--
-- statement_timeout: the CLI session cancels at about 2 minutes, and the
-- predicate alone took ~30 to 80 s on 2026-11-12. It is raised for this file
-- and reset at the end. Locks: DELETE takes ROW EXCLUSIVE on events, which
-- blocks no reader and no writer of other rows.

set statement_timeout = '15min';

do $trim$
declare
  measured constant bigint := 106084;
  cutoff   constant timestamptz := '2026-11-12 07:10:25.83801+00';
  found    bigint;
  deleted  bigint;
begin
  perform set_config('lock_timeout', '10s', true);

  -- Inside the block, so a refusal rolls the index back with everything else.
  create index if not exists detected_signals_event_id_tmp_63
    on public.detected_signals (event_id);

  create temp table events_to_delete_63 on commit drop as
  select e.id
    from public.events e
   where not e.radar_tracked
     and coalesce(e.updated_at, e.created_at) < cutoff
     and not exists (select 1 from public.my_bets b where b.event_id = e.id)
     and not exists (select 1 from public.my_bet_legs l where l.event_id = e.id)
     and not exists (select 1 from public.detected_signals s where s.event_id = e.id)
     and not exists (select 1 from public.market_match_links m where m.event_id = e.id)
     and not exists (select 1 from public.market_rule_digests d where d.event_id = e.id)
     and not exists (select 1 from public.ai_analyses a where a.event_id = e.id)
     and not exists (select 1 from public.polymarket_snapshots p where p.event_id = e.id);

  select count(*) into found from events_to_delete_63;
  if found > measured then
    raise exception 'issue 63: % events a apagar, mais que os % medidos e arquivados; nada foi apagado',
      found, measured;
  end if;

  delete from public.events e using events_to_delete_63 t where e.id = t.id;
  get diagnostics deleted = row_count;
  raise notice 'issue 63: % events apagados (% medidos)', deleted, measured;

  drop index public.detected_signals_event_id_tmp_63;
end
$trim$;

reset statement_timeout;
