import 'dotenv/config';

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

/**
 * Sondagem de atraso: o spread do lado lento.
 *
 * A ideia sob teste: mercados ligados por lógica não compartilham livro. Sai uma
 * notícia, o mercado óbvio reage em segundos e o ligado por raciocínio de
 * segundo grau demora, porque ninguém olha para ele. A operação seria comprar no
 * lento antes de ele acordar.
 *
 * A objeção que mata: o atraso existe porque ninguém olha; ninguém olha porque é
 * ilíquido; ilíquido tem spread largo; spread largo come a vantagem. São o mesmo
 * problema por três ângulos, e **este script mede o terceiro, que é o mais
 * barato de medir**.
 *
 * Ela NÃO mede atraso. Mede se valeria a pena medir atraso.
 *
 * ## Critério de morte, declarado antes do resultado
 *
 * O ganho plausível de uma notícia é de 2 a 4 centavos, e captura-se parte dele.
 * O custo de ida e volta é um spread INTEIRO, não meio. Se menos de 20% dos
 * mercados do lado lento tiverem spread <= 2¢, a ideia não paga como operação
 * manual e a frente morre aqui.
 *
 * Spread bom com profundidade minúscula também é não: vantagem × tamanho
 * minúsculo = nada. Por isso a profundidade em dólares sai junto, não depois.
 *
 * ## Zero LLM
 *
 * Os pares saem de ESTRUTURA, não de leitura: escada de data, escada de valor e
 * partição declarada por `negRisk`. Nenhuma chamada a modelo, nenhum custo de
 * API paga.
 *
 * ## Uso
 *
 *   npm run leadlag:spread -- --dry-run
 *   npm run leadlag:spread
 *   npm run leadlag:spread -- --pares=40
 */

const LABEL = 'probe-lead-lag';

const GAMMA = process.env['POLYMARKET_GAMMA_URL'] ?? 'https://gamma-api.polymarket.com';
const CLOB = 'https://clob.polymarket.com';
const SNAPSHOT_DIR = 'probes/lead-lag';

/** Teto de pares. Sessenta bastam; paginar o universo já custou 1h36 uma vez. */
const PARES_PADRAO = 60;

/**
 * De onde os candidatos saem. Esporte está fora por decisão: a frente anterior
 * se afogou em tênis de mesa e handicap, e não é o alvo.
 */
const TAGS = ['politics', 'geopolitics', 'world', 'elections', 'economy', 'tech', 'crypto'];

/** Tag que reprova o evento inteiro, mesmo que ele apareça numa busca acima. */
const TAGS_PROIBIDAS = new Set([
  'sports', 'soccer', 'games', 'nba', 'nfl', 'mlb', 'nhl', 'tennis', 'table-tennis',
  'baseball', 'basketball', 'football', 'hockey', 'ufc', 'mma', 'boxing', 'esports',
  'cs2', 'lol', 'dota', 'valorant', 'setka', 'epl', 'golf', 'cricket', 'f1', 'olympics',
  // Vela de minutos: é cripto, mas de prazo curto, e o alvo é prazo longo.
  'up-or-down', 'crypto-prices', 'hourly', '5m', '15m',
]);

/**
 * Prazo mínimo até o fechamento.
 *
 * Três dias mata a vela de 15 minutos sem precisar acertar o nome da tag dela —
 * e é o filtro que sobrevive à Polymarket inventando uma categoria nova de
 * mercado curto na semana que vem.
 */
const PRAZO_MINIMO_DIAS = 3;

// ---------------------------------------------------------------------------
// Flags
// ---------------------------------------------------------------------------

interface Args {
  pares: number;
  dryRun: boolean;
  write: boolean;
}

function parseArgs(argv: readonly string[]): Args | { error: string } {
  const args: Args = { pares: PARES_PADRAO, dryRun: false, write: true };
  for (const arg of argv) {
    if (arg === '--dry-run') {
      args.dryRun = true;
      continue;
    }
    if (arg === '--no-write') {
      args.write = false;
      continue;
    }
    const m = /^--pares=(\d+)$/.exec(arg);
    if (m === null) return { error: `argumento desconhecido: ${arg}` };
    args.pares = Number(m[1]);
  }
  return args;
}

// ---------------------------------------------------------------------------
// Gamma
// ---------------------------------------------------------------------------

