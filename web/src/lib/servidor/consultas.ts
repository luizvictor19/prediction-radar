import type { SupabaseClient } from '@supabase/supabase-js';

import { COLUNAS_CONTAGEM, ordenarContagens, paginar } from '../paginacao';
import type { TextoGuardado } from '../regulamento';
import type {
  Contradicao,
  ContagemDigest,
  CorpusCru,
  LeituraRegra,
  LinhaAchados,
  LinhaFilhaDoCorpus,
  MercadoRadar,
} from '../tipos';

/**
 * Every query the screen makes, and no other. Moved from `dados.ts` unchanged
 * (issue 85): the only difference is that the client is a parameter, built on
 * the server with the service key (`banco.ts`), instead of the browser client
 * that went through the Vite proxy. The comments came along, translated, since
 * this file is new.
 *
 * Every read is a SELECT on a view or a small table, except the rule's
 * original text (a primary-key lookup in `events`) and the two writes at the
 * end.
 *
 * None scans `events`, `polymarket_snapshots` or `system_logs`: PostgREST's
 * timeout is 8 s, and a seq scan over the 711 MB of `events` is a production
 * incident, not a query.
 */

const COLUNAS_RADAR = [
  'id',
  'slug',
  // `event_group_slug` goes HERE once
  // `20260825024030_v_radar_expoe_event_group_slug.sql` is applied. Asking for
  // it now breaks the whole query: the view does not have the column yet.
  // Until then `urlPolymarket` gets `undefined` and falls back to
  // `/market/<slug>`, measured opening the right market 55 times out of 55.
  'pergunta',
  'categoria',
  'tema',
  'assunto',
  'outcome',
  'best_bid',
  'best_ask',
  'mid_price',
  'spread',
  'preco_em',
  'preco_idade_min',
  'var_24h',
  'var_24h_base',
  'var_7d',
  'var_7d_base',
  'liquidez',
  'fecha_em',
  'dias_restantes',
  'tamanho_regra',
  'prob_self',
  'prob_self_em',
  'prob_self_estrategia',
].join(', ');

export function lerRadar(db: SupabaseClient): Promise<MercadoRadar[]> {
  return paginar<MercadoRadar>((de, ate) =>
    db.from('v_radar').select(COLUNAS_RADAR).order('id').range(de, ate),
  );
}

/**
 * The digestion counts, without the `achados` jsonb: that is the heavy field,
 * and it is only needed when a market is opened.
 *
 * The ordering comes from `ordenarContagens`, and it is a TOTAL order because
 * pagination requires one. The why is in `paginacao.ts`, next to the test that
 * measures it.
 */
export function lerContagens(db: SupabaseClient): Promise<ContagemDigest[]> {
  return paginar<ContagemDigest>((de, ate) =>
    ordenarContagens(db.from('digest_achados_por_mercado').select(COLUNAS_CONTAGEM)).range(de, ate),
  );
}

/**
 * One market's digestion, now with the findings.
 *
 * Returns a LIST, not an object: the view's grain is (market, rule text).
 * Today no market has two texts, but Polymarket editing a description creates
 * the second row, and `.single()` would start failing in production that day.
 */
export async function lerAchados(db: SupabaseClient, eventId: string): Promise<LinhaAchados[]> {
  const { data, error } = await db
    .from('digest_achados_por_mercado')
    .select(`${COLUNAS_CONTAGEM}, slug, title, achados`)
    .eq('event_id', eventId);
  if (error) throw new Error(error.message);
  return (data ?? []) as unknown as LinhaAchados[];
}

/** Every reading of ONE rule text within ONE market. */
export async function lerLeituras(
  db: SupabaseClient,
  eventId: string,
  sha: string,
): Promise<LeituraRegra[]> {
  const { data, error } = await db
    .from('market_rule_digests')
    .select(
      'id, event_id, description_sha256, leitura_n, resolve_sim, resolve_nao, fonte, prazo, anula_se, model, prompt_version, created_at',
    )
    .eq('event_id', eventId)
    .eq('description_sha256', sha)
    .order('leitura_n');
  if (error) throw new Error(error.message);
  return (data ?? []) as LeituraRegra[];
}

/**
 * The three reads behind the boilerplate gate's frequency index, over the
 * WHOLE corpus. Why the index is built from the corpus and not in a view, and
 * why the module-level cache holds the promise, is told in `dados.ts`, next
 * to `lerCorpusDigerido`, which builds the index from these rows.
 */
export async function lerCorpus(db: SupabaseClient): Promise<CorpusCru> {
  const [digests, pegadinhas, ambiguidades] = await Promise.all([
    paginar<CorpusCru['digests'][number]>((de, ate) =>
      db.from('market_rule_digests').select('id, description_sha256').order('id').range(de, ate),
    ),
    paginar<LinhaFilhaDoCorpus>((de, ate) =>
      db
        .from('digest_pegadinhas')
        // `severidade` becomes `tipo`: it is the field `montarIndice` reads,
        // and for a trap the severity is the subtype.
        .select('digest_id, tipo:severidade, trecho')
        .order('id')
        .range(de, ate),
    ),
    paginar<LinhaFilhaDoCorpus>((de, ate) =>
      db
        .from('digest_ambiguidades')
        // `trecho_conflito` is here for the internal contradiction, whose key
        // is BOTH passages.
        .select('digest_id, tipo, trecho, trecho_conflito')
        .order('id')
        .range(de, ate),
    ),
  ]);
  return { digests, pegadinhas, ambiguidades };
}

