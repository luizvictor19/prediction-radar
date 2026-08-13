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
  writeSnapshot,
} from './lib/probe-net.js';
import type { CandidateGroup, PairingMarket } from './lib/market-pairing.js';
import {
  DEFAULT_COST_MODEL,
  DEFAULT_PAIRING_CONFIG,
  estimateExtractorCost,
  generateCandidates,
  sampleDiscardedPairs,
} from './lib/market-pairing.js';

/**
 * Sonda do universo Polymarket — spec 003, fase 1.
 *
 * Ela NÃO escreve o extrator de relações. Ela produz o número que decide se o
 * extrator pode existir: quantas chamadas a um modelo custaria cobrir o universo,
 * e quanto isso dá em dólares. Se passar de umas poucas centenas, o desenho está
 * errado e a fase 2 não começa — volta-se ao gerador de candidatos, não ao
 * modelo.
 *
 * Três perguntas sustentam esse número:
 *
 * 1. **Quantos mercados existem** — o N que vira N² se ninguém filtrar.
 * 2. **As regras de resolução vêm no payload?** Sem o texto das regras o agente
 *    não tem como declarar diferença de fonte, e a `ressalvaDeResolucao` da spec
 *    vira teatro. É a pergunta que decide se a Parte B se sustenta.
 * 3. **Quanto já vem agrupado de graça** — evento, série, neg-risk. É a camada
 *    mais barata do gerador, e é de onde sai a `particiona`.
 *
 * ZERO LLM, por escrito na spec. SÓ LEITURA, e nem banco: não toca Supabase, não
 * escreve tabela, não roda migration. Nenhuma chamada à OddsPapi. O que ela
 * escreve são snapshots crus em `probes/polymarket/`.
 *
 * ## Por que contar é a parte difícil
 *
 * A Gamma não tem endpoint de contagem, o `offset` estoura em 2000 e o `limit`
 * satura em 100. Paginar por cursor até o fim custaria centenas de megabytes só
 * para saber o tamanho do universo.
 *
 * A saída é cortar por `endDate`: uma fatia de datas com menos de 2000 mercados
 * é contável por busca binária no offset, com respostas de `limit=1` que pesam
 * 7 KB. `countByDate` bissecta o calendário até toda folha caber nesse limite —
 * contagem EXATA por alguns megabytes, em vez de estimativa por centenas.
 *
 * E a árvore de contagem dá de graça o que a amostragem precisava: cada folha é
 * um estrato com tamanho conhecido. A amostra é proporcional a eles, e o peso de
 * cada mercado amostrado é exato em vez de suposto.
 *
 * ## Cortesia com uma API pública e gratuita
 *
 * Toda chamada passa por `call`, que espaça em `SPACING_MS` e conta — o relatório
 * imprime o total e os megabytes. O `--dry-run` conta o universo e para antes de
 * baixar qualquer amostra.
 *
 * ## Uso
 *
 *   npm run polymarket:universe -- --dry-run       # conta o universo e para
 *   npm run polymarket:universe                    # conta, amostra e roda o gerador
 *   npm run polymarket:universe -- --reuse-strata  # pula a contagem, usa a gravada
 *   npm run polymarket:universe -- --sample-events=600 --resolved-pages=6
 *   npm run polymarket:universe -- --no-write
 */

const LABEL = 'probe-universe';

const GAMMA = process.env['POLYMARKET_GAMMA_URL'] ?? 'https://gamma-api.polymarket.com';
const SNAPSHOT_DIR = 'probes/polymarket';

/**
 * `limit` satura em 100 por página — medido, não documentado. Pedir 1000 devolve
 * 100, sem erro e sem aviso; quem confia no parâmetro conclui que o universo tem
 * 100 mercados.
 */
const PAGE = 100;

/** Tamanho da página que vira snapshot no repositório. Ver a nota em `main`. */
const SNAPSHOT_LIMIT = 10;

/**
 * Teto DURO de `offset`: 2000. Acima disso vem HTTP 422 com
 * `"offset too large, use /events/keyset for deeper pagination"` — medido um a
 * um: 2000 devolve evento, 2001 já erra.
 *
 * É uma armadilha e vale o comentário: o erro chega como corpo JSON, e um leitor
 * que só olhe "veio array?" o confunde com "acabou a lista". Uma busca binária
 * ingênua converge no teto e reporta 2001 com cara de número exato — foi o que
 * a primeira versão desta sonda fez.
 */
const OFFSET_CEILING = 2000;

/**
 * O nome do parâmetro de cursor: `after_cursor`, e não `next_cursor`.
 *
 * A resposta devolve o campo chamado `next_cursor` e o parâmetro que o consome
 * se chama `after_cursor`. Passar `next_cursor` de volta NÃO dá erro: a Gamma
 * ignora o parâmetro desconhecido e devolve a PRIMEIRA página de novo, com o
 * mesmo cursor. Um laço de paginação sobre isso roda para sempre coletando a
 * mesma página, e o relatório sai dizendo 48.000 mercados quando viu 1.200.
 * Aconteceu aqui, e só apareceu porque a contagem de eventos únicos não batia.
 *
 * A lista de parâmetros verdadeira está em `GET /openapi.json`.
 */
const CURSOR_PARAM = 'after_cursor';

/** Janela do calendário para a árvore de contagem. */
const CALENDAR_START = '2015-01-01T00:00:00Z';
const CALENDAR_END = '2040-01-01T00:00:00Z';

/**
 * Granularidade mínima da bissecção: um minuto.
 *
 * Dia não basta. Um sábado de futebol tem mais de 2000 mercados abertos com
 * `endDate` no mesmo dia — cortar só por data deixa dezoito fatias saturadas e
 * a contagem vira piso em vez de número. `end_date_min`/`end_date_max` aceitam
 * ISO com hora, então a bissecção desce até onde precisar.
 */
const MIN_BUCKET_MS = 60_000;

/** Trava contra bissecção descontrolada se a Gamma mudar de comportamento. */
const MAX_BUCKETS = 600;

// ---------------------------------------------------------------------------
// Flags
// ---------------------------------------------------------------------------

interface Args {
  dryRun: boolean;
  /** Alvo de eventos abertos na amostra, distribuído entre os estratos. */
  sampleEvents: number;
  resolvedPages: number;
  write: boolean;
  /** Reaproveita a árvore de contagem gravada pela passada anterior. */
  reuseStrata: boolean;
}

const DEFAULTS: Args = {
  dryRun: false,
  sampleEvents: 1200,
  resolvedPages: 8,
  write: true,
  reuseStrata: false,
};

