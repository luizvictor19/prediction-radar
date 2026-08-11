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
 *   5. O que `active = false` significa, e se o histórico de fixture antiga é
 *      imutável. As duas foram perguntadas no Discord deles e não voltaram —
 *      então são medidas aqui, com a amostra que já temos e com o tempo.
 *      `analyzeActive` responde a primeira pelo PADRÃO (alternância com preço
 *      mudando vs. blocos coincidentes entre casas); `--snapshot`/`--compare`
 *      respondem a segunda com evidência própria, duas semanas depois.
 *
 *      A decisão que depende do item 5 está registrada em
 *      `specs/001-esports-vertical.md`, Parte D: o enricher da OddsPapi nasce com
 *      `supportsPointInTime = false` por AUSÊNCIA DE GARANTIA, não por defeito
 *      conhecido. Isso não o bloqueia — só o mantém fora do replay do eval até a
 *      comparação acima existir. Lá está o critério exato que vira a chave.
 *
 * ## Antes de rodar
 *
 *   ODDSPAPI_API_KEY=...
 *
 * ## Orçamento
 *
 * O Free dá 250 requisições/mês, e a contagem é por CHAMADA a endpoint billable
 * — tamanho da resposta não importa. Uma passada completa desta sonda gasta
 * **2 requisições billable** (`/v4/bookmakers` e `/v4/fixtures`) — e só gasta
 * isso porque o default de `--from`/`--to` é UMA janela de 9 datas. Um range
 * maior é partido por `windows()` em pedaços de 9 dias, e cada pedaço é uma
 * chamada paga: `--from=2026-07-01 --to=2026-07-31` custa 5, não 2.
 *
 * `--truncation` é o modo mais barato e mais conclusivo: 2 billable exatas,
 * duas janelas encaixadas, e a resposta definitiva sobre se `/v4/fixtures`
 * corta a lista. Sai no topo do `main` para não arrastar nenhuma outra chamada
 * paga junto. `/v4/account` e
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
 *   npm run oddspapi:probe -- --from=2026-08-07 --to=2026-08-15
 *   npm run oddspapi:probe -- --truncation           # 2 billable, e só elas
 *   npm run oddspapi:probe -- --bookmakers=pinnacle,ggbet,thunderpick
 *   npm run oddspapi:probe -- --fixture=id1704591169167084
 *   npm run oddspapi:probe -- --with-db      # cruza os nomes com esports_teams
 *   npm run oddspapi:probe -- --coverage     # cobertura real das NOSSAS partidas
 *
 * `--coverage` responde à pergunta que o contador de recusas do enricher deixou
 * aberta: das partidas que não acham fixture, quantas são teto da cobertura
 * deles e quantas são defeito do nosso casamento por nome. Usa `matchFixture` do
 * próprio enricher, não uma cópia — medir uma reimplementação descreveria um
 * sistema que não existe.
 *
 * `--with-db` e `--coverage` são opt-in de propósito: são as únicas partes que
 * leem o banco de produção.
 * Sem a flag a sonda só fala com a OddsPapi, e imprime os nomes deles para
 * conferência a olho.
 *
 * ### Imutabilidade, em duas passadas separadas por semanas
 *
 *   npm run oddspapi:probe -- --fixture=<encerrada> --bookmakers=a,b,c --snapshot
 *   npm run oddspapi:probe -- --compare=probes/oddspapi/<fixtureId>.json
 *
 * `--snapshot` aceita caminho (`--snapshot=onde/quiser.json`); sem valor, grava
 * em `probes/oddspapi/<fixtureId>.json`. O arquivo NÃO contém a chave de API — o
 * que ele guarda é endpoint, params, ETag, os dois hashes e o corpo. É feito
 * para durar em disco e para ser commitado se você quiser que o próprio git
 * carimbe a data.
 *
 * As duas passadas gastam ZERO billable quando `--fixture` e `--bookmakers` vêm
 * explícitos: `/v4/historical-odds` é declarado livre, e `--compare` nem chega a
 * fazer descoberta.
 *
 * `--coincidence-ms=60000` regula o quanto dois blocos de `active=false` podem
 * se afastar e ainda contarem como o mesmo evento.
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
  /** O corpo CRU, antes do parse. É o que permite comparar byte a byte. */
  readonly text: string;
  /** Só os headers com cara de cota/limite — é onde a contagem parece morar. */
  readonly meta: ReadonlyMap<string, string>;
  /**
   * `etag` e `last-modified`, quando vierem.
   *
   * São a afirmação do PRÓPRIO servidor sobre imutabilidade, e por isso ficam
   * fora de `meta`: um ETag idêntico duas semanas depois é evidência de outra
   * natureza que a comparação byte a byte — ela mostra que o corpo não mudou,
   * ele mostra que o servidor diz que não devia mudar. Os dois juntos separam
   * "estável por enquanto" de "prometido estável".
   */
  readonly etag: string | null;
  readonly lastModified: string | null;
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

  return {
    ok: response.ok,
    status: response.status,
    body,
    text,
    meta,
    etag: response.headers.get('etag'),
    lastModified: response.headers.get('last-modified'),
  };
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

/**
 * Distância de edição, com teto. Só para achar quase-casamento no relatório de
 * cobertura — não entra em decisão nenhuma do enricher.
 */
function editDistance(a: string, b: string, cap = 4): number {
  if (Math.abs(a.length - b.length) > cap) return cap + 1;

  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);

  for (let i = 1; i <= a.length; i += 1) {
    const row = [i];
    let best = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const value = Math.min((prev[j] ?? 0) + 1, (row[j - 1] ?? 0) + 1, (prev[j - 1] ?? 0) + cost);
      row[j] = value;
      if (value < best) best = value;
    }
    if (best > cap) return cap + 1;
    prev = row;
  }

  return prev[b.length] ?? cap + 1;
}

/** Iniciais das palavras: 'Natus Vincere' -> 'nv'. Preserva a fronteira de palavra. */
function acronymOf(raw: string): string {
  return raw
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length > 0)
    .map((w) => w[0] ?? '')
    .join('')
    .toLowerCase();
}

/** O curto aparece em ordem dentro do longo. Piso de 3 letras contra ruído. */
function isSubsequence(longer: string, shorter: string): boolean {
  if (shorter.length < 3 || shorter.length >= longer.length) return false;
  // Mesma inicial. Sem isto, `mtx` é subsequência de `dynamoeclotphoenix` e o
  // relatório classifica nomes sem relação nenhuma como quase-casamento.
  if (longer[0] !== shorter[0]) return false;

  let i = 0;
  for (const ch of longer) {
    if (ch === shorter[i]) i += 1;
    if (i === shorter.length) return true;
  }
  return false;
}

/**
 * Nomes que "quase" são o mesmo — heurística SÓ para o relatório.
 *
 * É o que separa as duas respostas que a cobertura de 35% pode ter. Se o time
 * não aparece de forma nenhuma na lista deles, o teto é da COBERTURA deles. Se
 * aparece com outra grafia, o teto é do NOSSO casamento — e aí tem conserto.
 *
 * Recebe os nomes CRUS de propósito: a normalização apaga espaço, e sem fronteira
 * de palavra não dá para reconhecer sigla — que é o caso dominante em esports
 * ('Natus Vincere' / 'NAVI', 'Fnatic' / 'FNC'). Foi o furo da primeira versão:
 * ela classificava sigla como cobertura deles, que é a conclusão oposta.
 *
 * Nenhuma decisão do enricher passa por aqui. O casamento que vale continua
 * sendo o exato de `matchFixture`; isto só rotula a falha para quem lê.
 */
function nearMiss(oursRaw: string, theirsRaw: string): boolean {
  const ours = normalize(oursRaw);
  const theirs = normalize(theirsRaw);

  if (ours.length === 0 || theirs.length === 0) return false;
  if (ours === theirs) return false;
  if (ours.includes(theirs) || theirs.includes(ours)) return true;

  if (acronymOf(oursRaw) === theirs || acronymOf(theirsRaw) === ours) return true;

  // Abreviação: as letras do curto aparecem na ordem dentro do longo.
  // 'navi' ⊂ 'natusvincere', 'fnc' ⊂ 'fnatic'. Cobre sigla, contração e corte,
  // que é a família inteira de como uma casa encurta nome de time.
  //
  // Piso de 3 letras: com 2, quase tudo é subsequência de quase tudo.
  if (isSubsequence(ours, theirs) || isSubsequence(theirs, ours)) return true;

  const cap = ours.length <= 6 ? 1 : 2;
  return editDistance(ours, theirs, cap) <= cap;
}