interface GammaMarket {
  id: string;
  question: string;
  clobTokenIds: string;
  volume24hr?: number;
  volumeNum?: number;
  liquidityNum?: number;
  endDate: string | null;
  closed: boolean;
  acceptingOrders?: boolean;
}

interface GammaEvent {
  id: string;
  title: string;
  negRisk?: boolean;
  enableNegRisk?: boolean;
  tags?: Array<{ slug: string }>;
  markets?: GammaMarket[];
}

let bytes = 0;

async function pegar(url: string, host: string): Promise<unknown> {
  const res = await call(url, host);
  bytes += res.bytes;
  if (res.status !== 200) throw new Error(`${host} HTTP ${res.status}`);
  return res.body;
}

async function eventosDaTag(slug: string): Promise<GammaEvent[]> {
  const params = new URLSearchParams({
    limit: '100',
    closed: 'false',
    active: 'true',
    archived: 'false',
    tag_slug: slug,
  });
  const corpo = await pegar(`${GAMMA}/events?${params.toString()}`, 'gamma');
  if (Array.isArray(corpo)) return corpo as GammaEvent[];
  if (isRecord(corpo) && Array.isArray(corpo['events'])) return corpo['events'] as GammaEvent[];
  return [];
}

// ---------------------------------------------------------------------------
// Escadas — estrutura, não leitura
// ---------------------------------------------------------------------------

const MESES: Record<string, number> = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
};

/**
 * Um degrau de data na pergunta: "by September 30", "in 2027", "before Dec 31".
 * Devolve um número ordenável, não uma data — a escada só precisa de ordem.
 */
function degrauDeData(pergunta: string): number | null {
  const t = pergunta.toLowerCase();
  const mes = Object.keys(MESES).find((m) => t.includes(m));
  const ano = /\b(20\d{2})\b/.exec(t)?.[1];
  if (mes === undefined && ano === undefined) return null;
  return Number(ano ?? '2026') * 100 + (mes === undefined ? 0 : (MESES[mes] as number));
}

/** Um degrau de valor: "above 100,000", "Over 4.5", "$120k", "at least 55%". */
function degrauDeValor(pergunta: string): number | null {
  const m = /\b(?:above|over|under|below|least|more than|less than|reach|hit|\$)\s*\$?([\d][\d,.]*)\s*([kmb])?/i.exec(
    pergunta,
  );
  if (m === null) return null;
  const base = Number((m[1] ?? '').replace(/,/g, ''));
  if (!Number.isFinite(base)) return null;
  const escala = { k: 1e3, m: 1e6, b: 1e9 }[(m[2] ?? '').toLowerCase()] ?? 1;
  return base * escala;
}

type TipoDePar = 'escada-data' | 'escada-valor' | 'particao';

interface Lado {
  id: string;
  pergunta: string;
  tokenId: string;
  volume24h: number;
  eventoId: string;
}

interface Par {
  tipo: TipoDePar;
  eventoTitulo: string;
  tags: string[];
  /** Maior volume 24h — o lado que o mercado observa. */
  rapido: Lado;
  /** O outro. É o spread DELE que decide a frente. */
  lento: Lado;
  razaoDeVolume: number;
}

function primeiroToken(m: GammaMarket): string | null {
  try {
    const lista: unknown = JSON.parse(m.clobTokenIds);
    return Array.isArray(lista) && typeof lista[0] === 'string' ? lista[0] : null;
  } catch {
    return null;
  }
}

function vivo(m: GammaMarket, agora: number): boolean {
  if (m.closed === true || m.acceptingOrders !== true) return false;
  if (m.endDate === null) return false;
  const dias = (new Date(m.endDate).getTime() - agora) / 86400000;
  return dias >= PRAZO_MINIMO_DIAS;
}

/**
 * Monta os pares de um evento.
 *
 * Quem é rápido e quem é lento é MECÂNICO, sem julgamento: dentro do grupo, o
 * lado observado é o de maior volume 24h e o lento é o outro. Pareia-se o mais
 * negociado com cada um dos demais — é a forma que instancia a hipótese
 * diretamente, e evita gastar chamada em par lento-contra-lento, que não diz
 * nada sobre "o rápido reage e o lento demora".
 */