/**
 * Onde a árvore de contagem fica guardada.
 *
 * A contagem é a parte cara da sonda — ~2.000 requisições e oito minutos — e é
 * também a que menos muda de uma hora para a outra. Sem cache, mexer numa linha
 * do relatório custa outra varredura inteira numa API gratuita, e foi assim que
 * este arquivo nasceu.
 */
const STRATA_CACHE = `${SNAPSHOT_DIR}/strata.json`;

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
    if (arg === '--reuse-strata') {
      args.reuseStrata = true;
      continue;
    }

    const match = /^--(sample-events|resolved-pages)=(.+)$/.exec(arg);
    if (match === null) return { error: `argumento desconhecido: ${arg}` };

    const [, key, raw = ''] = match;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 0) {
      return { error: `--${key}=${raw} precisa ser um inteiro >= 0` };
    }
    if (key === 'sample-events') args.sampleEvents = value;
    else args.resolvedPages = Math.min(value, 20);
  }

  return args;
}

// ---------------------------------------------------------------------------
// Payload da Gamma (só o que esta sonda lê)
// ---------------------------------------------------------------------------

interface GammaMarket {
  id: string;
  question: string;
  description: string;
  resolutionSource: string;
  outcomePrices: string;
  clobTokenIds: string;
  umaResolutionStatuses: string;
  endDate: string | null;
  closed: boolean;
}

interface GammaEvent {
  id: string;
  title: string;
  endDate: string | null;
  negRisk?: boolean;
  enableNegRisk?: boolean;
  series?: Array<{ id: string }>;
  tags?: Array<{ slug: string }>;
  markets?: GammaMarket[];
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function asArray(body: unknown, key: string): unknown[] {
  if (Array.isArray(body)) return body;
  if (isRecord(body) && Array.isArray(body[key])) return body[key] as unknown[];
  return [];
}

/** `outcomePrices` e `clobTokenIds` vêm como STRING de JSON, não como array. */
function parseJsonArray(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map((v) => String(v)) : [];
  } catch {
    return [];
  }
}

let bytesDownloaded = 0;

async function get(path: string, params: Record<string, string>): Promise<CallResult> {
  const res = await call(`${GAMMA}${path}?${new URLSearchParams(params).toString()}`, 'gamma');
  bytesDownloaded += res.bytes;
  if (res.status !== 200) {
    throw new Error(`Gamma HTTP ${res.status} em ${path} ${JSON.stringify(params)}`);
  }
  return res;
}

/** Filtro de "mercado aberto de verdade": ativo, não fechado, não arquivado. */
const OPEN_FILTER = { closed: 'false', active: 'true', archived: 'false' } as const;

// ---------------------------------------------------------------------------
// Contagem exata por bissecção do calendário
// ---------------------------------------------------------------------------

interface Stratum {
  from: string;
  to: string;
  /** Contagem exata, ou `null` quando nem um dia inteiro coube abaixo do teto. */
  markets: number | null;
}

function ms(iso: string): number {
  return new Date(iso).getTime();
}

function iso(at: number): string {
  return new Date(at).toISOString();
}

/** Corta o segundo e o `Z` só para caber na tabela. */
function shortIso(value: string): string {
  return value.slice(0, 16).replace('T', ' ');
}

async function marketsExistAt(from: string, to: string, offset: number): Promise<boolean> {
  const res = await get('/markets', {
    ...OPEN_FILTER,
    limit: '1',
    end_date_min: from,
    end_date_max: to,
    offset: String(offset),
  });
  return asArray(res.body, 'markets').length > 0;
}

/**
 * Conta exatamente os mercados de uma fatia de datas, ou devolve `null` se ela
 * satura o teto de offset.
 *
 * Uma sondagem em `offset = OFFSET_CEILING` decide entre as duas: se ainda há
 * mercado lá, a fatia é grande demais e vale 1 requisição descobrir isso, em vez
 * das 11 da busca binária inteira.
 */
async function countSlice(from: string, to: string): Promise<number | null> {
  if (!(await marketsExistAt(from, to, 0))) return 0;
  if (await marketsExistAt(from, to, OFFSET_CEILING)) return null;

  let low = 0;
  let high = OFFSET_CEILING;
  while (high - low > 1) {
    const mid = Math.floor((low + high) / 2);
    if (await marketsExistAt(from, to, mid)) low = mid;
    else high = mid;
  }
  return low + 1;
}

/**
 * Bissecta o calendário até toda folha ser contável, e devolve os estratos.
 *
 * As folhas não são só a contagem: são a estratificação da amostra logo abaixo.
 * Uma fatia de datas com N mercados conhecidos permite amostrar dela em
 * proporção exata, o que é o que torna a extrapolação de custo uma conta e não
 * um chute.
 */
async function countByDate(): Promise<{ strata: Stratum[]; saturated: Stratum[] }> {
  const strata: Stratum[] = [];
  const saturated: Stratum[] = [];
  const queue: Array<[string, string]> = [[CALENDAR_START, CALENDAR_END]];

  let probed = 0;
  while (queue.length > 0 && strata.length + saturated.length < MAX_BUCKETS) {
    const [from, to] = queue.shift() as [string, string];
    const count = await countSlice(from, to);
    probed++;
    if (probed % 20 === 0) {
      console.error(
        `[${LABEL}] ${strata.length} estratos fechados, ${queue.length} na fila, ${totalCalls()} requisições`,
      );
    }

    if (count !== null) {
      if (count > 0) strata.push({ from, to, markets: count });
      continue;
    }

    const span = ms(to) - ms(from);
    if (span <= MIN_BUCKET_MS) {
      // 2000+ mercados abrindo e fechando no MESMO minuto. Não dá para contar
      // por esta rota, e a honestidade é registrar o piso em vez de fingir um
      // número.
      saturated.push({ from, to, markets: null });
      continue;
    }

    // Bissecta pelo MEIO do intervalo de tempo, não pela metade da contagem: a
    // densidade é altíssima nos próximos dias e quase nula em 2030, então
    // cortar pelo relógio converge rápido justamente onde está o volume.
    const mid = iso(ms(from) + Math.floor(span / 2));
    queue.push([from, mid], [mid, to]);
  }

  return { strata, saturated };
}

interface StrataCache {
  countedAt: string;
  strata: Stratum[];
  saturated: Stratum[];
}

