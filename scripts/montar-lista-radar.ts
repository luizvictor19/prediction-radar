import type { CallResult } from './lib/probe-net.js';
import { SPACING_MS, call, callCounts, isRecord, num, section, table, totalCalls } from './lib/probe-net.js';

/**
 * Lista candidata do radar — a frente que troca prever por vigiar.
 *
 * A tese: o mercado precifica a MANCHETE e resolve pela REGRA, e a diferença
 * entre as duas é onde se opera. Isso põe o texto da regra no centro, e é por
 * isso que a ordenação final é por tamanho de `description` — proxy grosseira de
 * "regra complicada", que é onde se lê errado.
 *
 * O que esta sonda faz: escolhe 40 mercados para o dono aprovar. O que ela NÃO
 * faz, de propósito: não marca `tracked`, não escreve no banco, não cria coletor,
 * não chama modelo nenhum. Marcar é decisão de quem lê a lista.
 *
 * ZERO Supabase — este arquivo não importa `src/lib/supabase.js` e não carrega
 * dotenv: sem credencial não há como escrever por engano. A única rede é a Gamma,
 * que é pública e gratuita.
 *
 * ## Uso
 *
 *   npm run radar:lista -- --dry-run     # dimensiona a janela e para
 *   npm run radar:lista                  # confere o prazo, filtra, escreve o .md
 *   npm run radar:lista -- --reuse       # recalibra sobre a janela em disco
 *   npm run radar:lista -- --liq-min=25000 --teto-categoria=8 --teto-evento=1
 *   npm run radar:lista -- --sem-book    # desliga a sanidade de book
 */

const LABEL = 'radar-lista';

const GAMMA = process.env['POLYMARKET_GAMMA_URL'] ?? 'https://gamma-api.polymarket.com';
const OUT_FILE = 'probes/radar/lista-candidata.md';

/**
 * A janela coletada, em disco.
 *
 * Baixar a janela custa ~80 requisições e 56 MB de uma API gratuita, e o que
 * muda entre uma rodada e a seguinte é o PISO que se escolhe, não o universo.
 * Sem cache, mexer no piso de liquidez custaria outra varredura inteira — foi o
 * que o `strata.json` da sonda do universo resolveu, e o motivo é o mesmo.
 *
 * O que ele NÃO é: fonte para decidir. Preço envelhece em minutos, e a lista
 * final sai de uma coleta fresca. `--reuse` existe para calibrar filtro.
 */
const CACHE_FILE = 'probes/radar/janela.json';

/** `limit` satura em 100 por página — medido na sonda do universo, não documentado. */
const PAGE = 100;

/**
 * Teto DURO de `offset`: 2000. Acima disso a Gamma devolve 422 com um corpo JSON
 * que um leitor desatento confunde com "acabou a lista". Herdado de
 * `probe-polymarket-universe.ts`, onde custou uma contagem inteira para aparecer.
 */
const OFFSET_CEILING = 2000;

/** Filtro de "mercado aberto de verdade": ativo, não fechado, não arquivado. */
const OPEN_FILTER = { closed: 'false', active: 'true', archived: 'false' } as const;

const DIA_MS = 24 * 60 * 60 * 1000;

/** Quantos ids de evento cabem numa chamada de `/events` — repetição do parâmetro. */
const TAG_BATCH = 20;

/** Trava contra bissecção descontrolada se a Gamma mudar de comportamento. */
const MAX_JANELAS = 40;

// ---------------------------------------------------------------------------
// Flags
// ---------------------------------------------------------------------------

interface Args {
  dryRun: boolean;
  /** Início da janela de prazo, em dias a partir de agora. */
  semanaMin: number;
  semanaMax: number;
  liqMin: number;
  vol24Min: number;
  precoMin: number;
  precoMax: number;
  tetoCategoria: number;
  tetoEvento: number;
  n: number;
  /** Exige book de dois lados. Ver `sanidadeDeBook`. */
  book: boolean;
  spreadMax: number;
  write: boolean;
  maxTagCalls: number;
  /** Calibra filtro sobre a janela já baixada, sem tocar a rede. Ver `CACHE_FILE`. */
  reuse: boolean;
}

const DEFAULTS: Args = {
  dryRun: false,
  semanaMin: 28,
  semanaMax: 56,
  // Piso de liquidez: 5.000 USD, e não um número inventado — é o mesmo
  // `analyst_min_liquidity_usd` que o sistema já usa para decidir que um mercado
  // vale gastar análise. Reaproveitar a régua existente vale mais do que inventar
  // uma segunda — e a distribuição impressa abaixo mostra onde ela cai.
  liqMin: 5_000,
  vol24Min: 0,
  precoMin: 0.15,
  precoMax: 0.85,
  // 12 de 40 = 30%: nenhum tema passa de um terço da lista. Não dá para ser
  // muito mais apertado — a janela de 4–8 semanas só tem ~7 categorias grossas,
  // e um teto de 5 travaria a lista em 35 por aritmética, não por critério.
  tetoCategoria: 12,
  tetoEvento: 2,
  n: 40,
  book: true,
  spreadMax: 0.1,
  write: true,
  maxTagCalls: 40,
  reuse: false,
};