/**
 * A cobertura REAL, medida do nosso lado: das partidas da janela do enricher,
 * quantas acham fixture na OddsPapi — e, das que não acham, por quê.
 *
 * Existe porque o contador de recusas mediu 26 de 40 partidas "sem fixture
 * correspondente" e esse número sozinho não decide nada: 35% pode ser o teto da
 * cobertura deles (não cobrem CS2 de tier baixo) ou defeito do nosso casamento
 * (cobrem, com outra grafia). As duas leituras levam a ações opostas — desistir
 * da fonte, ou consertar o casamento.
 *
 * ## Mede a lógica de PRODUÇÃO, não uma cópia dela
 *
 * `matchFixture` e `normalize` são importados do enricher. Reimplementá-los aqui
 * mediria um casamento que não é o que roda — e o relatório passaria a descrever
 * um sistema que não existe.
 *
 * Único passo que lê o banco, junto com `--with-db`.
 */
async function measureCoverage(from: string, to: string): Promise<void> {
  const { supabase } = await import('../src/lib/supabase.js');
  const { matchFixture, normalize: normalizeTeam } =
    await import('../src/verticals/enrichers/oddspapi.js');

  console.log(`\n[${LABEL}] ===== cobertura real das nossas partidas =====`);

  const { data: matches, error } = await supabase
    .from('esports_matches')
    .select('id, match_slug, scheduled_at, team_a_id, team_b_id, external_ids')
    .eq('vertical_id', 'cs2')
    .gte('scheduled_at', `${from}T00:00:00Z`)
    .lte('scheduled_at', `${to}T23:59:59Z`)
    .order('scheduled_at', { ascending: true });

  if (error) {
    console.error(`[${LABEL}] leitura de esports_matches falhou: ${error.message}`);
    return;
  }

  const rows = (matches ?? []) as Record<string, unknown>[];
  if (rows.length === 0) {
    console.log(`[${LABEL}]   nenhuma partida de cs2 entre ${from} e ${to}.`);
    return;
  }

  const teamIds = [
    ...new Set(
      rows
        .flatMap((r) => [r['team_a_id'], r['team_b_id']])
        .filter((id): id is string => typeof id === 'string'),
    ),
  ];

  const { data: teams, error: teamError } = await supabase
    .from('esports_teams')
    .select('id, display_name, polymarket_code')
    .in('id', teamIds);

  if (teamError) {
    console.error(`[${LABEL}] leitura de esports_teams falhou: ${teamError.message}`);
    return;
  }

  const byId = new Map(
    ((teams ?? []) as Record<string, unknown>[]).map((t) => [t['id'] as string, t]),
  );

  // A janela de fixtures que o enricher usaria.
  //
  // A sonda e o cliente têm formas diferentes para a mesma coisa (`names` com
  // três variantes por lado; `sides` com as não-nulas), então a conversão é
  // explícita: `matchFixture` é o código de produção e recebe o que ele espera.
  const probed = await probeFixtures(from, to);
  const theirFixtures = probed.map((f) => ({
    fixtureId: f.fixtureId,
    startTime: f.startTime,
    finished: f.finished,
    hasOdds: f.hasOdds,
    sides: f.names.map((side) => side.filter((n): n is string => n !== null)),
  }));

  // Todos os nomes que eles conhecem na janela, normalizados, para o teste de
  // quase-casamento.
  const theirNames = new Map<string, string>();
  for (const fixture of theirFixtures) {
    for (const side of fixture.sides) {
      for (const variant of side) theirNames.set(normalizeTeam(variant), variant);
    }
  }

  let matched = 0;
  let semNome = 0;
  const porDegrau = new Map<string, number>();
  const fixturesUsadas = new Set<string>();
  const tetoDeles: string[] = [];
  const defeitoNosso: string[] = [];
  const bugDoCasador: string[] = [];
  const jaMemoizadas: string[] = [];

  for (const row of rows) {
    const slug = (row['match_slug'] as string | null) ?? (row['id'] as string);
    const a = byId.get(row['team_a_id'] as string);
    const b = byId.get(row['team_b_id'] as string);

    const nameA = typeof a?.['display_name'] === 'string' ? (a['display_name'] as string) : null;
    const nameB = typeof b?.['display_name'] === 'string' ? (b['display_name'] as string) : null;

    if (nameA === null || nameB === null) {
      semNome += 1;
      const falta = [
        nameA === null ? (a?.['polymarket_code'] ?? '?') : null,
        nameB === null ? (b?.['polymarket_code'] ?? '?') : null,
      ]
        .filter((c) => c !== null)
        .join(', ');
      defeitoNosso.push(`${slug} — sem display_name (código: ${falta})`);
      continue;
    }

    const codeA =
      typeof a?.['polymarket_code'] === 'string' ? (a['polymarket_code'] as string) : null;
    const codeB =
      typeof b?.['polymarket_code'] === 'string' ? (b['polymarket_code'] as string) : null;

    const agendada = new Date((row['scheduled_at'] as string | null) ?? '');
    const link = matchFixture(
      theirFixtures,
      { displayName: nameA, polymarketCode: codeA },
      { displayName: nameB, polymarketCode: codeB },
      Number.isFinite(agendada.getTime()) ? agendada : undefined,
    );
    if (link !== null) {
      matched += 1;
      porDegrau.set(link.tier, (porDegrau.get(link.tier) ?? 0) + 1);
      fixturesUsadas.add(link.fixtureId);
      const externalIds = row['external_ids'];
      if (
        externalIds !== null &&
        typeof externalIds === 'object' &&
        'oddspapi_fixture_id' in (externalIds as Record<string, unknown>)
      ) {
        jaMemoizadas.push(slug);
      }
      continue;
    }

    // Não casou. Antes de classificar, a pergunta decisiva: existe UMA fixture
    // com os dois times juntos?
    //
    // "PRESENTE" sozinho quer dizer "este nome aparece em alguma fixture da
    // janela" — o que é compatível com os dois times estarem em fixtures
    // DIFERENTES, contra outros adversários. A primeira versão deste relatório
    // não fazia essa distinção e convidava à leitura errada de que o par devia
    // ter casado. Se os dois estão na mesma fixture e o casamento falhou, é bug
    // do casador; se estão em fixtures diferentes, eles não cobrem ESTE par.
    const keyA = normalizeTeam(nameA);
    const keyB = normalizeTeam(nameB);
    const juntos = theirFixtures.find((f) => {
      const [s1 = [], s2 = []] = f.sides;
      const inS1 = (k: string): boolean => s1.some((n) => normalizeTeam(n) === k);
      const inS2 = (k: string): boolean => s2.some((n) => normalizeTeam(n) === k);
      return (inS1(keyA) && inS2(keyB)) || (inS2(keyA) && inS1(keyB));
    });

    if (juntos !== undefined) {
      bugDoCasador.push(
        `${slug} — os dois exatos na fixture ${juntos.fixtureId} e mesmo assim não casou`,
      );
      continue;
    }

    const diagnostico = [nameA, nameB].map((nome) => {
      const key = normalizeTeam(nome);
      if (theirNames.has(key)) {
        // Está na janela, mas contra outro adversário. Diz contra quem, que é o
        // que separa "não cobrem este par" de "resolvemos o adversário errado".
        const onde = theirFixtures.find((f) =>
          f.sides.some((side) => side.some((n) => normalizeTeam(n) === key)),
        );
        const adversario = onde?.sides
          .filter((side) => !side.some((n) => normalizeTeam(n) === key))
          .map((side) => side[0] ?? '?')
          .join('/');
        return `"${nome}" em OUTRA fixture (vs ${adversario ?? '?'})`;
      }

      const perto = [...theirNames.values()].find((cru) => nearMiss(nome, cru));
      if (perto !== undefined) return `"${nome}" ~ "${perto}"`;

      return `"${nome}" AUSENTE`;
    });

    // Só é defeito nosso se houver quase-casamento: nome presente contra OUTRO
    // adversário não é problema de grafia, é par que eles não têm.
    const temQuaseCasamento = diagnostico.some((d) => d.includes(' ~ '));
    (temQuaseCasamento ? defeitoNosso : tetoDeles).push(`${slug} — ${diagnostico.join(' | ')}`);
  }

  const total = rows.length;
  const pct = (n: number): string => `${Math.round((n / total) * 100)}%`;

  console.log(`\n[${LABEL}]   ${total} partida(s) de cs2 na janela ${from}..${to}`);
  console.log(
    `[${LABEL}]   ${theirFixtures.length} fixture(s) de CS2 do lado deles na mesma janela`,
  );
  console.log(
    `[${LABEL}]     casaram:              ${String(matched).padStart(4)}  ${pct(matched)}`,
  );
  // Por degrau: diz se o casamento relaxado está carregando a cobertura ou só
  // arredondando. Degrau fraco em massa é sinal para olhar as amostras à mão.
  for (const [degrau, n] of [...porDegrau].sort((x, y) => y[1] - x[1])) {
    console.log(`[${LABEL}]       via ${degrau.padEnd(10)}${String(n).padStart(4)}`);
  }
  console.log(
    `[${LABEL}]     TETO DELES:           ${String(tetoDeles.length).padStart(4)}  ${pct(tetoDeles.length)}  (nenhum dos dois times na lista deles)`,
  );
  console.log(
    `[${LABEL}]     DEFEITO NOSSO:        ${String(defeitoNosso.length).padStart(4)}  ${pct(defeitoNosso.length)}  (time presente com outra grafia, ou sem display_name)`,
  );
  console.log(`[${LABEL}]       dos quais sem display_name: ${semNome}`);
  console.log(
    `[${LABEL}]     BUG DO CASADOR:       ${String(bugDoCasador.length).padStart(4)}  ${pct(bugDoCasador.length)}  (os dois exatos na MESMA fixture e não casou)`,
  );
  console.log(`[${LABEL}]     já memoizadas em external_ids: ${jaMemoizadas.length}`);

  if (bugDoCasador.length > 0) {
    console.error(`\n[${LABEL}]   BUG — isto não deveria existir:`);
    for (const linha of bugDoCasador.slice(0, 20)) console.error(`[${LABEL}]     ${linha}`);
  }

  // O número que decide se vale insistir no casamento: quanto do que EXISTE do
  // lado deles nós já estamos aproveitando. A taxa sobre as nossas partidas
  // mistura duas coisas — o que eles não cobrem e o que nós não casamos — e a
  // primeira não tem conserto nenhum deste lado.
  const teto = Math.min(theirFixtures.length, total);
  console.log(
    `\n[${LABEL}]   TETO ESTRUTURAL: eles têm ${theirFixtures.length} fixture(s) para as nossas ` +
      `${total} partidas.`,
  );
  console.log(
    `[${LABEL}]   Aproveitamos ${fixturesUsadas.size}/${theirFixtures.length} das fixtures deles ` +
      `(${Math.round((fixturesUsadas.size / Math.max(theirFixtures.length, 1)) * 100)}%), ` +
      `e ${matched}/${teto} do máximo alcançável (${Math.round((matched / Math.max(teto, 1)) * 100)}%).`,
  );

  console.log(`\n[${LABEL}]   VEREDITO:`);
  if (defeitoNosso.length > tetoDeles.length) {
    console.log(
      `[${LABEL}]     A maior parte da perda é NOSSA — os times existem do lado deles com\n` +
        `[${LABEL}]     outra grafia (ou nem têm display_name aqui). Tem conserto: alias por\n` +
        `[${LABEL}]     time, ou casar também por polymarket_code.`,
    );
  } else if (tetoDeles.length > 0) {
    console.log(
      `[${LABEL}]     A maior parte da perda é COBERTURA DELES — os times não aparecem na\n` +
        `[${LABEL}]     lista de fixtures. Nenhum conserto de casamento recupera isso; é o\n` +
        `[${LABEL}]     teto da fonte para o nosso universo de partidas.`,
    );
  } else {
    console.log(`[${LABEL}]     Sem perda relevante nesta janela.`);
  }

  if (defeitoNosso.length > 0) {
    console.log(`\n[${LABEL}]   DEFEITO NOSSO — os consertáveis (até 30):`);
    for (const linha of defeitoNosso.slice(0, 30)) console.log(`[${LABEL}]     ${linha}`);
  }
  if (tetoDeles.length > 0) {
    console.log(`\n[${LABEL}]   TETO DELES — sem fixture na fonte (até 30):`);
    for (const linha of tetoDeles.slice(0, 30)) console.log(`[${LABEL}]     ${linha}`);
  }
}