async function readStrataCache(): Promise<StrataCache | null> {
  try {
    const { readFile } = await import('node:fs/promises');
    return JSON.parse(await readFile(STRATA_CACHE, 'utf8')) as StrataCache;
  } catch {
    return null;
  }
}

async function writeStrataCache(cache: StrataCache): Promise<void> {
  const { mkdir, writeFile } = await import('node:fs/promises');
  await mkdir(SNAPSHOT_DIR, { recursive: true });
  await writeFile(STRATA_CACHE, `${JSON.stringify(cache, null, 2)}\n`, 'utf8');
}

// ---------------------------------------------------------------------------
// Amostragem estratificada
// ---------------------------------------------------------------------------

async function fetchEventPage(
  extra: Record<string, string>,
  limit: number,
): Promise<{ events: GammaEvent[]; raw: CallResult }> {
  const res = await get('/events', { ...OPEN_FILTER, limit: String(limit), ...extra });
  return { events: asArray(res.body, 'events') as GammaEvent[], raw: res };
}

async function fetchResolvedPage(
  offset: number,
  endDateMax: string,
): Promise<{ events: GammaEvent[]; raw: CallResult }> {
  // Por `endDate` decrescente e com teto na data de hoje.
  //
  // Sem o teto a lista começa em 2029: a Gamma tem eventos FECHADOS com
  // `endDate` no futuro — "Who will be Trump's next Attorney General?" fecha em
  // 2029-01-19 e já está `closed: true`. Ordenar por data sem limitar traria
  // justamente os que ainda não resolveram, que é o oposto do que se quer.
  const res = await get('/events', {
    limit: String(PAGE),
    closed: 'true',
    order: 'endDate',
    ascending: 'false',
    end_date_max: endDateMax,
    offset: String(offset),
  });
  return { events: asArray(res.body, 'events') as GammaEvent[], raw: res };
}

// ---------------------------------------------------------------------------
// Conversão para o gerador
// ---------------------------------------------------------------------------

/**
 * Um mercado reduzido ao que esta sonda mede.
 *
 * Reduzido, e não a referência ao objeto da Gamma, porque uma página de eventos
 * são 4,6 MB. Guardar o payload cru de milhares de mercados para ler seis
 * booleanos de cada é o tipo de coisa que só aparece quando o processo morre por
 * memória no meio da varredura.
 */
interface Enriched {
  pairing: PairingMarket;
  hasPrice: boolean;
  hasTokenIds: boolean;
  hasRules: boolean;
  hasResolutionSource: boolean;
  umaPresent: boolean;
  /** Resolvido E com desfecho legível — é o que serve de teste automático. */
  outcomeKnown: boolean;
  /** Quantos mercados o evento dele tem. */
  siblings: number;
}

interface EventSummary {
  tags: string[];
  markets: number;
  negRisk: boolean;
}

function summarize(events: readonly GammaEvent[]): EventSummary[] {
  return events.map((e) => ({
    tags: (e.tags ?? []).map((t) => t.slug),
    markets: e.markets?.length ?? 0,
    negRisk: e.negRisk === true || e.enableNegRisk === true,
  }));
}

