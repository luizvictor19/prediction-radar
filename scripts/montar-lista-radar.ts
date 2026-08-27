import type { CallResult } from './lib/probe-net.js';
import { SPACING_MS, call, callCounts, isRecord, num, section, table, totalCalls } from './lib/probe-net.js';
import { DEFAULT_PAIRING_CONFIG, extractEntities, jaccard, tokenize } from './lib/market-pairing.js';

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
const OUT_FILE = 'probes/radar/lista-candidata-v2.md';

/**
 * Tags de evento, em disco.
 *
 * Mesma razão do cache da janela: a categoria de um evento não muda entre uma
 * calibração e a seguinte, e sem cache cada ajuste de piso custaria as ~9
 * chamadas de tag de novo. Com ele, `--reuse` roda com ZERO chamadas.
 */
const TAGS_FILE = 'probes/radar/tags.json';

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
  tetoAssunto: number;
  /** Corte de tamanho de descrição que separa `tese` de `controle`. */
  cortePapel: number;
  alvoControle: number;
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
  // Piso de volume 24h. O número está justificado no relatório contra a
  // distribuição medida — e a distribuição é o argumento, não o número.
  //
  // O que ele mata, e é o defeito que ele existe para matar: "Government
  // shutdown by October 1" tinha 13 mil de liquidez e UM DÓLAR de volume em 24h.
  // Liquidez é ordem parada; volume é gente negociando. A tese é "sai notícia →
  // o preço exagera → volta", e mercado que ninguém negocia não exagera: ele
  // fica onde o último trade o deixou.
  vol24Min: 500,
  precoMin: 0.15,
  precoMax: 0.85,
  // 20 de 40 = 50%, e foi 12 na v1. Subiu porque o trabalho dele mudou de mãos.
  //
  // Na v1 o teto de categoria era a ÚNICA defesa contra monocultura, e por isso
  // era apertado. Ele defendia mal: barrava por rótulo grosso ("politics") sem
  // saber que sete daqueles mercados eram a mesma notícia sobre o Irã. Agora o
  // teto de assunto faz esse trabalho direto, e medindo: com ele em 3, manter a
  // categoria em 12 descartava 18 candidatos bons por uma razão que o teto fino
  // já cobria. Aqui ele vira o que sobrou de útil — a garantia de que UMA
  // categoria não é a lista inteira.
  tetoCategoria: 20,
  tetoEvento: 2,
  // Teto por ASSUNTO. O teto por evento não bastava: na v1 o Irã apareceu em 7
  // dos 40 sob sete `eventId` diferentes — acordo nuclear, bloqueio, reunião
  // diplomática, cessar-fogo, Ormuz. São sete eventos e UMA notícia: se o Irã
  // fecha acordo, os sete andam juntos. Contá-los como sete observações é o
  // mesmo defeito de contar dois checkpoints da mesma partida como duas
  // evidências — infla a amostra sem informar nada.
  tetoAssunto: 3,
  // Mediana da descrição no universo da janela, medida na v1. Ver `papelDe`.
  cortePapel: 975,
  alvoControle: 8,
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
      /^--(semana-min|semana-max|liq-min|vol24-min|preco-min|preco-max|teto-categoria|teto-evento|teto-assunto|corte-papel|alvo-controle|n|spread-max|max-tag-calls)=(.+)$/.exec(
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
    else if (key === 'teto-assunto') args.tetoAssunto = Math.max(1, Math.round(value));
    else if (key === 'corte-papel') args.cortePapel = Math.round(value);
    else if (key === 'alvo-controle') args.alvoControle = Math.round(value);
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
/*
 * Do MAIS específico para o mais genérico, e a ordem é o critério inteiro.
 *
 * A v1 tinha `politics` no topo e por isso rotulava "Will there be no change in
 * Fed interest rates" como política — o evento tem as duas tags, e a primeira da
 * lista ganhava. O efeito não era cosmético: inflava `politics` contra o próprio
 * teto de categoria, que então barrava mercado de economia por conta de uma
 * decisão de juros mal rotulada.
 */
const CATEGORIAS_TOPO = [
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
  'elections',
  'geopolitics',
  'politics',
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

  // Cache em disco primeiro. Tag de evento não muda entre calibrações, e sem
  // isto cada ajuste de piso pagaria as chamadas de novo — pela segunda vez, à
  // toa, contra uma API gratuita.
  const { readFile, writeFile, mkdir } = await import('node:fs/promises');
  const { dirname } = await import('node:path');
  const cache = new Map<string, string[]>();
  try {
    const bruto = JSON.parse(await readFile(TAGS_FILE, 'utf8')) as Record<string, string[]>;
    for (const [id, tags] of Object.entries(bruto)) cache.set(id, tags);
  } catch {
    // Sem cache ainda. Não é erro: a primeira passada é que o cria.
  }

  const faltam: string[] = [];
  for (const id of eventIds) {
    const tags = cache.get(id);
    if (tags === undefined) faltam.push(id);
    else mapa.set(id, categoriaDeTags(tags));
  }
  if (faltam.length === 0) {
    console.error(`[${LABEL}] tags: ${mapa.size} do cache, 0 chamadas`);
    return mapa;
  }

  for (let i = 0; i < faltam.length; i += TAG_BATCH) {
    if (calls >= maxCalls) {
      console.error(
        `[${LABEL}] AVISO: teto de ${maxCalls} chamadas de tag atingido — ` +
          `${eventIds.length - i} eventos ficaram sem categoria (viram 'sem-tag')`,
      );
      break;
    }
    const lote = faltam.slice(i, i + TAG_BATCH);
    const query = [...lote.map((id) => `id=${encodeURIComponent(id)}`), `limit=${TAG_BATCH}`].join('&');
    const res = await get('/events', query);
    calls += 1;

    for (const raw of asArray(res.body, 'events')) {
      if (!isRecord(raw)) continue;
      const tags = Array.isArray(raw['tags'])
        ? raw['tags'].filter(isRecord).map((t) => str(t['slug'])).filter((s) => s !== '')
        : [];
      cache.set(str(raw['id']), tags);
      mapa.set(str(raw['id']), categoriaDeTags(tags));
    }
  }

  await mkdir(dirname(TAGS_FILE), { recursive: true });
  await writeFile(TAGS_FILE, `${JSON.stringify(Object.fromEntries(cache))}\n`, 'utf8');
  console.error(`[${LABEL}] tags: ${mapa.size} eventos, ${calls} chamadas novas`);

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
  papel: 'tese' | 'controle';
  /** Rótulo legível do grupo de assunto. `—` quando o grupo tem um membro só. */
  assunto: string;
  /**
   * Identidade do grupo, e é ela que o teto conta — não o rótulo.
   *
   * Os dois se separaram quando o rótulo de grupo unitário virou `—`: contar
   * pelo rótulo faria TODOS os assuntos únicos serem o mesmo assunto, e o teto
   * de 3 cortaria a lista em três mercados sem par. O rótulo é para ler; o id é
   * para contar.
   */
  grupoId: number;
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
// Assunto — o agrupamento que o `eventId` não faz
// ---------------------------------------------------------------------------

const MESES_SET = new Set(MESES);

/**
 * Componentes de entidade de uma pergunta, para servirem de chave de assunto.
 *
 * `extractEntities` do gerador da spec 003 devolve nomes próprios inteiros —
 * "us-iran final nuclear deal" sai como UMA entidade. Para ligar mercados por
 * assunto isso é grosso demais: o mercado do bloqueio não repete a frase toda,
 * ele diz "Iranian". Quebrar em componentes é o que faz `iran` ser a chave
 * compartilhada em vez de uma frase que só casa consigo mesma.
 *
 * Mês e número saem: eles ligariam "September 30" com "September 30" e
 * agrupariam metade da janela por prazo comum, que não é assunto nenhum.
 */
function componentesDeAssunto(pergunta: string): Set<string> {
  const out = new Set<string>();
  for (const entidade of extractEntities(pergunta)) {
    for (const parte of entidade.split(/[\s\-]+/)) {
      // Dois caracteres entram: `US` é componente, e sem ele "US-Iran Final
      // Nuclear Deal" compartilhava só `iran` com "US-Iran meeting" — uma chave
      // só, Jaccard 0,15, e o mercado mais comprido da lista ficava fora do
      // grupo do próprio assunto. Sigla de dois é sigla, não ruído; o que
      // protege contra ruído é a regra de duas chaves, não o comprimento.
      if (parte.length < 2) continue;
      if (MESES_SET.has(parte)) continue;
      if (/^[\d.,$%]+$/.test(parte)) continue;
      out.add(parte);
    }
  }
  return out;
}

/**
 * Duas chaves são a mesma coisa dita de dois jeitos?
 *
 * Só o caso do gentílico: `russia`/`russian`, `iran`/`iranian`. Prefixo com no
 * mínimo 4 caracteres, que é onde ele para de gerar falso positivo — abaixo
 * disso `new`/`news` já casaria. Não é stemmer e não pretende ser: um stemmer
 * de verdade aqui seria mais superfície de erro do que os dois casos que ele
 * resolve.
 */
function mesmaChave(a: string, b: string): boolean {
  if (a === b) return true;
  const [curta, longa] = a.length <= b.length ? [a, b] : [b, a];
  return curta.length >= 4 && longa.startsWith(curta);
}

interface GrupoAssunto {
  /** Rótulo legível: a chave compartilhada mais frequente do grupo. */
  rotulo: string;
  membros: number[];
}

/**
 * Agrupa candidatos por assunto: união de "compartilham entidade" com
 * "são textualmente parecidos".
 *
 * Union-find sobre duas arestas possíveis. A primeira é entidade compartilhada
 * — é ela que junta o acordo nuclear com o bloqueio e com Ormuz. A segunda é
 * Jaccard sobre os tokens da pergunta, no MESMO limiar de 0,4 da camada 3 do
 * gerador da spec 003, e pega o que a entidade não pega: duas perguntas sobre a
 * mesma coisa escritas sem nome próprio em comum.
 *
 * UMA entidade compartilhada é indício, não prova, e a primeira versão disto
 * tratava como prova. O resultado foi um grupo "russia" com 13 mercados que
 * fundia a guerra na Ucrânia, a taxa do banco central russo e a eleição
 * parlamentar — três coisas que não andam juntas. Nome de país não é assunto: é
 * dimensão.
 *
 * A causa está na pergunta em Title Case. "Russia Elections: United Russia Wins
 * Every Region?" tem TODA palavra capitalizada, então `extractEntities` devolve
 * `region`, `united`, `wins`, `every` como se fossem nomes próprios — e `region`
 * ligou a eleição russa com "Regional Board Chair" da Suécia. Corte por
 * frequência não resolve isso: `russia` aparece em 5 de 44 e é legítimo no mesmo
 * patamar em que `region` é lixo.
 *
 * Então a entidade só liga acompanhada: de uma SEGUNDA entidade compartilhada,
 * ou de similaridade textual mínima. Os três números abaixo foram medidos contra
 * os casos que importam nesta janela — ver `LIGACAO_*`.
 */
/** Texto sozinho basta. Mesmo limiar da camada 3 do gerador da spec 003. */
const LIGACAO_JACCARD_FORTE = DEFAULT_PAIRING_CONFIG.textSimilarity;
/**
 * Com uma entidade só, o texto precisa concordar um pouco.
 *
 * 0,25 é onde os dois casos medidos se separam: "Iran charges Hormuz fees" e
 * "Strait of Hormuz traffic returns to normal" compartilham só `hormuz` e dão
 * 0,30 — mesmo assunto, tem que ligar. "Russia capture Kostyantynivka" e "Bank
 * of Russia key rate" compartilham só `russia` e dão 0,18 — assuntos diferentes,
 * não pode ligar.
 */
const LIGACAO_JACCARD_FRACO = 0.25;
function agruparPorAssunto(cands: readonly Candidato[]): GrupoAssunto[] {
  const n = cands.length;
  const chaves = cands.map((c) => componentesDeAssunto(c.m.question));
  const tokens = cands.map((c) => new Set(tokenize(c.m.question)));

  const pai = Array.from({ length: n }, (_, i) => i);
  const raiz = (i: number): number => {
    let r = i;
    while (pai[r] !== r) r = pai[r] as number;
    while (pai[i] !== r) [i, pai[i]] = [pai[i] as number, r];
    return r;
  };
  const unir = (a: number, b: number): void => {
    const [ra, rb] = [raiz(a), raiz(b)];
    if (ra !== rb) pai[rb] = ra;
  };

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const ci = chaves[i] as Set<string>;
      const cj = chaves[j] as Set<string>;

      let compartilhadas = 0;
      for (const a of ci) {
        for (const b of cj) {
          if (mesmaChave(a, b)) {
            compartilhadas += 1;
            break;
          }
        }
        if (compartilhadas >= 2) break;
      }

      const sim = jaccard(tokens[i] as Set<string>, tokens[j] as Set<string>);
      const liga =
        sim >= LIGACAO_JACCARD_FORTE ||
        compartilhadas >= 2 ||
        (compartilhadas === 1 && sim >= LIGACAO_JACCARD_FRACO);
      if (liga) unir(i, j);
    }
  }

  const porRaiz = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const r = raiz(i);
    const lista = porRaiz.get(r);
    if (lista === undefined) porRaiz.set(r, [i]);
    else lista.push(i);
  }

  return [...porRaiz.values()].map((membros) => {
    const contagem = new Map<string, number>();
    for (const i of membros) {
      for (const t of chaves[i] as Set<string>) contagem.set(t, (contagem.get(t) ?? 0) + 1);
    }
    const ranking = [...contagem.entries()]
      .filter(([, c]) => c > 1)
      .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
    const [melhor, segunda] = ranking;

    // Grupo de um não tem assunto compartilhado: não há com quem compartilhar.
    // Rotulá-lo com a própria pergunta truncada enchia a coluna de ruído e dava
    // ao leitor a impressão de que ali havia agrupamento.
    if (membros.length === 1) return { rotulo: '—', membros };
    // O `*` marca grupo cuja chave dominante não está em todos os membros — é
    // onde o agrupamento juntou perguntas com a mesma FORMA e assunto diferente.
    // O caso vivo: "Bank of Japan (...) September Meeting" e "Bank of Russia (...)
    // September Meeting" compartilham `bank` e `meeting` e ficam a 0,30 de
    // Jaccard. São dois bancos centrais, não um assunto — e nenhum limiar
    // separa os dois sem separar também "Hormuz" de "Hormuz", que é o par que o
    // agrupamento existe para juntar. Fica agrupado, e fica VISÍVEL que está.
    const heterogeneo = melhor !== undefined && melhor[1] < membros.length;
    if (melhor === undefined) return { rotulo: `grupo de ${membros.length}*`, membros };
    // Heterogêneo mostra as DUAS chaves mais compartilhadas. Uma chave só
    // rotulava de "russia" um grupo que continha Fed e Banco do Japão — o rótulo
    // mentia com mais confiança do que o agrupamento errava.
    const rotulo = heterogeneo && segunda !== undefined ? `${melhor[0]}+${segunda[0]}*` : melhor[0] + (heterogeneo ? '*' : '');
    return { rotulo, membros };
  });
}

