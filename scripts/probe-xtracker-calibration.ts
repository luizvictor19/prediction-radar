import 'dotenv/config';

/**
 * Sonda do XTracker — fase 2: o mercado erra a cauda?
 *
 * A fase 1 respondeu que os dados existem. Esta mede uma coisa só, e sem modelo
 * nenhum: **as faixas baratas aconteceram mais vezes do que o preço delas dizia?**
 *
 * Nada de Poisson, nada de binomial negativa, nada de ajustar distribuição. A
 * dispersão de 27,8x da fase 1 prova que um modelo simples subestimaria a cauda —
 * não prova que o MERCADO usa modelo simples. Traders veem a mesma variância. Ler
 * uma propriedade do dado como se fosse preço errado foi exatamente como o
 * candidato C2 morreu.
 *
 * SÓ LEITURA, e nem banco: não toca Supabase, não escreve tabela, não roda
 * migration. Nenhuma chamada à OddsPapi. Não altera `src/` — importa
 * `src/eval/metrics.ts` para reaproveitar o desenho de calibração, e só.
 *
 * ## Uso
 *
 *   npm run xtracker:calib -- --dry-run     # dimensiona antes de puxar série
 *   npm run xtracker:calib                  # passada completa (~13 min)
 *   npm run xtracker:calib -- --markets=20  # amostra menor, para iterar
 *   npm run xtracker:calib -- --self-test   # confere as guardas, sem rede
 */

import {
  SPACING_MS,
  call,
  callCounts,
  isRecord,
  num,
  section,
  table,
  totalCalls,
  unwrap,
  writeSnapshot,
} from './lib/probe-net.js';

import {
  BIN_ASK,
  BIN_PRICE,
  type Bin as BinShape,
  type BinPoint,
  type BinState,
  type EdgeBucket,
  MIN_MATCHES_FOR_BUCKET,
  PRICE_EDGES,
  bucketGap,
  bucketIndex,
  bucketLabel,
  distinctMarkets,
  edgeBuckets,
  impliedMoments,
  mean,
  median,
  type InstantRow,
  PRICE_SUM_MAX,
  PRICE_SUM_MIN,
  coherentPoints,
  quarter,
  regimeRows,
  splitByMarketTime,
  standardDeviation,
  zScore,
} from './lib/calibration.js';

const LABEL = 'probe-xtracker-calib';

const XTRACKER = 'https://xtracker.polymarket.com/api';
const GAMMA = process.env['POLYMARKET_GAMMA_URL'] ?? 'https://gamma-api.polymarket.com';
const CLOB = 'https://clob.polymarket.com';
const DATA_API = 'https://data-api.polymarket.com';

const SNAPSHOT_DIR = 'probes/xtracker';

const GAMMA_PAGE = 100;
const MAX_GAMMA_PAGES = 14;
const TWEET_TAG_ID = '972';

/**
 * Fidelidade pedida ao CLOB, em minutos.
 *
 * A fase 1 mediu 10 min e concluiu que o servidor ignora o parâmetro. Medido de
 * novo aqui com `fidelity=1` sobre mercado de novembro/2025: passo de 60 s,
 * 1560 pontos numa janela de 26 h. Ou seja, ele NÃO ignora — a fase 1 testou num
 * mercado cujo book era raso. Pedir 1 custa o mesmo e entrega o dobro de
 * resolução onde ela existe.
 */
const CLOB_FIDELITY = 1;

/**
 * Quanto o ponto de preço pode estar longe do instante pedido, em segundos.
 *
 * A série ativa anda de 60 em 60 s, então 30 min é folga de 30x — generosa de
 * propósito, porque faixa de cauda tem book que esvazia e volta. A distribuição
 * do atraso de fato usado é impressa; se ela encostar no teto, o teto está
 * mentindo e a tabela avisa.
 */
const PRICE_TOLERANCE_SECONDS = 1800;

/** Duração da janela de contagem por série, quando não há tracking para juntar. */
const SERIES_WINDOW_HOURS: Record<string, number> = {
  'elon-tweets': 168,
  'elon-tweets-48h': 48,
};

/** Tolerância do casamento tracking ↔ evento pelo fechamento. Medido: 59 s de folga. */
const TRACKING_JOIN_SECONDS = 120;

/** Trades por página no data-api. Medido: aceita 1000. */
const TRADE_PAGE = 1000;
const MAX_TRADE_PAGES = 3;

/** Janela em torno do instante para colher trades, em segundos. */
const TRADE_WINDOW_SECONDS = 3 * 3600;

// ---------------------------------------------------------------------------
// Flags
// ---------------------------------------------------------------------------

interface Args {
  handle: string;
  /** Instantes de observação, em horas antes do fechamento. */
  offsets: number[];
  /** Teto de mercados (os mais recentes). 0 = todos. */
  markets: number;
  /** Quantas faixas baratas sondar com trades históricos na medida C. */
  tradeSamples: number;
  dryRun: boolean;
  selfTest: boolean;
  write: boolean;
}

const DEFAULTS: Args = {
  handle: 'elonmusk',
  offsets: [48, 24],
  markets: 0,
  tradeSamples: 120,
  dryRun: false,
  selfTest: false,
  write: true,
};

function parseArgs(argv: readonly string[]): Args | { error: string } {
  const args: Args = { ...DEFAULTS, offsets: [...DEFAULTS.offsets] };

  for (const arg of argv) {
    if (arg === '--no-write') {
      args.write = false;
      continue;
    }
    if (arg === '--dry-run') {
      args.dryRun = true;
      continue;
    }
    if (arg === '--self-test') {
      args.selfTest = true;
      continue;
    }

    const match = /^--(handle|markets|offsets|trade-samples)=(.+)$/.exec(arg);
    if (match === null) return { error: `argumento desconhecido: ${arg}` };
    const [, key, raw = ''] = match;

    if (key === 'handle') {
      args.handle = raw;
      continue;
    }
    if (key === 'offsets') {
      const parsed = raw.split(',').map(Number);
      if (parsed.some((v) => !Number.isFinite(v) || v <= 0)) {
        return { error: `--offsets=${raw} precisa ser uma lista de horas > 0` };
      }
      args.offsets = parsed;
      continue;
    }

    const value = Number(raw);
    if (!Number.isInteger(value) || value < 0) {
      return { error: `--${key}=${raw} precisa ser um inteiro >= 0` };
    }
    if (key === 'markets') args.markets = value;
    else args.tradeSamples = value;
  }

  return args;
}

// ---------------------------------------------------------------------------
// Gamma
// ---------------------------------------------------------------------------

interface GammaMarket {
  question: string;
  conditionId: string;
  closed: boolean;
  outcomePrices: string[];
  clobTokenIds: string[];
  bestBid: number | null;
  bestAsk: number | null;
}

interface GammaEvent {
  id: string;
  slug: string;
  title: string;
  closed: boolean;
  startDate: string | null;
  endDate: string | null;
  seriesSlug: string | null;
  markets: GammaMarket[];
}

function parseJsonArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value !== 'string') return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function asNumber(value: unknown): number | null {
  const n = Number(value);
  return typeof value !== 'undefined' && value !== null && Number.isFinite(n) ? n : null;
}

function asEvents(body: unknown): GammaEvent[] {
  if (!Array.isArray(body)) return [];

  return body.flatMap((row) => {
    if (!isRecord(row)) return [];
    const series = row['series'];
    const seriesSlug =
      Array.isArray(series) && isRecord(series[0]) ? String(series[0]['slug'] ?? '') : null;

    const markets = Array.isArray(row['markets'])
      ? row['markets'].flatMap((m): GammaMarket[] =>
          isRecord(m)
            ? [
                {
                  question: String(m['question'] ?? ''),
                  conditionId: String(m['conditionId'] ?? ''),
                  closed: m['closed'] === true,
                  outcomePrices: parseJsonArray(m['outcomePrices']),
                  clobTokenIds: parseJsonArray(m['clobTokenIds']),
                  bestBid: asNumber(m['bestBid']),
                  bestAsk: asNumber(m['bestAsk']),
                },
              ]
            : [],
        )
      : [];

    return [
      {
        id: String(row['id'] ?? ''),
        slug: String(row['slug'] ?? ''),
        title: String(row['title'] ?? ''),
        closed: row['closed'] === true,
        startDate: typeof row['startDate'] === 'string' ? row['startDate'] : null,
        endDate: typeof row['endDate'] === 'string' ? row['endDate'] : null,
        seriesSlug,
        markets,
      },
    ];
  });
}

async function loadTweetEvents(): Promise<{ events: GammaEvent[]; truncated: boolean }> {
  const events: GammaEvent[] = [];

  for (let page = 0; page < MAX_GAMMA_PAGES; page += 1) {
    const offset = page * GAMMA_PAGE;
    const res = await call(
      `${GAMMA}/events?tag_id=${TWEET_TAG_ID}&limit=${GAMMA_PAGE}&offset=${offset}`,
      'gamma',
    );
    const batch = asEvents(res.body);
    events.push(...batch);
    if (batch.length < GAMMA_PAGE) return { events, truncated: false };
  }

  return { events, truncated: true };
}

