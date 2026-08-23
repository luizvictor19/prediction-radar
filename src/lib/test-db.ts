import { createClient, type SupabaseClient } from '@supabase/supabase-js';

/**
 * The test database: a local Supabase stack, and never this project's.
 *
 * Some defects only a real Postgres produces. The one this exists for is
 * pagination by OFFSET under a non-total order — rows shift between pages and
 * the reader silently sees some twice and others never. Two substitutes were
 * tried and rejected in `f755843` (spying on the query builder, simulating
 * PostgREST): both assert that the code calls what it already calls, and neither
 * fails when the ordering is wrong.
 *
 * ## Writing here is allowed, and the guard is why
 *
 * `CLAUDE.md` forbids writes to the database. That prohibition is about the
 * project's Supabase instance, which holds a time series nothing can rebuild.
 * A test that seeds 4000 rows has to write somewhere, so the rule is kept by
 * making the target impossible to confuse: every client this module hands out
 * has been through `requireLocalDatabase`, which throws on any host that is not
 * this machine. A misconfigured `TEST_SUPABASE_URL` crashes the test run instead
 * of writing to production.
 *
 * ## Absent is skipped, never green
 *
 * The stack is not a prerequisite of `npm test`. A test that needs it and does
 * not find it SKIPS with the reason stated. What it must never do is pass — a
 * green that proves nothing is the failure mode this project treats as worse
 * than no test at all. Set `RADAR_TEST_DB=required` to turn absence into a
 * failure instead: that is the switch for a run that is supposed to have the
 * database, so "skipped" cannot become permanent by accident.
 */

/** What `supabase start` publishes. Same on every machine — not a secret. */
const DEFAULT_URL = 'http://127.0.0.1:54321';

/**
 * The local stack's demo service key, identical in every Supabase CLI install.
 * It is in the CLI's own output and grants nothing anywhere else.
 *
 * The service role is needed rather than the anon one because the schema
 * `revoke all ... from anon, authenticated` on every table and view the tests
 * touch, and no table has an RLS policy.
 */
const DEFAULT_SERVICE_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU';

/** How long to wait for the stack before calling it absent. */
const PROBE_TIMEOUT_MS = 2000;

export const SKIP_REASON =
  'test database absent — start it with `npm run test:db` (or `supabase start`)';

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

/**
 * Is this URL served by this machine?
 *
 * Compares the parsed HOSTNAME against a closed set, and not the string against
 * a substring. `http://127.0.0.1.attacker.example/` contains `127.0.0.1` and is
 * not local; so is `https://127.0.0.1.supabase.co`. A substring test would admit
 * both, and the thing it guards is a write.
 *
 * An unparseable URL is not local. Failing closed is the only safe default for a
 * guard whose false answer sends an INSERT to production.
 */
export function isLocalDatabase(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return LOCAL_HOSTS.has(parsed.hostname);
}

/**
 * Throws unless the URL is local. Call before handing a client to anything that
 * writes.
 */
export function requireLocalDatabase(url: string): void {
  if (!isLocalDatabase(url)) {
    throw new Error(
      `refusing to use ${url} as a test database: tests write, and only a local stack may be written to. ` +
        'See the writing prohibition in CLAUDE.md.',
    );
  }
}

export function testDatabaseUrl(): string {
  return process.env['TEST_SUPABASE_URL'] ?? DEFAULT_URL;
}

/**
 * Is the stack answering?
 *
 * Any HTTP reply counts as present, including 401: the question is whether
 * something is listening on that port, not whether this key is accepted. A
 * refused connection or a timeout is absence.
 */
export async function testDatabaseAvailable(url = testDatabaseUrl()): Promise<boolean> {
  try {
    await fetch(`${url}/rest/v1/`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    return true;
  } catch {
    return false;
  }
}

/**
 * The client, or `null` when the stack is absent — which the caller turns into a
 * skip.
 *
 * With `RADAR_TEST_DB=required` absence throws instead. That is for the run that
 * is supposed to have a database: without it, a broken stack would show up as a
 * suite full of skips and a zero exit code.
 */
export async function testDatabase(): Promise<SupabaseClient | null> {
  const url = testDatabaseUrl();
  requireLocalDatabase(url);

  if (!(await testDatabaseAvailable(url))) {
    if (process.env['RADAR_TEST_DB'] === 'required') {
      throw new Error(`RADAR_TEST_DB=required, but ${SKIP_REASON}`);
    }
    return null;
  }

  const key = process.env['TEST_SUPABASE_SERVICE_KEY'] ?? DEFAULT_SERVICE_KEY;
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}
