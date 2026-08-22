import { supabase } from './supabase';
import type {
  Achado,
  Contradicao,
  ContagemDigest,
  LeituraRegra,
  LinhaAchados,
  MercadoRadar,
} from './tipos';

/**
 * As leituras do banco. Todas são SELECT sobre view, exceto o texto original da
 * regra (que é lookup por chave primária em `events`) e as duas escritas do
 * final.
 *
 * Nenhuma varre `events`, `polymarket_snapshots` ou `system_logs`: o timeout do
 * PostgREST é de 8s e um seq scan nos 711 MB de `events` é incidente de
 * produção, não consulta.
 */

const PAGINA = 500;

/**
 * `data: unknown` de propósito: o client não tem tipos gerados do banco, e o
 * parser de `select()` do supabase-js só entende string LITERAL — a lista de
 * colunas aqui é montada em runtime. As formas de verdade estão em `tipos.ts`,
 * escritas contra as migrations.
 */
type Resposta = PromiseLike<{ data: unknown; error: { message: string } | null }>;

/**
 * O PostgREST corta em 1000 linhas por resposta e não avisa — a lista voltaria
 * truncada com cara de completa. Mesmo padrão de `scripts/nivelar-leituras.ts`.
 */
async function paginar<T>(monta: (de: number, ate: number) => Resposta): Promise<T[]> {
  const tudo: T[] = [];
  for (let de = 0; ; de += PAGINA) {
    const { data, error } = await monta(de, de + PAGINA - 1);
    if (error) throw new Error(error.message);
    const lote = (data ?? []) as T[];
    tudo.push(...lote);
    if (lote.length < PAGINA) return tudo;
  }
}

