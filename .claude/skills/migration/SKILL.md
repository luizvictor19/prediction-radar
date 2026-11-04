---
name: migration
description: The ritual for a database migration in prediction-radar, from measuring the live database to the report. Use it every time you are about to write a migration here, however small.
---

# Writing a migration

Adapted from chelsea-st-app. This repository has no RLS policies to verify and
no generated types, so those two steps are not here. What is left is the part
that cost something every time it was skipped: measure, write, stop, report.

## Steps

1. **Measure before writing.** When the migration touches existing rows, read
   the live database before writing a line of SQL. Reading is allowed, writing
   is not (`CLAUDE.md`, "Regras inegociáveis"). Report the number measured,
   with the date, never the number expected.
   - A NEW query on a large table (`events`, `polymarket_snapshots`,
     `esports_snapshots`, `system_logs`) is shown to Luiz before it runs, and
     waits. `events` has ~551k rows and PostgREST times out at 8s: a query
     with no index there is a production incident, not a lookup.
   - `psql` is denied. Read through a script under `scripts/medicoes/`, which
     is also how the number gets a command that can redo it.
2. **Write it, never apply it.** Create the file with
   `supabase migration new <name>` and stop there. Name it for what the change
   means, not for the mechanics (`prob_self_tem_lado`, not `alter_column`).
   Luiz applies. `supabase db push`, `db reset`, `db pull`, `migration up` and
   `psql` are on the deny list; do not look for an equivalent path around them.
3. **Language.** `--` comments are code comments: English. A `comment on` is a
   schema object and follows the language of the neighbouring comments on the
   same table. Older migrations stay as they are.
4. **Do not repeat an inherited claim as fact.** A sentence copied from an
   earlier migration is not measured until someone exercises it. Three applied
   migrations carry the claim that a partition is reachable through PostgREST,
   and it is false (`404 PGRST205` on all four).
5. **Run the gate.** `npm run check`, then `npm run test:db`, which starts a
   LOCAL Supabase stack and applies every migration in `supabase/migrations/`
   to it. That is the proof the SQL applies cleanly. It is local:
   `src/lib/test-db.ts` refuses any non-local URL. Stop the stack after with
   `npm run test:db:stop`.
6. **Review once.** Run code-review a single time over the whole delivery.
7. **Report**, in Portuguese:
   - the whole SQL of the migration;
   - the numbers measured in step 1, with the date and the command that
     produced them;
   - the review findings, with what was fixed and what was not, and why;
   - the reminder that the migration is written and NOT applied, so nothing
     that depends on it runs or deploys until Luiz applies it.

## Known traps

- `alter type ... add value` cannot be used in the same transaction that adds
  the value. One migration only adds it; the next one uses it.
- A `LIKE ANY` with a pattern coming from a variable does not use
  `idx_events_slug_prefix`, and falls back to a seq scan of `events`. It took
  the database down once (`20260807230005_retention_old_branch_plan.sql`).
  Check the plan of any new predicate on `events`.
- Repair data only when the affected rows can be identified with certainty. If
  they cannot, say so in the report instead of repairing by approximation.
- `supabase/migrations-adiadas/` holds migrations deliberately not applied.
  Moving one into `supabase/migrations/` is a decision for Luiz, not a cleanup.
