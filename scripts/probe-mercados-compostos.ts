import 'dotenv/config';

import {
  SPACING_MS,
  call,
  callCounts,
  isRecord,
  num,
  section,
  sha256,
  table,
  totalCalls,
  writeSnapshot,
} from './lib/probe-net.js';

/**
 * Sondagem de mercados COMPOSTOS — quantos existem, e quantos têm pernas.
 *
 * Composto é o mercado que depende de dois fatos ao mesmo tempo: "A e B", "A
 * antes de B", "X ganha e Y perde", "A sem B". Interessa porque tem piso e teto
 * ARITMÉTICOS, os limites de Fréchet:
 *
 *     P(A e B) <= min(P(A), P(B))
 *     P(A e B) >= P(A) + P(B) - 1
 *
 * Preço fora desse intervalo é impossível, não é opinião. Mas a conta só existe
 * se A e B forem NEGOCIÁVEIS separados — sem as pernas não há limite a violar,
 * e o composto vira só mais um mercado com preço que ninguém pode contestar.
 *
 * A fase 2 do extrator propôs ZERO conjunções em 927 relações. Ou a amostra
 * (tênis de mesa) não tinha nenhuma, ou composto é raro no Polymarket. Esta
 * contagem decide qual — e ela NÃO mede preço errado. Ela responde se existe
 * população suficiente para valer olhar preço depois.
 *
 * ZERO LLM, zero escrita no banco, zero migration. Só leitura da Gamma e da
 * CLOB, espaçada e contada.
 *
 * ## Duas fases, porque o meio do caminho é humano
 *
 * O casador de texto é grosseiro por construção, e a única forma honesta de
 * saber quanto ele erra é ler. Então a sonda para no meio:
 *
 *   fase `varredura` — pagina o universo aberto, casa texto, e IMPRIME 50 dos
 *     que bateram, pergunta inteira, para classificação à mão. Guarda em
 *     `probes/compostos/` o índice do universo e os casados.
 *   (aqui um humano escreve `probes/compostos/rotulos.json`)
 *   fase `pernas` — sobre os rotulados VERDADEIROS, parte a pergunta nas duas
 *     pernas, procura cada perna no índice do universo, e mede o livro das que
 *     acharam as duas.
 *
 * A fase 2 não repagina nada: ela lê os arquivos da fase 1. Um erro de rótulo
 * custa segundos, não outra varredura de 850 MB numa API gratuita.
 *
 * ## Uso
 *
 *   npm run compostos -- --dry-run          # dimensiona e para
 *   npm run compostos                       # varredura completa
 *   npm run compostos -- --max-paginas=100  # varredura curta, para testar
 *   npm run compostos -- --fase=pernas      # segunda fase, sobre os rótulos
 */

const LABEL = 'probe-compostos';

const GAMMA = process.env['POLYMARKET_GAMMA_URL'] ?? 'https://gamma-api.polymarket.com';
const CLOB = 'https://clob.polymarket.com';
const DIR = 'probes/compostos';

/** `limit` satura em 100 por página — medido na sonda do universo, não documentado. */
const PAGE = 100;

/** Teto DURO de `offset` na Gamma: acima de 2000 vem HTTP 422. */
const OFFSET_CEILING = 2000;

/** A árvore de contagem que a sonda do universo já pagou. Ver `--dry-run`. */
const STRATA_CACHE = 'probes/polymarket/strata.json';

const ARQ_UNIVERSO = `${DIR}/universo.jsonl`;
const ARQ_CASADOS = `${DIR}/casados.json`;
const ARQ_ROTULOS = `${DIR}/rotulos.json`;

const OPEN_FILTER = { closed: 'false', active: 'true', archived: 'false' } as const;

// ---------------------------------------------------------------------------
// Flags
// ---------------------------------------------------------------------------

interface Args {
  dryRun: boolean;
  fase: 'varredura' | 'pernas';
  maxPaginas: number;
  amostra: number;
  write: boolean;
}

function parseArgs(argv: readonly string[]): Args | { error: string } {
  const args: Args = { dryRun: false, fase: 'varredura', maxPaginas: Infinity, amostra: 50, write: true };
  for (const arg of argv) {
    if (arg === '--dry-run') {
      args.dryRun = true;
      continue;
    }
    if (arg === '--no-write') {
      args.write = false;
      continue;
    }
    if (arg === '--fase=pernas' || arg === '--fase=varredura') {
      args.fase = arg.endsWith('pernas') ? 'pernas' : 'varredura';
      continue;
    }
    const m = /^--(max-paginas|amostra)=(\d+)$/.exec(arg);
    if (m === null) return { error: `argumento desconhecido: ${arg}` };
    if (m[1] === 'max-paginas') args.maxPaginas = Number(m[2]);
    else args.amostra = Number(m[2]);
  }
  return args;
}

// ---------------------------------------------------------------------------
// Gamma
// ---------------------------------------------------------------------------

interface GammaMarket {
  id: string;
  question: string;
  description?: string;
  slug?: string;
  endDate: string | null;
  clobTokenIds?: string;
  volume24hr?: number;
  liquidityNum?: number;
  bestBid?: number;
  bestAsk?: number;
  negRisk?: boolean;
  events?: Array<{ id: string; title?: string }>;
}

let bytes = 0;

async function pegar(path: string, params: Record<string, string>): Promise<unknown> {
  const res = await call(`${GAMMA}${path}?${new URLSearchParams(params).toString()}`, 'gamma');
  bytes += res.bytes;
  if (res.status !== 200) throw new Error(`Gamma HTTP ${res.status} em ${path}`);
  return res.body;
}