interface OddsEntry {
  readonly createdAt: string | null;
  readonly price: number | null;
  readonly limit: number | null;
  /**
   * `active` da entrada, ou `null` quando o campo não existe.
   *
   * `null` e `false` são coisas diferentes e não podem colapsar: `false` é a
   * casa dizendo que a linha não vale naquele instante; `null` é a sonda não
   * tendo o que medir. Tratar os dois como "não ativo" inventaria suspensão.
   */
  readonly active: boolean | null;
  /**
   * Caminho até a entrada, ex. `bookmakers.pinnacle.markets.0.outcomes.1.odds.7`.
   *
   * É o que permite separar SÉRIES dentro da mesma casa. Sem isso, as entradas
   * de todos os mercados e outcomes de uma casa virariam uma sequência só, e a
   * alternância medida seria o intercalamento de séries distintas — um artefato
   * da coleta, não comportamento da casa.
   */
  readonly path: string;
}

/** O caminho sem o índice final: identifica a série a que a entrada pertence. */
function seriesKeyOf(path: string): string {
  return path.replace(/\.\d+$/, '');
}

/**
 * Coleta recursiva das entradas de odds. A doc descreve
 * `bookmakers -> markets -> outcomes -> players`, mas a sonda existe justamente
 * para não confiar nisso: qualquer objeto com `price` conta como entrada, em
 * qualquer profundidade.
 *
 * `path` acumula a rota até a entrada. Nada na análise depende da forma
 * documentada — só da rota que a resposta de fato tiver.
 */
function collectOdds(value: unknown, out: OddsEntry[], path = ''): void {
  if (Array.isArray(value)) {
    value.forEach((item, i) => collectOdds(item, out, path.length > 0 ? `${path}.${i}` : `${i}`));
    return;
  }
  if (!isRecord(value)) return;

  if ('price' in value) {
    // Três grafias possíveis para o mesmo campo. A doc usa `active`; as outras
    // duas aparecem no resto da API deles (`is_active` no entitlement de
    // `/v4/account`), e adivinhar errado aqui apagaria o fenômeno inteiro.
    const rawActive = value['active'] ?? value['isActive'] ?? value['is_active'];

    out.push({
      createdAt: str(value['createdAt']),
      price: typeof value['price'] === 'number' ? value['price'] : null,
      limit: typeof value['limit'] === 'number' ? value['limit'] : null,
      active: typeof rawActive === 'boolean' ? rawActive : null,
      path,
    });
  }
  for (const [k, nested] of Object.entries(value)) {
    collectOdds(nested, out, path.length > 0 ? `${path}.${k}` : k);
  }
}

// ---------------------------------------------------------------------------
// Item 5 — o padrão de `active`
// ---------------------------------------------------------------------------
//
// A pergunta que o Discord não respondeu: `active = false` no meio da série é a
// casa suspendendo o mercado, ou o feed deles falhando? As duas produzem o mesmo
// campo e significam coisas opostas para o eval.
//
//   SUSPENSÃO REAL — a casa tirou a linha (lesão, saque, mercado virando). O
//   `false` é INFORMAÇÃO: o silêncio da casa naquele instante é um dado sobre a
//   partida, e o eval deve preservá-lo.
//
//   FALHA DE FEED — a coleta deles perdeu contato. O `false` é ARTEFATO: não diz
//   nada sobre a partida, e usá-lo como sinal seria aprender o ruído do
//   fornecedor.
//
// O que separa as duas, e é medível sem resposta de ninguém:
//
//   1. Alternância COM preço mudando entre um bloco e o seguinte. Casa que
//      suspende e reabre reabre em outro preço — foi por isso que suspendeu.
//      Feed que cai e volta volta no mesmo preço, porque nada aconteceu.
//
//   2. Blocos de `false` COINCIDENTES entre casas diferentes. Pinnacle e GGBet
//      não suspendem juntas por acaso; o fornecedor que coleta as duas, sim,
//      cai para as duas ao mesmo tempo.
//
// Os dois sinais são independentes e podem aparecer juntos — daí o relatório
// mostrar os dois números em vez de escolher um veredito.

/** Quanto dois blocos de `false` podem se afastar e ainda contarem como o mesmo evento. */
const DEFAULT_COINCIDENCE_MS = 60_000;

interface FalseRun {
  readonly bookmaker: string;
  readonly series: string;
  /** Instantes do primeiro e do último `false` do bloco. */
  readonly startMs: number | null;
  readonly endMs: number | null;
  readonly startAt: string | null;
  readonly endAt: string | null;
  readonly entries: number;
  /** `true` quando há entrada ativa dos DOIS lados — o true→false→true completo. */
  readonly enclosed: boolean;
  readonly priceBefore: number | null;
  readonly priceAfter: number | null;
}

function priceChanged(run: FalseRun): boolean {
  return run.priceBefore !== null && run.priceAfter !== null && run.priceBefore !== run.priceAfter;
}

