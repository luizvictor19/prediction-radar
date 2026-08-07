/**
 * Cliente da LiquipediaDB API v3.
 *
 * Fonte primária de roster, confronto direto, forma recente e formato de
 * torneio. É a terceira fonte de contexto, e a primeira que NÃO vem da
 * Polymarket — o eval de 2026-08-07 mostrou o agente empatando com o preço
 * (Brier 0,1017 contra 0,1006 do mercado, n=12) e 58% das afirmações citando
 * `polymarket-context`, que é justamente a fonte de menor confiança e que o
 * mercado também lê.
 *
 * ---------------------------------------------------------------------------
 * OS TERMOS, E COMO ELES VIRARAM CÓDIGO
 * ---------------------------------------------------------------------------
 *
 * https://liquipedia.net/api-terms-of-use, lido em 2026-08-07. Cada regra tem
 * uma linha aqui, porque termo que só está no comentário é termo que se
 * descumpre no primeiro refactor:
 *
 *   "Rate limit all requests to no more than 60 requests per 1 hour."
 *      -> `RateBudget`, janela deslizante de 1h. O teto EFETIVO é 50: os 10
 *         restantes são reserva para o script de sonda, que roda noutro
 *         processo e teria contador próprio.
 *
 *   "Use a custom HTTP User-Agent header ... that identifies your project /
 *   use of the API, and includes contact information."
 *      -> `LIQUIPEDIA_USER_AGENT`, obrigatório. Sem ele o cliente RECUSA a
 *         chamada — não existe default, e não deve existir: um User-Agent
 *         genérico é, pelos próprios termos, motivo de bloqueio de IP.
 *
 *   "Re-use / cache your API results for as long as possible."
 *      -> cache em memória por query, com TTL, mais a memoização da identidade
 *         do time em `esports_teams.external_ids` (que sobrevive ao processo).
 *
 *   "Liquipedia content is licensed under CC-BY-SA 3.0, which requires that you
 *   attribute Liquipedia as the source of your data."
 *      -> `ATTRIBUTION` viaja em todo payload E no texto de todo `summary`. No
 *         texto porque é o `summary` que entra no prompt: um consumidor que
 *         concatene summaries perde os campos e fica só com as frases.
 *
 *   "Your HTTP client must support Content-Encoding: gzip"
 *      -> o `fetch` do Node (undici) negocia e descomprime gzip sozinho.
 *
 *   "Do not share your API Keys with third parties."
 *      -> a chave vive em `LIQUIPEDIA_API_KEY` e nunca entra em log, payload,
 *         mensagem de erro ou fragmento. `describeConfig` existe para o log
 *         poder dizer "configurado" sem dizer o quê.
 *
 * ---------------------------------------------------------------------------
 * O BLOQUEIO QUE NÃO É TÉCNICO
 * ---------------------------------------------------------------------------
 *
 * A chave da LPDB não é self-service: é pedido por formulário e aprovado por
 * gente. E a página de acesso diz que a chave NÃO é concedida a "betting-related
 * projects". Este projeto detecta sinal em mercado de previsão e dimensiona
 * aposta (`kelly.ts`, `my_bet_legs`, `bankroll.ts`) — se ele cai nessa
 * definição é decisão do dono, não deste código, e é decisão a tomar ANTES de
 * pedir a chave.
 *
 * Daí o desenho: sem `LIQUIPEDIA_API_KEY` e `LIQUIPEDIA_USER_AGENT` no ambiente,
 * e sem `esports_enricher_liquipedia_enabled` ligado na config, este módulo não
 * emite requisição nenhuma. Ele não falha, não tenta, não avisa em ciclo — o
 * enricher devolve vazio e o resto do sistema segue. Nada aqui liga sozinho.
 */

/** Base da API v3. Documentada como `https://api.liquipedia.net/api/v3/<datapoint>`. */
const BASE_URL = process.env['LIQUIPEDIA_API_URL'] ?? 'https://api.liquipedia.net/api/v3';

/** Teto dos termos. */
export const HOURLY_LIMIT = 60;

/**
 * Teto que ESTE processo se impõe.
 *
 * Menor que o dos termos de propósito: o script de sonda roda noutro processo,
 * com contador próprio, e dois contadores independentes somando 60 estourariam
 * o limite de verdade. A diferença é a reserva dele.
 */
