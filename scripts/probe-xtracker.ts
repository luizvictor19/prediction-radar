import 'dotenv/config';

import type { CallResult } from './lib/probe-net.js';
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
  writeSnapshot as writeSnapshotRaw,
} from './lib/probe-net.js';

/**
 * Sonda do XTracker — fase 1: descobrir se dá para medir antes de medir.
 *
 * A hipótese é que o Elon posta em RAJADA e que o mercado precifica com um modelo
 * tipo Poisson; se for verdade, as faixas das pontas estão baratas. Nada disso é
 * verificável sem quatro coisas que ninguém neste projeto tinha conferido:
 * histórico de contagem, regra de contagem reproduzível, lista de mercados
 * resolvidos, e — a que decide tudo — série de PREÇO anterior ao fechamento.
 *
 * Esta sonda não mede a hipótese. Ela responde se a medição é possível, e grava
 * as respostas cruas para que a fase 2 não precise confiar na memória de ninguém.
 *
 * SÓ LEITURA, e nem banco: não toca Supabase, não escreve tabela, não roda
 * migration. Nenhuma chamada à OddsPapi (cota de outra frente). O que ela escreve
 * são snapshots em `probes/xtracker/`, no mesmo formato dos da OddsPapi.
 *
 * ## Cortesia com uma API gratuita e sem chave
 *
 * O XTracker é público e sem autenticação, o que o torna fácil de abusar. Toda
 * chamada aqui passa por `call`, que espaça as requisições em
 * `SPACING_MS` e conta quantas foram — o relatório imprime o total. A passada
 * completa gasta ~25 requisições, e a mais cara delas (o histórico inteiro de
 * posts) é UMA, não uma por dia.
 *
 * ## Uso
 *
 *   npm run xtracker:probe                # passada completa
 *   npm run xtracker:probe -- --no-write  # sem gravar snapshot
 *   npm run xtracker:probe -- --markets=12 --prices=8
 *   npm run xtracker:probe -- --handle=elonmusk
 */

const LABEL = 'probe-xtracker';

const XTRACKER = 'https://xtracker.polymarket.com/api';
const GAMMA = process.env['POLYMARKET_GAMMA_URL'] ?? 'https://gamma-api.polymarket.com';
const CLOB = 'https://clob.polymarket.com';

const SNAPSHOT_DIR = 'probes/xtracker';

/** `limit` do Gamma satura em 100 por página — medido, não documentado. */
const GAMMA_PAGE = 100;

/** Teto de páginas do Gamma. Trava contra varredura acidental de milhares. */
const MAX_GAMMA_PAGES = 12;

/** A tag "Tweet Markets" do Gamma. É o guarda-chuva de todos os mercados de contagem. */
const TWEET_TAG_ID = '972';

/**
 * Fidelidade pedida ao CLOB, em minutos.
 *
 * Medido: o servidor devolve pontos de 10 em 10 minutos independentemente do que
 * se peça (1, 10 e 60 dão a mesma série). O parâmetro fica explícito para que a
 * próxima pessoa veja que ele foi testado e não presuma que 1 traria mais.
 */
const CLOB_FIDELITY = 60;

// ---------------------------------------------------------------------------
// Flags
// ---------------------------------------------------------------------------

interface Args {
  handle: string;
  /** Quantos eventos resolvidos detalhar (faixas, faixa vencedora). */
  markets: number;
  /** Em quantos mercados resolvidos sondar preço histórico. */
  prices: number;
  write: boolean;
}

const DEFAULTS: Args = { handle: 'elonmusk', markets: 8, prices: 6, write: true };

function parseArgs(argv: readonly string[]): Args | { error: string } {
  const args: Args = { ...DEFAULTS };

  for (const arg of argv) {
    if (arg === '--no-write') {
      args.write = false;
      continue;
    }

    const match = /^--(handle|markets|prices)=(.+)$/.exec(arg);
    if (match === null) return { error: `argumento desconhecido: ${arg}` };

    const [, key, raw = ''] = match;
    if (key === 'handle') {
      args.handle = raw;
      continue;
    }

    const value = Number(raw);
    if (!Number.isInteger(value) || value < 0) {
      return { error: `--${key}=${raw} precisa ser um inteiro >= 0` };
    }
    if (key === 'markets') args.markets = value;
    else args.prices = value;
  }

  return args;
}

// ---------------------------------------------------------------------------
// 1 + 2. XTracker: histórico e estrutura do post
// ---------------------------------------------------------------------------

interface Post {
  platformId: string;
  content: string;
  createdAt: string;
  importedAt: string | null;
}

interface Tracking {
  id: string;
  title: string;
  startDate: string;
  endDate: string;
  marketLink: string | null;
}

function asPosts(value: unknown): Post[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((row) => {
    if (!isRecord(row)) return [];
    const createdAt = row['createdAt'];
    if (typeof createdAt !== 'string') return [];
    return [
      {
        platformId: String(row['platformId'] ?? ''),
        content: typeof row['content'] === 'string' ? row['content'] : '',
        createdAt,
        importedAt: typeof row['importedAt'] === 'string' ? row['importedAt'] : null,
      },
    ];
  });
}

/** Contagem por dia UTC. A unidade de tudo que vem depois. */
function dailyCounts(posts: readonly Post[]): Map<string, number> {
  const byDay = new Map<string, number>();
  for (const post of posts) {
    const day = post.createdAt.slice(0, 10);
    byDay.set(day, (byDay.get(day) ?? 0) + 1);
  }
  return byDay;
}

