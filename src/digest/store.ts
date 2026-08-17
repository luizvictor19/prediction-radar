import { supabase } from '../lib/supabase.js';
import type { DigestResult } from './digest.js';
import type { DigestInput } from './prompts.js';

/**
 * A leitura do que digerir, e o payload do que gravar.
 *
 * **Este módulo não escreve.** `buildDigestRow` monta a linha e devolve; quem
 * grava é o dono, depois de aplicar a migration. Enquanto
 * `market_rule_digests` não existir, `readDigested` devolve o conjunto vazio com
 * `tabelaExiste: false` — e o script segue, porque o degrau 1 tem que rodar
 * ANTES do apply. É a ordem pedida: medir primeiro, aplicar depois de ler.
 */

const PAGE = 500;

export interface MarketToDigest {
  eventId: string;
  polymarketId: string;
  tema: string | null;
  /**
   * `events.liquidity`. Não entra na digestão — o modelo não a vê, e não deve:
   * ele lê a regra, não o mercado. Existe para ORDENAR o relatório, e a ordem
   * importa numa passada de 752: a contradição de um mercado com liquidez de
   * seis dígitos e a de um com US$ 500 têm o mesmo tamanho na tabela e não têm
   * o mesmo tamanho em dinheiro.
   *
   * `null` quando a coleta não trouxe o campo — e `null` não vira 0 na ordenação
   * (ver `ordenarPorLiquidez`): "não sei a liquidez" e "liquidez zero" são
   * coisas diferentes, e colapsá-las esconderia o mercado grande cujo dado
   * faltou.
   */
  liquidez: number | null;
  input: DigestInput;
}

interface EventRow {
  id: string;
  polymarket_id: string;
  slug: string | null;
  title: string;
  description: string | null;
  end_date: string | null;
  outcomes: unknown;
  radar_tema: string | null;
  liquidity: number | string | null;
}

/**
 * `events.outcomes` é jsonb e chegou de três formas diferentes na vida da
 * tabela: array de string, array de objeto e string com JSON dentro. Nenhuma
 * delas é erro de gravação — são coletores de épocas diferentes. Ler com cuidado
 * aqui é mais barato que uma normalização retroativa de 551k linhas.
 */
function readOutcomes(raw: unknown): string[] | null {
  const value = typeof raw === 'string' ? safeParse(raw) : raw;
  if (!Array.isArray(value)) return null;

  const names = value
    .map(entry => {
      if (typeof entry === 'string') return entry;
      if (typeof entry === 'object' && entry !== null && 'name' in entry) {
        const name = (entry as { name: unknown }).name;
        return typeof name === 'string' ? name : null;
      }
      return null;
    })
    .filter((name): name is string => name !== null && name.trim().length > 0);

  return names.length > 0 ? names : null;
}

function readNumber(raw: number | string | null): number | null {
  if (raw === null) return null;
  const n = typeof raw === 'string' ? Number(raw) : raw;
  return Number.isFinite(n) ? n : null;
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Os mercados do radar que têm regra para digerir.
 *
 * O recorte é `radar_tracked`, e não a tabela inteira: `events` tem ~551k linhas
 * e a marca do radar é o conjunto que este projeto vigia e cuja série nunca é
 * apagada. O `where` bate no índice parcial `idx_events_radar_tracked`, então
 * isto é varredura de algumas centenas de entradas e não dos 711 MB da tabela.
 *
 * Paginado em 500 porque o PostgREST tem prazo de 8s e a descrição é texto
 * grande: 673 descrições de ~1,3 mil caracteres são quase um megabyte numa
 * resposta só. Ordenado por `id` — a mesma ordem do índice — para a paginação
 * não depender de ordem que o banco não promete.
 *
 * Descrição vazia é filtrada AQUI e não no `where`: `length(btrim(...)) > 0` não
 * tem índice e viraria filtro sobre o heap; o custo de trazer uma linha a mais e
 * descartá-la em memória é menor que o de fazer o banco decidir.
 */
export async function readMarketsToDigest(): Promise<MarketToDigest[]> {
  const markets: MarketToDigest[] = [];

  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from('events')
      .select('id, polymarket_id, slug, title, description, end_date, outcomes, radar_tema, liquidity')
      .eq('radar_tracked', true)
      .order('id')
      .range(from, from + PAGE - 1);

    if (error) throw new Error(`leitura de events falhou: ${error.message}`);

    const rows = (data ?? []) as EventRow[];
    for (const row of rows) {
      const description = row.description?.trim() ?? '';
      if (description.length === 0) continue;

      markets.push({
        eventId: row.id,
        polymarketId: row.polymarket_id,
        tema: row.radar_tema,
        // `numeric` do Postgres chega como string no PostgREST quando passa da
        // precisão de um double. Ler os dois casos aqui é mais barato que
        // descobrir a ordenação errada num relatório de 752.
        liquidez: readNumber(row.liquidity),
        input: {
          question: row.title,
          description,
          slug: row.slug,
          endDate: row.end_date,
          outcomes: readOutcomes(row.outcomes),
        },
      });
    }

    if (rows.length < PAGE) break;
  }

  return markets;
}

