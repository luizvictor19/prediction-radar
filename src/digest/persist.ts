import type { DigestRows } from './rows.js';

/**
 * The atomic, idempotent write of one digest reading (issue 88, PR 1 of issue 86).
 *
 * The four parts of a reading (text, digest, traps, ambiguities) go to Postgres
 * in ONE rpc call to `record_rule_digest`, whose body runs in the transaction of
 * that single request. Either all four land or none does, so the "parent without
 * children" state that `scripts/carregar-digest.ts` can only report after the
 * fact cannot be produced here.
 *
 * Idempotency lives in the database, not in this module: the function inserts
 * with `on conflict do nothing` on the five-column unique of
 * `market_rule_digests`, and answers `duplicate` when the reading was already
 * there. A caller that retries after a timeout gets `duplicate` and nothing
 * changes, which is what an unattended, retrying runner needs.
 *
 * `incomplete` means the key exists but without the traps or ambiguities this
 * payload carries: a reading the manual loader left half-written. Nothing is
 * written and nothing is repaired; the caller reports it, and the repair is
 * the owner's decision.
 *
 * The client is a parameter, and this module imports no database client: the
 * same function serves the service-role client in production and a fake in the
 * pure tests, and loading it never requires SUPABASE_URL.
 */

export const RECORD_DIGEST_FUNCTION = 'record_rule_digest';

export type RecordOutcome = 'inserted' | 'duplicate' | 'incomplete';

/**
 * The one method of the Supabase client this module uses.
 *
 * Written by hand instead of `Pick<SupabaseClient, 'rpc'>`: that type makes
 * `rpc` return a `PostgrestFilterBuilder` (59 members), so a test fake could only
 * pass through an `as unknown as` cast that turns its type check off. The real
 * client satisfies this interface structurally; `persist.db.test.ts` passes it
 * unchanged.
 */
export interface RpcClient {
  rpc(
    fn: string,
    args: Record<string, unknown>,
  ): PromiseLike<{ data: unknown; error: { message: string } | null }>;
}

export async function recordDigest(client: RpcClient, rows: DigestRows): Promise<RecordOutcome> {
  const { data, error } = await client.rpc(RECORD_DIGEST_FUNCTION, {
    p_text: rows.text,
    p_digest: rows.digest,
    p_pegadinhas: rows.pegadinhas,
    p_ambiguidades: rows.ambiguidades,
  });

  if (error !== null) {
    throw new Error(`${RECORD_DIGEST_FUNCTION} falhou: ${error.message}`);
  }
  // Anything else is a contract break (a changed function, a proxy answering in
  // its place), and reading it as success would hide a reading that was not
  // written.
  if (data !== 'inserted' && data !== 'duplicate' && data !== 'incomplete') {
    throw new Error(`${RECORD_DIGEST_FUNCTION}: resposta inesperada ${JSON.stringify(data)}`);
  }
  return data;
}
