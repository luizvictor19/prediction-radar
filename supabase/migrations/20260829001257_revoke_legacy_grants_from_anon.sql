-- Revoke the legacy DML grants held by `anon` and `authenticated` in `public`.
--
-- Measured on 2026-08-29 by three paths that share no method: the live catalog
-- (`aclexplode(pg_class.relacl)`), the migration history read on its own, and a
-- probe of the production PostgREST endpoint with the `anon` key. All three
-- agree on the list below.
--
-- Nothing here is exploitable today, and that is now observed rather than
-- inferred: every one of the ten relations answers HTTP 200 with zero rows for
-- the `anon` key, `events` included, which has ~551k rows. That result also
-- proves `anon` holds no `BYPASSRLS` and that no permissive policy exists. The
-- grant and the lock are two independent things and only the lock is holding.
--
-- The failure mode is a routine change: the first permissive policy on any
-- table below opens SELECT, INSERT, UPDATE and DELETE, because the grant was
-- already there.
--
-- Applies to the project owner only. Do not run `supabase db push` from an
-- agent session.
--
-- No explicit `begin`/`commit`: none of the other 48 migrations use one, the
-- CLI already applies each file as a single transaction, and an inner `commit`
-- would close that block early.

-- Part 1: tables.
--
-- Issue #21 lists eight. The measurement found TEN, and the two extra ones are
-- why this file is not a transcription of it:
--
--   * `esports_snapshots` (partitioned parent) was never granted OR revoked by
--     any file in the repo. It inherits the grant from the default privileges
--     described in Part 3. Its `_default` partition WAS revoked
--     (20260805142957_esports_snapshots.sql:84) and the parent was missed, so
--     the claim that every post-baseline table carries an explicit revoke is
--     18 of 20, not 20 of 20.
--
--   * `polymarket_snapshots_legado` kept the baseline ACL through the
--     `alter table ... rename` at
--     20260814014541_particionar_polymarket_snapshots.sql:134, because a rename
--     preserves privileges. Its drop is still a pending manual step, written as
--     a comment in two files. The loop below skips whatever is already gone, so
--     this migration does not care which of the two happens first.
--
-- The 32 partitions are absent because they already carry no grant for either
-- role. Note that the reason given in three earlier migrations and in issue
-- #21, that a partition reached directly through PostgREST answers with its own
-- permissions, does NOT hold: PostgREST excludes partitions from its schema
-- cache and all four probed partitions answer 404 PGRST205. Their revokes are
-- cheap defence in depth, not the load-bearing thing they were described as.
--
-- `service_role` bypasses RLS and is untouched here, so nothing in `src/` or in
-- the `web/` dev proxy loses access.

do $$
declare
  alvo text;
begin
  foreach alvo in array array[
    'public.ai_analyses',
    'public.detected_signals',
    'public.esports_snapshots',
    'public.events',
    'public.my_bet_legs',
    'public.my_bets',
    'public.polymarket_snapshots',
    'public.polymarket_snapshots_legado',
    'public.system_config',
    'public.system_logs'
  ]
  loop
    if to_regclass(alvo) is null then
      raise notice 'skipped, no such relation: %', alvo;
    else
      execute format('revoke all on table %s from anon, authenticated', alvo);
      raise notice 'revoked: %', alvo;
    end if;
  end loop;
end
$$;

-- Part 2: sequences.
--
-- These two hold `SELECT, UPDATE, USAGE` for both roles. The four sequences
-- created after the baseline are all revoked, so this is the same asymmetry as
-- Part 1. A sequence carries no RLS, so unlike the tables above there is no
-- second lock behind the grant: `USAGE` here is reachable, and `UPDATE` on a
-- sequence lets the holder call `setval`. This is the part of the file that
-- does not depend on RLS holding.

do $$
declare
  alvo text;
begin
  foreach alvo in array array[
    'public.polymarket_snapshots_id_seq',
    'public.system_logs_id_seq'
  ]
  loop
    if to_regclass(alvo) is null then
      raise notice 'skipped, no such sequence: %', alvo;
    else
      execute format('revoke all on sequence %s from anon, authenticated', alvo);
      raise notice 'revoked: %', alvo;
    end if;
  end loop;