export interface DigestedKey {
  eventId: string;
  descriptionSha256: string;
  model: string;
  promptVersion: string;
}

export interface DigestedIndex {
  /** `false` enquanto a migration não estiver aplicada. */
  tabelaExiste: boolean;
  keys: Set<string>;
}

function keyOf(k: DigestedKey): string {
  return `${k.eventId}|${k.descriptionSha256}|${k.model}|${k.promptVersion}`;
}

/**
 * O que já foi digerido, para o laço não pagar duas vezes pelo mesmo texto.
 *
 * A chave inclui o HASH da descrição: mercado cuja regra foi editada tem hash
 * novo, não casa com nada, e volta para a fila sozinho. É o mecanismo inteiro
 * de não envelhecer em silêncio, e ele mora aqui em uma linha.
 *
 * Tabela ausente não é erro: até o apply, tudo está por digerir.
 */
export async function readDigested(): Promise<DigestedIndex> {
  const keys = new Set<string>();

  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from('market_rule_digests')
      .select('event_id, description_sha256, model, prompt_version')
      .order('id')
      .range(from, from + PAGE - 1);

    if (error) {
      return { tabelaExiste: false, keys };
    }

    const rows = (data ?? []) as Array<{
      event_id: string;
      description_sha256: string;
      model: string;
      prompt_version: string;
    }>;

    for (const row of rows) {
      keys.add(
        keyOf({
          eventId: row.event_id,
          descriptionSha256: row.description_sha256,
          model: row.model,
          promptVersion: row.prompt_version,
        }),
      );
    }

    if (rows.length < PAGE) break;
  }

  return { tabelaExiste: true, keys };
}

export function jaDigerido(index: DigestedIndex, key: DigestedKey): boolean {
  return index.keys.has(keyOf(key));
}

export interface DigestRows {
  digest: Record<string, unknown>;
  /** Linhas de `digest_pegadinhas`, sem `digest_id` — ele só existe no insert. */
  pegadinhas: Record<string, unknown>[];
  ambiguidades: Record<string, unknown>[];
}

/**
 * As linhas das três tabelas, montadas e devolvidas — não gravadas.
 *
 * Escrita é do dono, e as tabelas nem existem ainda. O que o projeto ganha com a
 * função existindo antes do apply é o payload conferido contra as colunas da
 * migration no mesmo commit em que ela é escrita, em vez de descoberto errado no
 * primeiro insert depois.
 *
 * `digest_id` fica de fora das filhas de propósito: ele é gerado pelo insert do
 * pai, e preenchê-lo aqui com um valor inventado faria o payload parecer pronto
 * quando não está.
 */
export function buildDigestRows(
  market: MarketToDigest,
  result: DigestResult,
  promptVersion: string,
  model: string,
): DigestRows {
  return {
    digest: {
      event_id: market.eventId,
      description_sha256: result.descriptionSha256,
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
    // `ordinal` preserva a ordem em que o modelo escreveu. O primeiro item de
    // uma lista costuma ser o mais forte, e essa hipótese só se mede se a ordem
    // sobreviver à gravação.
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