function paresDoEvento(evento: GammaEvent, agora: number): Par[] {
  const tags = (evento.tags ?? []).map((t) => t.slug);
  if (tags.some((t) => TAGS_PROIBIDAS.has(t))) return [];

  const vivos = (evento.markets ?? []).filter((m) => vivo(m, agora));
  if (vivos.length < 2) return [];

  const lados: Lado[] = [];
  for (const m of vivos) {
    const token = primeiroToken(m);
    if (token === null) continue;
    lados.push({
      id: m.id,
      pergunta: m.question,
      tokenId: token,
      volume24h: m.volume24hr ?? 0,
      eventoId: evento.id,
    });
  }
  if (lados.length < 2) return [];

  // A classificação é do EVENTO, não do par: os mercados de um evento
  // compartilham o enunciado por construção, e é isso que torna a escada
  // detectável sem ler nada.
  let tipo: TipoDePar | null = null;
  if (evento.negRisk === true || evento.enableNegRisk === true) {
    tipo = 'particao';
  } else {
    const datas = lados.map((l) => degrauDeData(l.pergunta));
    const valores = lados.map((l) => degrauDeValor(l.pergunta));
    if (datas.every((d) => d !== null) && new Set(datas).size > 1) tipo = 'escada-data';
    else if (valores.every((v) => v !== null) && new Set(valores).size > 1) tipo = 'escada-valor';
  }
  if (tipo === null) return [];

  const ordenados = [...lados].sort((a, b) => b.volume24h - a.volume24h);
  const rapido = ordenados[0] as Lado;

  return ordenados.slice(1).map((lento) => ({
    tipo: tipo as TipoDePar,
    eventoTitulo: evento.title,
    tags,
    rapido,
    lento,
    // Razão perto de 1 significa que os dois lados são igualmente observados, e
    // aí o par não serve para a hipótese. Sai da conta, contado.
    razaoDeVolume: lento.volume24h <= 0 ? Infinity : rapido.volume24h / lento.volume24h,
  }));
}

// ---------------------------------------------------------------------------
// CLOB
// ---------------------------------------------------------------------------

interface Nivel {
  price: string;
  size: string;
}

interface Livro {
  vazio: boolean;
  melhorBid: number | null;
  melhorAsk: number | null;
  /** Em centavos. */
  spread: number | null;
  /** Dólares no melhor bid e no melhor ask. */
  dolaresBid: number;
  dolaresAsk: number;
  /** O menor dos dois: é ele que limita a ida E a volta. */
  profundidade: number;
}

const LIVRO_VAZIO: Livro = {
  vazio: true,
  melhorBid: null,
  melhorAsk: null,
  spread: null,
  dolaresBid: 0,
  dolaresAsk: 0,
  profundidade: 0,
};