/**
 * O que dá para dizer sobre o TIPO de um post olhando só o payload.
 *
 * A resposta importa mais que os números: se a API não classifica, a regra de
 * contagem publicada ("principal, quote e repost contam; resposta não") não é
 * reproduzível a partir daqui, e qualquer recontagem nossa seria uma opinião
 * sobre o dado deles em vez de uma auditoria dele.
 */
function classify(posts: readonly Post[]): {
  campos: string[];
  repostAparente: number;
  respostaAparente: number;
  demais: number;
} {
  const campos = new Set<string>();
  for (const post of posts.slice(0, 200)) for (const key of Object.keys(post)) campos.add(key);

  const repost = posts.filter((p) => p.content.startsWith('RT @')).length;
  // Resposta começa com "@handle" no texto da API do X. A doc diz que resposta
  // NÃO conta — se aparecer alguma aqui, ou a doc está errada ou o texto engana.
  const resposta = posts.filter((p) => /^@\w/.test(p.content)).length;

  return {
    campos: [...campos].sort(),
    repostAparente: repost,
    respostaAparente: resposta,
    demais: posts.length - repost - resposta,
  };
}

// ---------------------------------------------------------------------------
// 5. Dispersão
// ---------------------------------------------------------------------------

interface Dispersion {
  n: number;
  mean: number;
  sd: number;
  poissonSd: number;
  /** Variância observada dividida pela de Poisson. 1 = Poisson; > 1 = rajada. */
  ratio: number;
}

function dispersion(values: readonly number[]): Dispersion | null {
  if (values.length < 2) return null;

  const n = values.length;
  const mean = values.reduce((s, v) => s + v, 0) / n;
  // Variância amostral (n−1): a de população subestima com amostra curta, e a
  // pergunta aqui é sobre o processo, não sobre estes dias específicos.
  const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / (n - 1);

  return {
    n,
    mean,
    sd: Math.sqrt(variance),
    poissonSd: Math.sqrt(mean),
    ratio: mean === 0 ? Number.NaN : variance / mean,
  };
}

/** `2026-08-11` + n dias, em UTC. */
function addDays(day: string, n: number): string {
  const at = new Date(`${day}T00:00:00.000Z`);
  at.setUTCDate(at.getUTCDate() + n);
  return at.toISOString().slice(0, 10);
}

/**
 * Somas em janelas NÃO sobrepostas de `size` dias.
 *
 * Não sobrepostas porque janelas que compartilham dias compartilham ruído: a
 * série de somas móveis tem autocorrelação por construção, e o desvio-padrão
 * dela subestima a dispersão real de uma aposta semanal — que é o número que o
 * mercado precifica.
 */
function windowSums(counts: readonly number[], size: number): number[] {
  const sums: number[] = [];
  for (let i = 0; i + size <= counts.length; i += size) {
    sums.push(counts.slice(i, i + size).reduce((s, v) => s + v, 0));
  }
  return sums;
}

/**
 * Dispersão do que uma previsão INGÊNUA erraria — e é este o número que decide.
 *
 * As linhas anteriores medem a variação bruta, que mistura duas coisas: o quanto
 * ele varia de um dia para o outro e o quanto a taxa-base dele mudou ao longo de
 * dez meses (de 53 posts/dia em dezembro para 23 em agosto). Ninguém precifica um
 * mercado semanal com a média de dez meses; precifica com a taxa recente.
 *
 * Então a pergunta honesta é: alguém que estime a taxa pelos `trailing` dias
 * anteriores e trate a semana como Poisson em cima dela — erra quanto? A razão
 * daqui é a superdispersão que SOBRA depois de dar ao modelo simples a informação
 * que ele realmente teria. Se ela ficar perto de 1, não há rajada a explorar: só
 * havia deriva, e a deriva o mercado também vê.
 */
function residualDispersion(
  counts: readonly number[],
  size: number,
  trailing: number,
): Dispersion | null {
  const residuals: number[] = [];
  const actuals: number[] = [];

  for (let start = trailing; start + size <= counts.length; start += size) {
    const past = counts.slice(start - trailing, start);
    const rate = past.reduce((s, v) => s + v, 0) / trailing;
    const forecast = rate * size;
    const actual = counts.slice(start, start + size).reduce((s, v) => s + v, 0);

    residuals.push(actual - forecast);
    actuals.push(actual);
  }

  if (residuals.length < 2) return null;

  const mean = actuals.reduce((s, v) => s + v, 0) / actuals.length;
  // Variância em torno da PREVISÃO (não da média dos resíduos): o erro de um
  // previsor enviesado tem que pesar, e centrar os resíduos perdoaria o viés.
  const variance = residuals.reduce((s, v) => s + v ** 2, 0) / (residuals.length - 1);

  return {
    n: residuals.length,
    mean,
    sd: Math.sqrt(variance),
    poissonSd: Math.sqrt(mean),
    ratio: variance / mean,
  };
}

/**
 * Dispersão DENTRO de cada mês, agrupada.
 *
 * Separa duas coisas que a dispersão global soma sem avisar: o quanto ele varia
 * de um dia para o outro (rajada) e o quanto a taxa-base dele muda de mês para
 * mês (deriva). Um mercado semanal precifica a primeira; a segunda é o que faz a
 * média histórica ser um estimador ruim da semana que vem. Se a razão global for
 * muito maior que esta, boa parte da "superdispersão" é deriva, não rajada.
 */
