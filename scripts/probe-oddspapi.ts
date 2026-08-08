import 'dotenv/config';

/**
 * Sonda da OddsPapi v4 — mede o que a leitura da documentação deixou em aberto.
 *
 * Não é enricher e não escreve nada. Existe para trocar quatro suposições por
 * medida ANTES de desenharmos o enricher:
 *
 *   1. `/v4/historical-odds` realmente não debita cota? A doc diz "always free,
 *      never increments request count". Isso decide a economia inteira do
 *      enricher: se for verdade, as 250 req/mês do Free pagam só a descoberta de
 *      fixtures, e o histórico é ilimitado (limitado só pelo cooldown de 5s).
 *      O teste é `/v4/account` antes e depois, com histórico no meio.
 *
 *   2. Quais casas o Free entrega de fato. A tela de Sports Access mostra várias
 *      com `Live: ❌`, e a página de pricing trata "número de bookmakers" como
 *      dimensão paga — enquanto o blog afirma que o Free vê as 350+. Uma das
 *      duas está errada, e é `/v4/bookmakers` que decide.
 *
 *   3. O quanto os nomes de time deles casam com `esports_teams.display_name`.
 *      Não há `pandascoreId` nem nada de Polymarket nos mapeamentos externos
 *      deles, então casamento é por nome + data — mesma classe de problema do
 *      enricher de Liquipedia. A diferença a favor: eles dão três variantes por
 *      lado (Name / ShortName / Abbr) contra o nome único da Liquipedia.
 *
 *   4. Densidade real do histórico: quantos movimentos de linha por casa numa
 *      partida de CS2, e se `createdAt` e `limit` vêm preenchidos. `createdAt` é
 *      o que torna a série point-in-time; `limit` (stake máximo) é o peso de
 *      confiança da casa na linha, e é o que faria uma discordância com o
 *      Polymarket valer mais ou menos no eval.
 *
 * ## Antes de rodar
 *
 *   ODDSPAPI_API_KEY=...
 *
 * ## Orçamento
 *
 * O Free dá 250 requisições/mês, e a contagem é por CHAMADA a endpoint billable
 * — tamanho da resposta não importa. Uma passada completa desta sonda gasta
 * **2 requisições billable** (`/v4/bookmakers` e `/v4/fixtures`). `/v4/account` e
 * `/v4/historical-odds` são declarados não-billable pela doc, e confirmar isso é
 * justamente o item 1. O contador abaixo separa as duas categorias e o relatório
 * final compara com o que a conta diz.
 *
 * Cooldowns documentados por endpoint (fixtures 2000ms, historical-odds 5000ms,
 * participants 1000ms) são respeitados aqui com margem.
 *
 * ## Uso
 *
 *   npm run oddspapi:probe
 *   npm run oddspapi:probe -- --from=2026-07-01 --to=2026-07-31
 *   npm run oddspapi:probe -- --bookmakers=pinnacle,ggbet,thunderpick
 *   npm run oddspapi:probe -- --fixture=id1704591169167084
 *   npm run oddspapi:probe -- --with-db      # cruza os nomes com esports_teams
 *
 * `--with-db` é opt-in de propósito: é a única parte que lê o banco de produção.
 * Sem a flag a sonda só fala com a OddsPapi, e imprime os nomes deles para
 * conferência a olho.
 */

const LABEL = 'probe-oddspapi';
const BASE = 'https://api.oddspapi.io';

/** CS2 na taxonomia deles. LoL = 18, Dota 2 = 16 — conferir com /v4/sports depois. */
const SPORT_CS2 = 17;

/**
 * Cooldown por endpoint, em ms, com margem sobre o documentado. Chave é o path.
 * O default cobre endpoint não listado — na dúvida, o mais lento.
 */
const COOLDOWN_MS: Readonly<Record<string, number>> = {
  '/v4/account': 1000,
  '/v4/bookmakers': 1500,
  '/v4/fixtures': 2500,
  '/v4/historical-odds': 5500,
};
const COOLDOWN_DEFAULT_MS = 5500;

/** Endpoints que a doc declara NÃO billable. É o que o item 1 põe à prova. */
const FREE_ENDPOINTS: ReadonlySet<string> = new Set(['/v4/account', '/v4/historical-odds']);

