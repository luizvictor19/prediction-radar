/**
 * Cliente da OddsPapi v4 — o que `scripts/probe-oddspapi.ts` mediu, virado em
 * código que roda em produção.
 *
 * Duas rotas, e a diferença entre elas governa o desenho inteiro:
 *
 *   `/v4/fixtures`        — BILLABLE. Descobre a partida deles que corresponde à
 *                           nossa. Teto de 10 dias por janela (medido:
 *                           `INVALID_PARAMETER` acima disso).
 *   `/v4/historical-odds` — declarado livre pela doc. É a série de linha, e é o
 *                           que o enricher lê a cada ciclo.
 *
 * ## O tier gratuito é cortesia, e cortesia acaba sem aviso
 *
 * São 250 requisições billable por mês, sem contador observável: `/v4/account`
 * não traz cota no corpo nem em header (medido). Isso tem duas consequências que
 * estão implementadas aqui e não são opcionais:
 *
 *   1. O orçamento é ESTIMADO por este processo, não lido da fonte. Serve para
 *      impedir laço descontrolado, não para saber quanto resta de verdade. Um
 *      deploy zera a contagem — e o desenho absorve isso porque a descoberta é
 *      memoizada em `esports_matches.external_ids`: reaprender custa zero.
 *
 *   2. Corte de acesso (401/403/402) é tratado como estado, não como erro de
 *      chamada. O cliente entra em `SUSPENDED_COOLDOWN_MS` e para de tentar. Um
 *      componente que insiste contra um tier cortado só produz log e queima
 *      relação com o fornecedor.
 *
 * Nada aqui levanta exceção para fora do enricher: `OddsPapiError` é nomeada e o
 * chamador decide. O contrato com o ciclo é o do `liquipedia-api`: o componente
 * degrada sozinho, o ciclo não fica sabendo.
 */

const COMPONENT = 'oddspapi-api';

const BASE_URL = 'https://api.oddspapi.io';

/**
 * `sportId` por vertical.
 *
 * SÓ `cs2`, e a ausência das outras duas é deliberada. A sonda anotou "LoL = 18,
 * Dota 2 = 16 — conferir com /v4/sports depois", e essa conferência não
 * aconteceu. Um `sportId` errado não falha: devolve as fixtures de OUTRO jogo, o
 * casamento por nome não acha ninguém, e o resultado é uma requisição billable
 * gasta por partida para descobrir nada. Vertical fora deste mapa não é
 * atendida, e é assim que fica até `/v4/sports` confirmar os números.
 */
export const SPORT_ID_BY_VERTICAL: Readonly<Record<string, number>> = {
  cs2: 17,
};

/**
 * Cooldown por endpoint, com margem sobre o documentado (fixtures 2000ms,
 * historical-odds 5000ms). Medido na sonda: o limitador deles não é só por
 * endpoint, daí o piso global.
 */
const COOLDOWN_MS: Readonly<Record<string, number>> = {
  '/v4/fixtures': 2500,
  '/v4/historical-odds': 5500,
};
const COOLDOWN_DEFAULT_MS = 5500;
const GLOBAL_COOLDOWN_MS = 1200;

/** Endpoints que a doc declara não-billable. */
const FREE_ENDPOINTS: ReadonlySet<string> = new Set(['/v4/account', '/v4/historical-odds']);

/** Teto do plano Free, por mês. */
export const MONTHLY_BILLABLE_LIMIT = 250;

/**
 * Reserva que a descoberta não pode encostar.
 *
 * O orçamento é estimado (ver o topo). Gastar até o último token confiando numa
 * estimativa é como não ter orçamento: quando a estimativa erra para baixo, quem
 * descobre é o 4xx. A reserva é a margem para esse erro.
 */
export const BILLABLE_RESERVE = 40;

/** Quanto tempo o cliente fica quieto depois de um corte de acesso. */
export const SUSPENDED_COOLDOWN_MS = 6 * 3_600_000;

const FETCH_TIMEOUT_MS = 20_000;

/** Máximo de casas que `/v4/historical-odds` aceita por chamada (documentado). */
export const MAX_BOOKMAKERS_PER_CALL = 3;

// ---------------------------------------------------------------------------
// Configuração
// ---------------------------------------------------------------------------