export const PROCESS_HOURLY_LIMIT = 50;

/** Espaçamento mínimo entre duas chamadas. Educação, não exigência dos termos. */
const MIN_GAP_MS = 1_000;

/** Um socket pendurado seguraria o ciclo do enricher inteiro. */
const FETCH_TIMEOUT_MS = 15_000;

export const ATTRIBUTION = {
  source: 'Liquipedia',
  license: 'CC BY-SA 3.0',
  license_url: 'https://creativecommons.org/licenses/by-sa/3.0/',
} as const;

/** A frase que vai no fim de todo `summary`. Curta porque ocupa prompt. */
export const ATTRIBUTION_SUFFIX = 'Fonte: Liquipedia (CC BY-SA 3.0).';

// ---------------------------------------------------------------------------
// Configuração
// ---------------------------------------------------------------------------

export interface LiquipediaConfig {
  apiKey: string;
  userAgent: string;
}

/**
 * A configuração do ambiente, ou `null` se falta alguma parte.
 *
 * Lida a cada chamada, e não uma vez no import: um processo que sobe antes de a
 * variável existir não pode ficar permanentemente convencido de que ela não
 * existe. É a mesma razão do `PROBE_RETRY_MS` das sondas de tabela.
 */
export function readConfig(): LiquipediaConfig | null {
  const apiKey = process.env['LIQUIPEDIA_API_KEY']?.trim();
  const userAgent = process.env['LIQUIPEDIA_USER_AGENT']?.trim();

  if (apiKey === undefined || apiKey.length === 0) return null;
  if (userAgent === undefined || userAgent.length === 0) return null;

  return { apiKey, userAgent };
}

/**
 * O que falta para o cliente poder chamar — em texto, para o log.
 *
 * Nunca diz o valor de nada. "configurado" é toda a informação que um log
 * precisa ter sobre uma credencial.
 */
export function describeConfig(): string {
  const apiKey = process.env['LIQUIPEDIA_API_KEY']?.trim();
  const userAgent = process.env['LIQUIPEDIA_USER_AGENT']?.trim();

  const missing: string[] = [];
  if (apiKey === undefined || apiKey.length === 0) missing.push('LIQUIPEDIA_API_KEY');
  if (userAgent === undefined || userAgent.length === 0) missing.push('LIQUIPEDIA_USER_AGENT');

  return missing.length === 0 ? 'configurado' : `faltando: ${missing.join(', ')}`;
}

// ---------------------------------------------------------------------------
// Orçamento de requisições
// ---------------------------------------------------------------------------

/**
 * Janela deslizante de uma hora.
 *
 * NÃO enfileira, NÃO espera: quando o orçamento acaba, a chamada é recusada na
 * hora e quem pediu desiste deste ciclo. Enfileirar seria o pior dos dois
 * mundos — o ciclo do enricher ficaria segurando o lock por até uma hora
 * esperando um token para produzir um fragmento que ninguém está esperando.
 */
export class RateBudget {
  private readonly hits: number[] = [];
  private lastAt = 0;

  constructor(
    private readonly limit = PROCESS_HOURLY_LIMIT,
    private readonly windowMs = 60 * 60_000,
  ) {}

  /** Quantas chamadas ainda cabem na janela. */
  remaining(now = Date.now()): number {
    this.prune(now);
    return Math.max(this.limit - this.hits.length, 0);
  }

  /** Milissegundos até a próxima chamada ser permitida. 0 = agora. */
  waitMs(now = Date.now()): number {
    this.prune(now);

    if (this.hits.length >= this.limit) {
      const oldest = this.hits[0] as number;
      return Math.max(oldest + this.windowMs - now, 1);
    }

    return Math.max(this.lastAt + MIN_GAP_MS - now, 0);
  }

  /**
   * Consome um token, se houver.
   *
   * O gap mínimo é espera curta e legítima (1s); o teto horário é recusa. Os
   * dois casos são diferentes de propósito: dormir 1s dentro de um ciclo é
   * aceitável, dormir 40 min não é.
   */
  take(now = Date.now()): { ok: true } | { ok: false; retryInMs: number } {
    this.prune(now);

    if (this.hits.length >= this.limit) {
      const oldest = this.hits[0] as number;
      return { ok: false, retryInMs: Math.max(oldest + this.windowMs - now, 1) };
    }

    this.hits.push(now);
    this.lastAt = now;
    return { ok: true };
  }