/**
 * The reach of each contradiction: in how many markets that text defect
 * appears.
 *
 * `digest_contradicoes` exposes `event_id` nowhere, not even in the jsonb. The
 * bridge is that `achados[].achado_id` of class `contradicao` is the SAME md5
 * as `defeito_id` (same formula in both migrations, stated in
 * `20260817040920_...sql:439`). Joining by `slug` would be the other way, and
 * slug is nullable and not unique.
 */
export async function lerContradicoes(
  db: SupabaseClient,
  defeitoIds: string[],
): Promise<Contradicao[]> {
  if (defeitoIds.length === 0) return [];
  const { data, error } = await db
    .from('digest_contradicoes')
    .select(
      'defeito_id, mercados_atingidos, mercados_acusados, mercados_herdados, textos_de_regra, liquidez_total, trecho, trecho_conflito',
    )
    .in('defeito_id', defeitoIds);
  if (error) throw new Error(error.message);
  return (data ?? []) as Contradicao[];
}

/**
 * The market's CURRENT description. Primary-key lookup -- a one-row index scan,
 * not a table scan.
 *
 * "Current" is the word that matters: `events.description` is overwritten in
 * place when Polymarket edits the rule, so this can be a different document from
 * the one that produced the findings. What decides whether it serves is
 * `escolherRegulamento`, and its answer depends on the hash. A market with no
 * row, and a market whose description is null, are different answers.
 */
export async function lerTextoDaRegra(
  db: SupabaseClient,
  eventId: string,
): Promise<{ encontrado: false } | { encontrado: true; texto: string | null }> {
  // `maybeSingle`: an id with no row is an answer (404 at the route), not an
  // error, where `.single()` turned it into a 500.
  const { data, error } = await db
    .from('events')
    .select('description')
    .eq('id', eventId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (data === null) return { encontrado: false };
  return { encontrado: true, texto: (data as { description: string | null }).description ?? null };
}

/**
 * Does the table not exist, or did the query fail?
 *
 * Both arrive as an error and they mean the opposite of each other. A missing
 * table is an ANSWER -- before the `20260823190031` apply no text is stored, and
 * that is what the screen should say. A network failure is the absence of an
 * answer, and asserting "not stored" on top of it would accuse the database of a
 * loss that may not exist.
 *
 * `42P01` is Postgres's `undefined_table`; `PGRST205` is PostgREST's "no such
 * table in the schema cache", which is what arrives first in practice.
 */
function tabelaAusente(error: { code?: string; message: string }): boolean {
  if (error.code === '42P01' || error.code === 'PGRST205') return true;
  return (
    /market_rule_texts/.test(error.message) && /(does not exist|not find)/i.test(error.message)
  );
}

/**
 * The rule text stored under a hash -- `market_rule_texts`, issue #9.
 *
 * It is the screen's only read that does not depend on `events`: the digested
 * text is here because it was stored at the moment of digestion (or recovered by
 * the backfill while that was still possible), and it stays here after Polymarket
 * edits the description. Primary-key lookup on a table of a few hundred rows.
 */
export async function lerTextoGuardado(db: SupabaseClient, sha: string): Promise<TextoGuardado> {
  const { data, error } = await db
    .from('market_rule_texts')
    .select('description')
    .eq('description_sha256', sha)
    .maybeSingle();

  if (error) {
    const e = error as { code?: string; message: string };
    return tabelaAusente(e) ? { fase: 'ausente' } : { fase: 'erro', motivo: e.message };
  }

  const linha = data as { description: string } | null;
  return linha === null ? { fase: 'ausente' } : { fase: 'guardado', texto: linha.description };
}

/**
 * Records the prediction: one `my_bets` row WITHOUT a leg.
 *
 * A bet without a leg is a prediction without a trade, derivable, no flag.
 * Audited on 2026-08-19: `v_minhas_posicoes`, `bankroll.ts`, `/positions`,
 * `/status`, `/edit` and the `resolved-detector` are all driven by the leg and
 * ignore this row. See `CONTEXTO-RADAR.md`.
 *
 * `placed_at` is NOT sent: the default is Postgres's `now()`. The browser's
 * clock does not decide the time of a dated prediction.
 *
 * The row comes built and validated from `validarPrevisao` (`entrada.ts`).
 */
export async function gravarPrevisao(
  db: SupabaseClient,
  linha: Record<string, unknown>,
): Promise<string> {
  const { data, error } = await db.from('my_bets').insert(linha).select('id').single();
  if (error) throw new Error(error.message);
  return (data as { id: string }).id;
}

/**
 * The trade, afterwards. Optional: the required field is the probability.
 *
 * The leg's `preco_mercado` stays NULL on purpose: the baseline was already
 * recorded on the bet, at the moment of the prediction, which is the moment
 * that matters. Repeating today's price here would be a second baseline,
 * measured after trading.
 *
 * The row comes built and validated from `validarLeg` (`entrada.ts`).
 */
export async function gravarLeg(db: SupabaseClient, linha: Record<string, unknown>): Promise<void> {
  const { error } = await db.from('my_bet_legs').insert(linha);
  if (error) throw new Error(error.message);
}