const isCountMarket = (e: GammaEvent): boolean =>
  /#\s*tweets|#\s*posts/i.test(e.title) && !/mention/i.test(e.title);

// ---------------------------------------------------------------------------
// Faixas
// ---------------------------------------------------------------------------

interface Bin {
  question: string;
  from: number;
  to: number | null;
  yes: boolean;
  tokenId: string | null;
  conditionId: string;
}

function parseBins(event: GammaEvent): { bins: Bin[]; unparsed: number } {
  const bins: Bin[] = [];
  let unparsed = 0;

  for (const market of event.markets) {
    const yes = market.outcomePrices[0] === '1';
    const tokenId = market.clobTokenIds[0] ?? null;
    const common = { question: market.question, yes, tokenId, conditionId: market.conditionId };

    const range = /post (\d+)-(\d+) (?:tweets|posts)/i.exec(market.question);
    const below = /post <(\d+) (?:tweets|posts)/i.exec(market.question);
    const above = /post (\d+)\+ (?:tweets|posts)/i.exec(market.question);

    if (range !== null) bins.push({ ...common, from: Number(range[1]), to: Number(range[2]) });
    else if (below !== null) bins.push({ ...common, from: 0, to: Number(below[1]) - 1 });
    else if (above !== null) bins.push({ ...common, from: Number(above[1]), to: null });
    else unparsed += 1;
  }

  bins.sort((a, b) => a.from - b.from);
  return { bins, unparsed };
}