/**
 * A chave, ou `null`. Lida a cada chamada e não no import, pelo mesmo motivo do
 * cliente da Liquipedia: um processo que subiu antes da variável existir não
 * pode ficar convencido para sempre de que ela não existe.
 */
export function readConfig(): { apiKey: string } | null {
  const apiKey = process.env['ODDSPAPI_API_KEY']?.trim();
  if (apiKey === undefined || apiKey.length === 0) return null;
  return { apiKey };
}

/** O que falta, em texto para log. Nunca diz o valor de nada. */
export function describeConfig(): string {
  return readConfig() === null ? 'faltando: ODDSPAPI_API_KEY' : 'configurado';
}

// ---------------------------------------------------------------------------
// Erros
// ---------------------------------------------------------------------------

export type OddsPapiErrorKind =
  /** Falta a chave. Nenhuma requisição foi feita. */
  | 'not_configured'
  /** Orçamento billable estimado no fim. Nenhuma requisição foi feita. */
  | 'budget_exhausted'
  /** Acesso cortado (401/403/402). O cliente está em cooldown. */
  | 'suspended'
  /** 429 do servidor. */
  | 'rate_limited'
  | 'http'
  | 'timeout'
  /** A resposta não tem a forma esperada. */
  | 'shape'
  /** Parâmetro que quebraria a requisição — prefixo, slug ou id fora do léxico. */
  | 'unsafe_param';

export class OddsPapiError extends Error {
  constructor(
    readonly kind: OddsPapiErrorKind,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'OddsPapiError';
  }
}

/**
 * Erro que o enricher deve engolir com um aviso por hora, em vez de tratar como
 * incidente.
 *
 * São os estados em que o componente está funcionando corretamente e a FONTE é
 * que não está disponível — incluindo o corte de cortesia, que é o caso esperado
 * deste tier e não uma anomalia.
 */
export function isExpectedOutage(err: OddsPapiError): boolean {
  return (
    err.kind === 'not_configured' ||
    err.kind === 'budget_exhausted' ||
    err.kind === 'suspended' ||
    err.kind === 'rate_limited'
  );
}

// ---------------------------------------------------------------------------
// Orçamento billable, estimado
// ---------------------------------------------------------------------------

/**
 * Janela deslizante de 30 dias sobre as chamadas a endpoint billable.
 *
 * NÃO é a cota real — é a estimativa deste processo. A cota real não é
 * observável (medido: `/v4/account` não traz contador nenhum), e um número que
 * finge saber o que não sabe é pior que um número declaradamente aproximado.
 */
export class BillableBudget {
  private readonly hits: number[] = [];

  constructor(
    private readonly limit = MONTHLY_BILLABLE_LIMIT,
    private readonly windowMs = 30 * 24 * 3_600_000,
  ) {}

  spent(now = Date.now()): number {
    this.prune(now);
    return this.hits.length;
  }

  remaining(now = Date.now()): number {
    return Math.max(this.limit - this.spent(now), 0);
  }

  /** Cabe gastar, respeitando a reserva? */
  canSpend(reserve = BILLABLE_RESERVE, now = Date.now()): boolean {
    return this.remaining(now) > reserve;
  }

  take(now = Date.now()): void {
    this.prune(now);
    this.hits.push(now);
  }

  reset(): void {
    this.hits.length = 0;
  }

  private prune(now: number): void {
    const cutoff = now - this.windowMs;
    while (this.hits.length > 0 && (this.hits[0] as number) <= cutoff) this.hits.shift();
  }
}

export const billableBudget = new BillableBudget();

// ---------------------------------------------------------------------------
// Estado de suspensão do tier
// ---------------------------------------------------------------------------

let suspendedUntil = 0;

export function suspendedForMs(now = Date.now()): number {
  return Math.max(suspendedUntil - now, 0);
}

export function markSuspended(now = Date.now()): void {
  suspendedUntil = now + SUSPENDED_COOLDOWN_MS;
}