// ---------------------------------------------------------------------------
// Papel: tese ou controle
// ---------------------------------------------------------------------------

/**
 * O tamanho da regra é o tamanho da superfície de interpretação.
 *
 * `tese` é onde ler com cuidado deveria dar vantagem: regra longa, com ressalva,
 * fonte nomeada, cláusula de escape. `controle` é onde ler com cuidado NÃO
 * deveria ajudar — a regra é curta porque delega a resolução a um placar:
 * resultado oficial do TSE, decisão anunciada do banco central, score final,
 * feed de preço. Não há o que ler errado.
 *
 * O corte é a mediana da descrição no universo da janela (975 caracteres). Ele
 * é grosseiro e é dito assim: separa superfície de interpretação por PROXY, não
 * por leitura. O controle existe justamente para que isso seja falseável — se a
 * vantagem aparecer igual nos dois lados, o que se achou foi sorte, e a proxy
 * (não o método) é a primeira suspeita.
 */
function papelDe(descLen: number, corte: number): 'tese' | 'controle' {
  return descLen > corte ? 'tese' : 'controle';
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
      papel: papelDe(m.description.length, args.cortePapel),
      assunto: '—',
      grupoId: -1,
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
  // Sensibilidade do piso de volume: o número escolhido é uma decisão, e uma
  // decisão sem o custo dela ao lado é um número inventado com cara de critério.
  const operaveis = naFaixa.filter((x) => x.liquidez >= args.liqMin && x.spread <= args.spreadMax);
  const qVolOper = quantis(operaveis.map((x) => x.volume24h));
  console.log(
    `\n  Volume 24h entre os ${operaveis.length} que passam liquidez e spread — ` +
      `p10 ${usd(qVolOper.p10)}, mediana ${usd(qVolOper.mediana)}, p90 ${usd(qVolOper.p90)}:\n`,
  );
  console.log(
    table(
      ['piso de volume 24h', 'sobrevivem', 'fração'],
      [0, 100, 250, 500, 1000, 2500, 5000, 10000].map((piso) => {
        const n = operaveis.filter((x) => x.volume24h >= piso).length;
        return [
          piso === args.vol24Min ? `${usd(piso)}  <- escolhido` : usd(piso),
          String(n),
          `${((100 * n) / Math.max(1, operaveis.length)).toFixed(0)}%`,
        ];
      }),
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
  // 5. Espelhos: dentro do mesmo evento, YES somando ~1 é UM mercado
  // -------------------------------------------------------------------------
  //
  // "BoJ sem mudança" a 0,27 e "BoJ +25 bps" a 0,72 somam 0,99. Julgar os dois é
  // julgar um: quem acha que 0,27 está baixo acha, pela mesma conta, que 0,72
  // está alto. Duas linhas na lista, uma opinião — e no fim uma amostra que
  // parece ter o dobro do tamanho que tem.
  //
  // O par fica com o de MAIOR volume, não com o mais comprido: a descrição dos
  // dois lados de um espelho é a mesma regra, então o desempate por tamanho
  // seria sorteio, e o volume é o que decide onde a reação aparece primeiro.
  const porEventoMercados = new Map<string, Candidato[]>();
  for (const c of passaram) {
    const k = c.m.eventId ?? c.m.id;
    const lista = porEventoMercados.get(k);
    if (lista === undefined) porEventoMercados.set(k, [c]);
    else lista.push(c);
  }

  const espelhos: Array<[Candidato, Candidato]> = [];
  const descartadosEspelho = new Set<string>();
  for (const lista of porEventoMercados.values()) {
    const ordenados = [...lista].sort((a, b) => b.volume24h - a.volume24h);
    const mantidos: Candidato[] = [];
    for (const c of ordenados) {
      const gemeo = mantidos.find((k) => {
        const soma = k.preco + c.preco;
        return soma >= 0.97 && soma <= 1.03;
      });
      if (gemeo === undefined) mantidos.push(c);
      else {
        espelhos.push([gemeo, c]);
        descartadosEspelho.add(c.m.id);
      }
    }
  }
  const semEspelho = passaram.filter((c) => !descartadosEspelho.has(c.m.id));

  console.log(section('5. Espelhos'));
  console.log(
    espelhos.length === 0
      ? '  Nenhum par com YES somando entre 0,97 e 1,03 dentro do mesmo evento.'
      : table(
          ['mantido (maior volume)', 'preço', 'descartado', 'preço', 'soma'],
          espelhos.map(([k, d]) => [
            k.m.question.slice(0, 42),
            num(k.preco),
            d.m.question.slice(0, 42),
            num(d.preco),
            num(k.preco + d.preco),
          ]),
          [0, 2],
        ),
  );
  console.log(`\n  ${descartadosEspelho.size} descartados por espelho; sobram ${semEspelho.length}`);

  // -------------------------------------------------------------------------
  // 6. Assunto
  // -------------------------------------------------------------------------
  const grupos = agruparPorAssunto(semEspelho);
  grupos.forEach((g, gi) => {
    for (const i of g.membros) {
      const c = semEspelho[i] as Candidato;
      c.assunto = g.rotulo;
      c.grupoId = gi;
    }
  });

  console.log(section('6. Assuntos'));
  console.log(`  ${grupos.length} assuntos distintos entre os ${semEspelho.length} candidatos.`);
  const multi = grupos.filter((g) => g.membros.length > 1).sort((a, b) => b.membros.length - a.membros.length);
  console.log(
    multi.length === 0
      ? '  Nenhum assunto com mais de um mercado.'
      : `\n${table(
          ['assunto', 'mercados', 'membros'],
          multi.map((g) => [
            g.rotulo,
            String(g.membros.length),
            g.membros
              .slice(0, 2)
              .map((i) => (semEspelho[i] as Candidato).m.question.slice(0, 34))
              .join(' / '),
          ]),
          [0, 2],
        )}\n\n  * = a chave do rótulo não está em todos os membros: mesma forma de pergunta,\n    assunto possivelmente diferente. Ver o comentário em \`agruparPorAssunto\`.`,
  );

  // -------------------------------------------------------------------------
  // 7. Seleção em duas trilhas, com os três tetos
  // -------------------------------------------------------------------------
  const porCategoria = new Map<string, number>();
  const porEvento = new Map<string, number>();
  const porAssunto = new Map<number, number>();
  const escolhidos: Candidato[] = [];
  let barradosCategoria = 0;
  let barradosEvento = 0;
  let barradosAssunto = 0;

  const tentar = (c: Candidato): boolean => {
    const evento = c.m.eventId ?? c.m.id;
    if ((porAssunto.get(c.grupoId) ?? 0) >= args.tetoAssunto) {
      barradosAssunto += 1;
      return false;
    }
    if ((porEvento.get(evento) ?? 0) >= args.tetoEvento) {
      barradosEvento += 1;
      return false;
    }
    if ((porCategoria.get(c.categoria) ?? 0) >= args.tetoCategoria) {
      barradosCategoria += 1;
      return false;
    }
    porAssunto.set(c.grupoId, (porAssunto.get(c.grupoId) ?? 0) + 1);
    porEvento.set(evento, (porEvento.get(evento) ?? 0) + 1);
    porCategoria.set(c.categoria, (porCategoria.get(c.categoria) ?? 0) + 1);
    escolhidos.push(c);
    return true;
  };

  // O controle entra PRIMEIRO, e por volume. Primeiro porque ele é cota, não
  // sobra: na v1 os controles eram o que restava depois de encher a lista, e o
  // que restava tinha volume zero. Por volume porque um controle que não negocia
  // não serve de comparação — ele não teria como reagir à notícia nem se a
  // leitura ajudasse.
  const controles = semEspelho.filter((c) => c.papel === 'controle').sort((a, b) => b.volume24h - a.volume24h);
  for (const c of controles) {
    if (escolhidos.length >= Math.min(args.alvoControle, args.n)) break;
    tentar(c);
  }
  // A tese entra por tamanho de descrição, que é a proxy da spec.
  const teses = semEspelho.filter((c) => c.papel === 'tese').sort((a, b) => b.descLen - a.descLen);
  for (const c of teses) {
    if (escolhidos.length >= args.n) break;
    tentar(c);
  }

  // Sobrou vaga e ainda há controle? Ele NÃO entra.
  //
  // O controle é cota, não enchimento — e esta é a lição da v1 escrita ao
  // contrário. Lá a lista completava 40 com o que sobrava; aqui completar com
  // controle daria 12 num alvo de 8, e o que se ganharia era comprimento. O
  // braço de comparação não fica melhor por ser maior que o braço comparado, e
  // uma lista de 30 honesta vale mais que 34 com quatro linhas de enchimento.

  const daTese = escolhidos.filter((c) => c.papel === 'tese');
  const doControle = escolhidos.filter((c) => c.papel === 'controle');
  const medianaVol = (lista: readonly Candidato[]): number => quantis(lista.map((c) => c.volume24h)).mediana;

  console.log(section('7. Seleção'));
  console.log(
    table(
      ['categoria', 'escolhidos', 'disponíveis'],
      [...porCategoria.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([k, v]) => [k, String(v), String(semEspelho.filter((c) => c.categoria === k).length)]),
      [0],
    ),
  );
  console.log(
    `\n  ${escolhidos.length} de ${args.n} preenchidos — ` +
      `teto de ${args.tetoAssunto}/assunto barrou ${barradosAssunto}, ` +
      `${args.tetoEvento}/evento barrou ${barradosEvento}, ` +
      `${args.tetoCategoria}/categoria barrou ${barradosCategoria}.`,
  );
  console.log(
    `  ${new Set(escolhidos.map((c) => c.m.eventId)).size} eventos distintos, ` +
      `${new Set(escolhidos.map((c) => c.grupoId)).size} assuntos distintos.`,
  );
  console.log(
    table(
      ['papel', 'escolhidos', 'disponíveis', 'volume 24h mediano'],
      [
        ['tese', String(daTese.length), String(semEspelho.filter((c) => c.papel === 'tese').length), usd(medianaVol(daTese))],
        [
          'controle',
          String(doControle.length),
          String(semEspelho.filter((c) => c.papel === 'controle').length),
          usd(medianaVol(doControle)),
        ],
      ],
      [0],
    ),
  );
  if (doControle.length < args.alvoControle) {
    console.log(
      `\n  AVISO: ${doControle.length} controles, alvo era ${args.alvoControle}. Não afrouxei o piso de volume\n` +
        '  para completar: controle que não negocia não serve de comparação, que é a razão de ele existir.',
    );
  }
  if (escolhidos.length < args.n) {
    console.log(
      `  AVISO: a janela não tem ${args.n} mercados que passem nos filtros E caibam nos tetos.\n` +
        '  Isso é resultado, não falha: o universo operável de 4–8 semanas é mais estreito que a lista pedida.\n' +
        '  Afrouxar teto ou piso é decisão de quem aprova, e o custo de afrouxar está no funil acima.',
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

    // A ordem da SAÍDA não é a ordem da seleção. O controle é escolhido primeiro
    // (é cota, e por volume), mas quem lê a lista quer ver a tese primeiro, do
    // mais comprido para o mais curto — é a ordem em que a proxy fala.
    const ordenados = [
      ...daTese.sort((a, b) => b.descLen - a.descLen),
      ...doControle.sort((a, b) => b.volume24h - a.volume24h),
    ];

    const linhas = ordenados.map((c, i) => {
      const link =
        c.m.eventSlug === null || c.m.eventSlug === ''
          ? `https://polymarket.com/market/${c.m.slug}`
          : `https://polymarket.com/event/${c.m.eventSlug}/${c.m.slug}`;
      const celulas = [
        String(i + 1),
        c.papel,
        c.m.question.replace(/\|/g, '\\|'),
        `**${usd(c.volume24h)}**`,
        c.assunto,
        c.categoria,
        num(c.preco),
        usd(c.liquidez),
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
      '# Radar: lista candidata v2',
      '',
      `Preços lidos em ${coletadaEm} por \`scripts/montar-lista-radar.ts\`. **Nada foi marcado ` +
        'como `tracked`**: a lista existe para ser aprovada, e marcar é escrita no banco (H4).',
      '',
      '## Como ela foi montada',
      '',
      `- Mercados **abertos** (\`closed=false, active=true, archived=false\`) com \`endDate\` entre ` +
        `${dia(de)} e ${dia(ate)} (${args.semanaMin} a ${args.semanaMax} dias).`,
      `- Preço do YES entre ${args.precoMin} e ${args.precoMax}.`,
      `- Liquidez ≥ ${usd(args.liqMin)} USD e **volume 24h ≥ ${usd(args.vol24Min)} USD**.` +
        (args.book ? `  Book de dois lados com spread ≤ ${args.spreadMax}.` : '  Sanidade de book DESLIGADA.'),
      `- Espelhos removidos: dentro do mesmo evento, dois mercados com YES somando 0,97–1,03 são um só. ` +
        `Caíram ${descartadosEspelho.size}.`,
      `- Tetos: ${args.tetoAssunto} por assunto, ${args.tetoEvento} por evento, ${args.tetoCategoria} por categoria. ` +
        `${new Set(escolhidos.map((c) => c.grupoId)).size} assuntos e ` +
        `${new Set(escolhidos.map((c) => c.m.eventId)).size} eventos distintos.`,
      '',
      '## Os dois papéis',
      '',
      `**tese** (${daTese.length}, volume mediano ${usd(medianaVol(daTese))}), regra acima de ${args.cortePapel} ` +
        'caracteres: ressalva, fonte nomeada, cláusula de escape. É onde ler com cuidado deveria dar vantagem.',
      '',
      `**controle** (${doControle.length}, volume mediano ${usd(medianaVol(doControle))}), regra curta porque ` +
        'delega a resolução a um placar: resultado oficial, decisão anunciada, score final, feed de preço. ' +
        'Ler com atenção não deveria ajudar. Se a vantagem aparecer igual nos dois lados, o que se achou foi ' +
        'sorte, não leitura: é para isso que o controle está aqui, e ele passa no mesmo piso de volume.',
      '',
      `Universo da janela: ${universo.length} mercados. Passaram nos filtros: ${passaram.length}. ` +
        `Depois de espelho e tetos: ${escolhidos.length}. ` +
        `Mediana da descrição: ${qUniverso.mediana} (universo) → ${qEscolhidos.mediana} (escolhidos), ${num(razao)}×; ` +
        `${acimaDaMediana} dos ${escolhidos.length} estão acima da mediana do universo.`,
      '',
      '## Os mercados',
      '',
      '| # | papel | pergunta | **vol 24h** | assunto | categoria | preço | liquidez | prazo | desc | link |',
      '| --- | --- | --- | ---: | --- | --- | ---: | ---: | --- | ---: | --- |',
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
