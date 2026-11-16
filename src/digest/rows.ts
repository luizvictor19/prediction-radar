import type { DigestResult } from './digest.js';
import type { MarketToDigest } from './store.js';

// This module builds the payload of one reading and imports no database client,
// so a test can build the real rows without SUPABASE_URL in the environment.
// `store.ts` re-exports both names, so its importers did not change.

export interface DigestRows {
  /**
   * The row of `market_rule_texts`: the digested text, stored under its hash.
   *
   * It travels in the artifact with the digest that produced it so the text is
   * stored the moment it was read, rather than recovered from
   * `events.description` afterwards, which only works until Polymarket edits
   * the description. The backfill of issue #9 cleans the past; this closes the
   * leak that would refill it.
   */
  text: Record<string, unknown>;
  digest: Record<string, unknown>;
  /** Rows of `digest_pegadinhas`, without `digest_id`: it only exists after the insert. */
  pegadinhas: Record<string, unknown>[];
  ambiguidades: Record<string, unknown>[];
}

/**
 * The rows of the four tables, built and returned, not written.
 *
 * `digest_id` is left out of the children on purpose: the parent's insert
 * generates it, and filling it here with an invented value would make the
 * payload look ready when it is not.
 */
export function buildDigestRows(
  market: MarketToDigest,
  result: DigestResult,
  promptVersion: string,
  model: string,
  /**
   * The reading index. Default 1 because that is what every pass of the ladder
   * does: one reading per (market, text, model, version). Only the leveling run
   * sends another value, computed with `proximaLeitura`.
   */
  leituraN = 1,
): DigestRows {
  return {
    // The two fields come from the same string by construction:
    // `readMarketsToDigest` trims the description before handing it to the
    // model, and `result.descriptionSha256` is `hashDescription` of exactly that
    // trimmed text. Recomputing the hash here would be a second chance to
    // disagree with the digest row sitting right below.
    text: {
      description_sha256: result.descriptionSha256,
      description: market.input.description,
      guardado_por: 'digestao',
    },
    digest: {
      event_id: market.eventId,
      description_sha256: result.descriptionSha256,
      leitura_n: leituraN,
      resolve_sim: result.output.resolveSim,
      resolve_nao: result.output.resolveNao,
      fonte: result.output.fonte,
      prazo: result.output.prazo,
      anula_se: result.output.anulaSe,
      model,
      prompt_version: promptVersion,
      tokens_input: result.usage.input,
      tokens_output: result.usage.output,
      tokens_cache_read: result.usage.cacheRead,
      tokens_cache_write: result.usage.cacheWrite,
      cost_usd: result.costUsd,
      latency_ms: result.latencyMs,
    },
    // `ordinal` keeps the order in which the model wrote. The first item of a
    // list tends to be the strongest, and that hypothesis can only be measured
    // if the order survives the write.
    pegadinhas: result.output.pegadinhas.map((p, i) => ({
      ordinal: i + 1,
      texto: p.texto,
      severidade: p.severidade,
      trecho: p.trecho,
      cenario: p.cenario,
    })),
    ambiguidades: result.output.ambiguidades.map((a, i) => ({
      ordinal: i + 1,
      tipo: a.tipo,
      trecho: a.trecho,
      trecho_conflito: a.trechoConflito,
      leitura_a: a.leituraA,
      leitura_b: a.leituraB,
    })),
  };
}
