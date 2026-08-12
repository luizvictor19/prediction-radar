/**
 * Reanálise da fase 2 a partir do snapshot, sem tocar em rede.
 *
 * A passada completa custa ~2800 requisições e 13 minutos. Iterar a ANÁLISE em
 * cima disso — recortar de outro jeito, mudar as bordas dos baldes, olhar um
 * instante só — não deveria custar nada disso, e principalmente não deveria
 * custar tráfego numa API gratuita que já respondeu a pergunta uma vez.
 *
 * Lê `probes/xtracker/calibration-dataset.json`, que a sonda grava, e reimprime
 * as medidas A e B com as mesmas funções. Se os números divergirem dos da sonda,
 * é porque alguém mudou a conta num lugar só.
 *
 *   npm run xtracker:reanalyze
 *   npm run xtracker:reanalyze -- --offset=48        # só um instante
 *   npm run xtracker:reanalyze -- --edges=0,.05,.2,1
 */

import { num, section, table } from './lib/probe-net.js';

import {
  BIN_ASK,
  BIN_PRICE,
  type BinPoint,
  type EdgeBucket,
  type InstantRow,
  MIN_MATCHES_FOR_BUCKET,
  PRICE_EDGES,
  PRICE_SUM_MAX,
  PRICE_SUM_MIN,
  bucketGap,
  bucketLabel,
  coherentPoints,
  distinctMarkets,
  edgeBuckets,
  mean,
  regimeRows,
  splitByMarketTime,
} from './lib/calibration.js';

const LABEL = 'analyze-xtracker-calib';
const SNAPSHOT = 'probes/xtracker/calibration-dataset.json';

/** O tick destes mercados. Gap menor que isso não tem ordem que o capture. */
const TICK = 0.001;

interface Dataset {
  points: BinPoint[];
  instants: InstantRow[];
  deadRows: number;
  liveRows: number;
}

function parseEdges(raw: string): number[] | null {
  const parsed = raw.split(',').map(Number);
  if (parsed.some((v) => !Number.isFinite(v) || v < 0 || v > 1)) return null;
  if (parsed.length < 2) return null;
  for (let i = 1; i < parsed.length; i += 1) {
    if ((parsed[i] ?? 0) <= (parsed[i - 1] ?? 0)) return null;
  }
  return parsed;
}

function bucketRows(buckets: readonly EdgeBucket[]): string[][] {
  return buckets.map((b) => {
    const gap = bucketGap(b);
    const conclusive = b.distinctMarkets >= MIN_MATCHES_FOR_BUCKET;
    const excludes = b.ciLow > b.meanPredicted || b.ciHigh < b.meanPredicted;
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
        : !excludes
          ? 'o preço cabe no intervalo'
          : Math.abs(gap) < TICK
            ? `gap < 1 tick (${TICK}) — nulo`
            : gap > 0
              ? 'CARA — aconteceu MENOS'
              : 'BARATA — aconteceu MAIS',
    ];
  });
}

const HEAD = [
  'balde',
  'n',
  'mercados',
  'preço médio',
  'aconteceu',
  'IC 95% (agrupado)',
  'gap',
  'leitura',
] as const;

