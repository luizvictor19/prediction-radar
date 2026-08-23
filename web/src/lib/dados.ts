import { supabase } from './supabase';
import { montarIndice, type IndiceDeBoilerplate, type LinhaDeTrecho } from './boilerplate';
import { chaveDaLinha } from './concordancia';
import { COLUNAS_CONTAGEM, ordenarContagens, paginar, type Resposta } from './paginacao';
import type { TextoGuardado } from './regulamento';
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

// `PAGINA`, `paginar`, `COLUNAS_CONTAGEM` and the counts' ordering live in
// `paginacao.ts` since issue #6: this module loads the browser client, and a
// Node test cannot import it. See the header over there.

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

export function lerRadar(): Promise<MercadoRadar[]> {
  return paginar<MercadoRadar>((de, ate) =>
    supabase.from('v_radar').select(COLUNAS_RADAR).order('id').range(de, ate),
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
export function lerContagens(): Promise<ContagemDigest[]> {
  return paginar<ContagemDigest>((de, ate) =>
    ordenarContagens(
      supabase.from('digest_achados_por_mercado').select(COLUNAS_CONTAGEM),
    ).range(de, ate),
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
 * O índice de frequência do gate de boilerplate — item 5, seção 7.
 *
 * Três leituras sobre o corpus INTEIRO, porque a pergunta que o gate responde é
 * sobre o corpus: em que fração dos regulamentos lidos esta passagem aparece.
 * Uma consulta por mercado não conseguiria responder isso.
 *
 * ## Por que no cliente, e não numa view
 *
 * A chave de contagem é `chaveDoGate`, e ela chama `mascararParaGate` — troca de
 * mês e número que existe só para juntar `December 31, 2026, 11:59 PM ET` com
 * `June 30, 2027, 11:59 PM ET` na mesma contagem. Fazer isso em SQL criaria uma
 * SEGUNDA implementação da máscara, e as duas divergiriam: o relatório de
 * medição e a tela passariam a discordar sobre o que é padrão da casa, em
 * silêncio. É o mesmo defeito que a réplica da view e a `normalizarTrecho`
 * duplicada já custaram.
 *
 * O custo medido em 23/08/2026 não compra esse risco de volta: 1264 linhas em
 * `market_rule_digests`, 3980 em `digest_pegadinhas`, 3252 em
 * `digest_ambiguidades` — cerca de 8,5 mil linhas, ~10 idas ao servidor pela
 * paginação de 500. Uma vez por sessão.
 *
 * ## Uma promessa em voo, reaproveitada
 *
 * O cache é de MÓDULO e guarda a promessa, não o resultado: duas telas abertas
 * ao mesmo tempo compartilham a mesma requisição em vez de disparar seis. Em
 * erro a promessa é descartada, para a próxima tela poder tentar de novo em vez
 * de herdar a falha para sempre.
 */
let indiceEmVoo: Promise<CorpusDigerido> | null = null;

/**
 * As duas coisas que a MESMA leitura do corpus produz.
 *
 * O gate agrupa pela chave MASCARADA — data e número viram marca, para juntar
 * as variantes do mesmo boilerplate. A fusão agrupa pela chave LITERAL, porque
 * mascarar ali fundiria dois prazos diferentes do mesmo regulamento. Chaves
 * diferentes, mesmas linhas: ler duas vezes seria pagar dobrado pelo mesmo
 * tráfego.
 */
export type CorpusDigerido = {
  indice: IndiceDeBoilerplate;
  /** Chave de identidade → os `digest_id` que apontaram aquele achado. */
  leiturasPorChave: Map<string, Set<string>>;
};

export function lerCorpusDigerido(): Promise<CorpusDigerido> {
  if (indiceEmVoo === null) {
    indiceEmVoo = carregarIndice().catch(e => {
      indiceEmVoo = null;
      throw e;
    });
  }
  return indiceEmVoo;
}

async function carregarIndice(): Promise<CorpusDigerido> {
  type LinhaDigest = { id: string; description_sha256: string };
  type LinhaFilha = {
    digest_id: string;
    tipo: string | null;
    trecho: string | null;
    trecho_conflito?: string | null;
  };

  const [digests, pegadinhas, ambiguidades] = await Promise.all([
    paginar<LinhaDigest>((de, ate) =>
      supabase.from('market_rule_digests').select('id, description_sha256').order('id').range(de, ate),
    ),
    paginar<LinhaFilha>((de, ate) =>
      supabase
        .from('digest_pegadinhas')
        // `severidade` vira `tipo`: é o campo que `montarIndice` lê, e na
        // pegadinha a severidade é o subtipo.
        .select('digest_id, tipo:severidade, trecho')
        .order('id')
        .range(de, ate),
    ),
    paginar<LinhaFilha>((de, ate) =>
      supabase
        .from('digest_ambiguidades')
        // `trecho_conflito` entra por causa da contradição interna: a chave dela
        // são as DUAS passagens.
        .select('digest_id, tipo, trecho, trecho_conflito')
        .order('id')
        .range(de, ate),
    ),
  ]);

  const shaPorDigest = new Map(digests.map(d => [d.id, d.description_sha256]));

  const linhas: LinhaDeTrecho[] = [];
  const leiturasPorChave = new Map<string, Set<string>>();

  for (const [tabela, filhas] of [
    ['pegadinha', pegadinhas],
    ['ambiguidade', ambiguidades],
  ] as const) {
    for (const f of filhas) {
      const sha = shaPorDigest.get(f.digest_id);
      // Filha sem digest é impossível pela FK; se aparecer, sumir em silêncio
      // encolheria o denominador e inflaria toda fração.
      if (sha === undefined) continue;

      // A contradição interna mora em `digest_ambiguidades`, marcada no `tipo`.
      // `digest_contradicoes` é outra coisa: o defeito agregado por TEXTO, que
      // a tela lê à parte para mostrar o alcance.
      const classe = f.tipo === 'contradicao_interna' ? 'contradicao' : tabela;

      linhas.push({ sha, classe, tipo: f.tipo, trecho: f.trecho });

      // A chave da FUSÃO é a literal, e o `sha` é o primeiro argumento dela:
      // fundir através de textos diferentes juntaria passagens de dois
      // regulamentos.
      const k = chaveDaLinha(sha, classe, f.tipo, f.trecho, f.trecho_conflito ?? null);
      if (k === null) continue;
      let set = leiturasPorChave.get(k);
      if (set === undefined) {
        set = new Set();
        leiturasPorChave.set(k, set);
      }
      set.add(f.digest_id);
    }
  }

  // O denominador é TODO texto lido, inclusive o que não produziu achado
  // nenhum: um texto lido e limpo é uma chance que a passagem teve de aparecer
  // e não apareceu.
  return { indice: montarIndice(linhas, [...shaPorDigest.values()]), leiturasPorChave };
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
 * The market's CURRENT description. Primary-key lookup -- a one-row index scan,
 * not a table scan.
 *
 * "Current" is the word that matters: `events.description` is overwritten in
 * place when Polymarket edits the rule, so this can be a different document from
 * the one that produced the findings. What decides whether it serves is
 * `escolherRegulamento`, and its answer depends on the hash.
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
  return /market_rule_texts/.test(error.message) && /(does not exist|not find)/i.test(error.message);
}

/**
 * The rule text stored under a hash -- `market_rule_texts`, issue #9.
 *
 * It is the screen's only read that does not depend on `events`: the digested
 * text is here because it was stored at the moment of digestion (or recovered by
 * the backfill while that was still possible), and it stays here after Polymarket
 * edits the description. Primary-key lookup on a table of a few hundred rows.
 */
export async function lerTextoGuardado(sha: string): Promise<TextoGuardado> {
  const { data, error } = await supabase
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