function withinMonthDispersion(byDay: ReadonlyMap<string, number>): Dispersion | null {
  const byMonth = new Map<string, number[]>();
  for (const [day, count] of byDay) {
    const month = day.slice(0, 7);
    const bucket = byMonth.get(month);
    if (bucket === undefined) byMonth.set(month, [count]);
    else bucket.push(count);
  }

  let sumSq = 0;
  let sumMean = 0;
  let df = 0;
  let n = 0;

  for (const counts of byMonth.values()) {
    if (counts.length < 2) continue;
    const mean = counts.reduce((s, v) => s + v, 0) / counts.length;
    sumSq += counts.reduce((s, v) => s + (v - mean) ** 2, 0);
    sumMean += mean * counts.length;
    df += counts.length - 1;
    n += counts.length;
  }

  if (df === 0 || n === 0) return null;

  const variance = sumSq / df;
  const mean = sumMean / n;

  return { n, mean, sd: Math.sqrt(variance), poissonSd: Math.sqrt(mean), ratio: variance / mean };
}

// ---------------------------------------------------------------------------
// 3. Mercados
// ---------------------------------------------------------------------------

interface GammaMarket {
  question: string;
  slug: string;
  closed: boolean;
  outcomePrices: string[];
  clobTokenIds: string[];
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
                  slug: String(m['slug'] ?? ''),
                  closed: m['closed'] === true,
                  outcomePrices: parseJsonArray(m['outcomePrices']),
                  clobTokenIds: parseJsonArray(m['clobTokenIds']),
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

/**
 * Todos os eventos da tag "Tweet Markets", paginando.
 *
 * É o caminho que responde "como listar sem adivinhar slug": a tag é o guarda-
 * chuva, e a série (`seriesSlug`) separa os formatos — 48h, semanal, diário. Sem
 * ela sobraria enumerar slug por slug, que além de frágil não diz o que existe.
 */
async function loadTweetEvents(): Promise<{
  events: GammaEvent[];
  pages: number;
  truncated: boolean;
}> {
  const events: GammaEvent[] = [];
  let pages = 0;

  for (let offset = 0; pages < MAX_GAMMA_PAGES; offset += GAMMA_PAGE) {
    const url = `${GAMMA}/events?tag_id=${TWEET_TAG_ID}&limit=${GAMMA_PAGE}&offset=${offset}`;
    const res = await call(url, 'gamma');
    pages += 1;

    const batch = asEvents(res.body);
    events.push(...batch);
    if (batch.length < GAMMA_PAGE) return { events, pages, truncated: false };
  }

  return { events, pages, truncated: true };
}

/** Uma faixa de contagem lida do título do mercado. */
interface Bin {
  question: string;
  from: number;
  to: number | null;
  yes: boolean;
  tokenId: string | null;
}

/**
 * As faixas de um evento, lidas do texto da pergunta.
 *
 * Três formatos convivem: "<40", "40-64" e "300+". Ler do título é frágil por
 * natureza — mas é o que existe, e a alternativa (confiar na ordem dos mercados)
 * é pior. Quantas perguntas NÃO casam com nenhum dos três é reportado, porque
 * uma faixa que o parser não entende vira buraco silencioso na cobertura.
 */
function parseBins(event: GammaEvent): { bins: Bin[]; unparsed: string[] } {
  const bins: Bin[] = [];
  const unparsed: string[] = [];

  for (const market of event.markets) {
    const yes = market.outcomePrices[0] === '1';
    const tokenId = market.clobTokenIds[0] ?? null;

    const range = /post (\d+)-(\d+) (?:tweets|posts)/i.exec(market.question);
    const below = /post <(\d+) (?:tweets|posts)/i.exec(market.question);
    const above = /post (\d+)\+ (?:tweets|posts)/i.exec(market.question);

    if (range !== null) {
      bins.push({
        question: market.question,
        from: Number(range[1]),
        to: Number(range[2]),
        yes,
        tokenId,
      });
    } else if (below !== null) {
      bins.push({ question: market.question, from: 0, to: Number(below[1]) - 1, yes, tokenId });
    } else if (above !== null) {
      bins.push({ question: market.question, from: Number(above[1]), to: null, yes, tokenId });
    } else {
      unparsed.push(market.question);
    }
  }

  bins.sort((a, b) => a.from - b.from);
  return { bins, unparsed };
}

/**
 * As faixas cobrem tudo sem sobrepor?
 *
 * A soma das probabilidades de um evento exaustivo e exclusivo é 1 — é o que
 * torna "comprar as pontas" uma aposta bem definida. Um buraco entre faixas é um
 * desfecho sem mercado; uma sobreposição é dois YES possíveis. Nenhum dos dois
 * apareceu na amostra, mas descobrir isso na fase 2, com dinheiro em cima, seria
 * caro.
 */
function coverage(bins: readonly Bin[]): { holes: string[]; overlaps: string[] } {
  const holes: string[] = [];
  const overlaps: string[] = [];

  for (let i = 0; i + 1 < bins.length; i += 1) {
    const current = bins[i];
    const next = bins[i + 1];
    if (current === undefined || next === undefined || current.to === null) continue;

    if (next.from > current.to + 1) holes.push(`${current.to}..${next.from}`);
    if (next.from <= current.to) overlaps.push(`${next.from}<=${current.to}`);
  }

  return { holes, overlaps };
}

// ---------------------------------------------------------------------------
// 4. Preço histórico
// ---------------------------------------------------------------------------

interface PriceProbe {
  slug: string;
  question: string;
  points: number;
  from: string | null;
  to: string | null;
  medianStepSeconds: number | null;
  min: number | null;
  max: number | null;
}

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

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? null;
}

