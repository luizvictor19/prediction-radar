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

/**
 * TTL da resposta de `/v4/fixtures`. Oito horas, e o número é aritmética — não
 * preferência, não "parece razoável".
 *
 * Medido no painel deles: 78/250 em 10/08 06:46 UTC e 93/250 em 11/08 03:14 UTC.
 * São 15 requisições em 20,5h = 17,6/dia, e as duas leituras já são POSTERIORES
 * à correção do cache compartilhado — não é o defeito antigo ainda drenando.
 *
 * Restavam 117 até a reserva de 40 (`BILLABLE_RESERVE`) cortar, e o ciclo vira
 * por volta de 07/09, 27 dias depois da segunda leitura. O teto por CHAVE de
 * cache é 86400/TTL, e o gasto é ele vezes o número de chaves ativas por dia:
 *
 *     TTL 1h → 24/chave — três vezes o orçamento inteiro
 *     TTL 6h →  4/chave × 1,143 = 4,57/dia → 117 duram 25,6 dias, esgota 05/09
 *               e o ciclo só vira 07/09: FALTA 1,5 dia
 *     TTL 8h →  3/chave × 1,143 = 3,43/dia → 117 duram 34 dias: SOBRA 7 dias
 *
 * ## A premissa frágil é 1,143, não o TTL
 *
 * O 1,143 é `(6 dias × 1 chave + 1 dia × 2 chaves) / 7` — o modelo de quantas
 * chaves de `DISCOVERY_BLOCK_DAYS` ficam ativas por dia, supondo que o lookahead
 * do enricher só atravessa a fronteira do bloco no dia da virada. Isso NÃO foi
 * medido; depende de com que frequência o lookahead alcança o bloco seguinte.
 *
 * Terminar 1,5 dia curto apoiado num modelo não validado é apostar que o erro
 * vai para o lado bom. É por isso que o TTL subiu para 8h: os 7 dias de margem
 * são a folga para o 1,143 estar errado. Quem confirma ou derruba o modelo é a
 * medição das 24h seguintes ao deploy — leia o painel deles de novo e compare o
 * consumo real com 3,43/dia. Se der mais, o número de chaves é maior que o
 * modelado, e é o modelo que estava errado, não o TTL.
 *
 * ## Por que 8h custa pouco
 *
 * Por causa da guarda de procedência, e só por causa dela: lista velha que não
 * acha a fixture NÃO carimba mais `oddspapi_missing_at` (ver `mergeFixtureIds`
 * no enricher). A partida é reavaliada de graça a cada ciclo e entra assim que a
 * lista renovar. Ou seja, staleness virou ATRASO, não exclusão — o custo de um
 * TTL maior é a partida entrar algumas horas depois, não ficar de fora.
 *
 * Se alguém reverter aquela guarda, este raciocínio some junto e 8h passa a
 * significar até 32h de silêncio por partida (8h de lista velha + 24h de
 * carimbo). As duas coisas são uma só.
 *
 * ## Qual dial girar
 *
 * ESTE. TTL não tem teto rígido e o efeito no orçamento é linear e imediato.
 * `DISCOVERY_BLOCK_DAYS` não — ele esbarra no limite de 10 dias da API e engorda
 * a lista devolvida, que é o que `describeTruncationRisk` existe para vigiar.
 */
export const FIXTURES_CACHE_SECONDS = 8 * 3_600;

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
  freeCache.clear();
  billableCache.clear();
  lastCallAt.clear();
  lastAnyCallAt = 0;
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

interface CacheEntry {
  at: number;
  /** Vencimento gravado por quem ESCREVEU. Só a evicção usa; a leitura usa o TTL de quem chama. */
  expiresAt: number;
  body: unknown;
}

/**
 * DOIS caches, separados pela mesma linha que separa a conta: billable e livre.
 *
 * A separação não é organização, é a garantia. `/v4/historical-odds` é livre e o
 * enricher o chama uma vez por partida por ciclo (~38 partidas, tick de 5 min);
 * `/v4/fixtures` é BILLABLE, custa do orçamento de 250/mês e por isso pede TTL
 * de 1h. Num mapa só, a rotatividade do livre enchia o teto em poucos ciclos e
 * despejava a entrada de fixtures muito antes da hora dela — e cada redescoberta
 * depois disso é uma requisição paga. O endpoint barato pagava a conta do caro.
 *
 * Compartilhar o mapa e só trocar a política de despejo NÃO resolveria: a entrada
 * de fixtures é justamente a mais ANTIGA do conjunto (escrita uma vez, vale 1h)
 * enquanto as de odds são reescritas a cada 2 min. Qualquer critério por idade a
 * elegeria primeiro. O que garante é o livre não alcançar o mapa do billable.
 */
const freeCache = new Map<string, CacheEntry>();
const billableCache = new Map<string, CacheEntry>();

/** Teto POR mapa. O mapa billable tem uma entrada por janela de descoberta e nunca chega perto. */
export const MAX_CACHE_ENTRIES = 200;