function comoLista(corpo: unknown, chave: string): unknown[] {
  if (Array.isArray(corpo)) return corpo;
  if (isRecord(corpo) && Array.isArray(corpo[chave])) return corpo[chave] as unknown[];
  return [];
}

function primeiroToken(m: GammaMarket): string | null {
  try {
    const lista: unknown = JSON.parse(m.clobTokenIds ?? '[]');
    return Array.isArray(lista) && typeof lista[0] === 'string' ? lista[0] : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// O CASADOR — os padrões, e o que eles erram de propósito
// ---------------------------------------------------------------------------

/**
 * Os padrões de composto. Cada um é uma conjunção que liga DOIS fatos.
 *
 * Nenhum deles é preciso, e é por isso que a precisão é medida logo abaixo em
 * vez de suposta. ` and ` é o pior de todos: "between $90 and $100" é faixa,
 * "Trump and Musk meet" é um evento só, "Russia and Ukraine ceasefire" é um
 * ator composto. Os três casam e nenhum é composto.
 */
const PADROES: Array<[string, RegExp]> = [
  ['and', / and /],
  ['both', /\bboth\b/],
  ['before', / before /],
  ['after', / after /],
  ['without', / without /],
  ['while', / while /],
  ['same day', /same day/],
  ['sweep', /\bsweep\b/],
];

/**
 * A ÚNICA armadilha que o casador desarma sozinho, porque ela é sintática e não
 * semântica: `between X and Y` é faixa de valor, nunca conjunção.
 *
 * As outras (ator composto, evento único) exigem leitura e ficam para a amostra
 * de 50 — desarmá-las na regex seria escolher a precisão antes de medi-la.
 */
/*
 * O `.` NÃO pode entrar na exclusão: ele está DENTRO do número.
 *
 * A primeira versão era `[^?.]*?`, com o ponto fora para não atravessar frase —
 * e com isso "between $0.60 and $0.70" deixou de casar, porque o ponto do
 * decimal barra o caminho até o `and`. Mediu-se o estrago no corpo da varredura:
 * 455 dos 642 do balde ` and ` eram faixa de preço que vazou por esse ponto.
 * O limite de frase volta como um teto de 60 caracteres, que é o que separa uma
 * faixa ("between $1.25T and $1.5T") de um `and` que só está longe.
 */
const FAIXA = /\bbetween\b[^?]{0,60}?\band\b/;

/**
 * Ordem de PRIORIDADE para atribuir UM padrão principal a cada mercado.
 *
 * Serve à estratificação da amostra, e a ordem é do mais específico para o mais
 * genérico: quem casa `both` e `and` ao mesmo tempo é caso de `both`, porque é
 * `both` que carrega a informação. Sem isso os baldes se sobrepõem e o mesmo
 * mercado seria conferido duas vezes com pesos diferentes.
 */
const PRIORIDADE = ['both', 'sweep', 'same day', 'without', 'while', 'before', 'after', 'and'];

function principal(padroes: readonly string[]): string {
  return PRIORIDADE.find((p) => padroes.includes(p)) ?? (padroes[0] as string);
}

interface Casado {
  id: string;
  question: string;
  slug: string;
  eventoId: string;
  eventoTitulo: string;
  /** Quais padrões dispararam na PERGUNTA. */
  padroes: string[];
  /** Quais dispararam só na `description`. */
  padroesNaDescricao: string[];
  faixa: boolean;
  tokenId: string | null;
  volume24h: number;
  bestBid: number | null;
  bestAsk: number | null;
  endDate: string | null;
}

function casar(texto: string): string[] {
  const t = ` ${texto.toLowerCase()} `;
  return PADROES.filter(([, re]) => re.test(t)).map(([nome]) => nome);
}

// ---------------------------------------------------------------------------
// Índice do universo — o que a fase 2 usa para procurar as pernas
// ---------------------------------------------------------------------------

interface Compacto {
  id: string;
  q: string;
  ev: string;
  tk: string | null;
  v: number;
}

/** Palavras que não distinguem pergunta nenhuma no Polymarket. */
const VAZIAS = new Set([
  'will', 'the', 'a', 'an', 'be', 'in', 'on', 'at', 'to', 'of', 'by', 'for', 'is', 'are',
  'this', 'that', 'it', 'or', 'and', 'do', 'does', 'did', 'have', 'has', 'with', 'from',
  'up', 'down', 'market', 'yes', 'no', 'than', 'as', 'any',
]);

function tokens(texto: string): string[] {
  return texto
    .toLowerCase()
    .replace(/[^a-z0-9$%.\s-]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 1 && !VAZIAS.has(w));
}

// ---------------------------------------------------------------------------
// Estatística
// ---------------------------------------------------------------------------

function quantil(ordenado: readonly number[], q: number): number {
  if (ordenado.length === 0) return 0;
  const pos = (ordenado.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  const a = ordenado[lo] ?? 0;
  const b = ordenado[hi] ?? a;
  return a + (b - a) * (pos - lo);
}

function pct(parte: number, todo: number): string {
  return todo === 0 ? '—' : `${((100 * parte) / todo).toFixed(1)}%`;
}

function distribuicao(valores: readonly number[], casas = 2): string {
  const s = [...valores].sort((a, b) => a - b);
  return (
    `min ${num(s[0] ?? 0, casas)}  p25 ${num(quantil(s, 0.25), casas)}  ` +
    `mediana ${num(quantil(s, 0.5), casas)}  p75 ${num(quantil(s, 0.75), casas)}  ` +
    `p95 ${num(quantil(s, 0.95), casas)}  max ${num(s[s.length - 1] ?? 0, casas)}`
  );
}

function mb(): string {
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

// ---------------------------------------------------------------------------
// FASE 1 — varredura
// ---------------------------------------------------------------------------

interface Stratum {
  from: string;
  to: string;
  markets: number | null;
}

async function lerEstratos(): Promise<{
  strata: Stratum[];
  saturated: Stratum[];
  countedAt: string;
} | null> {
  try {
    const { readFile } = await import('node:fs/promises');
    const c = JSON.parse(await readFile(STRATA_CACHE, 'utf8')) as {
      countedAt: string;
      strata: Stratum[];
      saturated: Stratum[];
    };
    return { strata: c.strata, saturated: c.saturated ?? [], countedAt: c.countedAt };
  } catch {
    return null;
  }
}

async function varredura(args: Args): Promise<void> {
  const cache = await lerEstratos();
  if (cache === null) {
    console.error(
      `[${LABEL}] ${STRATA_CACHE} não existe. Rode antes:\n` +
        '           npm run polymarket:universe -- --dry-run',
    );
    process.exit(2);
  }

  // Os SATURADOS entram na varredura junto com os contados.
  //
  // A sonda do universo os separou porque a bisseção do calendário chegou a
  // janelas de 47 segundos e elas AINDA tinham mais de 2000 mercados — são lotes
  // de mesmo `endDate` (as expirações de 14:00 UTC, o fim do ano), e por isso
  // não têm contagem exata: `markets: null`.
  //
  // Ignorá-los custaria pelo menos 6 * 2001 = ~12k mercados abertos fora da
  // varredura, ~10% do universo, sem que o relatório dissesse uma palavra. Eles
  // são varridos até o teto de offset — que é tudo o que a API deixa alcançar —
  // e o que sobra passando do teto é CONTADO em `truncados`, não escondido.
  const contados = cache.strata.filter((s) => (s.markets ?? 0) > 0);
  const saturados = cache.saturated;
  const estratos = [...contados, ...saturados];

  /** Quantas páginas cabem entre offset 0 e o teto — o máximo alcançável por estrato. */
  const PAGINAS_ATE_O_TETO = Math.floor(OFFSET_CEILING / PAGE) + 1;

  const previstos = contados.reduce((a, s) => a + (s.markets ?? 0), 0);
  const pisoSaturados = saturados.length * (OFFSET_CEILING + 1);
  const paginas =
    contados.reduce((a, s) => a + Math.ceil((s.markets ?? 0) / PAGE), 0) +
    saturados.length * PAGINAS_ATE_O_TETO;

  const cabecalho = [
    section('MERCADOS COMPOSTOS — quantos existem, e quantos têm as duas pernas'),
    '  Zero chamadas a modelo. Zero escrita no banco. Só leitura, espaçada e contada.',
    '',
    `  Estratos de data reaproveitados de ${STRATA_CACHE} (contados em ${cache.countedAt.slice(0, 16)}).`,
    '  A contagem exata do universo custou ~2.000 requisições na sonda da fase 1 e não',
    '  se paga de novo aqui: o que esta sonda precisa dela é só a partição do calendário',
    `  em fatias com menos de ${OFFSET_CEILING} mercados, que é o que torna o offset navegável.`,
    '',
    `  estratos a varrer:      ${estratos.length}  (${contados.length} contados + ${saturados.length} saturados)`,
    `  mercados abertos:       ~${previstos.toLocaleString('pt-BR')}  (contagem de ${cache.countedAt.slice(0, 10)})`,
    `  ... nos saturados:      >= ${pisoSaturados.toLocaleString('pt-BR')}  (janelas de ~47 s com mais de ${OFFSET_CEILING} mercados;`,
    `                          só os primeiros ${(OFFSET_CEILING + PAGE).toLocaleString('pt-BR')} de cada são alcançáveis por offset)`,
    `  páginas de ${PAGE}:        ~${paginas.toLocaleString('pt-BR')}`,
    `  requisições previstas:  ~${paginas.toLocaleString('pt-BR')}  (${SPACING_MS} ms de espaçamento)`,
    `  volume previsto:        ~${((paginas * 670) / 1024).toFixed(0)} MB  (uma página de ${PAGE} pesa ~670 KB, medido)`,
    `  tempo previsto:         ~${Math.ceil((paginas * 0.55) / 60)} min`,
  ];

  if (args.dryRun) {
    console.log([...cabecalho, '', '  --dry-run: parei aqui. Nenhuma página baixada.'].join('\n'));
    return;
  }

  // --- a varredura ----------------------------------------------------------

  const casados: Casado[] = [];
  const universo: Compacto[] = [];
  let vistos = 0;
  let semDescricao = 0;
  let truncados = 0;
  let pagina = 0;

  for (const [i, e] of estratos.entries()) {
    // O `offset` estoura em 2000, e o estrato foi construído para caber abaixo
    // disso. Mas a contagem é de ontem: se um estrato cresceu, a paginação para
    // no teto e o corte é CONTADO em vez de silencioso.
    for (let offset = 0; offset <= OFFSET_CEILING; offset += PAGE) {
      if (pagina >= args.maxPaginas) break;
      const corpo = await pegar('/markets', {
        ...OPEN_FILTER,
        limit: String(PAGE),
        end_date_min: e.from,
        end_date_max: e.to,
        offset: String(offset),
      });
      pagina++;
      const lista = comoLista(corpo, 'markets') as GammaMarket[];
      if (lista.length === 0) break;

      for (const m of lista) {
        vistos++;
        const pergunta = typeof m.question === 'string' ? m.question : '';
        const descricao = typeof m.description === 'string' ? m.description : '';
        if (descricao.trim() === '') semDescricao++;

        const evento = m.events?.[0];
        universo.push({
          id: String(m.id),
          q: pergunta,
          ev: String(evento?.id ?? ''),
          tk: primeiroToken(m),
          v: m.volume24hr ?? 0,
        });

        const naPergunta = casar(pergunta);
        // A `description` é texto de resolução: prosa longa, cheia de "and" de
        // ligação ("the market will resolve to Yes and the resolution source
        // will be..."). Casar nela infla o número sem produzir um composto —
        // por isso ela entra CONTADA à parte, não somada.
        const naDescricao = casar(descricao).filter((p) => !naPergunta.includes(p));

        if (naPergunta.length === 0) {
          if (naDescricao.length > 0) {
            casados.push({
              id: String(m.id),
              question: pergunta,
              slug: m.slug ?? '',
              eventoId: String(evento?.id ?? ''),
              eventoTitulo: evento?.title ?? '',
              padroes: [],
              padroesNaDescricao: naDescricao,
              faixa: false,
              tokenId: primeiroToken(m),
              volume24h: m.volume24hr ?? 0,
              bestBid: typeof m.bestBid === 'number' ? m.bestBid : null,
              bestAsk: typeof m.bestAsk === 'number' ? m.bestAsk : null,
              endDate: m.endDate,
            });
          }
          continue;
        }

        casados.push({
          id: String(m.id),
          question: pergunta,
          slug: m.slug ?? '',
          eventoId: String(evento?.id ?? ''),
          eventoTitulo: evento?.title ?? '',
          padroes: naPergunta,
          padroesNaDescricao: naDescricao,
          faixa: naPergunta.length === 1 && naPergunta[0] === 'and' && FAIXA.test(pergunta.toLowerCase()),
          tokenId: primeiroToken(m),
          volume24h: m.volume24hr ?? 0,
          bestBid: typeof m.bestBid === 'number' ? m.bestBid : null,
          bestAsk: typeof m.bestAsk === 'number' ? m.bestAsk : null,
          endDate: m.endDate,
        });
      }

      if (lista.length < PAGE) break;
      if (offset + PAGE > OFFSET_CEILING) truncados++;
    }

    if (pagina >= args.maxPaginas) {
      console.error(`[${LABEL}] teto --max-paginas=${args.maxPaginas} atingido no estrato ${i + 1}`);
      break;
    }
    if ((i + 1) % 10 === 0) {
      console.error(
        `[${LABEL}] estrato ${i + 1}/${estratos.length}: ${vistos.toLocaleString('pt-BR')} mercados, ` +
          `${casados.length} casados, ${totalCalls()} requisições, ${mb()}`,
      );
    }
  }

  // --- persistência ---------------------------------------------------------

  if (args.write) {
    const { mkdir, writeFile } = await import('node:fs/promises');
    await mkdir(DIR, { recursive: true });
    await writeFile(ARQ_UNIVERSO, universo.map((u) => JSON.stringify(u)).join('\n') + '\n', 'utf8');
    await writeFile(ARQ_CASADOS, `${JSON.stringify(casados, null, 2)}\n`, 'utf8');
    console.error(`[${LABEL}] gravados ${ARQ_UNIVERSO} e ${ARQ_CASADOS}`);

    // Snapshot de UMA página curta, no formato das outras sondas. Página de 10 e
    // não a de 100: o snapshot responde "que campos esta rota devolve", e isso
    // cabe em dez mercados — a de 100 pesa 670 KB.
    const res = await call(
      `${GAMMA}/markets?${new URLSearchParams({ ...OPEN_FILTER, limit: '10' }).toString()}`,
      'gamma',
    );
    bytes += res.bytes;
    await writeSnapshot(LABEL, `${DIR}/gamma-markets-open.json`, 'gamma-markets-open-snapshot', '/markets', { ...OPEN_FILTER, limit: '10' }, res);
  }

  // --- contagem por padrão --------------------------------------------------

  const naPergunta = casados.filter((c) => c.padroes.length > 0);
  const soDescricao = casados.filter((c) => c.padroes.length === 0);
  const limpos = naPergunta.filter((c) => !c.faixa);

  const porPadrao = PRIORIDADE.map((nome) => {
    const comEle = limpos.filter((c) => c.padroes.includes(nome));
    const principais = limpos.filter((c) => principal(c.padroes) === nome);
    return [
      nome,
      String(comEle.length),
      String(principais.length),
      pct(principais.length, limpos.length),
    ];
  });

  // --- a amostra de 50 ------------------------------------------------------

  // Sorteio DETERMINÍSTICO — ordena por sha256 do id — e ESTRATIFICADO por
  // padrão, em rodízio.
  //
  // Não é preciosismo: ` after ` sozinho é 92% dos casados, e quase todo ele é
  // "FDV above $300M one day after launch". Um sorteio simples gastaria 46 das
  // 50 conferências no mesmo molde de pergunta e não diria nada sobre ` both `
  // ou ` without `, que são os padrões cuja precisão realmente interessa. O peso
  // de cada estrato volta na hora de compor a precisão global — ver a fase 2.
  const comHash = await Promise.all(limpos.map(async (c) => ({ c, h: await sha256(c.id) })));
  comHash.sort((a, b) => (a.h < b.h ? -1 : 1));

  const baldes = new Map<string, Casado[]>();
  for (const { c } of comHash) {
    const p = principal(c.padroes);
    const balde = baldes.get(p);
    if (balde === undefined) baldes.set(p, [c]);
    else balde.push(c);
  }
  const filas = PRIORIDADE.map((p) => baldes.get(p) ?? []).filter((f) => f.length > 0);
  const amostra: Casado[] = [];
  for (let i = 0; amostra.length < args.amostra && filas.some((f) => i < f.length); i++) {
    for (const f of filas) {
      const c = f[i];
      if (c !== undefined && amostra.length < args.amostra) amostra.push(c);
    }
  }

  if (args.write) {
    const { writeFile } = await import('node:fs/promises');
    await writeFile(
      `${DIR}/amostra-50.json`,
      `${JSON.stringify(amostra.map((c) => ({ id: c.id, question: c.question, padroes: c.padroes })), null, 2)}\n`,
      'utf8',
    );
  }

  const out = [
    ...cabecalho,
    section('1. A VARREDURA'),
    `  mercados abertos varridos:     ${vistos.toLocaleString('pt-BR')}`,
    `  páginas baixadas:              ${pagina.toLocaleString('pt-BR')}`,
    `  estratos truncados no teto de offset: ${truncados}  (${saturados.length} deles são os saturados, que truncam por definição)`,
    `  ... o que passou do teto nesses estratos NÃO foi varrido. Piso do que ficou de`,
    `      fora: ${pisoSaturados.toLocaleString('pt-BR')} mercados nas ${saturados.length} janelas saturadas — lotes de mesmo \`endDate\`,`,
    '      que a bisseção do calendário não consegue partir e o offset não alcança.',
    `  mercados sem \`description\`:    ${semDescricao.toLocaleString('pt-BR')}  (${pct(semDescricao, vistos)})`,
    '',
    section('2. QUANTOS BATERAM EM PADRÃO DE COMPOSTO'),
    `  bateram na PERGUNTA:                    ${naPergunta.length.toLocaleString('pt-BR')}  (${pct(naPergunta.length, vistos)} do universo)`,
    `  ... descontando \`between X and Y\`:      ${limpos.length.toLocaleString('pt-BR')}  (${pct(limpos.length, vistos)})  <- é este o conjunto auditado`,
    `  bateram SÓ na \`description\`:            ${soDescricao.length.toLocaleString('pt-BR')}  (${pct(soDescricao.length, vistos)})`,
    '',
    '  A `description` é o texto de resolução — prosa longa, com "and" de ligação em',
    '  quase toda linha ("...will resolve to Yes and the resolution source will be...").',
    '  Casar nela infla o número sem produzir composto nenhum, e o composto que ela',
    '  revelaria sem estar na pergunta não é classificável por quem lê a pergunta. Ela',
    '  entra CONTADA à parte e fora da conta principal — decisão da sonda, declarada.',
    '',
    '  padrões usados, e o que cada um trouxe (sobre o conjunto auditado):',
    table(['padrão', 'casam nele', 'é o principal', '% dos casados'], porPadrao, [0]),
    '  ("principal" resolve a sobreposição: quem casa `both` e `and` conta como `both`,',
    '   do mais específico para o mais genérico. É por esse balde que a amostra é',
    '   estratificada, e é o peso dele que repõe a precisão global na fase 2.)',
    '',
    `  Filtro sintático único aplicado: \`${FAIXA.source}\` — "between $90 and $100" é`,
    '  faixa de valor, nunca conjunção. As outras armadilhas (ator composto, evento',
    '  único) exigem leitura e ficam para a amostra abaixo: desarmá-las na regex seria',
    '  escolher a precisão antes de medi-la.',
    '',
    section(`3. A AMOSTRA DE ${amostra.length} — pergunta inteira, para classificar À MÃO`),
    '  Sorteio determinístico por sha256 do id: duas execuções sorteiam os mesmos.',
    '',
    '  Estratificada por padrão principal, em rodízio — não os N primeiros, e não um',
    '  sorteio simples, que gastaria 46 das 50 conferências em "FDV after launch".',
    '',
    ...amostra.map(
      (c, i) => `  ${String(i + 1).padStart(2)}. [${c.id}] (${principal(c.padroes)})  ${c.question}`,
    ),
    '',
    `  Escreva o veredito em ${ARQ_ROTULOS}:`,
    '    { "verdadeiros": ["id", ...], "falsos": ["id", ...] }',
    `  e rode: npm run compostos -- --fase=pernas`,
    '',
    section('CUSTO DA PASSADA'),
    ...callCounts().map(([host, n]) => `  ${host.padEnd(10)} ${n} requisição(ões)`),
    `  ${'TOTAL'.padEnd(10)} ${totalCalls()}   (espaçadas em ${SPACING_MS} ms, ${mb()})`,
    '',
    '  Nenhuma chamada a modelo. Nenhuma escrita no banco.',
  ];

  console.log(out.join('\n'));
}

// ---------------------------------------------------------------------------
// FASE 2 — as pernas
// ---------------------------------------------------------------------------

/**
 * Parte a pergunta na conjunção e devolve os dois lados.
 *
 * Grosseiro de propósito: o objetivo não é entender a pergunta, é produzir dois
 * textos de busca bons o bastante para o índice invertido achar o mercado da
 * perna, se ele existir. Quem confere é o humano, olhando o candidato impresso.
 */
const CONECTIVOS = [' and ', ' before ', ' after ', ' without ', ' while '];

function partir(pergunta: string): [string, string] | null {
  const t = pergunta.toLowerCase();
  let corte = -1;
  let tamanho = 0;
  for (const c of CONECTIVOS) {
    const i = t.indexOf(c);
    if (i > 0 && (corte === -1 || i < corte)) {
      corte = i;
      tamanho = c.length;
    }
  }
  if (corte === -1) return null;

  const a = pergunta.slice(0, corte).replace(/^\s*will\s+/i, '').trim();
  const b = pergunta.slice(corte + tamanho).replace(/\?+$/, '').trim();
  if (a.length < 3 || b.length < 3) return null;
  return [a, b];
}

/**
 * Procura a perna no universo aberto por sobreposição de tokens ponderada por
 * IDF — token raro vale, token que aparece em 40.000 perguntas não.
 *
 * A pontuação é a fração do PESO da perna que a pergunta candidata cobre. Uma
 * perna curta ("Bitcoin above $200k") casa forte com o mercado que a nomeia
 * inteira; uma perna que só compartilha "2026" não passa de 0,2.
 */
interface Candidato {
  id: string;
  q: string;
  score: number;
  v: number;
  tk: string | null;
}

function procurar(
  perna: string,
  universo: readonly Compacto[],
  invertido: Map<string, number[]>,
  idf: Map<string, number>,
  excluirId: string,
  quantos: number,
): Candidato[] {
  const toks = [...new Set(tokens(perna))];
  const pesoTotal = toks.reduce((s, t) => s + (idf.get(t) ?? 0), 0);
  if (pesoTotal <= 0) return [];

  const pontos = new Map<number, number>();
  for (const t of toks) {
    const peso = idf.get(t) ?? 0;
    // Token que aparece em metade do universo não localiza nada e custa uma
    // varredura da lista inteira. Fora.
    const lista = invertido.get(t);
    if (lista === undefined || lista.length > universo.length / 20) continue;
    for (const i of lista) pontos.set(i, (pontos.get(i) ?? 0) + peso);
  }

  const ordenado = [...pontos.entries()]
    .map(([i, p]) => ({ i, score: p / pesoTotal }))
    .filter((x) => (universo[x.i] as Compacto).id !== excluirId)
    .sort((a, b) => b.score - a.score)
    .slice(0, quantos);

  return ordenado.map((x) => {
    const u = universo[x.i] as Compacto;
    return { id: u.id, q: u.q, score: x.score, v: u.v, tk: u.tk };
  });
}

interface Nivel {
  price: string;
  size: string;
}

interface Livro {
  vazio: boolean;
  spread: number | null;
  /** O menor entre os dólares no melhor bid e no melhor ask: limita ida E volta. */
  profundidade: number;
}

const LIVRO_VAZIO: Livro = { vazio: true, spread: null, profundidade: 0 };

/**
 * `bids` vem CRESCENTE e `asks` DECRESCENTE — o melhor de cada lado é o ÚLTIMO
 * elemento. Medido na sondagem de lead-lag, e é detalhe que inverte um spread
 * inteiro sem dar erro.
 *
 * Livro vazio devolve `vazio: true` e NUNCA um mid de 0,50: mid por aritmética
 * de livro vazio já fabricou edge falso na frente do XTracker.
 */
function livroDe(corpo: unknown): Livro {
  if (!isRecord(corpo)) return LIVRO_VAZIO;
  const bids = (Array.isArray(corpo['bids']) ? corpo['bids'] : []) as Nivel[];
  const asks = (Array.isArray(corpo['asks']) ? corpo['asks'] : []) as Nivel[];
  const topoBid = bids[bids.length - 1];
  const topoAsk = asks[asks.length - 1];
  if (topoBid === undefined || topoAsk === undefined) return LIVRO_VAZIO;

  const bid = Number(topoBid.price);
  const ask = Number(topoAsk.price);
  if (!Number.isFinite(bid) || !Number.isFinite(ask)) return LIVRO_VAZIO;

  return {
    vazio: false,
    spread: (ask - bid) * 100,
    profundidade: Math.min(bid * Number(topoBid.size), ask * Number(topoAsk.size)),
  };
}

async function pernas(_args: Args): Promise<void> {
  const { readFile } = await import('node:fs/promises');

  const universo: Compacto[] = (await readFile(ARQ_UNIVERSO, 'utf8'))
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as Compacto);
  const casados: Casado[] = JSON.parse(await readFile(ARQ_CASADOS, 'utf8')) as Casado[];

  let rotulos: { verdadeiros: string[]; falsos: string[] };
  try {
    rotulos = JSON.parse(await readFile(ARQ_ROTULOS, 'utf8')) as typeof rotulos;
  } catch {
    console.error(`[${LABEL}] ${ARQ_ROTULOS} não existe. Rode a fase 1 e classifique os 50 primeiro.`);
    process.exit(2);
    return;
  }

  const conferidos = rotulos.verdadeiros.length + rotulos.falsos.length;
  const precisaoCrua = conferidos === 0 ? 0 : rotulos.verdadeiros.length / conferidos;

  // --- precisão PONDERADA ---------------------------------------------------
  //
  // A amostra é estratificada por padrão, então a fração crua de acertos NÃO é a
  // precisão do casador: ela dá a `both` (raro) o mesmo peso que a ` after `
  // (92% dos casados). A precisão que vale é a média das precisões por padrão,
  // pesada pelo tamanho de cada padrão na POPULAÇÃO.
  const casadosLimpos = casados.filter(
    (c) => c.padroes.length > 0 && !c.faixa,
  );
  const rotuloDe = new Map<string, boolean>([
    ...rotulos.verdadeiros.map((id) => [id, true] as [string, boolean]),
    ...rotulos.falsos.map((id) => [id, false] as [string, boolean]),
  ]);
  const porIdCasado = new Map(casadosLimpos.map((c) => [c.id, c]));

  interface Estrato {
    padrao: string;
    populacao: number;
    conferidos: number;
    verdadeiros: number;
  }
  const estratos: Estrato[] = PRIORIDADE.map((p) => {
    const pop = casadosLimpos.filter((c) => principal(c.padroes) === p).length;
    const conf = [...rotuloDe.entries()].filter(([id]) => {
      const c = porIdCasado.get(id);
      return c !== undefined && principal(c.padroes) === p;
    });
    return {
      padrao: p,
      populacao: pop,
      conferidos: conf.length,
      verdadeiros: conf.filter(([, v]) => v).length,
    };
  }).filter((e) => e.populacao > 0);

  const popCoberta = estratos.filter((e) => e.conferidos > 0).reduce((s, e) => s + e.populacao, 0);
  const popTotal = estratos.reduce((s, e) => s + e.populacao, 0);
  const precisao =
    popCoberta === 0
      ? 0
      : estratos
          .filter((e) => e.conferidos > 0)
          .reduce((s, e) => s + (e.populacao * e.verdadeiros) / e.conferidos, 0) / popCoberta;
  const compostosEstimados = Math.round(precisao * popCoberta);

  // --- índice invertido -----------------------------------------------------

  console.error(`[${LABEL}] indexando ${universo.length.toLocaleString('pt-BR')} perguntas…`);
  const invertido = new Map<string, number[]>();
  for (const [i, u] of universo.entries()) {
    for (const t of new Set(tokens(u.q))) {
      const lista = invertido.get(t);
      if (lista === undefined) invertido.set(t, [i]);
      else lista.push(i);
    }
  }
  const idf = new Map<string, number>();
  for (const [t, lista] of invertido) idf.set(t, Math.log(universo.length / lista.length));

  // --- as pernas dos verdadeiros --------------------------------------------

  const porId = new Map(casados.map((c) => [c.id, c]));
  const verdadeiros = rotulos.verdadeiros.map((id) => porId.get(id)).filter((c): c is Casado => c !== undefined);

  /** Abaixo disto o "candidato" é ruído: compartilha data e mais nada. */
  const LIMIAR = 0.5;

  interface Achado {
    c: Casado;
    a: string;
    b: string;
    candA: Candidato[];
    candB: Candidato[];
  }

  const achados: Achado[] = [];
  let semSplit = 0;

  for (const c of verdadeiros) {
    const partes = partir(c.question);
    if (partes === null) {
      semSplit++;
      continue;
    }
    const [a, b] = partes;
    achados.push({
      c,
      a,
      b,
      candA: procurar(a, universo, invertido, idf, c.id, 3),
      candB: procurar(b, universo, invertido, idf, c.id, 3),
    });
  }

  const comDuasPernas = achados.filter(
    (x) => (x.candA[0]?.score ?? 0) >= LIMIAR && (x.candB[0]?.score ?? 0) >= LIMIAR,
  );

  // --- o livro dos que têm as duas pernas -----------------------------------

  const tokensParaLer = new Set<string>();
  for (const x of comDuasPernas) {
    if (x.c.tokenId !== null) tokensParaLer.add(x.c.tokenId);
    const ta = x.candA[0]?.tk;
    const tb = x.candB[0]?.tk;
    if (typeof ta === 'string') tokensParaLer.add(ta);
    if (typeof tb === 'string') tokensParaLer.add(tb);
  }

  console.error(`[${LABEL}] lendo ${tokensParaLer.size} livros na CLOB…`);
  const livros = new Map<string, Livro>();
  for (const t of tokensParaLer) {
    const res = await call(`${CLOB}/book?token_id=${t}`, 'clob');
    bytes += res.bytes;
    livros.set(t, res.status === 200 ? livroDe(res.body) : LIVRO_VAZIO);
  }

  const livroDoComposto = comDuasPernas.map((x) => livros.get(x.c.tokenId ?? '') ?? LIVRO_VAZIO);
  const comLivro = livroDoComposto.filter((l) => !l.vazio);
  const volumes = comDuasPernas.map((x) => x.c.volume24h);

  // Trio inteiro operável: composto + as duas pernas, todos com livro. É o que a
  // conta de Fréchet exige — sem as três pontas negociáveis não há arbitragem,
  // só uma observação.
  const trios = comDuasPernas.filter((x) => {
    const ta = x.candA[0]?.tk;
    const tb = x.candB[0]?.tk;
    return (
      !(livros.get(x.c.tokenId ?? '') ?? LIVRO_VAZIO).vazio &&
      typeof ta === 'string' &&
      typeof tb === 'string' &&
      !(livros.get(ta) ?? LIVRO_VAZIO).vazio &&
      !(livros.get(tb) ?? LIVRO_VAZIO).vazio
    );
  });

  const out = [
    section('MERCADOS COMPOSTOS — FASE 2: as pernas'),
    `  Universo indexado: ${universo.length.toLocaleString('pt-BR')} perguntas abertas (de ${ARQ_UNIVERSO}).`,
    '  Zero chamadas a modelo. Zero escrita no banco.',
    '',
    section('1. A PRECISÃO DO CASADOR — conferida à mão'),
    `  conferidos:           ${conferidos}`,
    `  compostos DE VERDADE: ${rotulos.verdadeiros.length}`,
    `  falsos positivos:     ${rotulos.falsos.length}`,
    `  acerto cru na amostra: ${(100 * precisaoCrua).toFixed(0)}%  <- NÃO é a precisão; a amostra é estratificada`,
    '',
    table(
      ['padrão', 'população', 'conferidos', 'verdadeiros', 'precisão do padrão'],
      estratos.map((e) => [
        e.padrao,
        e.populacao.toLocaleString('pt-BR'),
        String(e.conferidos),
        String(e.verdadeiros),
        e.conferidos === 0 ? '—' : pct(e.verdadeiros, e.conferidos),
      ]),
      [0],
    ),
    '',
    `  PRECISÃO PONDERADA PELA POPULAÇÃO: ${(100 * precisao).toFixed(0)}%`,
    `  (cobre ${popCoberta.toLocaleString('pt-BR')} de ${popTotal.toLocaleString('pt-BR')} casados — ${pct(popCoberta, popTotal)} da população tem estrato conferido)`,
    '',
    `  compostos DE VERDADE estimados no universo aberto: ~${compostosEstimados.toLocaleString('pt-BR')}`,
    '',
    '  A média é pesada pelo tamanho de cada padrão na população, e não pela amostra:',
    '  a amostra dá a `both` o mesmo espaço que a ` after `, que sozinha é a maioria',
    '  dos casados. Ler a fração crua como precisão inverteria o número.',
    '',
    section('2. AS PERNAS — elas existem como mercado aberto separado?'),
    `  compostos verdadeiros na amostra:     ${verdadeiros.length}`,
    `  ... que a partição automática partiu: ${verdadeiros.length - semSplit}  (${semSplit} sem conectivo partível)`,
    `  ... com AS DUAS pernas achadas (score >= ${LIMIAR}): ${comDuasPernas.length}`,
    '',
    `  TAXA: ${pct(comDuasPernas.length, Math.max(1, verdadeiros.length))} dos compostos verdadeiros têm as duas pernas abertas.`,
    `  Projetada sobre os ~${compostosEstimados.toLocaleString('pt-BR')} compostos estimados: ~${Math.round(
      (compostosEstimados * comDuasPernas.length) / Math.max(1, verdadeiros.length),
    ).toLocaleString('pt-BR')} mercados com as duas pernas.`,
    '',
    `  A projeção é frágil por construção — ela vem de ${verdadeiros.length} casos rotulados, e cada um`,
    '  vale muito. É ordem de grandeza, não contagem, e está aqui porque a pergunta da',
    '  sondagem é justamente de ordem de grandeza: "existe população suficiente?".',
    '',
    '  Busca por sobreposição de tokens ponderada por IDF sobre as perguntas abertas.',
    '  O score é a fração do PESO da perna coberta pela pergunta candidata — token',
    '  raro vale, "2026" quase não vale. Candidato impresso abaixo para conferência:',
    '  este número é o que decide a frente, e não pode sair de um limiar não olhado.',
    '',
    ...achados.flatMap((x) => [
      `  [${x.c.id}] ${x.c.question}`,
      `      perna A: "${x.a}"`,
      ...(x.candA.length === 0
        ? ['        (nenhum candidato)']
        : x.candA.map((k) => `        ${num(k.score, 2)}  ${k.q.slice(0, 88)}`)),
      `      perna B: "${x.b}"`,
      ...(x.candB.length === 0
        ? ['        (nenhum candidato)']
        : x.candB.map((k) => `        ${num(k.score, 2)}  ${k.q.slice(0, 88)}`)),
      '',
    ]),
    section('3. A LIQUIDEZ DOS QUE TÊM AS DUAS PERNAS'),
    `  compostos com as duas pernas:      ${comDuasPernas.length}`,
    `  ... com livro no próprio composto: ${comLivro.length}  (${comDuasPernas.length - comLivro.length} SEM livro — descartados, nunca mid 0,50)`,
    `  ... trio inteiro com livro:        ${trios.length}  (composto E as duas pernas)`,
    '',
    `  volume 24h do composto, US$:  ${volumes.length === 0 ? '—' : distribuicao(volumes, 0)}`,
    `  profundidade no topo, US$:    ${comLivro.length === 0 ? '—' : distribuicao(comLivro.map((l) => l.profundidade), 0)}`,
    `  spread do composto, ¢:        ${comLivro.length === 0 ? '—' : distribuicao(comLivro.map((l) => l.spread as number), 2)}`,
    '',
    '  (profundidade = o menor entre os dólares no melhor bid e no melhor ask; é ele',
    '   que limita a ida E a volta, e a volta é metade da operação)',
    '',
    section('CUSTO DA PASSADA'),
    ...callCounts().map(([host, n]) => `  ${host.padEnd(10)} ${n} requisição(ões)`),
    `  ${'TOTAL'.padEnd(10)} ${totalCalls()}   (espaçadas em ${SPACING_MS} ms, ${mb()})`,
  ];

  console.log(out.join('\n'));
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  if ('error' in parsed) {
    console.error(`[${LABEL}] ${parsed.error}`);
    process.exit(2);
  }
  if (parsed.fase === 'pernas') await pernas(parsed);
  else await varredura(parsed);
}

main().catch((err: unknown) => {
  console.error(`[${LABEL}] falhou:`, err instanceof Error ? err.message : String(err));
  process.exit(1);
});