/**
 * Lê o livro de um token.
 *
 * `bids` vem em ordem CRESCENTE e `asks` em ordem DECRESCENTE — o melhor de cada
 * lado é o ÚLTIMO elemento, não o primeiro. Medido, e é o tipo de detalhe que
 * inverte um spread inteiro sem dar erro.
 *
 * Livro vazio devolve `vazio: true` e NÃO um mid de 0,50. Mid de meio dólar por
 * aritmética de livro vazio já fabricou edge falso na frente do XTracker; aqui
 * ele é descarte contado, não dado.
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

  const dolaresBid = bid * Number(topoBid.size);
  const dolaresAsk = ask * Number(topoAsk.size);

  return {
    vazio: false,
    melhorBid: bid,
    melhorAsk: ask,
    spread: (ask - bid) * 100,
    dolaresBid,
    dolaresAsk,
    profundidade: Math.min(dolaresBid, dolaresAsk),
  };
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
  const agora = Date.now();

  console.error(`[${LABEL}] buscando eventos em ${TAGS.length} tags fora de esporte…`);
  const vistos = new Set<string>();
  const eventos: GammaEvent[] = [];
  const porTag = new Map<string, number>();

  for (const tag of TAGS) {
    const lista = await eventosDaTag(tag);
    let novos = 0;
    for (const e of lista) {
      if (vistos.has(e.id)) continue;
      vistos.add(e.id);
      eventos.push(e);
      novos++;
    }
    porTag.set(tag, novos);
  }

  const todosOsPares = eventos.flatMap((e) => paresDoEvento(e, agora));

  // Razão de volume perto de 1 = os dois lados são igualmente observados, e o
  // par não instancia "um rápido, um lento".
  const RAZAO_MINIMA = 2;
  const fracos = todosOsPares.filter((p) => p.razaoDeVolume < RAZAO_MINIMA);
  const uteis = todosOsPares.filter((p) => p.razaoDeVolume >= RAZAO_MINIMA);

  // Amostra ESTRATIFICADA por tipo, em rodízio, e não os 60 primeiros.
  //
  // Os primeiros da lista vêm na ordem em que a Gamma devolveu os eventos, e ali
  // a partição domina — 56 de 60 na primeira tentativa. Medir isso responderia
  // "qual o spread de uma partição", não "qual o spread do lado lento", e as
  // escadas de data e de valor são justamente as que a hipótese descreve:
  // relação de segundo grau que ninguém está olhando.
  const porTipoTodos = new Map<TipoDePar, Par[]>();
  for (const p of uteis) {
    const lista = porTipoTodos.get(p.tipo);
    if (lista === undefined) porTipoTodos.set(p.tipo, [p]);
    else lista.push(p);
  }
  const filas = [...porTipoTodos.values()];
  const pares: Par[] = [];
  for (let i = 0; pares.length < args.pares && filas.some((f) => i < f.length); i++) {
    for (const f of filas) {
      const p = f[i];
      if (p !== undefined && pares.length < args.pares) pares.push(p);
    }
  }

  const tokens = new Set<string>();
  for (const p of pares) {
    tokens.add(p.rapido.tokenId);
    tokens.add(p.lento.tokenId);
  }

  const porTipo = new Map<TipoDePar, number>();
  for (const p of pares) porTipo.set(p.tipo, (porTipo.get(p.tipo) ?? 0) + 1);

  const cabecalho = [
    section('SONDAGEM DE ATRASO — o spread do lado lento'),
    '  Zero chamadas a modelo. Só leitura. Não mede atraso: mede se valeria medir.',
    '',
    `  eventos abertos lidos:     ${eventos.length}  (${TAGS.length} tags, esporte excluído)`,
    ...[...porTag.entries()].map(([t, n]) => `      ${t.padEnd(12)} ${n} eventos novos`),
    '',
    `  pares estruturais achados: ${todosOsPares.length}`,
    `  descartados por volume 24h parecido (razão < ${RAZAO_MINIMA}x): ${fracos.length}`,
    `  pares úteis:               ${uteis.length}`,
    `  alvo desta passada:        ${pares.length}${uteis.length > args.pares ? `  (teto --pares=${args.pares})` : ''}`,
    '',
    '  por tipo — e a amostra é ESTRATIFICADA, em rodízio, não os N primeiros:',
    table(
      ['tipo', 'úteis no total', 'na amostra'],
      (['escada-data', 'escada-valor', 'particao'] as TipoDePar[]).map((t) => [
        t,
        String((porTipoTodos.get(t) ?? []).length),
        String(porTipo.get(t) ?? 0),
      ]),
      [0],
    ),
    '',
    `  mercados distintos a consultar no livro: ${tokens.size}`,
    `  chamadas à CLOB previstas: ${tokens.size}   (espaçadas em ${SPACING_MS} ms, ~${Math.ceil((tokens.size * SPACING_MS) / 1000)} s)`,
  ];

  if (args.dryRun) {
    console.log([...cabecalho, '', '  --dry-run: nenhuma chamada à CLOB feita.'].join('\n'));
    return;
  }

  console.error(`[${LABEL}] lendo ${tokens.size} livros na CLOB…`);
  const livros = new Map<string, Livro>();
  let primeiroCru: Awaited<ReturnType<typeof call>> | null = null;

  for (const token of tokens) {
    const res = await call(`${CLOB}/book?token_id=${token}`, 'clob');
    bytes += res.bytes;
    // Guarda a primeira resposta CRUA para o snapshot — snapshot não é motivo
    // para requisição nova.
    primeiroCru ??= res;
    livros.set(token, res.status === 200 ? livroDe(res.body) : LIVRO_VAZIO);
  }

  if (args.write && primeiroCru !== null) {
    await writeSnapshot(
      LABEL,
      `${SNAPSHOT_DIR}/clob-book.json`,
      'clob-book-snapshot',
      '/book',
      { token_id: [...tokens][0] ?? '' },
      primeiroCru,
    );
  }

  // --- resultado ------------------------------------------------------------

  const lentos = pares.map((p) => ({ par: p, livro: livros.get(p.lento.tokenId) as Livro }));
  const rapidos = pares.map((p) => ({ par: p, livro: livros.get(p.rapido.tokenId) as Livro }));

  const lentosVazios = lentos.filter((x) => x.livro.vazio);
  const lentosComLivro = lentos.filter((x) => !x.livro.vazio);
  const rapidosComLivro = rapidos.filter((x) => !x.livro.vazio);

  const spreadsLento = lentosComLivro.map((x) => x.livro.spread as number);
  const spreadsRapido = rapidosComLivro.map((x) => x.livro.spread as number);
  const profLento = lentosComLivro.map((x) => x.livro.profundidade);
  const profRapido = rapidosComLivro.map((x) => x.livro.profundidade);

  const ate2c = spreadsLento.filter((s) => s <= 2).length;
  const passa = lentosComLivro.length > 0 && ate2c / lentosComLivro.length >= 0.2;

  const mid = (l: Livro): number => (((l.melhorBid as number) + (l.melhorAsk as number)) / 2);
  const midsLento = lentosComLivro.map((x) => mid(x.livro));
  const relativosLento = lentosComLivro.map((x) => (x.livro.spread as number) / 100 / Math.max(1e-6, mid(x.livro)));
  // A faixa em que um ganho de 2 a 4 centavos é sequer aritmeticamente possível
  // nas duas direções. Fora dela o critério em centavos absolutos compara duas
  // grandezas que não vivem na mesma escala.
  const operaveis = lentosComLivro.filter((x) => mid(x.livro) >= 0.1 && mid(x.livro) <= 0.9);
  const operaveisEstreitos = operaveis.filter((x) => (x.livro.spread as number) <= 2);

  const out = [
    ...cabecalho,
    section('1. O LIVRO DO LADO LENTO'),
    `  pares medidos:             ${pares.length}`,
    `  lados lentos com livro:    ${lentosComLivro.length}`,
    `  lados lentos SEM livro:    ${lentosVazios.length}  (${pct(lentosVazios.length, lentos.length)})  <- DESCARTADOS, não contados como 50%`,
    '',
    '  Livro vazio dá mid de 0,50 por aritmética, e isso já fabricou edge falso na',
    '  frente do XTracker. Aqui ele sai da conta e aparece com sinal — um lado lento',
    '  sem livro nenhum é a forma mais extrema de "ilíquido", não um dado neutro.',
    '',
    `  spread do LENTO, em centavos:  ${distribuicao(spreadsLento)}`,
    `  spread do RÁPIDO, em centavos: ${distribuicao(spreadsRapido)}`,
    '',
    `  profundidade do LENTO, US$ no topo:  ${distribuicao(profLento, 0)}`,
    `  profundidade do RÁPIDO, US$ no topo: ${distribuicao(profRapido, 0)}`,
    '',
    '  (profundidade = o menor entre os dólares no melhor bid e no melhor ask; é o',
    '   que limita a ida E a volta, e a volta é metade da operação)',
    '',
    table(
      ['faixa de spread', 'lentos', '% dos lentos', 'profundidade mediana US$'],
      [
        ['<= 1¢', 1],
        ['<= 2¢', 2],
        ['<= 3¢', 3],
        ['<= 5¢', 5],
        ['> 5¢', Infinity],
      ].map(([rotulo, teto]) => {
        const sel = lentosComLivro.filter((x) =>
          teto === Infinity ? (x.livro.spread as number) > 5 : (x.livro.spread as number) <= (teto as number),
        );
        const profs = sel.map((x) => x.livro.profundidade).sort((a, b) => a - b);
        return [
          String(rotulo),
          String(sel.length),
          pct(sel.length, lentosComLivro.length),
          sel.length === 0 ? '—' : num(quantil(profs, 0.5), 0),
        ];
      }),
      [0],
    ),
    '',
    section('2. O CRITÉRIO DE MORTE'),
    `  lados lentos com spread <= 2¢: ${ate2c}/${lentosComLivro.length}  (${pct(ate2c, lentosComLivro.length)})`,
    '  limiar declarado antes de medir: 20%',
    '',
    passa
      ? '  PASSA no spread. A ideia não morre aqui — mas olhe a profundidade antes de\n' +
        '  comemorar: spread bom com US$ 40 de topo de livro também é não.'
      : '  NÃO PASSA. Menos de 20% dos lados lentos têm spread <= 2¢, e o custo de ida e\n' +
        '  volta é um spread INTEIRO contra um ganho plausível de 2 a 4 centavos. Como\n' +
        '  operação manual, a frente morre aqui.',
    '',
    `  Contando os ${lentosVazios.length} sem livro no denominador — que é a leitura honesta, porque um`,
    `  mercado sem livro também não é operável —: ${pct(ate2c, lentos.length)}.`,
    '',
    section('2b. O QUE O CRITÉRIO EM CENTAVOS ABSOLUTOS NÃO VÊ'),
    '  O limiar de 2¢ pressupõe, sem dizer, um mercado precificado no meio. Num',
    '  mercado a 0,005 um spread de 0,1¢ é 20% do preço — e uma notícia não move um',
    '  azarão de 0,005 em 2 centavos, porque isso seria 400%. O ganho de 2 a 4',
    '  centavos e o spread em centavos só são comparáveis onde o preço admite os dois.',
    '',
    `  preço médio (mid) do lado lento: ${distribuicao(midsLento, 3)}`,
    `  spread RELATIVO (spread ÷ mid): ${distribuicao(relativosLento, 2)}`,
    '',
    table(
      ['recorte do lado lento', 'n', '% dos com livro', 'spread mediano ¢', 'prof. mediana US$'],
      [
        ['todos', lentosComLivro],
        ['mid entre 0,10 e 0,90', operaveis],
        ['mid entre 0,10 e 0,90 E spread <= 2¢', operaveisEstreitos],
      ].map(([rotulo, sel]) => {
        const lista = sel as typeof lentosComLivro;
        const sp = lista.map((x) => x.livro.spread as number).sort((a, b) => a - b);
        const pf = lista.map((x) => x.livro.profundidade).sort((a, b) => a - b);
        return [
          String(rotulo),
          String(lista.length),
          pct(lista.length, lentosComLivro.length),
          lista.length === 0 ? '—' : num(quantil(sp, 0.5), 2),
          lista.length === 0 ? '—' : num(quantil(pf, 0.5), 0),
        ];
      }),
      [0],
    ),
    '',
    '  É esta última linha que a operação enfrenta, não os 81% do critério original:',
    `  ${operaveisEstreitos.length} de ${lentosComLivro.length} lados lentos (${pct(operaveisEstreitos.length, lentosComLivro.length)}) têm ao mesmo tempo preço onde um`,
    '  ganho de 2 a 4 centavos é plausível E spread que não o come inteiro.',
    '',
    section('3. O CONJUNTO OPERÁVEL, UM A UM'),
    '  Os lados lentos com preço na faixa e spread <= 2¢ — a lista inteira, porque',
    '  ela é curta. Ordenada por profundidade: é ela que decide se cabe dinheiro.',
    table(
      ['mid', 'spread ¢', 'prof US$', 'vol24h lento', 'razão vol', 'tipo', 'pergunta (lado lento)'],
      [...operaveisEstreitos]
        .sort((a, b) => b.livro.profundidade - a.livro.profundidade)
        .map((x) => [
          num(mid(x.livro), 3),
          num(x.livro.spread as number, 2),
          num(x.livro.profundidade, 0),
          num(x.par.lento.volume24h, 0),
          x.par.razaoDeVolume === Infinity ? '∞' : num(x.par.razaoDeVolume, 1),
          x.par.tipo,
          x.par.lento.pergunta.slice(0, 44),
        ]),
      [5, 6],
    ),
    '',
    `  profundidade mediana deste conjunto: US$ ${operaveisEstreitos.length === 0 ? '—' : num(quantil(operaveisEstreitos.map((x) => x.livro.profundidade).sort((a, b) => a - b), 0.5), 0)}`,
    '  O próprio enunciado da sondagem já dizia que US$ 40 de profundidade é pouco.',
    '',
    ...(await historicoQueTemos()),
    section('CUSTO DA PASSADA'),
    ...callCounts().map(([host, n]) => `  ${host.padEnd(10)} ${n} requisição(ões)`),
    `  ${'TOTAL'.padEnd(10)} ${totalCalls()}   (espaçadas em ${SPACING_MS} ms, ${(bytes / 1048576).toFixed(1)} MB)`,
    '',
    '  Zero chamadas a modelo. Nenhuma escrita no banco. Nenhuma OddsPapi.',
  ];

  console.log(out.join('\n'));
}

// ---------------------------------------------------------------------------
// PARTE 2 — que histórico de preço nós temos
// ---------------------------------------------------------------------------

/**
 * Se a granularidade for grossa demais, o atraso é invisível no que já temos e a
 * etapa seguinte precisa de coletor novo — dias viram semanas. É a única pergunta
 * desta sondagem que se responde no banco.
 *
 * ## Só SELECT, e todo ele por índice
 *
 * `polymarket_snapshots` e `events` são as tabelas grandes do projeto, e o
 * timeout do PostgREST é de 8s. O `retention_job` já derrubou o banco com um
 * `LIKE ANY` que virou seq scan em 711 MB, então aqui não há consulta que possa
 * escorregar para varredura:
 *
 *   A. janela da série  — ORDER BY id nas duas pontas, 1 linha cada, pela PK.
 *   B. amostra          — `status='active' ORDER BY volume_24h DESC LIMIT 100`,
 *                         que é exatamente `idx_events_status_volume`.
 *   C. cadência         — um `event_id` por vez com LIMIT 300, que é exatamente
 *                         `idx_snapshots_event_time (event_id, captured_at desc)`.
 *
 * O que NÃO se faz aqui, e de propósito: `count(*)` ou `count(distinct event_id)`
 * sobre a tabela inteira. As duas são seq scan e nenhuma delas cabe em 8s. Por
 * isso os números abaixo são de AMOSTRA e estão rotulados como tal — não são
 * censo, e apresentá-los como censo seria inventar precisão.
 */
