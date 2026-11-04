# 0008 · The Vite dev server as the Supabase proxy for `web/`

- **Status**: accepted (documenting an existing decision)
- **Date**: 2026-11-03, recorded retrospectively. The decision was made on 2026-08-19, after the first attempt failed.

## Context

The local screen in `web/` needs the database. The service key is refused from a browser
(Supabase answers 401, detected by User-Agent), and the anon key reads nothing because the radar
views revoke `anon` and no table has a policy (see 0001).

## Decision

The Vite dev server is the proxy. `/sb` is forwarded to PostgREST with `apikey`,
`Authorization` and `User-Agent` overwritten (`web/vite.config.ts`). `SUPABASE_URL` and
`SUPABASE_SERVICE_KEY` live in `web/.env.local` without the `VITE_` prefix, so Vite never inlines
them into the bundle. `web/src/lib/trava.ts` aborts if a `VITE_*` variable looks like a secret.

## Consequences

- The key has no path to the browser.
- The screen only runs under `npm run dev`; there is no deployed screen.
- The proxy has no authentication of its own (PR 23): anyone who reaches the dev server port
  reaches the database as the service role. It listens on `localhost` only.
- A public product would be a different app, on the anon key and public views.