async function main(): Promise<void> {
  let edges = [...PRICE_EDGES];
  let offset: number | null = null;

  for (const arg of process.argv.slice(2)) {
    const match = /^--(edges|offset)=(.+)$/.exec(arg);
    if (match === null) {
      console.error(`[${LABEL}] argumento desconhecido: ${arg}`);
      process.exit(1);
      return;
    }
    const [, key, raw = ''] = match;
    if (key === 'edges') {
      const parsed = parseEdges(raw);
      if (parsed === null) {
        console.error(`[${LABEL}] --edges precisa ser uma lista crescente em [0,1]`);
        process.exit(1);
        return;
      }
      edges = parsed;
    } else {
      offset = Number(raw);
    }
  }

  const { readFile } = await import('node:fs/promises');
  let data: Dataset;
  try {
    data = JSON.parse(await readFile(SNAPSHOT, 'utf8')) as Dataset;
  } catch {
    console.error(`[${LABEL}] não achei ${SNAPSHOT}. Rode \`npm run xtracker:calib\` antes.`);
    process.exit(1);
    return;
  }

  const points =
    offset === null ? data.points : data.points.filter((p) => p.offsetHours === offset);
  const instants =
    offset === null ? data.instants : data.instants.filter((i) => i.offsetHours === offset);

  const cheap = points.filter((p) => p.price < 0.1);
  const { older, newer } = splitByMarketTime(points);
  const olderIds = new Set(older.map((p) => p.marketSlug));
  const leak = [...new Set(newer.map((p) => p.marketSlug))].filter((id) => olderIds.has(id));
  const { bySeries, strongest, strongestSplit } = regimeRows(instants);
  const coherent = coherentPoints(points, instants);

  const zRow = (s: {
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
  const zHead = ['recorte', 'n', 'média z', 'IC 95%', 'desvio z', 'soma preços', 'veredito'];

  const out = [
    'REANÁLISE DA FASE 2 — do snapshot, sem rede',
    '===========================================',
    `  fonte: ${SNAPSHOT}`,
    `  linhas: ${points.length}  mercados: ${distinctMarkets(points)}` +
      (offset === null ? '  (T-48h e T-24h)' : `  (só T-${offset}h)`),
    `  bordas: ${edges.join(', ')}`,
    '',
    section('MEDIDA A — no mid'),
    table(HEAD, bucketRows(edgeBuckets(points, BIN_PRICE, edges)), [0, 5, 7]),
    '',
    `  abaixo de 10¢: ${cheap.length} linhas, ${distinctMarkets(cheap)} mercados, ` +
      `preço ${num(mean(cheap.map((p) => p.price)), 4)}, aconteceu ${num(mean(cheap.map((p) => p.outcome)), 4)}`,
    section('MEDIDA A — comprando no ask (mid + meio spread)'),
    table(HEAD, bucketRows(edgeBuckets(points, BIN_ASK, edges)), [0, 5, 7]),
    section(`MEDIDA A CORRIGIDA — só onde os preços somam [${PRICE_SUM_MIN}; ${PRICE_SUM_MAX}]`),
    `  mercado-instantes mantidos: ${coherent.keptInstants}   removidos: ${coherent.droppedInstants}`,
    `  linhas mantidas: ${coherent.kept.length}   removidas: ${coherent.dropped.length}`,
    '',
    table(HEAD, bucketRows(edgeBuckets(coherent.kept, BIN_PRICE, edges)), [0, 5, 7]),
    '',
    '  O que foi REMOVIDO:',
    table(HEAD, bucketRows(edgeBuckets(coherent.dropped, BIN_PRICE, edges)), [0, 5, 7]),
    section('GUARDA 2 — divisão temporal por mercado'),
    `  antiga: ${distinctMarkets(older)} mercados / ${older.length} linhas   ` +
      `recente: ${distinctMarkets(newer)} mercados / ${newer.length} linhas   ` +
      `interseção: ${leak.length}`,
    '',
    '  Metade ANTIGA:',
    table(HEAD, bucketRows(edgeBuckets(older, BIN_PRICE, edges)), [0, 5, 7]),
    '',
    '  Metade RECENTE:',
    table(HEAD, bucketRows(edgeBuckets(newer, BIN_PRICE, edges)), [0, 5, 7]),
    section('MEDIDA B — viés por série x instante'),
    table(zHead, bySeries.map(zRow), [0, 3, 6]),
  ];

  if (strongest !== null) {
    out.push(
      '',
      `  Recorte mais forte: ${strongest.label}. As guardas em cima dele:`,
      '',
      table(zHead, strongestSplit.map(zRow), [0, 3, 6]),
    );
  }

  console.log(out.join('\n'));
}

main().catch((err: unknown) => {
  console.error(`[${LABEL}] falhou:`, err instanceof Error ? err.message : String(err));
  process.exit(1);
});