function parseArgs(argv: readonly string[]): Args | { error: string } {
  const args: Args = { ...DEFAULTS };

  for (const arg of argv) {
    if (arg === '--dry-run') {
      args.dryRun = true;
      continue;
    }
    if (arg === '--no-write') {
      args.write = false;
      continue;
    }
    if (arg === '--sem-book') {
      args.book = false;
      continue;
    }
    if (arg === '--reuse') {
      args.reuse = true;
      continue;
    }

    const match =
      /^--(semana-min|semana-max|liq-min|vol24-min|preco-min|preco-max|teto-categoria|teto-evento|n|spread-max|max-tag-calls)=(.+)$/.exec(
        arg,
      );
    if (match === null) return { error: `argumento desconhecido: ${arg}` };

    const [, key = '', raw = ''] = match;
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0) return { error: `--${key}=${raw} precisa ser >= 0` };

    if (key === 'semana-min') args.semanaMin = value;
    else if (key === 'semana-max') args.semanaMax = value;
    else if (key === 'liq-min') args.liqMin = value;
    else if (key === 'vol24-min') args.vol24Min = value;
    else if (key === 'preco-min') args.precoMin = value;
    else if (key === 'preco-max') args.precoMax = value;
    else if (key === 'teto-categoria') args.tetoCategoria = Math.max(1, Math.round(value));
    else if (key === 'teto-evento') args.tetoEvento = Math.max(1, Math.round(value));
    else if (key === 'n') args.n = Math.max(1, Math.round(value));
    else if (key === 'spread-max') args.spreadMax = value;
    else args.maxTagCalls = Math.round(value);
  }

  if (args.semanaMin >= args.semanaMax) return { error: '--semana-min precisa ser menor que --semana-max' };
  return args;
}

// ---------------------------------------------------------------------------
// Payload da Gamma (só o que esta sonda lê)
// ---------------------------------------------------------------------------

interface GammaMarket {
  id: string;
  question: string;
  slug: string;
  description: string;
  endDate: string | null;
  outcomePrices: string;
  liquidityNum: number | null;
  volume24hr: number | null;
  volume24hrClob: number | null;
  bestBid: number | null;
  bestAsk: number | null;
  spread: number | null;
  lastTradePrice: number | null;
  acceptingOrders: boolean;
  enableOrderBook: boolean;
  hasReviewedDates: boolean;
  umaResolutionStatuses: string;
  eventId: string | null;
  eventSlug: string | null;
  eventTitle: string | null;
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function numOrNull(value: unknown): number | null {
  const n = typeof value === 'string' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}

function asArray(body: unknown, key: string): unknown[] {
  if (Array.isArray(body)) return body;
  if (isRecord(body) && Array.isArray(body[key])) return body[key] as unknown[];
  return [];
}

/**
 * A Gamma OMITE campo nulo ou zerado em vez de mandar `null`.
 *
 * Vale dizer porque muda a leitura de `volume24hr`: ausente não é "não existe o
 * campo", é "não houve volume". Uma versão anterior desta sonda concluiu que o
 * endpoint `/events` não trazia volume de 24h — trazia, mas a fatia amostrada era
 * de mercados de 2027 sem negócio nenhum.
 */
function toMarket(raw: unknown): GammaMarket | null {
  if (!isRecord(raw)) return null;
  const evento = Array.isArray(raw['events']) && isRecord(raw['events'][0]) ? raw['events'][0] : null;

  return {
    id: str(raw['id']),
    question: str(raw['question']),
    slug: str(raw['slug']),
    description: str(raw['description']),
    endDate: typeof raw['endDate'] === 'string' ? raw['endDate'] : null,
    outcomePrices: str(raw['outcomePrices']),
    liquidityNum: numOrNull(raw['liquidityNum']),
    volume24hr: numOrNull(raw['volume24hr']),
    volume24hrClob: numOrNull(raw['volume24hrClob']),
    bestBid: numOrNull(raw['bestBid']),
    bestAsk: numOrNull(raw['bestAsk']),
    spread: numOrNull(raw['spread']),
    lastTradePrice: numOrNull(raw['lastTradePrice']),
    acceptingOrders: raw['acceptingOrders'] === true,
    enableOrderBook: raw['enableOrderBook'] === true,
    hasReviewedDates: raw['hasReviewedDates'] === true,
    umaResolutionStatuses: str(raw['umaResolutionStatuses']),
    eventId: evento === null ? null : str(evento['id']),
    eventSlug: evento === null ? null : str(evento['slug']),
    eventTitle: evento === null ? null : str(evento['title']),
  };
}

/** `outcomePrices` vem como STRING de JSON, não como array. */
function parseJsonArray(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map((v) => String(v)) : [];
  } catch {
    return [];
  }
}

let bytesDownloaded = 0;

async function get(path: string, params: Record<string, string> | string): Promise<CallResult> {
  const query = typeof params === 'string' ? params : new URLSearchParams(params).toString();
  const res = await call(`${GAMMA}${path}?${query}`, 'gamma');
  bytesDownloaded += res.bytes;
  if (res.status !== 200) throw new Error(`Gamma HTTP ${res.status} em ${path} — ${res.text.slice(0, 160)}`);
  return res;
}