  private prune(now: number): void {
    const cutoff = now - this.windowMs;
    while (this.hits.length > 0 && (this.hits[0] as number) <= cutoff) this.hits.shift();
  }
}

/** O orçamento do processo. Compartilhado por todas as partidas de todos os ciclos. */
export const budget = new RateBudget();

// ---------------------------------------------------------------------------
// Erros
// ---------------------------------------------------------------------------

export type LiquipediaErrorKind =
  /** Falta chave ou User-Agent. Nenhuma requisição foi feita. */
  | 'not_configured'
  /** Orçamento da hora esgotado. Nenhuma requisição foi feita. */
  | 'rate_limited'
  /** A API respondeu erro. `status` diz qual. */
  | 'http'
  | 'timeout'
  /** A resposta não tem a forma esperada. */
  | 'shape'
  /** Condição com caractere que quebraria a sintaxe do LPDB. */
  | 'unsafe_condition';

export class LiquipediaError extends Error {
  constructor(
    readonly kind: LiquipediaErrorKind,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'LiquipediaError';
  }
}

// ---------------------------------------------------------------------------
// Condições
// ---------------------------------------------------------------------------

/**
 * Guard da sintaxe de condição do LPDB, no mesmo espírito de `safeSlugPrefixes`.
 *
 * `[[campo::valor]]`, unido por `AND`/`OR`. Colchete, barra vertical e `::`
 * dentro do VALOR são estrutura, não conteúdo — um nome de time com qualquer um
 * deles mudaria o sentido da condição em silêncio, e uma condição errada não
 * falha: ela responde sobre outra coisa.
 */
const UNSAFE_CONDITION_CHARS = /[[\]|]|::/;

export function conditionValue(value: string): string {
  const clean = value.trim();

  if (clean.length === 0) {
    throw new LiquipediaError('unsafe_condition', 'valor de condição vazio');
  }
  if (UNSAFE_CONDITION_CHARS.test(clean)) {
    throw new LiquipediaError(
      'unsafe_condition',
      `valor de condição com caractere de estrutura: ${JSON.stringify(clean)}`,
    );
  }

  return clean;
}

export function eq(field: string, value: string): string {
  return `[[${field}::${conditionValue(value)}]]`;
}

/** `[[date::<2026-08-07]]`, com a data em UTC e sem hora. */
export function before(field: string, date: Date): string {
  return `[[${field}::<${date.toISOString().slice(0, 10)}]]`;
}

export function and(...parts: string[]): string {
  return parts.filter(p => p.length > 0).join(' AND ');
}