function cacheFor(path: string): Map<string, CacheEntry> {
  return FREE_ENDPOINTS.has(path) ? freeCache : billableCache;
}

export function cacheKeyOf(path: string, params: Readonly<Record<string, string>>): string {
  return `${path}?${new URLSearchParams(params).toString()}`;
}

/**
 * Abre espaço para uma entrada, sem `clear()`.
 *
 * O `clear()` era o defeito em si: jogava fora entrada VÁLIDA e cara para
 * acomodar uma barata. Primeiro saem as já vencidas (que não custam nada a
 * ninguém); só se nenhuma tiver vencido é que sai a de escrita mais antiga.
 */
function evict(map: Map<string, CacheEntry>, now: number): void {
  if (map.size < MAX_CACHE_ENTRIES) return;

  for (const [key, entry] of map) {
    if (entry.expiresAt <= now) map.delete(key);
  }

  // Map itera em ordem de inserção, e `cacheWrite` apaga antes de gravar — a
  // primeira chave é sempre a de escrita mais antiga.
  while (map.size >= MAX_CACHE_ENTRIES) {
    const oldest = map.keys().next();
    if (oldest.done === true) return;
    map.delete(oldest.value);
  }
}

/** A entrada ainda dentro do TTL de quem pede, ou `undefined`. */
export function cacheRead(
  path: string,
  params: Readonly<Record<string, string>>,
  cacheSeconds: number,
  now = Date.now(),
): { body: unknown } | undefined {
  const hit = cacheFor(path).get(cacheKeyOf(path, params));
  if (hit === undefined || now - hit.at >= cacheSeconds * 1000) return undefined;
  return { body: hit.body };
}

export function cacheWrite(
  path: string,
  params: Readonly<Record<string, string>>,
  cacheSeconds: number,
  body: unknown,
  now = Date.now(),
): void {
  const map = cacheFor(path);
  const key = cacheKeyOf(path, params);

  map.delete(key); // reescrita volta para o fim da fila de idade
  evict(map, now);
  map.set(key, { at: now, expiresAt: now + cacheSeconds * 1000, body });
}

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

/**
 * De onde veio uma resposta. Rede ou cache — e a diferença é uma AFIRMAÇÃO
 * diferente sobre o mundo.
 *
 * `network` significa "a OddsPapi respondeu isto agora". `cache` significa
 * "a OddsPapi respondeu isto em algum momento das últimas 6h". A segunda não
 * sustenta conclusão sobre ausência: uma fixture que não está numa lista de 5h
 * atrás pode ter sido cadastrada há 4h.
 */
export type ResponseSource = 'network' | 'cache';

/**
 * Um valor com a procedência grudada.
 *
 * A procedência viaja no RETORNO, e não numa variável de módulo do tipo
 * `ultimaChamadaVeioDoCache`. Estado mutável de módulo já produziu três
 * incidentes neste repo — o cursor do resolver, o `lastAttemptAt` do enricher e
 * o próprio cache deste cliente — e o modo de falha é sempre o mesmo: o
 * comportamento logo depois do deploy é diferente do comportamento em regime,
 * então o teste passa, a primeira passada passa, e o defeito aparece na quarta
 * hora de produção. Aqui não há instante em que a resposta e a procedência
 * estejam separadas: quem tem uma tem a outra.
 *
 * Só isto não IMPEDE de esquecer — `.value` é acessível sem olhar `.source`. O
 * que impede está no ponto onde a distinção importa: `FixtureOutcome` no
 * enricher não deixa construir uma ausência sem declarar a procedência dela.
 */
