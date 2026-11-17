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
 * that went through the Vite proxy.
 *
 * As leituras do banco. Todas são SELECT sobre view, exceto o texto original da
 * regra (que é lookup por chave primária em `events`) e as duas escritas do
 * final.
 *
 * Nenhuma varre `events`, `polymarket_snapshots` ou `system_logs`: o timeout do
 * PostgREST é de 8s e um seq scan nos 711 MB de `events` é incidente de
 * produção, não consulta.
 */

const COLUNAS_RADAR = [
  'id',
  'slug',
  // `event_group_slug` entra AQUI quando
  // `20260825024030_v_radar_expoe_event_group_slug.sql` for aplicada. Pedir
  // agora derruba a query inteira: a view ainda não tem a coluna. Até lá
  // `urlPolymarket` recebe `undefined` e cai no fallback `/market/<slug>`, que
  // foi medido abrindo 55/55 no mercado certo.
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
 * As contagens da digestão, sem o jsonb `achados` — que é o campo pesado e só
 * faz falta quando um mercado é aberto.
 *
 * The ordering comes from `ordenarContagens`, and it is a TOTAL order because
 * pagination requires one — the why is in `paginacao.ts`, next to the test that
 * measures it.
 */
export function lerContagens(db: SupabaseClient): Promise<ContagemDigest[]> {
  return paginar<ContagemDigest>((de, ate) =>
    ordenarContagens(db.from('digest_achados_por_mercado').select(COLUNAS_CONTAGEM)).range(de, ate),
  );
}

/**
 * A digestão de um mercado, agora com os achados.
 *
 * Devolve LISTA e não um objeto: a granularidade da view é (mercado, texto de
 * regra). Hoje nenhum mercado tem dois textos, mas a Polymarket editar uma
 * descrição produz a segunda linha — e `.single()` passaria a estourar em
 * produção no dia em que isso acontecesse.
 */
export async function lerAchados(db: SupabaseClient, eventId: string): Promise<LinhaAchados[]> {
  const { data, error } = await db
    .from('digest_achados_por_mercado')
    .select(`${COLUNAS_CONTAGEM}, slug, title, achados`)
    .eq('event_id', eventId);
  if (error) throw new Error(error.message);
  return (data ?? []) as unknown as LinhaAchados[];
}

/** Todas as leituras de UM texto de regra dentro de UM mercado. */
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
        // `severidade` vira `tipo`: é o campo que `montarIndice` lê, e na
        // pegadinha a severidade é o subtipo.
        .select('digest_id, tipo:severidade, trecho')
        .order('id')
        .range(de, ate),
    ),
    paginar<LinhaFilhaDoCorpus>((de, ate) =>
      db
        .from('digest_ambiguidades')
        // `trecho_conflito` entra por causa da contradição interna: a chave dela
        // são as DUAS passagens.
        .select('digest_id, tipo, trecho, trecho_conflito')
        .order('id')
        .range(de, ate),
    ),
  ]);
  return { digests, pegadinhas, ambiguidades };
}

/**
 * O alcance de cada contradição: em quantos mercados aquele defeito de texto
 * aparece.
 *
 * `digest_contradicoes` não expõe `event_id` em lugar nenhum — nem no jsonb. A
 * ponte é que `achados[].achado_id` de classe `contradicao` é o MESMO md5 que
 * `defeito_id` (mesma fórmula nas duas migrations, declarado em
 * `20260817040920_...sql:439`). Ligar por `slug` seria o outro caminho, e slug
 * é nullable e não-unique.
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
 * `escolherRegulamento`, and its answer depends on the hash.
 */
export async function lerTextoDaRegra(db: SupabaseClient, eventId: string): Promise<string | null> {
  const { data, error } = await db.from('events').select('description').eq('id', eventId).single();
  if (error) throw new Error(error.message);
  return (data as { description: string | null } | null)?.description ?? null;
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
 * Grava a previsão: uma linha de `my_bets` SEM leg.
 *
 * Bet sem leg é previsão sem operação — derivável, sem flag. Auditado em
 * 19/08/2026: `v_minhas_posicoes`, `bankroll.ts`, `/positions`, `/status`,
 * `/edit` e o `resolved-detector` são todos dirigidos pela leg e ignoram esta
 * linha. Ver `CONTEXTO-RADAR.md`.
 *
 * `placed_at` NÃO é enviado: o default é `now()` do Postgres. O relógio do
 * navegador não decide a hora de uma previsão datada.
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
 * A operação, depois. Opcional — o campo obrigatório é a probabilidade.
 *
 * `preco_mercado` da leg fica NULO de propósito: a linha de base já foi gravada
 * no bet, no instante da previsão, que é o instante que importa. Repetir aqui o
 * preço de agora seria uma segunda base, medida depois de operar.
 *
 * The row comes built and validated from `validarLeg` (`entrada.ts`).
 */
export async function gravarLeg(db: SupabaseClient, linha: Record<string, unknown>): Promise<void> {
  const { error } = await db.from('my_bet_legs').insert(linha);
  if (error) throw new Error(error.message);
}