function timeOf(iso: string | null): number | null {
  if (iso === null) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Ordena a série no tempo, quando dá.
 *
 * Sem `createdAt` em TODAS as entradas a ordem do array é a única disponível — e
 * aí a alternância medida vale menos, porque depende de a resposta vir ordenada.
 * O relatório diz quando foi esse o caso em vez de fingir que ordenou.
 */
function ordered(entries: readonly OddsEntry[]): { rows: OddsEntry[]; byTime: boolean } {
  const byTime = entries.every((e) => timeOf(e.createdAt) !== null);
  if (!byTime) return { rows: [...entries], byTime: false };

  return {
    rows: [...entries].sort((a, b) => (timeOf(a.createdAt) ?? 0) - (timeOf(b.createdAt) ?? 0)),
    byTime: true,
  };
}

/**
 * Os blocos de `active = false` de uma série, com o preço dos dois lados.
 *
 * Entradas com `active = null` são PULADAS, não tratadas como ativas: onde o
 * campo não existe não há o que medir, e preencher o buraco com um palpite
 * fabricaria ou apagaria bloco.
 */
function falseRunsOf(bookmaker: string, series: string, entries: readonly OddsEntry[]): FalseRun[] {
  const measurable = entries.filter((e) => e.active !== null);
  const runs: FalseRun[] = [];

  let i = 0;
  while (i < measurable.length) {
    const entry = measurable[i];
    if (entry === undefined || entry.active !== false) {
      i += 1;
      continue;
    }

    const start = i;
    while (i < measurable.length && measurable[i]?.active === false) i += 1;
    const end = i - 1;

    const before = start > 0 ? measurable[start - 1] : undefined;
    const after = i < measurable.length ? measurable[i] : undefined;

    runs.push({
      bookmaker,
      series,
      startMs: timeOf(measurable[start]?.createdAt ?? null),
      endMs: timeOf(measurable[end]?.createdAt ?? null),
      startAt: measurable[start]?.createdAt ?? null,
      endAt: measurable[end]?.createdAt ?? null,
      entries: end - start + 1,
      enclosed: before !== undefined && after !== undefined,
      priceBefore: before?.price ?? null,
      priceAfter: after?.price ?? null,
    });
  }

  return runs;
}

/** Dois blocos se sobrepõem, dada a tolerância. Bloco de instante único conta. */
function coincide(a: FalseRun, b: FalseRun, toleranceMs: number): boolean {
  if (a.startMs === null || a.endMs === null || b.startMs === null || b.endMs === null)
    return false;
  return a.startMs - toleranceMs <= b.endMs && b.startMs - toleranceMs <= a.endMs;
}

function analyzeActive(perBook: ReadonlyMap<string, OddsEntry[]>, toleranceMs: number): void {
  console.log(`\n[${LABEL}] ===== padrão de \`active\` =====`);

  const all = [...perBook.values()].flat();
  const measurable = all.filter((e) => e.active !== null);

  if (all.length === 0) {
    console.log(`[${LABEL}]   nenhuma entrada de odds nesta resposta — nada a medir.`);
    return;
  }

  if (measurable.length === 0) {
    console.warn(
      `[${LABEL}]   NENHUMA entrada tem \`active\` (nem \`isActive\`, nem \`is_active\`).\n` +
        `[${LABEL}]   O padrão não é observável nesta resposta, e a pergunta do Discord\n` +
        `[${LABEL}]   continua aberta — mas por ausência do campo, não por ele ser estável.\n` +
        `[${LABEL}]   Conferir uma entrada crua antes de concluir qualquer coisa:`,
    );
    console.log(JSON.stringify(all.slice(0, 2), null, 2));
    return;
  }

  console.log(
    `[${LABEL}]   ${measurable.length}/${all.length} entrada(s) com o campo. ` +
      `${measurable.filter((e) => e.active === false).length} com active=false.`,
  );
  if (measurable.length < all.length) {
    console.log(
      `[${LABEL}]   As ${all.length - measurable.length} sem o campo ficam FORA da contagem — ` +
        `ausência não é suspensão.`,
    );
  }

  // -------------------------------------------------------------------------
  // Sinal 1 — alternância por casa, e o preço entre um bloco e o seguinte
  // -------------------------------------------------------------------------

  const runsByBook = new Map<string, FalseRun[]>();
  const unordered: string[] = [];

  for (const [book, entries] of perBook) {
    const bySeries = new Map<string, OddsEntry[]>();
    for (const entry of entries) {
      const key = seriesKeyOf(entry.path);
      const bucket = bySeries.get(key);
      if (bucket === undefined) bySeries.set(key, [entry]);
      else bucket.push(entry);
    }

    const runs: FalseRun[] = [];
    for (const [series, rows] of bySeries) {
      const { rows: sorted, byTime } = ordered(rows);
      if (!byTime && rows.some((r) => r.active !== null)) unordered.push(`${book}:${series}`);
      runs.push(...falseRunsOf(book, series, sorted));
    }
    runsByBook.set(book, runs);
  }

  console.log(`\n[${LABEL}]   transições por casa (uma série = um mercado/outcome):`);
  console.log(
    `[${LABEL}]     ${'casa'.padEnd(16)}${'séries'.padStart(7)}${'blocos'.padStart(8)}` +
      `${'true→false→true'.padStart(17)}${'c/ preço mudando'.padStart(18)}`,
  );

  for (const [book, runs] of runsByBook) {
    const seriesCount = new Set(perBook.get(book)?.map((e) => seriesKeyOf(e.path)) ?? []).size;
    const enclosed = runs.filter((r) => r.enclosed);
    const changed = enclosed.filter(priceChanged);

    console.log(
      `[${LABEL}]     ${book.padEnd(16)}${String(seriesCount).padStart(7)}` +
        `${String(runs.length).padStart(8)}${String(enclosed.length).padStart(17)}` +
        `${String(changed.length).padStart(18)}`,
    );
  }

  const allRuns = [...runsByBook.values()].flat();
  const allEnclosed = allRuns.filter((r) => r.enclosed);
  const allChanged = allEnclosed.filter(priceChanged);
  const sameBothSides = allEnclosed.filter(
    (r) => r.priceBefore !== null && r.priceAfter !== null && r.priceBefore === r.priceAfter,
  );

  if (allEnclosed.length > 0) {
    console.log(`\n[${LABEL}]   os 10 primeiros blocos fechados, com o preço dos dois lados:`);
    for (const run of allEnclosed.slice(0, 10)) {
      console.log(
        `[${LABEL}]     ${run.bookmaker.padEnd(14)}${String(run.entries).padStart(4)} entrada(s)  ` +
          `${run.startAt ?? '?'} .. ${run.endAt ?? '?'}  ` +
          `${run.priceBefore ?? '?'} -> ${run.priceAfter ?? '?'}` +
          `${priceChanged(run) ? '   PREÇO MUDOU' : ''}`,
      );
      console.log(`[${LABEL}]       série: ${run.series}`);
    }
  }

  // -------------------------------------------------------------------------
  // Sinal 2 — os blocos coincidem entre casas?
  // -------------------------------------------------------------------------

  const books = [...runsByBook.keys()].filter((b) => (runsByBook.get(b)?.length ?? 0) > 0);

  console.log(
    `\n[${LABEL}]   coincidência entre casas (tolerância ${Math.round(toleranceMs / 1000)}s):`,
  );

  if (books.length < 2) {
    console.log(
      `[${LABEL}]     menos de duas casas com bloco de false — o sinal 2 não é\n` +
        `[${LABEL}]     mensurável nesta amostra. Repetir com --bookmakers=a,b,c.`,
    );
  } else {
    for (let i = 0; i < books.length; i += 1) {
      for (let j = i + 1; j < books.length; j += 1) {
        const a = books[i] as string;
        const b = books[j] as string;
        const runsA = runsByBook.get(a) ?? [];
        const runsB = runsByBook.get(b) ?? [];

        const hitA = runsA.filter((ra) => runsB.some((rb) => coincide(ra, rb, toleranceMs)));
        const hitB = runsB.filter((rb) => runsA.some((ra) => coincide(ra, rb, toleranceMs)));

        const pctA = runsA.length === 0 ? 0 : Math.round((hitA.length / runsA.length) * 100);
        const pctB = runsB.length === 0 ? 0 : Math.round((hitB.length / runsB.length) * 100);

        console.log(
          `[${LABEL}]     ${a} × ${b}: ${hitA.length}/${runsA.length} de ${a} (${pctA}%) ` +
            `coincidem com ${hitB.length}/${runsB.length} de ${b} (${pctB}%)`,
        );
      }
    }
  }

  // -------------------------------------------------------------------------
  // Leitura
  // -------------------------------------------------------------------------

  console.log(`\n[${LABEL}]   Como ler:`);

  if (allEnclosed.length === 0) {
    console.log(
      `[${LABEL}]     Nenhum bloco fechado (true→false→true). Ou o false só aparece no\n` +
        `[${LABEL}]     fim da série — que é o normal de mercado fechando ao vivo, não\n` +
        `[${LABEL}]     suspensão — ou esta fixture não teve o fenômeno.`,
    );
  } else {
    console.log(
      `[${LABEL}]     ${allChanged.length}/${allEnclosed.length} bloco(s) fechado(s) reabrem em preço\n` +
        `[${LABEL}]     DIFERENTE; ${sameBothSides.length} reabrem no MESMO preço.`,
    );
    console.log(
      `[${LABEL}]     Preço mudando na volta é a casa tendo reprecificado enquanto estava\n` +
        `[${LABEL}]     fora — suspensão real, e o false é informação a preservar.\n` +
        `[${LABEL}]     Voltar no mesmo preço é o que uma queda de feed produz: nada\n` +
        `[${LABEL}]     aconteceu no intervalo porque não havia intervalo de verdade.`,
    );
  }

  if (books.length >= 2) {
    console.log(
      `[${LABEL}]     Coincidência alta entre casas independentes aponta para o\n` +
        `[${LABEL}]     fornecedor, não para as casas: Pinnacle e GGBet não suspendem\n` +
        `[${LABEL}]     juntas por acaso, mas a coleta que traz as duas cai para as duas.`,
    );
  }

  if (unordered.length > 0) {
    console.warn(
      `\n[${LABEL}]   ATENÇÃO: ${unordered.length} série(s) sem \`createdAt\` em todas as entradas.\n` +
        `[${LABEL}]   Nelas a ordem usada foi a do array, e a alternância medida depende de\n` +
        `[${LABEL}]   a resposta vir ordenada — o que não está prometido em lugar nenhum.\n` +
        `[${LABEL}]   Primeiras: ${unordered.slice(0, 3).join(', ')}`,
    );
  }
}

/**
 * Agrupa as entradas de odds por casa, preservando o caminho de cada uma.
 *
 * O caminho é o que a análise de `active` usa para separar séries dentro da
 * mesma casa — por isso o prefixo entra aqui, e não é reconstruído depois.
 */
function groupByBookmaker(body: unknown): Map<string, OddsEntry[]> {
  const perBook = new Map<string, OddsEntry[]>();
  const bookmakersNode = isRecord(body) ? body['bookmakers'] : undefined;

  if (Array.isArray(bookmakersNode)) {
    bookmakersNode.forEach((book, i) => {
      if (!isRecord(book)) return;
      const slug = str(book['slug']) ?? str(book['key']) ?? str(book['name']) ?? '(sem slug)';
      const entries: OddsEntry[] = [];
      collectOdds(book, entries, `bookmakers.${i}`);
      perBook.set(slug, entries);
    });
  } else if (isRecord(bookmakersNode)) {
    // Medido: `bookmakers` é um MAPA slug -> conteúdo, não uma lista. Mesma forma
    // de `/v4/participants` e do entitlement em `/v4/account` — é o padrão da casa.
    for (const [slug, content] of Object.entries(bookmakersNode)) {
      const entries: OddsEntry[] = [];
      collectOdds(content, entries, `bookmakers.${slug}`);
      perBook.set(slug, entries);
    }
  } else {
    const entries: OddsEntry[] = [];
    collectOdds(body, entries);
    perBook.set('(agrupamento não reconhecido)', entries);
  }

  return perBook;
}

async function fetchHistorical(
  fixtureId: string,
  bookmakers: readonly string[],
): Promise<CallResult> {
  return call('/v4/historical-odds', {
    fixtureId,
    bookmakers: bookmakers.slice(0, 3).join(','),
  });
}

async function probeHistorical(
  fixtureId: string,
  bookmakers: readonly string[],
  coincidenceMs: number,
): Promise<CallResult | null> {
  console.log(`\n[${LABEL}] ===== /v4/historical-odds fixtureId=${fixtureId} =====`);
  console.log(`[${LABEL}]   casas: ${bookmakers.join(', ')} (o endpoint aceita no máximo 3)`);

  const res = await fetchHistorical(fixtureId, bookmakers);

  if (!res.ok) return null;

  console.log(
    `[${LABEL}]   forma do topo: ${isRecord(res.body) ? Object.keys(res.body).join(', ') : typeof res.body}`,
  );
  console.log(
    `[${LABEL}]   etag: ${res.etag ?? '(ausente)'}   last-modified: ${res.lastModified ?? '(ausente)'}`,
  );

  // Por casa: a resposta agrupa por bookmaker, então medimos casa a casa em vez
  // de um total que esconderia uma casa vazia.
  const perBook = groupByBookmaker(res.body);

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

  analyzeActive(perBook, coincidenceMs);

  return res;
}

// ---------------------------------------------------------------------------
// Imutabilidade — evidência própria, sem depender de resposta de ninguém
// ---------------------------------------------------------------------------
//
// A pergunta: o histórico de uma fixture ANTIGA é imutável? Se for, o enricher
// pode cachear para sempre, o backfill é reprodutível e o replay do eval usa a
// série sem medo. Se não for — se a OddsPapi reescreve o passado quando corrige
// um feed — então o que o eval leria hoje não é o que existia na época, e a
// série deixa de ser point-in-time por mais carimbo que tenha.
//
// A doc não promete nada e o Discord não respondeu. O que resolve isso é tempo:
// gravar a resposta de uma fixture já encerrada, esperar, e buscar de novo.
//
//   npm run oddspapi:probe -- --fixture=<id> --bookmakers=a,b,c --snapshot
//   ... duas semanas ...
//   npm run oddspapi:probe -- --compare=probes/oddspapi/<id>.json
//
// As duas passadas gastam ZERO requisição billable: `/v4/historical-odds` é
// declarado livre (item 1), e `--compare` não chama descoberta nenhuma.
//
// Três evidências, de forças diferentes:
//
//   ETag igual        — o servidor AFIRMA que não mudou. É a mais forte, e a
//                       única que fala sobre intenção em vez de coincidência.
//   Hash canônico igual — o conteúdo não mudou, mesmo que a ordem das chaves ou
//                       o espaçamento tenham mudado. É a que interessa ao cache.
//   Bytes iguais      — nem a serialização mudou. Boa de ter, mas diferença aqui
//                       sozinha não é mutação de dado.
//
// O diff, quando houver, separa o que importa: ENTRADA ALTERADA (preço, active
// ou createdAt de uma entrada que já existia) é reescrita do passado e mata a
// imutabilidade. ENTRADA NOVA numa fixture encerrada é outra coisa — chegada
// tardia de dado, que o cache pode tolerar com TTL mas o replay não.

const SNAPSHOT_KIND = 'oddspapi-historical-odds-snapshot';

/** O `kind` das respostas de `/v4/fixtures` — formato igual, endpoint outro. */
const FIXTURES_SNAPSHOT_KIND = 'oddspapi-fixtures-snapshot';

const SNAPSHOT_DIR = 'probes/oddspapi';

interface Snapshot {
  readonly kind: string;
  readonly version: number;
  readonly fetchedAt: string;
  readonly endpoint: string;
  readonly params: Record<string, string>;
  readonly status: number;
  readonly etag: string | null;
  readonly lastModified: string | null;
  readonly rawSha256: string;
  readonly canonicalSha256: string;
  readonly body: unknown;
}

/**
 * JSON com as chaves ordenadas, em qualquer profundidade.
 *
 * Sem isso, uma troca de ordem de chaves — que nenhum servidor promete estável —
 * apareceria como "o passado mudou". O hash canônico é o que responde à pergunta
 * de conteúdo; o hash cru fica ao lado para a pergunta de serialização.
 */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (isRecord(value)) {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

async function sha256(text: string): Promise<string> {
  const { createHash } = await import('node:crypto');
  return createHash('sha256').update(text).digest('hex');
}

function snapshotPathFor(fixtureId: string, given: string | null): string {
  if (given !== null && given.length > 0) return given;
  return `${SNAPSHOT_DIR}/${fixtureId}.json`;
}

async function writeSnapshot(
  file: string,
  endpoint: string,
  params: Record<string, string>,
  res: CallResult,
  kind: string = SNAPSHOT_KIND,
): Promise<void> {
  const { mkdir, writeFile } = await import('node:fs/promises');
  const { dirname } = await import('node:path');

  const snapshot: Snapshot = {
    kind,
    version: 1,
    fetchedAt: new Date().toISOString(),
    endpoint,
    // `params` NUNCA inclui a chave: ela é acrescentada dentro de `call`, na URL.
    // Um arquivo destes é feito para durar duas semanas em disco e possivelmente
    // ser commitado — vazar credencial nele seria vazá-la para sempre.
    params,
    status: res.status,
    etag: res.etag,
    lastModified: res.lastModified,
    rawSha256: await sha256(res.text),
    canonicalSha256: await sha256(canonical(res.body)),
    body: res.body,
  };

  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');

  console.log(`\n[${LABEL}] ===== snapshot gravado =====`);
  console.log(`[${LABEL}]   arquivo: ${file}`);
  console.log(`[${LABEL}]   etag: ${res.etag ?? '(ausente)'}`);
  console.log(`[${LABEL}]   sha256 canônico: ${snapshot.canonicalSha256}`);
  console.log(`[${LABEL}]   sha256 cru:      ${snapshot.rawSha256}`);
  console.log(
    `\n[${LABEL}]   Daqui a duas semanas, para responder à imutabilidade com medida:\n` +
      `[${LABEL}]     npm run oddspapi:probe -- --compare=${file}`,
  );
}

/** Folhas do JSON, achatadas em `caminho -> valor`. É sobre isso que o diff fala. */
function leaves(value: unknown, out: Map<string, unknown>, path = ''): void {
  if (Array.isArray(value)) {
    value.forEach((item, i) => leaves(item, out, path.length > 0 ? `${path}.${i}` : `${i}`));
    return;
  }
  if (isRecord(value)) {
    for (const [k, v] of Object.entries(value)) {
      leaves(v, out, path.length > 0 ? `${path}.${k}` : k);
    }
    return;
  }
  out.set(path, value);
}

async function compareSnapshot(file: string, coincidenceMs: number): Promise<void> {
  const { readFile } = await import('node:fs/promises');

  const parsed: unknown = JSON.parse(await readFile(file, 'utf8'));
  if (!isRecord(parsed) || parsed['kind'] !== SNAPSHOT_KIND) {
    console.error(`[${LABEL}] ${file} não é um snapshot desta sonda (kind != ${SNAPSHOT_KIND}).`);
    process.exit(1);
  }
  const before = parsed as unknown as Snapshot;

  const fixtureId = before.params['fixtureId'] ?? '';
  const bookmakers = (before.params['bookmakers'] ?? '').split(',').filter((s) => s.length > 0);

  console.log(`[${LABEL}] ===== comparação com snapshot =====`);
  console.log(`[${LABEL}]   arquivo:  ${file}`);
  console.log(`[${LABEL}]   gravado:  ${before.fetchedAt}`);
  console.log(`[${LABEL}]   fixture:  ${fixtureId}`);
  console.log(`[${LABEL}]   casas:    ${bookmakers.join(', ')}`);

  const ageMs = Date.now() - Date.parse(before.fetchedAt);
  const ageDays = Number.isFinite(ageMs) ? Math.round(ageMs / 86_400_000) : null;
  console.log(`[${LABEL}]   idade:    ${ageDays === null ? '?' : `${ageDays} dia(s)`}`);
  if (ageDays !== null && ageDays < 7) {
    console.warn(
      `[${LABEL}]   Menos de uma semana. Igualdade aqui é fraca como evidência:\n` +
        `[${LABEL}]   correção de feed leva dias para aparecer. Repetir mais tarde.`,
    );
  }

  const after = await fetchHistorical(fixtureId, bookmakers);
  if (!after.ok) {
    console.error(`[${LABEL}]   refetch falhou (HTTP ${after.status}) — nada a comparar.`);
    process.exit(1);
  }

  const rawSha = await sha256(after.text);
  const canonicalSha = await sha256(canonical(after.body));

  console.log(`\n[${LABEL}]   ${'evidência'.padEnd(22)}${'antes'.padEnd(20)}agora`);
  const etagLine = `${(before.etag ?? '(ausente)').slice(0, 18).padEnd(20)}${(after.etag ?? '(ausente)').slice(0, 18)}`;
  console.log(`[${LABEL}]     ${'etag'.padEnd(20)}${etagLine}`);
  console.log(
    `[${LABEL}]     ${'sha256 canônico'.padEnd(20)}${before.canonicalSha256.slice(0, 16).padEnd(20)}${canonicalSha.slice(0, 16)}`,
  );
  console.log(
    `[${LABEL}]     ${'sha256 cru'.padEnd(20)}${before.rawSha256.slice(0, 16).padEnd(20)}${rawSha.slice(0, 16)}`,
  );

  const sameEtag = before.etag !== null && after.etag !== null && before.etag === after.etag;
  const sameCanonical = before.canonicalSha256 === canonicalSha;
  const sameRaw = before.rawSha256 === rawSha;

  console.log(`\n[${LABEL}]   VEREDITO:`);
  if (sameCanonical) {
    console.log(
      `[${LABEL}]     Conteúdo IDÊNTICO${sameRaw ? ' (byte a byte, inclusive)' : ' (bytes diferem: só serialização)'}.`,
    );
    console.log(
      `[${LABEL}]     ${
        sameEtag
          ? 'ETag igual: o servidor também afirma que não mudou.'
          : before.etag === null || after.etag === null
            ? 'Sem ETag para confirmar — a igualdade é observada, não prometida.'
            : 'ETag MUDOU apesar do conteúdo igual: o ETag deles não é estável, e não serve de atalho de cache.'
      }`,
    );
    console.log(
      `[${LABEL}]     ${ageDays ?? '?'} dia(s) sem mudança é evidência A FAVOR da imutabilidade —\n` +
        `[${LABEL}]     de uma fixture, num intervalo. Não é garantia, e o enricher deve\n` +
        `[${LABEL}]     dizer isso: continua sendo ausência de promessa, não promessa.`,
    );
    return;
  }

  console.log(`[${LABEL}]     O PASSADO MUDOU. Detalhe abaixo.`);

  if (sameEtag) {
    console.error(
      `[${LABEL}]     E o ETag NÃO mudou junto. O ETag deles mente: um cache que\n` +
        `[${LABEL}]     confiasse nele para revalidar serviria dado velho achando que\n` +
        `[${LABEL}]     está atualizado. Isso é achado sobre o fornecedor, não sobre\n` +
        `[${LABEL}]     esta fixture, e vale para o desenho inteiro do enricher.`,
    );
  }

  const oldLeaves = new Map<string, unknown>();
  const newLeaves = new Map<string, unknown>();
  leaves(before.body, oldLeaves);
  leaves(after.body, newLeaves);

  const changed: string[] = [];
  const added: string[] = [];
  const removed: string[] = [];

  for (const [path, value] of oldLeaves) {
    if (!newLeaves.has(path)) removed.push(path);
    else if (JSON.stringify(newLeaves.get(path)) !== JSON.stringify(value)) changed.push(path);
  }
  for (const path of newLeaves.keys()) {
    if (!oldLeaves.has(path)) added.push(path);
  }

  console.log(
    `\n[${LABEL}]   folhas: ${changed.length} alterada(s), ${added.length} nova(s), ${removed.length} removida(s)`,
  );

  // O corte que decide: entrada que JÁ EXISTIA e mudou é reescrita do passado.
  // Entrada nova numa fixture encerrada é chegada tardia — problema diferente,
  // e com solução diferente (TTL resolve uma, nada resolve a outra).
  const rewritten = changed.filter((p) => /\.(price|active|isActive|is_active|createdAt)$/.test(p));

  if (rewritten.length > 0) {
    console.error(
      `\n[${LABEL}]   ${rewritten.length} entrada(s) EXISTENTE(S) tiveram price/active/createdAt\n` +
        `[${LABEL}]   reescritos. Isto mata a imutabilidade: o que o eval leria hoje não é\n` +
        `[${LABEL}]   o que existia na época, e a série não é point-in-time por mais\n` +
        `[${LABEL}]   carimbo que ela tenha. supportsPointInTime tem que continuar false.`,
    );
    for (const path of rewritten.slice(0, 20)) {
      console.log(
        `[${LABEL}]     ${path}\n` +
          `[${LABEL}]       ${JSON.stringify(oldLeaves.get(path))} -> ${JSON.stringify(newLeaves.get(path))}`,
      );
    }
  } else if (changed.length > 0) {
    console.log(
      `\n[${LABEL}]   Nenhuma mudança em price/active/createdAt. As ${changed.length} alteradas\n` +
        `[${LABEL}]   são outros campos — conferir se são metadados voláteis (contadores,\n` +
        `[${LABEL}]   carimbos de resposta) antes de concluir mutação de dado:`,
    );
    for (const path of changed.slice(0, 20)) {
      console.log(
        `[${LABEL}]     ${path}: ${JSON.stringify(oldLeaves.get(path))} -> ${JSON.stringify(newLeaves.get(path))}`,
      );
    }
  }

  if (added.length > 0) {
    const perBookBefore = groupByBookmaker(before.body);
    const perBookAfter = groupByBookmaker(after.body);
    console.log(`\n[${LABEL}]   entradas de odds por casa, antes -> agora:`);
    for (const slug of new Set([...perBookBefore.keys(), ...perBookAfter.keys()])) {
      console.log(
        `[${LABEL}]     ${slug.padEnd(16)}${String(perBookBefore.get(slug)?.length ?? 0).padStart(6)} ->` +
          `${String(perBookAfter.get(slug)?.length ?? 0).padStart(6)}`,
      );
    }
    console.log(
      `[${LABEL}]   Entrada NOVA numa fixture encerrada é chegada tardia de dado, não\n` +
        `[${LABEL}]   reescrita. Um cache com TTL sobrevive a isso; um replay que assume\n` +
        `[${LABEL}]   a série fechada, não.`,
    );
  }

  console.log(`\n[${LABEL}]   O padrão de \`active\` na resposta de AGORA:`);
  analyzeActive(groupByBookmaker(after.body), coincidenceMs);
}

// ---------------------------------------------------------------------------
// `--truncation` — /v4/fixtures corta a lista em algum teto?
// ---------------------------------------------------------------------------

/** Datas da janela pequena (A) e da grande (B). B contém A inteira. */
const TRUNCATION_INNER_DATES = 3;
const TRUNCATION_OUTER_DATES = 9;

function isoDay(epochDay: number): string {
  return new Date(epochDay * 86_400_000).toISOString().slice(0, 10);
}

/** Quantas fixtures por data de `startTime`, para ler a semântica da faixa. */
function byStartDate(body: unknown): Map<string, number> {
  const out = new Map<string, number>();
  for (const row of firstObjectArray(body) ?? []) {
    const day = (str(row['startTime']) ?? '????-??-??').slice(0, 10);
    out.set(day, (out.get(day) ?? 0) + 1);
  }
  return new Map([...out].sort(([x], [y]) => x.localeCompare(y)));
}

/** Ids de fixture da resposta crua, na ordem em que vieram. */
function fixtureIdsOf(body: unknown): string[] {
  const rows = firstObjectArray(body) ?? [];
  return rows
    .map((row) => str(row['fixtureId']) ?? str(row['id']))
    .filter((id): id is string => id !== null);
}

/**
 * A envelopagem CRUA, que é o que ninguém neste projeto jamais viu.
 *
 * `firstObjectArray` cava até o primeiro array de objetos e devolve só ele —
 * então todo campo em volta da lista (cursor, total, página) foi descartado
 * antes de qualquer código enxergar. Este passo existe para acabar com isso.
 */
function describeEnvelope(label: string, body: unknown): void {
  console.log(`\n[${LABEL}]   --- envelopagem de ${label} ---`);

  if (Array.isArray(body)) {
    console.log(`[${LABEL}]     raiz: ARRAY cru de ${body.length} item(ns) — não há envelope.`);
  } else if (isRecord(body)) {
    console.log(`[${LABEL}]     raiz: objeto com ${Object.keys(body).length} chave(s):`);
    for (const [k, v] of Object.entries(body)) {
      const tipo = Array.isArray(v)
        ? `array[${v.length}]`
        : v === null
          ? 'null'
          : isRecord(v)
            ? `objeto{${Object.keys(v).join(',').slice(0, 60)}}`
            : `${typeof v} = ${JSON.stringify(v)?.slice(0, 60)}`;
      console.log(`[${LABEL}]       ${k}: ${tipo}`);
    }
  } else {
    console.log(`[${LABEL}]     raiz: ${typeof body}`);
  }

  const rows = firstObjectArray(body) ?? [];
  const first = rows[0];
  if (first !== undefined) {
    console.log(`[${LABEL}]     campos da 1ª fixture: ${Object.keys(first).join(', ')}`);
  }
}

/**
 * Modo `--truncation`: duas janelas, uma dentro da outra, e a pergunta que só
 * elas respondem.
 *
 * ## Por que inclusão de conjunto, e não contagem
 *
 * O aviso que roda em produção (`describeTruncationRisk`) é heurística: número
 * redondo e campo de paginação. 200 e 50 são tetos tão comuns quanto 250, e
 * nenhum número prova nada sozinho.
 *
 * Este teste é conclusivo. B contém A no tempo, então B tem que conter A no
 * conjunto: toda fixture devolvida na janela de 3 datas OBRIGATORIAMENTE aparece
 * na de 9 datas. Se faltar uma, B foi cortada — e isso é prova, não indício,
 * porque independe de o teto ser redondo, de estar documentado ou de a
 * envelopagem confessar.
 *
 * O secundário é a razão das contagens: sem teto, B ≈ 3 × A. Contagens parecidas
 * com janelas de tamanhos diferentes é teto batendo nas duas.
 *
 * ## Orçamento
 *
 * EXATAMENTE 2 requisições billable, e nada mais. Este modo sai antes do fluxo
 * normal da sonda justamente por isso: `/v4/bookmakers`, descoberta e
 * `--coverage` não rodam. `/v4/account` é declarado livre e é lido duas vezes,
 * antes e depois, para conferir o que a contabilidade deles diz.
 */
async function probeTruncation(center: string): Promise<void> {
  const centerDay = Math.floor(Date.parse(`${center}T00:00:00Z`) / 86_400_000);
  if (!Number.isFinite(centerDay)) {
    console.error(`[${LABEL}] --truncation=${center} não é uma data válida (YYYY-MM-DD)`);
    process.exit(1);
  }

  const innerPad = (TRUNCATION_INNER_DATES - 1) / 2;
  const outerPad = (TRUNCATION_OUTER_DATES - 1) / 2;

  const a = { from: isoDay(centerDay - innerPad), to: isoDay(centerDay + innerPad) };
  const b = { from: isoDay(centerDay - outerPad), to: isoDay(centerDay + outerPad) };

  console.log(
    `[${LABEL}] ===== TRUNCAMENTO de /v4/fixtures =====\n` +
      `[${LABEL}]   A (${TRUNCATION_INNER_DATES} datas): ${a.from}..${a.to}\n` +
      `[${LABEL}]   B (${TRUNCATION_OUTER_DATES} datas): ${b.from}..${b.to}\n` +
      `[${LABEL}]   B contém A: ${b.from <= a.from && a.to <= b.to ? 'sim' : 'NÃO — teste inválido'}\n` +
      `[${LABEL}]   Custo: EXATAMENTE 2 billable. Nenhuma outra chamada paga neste modo.\n`,
  );

  if (!(b.from <= a.from && a.to <= b.to)) {
    console.error(`[${LABEL}] janelas mal formadas — abortado antes de gastar cota.`);
    process.exit(1);
  }

  const antes = await readAccount('ANTES');

  const params = (w: { from: string; to: string }): Record<string, string> => ({
    sportId: String(SPORT_CS2),
    from: w.from,
    to: w.to,
  });

  const resA = await call('/v4/fixtures', params(a));
  const resB = await call('/v4/fixtures', params(b));

  const depois = await readAccount('DEPOIS');

  if (!resA.ok || !resB.ok) {
    console.error(`[${LABEL}] uma das janelas falhou (A=${resA.status} B=${resB.status}) — sem veredito.`);
    return;
  }

  // O corpo cru das duas, antes de qualquer conclusão: é a primeira resposta de
  // `/v4/fixtures` registrada neste projeto, e vale mais que o teste.
  await writeSnapshot(
    `${SNAPSHOT_DIR}/fixtures-${a.from}_${a.to}.json`,
    '/v4/fixtures',
    params(a),
    resA,
    FIXTURES_SNAPSHOT_KIND,
  );
  await writeSnapshot(
    `${SNAPSHOT_DIR}/fixtures-${b.from}_${b.to}.json`,
    '/v4/fixtures',
    params(b),
    resB,
    FIXTURES_SNAPSHOT_KIND,
  );

  describeEnvelope(`A (${a.from}..${a.to})`, resA.body);
  describeEnvelope(`B (${b.from}..${b.to})`, resB.body);

  const idsA = fixtureIdsOf(resA.body);
  const idsB = fixtureIdsOf(resB.body);
  const setB = new Set(idsB);
  const faltando = idsA.filter((id) => !setB.has(id));

  console.log(`\n[${LABEL}] ===== RESULTADO =====`);
  console.log(`[${LABEL}]   A: ${idsA.length} fixture(s) em ${TRUNCATION_INNER_DATES} datas`);
  console.log(`[${LABEL}]   B: ${idsB.length} fixture(s) em ${TRUNCATION_OUTER_DATES} datas`);
  // A razão é o teste SECUNDÁRIO, e é fraco quando a janela cruza o "agora":
  // eles publicam fixture com pouca antecedência, então as datas futuras vêm
  // quase vazias e as passadas cheias. Razão muito acima de 3× é isso, não teto.
  // Quem decide é a inclusão de conjunto acima.
  console.log(
    `[${LABEL}]   razão B/A: ${idsA.length === 0 ? '—' : (idsB.length / idsA.length).toFixed(2)}` +
      ` (esperado ~${(TRUNCATION_OUTER_DATES / TRUNCATION_INNER_DATES).toFixed(1)}× com densidade uniforme;` +
      ` janela que cruza o presente distorce isso)`,
  );
  console.log(`[${LABEL}]   ids de A ausentes em B: ${faltando.length}`);

  // A distribuição por data é o que revela a SEMÂNTICA da faixa, e ela não está
  // documentada. Sem isto, a razão B/A parece anômala sem explicação — e a
  // explicação muda o que a janela de produção cobre de verdade.
  const histA = byStartDate(resA.body);
  const histB = byStartDate(resB.body);
  const fmt = (h: Map<string, number>): string =>
    [...h].map(([d, n]) => `${d.slice(5)}:${n}`).join('  ') || '(vazio)';
  console.log(`[${LABEL}]   A por data de início: ${fmt(histA)}`);
  console.log(`[${LABEL}]   B por data de início: ${fmt(histB)}`);

  // O teste da borda: B (que contém A) enxerga fixtures na data `to` de A?
  // Se enxerga e A não devolveu nenhuma, o `to` de A não entrou na faixa.
  const naDataTo = histB.get(a.to) ?? 0;
  const aTrouxeTo = histA.get(a.to) ?? 0;
  const naDataFrom = histA.get(a.from) ?? 0;

  console.log(`\n[${LABEL}]   SEMÂNTICA DA FAIXA (medida, não documentada):`);
  if (naDataTo > 0 && aTrouxeTo === 0) {
    console.log(
      `[${LABEL}]     \`to\` é EXCLUSIVO. B tem ${naDataTo} fixture(s) em ${a.to} e A, cujo\n` +
        `[${LABEL}]     \`to\` é exatamente ${a.to}, não devolveu nenhuma delas.\n` +
        `[${LABEL}]     Consequência para o enricher: a janela cobre [from, to), então o dia\n` +
        `[${LABEL}]     de folga do FIM (DISCOVERY_PAD_DAYS) não é consultado — só o do começo.`,
    );
  } else if (aTrouxeTo > 0) {
    console.log(`[${LABEL}]     \`to\` é INCLUSIVO: A devolveu ${aTrouxeTo} fixture(s) em ${a.to}.`);
  } else {
    console.log(
      `[${LABEL}]     INDETERMINADO: não há fixture em ${a.to} nem em A nem em B, então a\n` +
        `[${LABEL}]     borda superior não foi exercitada. Repita num período mais denso.`,
    );
  }
  console.log(
    `[${LABEL}]     \`from\` parece ${naDataFrom > 0 ? 'INCLUSIVO' : 'não exercitado'}` +
      ` (A tem ${naDataFrom} fixture(s) em ${a.from}).`,
  );

  // O aviso que roda em produção, medido contra a resposta real: ele dispararia?
  const { describeTruncationRisk, paginationHintsOf } = await import('../src/lib/oddspapi-api.js');
  for (const [nome, res, ids] of [
    ['A', resA, idsA],
    ['B', resB, idsB],
  ] as const) {
    const hints = paginationHintsOf(res.body);
    const risco = describeTruncationRisk(ids.length, res.body);
    console.log(
      `[${LABEL}]   guarda de produção em ${nome}: ${risco === null ? 'silenciosa' : 'DISPARARIA'}` +
        ` (campos de paginação: ${hints.length === 0 ? 'nenhum' : hints.join(', ')})`,
    );
  }

  console.log(`\n[${LABEL}]   VEREDITO:`);
  if (idsA.length === 0) {
    console.log(
      `[${LABEL}]     INCONCLUSIVO — a janela A voltou vazia. Escolha um período com CS2\n` +
        `[${LABEL}]     denso: --truncation=YYYY-MM-DD. As 2 requisições foram gastas.`,
    );
  } else if (faltando.length > 0) {
    // Uma ou duas ausências não fecham o caso: as duas chamadas são separadas
    // por segundos, e uma fixture cadastrada nesse intervalo apareceria em A e
    // faltaria em B sem nenhum truncamento envolvido. Truncamento é sistemático
    // — corta muitas, e a contagem de B para num teto.
    const provavelCorrida = faltando.length <= 2;
    console.log(
      `[${LABEL}]     ${faltando.length} fixture(s) de A não aparecem em B, que a contém no tempo.\n` +
        `[${LABEL}]     Contagem de B: ${idsB.length}.\n` +
        `[${LABEL}]     Ausentes: ${faltando.slice(0, 10).join(', ')}\n` +
        (provavelCorrida
          ? `[${LABEL}]     AMBÍGUO: são poucas, e as duas chamadas distam segundos — cabe\n` +
            `[${LABEL}]     corrida (fixture cadastrada entre A e B) tanto quanto truncamento.\n` +
            `[${LABEL}]     Repita o modo para separar: corrida não se repete, teto sim.`
          : `[${LABEL}]     TRUNCAMENTO CONFIRMADO — é sistemático demais para ser corrida.\n` +
            `[${LABEL}]     Teto observado: ${idsB.length} fixture(s).\n` +
            `[${LABEL}]     PARE aqui: DISCOVERY_BLOCK_DAYS precisa encolher, e o tamanho novo\n` +
            `[${LABEL}]     muda a conta de orçamento inteira. Não é decisão da sonda.`),
    );
  } else {
    console.log(
      `[${LABEL}]     SEM TRUNCAMENTO nesta amostra. Toda fixture de A aparece em B, e B\n` +
        `[${LABEL}]     é ${(idsB.length / idsA.length).toFixed(2)}× maior — a janela de ${TRUNCATION_OUTER_DATES} datas devolve a lista completa.\n` +
        `[${LABEL}]     Vale para ESTE tamanho de lista (${idsB.length}); um teto acima disso\n` +
        `[${LABEL}]     continuaria invisível, e é o que a guarda em produção vigia.`,
    );
  }

  const diff = [...depois.entries()].map(([k, v]) => `${k}: ${antes.get(k) ?? '—'} → ${v}`);
  console.log(`\n[${LABEL}]   /v4/account antes vs depois:`);
  if (diff.length === 0) {
    console.log(
      `[${LABEL}]     NENHUM contador observável, nem no corpo nem em header — confirma a\n` +
        `[${LABEL}]     medição anterior. A diferença de 2 não é verificável do lado deles;\n` +
        `[${LABEL}]     o que se pode afirmar é que ESTA sonda fez 2 chamadas billable\n` +
        `[${LABEL}]     (contador interno abaixo). Confira o painel para o número real.`,
    );
  } else {
    for (const line of diff) console.log(`[${LABEL}]     ${line}`);
  }

  console.log(
    `\n[${LABEL}]   contador interno desta passada: ${billableSpent} billable, ${freeSpent} livre(s).`,
  );
  if (billableSpent !== 2) {
    console.error(
      `[${LABEL}]   ATENÇÃO: eram para ser exatamente 2 billable e foram ${billableSpent}.`,
    );
  }
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  if ((process.env['ODDSPAPI_API_KEY'] ?? '').length === 0) {
    console.error(`[${LABEL}] ODDSPAPI_API_KEY ausente no ambiente.`);
    process.exit(1);
  }

  // Uma ÚNICA janela de 9 datas, terminando em torno de hoje.
  //
  // O default era 2026-07-01..2026-07-31, e isso custava caro sem dizer: um mês
  // não é uma requisição, é QUATRO — `windows()` o parte em pedaços de 9 dias
  // porque a API rejeita range acima de 10, e cada pedaço é uma chamada
  // billable. A sonda anunciava "2 billable" no topo e gastava 5 em qualquer
  // invocação sem flags. O default agora é o que a linha do topo promete.
  //
  // Derivar de "hoje" aqui é o certo, ao contrário de `discoveryWindow` no
  // enricher: lá a fronteira móvel invalidaria o cache todo dia, aqui não há
  // cache nenhum e o que se quer é justamente o período recente e denso.
  const hoje = Math.floor(Date.now() / 86_400_000);
  const from = flag('from') ?? isoDay(hoje - 4);
  const to = flag('to') ?? isoDay(hoje + 4);
  const withDb = flag('with-db') !== null;

  const coincidenceRaw = Number(flag('coincidence-ms') ?? '');
  const coincidenceMs =
    Number.isFinite(coincidenceRaw) && coincidenceRaw > 0 ? coincidenceRaw : DEFAULT_COINCIDENCE_MS;

  // `--compare` é modo próprio e sai antes de tudo: não faz descoberta, não lê o
  // banco, não gasta billable. Só refaz a MESMA chamada gravada no arquivo.
  const compareFile = flag('compare');
  if (compareFile !== null && compareFile.length > 0) {
    await compareSnapshot(compareFile, coincidenceMs);
    return;
  }

  // `--truncation` é modo próprio pelo mesmo motivo que `--compare`, e aqui o
  // motivo é orçamento: ele gasta EXATAMENTE 2 billable e sair no topo é o que
  // garante isso. Abaixo desta linha vêm `/v4/bookmakers`, a descoberta e o
  // resto — nenhum deles roda neste modo.
  const truncation = flag('truncation');
  if (truncation !== null) {
    const center = truncation.length > 0 ? truncation : isoDay(Math.floor(Date.now() / 86_400_000));
    await probeTruncation(center);
    return;
  }

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

  // A pergunta que o contador de recusas deixou aberta: 35% de cobertura é teto
  // deles ou defeito nosso? Este passo mede pela lógica de PRODUÇÃO, sobre as
  // nossas partidas, e classifica cada falha.
  if (flag('coverage') !== null) await measureCoverage(from, to);

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
    const historical = await probeHistorical(target, chosenBooks, coincidenceMs);

    const snapshotFlag = flag('snapshot');
    if (snapshotFlag !== null && historical !== null) {
      // A fixture tem que estar ENCERRADA para o snapshot valer alguma coisa:
      // uma em andamento muda porque ainda está acontecendo, e a comparação
      // daqui a duas semanas não distinguiria isso de reescrita do passado.
      if (finished !== undefined && !finished.finished && explicit === null) {
        console.warn(
          `\n[${LABEL}] ATENÇÃO: a fixture escolhida não tem trueEndTime. O snapshot vai\n` +
            `[${LABEL}] gravar uma série ainda em movimento, e a comparação futura não vai\n` +
            `[${LABEL}] separar "mudou porque continuou" de "mudou porque reescreveram".\n` +
            `[${LABEL}] Prefira --fixture=<id de partida encerrada>.`,
        );
      }
      await writeSnapshot(
        snapshotPathFor(target, snapshotFlag),
        '/v4/historical-odds',
        { fixtureId: target, bookmakers: chosenBooks.slice(0, 3).join(',') },
        historical,
      );
    }
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
