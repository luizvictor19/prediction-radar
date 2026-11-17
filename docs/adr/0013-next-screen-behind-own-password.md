# 0013 · The screen runs on Next.js, behind its own password, with narrow server routes

- **Status**: accepted. Supersedes 0008. Amends 0001 in one point (below).
- **Date**: 2026-11-17. Approved by Luiz on 2026-11-16, on the plan of issue 85, with the
  recommendation on every question. Written in the PR of sub-issue 87, before any deploy.

## Context

Since 2026-08-19 the screen in `web/` reached the database through the Vite dev server, which
forwarded `/sb` to PostgREST and attached the service key (0008). That proxy forwarded anything,
had no authentication, and was safe only because it listened on `localhost`. The accepted
consequence was that the screen existed only under `npm run dev`.

On 2026-11-12 the project was slimmed down to the reading of rule against headline. The screen is
where that reading happens: the tabs Hoje, Regra and Operar, and the recording of `prob_self`
before the outcome. What is left of the product is mostly this screen, and it could not be opened
away from one machine.

The screen reads eight views and tables and makes two inserts (`my_bets`, `my_bet_legs`). There is
still one user and no accounts (0001). The budget is zero: Vercel Hobby and Supabase Free.
Vercel's own Password Protection is not available on Hobby (Pro, $20 per project per month, read
on 2026-11-16 in Vercel's deployment protection docs). The repository is public, so nothing in the
gate may depend on its code being unknown.

## Decision

`web/` is a Next.js App Router application, pinned to the version chelsea-st-app runs (16.4.3),
meant for Vercel with `web/` as the root directory, Node 24, region `gru1`.

The browser never talks to PostgREST. It calls route handlers under `/api`, one per query the
screen makes, and each handler runs that query with the service key on the server
(`web/src/lib/servidor/consultas.ts`). There is no route that forwards an arbitrary request. The
two inserts build their row from a whitelist of validated fields (`servidor/entrada.ts`).

Access is one shared password, held in `RADAR_SENHA` and compared in constant time. A correct
password sets a cookie signed with `RADAR_SEGREDO_DE_SESSAO` (HMAC-SHA256 over an expiry and the
password's hash, 30 days, `HttpOnly`, `SameSite=Lax`, `Secure` on https). The cookie is verified
in `src/proxy.ts` for every path and again inside every handler (`comSessao`). A missing
configuration, or a password shorter than 24 characters, closes the screen with 503. A write with
an `Origin` from another host gets 403. Login attempts are to be rate limited by one Vercel WAF
rule, and preview deployments to sit behind Vercel Authentication with no database credential;
both are dashboard settings, recorded when sub-issue B deploys.

`SUPABASE_URL` and `SUPABASE_SERVICE_KEY` keep their names, without `NEXT_PUBLIC_`, and are read by
one server module (`servidor/banco.ts`) at request time. CI builds with canary values and fails if
any appears under `web/.next/static`.

**Amendment to 0001.** Its list of server-side callers named "the Vite dev proxy of `web/`"; that
caller is now the route handlers of `web/`. The password is a gate on a single-user tool, not user
authentication: there are still no accounts, no per-user rules and no Supabase Auth. The rest of
0001 stands, including that a second user needs a new access model.

## Consequences

- The screen can open from any device once deployed. `npm run dev --prefix web` still works
  locally, bound to `127.0.0.1:5173`, and now also asks for the password.
- Once deployed, the service key is stored at a third place, Vercel's environment, besides the
  owner's machine and Railway.
- A leaked password gives the reads the screen makes and the two inserts. It does not give the
  key, other tables, updates or deletes. False rows in `my_bets` and `my_bet_legs` are the damage
  to plan for.
- Adding a query to the screen now means adding a route and its test. That friction is the point;
  `src/app/api/rotas.test.ts` walks the route files on disk, so a new route without the gate fails
  without anyone writing a test for it.
- The gate has no state: no session table, no migration, and no way to end one session without
  ending all of them (change the password or the secret).
- Rate limiting lives in a Vercel dashboard, not in this repository. The password's length is the
  control that travels with the code.
- `web/` gains a build, which joins `npm run check` and CI. The tests keep running under
  `tsx --test` from the root; none imports `next`.
- `trava.ts` and the `VITE_` convention are gone; the bundle scan replaces them.
- Hobby limits pause a feature when exceeded instead of charging. A paused screen is the failure
  mode, not a bill.
- This is still not a public product. One with other readers would be a different app, on the
  anon key and public views, as 0008 already said.
