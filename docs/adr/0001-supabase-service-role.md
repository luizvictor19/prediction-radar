# 0001 · Supabase Postgres, accessed through the service role

- **Status**: accepted (documenting an existing decision)
- **Date**: 2026-11-03, recorded retrospectively. The decision dates from the start of the project (April 2026).

## Context

One person builds and uses this system. It needs a relational database that a long-running
Node process, ad hoc scripts and a local screen can all read and write. Nobody else signs in,
so there is no per-user access rule to enforce.

## Decision

The database is Supabase Postgres. Every server-side caller (the Node process in `src/`, the
`tsx` scripts in `scripts/`, the Vite dev proxy of `web/`) connects with `SUPABASE_URL` and
`SUPABASE_SERVICE_KEY` (`src/lib/supabase.ts`). Supabase Auth is not used. Schema changes go
only through migrations in `supabase/migrations`, written by a session and applied by Luiz.

## Consequences

- No login, no session handling, no policies to write or test.
- The service role bypasses RLS. RLS is enabled on several tables with no policy at all
  (`create policy` matches nothing in the migrations), so the anon key reads nothing there; the
  radar views revoke `anon` and `authenticated`, and `20260829001257_revoke_legacy_grants_from_anon.sql`
  closes the legacy grants. Access control is "only the service role", not row rules.
- The key must never reach a browser (see 0008).
- A second user, or a public product, needs a new access model and a new ADR.