export function or(...parts: string[]): string {
  const kept = parts.filter(p => p.length > 0);
  return kept.length > 1 ? `(${kept.join(' OR ')})` : (kept[0] ?? '');
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

interface CacheEntry {
  at: number;
  rows: Record<string, unknown>[];
}

const cache = new Map<string, CacheEntry>();

/** Teto de entradas, contra crescimento sem fim num processo de dias. */
const MAX_CACHE_ENTRIES = 500;

export function resetLiquipediaCache(): void {
  cache.clear();
}

// ---------------------------------------------------------------------------
// A chamada
// ---------------------------------------------------------------------------

export interface QueryOptions {
  /** Wiki da Liquipedia: `counterstrike`, `leagueoflegends`, `dota2`. */
  wiki: string;
  /** Datapoint: `team`, `squadplayer`, `match2`, `tournament`. */
  datapoint: string;
  conditions: string;
  /** Campos pedidos. Menos campo = menos payload, e os termos pedem isso. */
  query: string;
  limit?: number;
  /** `date DESC` etc. */
  order?: string;
  /** Validade da resposta em cache, em segundos. */
  cacheSeconds: number;
}

function cacheKey(opts: QueryOptions): string {
  return [opts.wiki, opts.datapoint, opts.conditions, opts.query, opts.limit, opts.order].join('|');
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Uma consulta ao LPDB, com cache, orçamento e as três exigências dos termos.
 *
 * Devolve as linhas de `result`. Nunca devolve a resposta crua: o formato da
 * envelopagem é detalhe da API, e o chamador que dependesse dele teria que
 * mudar junto com ela.
 *
 * ## Sobre a forma da resposta
 *
 * A documentação oficial (api.liquipedia.net/documentation) exige chave para ser
 * lida, então o parsing aqui é DEFENSIVO por decisão e não por preguiça: aceita
 * `{ result: [...] }` e uma lista crua, e trata qualquer outra coisa como
 * `shape` — erro nomeado, não exceção de acesso a campo. O primeiro contato real
 * com a API deve ser `npm run liquipedia:probe`, que imprime a resposta crua
 * justamente para confirmar isto antes de o job depender dela.
 */
export async function query(opts: QueryOptions): Promise<Record<string, unknown>[]> {
  const key = cacheKey(opts);
  const now = Date.now();

  const hit = cache.get(key);
  if (hit !== undefined && now - hit.at < opts.cacheSeconds * 1000) {
    return hit.rows;
  }

  const config = readConfig();
  if (config === null) {
    throw new LiquipediaError('not_configured', `credenciais ausentes (${describeConfig()})`);
  }

  // A ordem importa. O espaçamento é medido ANTES de consumir o token, senão
  // ele mede a distância para a própria chamada que se acabou de registrar e
  // dorme 1s antes de toda requisição, inclusive a primeira.
  if (budget.remaining(now) === 0) {
    throw new LiquipediaError(
      'rate_limited',
      `orçamento de ${PROCESS_HOURLY_LIMIT}/h esgotado, libera em ${Math.round(budget.waitMs(now) / 1000)}s`,
    );
  }

  const gap = budget.waitMs(now);
  if (gap > 0) await sleep(gap);

  const token = budget.take();
  if (!token.ok) {
    throw new LiquipediaError(
      'rate_limited',
      `orçamento de ${PROCESS_HOURLY_LIMIT}/h esgotado, libera em ${Math.round(token.retryInMs / 1000)}s`,
    );
  }

  const params = new URLSearchParams({
    wiki: opts.wiki,
    conditions: opts.conditions,
    query: opts.query,
  });
  if (opts.limit !== undefined) params.set('limit', String(opts.limit));
  if (opts.order !== undefined) params.set('order', opts.order);

  const url = `${BASE_URL}/${opts.datapoint}?${params.toString()}`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(url, {
      headers: {
        // O formato documentado pelos clientes da comunidade. A chave nunca é
        // logada — ver `describeConfig`.
        Authorization: `Apikey ${config.apiKey}`,
        'User-Agent': config.userAgent,
        Accept: 'application/json',
      },
      signal: controller.signal,
    });
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new LiquipediaError('timeout', `timeout de ${FETCH_TIMEOUT_MS}ms em ${opts.datapoint}`);
    }
    throw new LiquipediaError('http', `falha de rede em ${opts.datapoint}: ${String(err)}`);
  } finally {
    clearTimeout(timeoutId);
  }

  if (!response.ok) {
    // 429 é o próprio servidor dizendo que o orçamento local está errado. Zerar
    // o que resta da janela é a resposta certa: insistir é o caminho para o ban
    // de IP que os termos prometem.
    if (response.status === 429) {
      for (let i = budget.remaining(); i > 0; i--) budget.take();
    }
    throw new LiquipediaError(
      'http',
      `HTTP ${response.status} em ${opts.datapoint}`,
      response.status,
    );
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch (err) {
    throw new LiquipediaError('shape', `resposta não é JSON em ${opts.datapoint}: ${String(err)}`);
  }

  const rows = extractRows(body, opts.datapoint);

  if (cache.size >= MAX_CACHE_ENTRIES) cache.clear();
  cache.set(key, { at: Date.now(), rows });

  return rows;
}

/** As linhas, sob a envelopagem que vier. Pura, para o teste cobrir sem rede. */
export function extractRows(body: unknown, datapoint = 'consulta'): Record<string, unknown>[] {
  const list = Array.isArray(body)
    ? body
    : typeof body === 'object' && body !== null
      ? ((body as Record<string, unknown>)['result'] ?? null)
      : null;

  if (!Array.isArray(list)) {
    throw new LiquipediaError('shape', `resposta de ${datapoint} sem lista em \`result\``);
  }

  return list.filter(
    (row): row is Record<string, unknown> => typeof row === 'object' && row !== null,
  );
}