export function resetOddsPapiState(): void {
  suspendedUntil = 0;
  billableBudget.reset();
  cache.clear();
  lastCallAt.clear();
  lastAnyCallAt = 0;
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

interface CacheEntry {
  at: number;
  body: unknown;
}

const cache = new Map<string, CacheEntry>();
const MAX_CACHE_ENTRIES = 200;

// ---------------------------------------------------------------------------
// Chamada
// ---------------------------------------------------------------------------

const lastCallAt = new Map<string, number>();
let lastAnyCallAt = 0;

/**
 * Quanto esta chamada VAI dormir antes de sair, sem dormir.
 *
 * O cooldown é POR PROCESSO e não por chamada, e isso está certo: é o limite da
 * chave deles, não uma cortesia local. Torná-lo por chamada só faria N chamadas
 * partirem juntas e levarem 429.
 *
 * O erro não era o escopo, era a espera ser INVISÍVEL. `call` dormia 5,5s dentro
 * de si mesma e cobrava isso de quem chamou sem avisar; com 40 partidas num
 * ciclo, viravam 220 segundos que ninguém tinha orçado — e o ciclo estourava o
 * timeout de 4 min sem nenhum componente ter feito nada de errado.
 *
 * Com o custo exposto, quem chama decide: cabe no meu orçamento de tempo, ou
 * desisto desta partida e deixo para o ciclo seguinte?
 */
export function waitMsFor(path: string, now = Date.now()): number {
  const cooldown = COOLDOWN_MS[path] ?? COOLDOWN_DEFAULT_MS;

  const previous = lastCallAt.get(path);
  const perEndpoint = previous === undefined ? 0 : Math.max(cooldown - (now - previous), 0);
  const global = Math.max(GLOBAL_COOLDOWN_MS - (now - lastAnyCallAt), 0);

  return Math.max(perEndpoint, global);
}

/** O custo de uma chamada a este endpoint quando o cooldown já venceu. */
export function cooldownOf(path: string): number {
  return COOLDOWN_MS[path] ?? COOLDOWN_DEFAULT_MS;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Guard dos parâmetros, no mesmo espírito de `safeSlugPrefixes` e de
 * `conditionValue` do LPDB.
 *
 * Id de fixture e slug de casa entram na query string. Um valor com `&` ou `=`
 * não falharia: mudaria o sentido da requisição em silêncio, e uma requisição
 * que responde sobre outra coisa é o pior modo de falha possível numa fonte de
 * preço.
 */
const SAFE_PARAM_RE = /^[a-zA-Z0-9_.-]+$/;

export function safeParam(name: string, value: string): string {
  const clean = value.trim();
  if (clean.length === 0) {
    throw new OddsPapiError('unsafe_param', `${name} vazio`);
  }
  if (!SAFE_PARAM_RE.test(clean)) {
    throw new OddsPapiError(
      'unsafe_param',
      `${name} com caractere fora de [a-zA-Z0-9_.-]: ${JSON.stringify(clean)}`,
    );
  }
  return clean;
}

/** Medido: o 429 deles traz `error.retryMs` com a espera exata. */
function retryMsOf(body: unknown): number | null {
  if (!isRecord(body)) return null;
  const err = body['error'];
  if (!isRecord(err)) return null;
  const ms = err['retryMs'];
  return typeof ms === 'number' ? ms : null;
}

interface CallOptions {
  readonly path: string;
  readonly params: Readonly<Record<string, string>>;
  readonly cacheSeconds: number;
  /** Reserva a respeitar quando o endpoint é billable. */
  readonly reserve?: number;
}

/**
 * Uma chamada, com cooldown, orçamento, cache e o cooldown de suspensão.
 *
 * A ordem das guardas é a ordem do custo: primeiro o que não gasta nada (cache,
 * suspensão, configuração, orçamento), depois a espera, e só então a rede.
 */
async function call(opts: CallOptions, attempt = 0): Promise<unknown> {
  const key = `${opts.path}?${new URLSearchParams(opts.params).toString()}`;
  const now = Date.now();

  const hit = cache.get(key);
  if (hit !== undefined && now - hit.at < opts.cacheSeconds * 1000) {
    return hit.body;
  }

  const suspended = suspendedForMs(now);
  if (suspended > 0) {
    throw new OddsPapiError(
      'suspended',
      `acesso cortado — quieto por mais ${Math.round(suspended / 60_000)} min`,
    );
  }

  const config = readConfig();
  if (config === null) {
    throw new OddsPapiError('not_configured', `credencial ausente (${describeConfig()})`);
  }

  const billable = !FREE_ENDPOINTS.has(opts.path);
  if (billable && !billableBudget.canSpend(opts.reserve ?? BILLABLE_RESERVE, now)) {
    throw new OddsPapiError(
      'budget_exhausted',
      `orçamento billable estimado no fim: ${billableBudget.remaining(now)}/${MONTHLY_BILLABLE_LIMIT} ` +
        `restantes, reserva ${opts.reserve ?? BILLABLE_RESERVE}`,
    );
  }

  const cooldown = COOLDOWN_MS[opts.path] ?? COOLDOWN_DEFAULT_MS;
  const previous = lastCallAt.get(opts.path);
  if (previous !== undefined) {
    const wait = cooldown - (Date.now() - previous);
    if (wait > 0) await sleep(wait);
  }
  const sinceAny = Date.now() - lastAnyCallAt;
  if (sinceAny < GLOBAL_COOLDOWN_MS) await sleep(GLOBAL_COOLDOWN_MS - sinceAny);

  const url = new URL(opts.path, BASE_URL);
  url.searchParams.set('apiKey', config.apiKey);
  for (const [k, v] of Object.entries(opts.params)) url.searchParams.set(k, v);

  lastCallAt.set(opts.path, Date.now());
  lastAnyCallAt = Date.now();
  if (billable && attempt === 0) billableBudget.take();

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(url, {
      headers: { accept: 'application/json' },
      signal: controller.signal,
    });
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new OddsPapiError('timeout', `timeout de ${FETCH_TIMEOUT_MS}ms em ${opts.path}`);
    }
    throw new OddsPapiError('http', `falha de rede em ${opts.path}: ${String(err)}`);
  } finally {
    clearTimeout(timeoutId);
  }

  const text = await response.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text) as unknown;
  } catch {
    /* não-JSON: fica o texto, que é o que interessa num erro */
  }

  // Corte de cortesia. Não é erro de chamada e não adianta repetir: o tier
  // sumiu, e o certo é ficar quieto até alguém olhar.
  if (response.status === 401 || response.status === 402 || response.status === 403) {
    markSuspended();
    throw new OddsPapiError(
      'suspended',
      `HTTP ${response.status} em ${opts.path} — acesso cortado, quieto por ${SUSPENDED_COOLDOWN_MS / 3_600_000}h`,
      response.status,
    );
  }

  if (response.status === 429) {
    const waitMs = retryMsOf(body);
    // Uma tentativa só, e só quando ELES dizem quanto esperar. Insistir contra
    // um limitador é o caminho para o corte que o bloco acima trata.
    if (attempt === 0 && waitMs !== null && waitMs <= 10_000) {
      await sleep(waitMs + 250);
      return call(opts, attempt + 1);
    }
    throw new OddsPapiError('rate_limited', `429 em ${opts.path}`, 429);
  }

  if (!response.ok) {
    throw new OddsPapiError(
      'http',
      `HTTP ${response.status} em ${opts.path}: ${text.slice(0, 200)}`,
      response.status,
    );
  }

  if (cache.size >= MAX_CACHE_ENTRIES) cache.clear();
  cache.set(key, { at: Date.now(), body });

  return body;
}