async function historicoQueTemos(): Promise<string[]> {
  const cabecalho = [section('4. QUE HISTÓRICO DE PREÇO NÓS TEMOS (só SELECT, tudo por índice)')];

  let supabase;
  try {
    ({ supabase } = await import('../src/lib/supabase.js'));
  } catch {
    return [...cabecalho, '  Sem credencial de banco nesta execução — parte 2 pulada.'];
  }

  // A. janela
  const [maisAntigo, maisNovo] = await Promise.all([
    supabase.from('polymarket_snapshots').select('captured_at').order('id', { ascending: true }).limit(1),
    supabase.from('polymarket_snapshots').select('captured_at').order('id', { ascending: false }).limit(1),
  ]);
  if (maisAntigo.error !== null || maisNovo.error !== null) {
    return [...cabecalho, `  Falhou: ${maisAntigo.error?.message ?? maisNovo.error?.message}`];
  }

  // B. quais mercados TÊM série — e a amostra sai da própria tabela de
  // snapshots, não de `events`.
  //
  // A primeira versão amostrou `events where status='active' order by volume_24h`
  // e achou ZERO mercados com série em 300. Não era bug: o conjunto capturado é o
  // dos mercados RASTREADOS, que não é o dos mais líquidos de hoje. Perguntar
  // "estes mercados têm série?" respondia sobre a amostra, não sobre o banco.
  // Perguntar "de quem é a série que existe?" responde sobre o banco.
  const { data: cauda, error: erroCauda } = await supabase
    .from('polymarket_snapshots')
    .select('event_id')
    .order('id', { ascending: false })
    .limit(2000);
  if (erroCauda !== null) return [...cabecalho, `  Falhou ao amostrar event_id: ${erroCauda.message}`];

  const ids = [...new Set((cauda ?? []).map((r) => r.event_id as string))].filter((x) => x !== null);

  const amostra: Array<{ id: string; titulo: string; categoria: string | null }> = [];
  // `events` por PK, em lotes: `in (...)` sobre a chave primária é index scan.
  for (let i = 0; i < ids.length; i += 50) {
    const lote = ids.slice(i, i + 50);
    const { data, error } = await supabase
      .from('events')
      .select('id, title, polymarket_category')
      .in('id', lote);
    if (error !== null) return [...cabecalho, `  Falhou ao ler events: ${error.message}`];
    for (const e of data ?? []) {
      amostra.push({
        id: e.id as string,
        titulo: (e.title as string) ?? '',
        categoria: (e.polymarket_category as string | null) ?? null,
      });
    }
  }

  // Fora de esporte: pela categoria quando ela existe, e pelo título quando não.
  // Heurística, e rotulada como tal — não é classificação, é corte grosseiro.
  const ESPORTE = /\b(vs\.?|game|match|set|handicap|o\/u|over|under|goals?|nba|nfl|mlb|nhl|ufc|soccer|tennis|cs2|lol|dota|series|inning|quarter|half)\b/i;
  const foraDeEsporte = (m: (typeof amostra)[number]): boolean => {
    if (m.categoria !== null) return !/sport|esport|game/i.test(m.categoria);
    return !ESPORTE.test(m.titulo);
  };

  // C. cadência, um event_id por vez.
  console.error(`[${LABEL}] medindo cadência em ${amostra.length} mercados…`);
  const intervalos: number[] = [];
  const intervalosForaDeEsporte: number[] = [];
  let comSerie = 0;
  let comSerieForaDeEsporte = 0;

  for (const m of amostra) {
    const { data, error } = await supabase
      .from('polymarket_snapshots')
      .select('captured_at')
      .eq('event_id', m.id)
      .order('captured_at', { ascending: false })
      .limit(300);
    if (error !== null) continue;

    // Timestamps DISTINTOS, e não linhas.
    //
    // A tabela tem uma linha por OUTCOME, não por captura: um mercado binário
    // grava duas linhas com o mesmo `captured_at`. Contar linhas dava intervalo
    // mediano de 0,0 min — o que não é uma cadência de segundos, é a mesma
    // captura contada duas vezes. Arredonda ao segundo porque a coluna tem
    // microssegundos e as duas linhas do par não são idênticas até a última casa.
    const ts = [
      ...new Set((data ?? []).map((r) => Math.floor(new Date(r.captured_at as string).getTime() / 1000))),
    ]
      .map((s) => s * 1000)
      .sort((a, b) => a - b);
    if (ts.length < 2) continue;

    comSerie++;
    const fora = foraDeEsporte(m);
    if (fora) comSerieForaDeEsporte++;

    // A mediana DENTRO do mercado primeiro, e só depois a mediana entre
    // mercados. Jogar todos os intervalos num balde só deixaria o mercado mais
    // capturado decidir o número sozinho.
    const passos: number[] = [];
    for (let i = 1; i < ts.length; i++) passos.push(((ts[i] as number) - (ts[i - 1] as number)) / 1000);
    passos.sort((a, b) => a - b);
    const medianaDoMercado = quantil(passos, 0.5);
    intervalos.push(medianaDoMercado);
    if (fora) intervalosForaDeEsporte.push(medianaDoMercado);
  }

  const minutos = (s: number): string => `${(s / 60).toFixed(1)} min`;
  const ord = [...intervalos].sort((a, b) => a - b);
  const ordFora = [...intervalosForaDeEsporte].sort((a, b) => a - b);

  return [
    ...cabecalho,
    `  janela da série: ${String(maisAntigo.data?.[0]?.captured_at ?? '—').slice(0, 19)} → ${String(maisNovo.data?.[0]?.captured_at ?? '—').slice(0, 19)}`,
    '',
    `  amostra: ${amostra.length} mercados distintos, tirados das 2.000 capturas mais recentes`,
    `  com série (>= 2 capturas):        ${comSerie}  (${pct(comSerie, amostra.length)})`,
    `  ... e fora de esporte:            ${comSerieForaDeEsporte}  (${pct(comSerieForaDeEsporte, comSerie)} dos com série)`,
    '',
    `  INTERVALO MEDIANO ENTRE CAPTURAS: ${ord.length === 0 ? '—' : minutos(quantil(ord, 0.5))}`,
    `    distribuição: p25 ${ord.length === 0 ? '—' : minutos(quantil(ord, 0.25))}  p75 ${ord.length === 0 ? '—' : minutos(quantil(ord, 0.75))}  p95 ${ord.length === 0 ? '—' : minutos(quantil(ord, 0.95))}`,
    `    só fora de esporte (n=${ordFora.length}): ${ordFora.length === 0 ? '—' : minutos(quantil(ordFora, 0.5))}`,
    '',
    '  É mediana da mediana: primeiro o passo típico DENTRO de cada mercado, depois',
    '  entre mercados. Um balde único deixaria o mercado mais capturado decidir o',
    '  número sozinho.',
    '',
    '  AMOSTRA, não censo. `count(distinct event_id)` sobre a tabela inteira é seq',
    '  scan e não cabe nos 8s do PostgREST — o número de mercados com série no banco',
    '  todo não sai por esta rota, e fingir que sai seria inventar precisão.',
  ];
}

main().catch((err: unknown) => {
  console.error(`[${LABEL}] falhou:`, err instanceof Error ? err.message : String(err));
  process.exit(1);
});
