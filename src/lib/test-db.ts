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
 * ## Local is not enough: the stack has to be this project's
 *
 * Another project's local Supabase can hold the same port, and the tests' cleanup
 * would delete its rows (issue 77). So before any client exists, one read of the
 * OpenAPI root has to list the relations in `PROJECT_MARKERS`. A stack that
 * answers without them is skipped, or fails the run under `RADAR_TEST_DB=required`.
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

/** Everything `testDatabase` reaches outside itself. Each one defaults to the real thing. */
export interface TestDatabaseDeps {
  url?: string;
  key?: string;
  env?: Readonly<Record<string, string | undefined>>;
  fetch?: typeof fetch;
  createClient?: (url: string, key: string) => SupabaseClient;
}

/** The client to write through, or why there is none (the caller skips with it). */
export type TestDatabase = { client: SupabaseClient } | { skipReason: string };

function localClient(url: string, key: string): SupabaseClient {
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

/**
 * Relations that only this project's migrations create. A stack is this
 * project's only when its OpenAPI root lists all three.
 *
 * Not `events`: that is a name any project could have. None of these three is a
 * table issue 73 drops.
 *
 * - `market_rule_texts`: `20260823190031_guardar_texto_da_regra.sql`
 * - `market_rule_digests`: `20260815213832_digestao_de_regras.sql`
 * - `digest_achados_por_mercado`: `20260817040920_propagar_achados_por_hash.sql`
 */
const PROJECT_MARKERS = ['market_rule_texts', 'market_rule_digests', 'digest_achados_por_mercado'];

type Probe = { kind: 'absent' } | { kind: 'ours' } | { kind: 'foreign'; detail: string };

/**
 * Whose stack answers on this URL?
 *
 * One GET to the OpenAPI root, with the same key the client will use: the fewest
 * requests to a stack that may not be ours, and none of them a write. A refused
 * connection or a timeout is absence. Anything else is ours only if the root
 * lists every marker; a non-200 status, a body that is not JSON or a missing
 * marker all mean foreign. The guard fails closed: a parse error never counts as
 * ours.
 */
async function probeTestDatabase(
  url: string,
  key: string,
  fetchImpl: typeof fetch,
): Promise<Probe> {
  let response: Response;
  try {
    response = await fetchImpl(`${url}/rest/v1/`, {
      headers: { apikey: key, Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
  } catch {
    return { kind: 'absent' };
  }

  if (response.status !== 200) {
    return { kind: 'foreign', detail: `a raiz respondeu HTTP ${response.status}` };
  }

  let definitions: unknown;
  try {
    const body: unknown = JSON.parse(await response.text());
    definitions =
      typeof body === 'object' && body !== null
        ? (body as { definitions?: unknown }).definitions
        : undefined;
  } catch {
    return { kind: 'foreign', detail: 'a raiz não devolveu JSON' };
  }

  const listed =
    typeof definitions === 'object' && definitions !== null ? Object.keys(definitions) : [];
  const missing = PROJECT_MARKERS.filter((marker) => !listed.includes(marker));
  if (missing.length > 0) {
    return { kind: 'foreign', detail: `faltam ${missing.join(', ')}` };
  }
  return { kind: 'ours' };
}

function foreignStackReason(url: string, detail: string): string {
  return (
    `a stack em ${url} não é a deste projeto (${detail}); nada foi escrito. ` +
    'Se for outro projeto, pare a stack dele; se for um volume antigo deste, ' +
    '`npm run test:db:stop` e `npm run test:db` recriam.'
  );
}

/**
 * The client, or the reason there is none, which the caller turns into a skip:
 * the stack is absent, or it answers but is not this project's.
 *
 * With `RADAR_TEST_DB=required` either case throws instead. That is for the run that
 * is supposed to have a database: without it, a broken stack would show up as a
 * suite full of skips and a zero exit code.
 */
export async function testDatabase(deps: TestDatabaseDeps = {}): Promise<TestDatabase> {
  const env = deps.env ?? process.env;
  const url = deps.url ?? env['TEST_SUPABASE_URL'] ?? DEFAULT_URL;
  requireLocalDatabase(url);
  const key = deps.key ?? env['TEST_SUPABASE_SERVICE_KEY'] ?? DEFAULT_SERVICE_KEY;
  const required = env['RADAR_TEST_DB'] === 'required';

  const probe = await probeTestDatabase(url, key, deps.fetch ?? fetch);
  if (probe.kind === 'absent') {
    if (required) throw new Error(`RADAR_TEST_DB=required, but ${SKIP_REASON}`);
    return { skipReason: SKIP_REASON };
  }
  if (probe.kind === 'foreign') {
    const reason = foreignStackReason(url, probe.detail);
    if (required) throw new Error(`RADAR_TEST_DB=required, mas ${reason}`);
    return { skipReason: reason };
  }

  // Only now, with the stack known to be this project's, is there a client that writes.
  return { client: (deps.createClient ?? localClient)(url, key) };
}