const COLUNAS_RADAR = [
  'id',
  'slug',
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

const COLUNAS_CONTAGEM = [
  'event_id',
  'description_sha256',
  'leituras_do_texto',
  'mercados_do_texto',
  'achados_total',
  'achados_acusados',
  'achados_herdados',
  'pegadinhas',
  'ambiguidades',
  'contradicoes',
  'pegadinhas_muda_resultado',
  'confirmacao_maxima',
].join(', ');

export function lerRadar(): Promise<MercadoRadar[]> {
  return paginar<MercadoRadar>((de, ate) =>
    supabase.from('v_radar').select(COLUNAS_RADAR).order('id').range(de, ate),
  );
}

/**
 * As contagens da digestão, sem o jsonb `achados` — que é o campo pesado e só
 * faz falta quando um mercado é aberto.
 *
 * ## A ordenação é o par, e isso é requisito da paginação
 *
 * A granularidade da view é (mercado, texto de regra), então `event_id` sozinho
 * NÃO é ordem total: dois textos do mesmo mercado empatam nele. Paginação por
 * `range` é OFFSET, e com empate o Postgres não promete ordem estável entre uma
 * página e a seguinte — na fronteira, uma das linhas empatadas pode vir duas
 * vezes ou nenhuma. Aí a lista soma a contradição de um texto duas vezes, ou
 * perde a de outro, e em silêncio.
 *
 * Hoje isso não morde: cada mercado tem um texto só — 1033 linhas para 1033
 * mercados, medido em 22/08/2026 por `npm run medir:tela-regra` —, e com um
 * texto por mercado `event_id` é único. Mas é
 * exatamente o caso que `juntarRadarComDigest` e `textosParaLer` passaram a
 * suportar, e uma descrição editada na Polymarket cria a segunda linha.
 *
 * `(event_id, description_sha256)` é a chave da view — o `group by` dela termina
 * nesses dois — logo é ordem total, e a paginação volta a ser determinística.
 */
export function lerContagens(): Promise<ContagemDigest[]> {
  return paginar<ContagemDigest>((de, ate) =>
    supabase
      .from('digest_achados_por_mercado')
      .select(COLUNAS_CONTAGEM)
      .order('event_id')
      .order('description_sha256')
      .range(de, ate),
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
export async function lerAchados(eventId: string): Promise<LinhaAchados[]> {
  const { data, error } = await supabase
    .from('digest_achados_por_mercado')
    .select(`${COLUNAS_CONTAGEM}, slug, title, achados`)
    .eq('event_id', eventId);
  if (error) throw new Error(error.message);
  return (data ?? []) as unknown as LinhaAchados[];
}

/** Todas as leituras de UM texto de regra dentro de UM mercado. */
export async function lerLeituras(eventId: string, sha: string): Promise<LeituraRegra[]> {
  const { data, error } = await supabase
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
 * O alcance de cada contradição: em quantos mercados aquele defeito de texto
 * aparece.
 *
 * `digest_contradicoes` não expõe `event_id` em lugar nenhum — nem no jsonb. A
 * ponte é que `achados[].achado_id` de classe `contradicao` é o MESMO md5 que
 * `defeito_id` (mesma fórmula nas duas migrations, declarado em
 * `20260817040920_...sql:439`). Ligar por `slug` seria o outro caminho, e slug
 * é nullable e não-unique.
 */
export async function lerContradicoes(defeitoIds: string[]): Promise<Contradicao[]> {
  if (defeitoIds.length === 0) return [];
  const { data, error } = await supabase
    .from('digest_contradicoes')
    .select(
      'defeito_id, mercados_atingidos, mercados_acusados, mercados_herdados, textos_de_regra, liquidez_total, trecho, trecho_conflito',
    )
    .in('defeito_id', defeitoIds);
  if (error) throw new Error(error.message);
  return (data ?? []) as Contradicao[];
}

/**
 * O texto cru do regulamento. Lookup por PK — index scan de uma linha, não
 * varredura. Fica atrás de um "ver o texto original" fechado por padrão.
 */
export async function lerTextoDaRegra(eventId: string): Promise<string | null> {
  const { data, error } = await supabase
    .from('events')
    .select('description')
    .eq('id', eventId)
    .single();
  if (error) throw new Error(error.message);
  return (data as { description: string | null } | null)?.description ?? null;
}

export type Previsao = {
  eventId: string;
  /** Em 0–1, como sai de `lerProbabilidade`. Nunca em %. */
  prob: number;
  categoria: string | null;
  nota: string | null;
  precoMercado: number | null;
  precoMercadoEm: string | null;
  precoMercadoOutcome: string | null;
};

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
 */
export async function gravarPrevisao(p: Previsao): Promise<string> {
  const linha: Record<string, unknown> = {
    event_id: p.eventId,
    prob_self: p.prob,
    estrategia: 'radar',
    polymarket_category: p.categoria,
    preco_mercado: p.precoMercado,
    preco_mercado_em: p.precoMercadoEm,
    preco_mercado_outcome: p.precoMercadoOutcome,
  };
  if (p.nota) {
    linha['thesis'] = p.nota;
    linha['thesis_type'] = 'radar';
  }

  const { data, error } = await supabase.from('my_bets').insert(linha).select('id').single();
  if (error) throw new Error(error.message);
  return (data as { id: string }).id;
}

export type Leg = {
  betId: string;
  eventId: string;
  outcome: string;
  entryPrice: number;
  stakeUsd: number;
};

/**
 * A operação, depois. Opcional — o campo obrigatório é a probabilidade.
 *
 * `preco_mercado` da leg fica NULO de propósito: a linha de base já foi gravada
 * no bet, no instante da previsão, que é o instante que importa. Repetir aqui o
 * preço de agora seria uma segunda base, medida depois de operar.
 */
export async function gravarLeg(l: Leg): Promise<void> {
  const { error } = await supabase.from('my_bet_legs').insert({
    bet_id: l.betId,
    event_id: l.eventId,
    outcome: l.outcome,
    entry_price: l.entryPrice,
    stake_usd: l.stakeUsd,
    shares: Math.round((l.stakeUsd / l.entryPrice) * 10000) / 10000,
  });
  if (error) throw new Error(error.message);
}