// ---------------------------------------------------------------------------
// `/v4/fixtures`
// ---------------------------------------------------------------------------

export interface OddsPapiFixture {
  readonly fixtureId: string;
  readonly startTime: string | null;
  /** Medido: `statusId` volta null em toda fixture de CS2. Quem diz que acabou é este. */
  readonly finished: boolean;
  readonly hasOdds: boolean;
  /** As três variantes de nome por lado, como eles as entregam. */
  readonly sides: readonly (readonly string[])[];
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

/** O primeiro array de objetos encontrado — a envelopagem varia por endpoint. */
function firstObjectArray(value: unknown): Record<string, unknown>[] | null {
  if (Array.isArray(value)) return value.filter(isRecord);
  if (isRecord(value)) {
    for (const nested of Object.values(value)) {
      const found = firstObjectArray(nested);
      if (found !== null && found.length > 0) return found;
    }
  }
  return null;
}

export function toFixture(row: Record<string, unknown>): OddsPapiFixture | null {
  const id = str(row['fixtureId']) ?? str(row['id']);
  if (id === null) return null;

  const side = (n: 1 | 2): string[] =>
    [
      str(row[`participant${n}Name`]),
      str(row[`participant${n}ShortName`]),
      str(row[`participant${n}Abbr`]),
    ].filter((s): s is string => s !== null);

  return {
    fixtureId: id,
    startTime: str(row['startTime']),
    finished: str(row['trueEndTime']) !== null,
    hasOdds: row['hasOdds'] === true,
    sides: [side(1), side(2)],
  };
}

/**
 * Fixtures de um esporte numa janela.
 *
 * BILLABLE. A janela é limitada a 9 dias porque a API rejeita acima de 10
 * (medido: `INVALID_PARAMETER`, "must be under 10 days apart") — e quem chama
 * deve preferir a MENOR janela que resolva, porque cada janela é uma requisição
 * do orçamento mensal.
 */
export async function fixtures(opts: {
  sportId: number;
  from: string;
  to: string;
  cacheSeconds?: number;
  reserve?: number;
}): Promise<OddsPapiFixture[]> {
  const body = await call({
    path: '/v4/fixtures',
    params: {
      sportId: String(opts.sportId),
      from: safeParam('from', opts.from),
      to: safeParam('to', opts.to),
    },
    // Uma hora. A janela de descoberta é o dia da partida, e fixture nova entra
    // com dias de antecedência — reconsultar de hora em hora é folgado, e cada
    // reconsulta custa do orçamento mensal.
    cacheSeconds: opts.cacheSeconds ?? 3_600,
    ...(opts.reserve === undefined ? {} : { reserve: opts.reserve }),
  });

  const rows = firstObjectArray(body);
  if (rows === null) {
    throw new OddsPapiError('shape', '/v4/fixtures não devolveu lista de objetos');
  }

  return rows.map(toFixture).filter((f): f is OddsPapiFixture => f !== null);
}

// ---------------------------------------------------------------------------
// `/v4/historical-odds`
// ---------------------------------------------------------------------------

export interface OddsEntry {
  /** Quando a casa publicou esta linha. Sem isto não há série. */
  readonly createdAt: string | null;
  readonly price: number | null;
  /** Stake máximo. Medido: só a Pinnacle preenche; na Stake vem null em tudo. */
  readonly limit: number | null;
  /**
   * `null` = o campo não existe na entrada, e isso NÃO é `false`.
   *
   * Ausência de campo não é suspensão. Colapsar os dois inventaria mercado
   * fechado onde só falta dado.
   */
  readonly active: boolean | null;
  /**
   * Nome do outcome, do ancestral mais próximo que tiver um.
   *
   * MEDIDO: na resposta real de CS2 vem `null` em TODAS as entradas — não existe
   * campo de nome em nível nenhum. O campo fica porque custa nada e porque a
   * identidade por nome, quando existe, é melhor que por posição; quem resolve o
   * lado no caso medido é `marketOutcomeOf`.
   */
  readonly outcome: string | null;
  /** Caminho até a entrada. Separa séries distintas dentro da mesma casa. */
  readonly path: string;
}

/**
 * `marketId` e `outcomeId` extraídos do caminho.
 *
 * A forma medida é `bookmakers.{casa}.markets.{marketId}.outcomes.{outcomeId}.players.{playerId}[]`
 * — mapas encadeados, com os ids como CHAVE. Não há nome em lugar nenhum, então
 * esses ids são a única identidade que a resposta oferece.
 *
 * Os ids são da taxonomia deles e globais, não por fixture: o market `171`
 * aparece igual na Pinnacle e na Stake, e os dois outcomes dele são `171` e
 * `172`. É o que torna possível fixar o mercado a ler em config em vez de
 * adivinhar por densidade a cada partida.
 */
export function marketOutcomeOf(path: string): { marketId: string; outcomeId: string } | null {
  const match = /(?:^|\.)markets\.([^.]+)\.outcomes\.([^.]+)/.exec(path);
  if (match === null) return null;
  return { marketId: match[1] as string, outcomeId: match[2] as string };
}

/**
 * Coleta recursiva das entradas. A doc descreve
 * `bookmakers -> markets -> outcomes -> players`, e o parsing NÃO depende disso:
 * qualquer objeto com `price` conta como entrada, em qualquer profundidade.
 *
 * Foi assim que a sonda mediu, e é o que sobrevive a eles mudarem a envelopagem
 * sem avisar. `outcome` vem do ancestral mais próximo que tenha nome — é o único
 * jeito de saber de que LADO a linha fala sem depender da posição no array.
 */
export function collectOdds(
  value: unknown,
  out: OddsEntry[],
  path = '',
  outcome: string | null = null,
): void {
  if (Array.isArray(value)) {
    value.forEach((item, i) =>
      collectOdds(item, out, path.length > 0 ? `${path}.${i}` : `${i}`, outcome),
    );
    return;
  }
  if (!isRecord(value)) return;

  const named =
    str(value['outcomeName']) ??
    str(value['participantName']) ??
    str(value['name']) ??
    str(value['label']) ??
    outcome;

  if ('price' in value) {
    const rawActive = value['active'] ?? value['isActive'] ?? value['is_active'];
    out.push({
      createdAt: str(value['createdAt']),
      price: typeof value['price'] === 'number' ? value['price'] : null,
      limit: typeof value['limit'] === 'number' ? value['limit'] : null,
      active: typeof rawActive === 'boolean' ? rawActive : null,
      outcome: named,
      path,
    });
  }

  for (const [k, nested] of Object.entries(value)) {
    collectOdds(nested, out, path.length > 0 ? `${path}.${k}` : k, named);
  }
}

/** As entradas agrupadas por casa, com o caminho preservado. */
export function groupByBookmaker(body: unknown): Map<string, OddsEntry[]> {
  const perBook = new Map<string, OddsEntry[]>();
  const node = isRecord(body) ? body['bookmakers'] : undefined;

  if (Array.isArray(node)) {
    node.forEach((book, i) => {
      if (!isRecord(book)) return;
      const slug = str(book['slug']) ?? str(book['key']) ?? str(book['name']) ?? `book-${i}`;
      const entries: OddsEntry[] = [];
      collectOdds(book, entries, `bookmakers.${i}`);
      perBook.set(slug, entries);
    });
    return perBook;
  }

  if (isRecord(node)) {
    // Medido: `bookmakers` é um MAPA slug -> conteúdo. Mesma forma de
    // `/v4/participants` e do entitlement em `/v4/account` — é o padrão da casa.
    for (const [slug, content] of Object.entries(node)) {
      const entries: OddsEntry[] = [];
      collectOdds(content, entries, `bookmakers.${slug}`);
      perBook.set(slug, entries);
    }
  }

  return perBook;
}

/**
 * A série histórica de uma fixture, por casa.
 *
 * Declarado não-billable pela doc — e é por isso que o enricher pode ler a cada
 * ciclo. Se um dia a medição do item 1 da sonda mostrar o contrário, é aqui que
 * `FREE_ENDPOINTS` muda, e o desenho inteiro do enricher passa a caber nas 250.
 *
 * Casa AUSENTE da resposta é normal, não erro: medido, bet365 devolve zero
 * apesar de entitulada. Quem trata isso é o chamador — este cliente devolve o
 * que veio.
 */
export async function historicalOdds(opts: {
  fixtureId: string;
  bookmakers: readonly string[];
  cacheSeconds?: number;
}): Promise<Map<string, OddsEntry[]>> {
  const books = opts.bookmakers
    .slice(0, MAX_BOOKMAKERS_PER_CALL)
    .map((b) => safeParam('bookmaker', b));

  if (books.length === 0) {
    throw new OddsPapiError('unsafe_param', 'nenhuma casa pedida');
  }

  const body = await call({
    path: '/v4/historical-odds',
    params: {
      fixtureId: safeParam('fixtureId', opts.fixtureId),
      bookmakers: books.join(','),
    },
    // Curto: a série ao vivo é o dado mais volátil que existe aqui, e o custo de
    // reler é o cooldown de 5,5s, não uma requisição do orçamento.
    cacheSeconds: opts.cacheSeconds ?? 120,
  });

  const perBook = groupByBookmaker(body);
  if (perBook.size === 0 && !isRecord(body)) {
    throw new OddsPapiError('shape', '/v4/historical-odds não devolveu objeto com `bookmakers`');
  }

  return perBook;
}

export { COMPONENT as ODDSPAPI_COMPONENT };