function coverageBroken(bins: readonly Bin[]): boolean {
  for (let i = 0; i + 1 < bins.length; i += 1) {
    const current = bins[i];
    const next = bins[i + 1];
    if (current === undefined || next === undefined || current.to === null) continue;
    if (next.from !== current.to + 1) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// A janela de contagem
// ---------------------------------------------------------------------------

interface Tracking {
  title: string;
  startMs: number;
  endMs: number;
}

/**
 * De onde sai o início da janela de contagem — e por que NÃO do Gamma.
 *
 * `event.startDate` do Gamma é o instante de CRIAÇÃO do mercado, não o começo da
 * contagem: o evento "august-4-august-11" tem `startDate` 2026-08-01 e conta a
 * partir de 2026-08-04T16:00Z. Usar o campo do Gamma acrescentaria três dias de
 * posts à contagem acumulada de cada instante — o erro apareceria como "faixa
 * baixa impossível" em faixa que ainda estava viva, e passaria despercebido.
 *
 * A fonte certa é o tracking do XTracker, que é o que resolve o mercado. Ele casa
 * com o evento pelo FECHAMENTO (delta medido: no máximo 59 s). Para os 17 eventos
 * sem tracking, a duração da série serve de recurso — medido: `elon-tweets` são
 * 168 h e `elon-tweets-48h` são 48 h, sem exceção nos 163 que casaram. A série
 * `elon-tweet-daily` NÃO tem duração fixa (48 h, 721 h e 744 h aparecem juntas),
 * então sem tracking ela é descartada em vez de chutada.
 */
function windowStart(
  event: GammaEvent,
  endMs: number,
  trackings: readonly Tracking[],
): { startMs: number; source: 'tracking' | 'serie' } | null {
  let best: Tracking | null = null;
  let bestDelta = Number.POSITIVE_INFINITY;
  for (const tracking of trackings) {
    const delta = Math.abs(tracking.endMs - endMs);
    if (delta < bestDelta) {
      bestDelta = delta;
      best = tracking;
    }
  }
  if (best !== null && bestDelta <= TRACKING_JOIN_SECONDS * 1000) {
    return { startMs: best.startMs, source: 'tracking' };
  }

  const hours = SERIES_WINDOW_HOURS[event.seriesSlug ?? ''];
  if (hours === undefined) return null;
  return { startMs: endMs - hours * 3600_000, source: 'serie' };
}

// ---------------------------------------------------------------------------
// Preço
// ---------------------------------------------------------------------------

interface PricePoint {
  t: number;
  p: number;
}

function asHistory(body: unknown): PricePoint[] {
  const history = isRecord(body) ? body['history'] : null;
  if (!Array.isArray(history)) return [];

  return history.flatMap((row) => {
    if (!isRecord(row)) return [];
    const t = Number(row['t']);
    const p = Number(row['p']);
    return Number.isFinite(t) && Number.isFinite(p) ? [{ t, p }] : [];
  });
}

/** O ponto mais próximo do instante, ou `null` se o mais próximo estiver longe demais. */
function pickNearest(
  history: readonly PricePoint[],
  atSeconds: number,
  toleranceSeconds: number,
): PricePoint | null {
  let best: PricePoint | null = null;
  let bestDelta = Number.POSITIVE_INFINITY;

  for (const point of history) {
    const delta = Math.abs(point.t - atSeconds);
    if (delta < bestDelta) {
      bestDelta = delta;
      best = point;
    }
  }

  return bestDelta <= toleranceSeconds ? best : null;
}

// ---------------------------------------------------------------------------
// Posts
// ---------------------------------------------------------------------------

function asPostTimes(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  const times = value.flatMap((row) => {
    if (!isRecord(row)) return [];
    const createdAt = row['createdAt'];
    if (typeof createdAt !== 'string') return [];
    const ms = new Date(createdAt).getTime();
    return Number.isFinite(ms) ? [ms] : [];
  });
  return times.sort((a, b) => a - b);
}

/** Quantos posts em `[lo, hi]`. Busca binária: chamada ~7000 vezes. */
function countBetween(sorted: readonly number[], lo: number, hi: number): number {
  return lowerBound(sorted, hi + 1) - lowerBound(sorted, lo);
}

function lowerBound(sorted: readonly number[], value: number): number {
  let low = 0;
  let high = sorted.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if ((sorted[mid] ?? Number.POSITIVE_INFINITY) < value) low = mid + 1;
    else high = mid;
  }
  return low;
}

// ---------------------------------------------------------------------------
// Trades — a medida C
// ---------------------------------------------------------------------------

interface Trade {
  /** Preço já convertido para o lado YES da faixa. */
  yesPrice: number;
  /** Lado do TOMADOR, já convertido para o lado YES. BUY paga o ask. */
  side: 'BUY' | 'SELL';
  timestamp: number;
}

/**
 * Os trades de uma faixa, com o lado NO convertido para YES.
 *
 * Um taker que COMPRA "No" a 0,97 é, exatamente, um taker que VENDE "Yes" a 0,03:
 * mesmo book, mesma travessia, sinal trocado. Jogar fora os trades de "No"
 * descartaria metade da evidência, e num mercado de cauda — onde quase todo o
 * volume está do lado "No", que é o lado caro — descartaria justamente a metade
 * que existe.
 */
function asTrades(body: unknown): Trade[] {
  if (!Array.isArray(body)) return [];

  return body.flatMap((row) => {
    if (!isRecord(row)) return [];
    const price = Number(row['price']);
    const timestamp = Number(row['timestamp']);
    const side = row['side'] === 'BUY' ? 'BUY' : row['side'] === 'SELL' ? 'SELL' : null;
    const outcome = String(row['outcome'] ?? '');
    if (!Number.isFinite(price) || !Number.isFinite(timestamp) || side === null) return [];

    const isYes = /^yes$/i.test(outcome);
    return [
      {
        yesPrice: isYes ? price : 1 - price,
        side: isYes ? side : side === 'BUY' ? 'SELL' : 'BUY',
        timestamp,
      },
    ];
  });
}

// ---------------------------------------------------------------------------
// Self-test das guardas
// ---------------------------------------------------------------------------

function selfTest(): string[] {
  const out: string[] = [];
  let failures = 0;

  const check = (name: string, ok: boolean, detail = ''): void => {
    if (!ok) failures += 1;
    out.push(`  ${ok ? 'ok  ' : 'FALHA'} ${name}${detail === '' ? '' : ` — ${detail}`}`);
  };

  const point = (marketSlug: string, closeAt: string, price: number, outcome: 0 | 1): BinPoint => ({
    marketSlug,
    matchSlug: marketSlug,
    seriesSlug: 'elon-tweets',
    question: 'q',
    closeAt,
    openAt: closeAt,
    offsetHours: 48,
    observedAt: closeAt,
    from: 0,
    to: 10,
    price,
    priceLagSeconds: 0,
    countSoFar: 0,
    hoursLeft: 48,
    state: 'viva',
    outcome,
    halfSpread: 0.01,
  });

  // Guarda 2: nenhum mercado atravessa o corte.
  const split = splitByMarketTime([
    point('a', '2026-01-01T00:00:00Z', 0.1, 0),
    point('a', '2026-01-01T00:00:00Z', 0.2, 1),
    point('b', '2026-02-01T00:00:00Z', 0.1, 0),
    point('c', '2026-03-01T00:00:00Z', 0.1, 1),
    point('d', '2026-04-01T00:00:00Z', 0.1, 0),
  ]);
  const olderIds = new Set(split.older.map((p) => p.marketSlug));
  const newerIds = new Set(split.newer.map((p) => p.marketSlug));
  const overlap = [...olderIds].filter((id) => newerIds.has(id));
  check('corte temporal por mercado: interseção vazia', overlap.length === 0, `${overlap.length}`);
  check(
    'corte temporal: as duas linhas do mercado "a" ficam do mesmo lado',
    split.older.filter((p) => p.marketSlug === 'a').length === 2,
  );

  // Guarda 1: o balde conta MERCADOS, não linhas.
  const inflated = edgeBuckets(
    Array.from({ length: 26 }, (_, i) =>
      point('um-so-mercado', '2026-01-01T00:00:00Z', 0.03, i === 0 ? 1 : 0),
    ),
    BIN_PRICE,
  );
  check(
    'balde conta mercados distintos, não linhas',
    inflated[0]?.n === 26 && inflated[0]?.distinctMarkets === 1,
    `n=${inflated[0]?.n} mercados=${inflated[0]?.distinctMarkets}`,
  );

  /**
   * O bootstrap agrupado tem que SEGUIR a correlação dentro do mercado — nos dois
   * sentidos, e o segundo caso é o que esta amostra de fato tem.
   *
   * O reflexo é dizer "agrupar alarga o intervalo". Alarga quando as linhas do
   * mesmo grupo concordam: mercado que resolve tudo YES ou tudo NÃO carrega uma
   * evidência só, e tratar as 20 linhas como 20 infla a precisão.
   *
   * Só que a estrutura DESTES mercados é a oposta. Exatamente uma faixa do evento
   * resolve YES, então as faixas são ANTIcorrelacionadas: saber que a 20–39 ganhou
   * é saber que as outras 25 perderam. Aí o número de acertos por mercado é quase
   * fixo, a variância entre mercados é menor que a binomial, e o intervalo
   * agrupado fica mais ESTREITO — legitimamente.
   *
   * Os dois casos são verificados porque um bootstrap que só alarga estaria
   * ignorando o agrupamento e acertando por acaso na metade das vezes.
   */
  const widthOf = (buckets: readonly EdgeBucket[]): number => {
    const bucket = buckets[0];
    return bucket === undefined ? 0 : (bucket.ciHigh - bucket.ciLow) / 2;
  };
  const naiveHalfWidth = (rate: number, n: number): number =>
    1.96 * Math.sqrt((rate * (1 - rate)) / n);

  // Concordância dentro do mercado: metade dos mercados resolve TUDO YES.
  const agreeing = edgeBuckets(
    Array.from({ length: 10 }, (_, m) =>
      Array.from({ length: 20 }, () => point(`m${m}`, '2026-01-01T00:00:00Z', 0.5, m < 5 ? 1 : 0)),
    ).flat(),
    BIN_PRICE,
  );
  check(
    'linhas que CONCORDAM dentro do mercado: agrupar alarga o intervalo',
    widthOf(agreeing) > naiveHalfWidth(0.5, 200),
    `agrupado ±${num(widthOf(agreeing), 4)} vs ingênuo ±${num(naiveHalfWidth(0.5, 200), 4)}`,
  );

  // A estrutura real: exatamente uma faixa por mercado resolve YES.
  const exclusive = edgeBuckets(
    Array.from({ length: 10 }, (_, m) =>
      Array.from({ length: 20 }, (_, i) =>
        point(`m${m}`, '2026-01-01T00:00:00Z', 0.05, i === 0 ? 1 : 0),
      ),
    ).flat(),
    BIN_PRICE,
  );
  check(
    'exatamente uma faixa YES por mercado: agrupar estreita, e está certo',
    widthOf(exclusive) < naiveHalfWidth(0.05, 200),
    `agrupado ±${num(widthOf(exclusive), 4)} vs ingênuo ±${num(naiveHalfWidth(0.05, 200), 4)}`,
  );

  // As bordas: cada preço no balde certo, e o teto entra no último.
  check('bucketIndex(0.019) = <2¢', bucketIndex(0.019, PRICE_EDGES) === 0);
  check('bucketIndex(0.02) = 2–5¢', bucketIndex(0.02, PRICE_EDGES) === 1);
  check(
    'bucketIndex(1) cai no último balde',
    bucketIndex(1, PRICE_EDGES) === PRICE_EDGES.length - 2,
  );

  // Medida B: faixa morta entra com zero, não como ausência.
  const bins: BinShape[] = [
    { from: 0, to: 19, price: 0.9, state: 'morta' },
    { from: 20, to: 39, price: 0.5, state: 'viva' },
    { from: 40, to: null, price: 0.5, state: 'viva' },
  ];
  const moments = impliedMoments(bins);
  check(
    'faixa morta não entra na distribuição implícita',
    moments !== null && Math.abs(moments.priceSum - 1) < 1e-9,
    `soma=${num(moments?.priceSum ?? Number.NaN, 4)}`,
  );
  check(
    'média implícita ignora a faixa morta',
    moments !== null && Math.abs(moments.mean - (0.5 * 29.5 + 0.5 * 50)) < 1e-6,
    `média=${num(moments?.mean ?? Number.NaN, 3)}`,
  );

  // O z: mercado calibrado em largura dá desvio 1.
  const zs = [-1, 0, 1, -1, 1].map((z) => z);
  check('desvio-padrão amostral confere', Math.abs((standardDeviation(zs) ?? 0) - 1) < 1e-9);

  // O preço de travessia nunca é menor que o mid, e some sem estimativa.
  check('BIN_ASK soma meio spread', BIN_ASK(point('a', '2026-01-01T00:00:00Z', 0.03, 0)) === 0.04);
  check(
    'BIN_ASK é null sem estimativa de spread',
    BIN_ASK({ ...point('a', '2026-01-01T00:00:00Z', 0.03, 0), halfSpread: null }) === null,
  );

  out.push('', failures === 0 ? '  TODAS AS GUARDAS PASSARAM.' : `  ${failures} FALHA(S).`);
  return out;
}

/**
 * O recorte que separa "o mercado erra" de "eu observei na hora errada".
 *
 * A medida A do conjunto todo esconde de onde o desvio vem. Este bloco abre por
 * série e por instante, escolhe o recorte com o maior viés que EXCLUI zero, e
 * aplica nele as mesmas guardas 2 e 3 — porque um viés que só existe numa metade
 * do calendário, ou que cresce monotonicamente junto com a deriva da taxa-base,
 * é mineração de dados por mais forte que pareça no total.
 */
function regimeSection(instants: readonly InstantRow[]): string[] {
  const { bySeries, strongest, strongestSplit } = regimeRows(instants);

  const row = (s: {
    label: string;
    n: number;
    meanZ: number;
    ciLow: number;
    ciHigh: number;
    sdZ: number;
    priceSum: number;
  }): string[] => [
    s.label,
    String(s.n),
    (s.meanZ > 0 ? '+' : '') + num(s.meanZ, 3),
    `[${num(s.ciLow, 3)}; ${num(s.ciHigh, 3)}]`,
    num(s.sdZ, 3),
    num(s.priceSum, 4),
    s.n < MIN_MATCHES_FOR_BUCKET
      ? `poucos (<${MIN_MATCHES_FOR_BUCKET})`
      : s.ciLow > 0 || s.ciHigh < 0
        ? 'exclui zero'
        : '—',
  ];

  const lines = [
    section('DE ONDE VEM O DESVIO — série x instante, e as guardas em cima dele'),
    'Média de z por recorte. z negativo = a contagem real ficou ABAIXO da média que',
    'os preços implicavam; positivo = acima. Zero dentro do intervalo = sem viés.',
    '',
    table(
      ['recorte', 'n', 'média z', 'IC 95%', 'desvio z', 'soma preços', 'veredito'],
      bySeries.map(row),
      [0, 3, 6],
    ),
  ];

  if (strongest === null) {
    lines.push(
      '',
      '  Nenhum recorte tem viés médio que exclua zero. Não há candidato a perseguir.',
    );
    return lines;
  }

  lines.push(
    '',
    `  O recorte mais forte é ${strongest.label} (média z ${num(strongest.meanZ, 3)}).`,
    '  As mesmas guardas, aplicadas SÓ nele:',
    '',
    table(
      ['recorte', 'n', 'média z', 'IC 95%', 'desvio z', 'soma preços', 'veredito'],
      strongestSplit.map(row),
      [0, 3, 6],
    ),
    '',
    '  Se o viés aparece só na metade recente e cresce trimestre a trimestre, ele',
    '  não é uma distorção estável de preço: é o mercado atrasado em relação a uma',
    '  taxa-base que está caindo. Apostar nisso é apostar que a queda continua — o',
    '  que é uma opinião sobre o Elon, não sobre o mercado, e é o oposto do que',
    '  esta frente foi procurar.',
  );

  return lines;
}

// ---------------------------------------------------------------------------

interface MarketRecord {
  event: GammaEvent;
  bins: Bin[];
  openMs: number;
  closeMs: number;
  windowSource: 'tracking' | 'serie';
  finalCount: number;
  yesBin: Bin;
}

type DiscardReason =
  | 'sem_faixa_nao_lida'
  | 'cobertura_furada'
  | 'sem_faixa_yes'
  | 'sem_janela_de_contagem'
  | 'janela_antes_do_historico'
  | 'sem_token';

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if ('error' in args) {
    console.error(`[${LABEL}] ${args.error}`);
    console.error(
      `[${LABEL}] uso: npm run xtracker:calib -- [--dry-run] [--markets=N] ` +
        `[--offsets=48,24] [--trade-samples=N] [--self-test] [--no-write]`,
    );
    process.exit(1);
    return;
  }

  const out: string[] = [
    'SONDA DO XTRACKER — FASE 2 (CALIBRAÇÃO DA CAUDA)',
    '===============================================',
    'Uma pergunta: as faixas baratas aconteceram mais vezes do que o preço dizia?',
    'Sem modelo de contagem. O previsor é o próprio preço do mercado.',
  ];

  if (args.selfTest) {
    out.push(section('SELF-TEST DAS GUARDAS (sem rede)'), ...selfTest());
    console.log(out.join('\n'));
    return;
  }

  // --- posts e trackings ----------------------------------------------------

  console.error(`[${LABEL}] xtracker: trackings e histórico de posts…`);
  const trackingsRes = await call(
    `${XTRACKER}/users/${args.handle}/trackings?platform=x`,
    'xtracker',
  );
  const rawTrackings = unwrap(trackingsRes.body);
  const trackings: Tracking[] = (Array.isArray(rawTrackings) ? rawTrackings : []).flatMap((row) => {
    if (!isRecord(row)) return [];
    const startMs = new Date(String(row['startDate'] ?? '')).getTime();
    const endMs = new Date(String(row['endDate'] ?? '')).getTime();
    return Number.isFinite(startMs) && Number.isFinite(endMs)
      ? [{ title: String(row['title'] ?? ''), startMs, endMs }]
      : [];
  });

  const since = new Date(Math.min(...trackings.map((t) => t.startMs))).toISOString().slice(0, 10);
  // `endDate` é EXCLUSIVO nesta API (medido na fase 1): pedir amanhã inclui hoje.
  const until = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);

  const postsRes = await call(
    `${XTRACKER}/users/${args.handle}/posts?platform=x&startDate=${since}&endDate=${until}`,
    'xtracker',
  );
  const postTimes = asPostTimes(unwrap(postsRes.body));
  const historyStartMs = postTimes[0] ?? Number.POSITIVE_INFINITY;
  const historyEndMs = postTimes[postTimes.length - 1] ?? 0;

  // --- mercados -------------------------------------------------------------

  console.error(`[${LABEL}] gamma: listando a tag Tweet Markets…`);
  const { events, truncated } = await loadTweetEvents();

  const elonEvents = events.filter((e) => isCountMarket(e) && /elon musk/i.test(e.title));
  const resolved = elonEvents
    .filter((e) => e.closed && e.endDate !== null)
    .sort((a, b) => ((a.endDate ?? '') < (b.endDate ?? '') ? -1 : 1));

  const discards: Record<DiscardReason, number> = {
    sem_faixa_nao_lida: 0,
    cobertura_furada: 0,
    sem_faixa_yes: 0,
    sem_janela_de_contagem: 0,
    janela_antes_do_historico: 0,
    sem_token: 0,
  };

  const records: MarketRecord[] = [];
  for (const event of resolved) {
    const closeMs = new Date(event.endDate ?? '').getTime();
    const { bins, unparsed } = parseBins(event);

    if (unparsed > 0) {
      discards.sem_faixa_nao_lida += 1;
      continue;
    }
    if (coverageBroken(bins)) {
      discards.cobertura_furada += 1;
      continue;
    }
    const yesBins = bins.filter((b) => b.yes);
    const yesBin = yesBins[0];
    if (yesBins.length !== 1 || yesBin === undefined) {
      discards.sem_faixa_yes += 1;
      continue;
    }
    if (bins.some((b) => b.tokenId === null)) {
      discards.sem_token += 1;
      continue;
    }

    const window = windowStart(event, closeMs, trackings);
    if (window === null) {
      discards.sem_janela_de_contagem += 1;
      continue;
    }
    if (window.startMs < historyStartMs || closeMs > historyEndMs + 86_400_000) {
      discards.janela_antes_do_historico += 1;
      continue;
    }

    records.push({
      event,
      bins,
      openMs: window.startMs,
      closeMs,
      windowSource: window.source,
      finalCount: countBetween(postTimes, window.startMs, closeMs),
      yesBin,
    });
  }

  const selected = args.markets > 0 ? records.slice(-args.markets) : records;

  // --- dimensionamento ------------------------------------------------------

  interface Wanted {
    record: MarketRecord;
    bin: Bin;
    /** Instantes (em segundos) em que esta faixa está VIVA. */
    instants: Array<{ offsetHours: number; atSeconds: number; countSoFar: number }>;
  }

  const wanted: Wanted[] = [];
  let deadRows = 0;
  let liveRows = 0;

  for (const record of selected) {
    for (const bin of record.bins) {
      const instants: Wanted['instants'] = [];
      for (const offsetHours of args.offsets) {
        const atMs = record.closeMs - offsetHours * 3600_000;
        if (atMs < record.openMs) continue;
        const countSoFar = countBetween(postTimes, record.openMs, atMs);
        const state: BinState = bin.to !== null && bin.to < countSoFar ? 'morta' : 'viva';
        if (state === 'morta') {
          deadRows += 1;
          continue;
        }
        liveRows += 1;
        instants.push({ offsetHours, atSeconds: Math.floor(atMs / 1000), countSoFar });
      }
      if (instants.length > 0) wanted.push({ record, bin, instants });
    }
  }

  const sizing = [
    section('DIMENSIONAMENTO — o que a passada completa vai custar'),
    `  eventos na tag:                          ${events.length}${truncated ? ' (TETO DE PÁGINAS ATINGIDO)' : ''}`,
    `  de contagem do Elon, resolvidos:         ${resolved.length}`,
    `  descartados antes de qualquer chamada:   ${Object.values(discards).reduce((s, v) => s + v, 0)}`,
    ...Object.entries(discards).map(([reason, n]) => `    ${reason.padEnd(28)} ${n}`),
    `  mercados no conjunto:                    ${records.length}`,
    `  mercados selecionados (--markets):       ${selected.length}`,
    '',
    `  instantes por mercado:                   ${args.offsets.map((h) => `T-${h}h`).join(', ')}`,
    `  linhas (mercado, faixa, instante) VIVAS: ${liveRows}`,
    `  linhas MORTAS (faixa já impossível):     ${deadRows}   — não viram chamada nem linha`,
    '',
    `  chamadas de prices-history a fazer:      ${wanted.length}  (uma por faixa, cobrindo os dois instantes)`,
    `  chamadas de trades (medida C):           ~${Math.min(args.tradeSamples, liveRows) * 2}`,
    `  tempo estimado:                          ~${Math.round(((wanted.length + args.tradeSamples * 2) * SPACING_MS) / 60000)} min`,
  ];

  out.push(...sizing);

  if (args.dryRun) {
    out.push(
      '',
      '  --dry-run: nenhuma série puxada. Rode sem a flag para medir.',
      section('CUSTO DA PASSADA'),
      ...callCounts().map(([host, n]) => `  ${host.padEnd(26)} ${n} requisição(ões)`),
      `  ${'TOTAL'.padEnd(26)} ${totalCalls()}`,
    );
    console.log(out.join('\n'));
    return;
  }

  // --- as séries ------------------------------------------------------------

  console.error(`[${LABEL}] clob: ${wanted.length} séries de preço…`);

  const points: BinPoint[] = [];
  /** Série guardada só das faixas baratas sorteadas para a medida C. */
  const seriesByToken = new Map<string, PricePoint[]>();
  const lags: number[] = [];
  let noSeries = 0;
  let outOfTolerance = 0;
  let done = 0;

  /** Faixa viva sem preço, por instante — o número que decide se a medida A vale. */
  const missingByOffset = new Map<number, number>();
  const foundByOffset = new Map<number, number>();

  for (const item of wanted) {
    done += 1;
    if (done % 250 === 0) console.error(`[${LABEL}]   ${done}/${wanted.length} séries…`);

    const offsets = item.instants.map((i) => i.atSeconds);
    const lo = Math.min(...offsets) - PRICE_TOLERANCE_SECONDS;
    const hi = Math.max(...offsets) + PRICE_TOLERANCE_SECONDS;
    const tokenId = item.bin.tokenId ?? '';

    const res = await call(
      `${CLOB}/prices-history?market=${tokenId}&startTs=${lo}&endTs=${hi}&fidelity=${CLOB_FIDELITY}`,
      'clob',
    );
    const history = asHistory(res.body);
    if (history.length === 0) noSeries += item.instants.length;
    seriesByToken.set(tokenId, history);

    for (const instant of item.instants) {
      foundByOffset.set(instant.offsetHours, foundByOffset.get(instant.offsetHours) ?? 0);
      const nearest = pickNearest(history, instant.atSeconds, PRICE_TOLERANCE_SECONDS);
      if (nearest === null) {
        if (history.length > 0) outOfTolerance += 1;
        missingByOffset.set(
          instant.offsetHours,
          (missingByOffset.get(instant.offsetHours) ?? 0) + 1,
        );
        continue;
      }

      foundByOffset.set(instant.offsetHours, (foundByOffset.get(instant.offsetHours) ?? 0) + 1);
      lags.push(Math.abs(nearest.t - instant.atSeconds));

      points.push({
        marketSlug: item.record.event.slug,
        matchSlug: item.record.event.slug,
        seriesSlug: item.record.event.seriesSlug ?? '(sem série)',
        question: item.bin.question,
        closeAt: new Date(item.record.closeMs).toISOString(),
        openAt: new Date(item.record.openMs).toISOString(),
        offsetHours: instant.offsetHours,
        observedAt: new Date(instant.atSeconds * 1000).toISOString(),
        from: item.bin.from,
        to: item.bin.to,
        price: nearest.p,
        priceLagSeconds: Math.abs(nearest.t - instant.atSeconds),
        countSoFar: instant.countSoFar,
        hoursLeft: instant.offsetHours,
        state: 'viva',
        outcome: item.bin.yes ? 1 : 0,
        halfSpread: null,
      });
    }
  }

  out.push(
    section('O CONJUNTO — o que entrou e o que caiu fora'),
    `  mercados com pelo menos uma linha:  ${distinctMarkets(points)} de ${selected.length}`,
    `  linhas (mercado, faixa, instante):  ${points.length}`,
    '',
    `  linhas vivas pedidas:               ${liveRows}`,
    `  faixa sem série nenhuma na janela:  ${noSeries}`,
    `  série existia mas fora da tolerância de ${PRICE_TOLERANCE_SECONDS / 60} min: ${outOfTolerance}`,
    `  DESCARTADAS no total:               ${liveRows - points.length}` +
      `  (${num(((liveRows - points.length) / Math.max(liveRows, 1)) * 100, 1)}%)`,
    '',
    table(
      ['instante', 'com preço', 'sem preço', '% perdida'],
      args.offsets.map((h) => {
        const found = foundByOffset.get(h) ?? 0;
        const missing = missingByOffset.get(h) ?? 0;
        return [
          `T-${h}h`,
          String(found),
          String(missing),
          `${num((missing / Math.max(found + missing, 1)) * 100, 1)}%`,
        ];
      }),
      [0],
    ),
    '',
    `  atraso do ponto usado: mediano ${num((median(lags) ?? 0) / 60, 1)} min, ` +
      `máximo ${num(Math.max(0, ...lags) / 60, 1)} min (teto ${PRICE_TOLERANCE_SECONDS / 60} min)`,
    '',
    '  O DESCARTE NÃO É ALEATÓRIO, e é a armadilha central desta medida.',
    '',
    '  A série de uma faixa PARA quando o book dela esvazia — e o book esvazia',
    '  quando a faixa vira notícia velha. Medido no evento de 4–11/nov: a série da',
    '  faixa 0–19 termina em 06/nov e a de 20–39 em 07/nov, com o mercado fechando',
    '  em 11/nov. Em T-48h essas faixas não têm preço, e todas elas resolveram NÃO.',
    '',
    '  Descartar linha sem preço, sem mais, removeria do conjunto justamente as',
    '  faixas baratas que já se sabia perdedoras — e a taxa de acerto dos baldes',
    '  baratos subiria por construção. Seria um edge fabricado pelo descarte.',
    '',
    '  A defesa é aritmética, não estatística: a contagem só sobe, então uma faixa',
    '  com teto abaixo da contagem já acumulada tem probabilidade ZERO, não',
    `  "probabilidade pequena". As ${deadRows} linhas nesse estado saem do universo`,
    '  ANTES de qualquer chamada — não são descarte por falta de dado, são faixas',
    '  que ninguém compraria. O que sobra acima é descarte de verdade, e é ele que',
    '  a tabela de % perdida vigia.',
  );

  // --- MEDIDA C, parte 1: o que é o número da série -------------------------

  console.error(`[${LABEL}] clob: identidade do preço da série…`);
  const liveEvents = elonEvents.filter((e) => !e.closed);
  const liveBins = liveEvents.flatMap((e) => e.markets);
  const identityTarget = liveBins.find(
    (m) => m.bestBid !== null && m.bestAsk !== null && m.bestAsk - m.bestBid > 0.005,
  );

  const identityRows: string[][] = [];
  if (identityTarget !== undefined) {
    const tokenId = identityTarget.clobTokenIds[0] ?? '';
    const nowSeconds = Math.floor(Date.now() / 1000);
    const bookRes = await call(`${CLOB}/book?token_id=${tokenId}`, 'clob');
    const midRes = await call(`${CLOB}/midpoint?token_id=${tokenId}`, 'clob');
    const histRes = await call(
      `${CLOB}/prices-history?market=${tokenId}&startTs=${nowSeconds - 3600}&endTs=${nowSeconds}&fidelity=1`,
      'clob',
    );

    const book = isRecord(bookRes.body) ? bookRes.body : {};
    const bids = Array.isArray(book['bids']) ? book['bids'] : [];
    const asks = Array.isArray(book['asks']) ? book['asks'] : [];
    const bestBid = Math.max(
      ...bids.flatMap((b) => (isRecord(b) ? [Number(b['price'])] : [])).filter(Number.isFinite),
    );
    const bestAsk = Math.min(
      ...asks.flatMap((a) => (isRecord(a) ? [Number(a['price'])] : [])).filter(Number.isFinite),
    );
    const lastTrade = Number(book['last_trade_price']);
    const midpoint = isRecord(midRes.body) ? Number(midRes.body['mid']) : Number.NaN;
    const history = asHistory(histRes.body);
    const lastPoint = history[history.length - 1];

    identityRows.push(
      ['melhor bid do book', num(bestBid, 4)],
      ['melhor ask do book', num(bestAsk, 4)],
      ['mid calculado (bid+ask)/2', num((bestBid + bestAsk) / 2, 4)],
      ['GET /midpoint', num(midpoint, 4)],
      ['último trade (last_trade_price)', num(lastTrade, 4)],
      ['último ponto de /prices-history', lastPoint === undefined ? '—' : num(lastPoint.p, 4)],
    );
  }

  // --- MEDIDA C, parte 2: o spread ------------------------------------------

  /** Meio spread por balde de preço, das duas fontes que existem. */
  const liveSpreadByBucket = new Map<number, number[]>();
  for (const market of liveBins) {
    if (market.bestBid === null || market.bestAsk === null) continue;
    const mid = (market.bestBid + market.bestAsk) / 2;
    const index = bucketIndex(mid, PRICE_EDGES);
    if (index === null) continue;
    const list = liveSpreadByBucket.get(index);
    if (list === undefined) liveSpreadByBucket.set(index, [market.bestAsk - market.bestBid]);
    else list.push(market.bestAsk - market.bestBid);
  }

  console.error(`[${LABEL}] data-api: travessia histórica em faixas baratas…`);

  /** Sobrepreço pago por quem COMPRA, medido contra o mid do mesmo instante. */
  const tradeExcessByBucket = new Map<number, number[]>();
  const tradeSpreadByBucket = new Map<number, number[]>();
  let sampledBins = 0;
  let sampledWithTrades = 0;

  /**
   * A amostra da medida C: ESTRATIFICADA por balde e espalhada pelo calendário.
   *
   * Duas correções sobre o óbvio, e as duas mudaram o resultado no piloto:
   *
   * 1. Estratificar por balde. Sortear "as faixas baratas" faz a amostra ser
   *    quase toda do balde <2¢ — que é o mais populoso — e os baldes de cima
   *    ficam sem barra nenhuma, saindo da medida A executável. A barra sumir é
   *    pior que ela ser imprecisa: um balde sem barra desaparece da tabela em
   *    vez de aparecer com ressalva.
   * 2. Espalhar no tempo. As N primeiras linhas seriam todas do mesmo mês, e o
   *    spread de um mês não é o spread da amostra — a liquidez destes mercados
   *    mudou junto com a taxa-base.
   */
  const byBucket = new Map<number, BinPoint[]>();
  for (const point of points) {
    const index = bucketIndex(point.price, PRICE_EDGES);
    if (index === null) continue;
    const list = byBucket.get(index);
    if (list === undefined) byBucket.set(index, [point]);
    else list.push(point);
  }

  const perBucket = Math.max(1, Math.floor(args.tradeSamples / Math.max(byBucket.size, 1)));
  const sample: BinPoint[] = [];
  for (const [, list] of [...byBucket.entries()].sort(([a], [b]) => a - b)) {
    const ordered = [...list].sort((a, b) =>
      a.observedAt < b.observedAt ? -1 : a.observedAt > b.observedAt ? 1 : 0,
    );
    const step = Math.max(1, Math.floor(ordered.length / perBucket));
    sample.push(...ordered.filter((_, i) => i % step === 0).slice(0, perBucket));
  }

  const conditionOf = new Map<string, string>();
  for (const record of selected) {
    for (const bin of record.bins) {
      conditionOf.set(`${record.event.slug}|${bin.question}`, bin.conditionId);
    }
  }

  for (const point of sample) {
    const conditionId = conditionOf.get(`${point.marketSlug}|${point.question}`);
    if (conditionId === undefined || conditionId === '') continue;
    sampledBins += 1;

    const atSeconds = Math.floor(new Date(point.observedAt).getTime() / 1000);
    const trades: Trade[] = [];
    for (let page = 0; page < MAX_TRADE_PAGES; page += 1) {
      const res = await call(
        `${DATA_API}/trades?market=${conditionId}&limit=${TRADE_PAGE}&offset=${page * TRADE_PAGE}`,
        'data-api',
      );
      const batch = asTrades(res.body);
      trades.push(...batch);
      // O data-api devolve do mais recente para o mais antigo: quando a página já
      // começou antes do instante que interessa, paginar mais só afasta.
      if (batch.length < TRADE_PAGE) break;
      const oldest = Math.min(...batch.map((t) => t.timestamp));
      if (oldest < atSeconds - TRADE_WINDOW_SECONDS) break;
    }

    const near = trades.filter((t) => Math.abs(t.timestamp - atSeconds) <= TRADE_WINDOW_SECONDS);
    if (near.length === 0) continue;
    sampledWithTrades += 1;

    const index = bucketIndex(point.price, PRICE_EDGES);
    if (index === null) continue;

    const history = seriesByToken.get(
      selected
        .find((r) => r.event.slug === point.marketSlug)
        ?.bins.find((b) => b.question === point.question)?.tokenId ?? '',
    );

    const buys = near.filter((t) => t.side === 'BUY');
    const sells = near.filter((t) => t.side === 'SELL');
    const medBuy = median(buys.map((t) => t.yesPrice));
    const medSell = median(sells.map((t) => t.yesPrice));
    if (medBuy !== null && medSell !== null && medBuy - medSell >= 0) {
      const list = tradeSpreadByBucket.get(index);
      if (list === undefined) tradeSpreadByBucket.set(index, [medBuy - medSell]);
      else list.push(medBuy - medSell);
    }

    if (history !== undefined && history.length > 0) {
      for (const trade of buys) {
        const nearest = pickNearest(history, trade.timestamp, PRICE_TOLERANCE_SECONDS);
        if (nearest === null) continue;
        const list = tradeExcessByBucket.get(index);
        if (list === undefined) tradeExcessByBucket.set(index, [trade.yesPrice - nearest.p]);
        else list.push(trade.yesPrice - nearest.p);
      }
    }
  }

  /**
   * O meio spread de cada balde, com a fonte declarada.
   *
   * A ordem de preferência é a ordem da qualidade da evidência: o sobrepreço de
   * fato pago por um comprador contra o mid do mesmo instante é a medida direta
   * da travessia; o spread entre trades de compra e de venda é indireto; o book
   * de hoje é de OUTRO mercado, do mesmo tipo, e só serve onde os dois primeiros
   * não alcançam. Balde sem nenhuma das três fica sem barra — e as linhas dele
   * saem da medida A executável, em vez de entrarem com custo zero.
   */
  const halfSpreadByBucket = new Map<number, { value: number; source: string }>();
  for (let index = 0; index + 1 < PRICE_EDGES.length; index += 1) {
    const excess = tradeExcessByBucket.get(index) ?? [];
    const traded = tradeSpreadByBucket.get(index) ?? [];
    const live = liveSpreadByBucket.get(index) ?? [];

    if (excess.length >= 20) {
      const m = median(excess);
      if (m !== null && m > 0) {
        halfSpreadByBucket.set(index, { value: m, source: `compra vs mid (n=${excess.length})` });
        continue;
      }
    }
    if (traded.length >= 5) {
      const m = median(traded);
      if (m !== null && m > 0) {
        halfSpreadByBucket.set(index, {
          value: m / 2,
          source: `trades compra−venda (n=${traded.length})`,
        });
        continue;
      }
    }
    if (live.length >= 3) {
      const m = median(live);
      if (m !== null && m > 0) {
        halfSpreadByBucket.set(index, {
          value: m / 2,
          source: `book vivo hoje (n=${live.length})`,
        });
      }
    }
  }

  for (const point of points) {
    const index = bucketIndex(point.price, PRICE_EDGES);
    point.halfSpread = index === null ? null : (halfSpreadByBucket.get(index)?.value ?? null);
  }

  // --- os mercado-instantes, e a soma de preços que valida cada um --------

  interface MarketInstant {
    marketSlug: string;
    seriesSlug: string;
    closeAt: string;
    offsetHours: number;
    priceSum: number;
    impliedMean: number;
    impliedSd: number;
    actual: number;
    z: number;
    missing: number;
  }

  const instants: MarketInstant[] = [];
  for (const record of selected) {
    for (const offsetHours of args.offsets) {
      const atMs = record.closeMs - offsetHours * 3600_000;
      if (atMs < record.openMs) continue;
      const countSoFar = countBetween(postTimes, record.openMs, atMs);

      const shaped: BinShape[] = record.bins.map((bin) => {
        const state: BinState = bin.to !== null && bin.to < countSoFar ? 'morta' : 'viva';
        const row = points.find(
          (p) =>
            p.marketSlug === record.event.slug &&
            p.question === bin.question &&
            p.offsetHours === offsetHours,
        );
        return { from: bin.from, to: bin.to, price: row?.price ?? null, state };
      });

      const moments = impliedMoments(shaped);
      if (moments === null || moments.missing > 0) continue;

      const z = zScore(record.finalCount, moments);
      if (z === null) continue;

      instants.push({
        marketSlug: record.event.slug,
        seriesSlug: record.event.seriesSlug ?? '(sem série)',
        closeAt: new Date(record.closeMs).toISOString(),
        offsetHours,
        priceSum: moments.priceSum,
        impliedMean: moments.mean,
        impliedSd: moments.sd,
        actual: record.finalCount,
        z,
        missing: moments.missing,
      });
    }
  }

  // --- MEDIDA A -------------------------------------------------------------

  /**
   * O tick destes mercados. Medido no `/book`: 0,001 nas faixas de cauda.
   *
   * Serve de piso de significância. Um gap de 0,0025 é estatisticamente lindo e
   * economicamente inexistente: ele é menor que o passo mínimo de preço, então
   * não existe ordem que o capture. Chamar isso de "CARA" seria repetir o C2 com
   * outro nome.
   */
  const TICK = 0.001;

  const bucketRows = (buckets: readonly EdgeBucket[]): string[][] =>
    buckets.map((b) => {
      const gap = bucketGap(b);
      const conclusive = b.distinctMarkets >= MIN_MATCHES_FOR_BUCKET;
      const ciExcludesPrice = b.ciLow > b.meanPredicted || b.ciHigh < b.meanPredicted;
      return [
        bucketLabel(b),
        String(b.n),
        String(b.distinctMarkets),
        num(b.meanPredicted, 4),
        num(b.observedRate, 4),
        `[${num(b.ciLow, 4)}; ${num(b.ciHigh, 4)}]`,
        (gap > 0 ? '+' : '') + num(gap, 4),
        !conclusive
          ? `poucos mercados (<${MIN_MATCHES_FOR_BUCKET})`
          : !ciExcludesPrice
            ? 'o preço cabe no intervalo'
            : Math.abs(gap) < TICK
              ? `gap < 1 tick (${TICK}) — nulo`
              : gap > 0
                ? 'CARA — aconteceu MENOS'
                : 'BARATA — aconteceu MAIS',
      ];
    });

  const main = edgeBuckets(points, BIN_PRICE);

  out.push(
    section('MEDIDA A — calibração: o preço da faixa contra o que aconteceu'),
    'Previsor = preço da faixa (mid). "gap" = preço médio − taxa observada;',
    'positivo quer dizer que a faixa PROMETEU mais do que ENTREGOU, ou seja, cara.',
    'O intervalo é bootstrap reamostrando MERCADOS, não linhas — ver guarda 1.',
    '',
    table(
      ['balde', 'n', 'mercados', 'preço médio', 'aconteceu', 'IC 95% (agrupado)', 'gap', 'leitura'],
      bucketRows(main),
      [0, 5, 7],
    ),
    '',
    `  mercados distintos no total: ${distinctMarkets(points)}   linhas: ${points.length}`,
  );

  // A pergunta de cinco linhas: abaixo de 10¢ aconteceu mais que 10%?
  const cheapPoints = points.filter((p) => p.price < 0.1);
  const cheapRate = cheapPoints.length === 0 ? null : mean(cheapPoints.map((p) => p.outcome));
  const cheapPrice = cheapPoints.length === 0 ? null : mean(cheapPoints.map((p) => p.price));
  const cheapBuckets = edgeBuckets(cheapPoints, BIN_PRICE, [0, 0.1]);
  const cheapBucket = cheapBuckets[0];

  out.push(
    '',
    '  A PERGUNTA, isolada — todas as faixas abaixo de 10¢ juntas:',
    `    linhas:            ${cheapPoints.length}`,
    `    mercados:          ${distinctMarkets(cheapPoints)}`,
    `    preço médio:       ${num(cheapPrice, 4)}  (${num((cheapPrice ?? 0) * 100, 2)}¢)`,
    `    aconteceu:         ${num(cheapRate, 4)}  (${num((cheapRate ?? 0) * 100, 2)}%)`,
    `    IC 95% agrupado:   [${num(cheapBucket?.ciLow ?? Number.NaN, 4)}; ${num(cheapBucket?.ciHigh ?? Number.NaN, 4)}]`,
    `    gap:               ${num((cheapPrice ?? 0) - (cheapRate ?? 0), 4)}`,
    '',
    '  O QUE ENCHE O BALDE <2¢, e sem isto a linha de cima engana:',
    `    linhas no balde <2¢:            ${points.filter((p) => p.price < 0.02).length}`,
    `    delas, com mid <= 1 tick (${TICK}): ${points.filter((p) => p.price <= TICK).length}`,
    `    de ${distinctMarkets(points.filter((p) => p.price <= TICK))} mercados`,
    '',
    '    Faixa cotada no piso do tick não é "o mercado disse 0,05%". É book de um',
    '    lado só: sem bid nenhum, o mid vira metade do ask por definição, e o',
    '    número que sai da série é artefato da fórmula, não opinião de ninguém.',
    '    Essas linhas dominam o balde mais barato e resolveram NÃO praticamente',
    '    sempre — o que não é o mercado acertando a cauda, é a cauda longe demais',
    '    para alguém se dar ao trabalho de cotar.',
  );

  // --- a correção que mais muda a leitura -----------------------------------

  const coherent = coherentPoints(points, instants);

  out.push(
    section('MEDIDA A CORRIGIDA — só onde os preços somam ~1'),
    'Uma faixa cujo book está vazio não tem preço: o mid de um book vazio é ~0,5 por',
    'aritmética, não por opinião. O sintoma é a soma das faixas do evento estourar 1.',
    '',
    `  mercado-instantes com soma em [${PRICE_SUM_MIN}; ${PRICE_SUM_MAX}]: ${coherent.keptInstants}`,
    `  mercado-instantes fora dessa faixa:            ${coherent.droppedInstants}`,
    `  linhas mantidas: ${coherent.kept.length}   linhas removidas: ${coherent.dropped.length}`,
    '',
    table(
      ['balde', 'n', 'mercados', 'preço médio', 'aconteceu', 'IC 95% (agrupado)', 'gap', 'leitura'],
      bucketRows(edgeBuckets(coherent.kept, BIN_PRICE)),
      [0, 5, 7],
    ),
    '',
    '  E o que foi REMOVIDO, para que ninguém precise acreditar que era lixo:',
    '',
    table(
      ['balde', 'n', 'mercados', 'preço médio', 'aconteceu', 'IC 95% (agrupado)', 'gap', 'leitura'],
      bucketRows(edgeBuckets(coherent.dropped, BIN_PRICE)),
      [0, 5, 7],
    ),
    '',
    '  Se o único balde "significativo" da tabela anterior estiver calibrado aqui e',
    '  torto ali, o achado não era do mercado: era do book vazio na hora da listagem.',
  );

  // --- guarda 2: divisão temporal -------------------------------------------

  const { older, newer } = splitByMarketTime(points);
  const olderIds = new Set(older.map((p) => p.marketSlug));
  const newerIds = new Set(newer.map((p) => p.marketSlug));
  const intersection = [...olderIds].filter((id) => newerIds.has(id));

  out.push(
    section('GUARDA 2 — divisão temporal por MERCADO'),
    `  metade antiga:  ${distinctMarkets(older)} mercados, ${older.length} linhas` +
      `  (fecham até ${older[older.length - 1]?.closeAt.slice(0, 10) ?? '—'})`,
    `  metade recente: ${distinctMarkets(newer)} mercados, ${newer.length} linhas` +
      `  (a partir de ${newer[0]?.closeAt.slice(0, 10) ?? '—'})`,
    `  INTERSEÇÃO DE MERCADOS: ${intersection.length}` +
      (intersection.length === 0
        ? '  — vazia, nenhum mercado atravessa o corte.'
        : `  — VAZAMENTO: ${intersection.slice(0, 5).join(', ')}`),
    '',
    '  Metade ANTIGA:',
    table(
      ['balde', 'n', 'mercados', 'preço médio', 'aconteceu', 'IC 95% (agrupado)', 'gap', 'leitura'],
      bucketRows(edgeBuckets(older, BIN_PRICE)),
      [0, 5, 7],
    ),
    '',
    '  Metade RECENTE:',
    table(
      ['balde', 'n', 'mercados', 'preço médio', 'aconteceu', 'IC 95% (agrupado)', 'gap', 'leitura'],
      bucketRows(edgeBuckets(newer, BIN_PRICE)),
      [0, 5, 7],
    ),
  );

  // --- guarda 3: regime -----------------------------------------------------

  const quarters = [...new Set(points.map((p) => quarter(p.closeAt)))].sort();
  const quarterRows: string[][] = [];
  for (const q of quarters) {
    const slice = points.filter((p) => quarter(p.closeAt) === q);
    const sub = slice.filter((p) => p.price < 0.1);
    const days = new Set(slice.map((p) => p.closeAt.slice(0, 10)));
    const counts = [...new Map(slice.map((p) => [p.marketSlug, p])).values()];
    void counts;

    const bucket = edgeBuckets(sub, BIN_PRICE, [0, 0.1])[0];
    quarterRows.push([
      q,
      String(distinctMarkets(slice)),
      String(days.size),
      String(sub.length),
      num(mean(sub.map((p) => p.price)), 4),
      num(mean(sub.map((p) => p.outcome)), 4),
      bucket === undefined ? '—' : `[${num(bucket.ciLow, 3)}; ${num(bucket.ciHigh, 3)}]`,
      num((mean(sub.map((p) => p.price)) ?? 0) - (mean(sub.map((p) => p.outcome)) ?? 0), 4),
    ]);
  }

  const ratePerMarket = selected
    .filter((r) => r.closeMs > 0)
    .map((r) => ({
      q: quarter(new Date(r.closeMs).toISOString()),
      perDay: r.finalCount / Math.max((r.closeMs - r.openMs) / 86_400_000, 1e-9),
    }));

  out.push(
    section('GUARDA 3 — a deriva: o efeito aparece nos dois regimes?'),
    '  Faixas abaixo de 10¢, por trimestre de fechamento.',
    '',
    table(
      ['trimestre', 'mercados', 'dias', 'linhas <10¢', 'preço médio', 'aconteceu', 'IC 95%', 'gap'],
      quarterRows,
      [0, 6],
    ),
    '',
    '  A taxa-base, para situar o regime:',
    table(
      ['trimestre', 'mercados', 'posts/dia (mediana)'],
      quarters.map((q) => {
        const rates = ratePerMarket.filter((r) => r.q === q).map((r) => r.perDay);
        return [q, String(rates.length), num(median(rates), 1)];
      }),
      [0],
    ),
  );

  // --- MEDIDA B -------------------------------------------------------------

  const zRows: string[][] = [];
  for (const offsetHours of args.offsets) {
    const slice = instants.filter((i) => i.offsetHours === offsetHours);
    const zs = slice.map((i) => i.z);
    const sd = standardDeviation(zs);
    zRows.push([
      `T-${offsetHours}h`,
      String(slice.length),
      String(new Set(slice.map((i) => i.marketSlug)).size),
      num(mean(zs), 3),
      num(sd, 3),
      sd === null ? '—' : `${num((sd - 1) * 100, 0)}%`,
      num(median(slice.map((i) => i.impliedSd)), 1),
      num(median(slice.map((i) => i.priceSum)), 4),
    ]);
  }

  const seriesRows: string[][] = [];
  for (const series of [...new Set(instants.map((i) => i.seriesSlug))].sort()) {
    const slice = instants.filter((i) => i.seriesSlug === series);
    const sd = standardDeviation(slice.map((i) => i.z));
    seriesRows.push([
      series,
      String(slice.length),
      num(mean(slice.map((i) => i.z)), 3),
      num(sd, 3),
      num(median(slice.map((i) => i.impliedSd)), 1),
      num(median(slice.map((i) => i.actual)), 0),
    ]);
  }

  const allSums = instants.map((i) => i.priceSum);
  const above = allSums.filter((s) => s > 1.01).length;
  const below = allSums.filter((s) => s < 0.99).length;

  out.push(
    section('MEDIDA B — a largura implícita contra a realizada'),
    'z = (contagem real − média implícita) / desvio implícito, um por mercado-instante.',
    'Se o mercado acerta a LARGURA, o desvio dos z dá 1. Acima de 1, ele é estreito',
    'demais — e o excesso é o tamanho do erro. Comparar desvio implícito com desvio',
    'das contagens realizadas seria pior: a amostra mistura janelas de 48 h e 7 dias,',
    'com a taxa-base caindo de 53 para 23 posts/dia por cima.',
    '',
    table(
      [
        'instante',
        'mercado-instantes',
        'mercados',
        'média z',
        'desvio z',
        'estreiteza',
        'desvio impl. (mediana)',
        'soma preços',
      ],
      zRows,
      [0],
    ),
    '',
    '  Por série (janelas diferentes, escalas diferentes):',
    table(
      ['série', 'n', 'média z', 'desvio z', 'desvio impl.', 'contagem real (mediana)'],
      seriesRows,
      [0],
    ),
    '',
    '  A SOMA DOS PREÇOS — a checagem que diz se a medida A está enviesada:',
    `    mediana:                 ${num(median(allSums), 4)}`,
    `    mercado-instantes:       ${allSums.length}`,
    `    soma > 1,01:             ${above}  (${num((above / Math.max(allSums.length, 1)) * 100, 1)}%)`,
    `    soma < 0,99:             ${below}  (${num((below / Math.max(allSums.length, 1)) * 100, 1)}%)`,
    '',
    '    Só entram aqui os mercado-instantes com preço em TODAS as faixas vivas —',
    `    ${instants.length} de ${selected.length * args.offsets.length} possíveis. Uma soma calculada com faixa faltando`,
    '    daria abaixo de 1 por ausência de dado, não por informação do mercado, e a',
    '    leitura "faltam faixas no conjunto" viraria circular.',
    '',
    '    Acima de 1 é o desvio de neg-risk (estes mercados são neg-risk: o Gamma',
    '    marca `negRisk: true`), e vira candidato próprio: vender o conjunto das',
    '    faixas quando a soma passa de 1 é uma aposta sem opinião sobre o Elon.',
    ...regimeSection(instants),
  );

  // --- MEDIDA C -------------------------------------------------------------

  const spreadRows: string[][] = [];
  for (let index = 0; index + 1 < PRICE_EDGES.length; index += 1) {
    const from = PRICE_EDGES[index] ?? 0;
    const to = PRICE_EDGES[index + 1] ?? 1;
    const chosen = halfSpreadByBucket.get(index);
    const excess = tradeExcessByBucket.get(index) ?? [];
    const traded = tradeSpreadByBucket.get(index) ?? [];
    const live = liveSpreadByBucket.get(index) ?? [];
    if (chosen === undefined && excess.length === 0 && traded.length === 0 && live.length === 0) {
      continue;
    }

    spreadRows.push([
      bucketLabel({ from, to }),
      excess.length === 0 ? '—' : `${num(median(excess), 4)} (n=${excess.length})`,
      traded.length === 0 ? '—' : `${num(median(traded), 4)} (n=${traded.length})`,
      live.length === 0 ? '—' : `${num(median(live), 4)} (n=${live.length})`,
      chosen === undefined ? 'SEM BARRA' : num(chosen.value, 4),
      chosen?.source ?? '—',
    ]);
  }

  const executable = edgeBuckets(points, BIN_ASK);
  const askPoints = points.filter((p) => BIN_ASK(p) !== null);
  const cheapAsk = askPoints.filter((p) => (BIN_ASK(p) ?? 1) < 0.1);

  out.push(
    section('MEDIDA C — dá para executar?'),
    '  1. O QUE É O NÚMERO DA SÉRIE — medido nesta passada, num mercado vivo:',
    '',
    identityRows.length === 0
      ? '  (nenhum mercado vivo com book de dois lados agora — não deu para medir)'
      : table(['fonte', 'valor'], identityRows, [0]),
    '',
    identityRows.length === 0
      ? ''
      : '  `/prices-history` devolve o MID, não o negócio: ele bate com (bid+ask)/2 e com\n' +
          '  `/midpoint`, e NÃO com `last_trade_price`. A medida A inteira está medida\n' +
          '  contra o meio do book — que é um preço em que ninguém compra.',
    '',
    `  2. O SPREAD — três fontes, da mais direta para a mais indireta.`,
    `     Amostra: ${sampledBins} faixas, estratificadas por balde e espalhadas pelo calendário,`,
    `     ${sampledWithTrades} delas com trade dentro de ±${TRADE_WINDOW_SECONDS / 3600} h do instante.`,
    '',
    table(
      [
        'balde',
        'compra − mid (meio spread)',
        'compra − venda (spread)',
        'book vivo (spread)',
        'meio spread usado',
        'fonte',
      ],
      spreadRows,
      [0, 5],
    ),
    '',
    '  3. A MEDIDA A REFEITA COMPRANDO NO ASK (mid + meio spread):',
    '',
    table(
      ['balde', 'n', 'mercados', 'preço médio', 'aconteceu', 'IC 95% (agrupado)', 'gap', 'leitura'],
      bucketRows(executable),
      [0, 5, 7],
    ),
    '',
    `    linhas com barra de execução: ${askPoints.length} de ${points.length}`,
    `    abaixo de 10¢ JÁ NO ASK:      ${cheapAsk.length} linhas, ` +
      `${distinctMarkets(cheapAsk)} mercados, aconteceu ${num(mean(cheapAsk.map((p) => p.outcome)), 4)}`,
    '',
    '    O balde muda de nome quando o preço muda: uma faixa cujo mid é 3¢ e cujo ask',
    '    é 4¢ sai do balde 2–5¢ e pode entrar no de cima. É exatamente o ponto — a',
    '    tabela acima responde "comprando pelo que dá para comprar, o que acontece?",',
    '    e não "quanto valia o meio do book".',
  );

  // --- snapshots ------------------------------------------------------------

  if (args.write) {
    const { mkdir, writeFile } = await import('node:fs/promises');
    await mkdir(SNAPSHOT_DIR, { recursive: true });
    await writeFile(
      `${SNAPSHOT_DIR}/calibration-dataset.json`,
      `${JSON.stringify(
        {
          kind: 'xtracker-calibration-dataset',
          version: 1,
          builtAt: new Date().toISOString(),
          offsets: args.offsets,
          priceEdges: PRICE_EDGES,
          priceToleranceSeconds: PRICE_TOLERANCE_SECONDS,
          markets: distinctMarkets(points),
          discards,
          deadRows,
          liveRows,
          points,
          instants,
        },
        null,
        2,
      )}\n`,
      'utf8',
    );
    console.error(`[${LABEL}] snapshot: ${SNAPSHOT_DIR}/calibration-dataset.json`);

    if (identityTarget !== undefined) {
      const tokenId = identityTarget.clobTokenIds[0] ?? '';
      const bookRes = await call(`${CLOB}/book?token_id=${tokenId}`, 'clob');
      await writeSnapshot(
        LABEL,
        `${SNAPSHOT_DIR}/clob-book-${tokenId.slice(0, 12)}.json`,
        'clob-book-snapshot',
        '/book',
        { token_id: tokenId },
        bookRes,
      );
    }
  }

  out.push(
    section('CUSTO DA PASSADA'),
    ...callCounts().map(([host, n]) => `  ${host.padEnd(26)} ${n} requisição(ões)`),
    `  ${'TOTAL'.padEnd(26)} ${totalCalls()}   (espaçadas em ${SPACING_MS} ms)`,
    '',
    '  Nenhuma chamada à OddsPapi. Nenhuma escrita no banco. Nenhum arquivo de',
    '  `src/` alterado.',
  );

  console.log(out.join('\n'));
}

main().catch((err: unknown) => {
  console.error(`[${LABEL}] falhou:`, err instanceof Error ? err.message : String(err));
  process.exit(1);
});