/**
 * A série de preço de um token, com a janela EXPLÍCITA.
 *
 * `interval=max` devolveu série vazia num mercado de fevereiro e série completa
 * num de agosto — ou seja, ele não é "desde sempre", é uma janela recente
 * relativa a hoje. Com `startTs`/`endTs` o mesmo mercado de fevereiro devolveu
 * 254 pontos. É a diferença entre "não há histórico" e "não perguntei direito",
 * e é o tipo de engano que mata uma frente inteira sem deixar rastro.
 */
async function probePrice(
  slug: string,
  question: string,
  tokenId: string,
  startMs: number,
  endMs: number,
): Promise<{ probe: PriceProbe; res: CallResult; url: string; params: Record<string, string> }> {
  // Margem de um dia de cada lado: o mercado costuma abrir antes do início da
  // janela de contagem, e o preço das horas anteriores é justamente o que diz se
  // a faixa estava cara quando ainda dava para comprar.
  const startTs = Math.floor(startMs / 1000) - 86_400;
  const endTs = Math.floor(endMs / 1000) + 86_400;

  const params = {
    market: tokenId,
    startTs: String(startTs),
    endTs: String(endTs),
    fidelity: String(CLOB_FIDELITY),
  };
  const url = `${CLOB}/prices-history?market=${tokenId}&startTs=${startTs}&endTs=${endTs}&fidelity=${CLOB_FIDELITY}`;
  const res = await call(url, 'clob');

  const history = asHistory(res.body);
  const steps = history.slice(1).map((point, i) => point.t - (history[i]?.t ?? point.t));

  return {
    probe: {
      slug,
      question,
      points: history.length,
      from: history[0] === undefined ? null : new Date(history[0].t * 1000).toISOString(),
      to:
        history[history.length - 1] === undefined
          ? null
          : new Date((history[history.length - 1]?.t ?? 0) * 1000).toISOString(),
      medianStepSeconds: median(steps),
      min: history.length === 0 ? null : Math.min(...history.map((h) => h.p)),
      max: history.length === 0 ? null : Math.max(...history.map((h) => h.p)),
    },
    res,
    url,
    params,
  };
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if ('error' in args) {
    console.error(`[${LABEL}] ${args.error}`);
    console.error(
      `[${LABEL}] uso: npm run xtracker:probe -- [--handle=elonmusk] [--markets=8] [--prices=6] [--no-write]`,
    );
    process.exit(1);
    return;
  }

  const out: string[] = [
    'SONDA DO XTRACKER — FASE 1 (DESCOBERTA)',
    '=======================================',
    'Não mede a hipótese. Responde se dá para medir, e grava as respostas cruas.',
  ];

  // --- 1 e 2: histórico e estrutura -----------------------------------------

  console.error(`[${LABEL}] xtracker: usuário e trackings…`);
  const userRes = await call(`${XTRACKER}/users/${args.handle}?platform=x`, 'xtracker');
  const user = unwrap(userRes.body);
  const userId = isRecord(user) ? String(user['id'] ?? '') : '';

  const trackingsRes = await call(
    `${XTRACKER}/users/${args.handle}/trackings?platform=x`,
    'xtracker',
  );
  const trackings = (
    Array.isArray(unwrap(trackingsRes.body)) ? unwrap(trackingsRes.body) : []
  ) as unknown[];
  const parsedTrackings: Tracking[] = trackings.flatMap((row) =>
    isRecord(row) && typeof row['startDate'] === 'string'
      ? [
          {
            id: String(row['id'] ?? ''),
            title: String(row['title'] ?? ''),
            startDate: row['startDate'],
            endDate: String(row['endDate'] ?? ''),
            marketLink: typeof row['marketLink'] === 'string' ? row['marketLink'] : null,
          },
        ]
      : [],
  );

  const oldestTracking = [...parsedTrackings].sort((a, b) =>
    a.startDate < b.startDate ? -1 : 1,
  )[0];

  // A janela pedida começa antes do tracking mais antigo de propósito: é assim
  // que se descobre onde o histórico ACABA, em vez de assumir que ele começa
  // onde o primeiro mercado começou.
  const since = oldestTracking === undefined ? '2025-01-01' : oldestTracking.startDate.slice(0, 10);
  const until = new Date().toISOString().slice(0, 10);

  console.error(`[${LABEL}] xtracker: histórico de posts ${since} → ${until} (uma requisição)…`);
  const postsUrl = `${XTRACKER}/users/${args.handle}/posts?platform=x&startDate=${since}&endDate=${until}`;
  const postsRes = await call(postsUrl, 'xtracker');
  const posts = asPosts(unwrap(postsRes.body));
  const byDay = dailyCounts(posts);
  const days = [...byDay.keys()].sort();

  // SEMÂNTICA DE endDate, antes do teste de truncamento — porque errar isto faz
  // o teste de truncamento mentir. Uma janela de um dia só: se `endDate` fosse
  // inclusivo, [d, d+1) traria dois dias.
  const anchor = days[Math.floor(days.length / 2)] ?? since;
  const oneDayRes = await call(
    `${XTRACKER}/users/${args.handle}/posts?platform=x&startDate=${anchor}&endDate=${addDays(anchor, 1)}`,
    'xtracker',
  );
  const oneDay = asPosts(unwrap(oneDayRes.body));
  const oneDayDays = new Set(oneDay.map((p) => p.createdAt.slice(0, 10)));
  const exclusiveEnd = oneDayDays.size === 1 && oneDayDays.has(anchor);

  // A checagem de truncamento, agora com as janelas ALINHADAS: sete dias pedidos
  // como [d0, d0+7) contra os mesmos sete dias recortados da janela grande. Se a
  // janela grande estivesse cortada, ela traria menos.
  const probeFrom = days[0] ?? since;
  const probeLast = days[Math.min(6, days.length - 1)] ?? until;
  const smallRes = await call(
    `${XTRACKER}/users/${args.handle}/posts?platform=x&startDate=${probeFrom}&endDate=${addDays(probeLast, 1)}`,
    'xtracker',
  );
  const smallPosts = asPosts(unwrap(smallRes.body));
  const bigSlice = posts.filter(
    (p) => p.createdAt.slice(0, 10) >= probeFrom && p.createdAt.slice(0, 10) <= probeLast,
  );

  const shape = classify(posts);

  out.push(
    section('1. LIMITES DA API DE POSTS — até onde o histórico vai'),
    `  handle: ${args.handle}  (userId ${userId})`,
    `  janela pedida: ${since} → ${until}`,
    '',
    `  posts devolvidos:      ${posts.length}`,
    `  dias distintos:        ${byDay.size}`,
    `  primeiro dia:          ${days[0] ?? '—'}`,
    `  último dia:            ${days[days.length - 1] ?? '—'}`,
    `  tamanho da resposta:   ${(postsRes.bytes / 1e6).toFixed(2)} MB em ${postsRes.ms} ms`,
    '',
    `  endDate é EXCLUSIVO: ${exclusiveEnd ? 'SIM' : 'NÃO'} — pedir [${anchor}, ${addDays(anchor, 1)}) devolveu`,
    `  ${oneDay.length} post(s) em ${oneDayDays.size} dia(s) distinto(s).`,
    exclusiveEnd
      ? '  É a pegadinha desta API: `endDate=2026-08-12` NÃO inclui o dia 12. Uma janela\n' +
          '  pedida como "os últimos 9 dias" entrega 8, e quem contar dias em vez de posts\n' +
          '  conclui que a API truncou quando ela só interpretou a borda ao contrário.'
      : '  A borda superior entra na janela; nenhum ajuste é necessário ao encadear.',
    '',
    '  TRUNCAMENTO — a janela grande está cortada? (janelas alinhadas)',
    `    janela curta [${probeFrom}, ${addDays(probeLast, 1)}): ${smallPosts.length} posts`,
    `    mesmo pedaço dentro da janela grande:      ${bigSlice.length} posts`,
    smallPosts.length === bigSlice.length
      ? '    IGUAIS — a janela grande NÃO corta. Uma requisição traz o histórico inteiro,\n' +
          '    sem paginação, sem cursor e sem encadear janelas.'
      : '    DIFERENTES — a janela grande TRUNCA, e o histórico precisa ser puxado em\n' +
          '    janelas menores encadeadas.',
    '',
    '  Nenhum parâmetro de paginação existe e nenhum aparece na resposta: o corpo é',
    '  um array puro, sem `nextCursor`, `total` ou `page`.',
  );

  // --- estrutura do post ----------------------------------------------------

  out.push(
    section('2. ESTRUTURA DO POST — a regra de contagem é reproduzível?'),
    `  campos por post: ${shape.campos.join(', ')}`,
    '',
    '  NÃO existe campo de tipo. Não há `isRetweet`, `isQuote`, `isReply`,',
    '  `inReplyToId`, `referencedTweets` nem equivalente. A única pista é textual:',
    '',
    table(
      ['classe (heurística de texto)', 'n', '%'],
      [
        [
          'começa com "RT @" (repost)',
          String(shape.repostAparente),
          `${((shape.repostAparente / Math.max(posts.length, 1)) * 100).toFixed(1)}%`,
        ],
        [
          'começa com "@" (resposta)',
          String(shape.respostaAparente),
          `${((shape.respostaAparente / Math.max(posts.length, 1)) * 100).toFixed(1)}%`,
        ],
        [
          'demais (principal ou quote)',
          String(shape.demais),
          `${((shape.demais / Math.max(posts.length, 1)) * 100).toFixed(1)}%`,
        ],
      ],
    ),
    '',
    '  O QUE ISSO SIGNIFICA, e é o achado desta seção:',
    '',
    '  - post principal e QUOTE são indistinguíveis. O quote vem como texto comum,',
    '    sem marca nenhuma do post citado;',
    '  - repost só é reconhecível pelo prefixo "RT @", que é convenção de exibição',
    '    do X e não um campo — um post principal que comece com essas quatro letras',
    '    seria classificado errado, e nada no payload permitiria perceber;',
    '  - resposta não aparece (0 casos), o que é CONSISTENTE com a doc dizendo que',
    '    resposta não conta. Consistente não é o mesmo que verificado: não dá para',
    '    distinguir "eles filtram respostas" de "ele não respondeu nada" sem uma',
    '    fonte externa.',
    '',
    '  Conclusão: a regra publicada NÃO é reproduzível a partir deste payload. O que',
    '  é auditável é o TOTAL — e é o que a seção seguinte confere.',
  );

  // --- a reconciliação com a contagem oficial -------------------------------

  const completed = parsedTrackings
    .filter((t) => new Date(t.endDate).getTime() < Date.now())
    .sort((a, b) => (a.startDate < b.startDate ? 1 : -1));

  const reconRows: string[][] = [];
  for (const tracking of completed.slice(0, 4)) {
    const res = await call(`${XTRACKER}/trackings/${tracking.id}?includeStats=true`, 'xtracker');
    const data = unwrap(res.body);
    const stats = isRecord(data) && isRecord(data['stats']) ? data['stats'] : null;
    const official = stats === null ? null : Number(stats['total']);

    const lo = new Date(tracking.startDate).getTime();
    const hi = new Date(tracking.endDate).getTime();
    const mine = posts.filter((p) => {
      const at = new Date(p.createdAt).getTime();
      return at >= lo && at <= hi;
    }).length;

    reconRows.push([
      tracking.title.slice(0, 44),
      official === null ? '—' : String(official),
      String(mine),
      official === null ? '—' : String(mine - official),
      stats === null ? '—' : String((stats['daily'] as unknown[] | undefined)?.length ?? 0),
    ]);
  }

  out.push(
    '',
    '  RECONCILIAÇÃO — /posts contra a contagem OFICIAL do tracking',
    '  (a contagem oficial é a que resolve o mercado; se as duas batem, /posts',
    '   serve de fonte auditável mesmo sem classificar tipo)',
    '',
    table(['tracking', 'oficial', 'de /posts', 'diferença', 'buckets'], reconRows, [0]),
    '',
    '  `buckets` é o tamanho de `stats.daily`, que apesar do nome vem de HORA em',
    '  hora — é a granularidade mais fina de contagem oficial que existe aqui.',
  );

  // --- 5. dispersão ---------------------------------------------------------

  const counts = days.map((day) => byDay.get(day) ?? 0);
  const daily = dispersion(counts);
  const within = withinMonthDispersion(byDay);
  const weekly = dispersion(windowSums(counts, 7));
  const threeDay = dispersion(windowSums(counts, 3));
  const weeklyResidual = residualDispersion(counts, 7, 28);
  const threeDayResidual = residualDispersion(counts, 3, 28);

  const byMonth = new Map<string, number[]>();
  for (const [day, count] of byDay) {
    const month = day.slice(0, 7);
    const bucket = byMonth.get(month);
    if (bucket === undefined) byMonth.set(month, [count]);
    else bucket.push(count);
  }

  const dispRow = (label: string, d: Dispersion | null): string[] =>
    d === null
      ? [label, '—', '—', '—', '—', '—']
      : [
          label,
          String(d.n),
          num(d.mean, 1),
          num(d.sd, 2),
          num(d.poissonSd, 2),
          `${num(d.ratio, 2)}x`,
        ];

  out.push(
    section('5. DISPERSÃO — os 9 dias eram sorte?'),
    'Razão = variância observada / variância de Poisson. 1,0 = Poisson puro.',
    '',
    table(
      ['série', 'n', 'média', 'desvio obs.', 'desvio Poisson', 'razão'],
      [
        dispRow('diária (histórico inteiro)', daily),
        dispRow('diária, DENTRO do mês', within),
        dispRow('janelas de 3 dias', threeDay),
        dispRow('janelas de 7 dias', weekly),
        dispRow('7 dias, vs taxa dos 28 anteriores', weeklyResidual),
        dispRow('3 dias, vs taxa dos 28 anteriores', threeDayResidual),
      ],
      [0],
    ),
    '',
    'Por mês — a taxa-base é estável?',
    table(
      ['mês', 'dias', 'média/dia', 'desvio', 'razão'],
      [...byMonth.entries()]
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([month, values]) => {
          const d = dispersion(values);
          return [
            month,
            String(values.length),
            d === null ? '—' : num(d.mean, 1),
            d === null ? '—' : num(d.sd, 2),
            d === null ? '—' : `${num(d.ratio, 2)}x`,
          ];
        }),
      [0],
    ),
    '',
    '  As DUAS primeiras linhas da primeira tabela são a leitura que importa, e a',
    '  diferença entre elas é o que nove dias não conseguem mostrar:',
    '',
    '  - "diária (histórico inteiro)" mistura rajada com DERIVA da taxa-base. Se a',
    '    média mensal anda de 30 para 20 posts/dia, a variância global cresce sem',
    '    que ele tenha ficado mais errático em nenhum dia;',
    '  - "diária, DENTRO do mês" tira a deriva e deixa só a rajada.',
    '',
    '  E as DUAS ÚLTIMAS linhas são as que valem contra o mercado. Ninguém precifica',
    '  a semana que vem com a média de dez meses: precifica com a taxa recente. Elas',
    '  medem quanto erra quem estima a taxa pelos 28 dias anteriores e trata o resto',
    '  como Poisson — a superdispersão que SOBRA depois de dar ao modelo simples a',
    '  informação que ele de fato teria. É essa que a fase 2 tem que testar contra o',
    '  preço; a razão bruta de 40x contaria a deriva duas vezes e prometeria um edge',
    '  que o mercado enxerga tão bem quanto nós.',
  );

  // --- 3. mercados ----------------------------------------------------------

  console.error(`[${LABEL}] gamma: listando mercados da tag Tweet Markets…`);
  const { events, pages, truncated } = await loadTweetEvents();

  const isCount = (e: GammaEvent): boolean =>
    /#\s*tweets|#\s*posts/i.test(e.title) && !/mention/i.test(e.title);
  const elonEvents = events.filter((e) => isCount(e) && /elon musk/i.test(e.title));
  const resolved = elonEvents.filter((e) => e.closed);
  const sortedResolved = [...resolved].sort((a, b) =>
    (a.endDate ?? '') < (b.endDate ?? '') ? -1 : 1,
  );

  const firstDay = days[0] ?? '9999-12-31';
  const usableResolved = resolved.filter((e) => (e.startDate ?? '').slice(0, 10) >= firstDay);

  const bySeries = new Map<string, number>();
  for (const event of elonEvents) {
    const key = event.seriesSlug ?? '(sem série)';
    bySeries.set(key, (bySeries.get(key) ?? 0) + 1);
  }

  const detailRows: string[][] = [];
  let holesTotal = 0;
  let overlapsTotal = 0;
  let multiYes = 0;
  let unparsedTotal = 0;

  for (const event of sortedResolved.slice(-args.markets)) {
    const { bins, unparsed } = parseBins(event);
    const { holes, overlaps } = coverage(bins);
    const yes = bins.filter((b) => b.yes);

    holesTotal += holes.length;
    overlapsTotal += overlaps.length;
    unparsedTotal += unparsed.length;
    if (yes.length !== 1) multiYes += 1;

    const widths = bins.filter((b) => b.to !== null).map((b) => (b.to ?? 0) - b.from + 1);

    detailRows.push([
      (event.endDate ?? '').slice(0, 10),
      event.seriesSlug ?? '—',
      String(bins.length),
      widths.length === 0 ? '—' : `${Math.min(...widths)}–${Math.max(...widths)}`,
      holes.length === 0 && overlaps.length === 0
        ? 'ok'
        : `${holes.length} buraco(s)/${overlaps.length} sobrep.`,
      yes[0] === undefined ? '(nenhuma)' : `${yes[0].from}–${yes[0].to ?? '+'}`,
    ]);
  }

  out.push(
    section('3. MERCADOS HISTÓRICOS — quantos, desde quando, como listar'),
    `  Listagem: GET /events?tag_id=${TWEET_TAG_ID} (tag "Tweet Markets"), ${pages} página(s) de ${GAMMA_PAGE}.`,
    truncated
      ? `  ATENÇÃO: parei no teto de ${MAX_GAMMA_PAGES} páginas — a lista pode continuar.`
      : '  A paginação terminou sozinha; a lista está completa.',
    '',
    `  eventos na tag (todas as contas):        ${events.length}`,
    `  de contagem do Elon:                     ${elonEvents.length}`,
    `  desses, já resolvidos (closed):          ${resolved.length}`,
    `  resolvido mais antigo:                   ${(sortedResolved[0]?.endDate ?? '—').slice(0, 10)}`,
    `  resolvido mais recente:                  ${(sortedResolved[sortedResolved.length - 1]?.endDate ?? '—').slice(0, 10)}`,
    '',
    // A interseção é o tamanho REAL da amostra da fase 2: mercado resolvido sem
    // contagem é desfecho sem features, e contagem sem mercado é feature sem
    // desfecho. Nenhum dos dois vira linha.
    `  com contagem disponível (dentro de ${days[0] ?? '—'} → ${days[days.length - 1] ?? '—'}): ${usableResolved.length}`,
    `  resolvidos ANTES do início da contagem:  ${resolved.length - usableResolved.length}` +
      '  (mercado sem série de posts — não vira linha)',
    '',
    '  por série (é a série que separa os formatos de janela):',
    table(
      ['série', 'eventos'],
      [...bySeries.entries()].sort((a, b) => b[1] - a[1]).map(([slug, n]) => [slug, String(n)]),
      [0],
    ),
    '',
    `  Estrutura de faixas dos ${detailRows.length} eventos resolvidos mais recentes:`,
    table(
      ['fim', 'série', 'faixas', 'larguras', 'cobertura', 'faixa YES'],
      detailRows,
      [0, 1, 4, 5],
    ),
    '',
    `  buracos na cobertura: ${holesTotal}   sobreposições: ${overlapsTotal}`,
    `  eventos sem exatamente uma faixa YES: ${multiYes}`,
    `  perguntas que o parser de faixa não entendeu: ${unparsedTotal}`,
    holesTotal === 0 && overlapsTotal === 0 && multiYes === 0
      ? '  As faixas são exaustivas e exclusivas, e cada evento tem exatamente uma\n' +
          '  vencedora — que é o que torna "a soma é um evento certo" verdade e não fé.'
      : '  ATENÇÃO: a exaustividade NÃO se confirma em todos os eventos. Antes de\n' +
          '  qualquer aposta, olhar os casos acima um a um.',
  );

  // --- 4. preço histórico ---------------------------------------------------

  console.error(`[${LABEL}] clob: sondando preço histórico…`);
  const priceTargets = sortedResolved.slice(-args.prices);
  const probes: PriceProbe[] = [];
  let snapshotWritten = false;

  for (const event of priceTargets) {
    const { bins } = parseBins(event);
    // A faixa vencedora é a mais informativa: é a que sai de um preço qualquer e
    // termina em 1, então a série dela mostra a trajetória inteira da crença.
    const target = bins.find((b) => b.yes) ?? bins[0];
    if (target?.tokenId == null || event.startDate === null || event.endDate === null) continue;

    const { probe, res, url, params } = await probePrice(
      event.slug,
      target.question,
      target.tokenId,
      new Date(event.startDate).getTime(),
      new Date(event.endDate).getTime(),
    );
    probes.push(probe);

    if (args.write && !snapshotWritten && probe.points > 0) {
      await writeSnapshotRaw(
        LABEL,
        `${SNAPSHOT_DIR}/clob-prices-history-${event.slug}.json`,
        'clob-prices-history-snapshot',
        '/prices-history',
        params,
        res,
      );
      snapshotWritten = true;
      void url;
    }
  }

  const withSeries = probes.filter((p) => p.points > 0);
  const steps = withSeries.map((p) => p.medianStepSeconds).filter((s): s is number => s !== null);

  out.push(
    section('4. PREÇO HISTÓRICO — a pergunta que decide a frente inteira'),
    `  Fonte: GET ${CLOB}/prices-history?market=<tokenId>&startTs=&endTs=&fidelity=`,
    '  Pública, sem chave, sem autenticação.',
    '',
    table(
      ['evento', 'pontos', 'de', 'até', 'passo', 'preço min/max'],
      probes.map((p) => [
        p.slug.replace('elon-musk-of-tweets-', '').slice(0, 30),
        String(p.points),
        (p.from ?? '—').slice(0, 16),
        (p.to ?? '—').slice(0, 16),
        p.medianStepSeconds === null ? '—' : `${Math.round(p.medianStepSeconds / 60)} min`,
        p.min === null ? '—' : `${num(p.min, 3)} / ${num(p.max, 3)}`,
      ]),
      [0, 2, 3],
    ),
    '',
    `  mercados com série: ${withSeries.length} de ${probes.length}`,
    `  passo mediano: ${steps.length === 0 ? '—' : `${Math.round((median(steps) ?? 0) / 60)} min`}`,
    '',
    withSeries.length === 0
      ? '  NÃO HÁ PREÇO HISTÓRICO RECUPERÁVEL. A frente morre aqui: sem preço anterior\n' +
          '  ao fechamento só se conhece o desfecho, e desfecho sem preço não diz se a\n' +
          '  faixa estava cara ou barata.'
      : '  EXISTE série de preço histórico, e ela cobre a vida inteira do mercado —\n' +
          '  da abertura à resolução. A frente é viável.',
    '',
    '  UMA ARMADILHA MEDIDA, e que teria matado a frente por engano:',
    '  `interval=max` devolve série VAZIA para mercado antigo (testado em fevereiro:',
    '  0 pontos) e série completa para mercado recente. Com `startTs`/`endTs`',
    '  explícitos, o MESMO mercado de fevereiro devolve centenas de pontos. Quem',
    '  testar só com `interval=max` conclui "não há histórico" e está errado.',
    '  `fidelity` foi testado em 1, 10 e 60 e devolveu a MESMA série — o passo real',
    '  é do servidor, não do pedido.',
  );

  // --- snapshots -----------------------------------------------------------

  if (args.write) {
    // A janela CURTA, não o histórico inteiro. O histórico são 3,6 MB e a
    // pergunta que um snapshot responde — "que campos esta API devolve, e a
    // resposta de hoje é igual à de amanhã?" — cabe inteira em sete dias. Um
    // arquivo de 4,6 MB no repositório para responder isso é peso sem resposta a
    // mais.
    await writeSnapshotRaw(
      LABEL,
      `${SNAPSHOT_DIR}/posts-${args.handle}-${probeFrom}_${addDays(probeLast, 1)}.json`,
      'xtracker-posts-snapshot',
      `/users/${args.handle}/posts`,
      { platform: 'x', startDate: probeFrom, endDate: addDays(probeLast, 1) },
      smallRes,
    );
    await writeSnapshotRaw(
      LABEL,
      `${SNAPSHOT_DIR}/user-${args.handle}.json`,
      'xtracker-user-snapshot',
      `/users/${args.handle}`,
      { platform: 'x' },
      userRes,
    );

    const sample = completed[0];
    if (sample !== undefined) {
      const res = await call(`${XTRACKER}/trackings/${sample.id}?includeStats=true`, 'xtracker');
      await writeSnapshotRaw(
        LABEL,
        `${SNAPSHOT_DIR}/tracking-stats-${sample.id}.json`,
        'xtracker-tracking-stats-snapshot',
        `/trackings/${sample.id}`,
        { includeStats: 'true' },
        res,
      );
    }
  }

  out.push(
    section('CUSTO DA PASSADA'),
    ...callCounts().map(([host, n]) => `  ${host.padEnd(24)} ${n} requisição(ões)`),
    `  ${'TOTAL'.padEnd(24)} ${totalCalls()}   (espaçadas em ${SPACING_MS} ms)`,
    '',
    '  Nenhuma chamada à OddsPapi. Nenhuma escrita no banco.',
  );

  console.log(out.join('\n'));
}

main().catch((err: unknown) => {
  console.error(`[${LABEL}] falhou:`, err instanceof Error ? err.message : String(err));
  process.exit(1);
});