end
$$;

-- Part 3: the default privileges. NOT APPLIED, AND NOT PENDING. Decided.
--
-- `pg_default_acl` holds six live entries in `public`, owned by `postgres` and
-- by `supabase_admin`, granting all eight privileges on every NEW table,
-- `SELECT UPDATE USAGE` on every NEW sequence and `EXECUTE` on every NEW
-- function to `anon` and `authenticated`. They come from the baseline
-- (20260804054445_remote_schema.sql:51-67) and were never reverted. They are
-- why Parts 1 and 2 fix the past without changing the future: the next table
-- created in `public` is born with the same grant.
--
-- Measured on the dashboard, 2026-08-29:
--
--   pg_has_role('postgres', 'supabase_admin', 'member') = false
--   postgres: rolsuper = false, rolbypassrls = true, rolcreaterole = true
--
-- The first two say the same thing by two paths: `postgres` is not a superuser
-- and not a member of `supabase_admin`. So a revoke aimed at the entries
-- `postgres` owns is not a no-op, it would take real effect, and the three
-- entries owned by `supabase_admin` are out of its reach entirely.
--
-- And that is why it is not worth doing. `postgres` carries `rolbypassrls` and
-- `rolcreaterole`. Whoever holds that credential already ignores RLS on every
-- table in this database and can already mint roles. Revoking table privileges
-- does not shrink that blast radius by anything.
--
-- Conclusion: the benefit is near zero, so it does not earn its cost. This
-- block stays commented permanently. It is a decision, not an open measurement,
-- and it does not need revisiting when someone next reads this file.
--
-- Deliberately NOT claimed here: anything about whether these statements would
-- disturb `supabase db push` or the dashboard SQL editor. That was not
-- measured. The benefit argument stands on its own without it, and an
-- unmeasured claim is the exact failure this file already corrects once, in the
-- partition note in Part 1.
--
-- Related but not a substitute: `supabase/config.toml:19-24` documents
-- `auto_expose_new_tables`, currently unset, and says the field disappears on
-- 2026-10-30 once always-revoked becomes permanent. That governs the CLI and
-- new behaviour; it does not undo the six entries already sitting in this
-- project's `pg_default_acl`.
--
-- Kept below only so the shape of the rejected change is legible:
--
-- alter default privileges for role postgres in schema public
--   revoke all on tables from anon, authenticated;
-- alter default privileges for role postgres in schema public
--   revoke all on sequences from anon, authenticated;
-- alter default privileges for role postgres in schema public
--   revoke all on routines from anon, authenticated;
-- alter default privileges for role supabase_admin in schema public
--   revoke all on tables from anon, authenticated;
-- alter default privileges for role supabase_admin in schema public
--   revoke all on sequences from anon, authenticated;
-- alter default privileges for role supabase_admin in schema public
--   revoke all on routines from anon, authenticated;

-- Deliberately NOT touched, each verified against the live catalog:
--
--   * `search_events_by_title` keeps its `anon` grant. It is `SECURITY INVOKER`,
--     so it runs as the caller and the RLS on `events` applies. Probed with the
--     `anon` key today it answers `200 []`. Be aware of the side effect: once
--     Part 1 removes `SELECT` on `events` from `anon`, the same call starts
--     answering `42501 permission denied for table events` instead. The grant
--     survives as a call that can only fail. Revoking it too is defensible; it
--     is left alone because it changes an externally visible response and that
--     is a separate decision.
--   * `update_updated_at` and `context_fragments_guard` return `trigger` and are
--     not callable over RPC.
--   * The 31 `pg_trgm` functions carry `EXECUTE` for `anon` and for `PUBLIC`.
--     That is stock Supabase, outside the scope of this issue.
--   * No table or view in `public` grants anything to `PUBLIC`, and no column
--     grant exists anywhere (218 columns of the 19 already-revoked relations
--     were probed individually and all answered 42501), so no statement above
--     needs a `from public` clause or a column-level revoke.