function toPairing(events: readonly GammaEvent[]): Enriched[] {
  const out: Enriched[] = [];

  for (const event of events) {
    const seriesId = event.series?.[0]?.id ?? null;
    const tags = (event.tags ?? []).map((t) => t.slug);
    // A chave de neg-risk é o EVENTO, não o mercado: `negRisk: true` no evento é
    // a API declarando que os mercados dele são mutuamente exclusivos e
    // exaustivos. O `negRiskRequestID` do mercado vem vazio mesmo em evento
    // neg-risk, então usá-lo perderia a partição.
    const negRiskKey = event.negRisk === true || event.enableNegRisk === true ? `event:${event.id}` : null;
    const siblings = event.markets?.length ?? 0;

    for (const market of event.markets ?? []) {
      const prices = parseJsonArray(str(market.outcomePrices));
      const tokenIds = parseJsonArray(str(market.clobTokenIds));
      const rules = str(market.description);
      const resolved = market.closed === true;
      // Mercado antigo (2020-21) devolve `["0","0"]` — nem sim nem não. Só o par
      // {"0","1"} é desfecho legível.
      const sorted = [...prices].sort();
      const outcomeKnown = resolved && prices.length === 2 && sorted[0] === '0' && sorted[1] === '1';

      out.push({
        pairing: {
          id: market.id,
          question: str(market.question),
          rules,
          eventId: event.id,
          seriesId,
          negRiskKey,
          tags,
          endDate: market.endDate,
          resolved,
        },
        hasPrice: prices.length > 0 && prices.some((p) => p !== ''),
        hasTokenIds: tokenIds.length > 0,
        hasRules: rules.trim().length > 0,
        hasResolutionSource: str(market.resolutionSource).trim().length > 0,
        umaPresent: str(market.umaResolutionStatuses).length > 2,
        outcomeKnown,
        siblings,
      });
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// Estatística auxiliar
// ---------------------------------------------------------------------------

function quantile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return 0;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  const a = sorted[lo] ?? 0;
  const b = sorted[hi] ?? a;
  return a + (b - a) * (pos - lo);
}

function pct(part: number, whole: number): string {
  return whole === 0 ? '—' : `${((100 * part) / whole).toFixed(1)}%`;
}

function distribution(values: readonly number[]): string {
  const sorted = [...values].sort((a, b) => a - b);
  return (
    `min ${num(sorted[0] ?? 0, 0)}  p25 ${num(quantile(sorted, 0.25), 0)}  ` +
    `mediana ${num(quantile(sorted, 0.5), 0)}  p75 ${num(quantile(sorted, 0.75), 0)}  ` +
    `p95 ${num(quantile(sorted, 0.95), 0)}  max ${num(sorted[sorted.length - 1] ?? 0, 0)}`
  );
}

function groupSizeRows(groups: readonly CandidateGroup[]): string[][] {
  const buckets: Array<[string, (n: number) => boolean]> = [
    ['2', (n) => n === 2],
    ['3', (n) => n === 3],
    ['4-5', (n) => n >= 4 && n <= 5],
    ['6-8', (n) => n >= 6 && n <= 8],
    ['9-12', (n) => n >= 9 && n <= 12],
    ['13-30', (n) => n >= 13 && n <= 30],
    ['31+', (n) => n >= 31],
  ];

  return buckets.map(([label, test]) => {
    const hit = groups.filter((g) => test(g.memberIds.length));
    return [
      label,
      String(hit.length),
      pct(hit.length, groups.length),
      String(hit.filter((g) => g.needsModel).length),
      String(hit.filter((g) => g.fullyResolved).length),
    ];
  });
}

function mb(): string {
  return `${(bytesDownloaded / 1048576).toFixed(1)} MB`;
}

// ---------------------------------------------------------------------------
// Principal
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  if ('error' in parsed) {
    console.error(`[${LABEL}] ${parsed.error}`);
    process.exit(2);
  }
  const args = parsed;

  const out: string[] = [
    section('SONDA DO UNIVERSO POLYMARKET — spec 003, fase 1'),
    `  Fonte: ${GAMMA} (Gamma, pública, sem chave)`,
    '  Zero chamadas a modelo. Zero escrita no banco. Zero OddsPapi.',
  ];

  // --- 0. contagem exata ----------------------------------------------------

  const cached = args.reuseStrata ? await readStrataCache() : null;
  if (cached !== null) {
    console.error(`[${LABEL}] reaproveitando a contagem de ${cached.countedAt} (${STRATA_CACHE})`);
  } else {
    console.error(`[${LABEL}] contando o universo por bissecção de calendário…`);
  }

  const countedAt = cached?.countedAt ?? new Date().toISOString();
  const { strata, saturated } = cached ?? (await countByDate());
  if (cached === null && args.write) {
    await writeStrataCache({ countedAt, strata, saturated });
  }

  const counted = strata.reduce((s, b) => s + (b.markets ?? 0), 0);
  const floorFromSaturated = saturated.length * (OFFSET_CEILING + 1);
  const universeMarkets = counted + floorFromSaturated;

  out.push(
    section('0. O UNIVERSO — quantos mercados abertos existem'),
    `  mercados abertos (active, não fechado, não arquivado): ${saturated.length > 0 ? '>= ' : ''}${universeMarkets.toLocaleString('pt-BR')}`,
    `  pares brutos C(N,2):                                   ~${Math.round((universeMarkets * (universeMarkets - 1)) / 2).toLocaleString('pt-BR')}`,
    '',
    `  estratos de data contados exatamente: ${strata.length}`,
    `  estratos que saturam o teto de offset: ${saturated.length}` +
      (saturated.length > 0 ? `  (contribuem só o piso de ${OFFSET_CEILING + 1} cada)` : ''),
    ...saturated.map(
      (b) => `    ${shortIso(b.from)} .. ${shortIso(b.to)}: >= ${OFFSET_CEILING + 1} mercados`,
    ),
    '',
    '  A spec 003 supõe "2.000 mercados abertos" e conclui 2 milhões de pares.',
    `  O universo real é ${(universeMarkets / 2000).toFixed(0)}x isso, e os pares, ${((universeMarkets / 2000) ** 2).toFixed(0)}x. A conta da Parte C`,
    '  está certa no método e errada na escala — o que só reforça a conclusão dela:',
    '  sem gerador de candidatos não existe orçamento.',
    '',
    '  os dez estratos mais densos:',
    table(
      ['de', 'até', 'mercados'],
      [...strata]
        .sort((a, b) => (b.markets ?? 0) - (a.markets ?? 0))
        .slice(0, 10)
        .map((b) => [shortIso(b.from), shortIso(b.to), String(b.markets)]),
      [0, 1],
    ),
    '',
    cached === null
      ? `  Custo até aqui: ${totalCalls()} requisições, ${mb()} — contagem EXATA, não estimativa.`
      : `  Contagem reaproveitada de ${countedAt} (--reuse-strata); 0 requisições gastas nela.`,
    '  Paginar o universo por cursor para chegar ao mesmo número custaria centenas',
    '  de megabytes: a resposta de uma página de 100 mercados pesa 650 KB, e a de',
    '  `limit=1` que a busca binária usa pesa 7 KB.',
    '',
    '  UMA ARMADILHA MEDIDA, e que já produziu um número falso nesta sonda: em',
    `  /events/keyset e /markets/keyset o cursor da resposta chama-se \`next_cursor\`,`,
    `  mas o parâmetro que o consome chama-se \`${CURSOR_PARAM}\`. Devolver`,
    '  `next_cursor` NÃO dá erro — a Gamma ignora parâmetro desconhecido e serve a',
    '  primeira página de novo, com o mesmo cursor. Um laço sobre isso coleta 40',
    '  vezes a mesma página e reporta 48.000 mercados tendo visto 1.200. A lista de',
    '  parâmetros verdadeira está em GET /openapi.json.',
  );

  if (args.dryRun) {
    out.push(
      section('CUSTO DA PASSADA'),
      ...callCounts().map(([host, n]) => `  ${host.padEnd(20)} ${n} requisição(ões)`),
      `  ${'TOTAL'.padEnd(20)} ${totalCalls()}   (espaçadas em ${SPACING_MS} ms, ${mb()})`,
      '',
      '  --dry-run: parei aqui. Sem --dry-run a sonda amostra e roda o gerador.',
    );
    console.log(out.join('\n'));
    return;
  }

  // --- 1. amostra estratificada ---------------------------------------------

  console.error(`[${LABEL}] amostrando ${args.sampleEvents} eventos em ${strata.length} estratos…`);

  // Proporcional ao tamanho do estrato, uma requisição por estrato. Amostrar
  // EVENTOS inteiros, e não mercados soltos, não é detalhe: a camada 1 agrupa
  // por evento, e um evento partido pela amostra viraria um grupo menor do que
  // é — o gerador pareceria pior do que é justamente na camada que mais rende.
  const totalForWeights = strata.reduce((s, b) => s + (b.markets ?? 0), 0);
  const open: Enriched[] = [];
  const openSummaries: EventSummary[] = [];
  let sampledMarkets = 0;

  for (const [i, bucket] of strata.entries()) {
    const share = (bucket.markets ?? 0) / Math.max(1, totalForWeights);
    const limit = Math.max(5, Math.min(PAGE, Math.round(args.sampleEvents * share)));

    // Offset pseudo-aleatório DENTRO do estrato, e não sempre zero.
    //
    // `offset=0` traz sempre os eventos de menor id — os mais antigos de cada
    // fatia de data. Isso não é amostra, é um viés sistemático: mercados
    // criados há mais tempo têm mais mercados irmãos e mais liquidez, e o
    // gerador pareceria melhor do que é. O passo primo espalha os offsets entre
    // os estratos sem depender de `Math.random`, que tornaria duas execuções
    // incomparáveis. Estimativa grosseira de eventos por estrato: mercados/12,
    // que é a mediana medida de mercados por evento.
    const eventsInStratum = Math.max(1, Math.floor((bucket.markets ?? 0) / 12));
    const room = Math.max(0, Math.min(OFFSET_CEILING - limit, eventsInStratum - limit));
    const offset = room === 0 ? 0 : (i * 7919) % room;

    const page = await fetchEventPage(
      { end_date_min: bucket.from, end_date_max: bucket.to, offset: String(offset) },
      limit,
    );
    open.push(...toPairing(page.events));
    openSummaries.push(...summarize(page.events));
    sampledMarkets = open.length;
    console.error(
      `[${LABEL}] ${bucket.from}..${bucket.to}: ${page.events.length} eventos, ${sampledMarkets} mercados acumulados`,
    );
  }

  // --- 2. resolvidos --------------------------------------------------------

  console.error(`[${LABEL}] paginando eventos resolvidos…`);
  const today = new Date().toISOString().slice(0, 10);
  const endDateMax = `${today}T23:59:59Z`;
  const resolved: Enriched[] = [];
  const resolvedSummaries: EventSummary[] = [];
  let resolvedPages = 0;

  for (let offset = 0; resolvedPages < args.resolvedPages && offset < OFFSET_CEILING; offset += PAGE) {
    const page = await fetchResolvedPage(offset, endDateMax);
    if (page.events.length === 0) break;
    resolved.push(...toPairing(page.events));
    resolvedSummaries.push(...summarize(page.events));
    resolvedPages++;
  }

  // --- snapshots ------------------------------------------------------------

  // Corpo CRU de uma página de cada rota, no formato das outras sondas: o hash
  // canônico responde "o conteúdo mudou?" e o cru, "a serialização mudou?".
  //
  // Página CURTA, e não a de 100 que a amostragem baixou. A pergunta que um
  // snapshot responde — "que campos esta API devolve, e a resposta de hoje é
  // igual à de amanhã?" — cabe inteira em dez eventos; a de 100 pesa 4,6 MB, e
  // pôr isso no repositório é peso sem resposta a mais. Mesma decisão que a
  // sonda do XTracker já tinha tomado, e pelo mesmo motivo.
  if (args.write) {
    const openSnap = await fetchEventPage(
      { end_date_min: strata[0]?.from ?? CALENDAR_START, end_date_max: strata[0]?.to ?? CALENDAR_END, offset: '0' },
      SNAPSHOT_LIMIT,
    );
    await writeSnapshot(
      LABEL,
      `${SNAPSHOT_DIR}/gamma-events-open.json`,
      'gamma-events-open-snapshot',
      '/events',
      {
        ...OPEN_FILTER,
        limit: String(SNAPSHOT_LIMIT),
        end_date_min: strata[0]?.from ?? CALENDAR_START,
        end_date_max: strata[0]?.to ?? CALENDAR_END,
      },
      openSnap.raw,
    );

    const resolvedSnap = await get('/events', {
      limit: String(SNAPSHOT_LIMIT),
      closed: 'true',
      order: 'endDate',
      ascending: 'false',
      end_date_max: endDateMax,
      offset: '0',
    });
    await writeSnapshot(
      LABEL,
      `${SNAPSHOT_DIR}/gamma-events-resolved.json`,
      'gamma-events-resolved-snapshot',
      '/events',
      { limit: String(SNAPSHOT_LIMIT), closed: 'true', order: 'endDate', ascending: 'false', end_date_max: endDateMax },
      resolvedSnap,
    );
  }

  const all = [...open, ...resolved];
  const allSummaries = [...openSummaries, ...resolvedSummaries];

  out.push(
    section('1. A AMOSTRA'),
    `  ABERTOS    eventos: ${openSummaries.length}   mercados: ${open.length}   (${pct(open.length, universeMarkets)} do universo aberto)`,
    `  RESOLVIDOS eventos: ${resolvedSummaries.length}   mercados: ${resolved.length}   (${resolvedPages} páginas, endDate <= ${today}, decrescente)`,
    '',
    '  A amostra dos abertos é estratificada por data, proporcional ao tamanho de',
    '  cada estrato, e amostra EVENTOS inteiros — a camada 1 agrupa por evento, e',
    '  um evento partido pela amostragem viraria um grupo menor do que é.',
    '',
    `  Resolvidos: o offset estoura em ${OFFSET_CEILING}, então esta rota alcança os ~${OFFSET_CEILING}`,
    '  eventos resolvidos mais recentes. Para ir além é /events/keyset, que pagina',
    '  por cursor mas ordena por id — ou seja, começa em 2020.',
    '',
    `  mercados/evento (abertos): ${distribution(openSummaries.map((e) => e.markets))}`,
  );

  // --- 3. as regras de resolução --------------------------------------------

  const withRules = all.filter((m) => m.hasRules);
  const withSource = all.filter((m) => m.hasResolutionSource);
  const umaPresent = all.filter((m) => m.umaPresent);

  out.push(
    section('2. AS REGRAS DE RESOLUÇÃO — a pergunta que decide a `ressalvaDeResolucao`'),
    `  \`description\` preenchido:          ${withRules.length}/${all.length}  (${pct(withRules.length, all.length)})`,
    `  \`resolutionSource\` preenchido:     ${withSource.length}/${all.length}  (${pct(withSource.length, all.length)})`,
    `  \`umaResolutionStatuses\` não-vazio: ${umaPresent.length}/${all.length}  (${pct(umaPresent.length, all.length)})`,
    '',
    `  tamanho de \`description\`, em caracteres: ${distribution(withRules.map((m) => m.pairing.rules.length))}`,
    '',
    withRules.length / Math.max(1, all.length) > 0.95
      ? '  SIM, as regras vêm no payload, em `description`, e vêm em praticamente todo\n' +
        '  mercado. É texto corrido e completo — fonte, data, condição de void, critério\n' +
        '  de "Yes". A `ressalvaDeResolucao` da Parte B é possível: o agente tem o que\n' +
        '  ler nas duas pontas para declarar diferença, e o campo não é teatro.\n' +
        '\n' +
        '  A ressalva sobre a ressalva: `resolutionSource` como CAMPO é quase sempre\n' +
        '  vazio. A fonte está DENTRO do texto de `description`, em prosa. Comparar\n' +
        '  fonte entre dois mercados é leitura, não igualdade de string — que é\n' +
        '  justamente a tarefa que a spec dá ao modelo, então não é problema. Mas mata\n' +
        '  qualquer atalho do tipo "só compare se `resolutionSource` bater".'
      : '  NÃO: as regras NÃO vêm de forma confiável no payload. A `ressalvaDeResolucao`\n' +
        '  não é implementável como a spec a descreve, e a Parte B precisa ser reescrita\n' +
        '  antes da fase 2.',
  );

  // --- 4. agrupamento de graça ----------------------------------------------

  const inMultiMarketEvent = all.filter((m) => m.siblings >= 2);
  const inNegRisk = all.filter((m) => m.pairing.negRiskKey !== null);
  const inSeries = all.filter((m) => m.pairing.seriesId !== null);

  out.push(
    section('3. O QUE JÁ VEM AGRUPADO DE GRAÇA'),
    table(
      ['estrutura', 'mercados', 'da amostra', 'o que ela declara'],
      [
        ['evento com 2+ mercados', String(inMultiMarketEvent.length), pct(inMultiMarketEvent.length, all.length), 'mesmo assunto; relação provável'],
        ['neg-risk', String(inNegRisk.length), pct(inNegRisk.length, all.length), 'exclusivos e exaustivos → `particiona`'],
        ['série', String(inSeries.length), pct(inSeries.length, all.length), 'mesma pergunta, janelas diferentes'],
      ],
      [0, 3],
    ),
    '',
    '  O neg-risk é o achado que muda a conta: quando o evento traz `negRisk: true`,',
    '  a API está DECLARANDO a partição. A `particiona` sai de graça, sem modelo, e',
    '  esses grupos saem da conta de custo — pagar por eles seria comprar o que a API',
    '  dá. Bate com a Parte H: a `particiona` é a mais fácil e a menos valiosa.',
    '',
    '  Cuidado medido: o `negRiskRequestID` do MERCADO vem vazio mesmo em evento',
    '  neg-risk. A chave que funciona é `negRisk`/`enableNegRisk` do EVENTO.',
  );

  // --- 5. estrutura no texto ------------------------------------------------

  const tagCounts = new Map<string, number>();
  for (const e of allSummaries) for (const t of e.tags) tagCounts.set(t, (tagCounts.get(t) ?? 0) + 1);
  const topTags = [...tagCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
  const withTags = allSummaries.filter((e) => e.tags.length > 0);
  const withEndDate = all.filter((m) => m.pairing.endDate !== null);

  out.push(
    section('4. ESTRUTURA NO TEXTO — tags, data, tamanho de pergunta'),
    `  eventos com tag:      ${withTags.length}/${allSummaries.length}  (${pct(withTags.length, allSummaries.length)})`,
    `  mercados com endDate: ${withEndDate.length}/${all.length}  (${pct(withEndDate.length, all.length)})`,
    '',
    `  tamanho da pergunta, em caracteres: ${distribution(all.map((m) => m.pairing.question.length))}`,
    '',
    '  tags mais frequentes:',
    table(['tag', 'eventos'], topTags.map(([slug, n]) => [slug, String(n)]), [0]),
    '',
    '  Tag vem de /events, não de /markets: a rota de mercados não traz `tags` nem',
    '  dentro do `events` embutido. Quem quiser tag tem que passar por evento.',
  );

  // --- 6. preço e tokens ----------------------------------------------------

  const withPrice = all.filter((m) => m.hasPrice);
  const withTokens = all.filter((m) => m.hasTokenIds);

  out.push(
    section('5. PREÇO E clobTokenIds — vêm juntos ou exigem chamada à parte?'),
    `  \`outcomePrices\` no payload: ${withPrice.length}/${all.length}  (${pct(withPrice.length, all.length)})`,
    `  \`clobTokenIds\` no payload:  ${withTokens.length}/${all.length}  (${pct(withTokens.length, all.length)})`,
    '',
    '  VÊM JUNTOS. Zero chamadas extras: uma página de /events traz pergunta, regras,',
    '  preço e token id dos mercados dela. O extrator não precisa do CLOB para montar',
    '  o prompt, e a checagem aritmética da desigualdade (`P(A) <= P(B)`) roda sobre o',
    '  preço que já veio.',
    '',
    '  Os dois vêm como STRING de JSON, não como array — `"[\\"0.04\\", \\"0.96\\"]"`.',
    '  Quem não fizer o parse duplo lê um preço que é texto e compara errado.',
  );

  // --- 7. o gerador ---------------------------------------------------------

  console.error(`[${LABEL}] gerando candidatos sobre ${all.length} mercados…`);
  const universe = all.map((m) => m.pairing);
  const result = generateCandidates(universe, DEFAULT_PAIRING_CONFIG);
  const stats = result.stats;

  const modelGroups = result.groups.filter((g) => g.needsModel);
  const freeGroups = result.groups.filter((g) => !g.needsModel);

  out.push(
    section('6. O GERADOR DE CANDIDATOS — de N² para grupos'),
    `  mercados na amostra:        ${stats.markets}`,
    `  pares brutos C(N,2):        ${stats.totalPairs.toLocaleString('pt-BR')}`,
    `  pares cobertos por grupo:   ${stats.pairsCovered.toLocaleString('pt-BR')}  (${pct(stats.pairsCovered, stats.totalPairs)})`,
    `  pares descartados:          ${stats.pairsDiscarded.toLocaleString('pt-BR')}  (${pct(stats.pairsDiscarded, stats.totalPairs)})`,
    '',
    `  grupos:                     ${stats.groups}`,
    `  ... que precisam de modelo: ${modelGroups.length}`,
    `  ... de graça (neg-risk):    ${freeGroups.length}`,
    `  mercados órfãos:            ${stats.orphanMarkets}  (${pct(stats.orphanMarkets, stats.markets)})`,
    `  tamanho de grupo:           ${distribution(result.groups.map((g) => g.memberIds.length))}`,
    '',
    '  distribuição de tamanho:',
    table(['membros', 'grupos', 'do total', 'c/ modelo', 'todos resolvidos'], groupSizeRows(result.groups), [0]),
    '',
    `  Teto de grupo: ${DEFAULT_PAIRING_CONFIG.maxGroupSize} membros (${DEFAULT_PAIRING_CONFIG.maxStructuralGroupSize} para grupo estrutural que vira prompt).`,
    '  O que manda não é o contexto: um mercado custa ~150 tokens de pergunta +',
    `  regras, então ${DEFAULT_PAIRING_CONFIG.maxGroupSize} membros são ~2,7k tokens — um terço do prompt v2 do`,
    `  analista, que já roda em produção. O que manda é a carga de raciocínio: ${DEFAULT_PAIRING_CONFIG.maxGroupSize}`,
    `  membros são ${(DEFAULT_PAIRING_CONFIG.maxGroupSize * (DEFAULT_PAIRING_CONFIG.maxGroupSize - 1)) / 2} pares para julgar numa passada, e nesta spec precisão vale mais`,
    '  que cobertura — pedir mais troca as duas na direção errada.',
    '',
    '  Grupo neg-risk NÃO tem teto: ele não vira prompt nenhum, e a partição que a',
    '  API declarou vale para os 384 membros, não para os 60 primeiros.',
    '',
    '  descarte por camada:',
    table(
      ['camada', 'grupos', 'pares novos', 'redundantes', 'perdidos no teto', 'recusados'],
      stats.byLayer.map((l) => [
        `${l.layer} — ${l.layer === 1 ? 'estrutura' : l.layer === 2 ? 'entidades' : 'texto'}`,
        String(l.groups),
        l.pairsNew.toLocaleString('pt-BR'),
        l.pairsRedundant.toLocaleString('pt-BR'),
        l.pairsDroppedToCap.toLocaleString('pt-BR'),
        l.pairsRejected.toLocaleString('pt-BR'),
      ]),
      [0],
    ),
    '  ("redundantes" e "recusados" contam só pares que nenhuma camada anterior já',
    '   cobria — descarte inventado engana tanto quanto descarte silencioso.)',
    '',
    ...stats.byLayer.flatMap((l) => l.notes.slice(0, 4).map((note) => `  [camada ${l.layer}] ${note}`)),
  );

  // --- 8. auditoria do descarte ---------------------------------------------

  console.error(`[${LABEL}] auditando o descarte…`);
  const audit = sampleDiscardedPairs(universe, result, 3000);

  out.push(
    section('7. VOCÊ CONFIA NESSE DESCARTE?'),
    `  pares descartados sorteados: ${audit.sampled}`,
    `  maior Jaccard encontrado:    ${num(audit.maxSimilarity, 3)}  (limiar da camada 3: ${DEFAULT_PAIRING_CONFIG.textSimilarity})`,
    `  passariam do limiar:         ${audit.aboveThreshold}  (${pct(audit.aboveThreshold, Math.max(1, audit.sampled))})`,
    `  ... desses, do mesmo evento: ${audit.aboveThresholdSameEvent}  (apontaria teto de grupo, não limiar)`,
    '',
    '  os pares descartados mais parecidos da amostra:',
    table(
      ['jaccard', 'mesmo ev.', 'pergunta A', 'pergunta B'],
      audit.worst.map((w) => [num(w.similarity, 3), w.sameEvent ? 'sim' : 'não', w.a.slice(0, 40), w.b.slice(0, 40)]),
      [1, 2, 3],
    ),
    '',
    audit.aboveThreshold === 0
      ? '  Nenhum par descartado passaria do limiar. O descarte é o que diz ser: o que\n' +
        '  sai é o que não se parece com nada. Isso NÃO prova que não há relação lógica\n' +
        '  entre perguntas escritas de formas muito diferentes — prova que a heurística\n' +
        '  aplica o próprio critério, e não perde por defeito. A relação parafraseada\n' +
        '  segue sendo o ponto fraco conhecido, e na assimetria da Parte E ela custa\n' +
        '  zero: perder relação não perde dinheiro; inventar relação perde.'
      : audit.aboveThresholdSameEvent > audit.aboveThreshold / 2
        ? '  ATENÇÃO: há par descartado acima do limiar, e a MAIORIA é do mesmo evento.\n' +
          '  Isso é teto de grupo cortando estrutura, não limiar mal escolhido. Subir\n' +
          '  `maxStructuralGroupSize`, ou conferir se um grupo que não vira prompt está\n' +
          '  sendo truncado à toa.'
        : '  ATENÇÃO: há par descartado acima do limiar, e ele NÃO é do mesmo evento.\n' +
          '  Isso é o índice invertido perdendo par que não compartilha token raro.\n' +
          '  Baixar `invertedIndexDfCeiling` antes da fase 2.',
  );

  // --- 9. a aritmética ------------------------------------------------------

  const cheap = estimateExtractorCost(result.groups, DEFAULT_COST_MODEL, false);
  const pessimistic = estimateExtractorCost(result.groups, DEFAULT_COST_MODEL, true);
  const openOnly = Math.max(1, open.length);
  const scale = universeMarkets / openOnly;
  const callsPerMarket = cheap.calls / stats.markets;
  const usdPerCall = cheap.calls === 0 ? 0 : cheap.usd / cheap.calls;
  const avgGroupSize =
    stats.groups === 0
      ? 2
      : result.groups.reduce((s, g) => s + g.memberIds.length, 0) / stats.groups;
  const layer1 = estimateExtractorCost(result.groups.filter((g) => g.layer === 1 && g.needsModel));

  out.push(
    section('8. A ARITMÉTICA — quantas chamadas, quantos dólares'),
    `  Preço: ${DEFAULT_COST_MODEL.model}, US$ ${DEFAULT_COST_MODEL.inputPerMTok}/MTok de entrada, US$ ${DEFAULT_COST_MODEL.outputPerMTok}/MTok de saída.`,
    '  Ancorado no medido, não em média por chamada: `esports_analyses` tem 178',
    '  análises em sonnet-4-6/medium — a v1 gastou 3.423 tokens de entrada e 319 de',
    '  saída (US$ 0,0151); a v2, 8.714 e 359 (US$ 0,0315). Os dois batem com esse',
    '  preço por token, e é por token que a conta é feita: o prompt do extrator tem',
    '  tamanho próprio e a média do analista não sabe disso.',
    '',
    `  NA AMOSTRA (${stats.markets} mercados):`,
    table(
      ['cenário', 'chamadas', 'tok entrada', 'tok saída', 'US$'],
      [
        ['emite só o que achar', cheap.calls.toLocaleString('pt-BR'), cheap.inputTokens.toLocaleString('pt-BR'), cheap.outputTokens.toLocaleString('pt-BR'), num(cheap.usd, 2)],
        ['um veredito por par (teto)', pessimistic.calls.toLocaleString('pt-BR'), pessimistic.inputTokens.toLocaleString('pt-BR'), pessimistic.outputTokens.toLocaleString('pt-BR'), num(pessimistic.usd, 2)],
      ],
      [0],
    ),
    '',
    `  custo por chamada:  US$ ${num(usdPerCall, 4)}`,
    `  chamadas/mercado:   ${num(callsPerMarket, 3)}`,
    '',
    '  E o mesmo custo repartido por camada — a tabela que decide o que ligar:',
    table(
      ['camada', 'chamadas', 'US$', 'pares novos', 'US$ / 1k pares'],
      [1, 2, 3].map((layer) => {
        const mine = result.groups.filter((g) => g.layer === layer && g.needsModel);
        const cost = estimateExtractorCost(mine);
        const fresh = stats.byLayer.find((l) => l.layer === layer)?.pairsNew ?? 0;
        return [
          `${layer} — ${layer === 1 ? 'estrutura' : layer === 2 ? 'entidades' : 'texto'}`,
          String(cost.calls),
          num(cost.usd, 2),
          fresh.toLocaleString('pt-BR'),
          fresh === 0 ? '—' : num((1000 * cost.usd) / fresh, 2),
        ];
      }),
      [0],
    ),
    '',
    `  EXTRAPOLADO PARA O UNIVERSO ABERTO (${universeMarkets.toLocaleString('pt-BR')} mercados, fator ${num(scale, 1)}x):`,
    `    chamadas:  ~${Math.round(cheap.calls * scale).toLocaleString('pt-BR')}`,
    `    US$:       ~${num(cheap.usd * scale, 0)}  (teto pessimista: ~${num(pessimistic.usd * scale, 0)})`,
    '',
    '  A extrapolação é LINEAR em mercados, e ela é justa na camada 1 e conservadora',
    '  nas outras duas: a camada 1 agrupa dentro do evento, então dobrar o universo',
    '  dobra os grupos dela; as camadas 2 e 3 comparam entre eventos, e numa amostra',
    `  de ${pct(open.length, universeMarkets)} elas veem muito menos vizinho do que veriam no universo`,
    '  inteiro. O número acima é PISO para elas.',
    '',
    '  O teto que fecha a conta por cima, e ele NÃO depende de amostra: cada mercado',
    '  entra em no máximo 4 grupos — um estrutural de evento OU de neg-risk (nunca os',
    '  dois: o neg-risk suprime o de evento), um de série, um balde de entidade (o da',
    '  entidade mais rara, e só um) e uma componente de texto (elas são disjuntas).',
    '  Logo as chamadas são no máximo 4N/tamanho médio de grupo, cresçam as camadas 2',
    '  e 3 o quanto crescerem.',
    `    pior caso (grupos de 2 membros):        ${Math.round((4 * universeMarkets) / 2).toLocaleString('pt-BR')} chamadas, US$ ${num(((4 * universeMarkets) / 2) * usdPerCall, 0)}`,
    `    com o tamanho médio medido (${num(avgGroupSize, 1)} membros): ${Math.round((4 * universeMarkets) / avgGroupSize).toLocaleString('pt-BR')} chamadas, US$ ${num(((4 * universeMarkets) / avgGroupSize) * usdPerCall, 0)}`,
    '',
    `  Comparação: par a par seriam ${stats.pairsCovered.toLocaleString('pt-BR')} chamadas para os MESMOS pares da`,
    `  amostra. O grupo em vez do par corta a conta por ${num(stats.pairsCovered / Math.max(1, cheap.calls), 0)}x, e é a decisão de`,
    '  desenho mais importante da fase.',
    '',
    `  SÓ A CAMADA 1, extrapolada para o universo: ~${Math.round(layer1.calls * scale).toLocaleString('pt-BR')} chamadas, ~US$ ${num(layer1.usd * scale, 0)}.`,
    `  Ela sozinha cobre ${pct(stats.byLayer[0]?.pairsNew ?? 0, stats.pairsCovered)} dos pares cobertos, e é a única camada cuja`,
    '  extrapolação linear é justa — as outras duas comparam entre eventos e crescem',
    '  mais rápido que N. Se o teto de gasto apertar, é por aqui que se corta, e o',
    '  corte é conhecido em vez de silencioso.',
  );

  // --- 10. a medição de graça -----------------------------------------------

  const resolvedGroups = result.groups.filter((g) => g.fullyResolved);
  const resolvedModelGroups = resolvedGroups.filter((g) => g.needsModel);
  const outcomeReadable = all.filter((m) => m.outcomeKnown).length;
  const resolvedTotal = all.filter((m) => m.pairing.resolved).length;

  out.push(
    section('9. A MEDIÇÃO QUE SAI DE GRAÇA — grupos inteiramente resolvidos'),
    '  Relação lógica é verificável contra o DESFECHO, e isso não precisa de humano:',
    '  se `A implica B` e ambos resolveram, uma resolução com A=SIM e B=NÃO refuta a',
    '  relação objetivamente. Vale para `implica`, `exclui`, `particiona` e',
    '  `equivale`. Não vale quando o antecedente nunca disparou — aí segue precisando',
    '  de rótulo humano, e a taxa disso é o que sobra para a Parte E.',
    '',
    `  mercados resolvidos na amostra:            ${resolvedTotal}  (${pct(resolvedTotal, all.length)})`,
    `  ... com desfecho legível em outcomePrices: ${outcomeReadable}  (${pct(outcomeReadable, Math.max(1, resolvedTotal))} dos resolvidos)`,
    '',
    `  grupos inteiramente resolvidos:            ${resolvedGroups.length}  (${pct(resolvedGroups.length, stats.groups)} dos grupos)`,
    `  ... e que precisam de modelo:              ${resolvedModelGroups.length}`,
    `  custo de rodar SÓ eles:                    US$ ${num(estimateExtractorCost(resolvedModelGroups).usd, 2)}`,
    '',
    '  Cuidado medido: mercado antigo (2020-21) devolve `["0","0"]` em',
    '  `outcomePrices` — nem sim nem não. Só o par {"0","1"} é desfecho legível, e é',
    '  por isso que a listagem de resolvidos é por `endDate` decrescente: os recentes',
    '  têm desfecho, os de 2020 não têm.',
  );

  // --- custo da passada -----------------------------------------------------

  out.push(
    section('CUSTO DA PASSADA'),
    ...callCounts().map(([host, n]) => `  ${host.padEnd(20)} ${n} requisição(ões)`),
    `  ${'TOTAL'.padEnd(20)} ${totalCalls()}   (espaçadas em ${SPACING_MS} ms, ${mb()})`,
    '',
    '  Nenhuma chamada a modelo. Nenhuma escrita no banco. Nenhuma OddsPapi.',
  );

  console.log(out.join('\n'));
}

main().catch((err: unknown) => {
  console.error(`[${LABEL}] falhou:`, err instanceof Error ? err.message : String(err));
  process.exit(1);
});
