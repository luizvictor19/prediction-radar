import { supabase } from '../lib/supabase.js';
import { keyOf, type DigestedIndex } from './leituras.js';
import type { DigestInput } from './prompts.js';

// As chaves e as perguntas sobre elas moram em `leituras.ts`, que não importa o
// cliente do banco e por isso pode ter teste sem rede. Reexportadas aqui porque
// quem consome a digestão consome este módulo.
export {
  jaCarregado,
  jaDigerido,
  leiturasDoTexto,
  proximaLeitura,
  type DigestedIndex,
  type DigestedKey,
} from './leituras.js';

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
  /**
   * `events.status`, cru, sem interpretação nenhuma aqui.
   *
   * Esta função NÃO filtra por ele de propósito: ela tem três consumidores e só
   * dois devem descartar mercado com desfecho (ver `scripts/lib/fila-digestao.ts`).
   * Filtrar aqui encolheria também o denominador dos modos `--comparar` e
   * `--amostra-de`, que existem para responder sobre a rodada antiga.
   */
  status: string | null;
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
  status: string | null;
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
    .map((entry) => {
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

const EVENT_COLUMNS =
  'id, polymarket_id, slug, title, description, end_date, outcomes, radar_tema, liquidity, status';

/** One `events` row as the digestion reads it; `null` when the rule text is empty. */
function toMarket(row: EventRow): MarketToDigest | null {
  const description = row.description?.trim() ?? '';
  if (description.length === 0) return null;

  return {
    eventId: row.id,
    polymarketId: row.polymarket_id,
    tema: row.radar_tema,
    // `numeric` do Postgres chega como string no PostgREST quando passa da
    // precisão de um double. Ler os dois casos aqui é mais barato que
    // descobrir a ordenação errada num relatório de 752.
    liquidez: readNumber(row.liquidity),
    status: row.status,
    input: {
      question: row.title,
      description,
      slug: row.slug,
      endDate: row.end_date,
      outcomes: readOutcomes(row.outcomes),
    },
  };
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
      .select(EVENT_COLUMNS)
      .eq('radar_tracked', true)
      .order('id')
      .range(from, from + PAGE - 1);

    if (error) throw new Error(`leitura de events falhou: ${error.message}`);

    const rows = (data ?? []) as EventRow[];
    for (const row of rows) {
      const market = toMarket(row);
      if (market !== null) markets.push(market);
    }

    if (rows.length < PAGE) break;
  }

  return markets;
}

interface DigestedRow {
  event_id: string;
  description_sha256: string;
  model: string;
  prompt_version: string;
  leitura_n?: number;
}

const COLUNAS_SEM_LEITURA = 'event_id, description_sha256, model, prompt_version';
const COLUNAS_COM_LEITURA = `${COLUNAS_SEM_LEITURA}, leitura_n`;

/**
 * O que já foi digerido, para o laço não pagar duas vezes pelo mesmo texto.
 *
 * A chave inclui o HASH da descrição: mercado cuja regra foi editada tem hash
 * novo, não casa com nada, e volta para a fila sozinho. É o mecanismo inteiro
 * de não envelhecer em silêncio, e ele mora aqui em uma linha.
 *
 * Tabela ausente não é erro: até o apply, tudo está por digerir.
 *
 * A COLUNA ausente também não é erro aqui — mas é impedimento lá na frente. A
 * primeira página é pedida com `leitura_n`; se o PostgREST recusar, o mesmo
 * pedido sai sem ela e `colunaLeituraN` fica `false`. A distinção importa
 * porque as duas ausências têm consequências opostas: sem TABELA tudo está por
 * digerir e o degrau 1 roda; sem COLUNA o nivelamento não pode rodar, porque
 * ele grava duas leituras da mesma chave.
 */
export async function readDigested(): Promise<DigestedIndex> {
  const keys = new Set<string>();
  const keysComLeitura = new Set<string>();
  const leiturasPorTexto = new Map<string, number>();
  const maxLeituraPorChave = new Map<string, number>();
  const combinacoes = new Map<string, number>();
  let colunaLeituraN = true;
  let colunas = COLUNAS_COM_LEITURA;

  for (let from = 0; ; from += PAGE) {
    let { data, error } = await supabase
      .from('market_rule_digests')
      .select(colunas)
      .order('id')
      .range(from, from + PAGE - 1);

    // Uma única tentativa de recuo, e só na primeira página: se a coluna não
    // existe, o erro vem já na primeira e o custo é um round-trip. Recuar em
    // qualquer página faria uma falha transitória no meio da paginação virar
    // "a coluna não existe", que é um diagnóstico errado e caro.
    if (error && colunaLeituraN && from === 0) {
      colunaLeituraN = false;
      colunas = COLUNAS_SEM_LEITURA;
      ({ data, error } = await supabase
        .from('market_rule_digests')
        .select(colunas)
        .order('id')
        .range(from, from + PAGE - 1));
    }

    if (error) {
      return {
        tabelaExiste: false,
        colunaLeituraN: false,
        keys,
        keysComLeitura,
        leiturasPorTexto,
        maxLeituraPorChave,
        combinacoes,
      };
    }

    const rows = (data ?? []) as unknown as DigestedRow[];

    for (const row of rows) {
      const chave = keyOf({
        eventId: row.event_id,
        descriptionSha256: row.description_sha256,
        model: row.model,
        promptVersion: row.prompt_version,
      });
      keys.add(chave);

      leiturasPorTexto.set(
        row.description_sha256,
        (leiturasPorTexto.get(row.description_sha256) ?? 0) + 1,
      );

      // Sem a coluna, toda linha existente É a leitura 1 — a unique antiga
      // garantia uma linha por chave de 4 partes. O `?? 1` não é chute.
      const n = row.leitura_n ?? 1;
      keysComLeitura.add(`${chave}|${n}`);

      const combo = `${row.model}|${row.prompt_version}`;
      combinacoes.set(combo, (combinacoes.get(combo) ?? 0) + 1);
      maxLeituraPorChave.set(chave, Math.max(maxLeituraPorChave.get(chave) ?? 0, n));
    }

    if (rows.length < PAGE) break;
  }

  return {
    tabelaExiste: true,
    colunaLeituraN,
    keys,
    keysComLeitura,
    leiturasPorTexto,
    maxLeituraPorChave,
    combinacoes,
  };
}

// `DigestRows` and `buildDigestRows` live in `rows.ts`, which imports no database
// client and can therefore be loaded by a test. Re-exported so importers stay put.
export { buildDigestRows, type DigestRows } from './rows.js';

// ---------------------------------------------------------------------------
// The scheduled path (issue 93): one market and one key at a time
// ---------------------------------------------------------------------------

/**
 * One market by id, as the digestion reads it, or `null` when the row is gone
 * or its rule text is empty.
 *
 * A primary-key lookup on `events`: one index probe, never a scan.
 */
export async function readMarketToDigest(eventId: string): Promise<MarketToDigest | null> {
  const { data, error } = await supabase
    .from('events')
    .select(EVENT_COLUMNS)
    .eq('id', eventId)
    .maybeSingle();
  if (error) throw new Error(`leitura do evento ${eventId} falhou: ${error.message}`);
  return data === null ? null : toMarket(data as EventRow);
}

/**
 * Whether this market already has a reading of this text by this model and
 * prompt version: the four-part question of `jaDigerido`, asked of one key.
 *
 * The four columns are the leading columns of the five-column unique index on
 * `market_rule_digests`, so this is an index probe.
 */
export async function digestExists(key: {
  eventId: string;
  sha256: string;
  model: string;
  promptVersion: string;
}): Promise<boolean> {
  const { data, error } = await supabase
    .from('market_rule_digests')
    .select('id')
    .eq('event_id', key.eventId)
    .eq('description_sha256', key.sha256)
    .eq('model', key.model)
    .eq('prompt_version', key.promptVersion)
    .limit(1);
  if (error) throw new Error(`leitura de market_rule_digests falhou: ${error.message}`);
  return (data ?? []).length > 0;
}

/**
 * The digest settings of `system_config`, read strictly.
 *
 * Not `getSystemConfig()`: that one falls back to code defaults when the read
 * fails, and its default prompt version is `v1`. A scheduled run that silently
 * read with the wrong prompt would write readings under a key no one asked for;
 * here a failed read stops the run instead.
 */
export async function readDigestConfig(): Promise<{
  model: string;
  promptVersion: string;
  timeoutMs: number;
}> {
  const { data, error } = await supabase
    .from('system_config')
    .select('digest_model, digest_prompt_version, digest_timeout_ms')
    .eq('id', 1)
    .single();
  if (error || data === null) {
    throw new Error(`leitura de system_config falhou: ${error?.message ?? 'sem linha'}`);
  }
  const row = data as {
    digest_model: unknown;
    digest_prompt_version: unknown;
    digest_timeout_ms: unknown;
  };
  if (
    typeof row.digest_model !== 'string' ||
    typeof row.digest_prompt_version !== 'string' ||
    typeof row.digest_timeout_ms !== 'number'
  ) {
    throw new Error('system_config: configuração da digestão incompleta');
  }
  return {
    model: row.digest_model,
    promptVersion: row.digest_prompt_version,
    timeoutMs: row.digest_timeout_ms,
  };
}