export interface Sourced<T> {
  readonly source: ResponseSource;
  readonly value: T;
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
async function call(opts: CallOptions, attempt = 0): Promise<Sourced<unknown>> {
  const now = Date.now();

  const hit = cacheRead(opts.path, opts.params, opts.cacheSeconds, now);
  if (hit !== undefined) {
    return { source: 'cache', value: hit.body };
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

  cacheWrite(opts.path, opts.params, opts.cacheSeconds, body);

  return { source: 'network', value: body };
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
 * Contagens que cheiram a teto de página em vez de a fim de lista.
 *
 * Nenhuma delas é prova: 250 fixtures de CS2 numa janela de 9 dias é um número
 * perfeitamente possível. O que elas são é o único sinal barato que existe —
 * a doc não promete ausência de paginação, e ninguém mediu.
 */
export const SUSPICIOUS_PAGE_SIZES: readonly number[] = [100, 250, 500, 1000];

/** Nomes de campo que denunciam resposta paginada, em qualquer capitalização. */
const PAGINATION_KEYS: ReadonlySet<string> = new Set([
  'cursor',
  'nextcursor',
  'next',
  'nextpage',
  'hasmore',
  'hasnext',
  'page',
  'pages',
  'pagecount',
  'pagesize',
  'perpage',
  'limit',
  'offset',
  'total',
  'totalcount',
  'totalpages',
]);

/**
 * Campos de paginação na ENVELOPAGEM da resposta.
 *
 * Não desce em array de propósito. As fixtures são o array, e uma delas pode
 * muito bem ter um campo `total` ou `limit` seu — varrer as 350 produziria
 * alarme toda vez. O que interessa é o envelope em volta da lista.
 */
export function paginationHintsOf(body: unknown, depth = 0): string[] {
  if (depth > 3 || !isRecord(body)) return [];

  const found: string[] = [];
  for (const [key, value] of Object.entries(body)) {
    if (PAGINATION_KEYS.has(key.toLowerCase().replace(/[_-]/g, ''))) {
      found.push(`${key}=${JSON.stringify(value)?.slice(0, 40) ?? 'null'}`);
    }
    if (isRecord(value)) found.push(...paginationHintsOf(value, depth + 1));
  }

  return found;
}

/**
 * O aviso de truncamento, ou `null` quando nada cheira mal.
 *
 * Por que isto existe: a janela passou de 3 para 9 dias (`DISCOVERY_BLOCK_DAYS`
 * no enricher), e a lista que volta é da ordem de centenas em vez de dezenas. Se
 * `/v4/fixtures` cortar num teto qualquer, o excesso some em SILÊNCIO — e uma
 * fixture ausente por truncamento é indistinguível de uma fixture que não
 * existe. O enricher registraria a segunda leitura como fato sobre a partida.
 *
 * É o modo de falha mais caro que sobrou neste caminho: a cobertura está em 41%,
 * e uma perda por truncamento entraria nessa conta sem deixar rastro.
 */
export function describeTruncationRisk(count: number, body: unknown): string | null {
  const hints = paginationHintsOf(body);
  const roundNumber = SUSPICIOUS_PAGE_SIZES.includes(count);

  if (!roundNumber && hints.length === 0) return null;

  const causes: string[] = [];
  if (roundNumber) {
    causes.push(`a contagem é exatamente ${count}, um teto de página plausível`);
  }
  if (hints.length > 0) {
    causes.push(`a resposta traz campo de paginação (${hints.join(', ')})`);
  }

  return (
    `possível TRUNCAMENTO em /v4/fixtures: ${causes.join(' e ')}. ` +
    `Fixture cortada é indistinguível de fixture inexistente, e o enricher ` +
    `carimbaria a partida como não coberta. Confirme com a sonda antes de confiar ` +
    `na cobertura desta janela.`
  );
}

/**
 * Fixtures de um esporte numa janela, COM a procedência da resposta.
 *
 * BILLABLE. A janela é limitada a 9 dias porque a API rejeita acima de 10
 * (medido: `INVALID_PARAMETER`, "must be under 10 days apart") — e quem chama
 * deve preferir a MENOR janela que resolva, porque cada janela é uma requisição
 * do orçamento mensal.
 *
 * Devolve `Sourced` e não a lista crua porque, com TTL de
 * `FIXTURES_CACHE_SECONDS`, "não achei nesta lista" deixou de ser um fato sobre
 * a partida e passou a ser um fato sobre a IDADE DA LISTA. Quem chama precisa
 * saber qual dos dois tem na mão antes de gravar conclusão em lugar nenhum.
 */
export async function fixtures(opts: {
  sportId: number;
  from: string;
  to: string;
  cacheSeconds?: number;
  reserve?: number;
}): Promise<Sourced<OddsPapiFixture[]>> {
  const response = await call({
    path: '/v4/fixtures',
    params: {
      sportId: String(opts.sportId),
      from: safeParam('from', opts.from),
      to: safeParam('to', opts.to),
    },
    cacheSeconds: opts.cacheSeconds ?? FIXTURES_CACHE_SECONDS,
    ...(opts.reserve === undefined ? {} : { reserve: opts.reserve }),
  });

  const rows = firstObjectArray(response.value);
  if (rows === null) {
    throw new OddsPapiError('shape', '/v4/fixtures não devolveu lista de objetos');
  }

  // Só na resposta de REDE. Do cache, o mesmo corpo voltaria a cada ciclo e o
  // aviso viraria ruído de log — e a contagem já foi registrada quando a lista
  // chegou. É a mesma distinção que governa o `missing_at` no enricher: o que
  // se aprende sobre a fonte se aprende quando a fonte responde.
  if (response.source === 'network') {
    console.log(
      `[${COMPONENT}] /v4/fixtures ${opts.from}..${opts.to}: ${rows.length} fixture(s) da rede`,
    );

    const risk = describeTruncationRisk(rows.length, response.value);
    if (risk !== null) console.warn(`[${COMPONENT}] ${risk}`);
  }

  return {
    source: response.source,
    value: rows.map(toFixture).filter((f): f is OddsPapiFixture => f !== null),
  };
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

  // A procedência é descartada de propósito aqui, e é o único lugar onde isso é
  // certo: nada a jusante de `/v4/historical-odds` grava conclusão sobre
  // ausência. Casa que não aparece na resposta vira `coverage`, não carimbo.
  const { value: body } = await call({
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