/**
 * Casas que interessam ao eval, em ordem de preferência para a amostra de
 * histórico. Pinnacle primeiro porque é a sharp de referência — é a linha contra
 * a qual a discordância do Polymarket significa alguma coisa. Depois as
 * especialistas em esports, que costumam ter mercado onde a mainstream não tem.
 */
const PREFERRED_BOOKMAKERS: readonly string[] = [
  'pinnacle',
  'ggbet',
  'thunderpick',
  'singbet',
  'bet365',
  'betway',
  'stake',
  '1xbet',
];

// ---------------------------------------------------------------------------
// Infra
// ---------------------------------------------------------------------------

function flag(name: string): string | null {
  const hit = process.argv
    .slice(2)
    .find((arg) => arg === `--${name}` || arg.startsWith(`--${name}=`));
  if (hit === undefined) return null;
  const [, value] = hit.split('=');
  return value ?? '';
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const lastCallAt = new Map<string, number>();
/** Piso entre chamadas quaisquer — o limitador deles não é só por endpoint. */
const GLOBAL_COOLDOWN_MS = 1200;
let lastAnyCallAt = 0;
let billableSpent = 0;
let freeSpent = 0;

interface CallResult {
  readonly ok: boolean;
  readonly status: number;
  readonly body: unknown;
  /** Só os headers com cara de cota/limite — é onde a contagem parece morar. */
  readonly meta: ReadonlyMap<string, string>;
}

/** Medido na primeira passada: o 429 traz `error.retryMs` com a espera exata. */
function retryMsOf(body: unknown): number | null {
  if (!isRecord(body)) return null;
  const err = body['error'];
  if (!isRecord(err)) return null;
  const ms = err['retryMs'];
  return typeof ms === 'number' ? ms : null;
}

async function call(
  path: string,
  params: Readonly<Record<string, string>> = {},
  attempt = 0,
): Promise<CallResult> {
  // Cooldown por endpoint E um piso global: a primeira passada levou 429 em
  // `/v4/account` logo depois de `/v4/fixtures`, com os dois muito acima do
  // cooldown individual. O limitador deles não é só por endpoint.
  const cooldown = COOLDOWN_MS[path] ?? COOLDOWN_DEFAULT_MS;
  const previous = lastCallAt.get(path);
  if (previous !== undefined) {
    const wait = cooldown - (Date.now() - previous);
    if (wait > 0) await sleep(wait);
  }
  const sinceAny = Date.now() - lastAnyCallAt;
  if (sinceAny < GLOBAL_COOLDOWN_MS) await sleep(GLOBAL_COOLDOWN_MS - sinceAny);

  const key = process.env['ODDSPAPI_API_KEY'] ?? '';
  const url = new URL(path, BASE);
  url.searchParams.set('apiKey', key);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  lastCallAt.set(path, Date.now());
  lastAnyCallAt = Date.now();
  if (attempt === 0) {
    if (FREE_ENDPOINTS.has(path)) freeSpent += 1;
    else billableSpent += 1;
  }

  // A chave vai na query string: nunca imprimir a URL montada.
  const shown = Object.entries(params)
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  console.log(`[${LABEL}] GET ${path}${shown.length > 0 ? `?${shown}` : ''}`);

  const response = await fetch(url, { headers: { accept: 'application/json' } });
  const text = await response.text();

  let body: unknown = text;
  try {
    body = JSON.parse(text) as unknown;
  } catch {
    /* resposta não-JSON: fica o texto cru, que é o que interessa num erro */
  }

  // `/v4/account` não tem NENHUM campo de cota no corpo (medido). Se a contagem
  // é observável, é por header — então capturamos todos os que parecem contador.
  const meta = new Map<string, string>();
  response.headers.forEach((v, k) => {
    if (/quota|limit|remain|request|ratelimit|used|credit/i.test(k)) meta.set(k, v);
  });
  if (meta.size > 0) {
    console.log(`[${LABEL}]   headers: ${[...meta].map(([k, v]) => `${k}=${v}`).join('  ')}`);
  }

  if (response.status === 429 && attempt < 3) {
    const waitMs = retryMsOf(body) ?? 1000;
    console.log(`[${LABEL}]   429 — aguardando ${waitMs}ms e repetindo (não reconta)`);
    await sleep(waitMs + 250);
    return call(path, params, attempt + 1);
  }

  if (!response.ok) {
    console.error(`[${LABEL}]   HTTP ${response.status} — ${text.slice(0, 400)}`);
  }

  return { ok: response.ok, status: response.status, body, meta };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** Primeiro array de objetos encontrado — a envelopagem varia por endpoint. */
function firstObjectArray(value: unknown): Record<string, unknown>[] | null {
  if (Array.isArray(value)) {
    return value.filter(isRecord);
  }
  if (isRecord(value)) {
    for (const nested of Object.values(value)) {
      const found = firstObjectArray(nested);
      if (found !== null && found.length > 0) return found;
    }
  }
  return null;
}

/**
 * Campos numéricos que parecem contador de cota, de qualquer nível do objeto.
 * A doc não fixa o nome, e a sonda não pode depender de adivinhar certo: o que
 * importa é a DIFERENÇA entre antes e depois, então basta capturar todos.
 */
function quotaCounters(value: unknown, prefix = ''): Map<string, number> {
  const out = new Map<string, number>();
  if (!isRecord(value)) return out;

  for (const [k, v] of Object.entries(value)) {
    const path = prefix.length > 0 ? `${prefix}.${k}` : k;
    if (typeof v === 'number') {
      if (/request|quota|limit|remain|used|credit|call/i.test(k)) out.set(path, v);
    } else if (isRecord(v)) {
      for (const [nk, nv] of quotaCounters(v, path)) out.set(nk, nv);
    }
  }
  return out;
}

/** lowercase, sem acento, sem pontuação — para comparar nome de time. */
function normalize(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

// ---------------------------------------------------------------------------
// Passos
// ---------------------------------------------------------------------------

/**
 * `/v4/account` não traz contador de cota no corpo — medido na primeira passada.
 * O que ele traz, e vale mais do que se esperava, é a assinatura com o mapa de
 * bookmakers ENTITULADOS, cada um com `has_live_odds` / `has_player_props`. Essa
 * é a resposta autoritativa para a pergunta 2, melhor que `/v4/bookmakers` (que
 * lista o catálogo, não o direito de acesso).
 */
async function readAccount(when: string): Promise<Map<string, number>> {
  const res = await call('/v4/account');
  console.log(`[${LABEL}] ===== /v4/account (${when}) =====`);

  const counters = quotaCounters(res.body);
  const headerCounters = new Map<string, number>();
  for (const [k, v] of res.meta) {
    const n = Number(v);
    if (Number.isFinite(n)) headerCounters.set(`header:${k}`, n);
  }
  for (const [k, v] of headerCounters) counters.set(k, v);

  const subs = isRecord(res.body) ? res.body['subscriptions'] : undefined;
  const active = Array.isArray(subs)
    ? subs.filter(isRecord).find((s) => s['is_active'] === true)
    : undefined;

  if (active !== undefined) {
    const books = active['bookmakers'];
    const entitled = isRecord(books) ? Object.entries(books) : [];
    const live = entitled.filter(([, v]) => isRecord(v) && v['has_live_odds'] === true).length;
    const props = entitled.filter(([, v]) => isRecord(v) && v['has_player_props'] === true).length;

    console.log(
      `[${LABEL}]   assinatura ativa: price=${JSON.stringify(active['price'])} ` +
        `valid_until=${JSON.stringify(active['valid_until'])}`,
    );
    console.log(
      `[${LABEL}]   bookmakers ENTITULADOS: ${entitled.length}  ` +
        `(com live odds: ${live}, com player props: ${props})`,
    );

    if (when === 'ANTES') {
      console.log(`[${LABEL}]   as que interessam ao eval, no entitlement:`);
      for (const wanted of PREFERRED_BOOKMAKERS) {
        const hit = entitled.find(([slug]) => slug === wanted);
        const cap = hit !== undefined && isRecord(hit[1]) ? hit[1] : null;
        console.log(
          `[${LABEL}]     ${wanted.padEnd(12)} ` +
            (cap === null
              ? 'AUSENTE do entitlement'
              : `ok   live=${cap['has_live_odds'] === true ? 'sim' : 'NAO'}  props=${cap['has_player_props'] === true ? 'sim' : 'nao'}`),
        );
      }
    }
  } else {
    console.log(JSON.stringify(res.body, null, 2).slice(0, 800));
  }

  if (counters.size === 0) {
    console.warn(
      `[${LABEL}]   nenhum contador de cota — nem no corpo, nem em header.\n` +
        `[${LABEL}]   O item 1 não é observável por esta via.`,
    );
  }
  return counters;
}

async function probeBookmakers(): Promise<string[]> {
  const res = await call('/v4/bookmakers');
  console.log(`\n[${LABEL}] ===== /v4/bookmakers =====`);

  if (!res.ok) return [];

  const rows = firstObjectArray(res.body);
  // A envelopagem pode ser `{slug: name}` como em /v4/participants, ou lista.
  const slugs: string[] = [];
  const named = new Map<string, string>();

  if (rows !== null && rows.length > 0) {
    console.log(
      `[${LABEL}]   forma: lista de objetos. Chaves: ${Object.keys(rows[0] ?? {}).join(', ')}`,
    );
    for (const row of rows) {
      const slug = str(row['slug']) ?? str(row['key']) ?? str(row['id']);
      const name = str(row['name']) ?? str(row['title']) ?? slug;
      if (slug !== null) {
        slugs.push(slug);
        named.set(slug, name ?? slug);
      }
    }
    console.log(JSON.stringify(rows.slice(0, 3), null, 2));
  } else if (isRecord(res.body)) {
    console.log(`[${LABEL}]   forma: mapa chave->nome`);
    for (const [k, v] of Object.entries(res.body)) {
      slugs.push(k);
      named.set(k, typeof v === 'string' ? v : k);
    }
  }

  console.log(`\n[${LABEL}]   TOTAL de casas no plano Free: ${slugs.length}`);

  console.log(`\n[${LABEL}]   As que interessam ao eval:`);
  for (const wanted of PREFERRED_BOOKMAKERS) {
    // Exato primeiro: `stake` e `mystake` são casas diferentes, e o `includes`
    // sozinho fazia a segunda responder pela primeira.
    const hit =
      slugs.find((s) => s === wanted) ??
      slugs.find((s) => normalize(s).includes(normalize(wanted)));
    const label =
      hit === undefined
        ? 'AUSENTE'
        : `ok  (slug=${hit}${hit === wanted ? '' : ' — casamento aproximado'}, nome=${named.get(hit) ?? '?'})`;
    console.log(`[${LABEL}]     ${wanted.padEnd(12)} ${label}`);
  }

  // Achado da primeira passada, e o mais relevante ao eval: o próprio Polymarket
  // está no catálogo, junto com Kalshi e as exchanges. Se o preço do Polymarket
  // chega pela mesma resposta que o das casas, o baseline vem alinhado no tempo
  // e no formato — sem precisar cruzar duas coletas com relógios diferentes.
  console.log(`\n[${LABEL}]   Mercados de previsão e exchanges no catálogo:`);
  for (const wanted of [
    'polymarket',
    'polymarket.us',
    'kalshi',
    'betfair-ex',
    'matchbook',
    'sx.bet',
    'prophetx',
  ]) {
    console.log(
      `[${LABEL}]     ${wanted.padEnd(14)} ${slugs.includes(wanted) ? 'presente' : 'ausente'}`,
    );
  }

  console.log(`\n[${LABEL}]   Lista completa (slugs):`);
  console.log(`[${LABEL}]     ${slugs.join(', ')}`);

  return slugs;
}

interface Fixture {
  readonly fixtureId: string;
  readonly startTime: string | null;
  readonly statusId: number | null;
  readonly finished: boolean;
  readonly hasOdds: boolean;
  readonly names: readonly (readonly [string | null, string | null, string | null])[];
  readonly raw: Record<string, unknown>;
}

function toFixture(row: Record<string, unknown>): Fixture | null {
  const id = str(row['fixtureId']) ?? str(row['id']);
  if (id === null) return null;

  const side = (n: 1 | 2): readonly [string | null, string | null, string | null] => [
    str(row[`participant${n}Name`]),
    str(row[`participant${n}ShortName`]),
    str(row[`participant${n}Abbr`]),
  ];

  return {
    fixtureId: id,
    startTime: str(row['startTime']),
    statusId: typeof row['statusId'] === 'number' ? row['statusId'] : null,
    // MEDIDO: `statusId` volta null em toda fixture de CS2 da amostra, apesar de
    // a doc descrevê-lo como 0-3. Quem diz que a partida acabou é `trueEndTime`
    // — e `hasOdds` diz se vale a pena pedir histórico. O enricher tem que ler
    // esses dois, não `statusId`.
    finished: str(row['trueEndTime']) !== null,
    hasOdds: row['hasOdds'] === true,
    names: [side(1), side(2)],
    raw: row,
  };
}

/**
 * Janelas de no máximo 9 dias.
 *
 * Medido: com só `sportId`, a API rejeita range acima de 10 dias
 * (`INVALID_PARAMETER`, "must be under 10 days apart"). Isso é custo de cota
 * direto no desenho do enricher — varrer um mês de CS2 são 4 requisições
 * billable, não 1. Com `tournamentId` a restrição pode não valer; fica para a
 * próxima sonda.
 */
function windows(from: string, to: string, maxDays = 9): (readonly [string, string])[] {
  const start = new Date(`${from}T00:00:00Z`).getTime();
  const end = new Date(`${to}T00:00:00Z`).getTime();
  const step = maxDays * 24 * 60 * 60 * 1000;
  const out: (readonly [string, string])[] = [];

  for (let cursor = start; cursor < end; cursor += step) {
    const stop = Math.min(cursor + step, end);
    out.push([
      new Date(cursor).toISOString().slice(0, 10),
      new Date(stop).toISOString().slice(0, 10),
    ] as const);
  }
  return out;
}

async function probeFixtures(from: string, to: string): Promise<Fixture[]> {
  const chunks = windows(from, to);
  console.log(
    `\n[${LABEL}] ===== /v4/fixtures sportId=${SPORT_CS2} ${from}..${to} =====\n` +
      `[${LABEL}]   ${chunks.length} janela(s) de até 9 dias = ${chunks.length} requisição(ões) billable`,
  );

  const rows: Record<string, unknown>[] = [];
  for (const [wFrom, wTo] of chunks) {
    const res = await call('/v4/fixtures', {
      sportId: String(SPORT_CS2),
      from: wFrom,
      to: wTo,
    });
    if (!res.ok) continue;
    const chunkRows = firstObjectArray(res.body) ?? [];
    console.log(`[${LABEL}]   ${wFrom}..${wTo}: ${chunkRows.length} fixture(s)`);
    rows.push(...chunkRows);
  }

  if (rows.length === 0) return [];

  console.log(`[${LABEL}]   ${rows.length} fixture(s). Chaves da primeira:`);
  console.log(`[${LABEL}]     ${Object.keys(rows[0] ?? {}).join(', ')}`);
  console.log(`\n[${LABEL}]   Primeira fixture crua (para conferir mapeamentos externos):`);
  console.log(JSON.stringify(rows[0] ?? {}, null, 2).slice(0, 2000));

  const fixtures = rows.map(toFixture).filter((f): f is Fixture => f !== null);

  console.log(`\n[${LABEL}]   Nomes de time, três variantes por lado:`);
  console.log(
    `[${LABEL}]     ${'status'.padEnd(7)}${'Name'.padEnd(26)}${'ShortName'.padEnd(20)}Abbr`,
  );
  for (const f of fixtures.slice(0, 25)) {
    for (const [name, short, abbr] of f.names) {
      console.log(
        `[${LABEL}]     ${String(f.statusId ?? '?').padEnd(7)}` +
          `${(name ?? '—').padEnd(26)}${(short ?? '—').padEnd(20)}${abbr ?? '—'}`,
      );
    }
    console.log(`[${LABEL}]     ${'-'.repeat(60)}`);
  }

  return fixtures;
}

/**
 * Cruza os nomes deles com `esports_teams.display_name`. Único passo que lê o
 * banco, e por isso está atrás de `--with-db`.
 *
 * O que se mede aqui: quantos lados de fixture casam por nome exato normalizado,
 * e por qual das três variantes. Os que não casam são a lista de trabalho do
 * enricher — e os `display_name IS NULL` (caminho 2 do resolver) são os que
 * nenhuma estratégia por nome alcança.
 */
async function compareWithDb(fixtures: readonly Fixture[]): Promise<void> {
  const { supabase } = await import('../src/lib/supabase.js');

  const { data, error } = await supabase
    .from('esports_teams')
    .select('display_name, polymarket_code')
    .eq('vertical_id', 'cs2');

  if (error) {
    console.error(`\n[${LABEL}] leitura de esports_teams falhou: ${error.message}`);
    return;
  }

  const rows = (data ?? []) as { display_name: string | null; polymarket_code: string }[];
  const byName = new Map<string, string>();
  let missingName = 0;
  for (const row of rows) {
    if (row.display_name === null) {
      missingName += 1;
      continue;
    }
    byName.set(normalize(row.display_name), row.display_name);
  }

  console.log(`\n[${LABEL}] ===== cruzamento com esports_teams (cs2) =====`);
  console.log(
    `[${LABEL}]   ${rows.length} time(s) na tabela, ${byName.size} com display_name, ` +
      `${missingName} sem (esses nenhum casamento por nome alcança).`,
  );

  let hits = 0;
  let total = 0;
  const misses: string[] = [];
  const viaVariant = new Map<string, number>([
    ['Name', 0],
    ['ShortName', 0],
    ['Abbr', 0],
  ]);

  for (const f of fixtures) {
    for (const side of f.names) {
      const [name, short, abbr] = side;
      if (name === null && short === null && abbr === null) continue;
      total += 1;

      const variants: readonly (readonly [string, string | null])[] = [
        ['Name', name],
        ['ShortName', short],
        ['Abbr', abbr],
      ];

      const hit = variants.find(([, v]) => v !== null && byName.has(normalize(v)));
      if (hit === undefined) {
        misses.push(name ?? short ?? abbr ?? '?');
        continue;
      }
      hits += 1;
      viaVariant.set(hit[0], (viaVariant.get(hit[0]) ?? 0) + 1);
    }
  }

  const pct = total === 0 ? 0 : Math.round((hits / total) * 100);
  console.log(`[${LABEL}]   casamento exato normalizado: ${hits}/${total} lados (${pct}%)`);
  for (const [variant, count] of viaVariant) {
    console.log(`[${LABEL}]     via ${variant.padEnd(10)} ${count}`);
  }
  if (misses.length > 0) {
    console.log(`[${LABEL}]   sem casar (${misses.length}), primeiros 20:`);
    console.log(`[${LABEL}]     ${[...new Set(misses)].slice(0, 20).join(' | ')}`);
  }
}

interface OddsEntry {
  readonly createdAt: string | null;
  readonly price: number | null;
  readonly limit: number | null;
}

/**
 * Coleta recursiva das entradas de odds. A doc descreve
 * `bookmakers -> markets -> outcomes -> players`, mas a sonda existe justamente
 * para não confiar nisso: qualquer objeto com `price` conta como entrada, em
 * qualquer profundidade.
 */
function collectOdds(value: unknown, out: OddsEntry[]): void {
  if (Array.isArray(value)) {
    for (const item of value) collectOdds(item, out);
    return;
  }
  if (!isRecord(value)) return;

  if ('price' in value) {
    out.push({
      createdAt: str(value['createdAt']),
      price: typeof value['price'] === 'number' ? value['price'] : null,
      limit: typeof value['limit'] === 'number' ? value['limit'] : null,
    });
  }
  for (const nested of Object.values(value)) collectOdds(nested, out);
}

async function probeHistorical(fixtureId: string, bookmakers: readonly string[]): Promise<void> {
  console.log(`\n[${LABEL}] ===== /v4/historical-odds fixtureId=${fixtureId} =====`);
  console.log(`[${LABEL}]   casas: ${bookmakers.join(', ')} (o endpoint aceita no máximo 3)`);

  const res = await call('/v4/historical-odds', {
    fixtureId,
    bookmakers: bookmakers.slice(0, 3).join(','),
  });

  if (!res.ok) return;

  console.log(
    `[${LABEL}]   forma do topo: ${isRecord(res.body) ? Object.keys(res.body).join(', ') : typeof res.body}`,
  );

  // Por casa: a resposta agrupa por bookmaker, então medimos casa a casa em vez
  // de um total que esconderia uma casa vazia.
  const perBook = new Map<string, OddsEntry[]>();
  const bookmakersNode = isRecord(res.body) ? res.body['bookmakers'] : undefined;

  if (Array.isArray(bookmakersNode)) {
    for (const book of bookmakersNode) {
      if (!isRecord(book)) continue;
      const slug = str(book['slug']) ?? str(book['key']) ?? str(book['name']) ?? '(sem slug)';
      const entries: OddsEntry[] = [];
      collectOdds(book, entries);
      perBook.set(slug, entries);
    }
  } else if (isRecord(bookmakersNode)) {
    // Medido: `bookmakers` é um MAPA slug -> conteúdo, não uma lista. Mesma forma
    // de `/v4/participants` e do entitlement em `/v4/account` — é o padrão da casa.
    for (const [slug, content] of Object.entries(bookmakersNode)) {
      const entries: OddsEntry[] = [];
      collectOdds(content, entries);
      perBook.set(slug, entries);
    }
  } else {
    const entries: OddsEntry[] = [];
    collectOdds(res.body, entries);
    perBook.set('(agrupamento não reconhecido)', entries);
  }

  console.log(`\n[${LABEL}]   movimentos de linha por casa:`);
  for (const [slug, entries] of perBook) {
    const withCreatedAt = entries.filter((e) => e.createdAt !== null).length;
    const withLimit = entries.filter((e) => e.limit !== null).length;
    const stamps = entries
      .map((e) => e.createdAt)
      .filter((s): s is string => s !== null)
      .sort();

    console.log(
      `[${LABEL}]     ${slug.padEnd(16)} ${String(entries.length).padStart(6)} entrada(s)  ` +
        `createdAt ${withCreatedAt}/${entries.length}  limit ${withLimit}/${entries.length}`,
    );
    if (stamps.length > 0) {
      console.log(`[${LABEL}]       janela: ${stamps[0]} .. ${stamps[stamps.length - 1]}`);
    }
  }

  const all: OddsEntry[] = [];
  collectOdds(res.body, all);
  console.log(`\n[${LABEL}]   amostra de 5 entradas cruas:`);
  console.log(JSON.stringify(all.slice(0, 5), null, 2));

  if (all.length > 0 && all.every((e) => e.limit === null)) {
    console.warn(
      `[${LABEL}]   ATENÇÃO: nenhum \`limit\` preenchido. O stake máximo era metade\n` +
        `[${LABEL}]   do argumento a favor desta fonte — sem ele, a discordância com o\n` +
        `[${LABEL}]   Polymarket perde o peso de confiança da casa.`,
    );
  }
  if (all.length > 0 && all.every((e) => e.createdAt === null)) {
    console.error(
      `[${LABEL}]   ATENÇÃO: nenhum \`createdAt\`. Sem carimbo a série não é\n` +
        `[${LABEL}]   point-in-time, e não serve de baseline para o eval.`,
    );
  }
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  if ((process.env['ODDSPAPI_API_KEY'] ?? '').length === 0) {
    console.error(`[${LABEL}] ODDSPAPI_API_KEY ausente no ambiente.`);
    process.exit(1);
  }

  const from = flag('from') ?? '2026-07-01';
  const to = flag('to') ?? '2026-07-31';
  const withDb = flag('with-db') !== null;

  console.log(
    `[${LABEL}] plano Free: 250 req/mês, contadas por chamada a endpoint billable.\n` +
      `[${LABEL}] Esta passada gasta 2 billable (/v4/bookmakers e /v4/fixtures).\n` +
      `[${LABEL}] /v4/account e /v4/historical-odds são declarados livres — é o que se mede.\n`,
  );

  const before = await readAccount('ANTES');

  // Com `--fixture` e `--bookmakers` a sonda não gasta NADA billable: os dois
  // passos restantes (`/v4/account` e `/v4/historical-odds`) são os declarados
  // livres. É o modo de reexecutar o item 4 sem consumir as 250/mês.
  const explicit = flag('fixture');
  const skipDiscovery =
    explicit !== null && explicit.length > 0 && (flag('bookmakers') ?? '').length > 0;

  const slugs = skipDiscovery ? [] : await probeBookmakers();
  const fixtures = skipDiscovery ? [] : await probeFixtures(from, to);

  if (withDb) await compareWithDb(fixtures);

  // Fixture para o histórico: preferir FINALIZADA (statusId 2 pela doc), que é o
  // caso que o eval consome — série pré-partida inteira mais o desfecho. Além
  // disso, só fixture finalizada/cancelada emite ETag, então é a que permite
  // re-pull barato no backfill.
  const finished =
    fixtures.find((f) => f.finished && f.hasOdds) ?? fixtures.find((f) => f.hasOdds) ?? fixtures[0];
  const target =
    explicit !== null && explicit.length > 0 ? explicit : (finished?.fixtureId ?? null);

  const chosenBooks =
    (flag('bookmakers') ?? '').length > 0
      ? (flag('bookmakers') as string).split(',')
      : PREFERRED_BOOKMAKERS.filter((w) =>
          slugs.some((s) => normalize(s).includes(normalize(w))),
        ).slice(0, 3);

  if (target === null) {
    console.warn(
      `\n[${LABEL}] nenhuma fixture no range ${from}..${to} — o passo de histórico foi pulado.\n` +
        `[${LABEL}] Tente outro range com --from/--to, ou passe --fixture=<id> direto.`,
    );
  } else if (chosenBooks.length === 0) {
    console.warn(`\n[${LABEL}] nenhuma casa preferida disponível — passe --bookmakers=a,b,c`);
  } else {
    if (finished !== undefined && !finished.finished && explicit === null) {
      console.warn(
        `[${LABEL}] nenhuma fixture com trueEndTime no range (hasOdds=${finished.hasOdds}). ` +
          `A densidade medida pode ser parcial.`,
      );
    }
    await probeHistorical(target, chosenBooks);
  }

  const after = await readAccount('DEPOIS');

  // ---------------------------------------------------------------------------
  // Veredito do item 1
  // ---------------------------------------------------------------------------
  console.log(`\n[${LABEL}] ===== cota: antes vs depois =====`);
  console.log(
    `[${LABEL}]   chamadas desta passada: ${billableSpent} billable + ${freeSpent} declaradas livres`,
  );

  const keys = new Set([...before.keys(), ...after.keys()]);
  if (keys.size === 0) {
    console.log(`[${LABEL}]   sem contador numérico reconhecido — comparar os dois JSON à mão.`);
  }
  for (const k of keys) {
    const a = before.get(k);
    const b = after.get(k);
    const delta = a !== undefined && b !== undefined ? b - a : null;
    console.log(
      `[${LABEL}]     ${k.padEnd(28)} ${String(a ?? '—').padStart(8)} -> ${String(b ?? '—').padStart(8)}` +
        (delta === null ? '' : `   Δ ${delta > 0 ? '+' : ''}${delta}`),
    );
  }

  console.log(
    `\n[${LABEL}] Como ler o Δ: se o contador de consumo subiu ${billableSpent} (e não\n` +
      `[${LABEL}] ${billableSpent + freeSpent}), a doc está certa e /v4/historical-odds sai de graça —\n` +
      `[${LABEL}] o que torna o histórico ilimitado no Free, limitado só pelo cooldown de 5s.\n` +
      `[${LABEL}] Se subiu ${billableSpent + freeSpent}, as 250/mês passam a ser o teto real do enricher\n` +
      `[${LABEL}] e o desenho muda: cache agressivo e ETag deixam de ser otimização e viram requisito.`,
  );
}

main().catch((err) => {
  console.error(`[${LABEL}] Fatal:`, err);
  process.exit(1);
});