// ---------------------------------------------------------------------------
// Datas
// ---------------------------------------------------------------------------

function iso(at: number): string {
  return new Date(at).toISOString();
}

function dia(value: string | null): string {
  return value === null ? '—' : value.slice(0, 10);
}

const MESES = [
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
];

/**
 * Todas as datas "Month D, YYYY" de um texto, em epoch UTC.
 *
 * As regras da Polymarket são escritas em inglês e datam o prazo por extenso —
 * "between July 3, 2025, and December 31, 2026, 11:59 PM ET". É a única fonte de
 * prazo INDEPENDENTE do campo `endDate`, e é o que permite conferir um contra o
 * outro em vez de acreditar no campo.
 */
function datasDoTexto(texto: string): number[] {
  const encontradas: number[] = [];
  const re = /\b(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\b/gi;

  for (const m of texto.matchAll(re)) {
    const mes = MESES.indexOf((m[1] ?? '').toLowerCase());
    const dia = Number(m[2]);
    const ano = Number(m[3]);
    if (mes < 0 || !Number.isInteger(dia) || !Number.isInteger(ano)) continue;
    encontradas.push(Date.UTC(ano, mes, dia));
  }
  return encontradas;
}

/**
 * `endDate` está ancorado em ALGUMA data que a regra nomeia?
 *
 * Esta é a pergunta certa, e a primeira versão desta sonda fez a errada. Ela
 * comparava `endDate` com a MAIOR data do texto e concluía que 2309 de 3201
 * mercados se desmentiam. Não se desmentiam: a maior data costuma ser a cláusula
 * de escape, não o prazo. A regra da eleição brasileira diz
 *
 *   "A presidential election is scheduled to take place in Brazil on October 4,
 *    2026. (...) If the result of this election isn't known by June 30, 2027,
 *    (...) the market will resolve to 'Other'."
 *
 * e `endDate` é 2026-10-04 — a data do EVENTO, não a do backstop. Comparar com o
 * máximo transformava concordância em contradição, e teria descartado a metade
 * mais bem datada do universo.
 *
 * Devolve o desvio, em dias, para a data citada mais próxima de `endDate`.
 */
function ancoraNoTexto(texto: string, endDate: number): number | null {
  const datas = datasDoTexto(texto);
  if (datas.length === 0) return null;
  let melhor = Infinity;
  for (const d of datas) {
    const delta = Math.round((endDate - d) / DIA_MS);
    if (Math.abs(delta) < Math.abs(melhor)) melhor = delta;
  }
  return melhor;
}

/** A última data que a regra nomeia — o limite externo dela, backstop incluído. */
function limiteExternoDoTexto(texto: string): number | null {
  const datas = datasDoTexto(texto);
  return datas.length === 0 ? null : Math.max(...datas);
}

// ---------------------------------------------------------------------------
// Coleta
// ---------------------------------------------------------------------------

async function paginaJanela(from: string, to: string, offset: number): Promise<GammaMarket[]> {
  const res = await get('/markets', {
    ...OPEN_FILTER,
    limit: String(PAGE),
    offset: String(offset),
    end_date_min: from,
    end_date_max: to,
  });
  return asArray(res.body, 'markets')
    .map(toMarket)
    .filter((m): m is GammaMarket => m !== null);
}

async function existeEm(from: string, to: string, offset: number): Promise<boolean> {
  const res = await get('/markets', {
    ...OPEN_FILTER,
    limit: '1',
    offset: String(offset),
    end_date_min: from,
    end_date_max: to,
  });
  return asArray(res.body, 'markets').length > 0;
}

/**
 * Conta EXATO os mercados de uma fatia, ou `null` se ela satura o teto de offset.
 *
 * Busca binária sobre `offset` com respostas de `limit=1` (~7 KB). Uma sondagem
 * em `OFFSET_CEILING` decide antes se a fatia é grande demais — 1 requisição em
 * vez das 11 da busca inteira. Mesma mecânica de `countSlice` na sonda do
 * universo; está aqui de novo porque lá ela é interna e específica do calendário.
 */
async function contarFatia(from: string, to: string): Promise<number | null> {
  if (!(await existeEm(from, to, 0))) return 0;
  if (await existeEm(from, to, OFFSET_CEILING)) return null;

  let low = 0;
  let high = OFFSET_CEILING;
  while (high - low > 1) {
    const mid = Math.floor((low + high) / 2);
    if (await existeEm(from, to, mid)) low = mid;
    else high = mid;
  }
  return low + 1;
}

/**
 * Pagina uma fatia inteira, partindo em duas se ela estourar o teto de offset.
 *
 * Cortar por data é a única saída: sem endpoint de contagem e com `offset`
 * limitado a 2000, uma fatia saturada é invisível pela metade — e o silêncio
 * pareceria "a janela tem 2000 mercados".
 */
async function coletarJanela(from: string, to: string, janelas: { n: number }): Promise<GammaMarket[]> {
  if (janelas.n >= MAX_JANELAS) {
    console.error(`[${LABEL}] AVISO: teto de ${MAX_JANELAS} sub-janelas atingido; fatia ${from}..${to} NÃO coletada`);
    return [];
  }
  janelas.n += 1;

  const out: GammaMarket[] = [];
  for (let offset = 0; offset <= OFFSET_CEILING - PAGE; offset += PAGE) {
    const pagina = await paginaJanela(from, to, offset);
    out.push(...pagina);
    if (pagina.length < PAGE) return out;
  }

  // Saiu do laço com todas as páginas cheias: a fatia satura. Parte no meio.
  const meio = iso(Math.floor((Date.parse(from) + Date.parse(to)) / 2));
  if (meio === from || meio === to) {
    console.error(`[${LABEL}] AVISO: fatia ${from}..${to} satura e não dá para partir; lista incompleta`);
    return out;
  }
  console.error(`[${LABEL}] fatia ${from}..${to} saturou o offset — partindo em ${meio}`);
  const [a, b] = [await coletarJanela(from, meio, janelas), await coletarJanela(meio, to, janelas)];
  return [...a, ...b];
}

// ---------------------------------------------------------------------------
// Categoria — vem das tags do EVENTO, que `/markets` não embute
// ---------------------------------------------------------------------------

/**
 * Ordem de prioridade das tags de topo.
 *
 * A Gamma devolve tags de granularidades misturadas — `["politics","brazil",
 * "global-elections","world"]` — e o teto por categoria precisa operar no nível
 * GROSSO. Se o rótulo fosse a tag mais específica, quarenta mercados da eleição
 * brasileira entrariam sob `brazil`, `global-elections` e `main-election` como se
 * fossem três temas, e a monocultura passaria pelo teto sem encostar nele.
 */
const CATEGORIAS_TOPO = [
  'politics',
  'geopolitics',
  'elections',
  'crypto',
  'economy',
  'business',
  'tech',
  'ai',
  'science',
  'health',
  'climate',
  'weather',
  'sports',
  'esports',
  'culture',
  'pop-culture',
  'entertainment',
  'world',
];

function categoriaDeTags(tags: readonly string[]): string {
  for (const topo of CATEGORIAS_TOPO) {
    if (tags.includes(topo)) return topo;
  }
  return tags[0] ?? 'sem-tag';
}

async function buscarTags(eventIds: readonly string[], maxCalls: number): Promise<Map<string, string>> {
  const mapa = new Map<string, string>();
  let calls = 0;

  for (let i = 0; i < eventIds.length; i += TAG_BATCH) {
    if (calls >= maxCalls) {
      console.error(
        `[${LABEL}] AVISO: teto de ${maxCalls} chamadas de tag atingido — ` +
          `${eventIds.length - i} eventos ficaram sem categoria (viram 'sem-tag')`,
      );
      break;
    }
    const lote = eventIds.slice(i, i + TAG_BATCH);
    const query = [...lote.map((id) => `id=${encodeURIComponent(id)}`), `limit=${TAG_BATCH}`].join('&');
    const res = await get('/events', query);
    calls += 1;

    for (const raw of asArray(res.body, 'events')) {
      if (!isRecord(raw)) continue;
      const tags = Array.isArray(raw['tags'])
        ? raw['tags'].filter(isRecord).map((t) => str(t['slug'])).filter((s) => s !== '')
        : [];
      mapa.set(str(raw['id']), categoriaDeTags(tags));
    }
  }

  return mapa;
}

// ---------------------------------------------------------------------------
// Filtros
// ---------------------------------------------------------------------------

interface Candidato {
  m: GammaMarket;
  preco: number;
  liquidez: number;
  volume24h: number;
  descLen: number;
  /** Distância em dias entre `endDate` e a data citada mais próxima na regra. */
  desvioPrazo: number | null;
  categoria: string;
}

/**
 * Preço do YES, com o book como testemunha.
 *
 * `outcomePrices[0]` é o que a Gamma publica, e o que a tela mostra. Mas o
 * projeto já se queimou com preço de livro vazio: a média de bid e ask num book
 * sem nenhum dos dois dá 0,50 por aritmética, não por consenso, e 0,50 cai bem no
 * meio da faixa 0,15–0,85 que este filtro usa. Por isso o preço vem do campo
 * publicado e a SANIDADE vem do book — separados, para que um livro vazio seja
 * descartado em vez de virar candidato mediano.
 */
function precoYes(m: GammaMarket): number | null {
  const precos = parseJsonArray(m.outcomePrices).map(Number);
  const p = precos[0];
  if (typeof p === 'number' && Number.isFinite(p) && p > 0 && p < 1) return p;
  return m.lastTradePrice !== null && m.lastTradePrice > 0 && m.lastTradePrice < 1 ? m.lastTradePrice : null;
}

function sanidadeDeBook(m: GammaMarket): boolean {
  const { bestBid: bid, bestAsk: ask } = m;
  if (bid === null || ask === null) return false;
  return bid > 0 && ask < 1 && ask > bid;
}

// ---------------------------------------------------------------------------
// Relatório
// ---------------------------------------------------------------------------

function quantis(valores: readonly number[]): { n: number; p10: number; mediana: number; media: number; p90: number } {
  const ord = [...valores].sort((a, b) => a - b);
  const q = (p: number): number => ord[Math.min(ord.length - 1, Math.max(0, Math.floor(p * ord.length)))] ?? 0;
  const media = ord.length === 0 ? 0 : ord.reduce((s, v) => s + v, 0) / ord.length;
  return { n: ord.length, p10: q(0.1), mediana: q(0.5), media, p90: q(0.9) };
}

function usd(v: number): string {
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(0)}k`;
  return v.toFixed(0);
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  if ('error' in parsed) {
    console.error(`[${LABEL}] ${parsed.error}`);
    process.exit(1);
  }
  const args = parsed;

  const agora = Date.now();
  const de = iso(agora + args.semanaMin * DIA_MS);
  const ate = iso(agora + args.semanaMax * DIA_MS);

  console.log(section(`Radar — lista candidata (${LABEL})`));
  console.log(`  agora:   ${iso(agora)}`);
  console.log(`  janela:  ${de} .. ${ate}  (${args.semanaMin}–${args.semanaMax} dias)`);
  console.log(`  espaço:  ${SPACING_MS} ms entre chamadas, host único (gamma)\n`);

  // -------------------------------------------------------------------------
  // 0. Dimensionar ANTES de paginar
  // -------------------------------------------------------------------------
  if (args.reuse) {
    const { readFile } = await import('node:fs/promises');
    const cache = JSON.parse(await readFile(CACHE_FILE, 'utf8')) as { coletadaEm: string; mercados: GammaMarket[] };
    console.log(section('0. Janela reaproveitada do disco'));
    console.log(`  ${CACHE_FILE} — ${cache.mercados.length} mercados, coletada em ${cache.coletadaEm}`);
    console.log('  ZERO chamadas de coleta. Preço envelheceu: serve para calibrar filtro, não para decidir.');
    await relatorio(args, cache.mercados, agora, de, ate, cache.coletadaEm);
    return;
  }

  const total = await contarFatia(de, ate);
  const paginas = total === null ? null : Math.ceil(total / PAGE);
  console.log(section('0. Dimensionamento da janela'));
  console.log(
    total === null
      ? `  A janela satura o teto de offset (>${OFFSET_CEILING}). Vai precisar ser partida por data.`
      : `  ${total} mercados abertos com endDate na janela → ${String(paginas)} páginas de ${PAGE}.`,
  );
  console.log(`  Chamadas gastas até aqui: ${totalCalls()}`);

  if (args.dryRun) {
    console.log(
      `\n  --dry-run: para aqui. Estimativa para a rodada completa: ` +
        `~${(paginas ?? 20) + 12} chamadas de coleta + até ${args.maxTagCalls} de categoria.`,
    );
    console.log(section('Chamadas'));
    console.log(table(['host', 'chamadas'], callCounts().map(([h, n]) => [h, String(n)])));
    return;
  }

  // -------------------------------------------------------------------------
  // 1. Coleta
  // -------------------------------------------------------------------------
  const brutos = await coletarJanela(de, ate, { n: 0 });
  const universo = [...new Map(brutos.map((m) => [m.id, m])).values()];
  console.log(section('1. Coleta'));
  console.log(`  ${universo.length} mercados abertos na janela (${brutos.length - universo.length} duplicatas)`);

  const { mkdir, writeFile } = await import('node:fs/promises');
  const { dirname } = await import('node:path');
  await mkdir(dirname(CACHE_FILE), { recursive: true });
  await writeFile(
    CACHE_FILE,
    `${JSON.stringify({ coletadaEm: iso(agora), janela: { de, ate }, mercados: universo })}\n`,
    'utf8',
  );
  console.log(`  cache: ${CACHE_FILE} — use --reuse para calibrar filtro sem gastar chamada`);

  await relatorio(args, universo, agora, de, ate, iso(agora));
}

/**
 * Tudo que é decisão sobre a janela já baixada: conferência do prazo, filtros,
 * categoria, seleção e a lista.
 *
 * Separado da coleta porque calibrar um piso não pode custar 56 MB de uma API
 * pública. Nada aqui toca a rede, exceto a busca de tags — que é proporcional ao
 * que sobreviveu aos filtros, não ao universo.
 */
async function relatorio(
  args: Args,
  universo: readonly GammaMarket[],
  agora: number,
  de: string,
  ate: string,
  /** Quando os PREÇOS foram lidos — com `--reuse` não é agora. */
  coletadaEm: string,
): Promise<void> {
  // -------------------------------------------------------------------------
  // 2. O que `endDate` significa — conferido, não suposto
  // -------------------------------------------------------------------------
  console.log(section('2. Conferência do campo de prazo'));

  let ancorados = 0;
  let semData = 0;
  let alemDoLimite = 0;
  const desvios: number[] = [];

  for (const m of universo) {
    if (m.endDate === null) continue;
    const texto = `${m.question}\n${m.description}`;
    const fim = Date.parse(m.endDate);
    const desvio = ancoraNoTexto(texto, fim);
    if (desvio === null) {
      semData += 1;
      continue;
    }
    desvios.push(Math.abs(desvio));
    // ±1 dia absorve a virada de meia-noite em ET: "by December 31" vira
    // `endDate` no dia seguinte às 04:00/05:00Z, e é o mesmo prazo.
    if (Math.abs(desvio) <= 1) ancorados += 1;
    const limite = limiteExternoDoTexto(texto);
    if (limite !== null && fim - limite > 2 * DIA_MS) alemDoLimite += 1;
  }

  const comData = universo.length - semData;
  const vencidos = universo.filter((m) => m.endDate !== null && Date.parse(m.endDate) < agora);
  const revisados = universo.filter((m) => m.hasReviewedDates).length;
  const pct = (n: number, de: number): string => `${n} (${((100 * n) / Math.max(1, de)).toFixed(0)}%)`;

  console.log(
    table(
      ['medida', 'valor'],
      [
        ['mercados na janela', String(universo.length)],
        ['com alguma data por extenso na regra', pct(comData, universo.length)],
        ['endDate coincide com uma data citada na regra (±1d)', pct(ancorados, comData)],
        ['endDate DEPOIS do limite externo da regra (>2d) — suspeito', pct(alemDoLimite, comData)],
        ['hasReviewedDates = true', pct(revisados, universo.length)],
        ['endDate já vencido (na janela futura, tem de ser 0)', String(vencidos.length)],
      ],
      [0],
    ),
  );

  console.log('\n  Dez maiores liquidez da janela — para conferir contra calendário conhecido:');
  const conhecidos = [...universo]
    .sort((a, b) => (b.liquidityNum ?? 0) - (a.liquidityNum ?? 0))
    .slice(0, 10)
    .map((m) => {
      const texto = `${m.question}\n${m.description}`;
      const desvio = m.endDate === null ? null : ancoraNoTexto(texto, Date.parse(m.endDate));
      const limite = limiteExternoDoTexto(texto);
      return [
        m.question.slice(0, 52),
        dia(m.endDate),
        desvio === null ? '—' : `${desvio > 0 ? '+' : ''}${desvio}d`,
        limite === null ? '—' : dia(iso(limite)),
        usd(m.liquidityNum ?? 0),
      ];
    });
  console.log(
    table(['pergunta', 'endDate', 'desvio p/ data citada', 'backstop da regra', 'liquidez'], conhecidos, [0]),
  );

  // -------------------------------------------------------------------------
  // 3. Filtros
  // -------------------------------------------------------------------------
  const quedas = new Map<string, number>();
  const cai = (motivo: string): void => {
    quedas.set(motivo, (quedas.get(motivo) ?? 0) + 1);
  };

  const passaram: Candidato[] = [];
  const naFaixa: Array<{ liquidez: number; volume24h: number; spread: number }> = [];
  for (const m of universo) {
    if (m.endDate === null || Date.parse(m.endDate) < agora) {
      cai('endDate ausente ou vencido');
      continue;
    }
    if (!m.acceptingOrders || !m.enableOrderBook) {
      cai('não aceita ordem / sem book');
      continue;
    }
    const preco = precoYes(m);
    if (preco === null) {
      cai('sem preço utilizável');
      continue;
    }
    if (preco < args.precoMin || preco > args.precoMax) {
      cai(`preço fora de ${args.precoMin}–${args.precoMax}`);
      continue;
    }
    // A partir daqui o mercado é negociável e está na faixa de preço. É este o
    // conjunto contra o qual o piso de liquidez tem de ser justificado — medir a
    // distribuição sobre o universo inteiro misturaria mercado morto de 2 dólares
    // com o que se pretende vigiar, e qualquer piso pareceria generoso.
    const liquidez = m.liquidityNum ?? 0;
    const volume24h = m.volume24hr ?? m.volume24hrClob ?? 0;
    naFaixa.push({ liquidez, volume24h, spread: (m.bestAsk ?? 1) - (m.bestBid ?? 0) });

    if (args.book && !sanidadeDeBook(m)) {
      cai('book de um lado só (ou invertido)');
      continue;
    }
    if (args.book && (m.bestAsk ?? 1) - (m.bestBid ?? 0) > args.spreadMax) {
      cai(`spread > ${args.spreadMax}`);
      continue;
    }
    if (liquidez < args.liqMin) {
      cai(`liquidez < ${args.liqMin}`);
      continue;
    }
    if (volume24h < args.vol24Min) {
      cai(`volume 24h < ${args.vol24Min}`);
      continue;
    }
    // O único caso em que o campo de prazo se DESMENTE: `endDate` cai depois do
    // limite externo que a própria regra nomeia — inclusive o backstop. Não é a
    // comparação com a maior data (essa é a normal, e é o backstop); é `endDate`
    // ultrapassando até ela.
    const texto = `${m.question}\n${m.description}`;
    const limite = limiteExternoDoTexto(texto);
    if (limite !== null && Date.parse(m.endDate) - limite > 2 * DIA_MS) {
      cai('endDate posterior ao limite externo da regra');
      continue;
    }

    passaram.push({
      m,
      preco,
      liquidez,
      volume24h,
      descLen: m.description.length,
      desvioPrazo: ancoraNoTexto(texto, Date.parse(m.endDate)),
      categoria: 'sem-tag',
    });
  }

  console.log(section('3. Filtros'));
  console.log(
    table(
      ['motivo da queda', 'mercados'],
      [...quedas.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => [k, String(v)]),
      [0],
    ),
  );

  const qLiq = quantis(naFaixa.map((x) => x.liquidez));
  const qVol = quantis(naFaixa.map((x) => x.volume24h));
  const qSpr = quantis(naFaixa.map((x) => x.spread));
  console.log(`\n  Distribuição entre os ${naFaixa.length} mercados negociáveis na faixa de preço —`);
  console.log('  é contra ela que o piso de liquidez e o teto de spread se justificam:\n');
  console.log(
    table(
      ['medida', 'p10', 'mediana', 'média', 'p90'],
      [
        ['liquidez USD', usd(qLiq.p10), usd(qLiq.mediana), usd(qLiq.media), usd(qLiq.p90)],
        ['volume 24h USD', usd(qVol.p10), usd(qVol.mediana), usd(qVol.media), usd(qVol.p90)],
        ['spread', num(qSpr.p10, 3), num(qSpr.mediana, 3), num(qSpr.media, 3), num(qSpr.p90, 3)],
      ],
      [0],
    ),
  );
  console.log(`\n  sobreviveram: ${passaram.length}`);

  // -------------------------------------------------------------------------
  // 4. Categoria — só para quem passou, e do mais comprido para o mais curto
  // -------------------------------------------------------------------------
  passaram.sort((a, b) => b.descLen - a.descLen);
  const eventIds = [...new Set(passaram.map((c) => c.m.eventId).filter((id): id is string => id !== null && id !== ''))];
  const tags = await buscarTags(eventIds, args.maxTagCalls);
  for (const c of passaram) c.categoria = tags.get(c.m.eventId ?? '') ?? 'sem-tag';

  // -------------------------------------------------------------------------
  // 5. Seleção com teto por categoria
  // -------------------------------------------------------------------------
  const porCategoria = new Map<string, number>();
  const porEvento = new Map<string, number>();
  const escolhidos: Candidato[] = [];
  let barradosCategoria = 0;
  let barradosEvento = 0;

  for (const c of passaram) {
    if (escolhidos.length >= args.n) break;
    // O teto por EVENTO vem primeiro porque é onde a monocultura mora de fato.
    // A eleição brasileira é UM evento com 32 mercados — um por candidato — e as
    // descrições deles são a mesma regra com o nome trocado. Sem este teto, a
    // ordenação por tamanho de descrição enfileira os 32 juntos e entrega uma
    // lista que parece variada por categoria e é uma pergunta só.
    const evento = c.m.eventId ?? c.m.id;
    if ((porEvento.get(evento) ?? 0) >= args.tetoEvento) {
      barradosEvento += 1;
      continue;
    }
    if ((porCategoria.get(c.categoria) ?? 0) >= args.tetoCategoria) {
      barradosCategoria += 1;
      continue;
    }
    porEvento.set(evento, (porEvento.get(evento) ?? 0) + 1);
    porCategoria.set(c.categoria, (porCategoria.get(c.categoria) ?? 0) + 1);
    escolhidos.push(c);
  }

  console.log(section('4. Seleção'));
  console.log(
    table(
      ['categoria', 'escolhidos', 'disponíveis'],
      [...porCategoria.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([k, v]) => [k, String(v), String(passaram.filter((c) => c.categoria === k).length)]),
      [0],
    ),
  );
  console.log(
    `\n  ${escolhidos.length} de ${args.n} preenchidos — ` +
      `teto de ${args.tetoEvento}/evento barrou ${barradosEvento}, ` +
      `teto de ${args.tetoCategoria}/categoria barrou ${barradosCategoria}, ` +
      `${new Set(escolhidos.map((c) => c.m.eventId)).size} eventos distintos.`,
  );
  if (escolhidos.length < args.n) {
    console.log(
      `  AVISO: a janela não tem ${args.n} mercados que passem nos filtros E caibam nos tetos.\n` +
        '  Isso é resultado, não falha: significa que o universo operável de 4–8 semanas é mais estreito\n' +
        '  do que a lista pedida. Afrouxar teto ou piso é decisão de quem aprova.',
    );
  }

  // -------------------------------------------------------------------------
  // 6. A proxy discriminou?
  // -------------------------------------------------------------------------
  const qUniverso = quantis(universo.map((m) => m.description.length));
  const qPassaram = quantis(passaram.map((c) => c.descLen));
  const qEscolhidos = quantis(escolhidos.map((c) => c.descLen));

  console.log(section('5. Tamanho da descrição — escolhidos contra o universo'));
  console.log(
    table(
      ['conjunto', 'n', 'p10', 'mediana', 'média', 'p90'],
      [
        ['universo da janela', qUniverso.n, qUniverso.p10, qUniverso.mediana, Math.round(qUniverso.media), qUniverso.p90],
        ['passaram nos filtros', qPassaram.n, qPassaram.p10, qPassaram.mediana, Math.round(qPassaram.media), qPassaram.p90],
        ['os escolhidos', qEscolhidos.n, qEscolhidos.p10, qEscolhidos.mediana, Math.round(qEscolhidos.media), qEscolhidos.p90],
      ].map((r) => r.map(String)),
      [0],
    ),
  );
  const razao = qUniverso.mediana === 0 ? 0 : qEscolhidos.mediana / qUniverso.mediana;
  console.log(
    `\n  mediana dos escolhidos / mediana do universo = ${num(razao)}×` +
      (razao < 1.3
        ? '  → a proxy NÃO discriminou. A ordenação por tamanho não achou regra mais complicada;\n' +
          '    trocou de conjunto por outro parecido. Vale dizer em voz alta em vez de fingir.'
        : '  → a proxy discriminou.'),
  );

  // -------------------------------------------------------------------------
  // 7. Saída
  // -------------------------------------------------------------------------
  if (args.write) {
    const { mkdir, writeFile } = await import('node:fs/promises');
    const { dirname } = await import('node:path');

    const linhas = escolhidos.map((c, i) => {
      const link =
        c.m.eventSlug === null || c.m.eventSlug === ''
          ? `https://polymarket.com/market/${c.m.slug}`
          : `https://polymarket.com/event/${c.m.eventSlug}/${c.m.slug}`;
      const celulas = [
        String(i + 1),
        c.m.question.replace(/\|/g, '\\|'),
        c.categoria,
        num(c.preco),
        usd(c.liquidez),
        usd(c.volume24h),
        dia(c.m.endDate),
        String(c.descLen),
        `[abrir](${link})`,
      ];
      return `| ${celulas.join(' | ')} |`;
    });

    // Quantos dos escolhidos têm regra mais comprida que a mediana do universo.
    // É a leitura honesta da proxy: ela ordena, mas a lista tem 40 vagas e os
    // tetos empurram para dentro dela o que sobrou, não o que é comprido.
    const acimaDaMediana = escolhidos.filter((c) => c.descLen > qUniverso.mediana).length;

    const md = [
      '# Radar — lista candidata',
      '',
      `Preços lidos em ${coletadaEm} por \`scripts/montar-lista-radar.ts\`. **Nada foi marcado ` +
        'como `tracked`** — a lista existe para ser aprovada, e marcar é escrita no banco (H4).',
      '',
      '## Como ela foi montada',
      '',
      `- Mercados **abertos** (\`closed=false, active=true, archived=false\`) com \`endDate\` entre ` +
        `${dia(de)} e ${dia(ate)} — ${args.semanaMin} a ${args.semanaMax} dias.`,
      `- Preço do YES entre ${args.precoMin} e ${args.precoMax}.`,
      `- Liquidez ≥ ${usd(args.liqMin)} USD.` +
        (args.book ? `  Book de dois lados com spread ≤ ${args.spreadMax}.` : '  Sanidade de book DESLIGADA.'),
      `- Descartados os mercados cujo \`endDate\` cai depois do limite externo que a própria regra nomeia.`,
      `- Ordenados por tamanho da \`description\`, com teto de ${args.tetoCategoria} por categoria e ` +
        `${args.tetoEvento} por evento — ${new Set(escolhidos.map((c) => c.m.eventId)).size} eventos distintos.`,
      '',
      `Universo da janela: ${universo.length} mercados. Passaram nos filtros: ${passaram.length}. ` +
        `Mediana da descrição: ${qUniverso.mediana} (universo) → ${qEscolhidos.mediana} (escolhidos), ${num(razao)}×.`,
      '',
      `**Onde a proxy para de discriminar.** ${acimaDaMediana} dos ${escolhidos.length} têm regra mais comprida ` +
        `que a mediana do universo (${qUniverso.mediana} caracteres); os outros ${escolhidos.length - acimaDaMediana} ` +
        'entraram porque as vagas sobraram depois dos tetos, não porque a regra deles seja complicada. ' +
        'O topo da lista é onde a tese vive; a cauda é preenchimento, e vale ler como tal.',
      '',
      '## Os mercados',
      '',
      '| # | pergunta | categoria | preço | liquidez | vol 24h | prazo | desc | link |',
      '| --- | --- | --- | ---: | ---: | ---: | --- | ---: | --- |',
      ...linhas,
      '',
    ].join('\n');

    await mkdir(dirname(OUT_FILE), { recursive: true });
    await writeFile(OUT_FILE, md, 'utf8');
    console.log(`\n  escrito: ${OUT_FILE} (${escolhidos.length} mercados)`);
  }

  console.log(section('Chamadas'));
  console.log(table(['host', 'chamadas'], callCounts().map(([h, n]) => [h, String(n)]), [0]));
  console.log(`\n  total: ${totalCalls()} chamadas, ${(bytesDownloaded / 1024 / 1024).toFixed(1)} MB`);
}

await main();
