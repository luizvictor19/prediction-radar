import 'dotenv/config';
import {
  CHECKPOINTS,
  TOLERANCE_SECONDS,
  loadExecutionDataset,
  loadMarketUniverse,
  type ExecutionDiscardReason,
  type ExecutionPoint,
} from '../src/eval/market-dataset.js';
import {
  backtestFixed,
  backtestKelly,
  currentFeeRate,
  splitExecutionByMatch,
  type KellyResult,
  type ThresholdResult,
} from '../src/eval/backtest.js';

/**
 * "Comprar o favorito acima de um limiar" — sobra dinheiro depois do book?
 *
 * A calibração já disse que o favorito parece barato demais. Essa é uma
 * afirmação sobre o MID. Esta sonda faz a pergunta que decide se o achado vale
 * alguma coisa: comprando pelo `best_ask`, pagando as taxas que houver, o
 * resultado ainda é positivo?
 *
 * SÓ LEITURA. Nenhum INSERT, UPDATE, DELETE ou DDL, nenhuma chamada de API paga,
 * nenhuma ordem enviada a lugar nenhum. É sonda: não tem cron e não grava nada.
 *
 * ## O que ela NÃO simula, e é honesto dizer antes
 *
 *   - PROFUNDIDADE. Compra ao `best_ask` do topo do book. Em mercado de CS2 com
 *     liquidez de dezenas de dólares, uma ordem de tamanho real anda o preço, e
 *     o retorno de verdade é PIOR que o daqui. O que sai deste script é um TETO.
 *   - o preço de um instante só (o checkpoint), não a melhor execução da janela;
 *   - saída antes do fim: toda posição é levada até a resolução.
 *
 * ## Custo no banco
 *
 * Uma consulta por (partida, checkpoint), com `event_id` E os dois lados de
 * `captured_at` — a mesma disciplina do `eval:market`. A diferença é que aqui a
 * consulta NÃO filtra por rótulo: traz os dois lados do book, porque quando o
 * favorito é o adversário do time A é o `best_ask` DELE que se paga.
 *
 * ## Uso
 *
 *   npm run backtest:favorite -- --dry-run
 *   npm run backtest:favorite
 *   npm run backtest:favorite -- --thresholds=0.80,0.85,0.90,0.92,0.95
 *   npm run backtest:favorite -- --kelly-fraction=0.25 --max-stake=0.03
 */

const LABEL = 'backtest-favorite';

/**
 * A varredura padrão. É uma REGIÃO que se procura, não um vencedor.
 *
 * O melhor limiar de uma varredura é bom por construção — com cinco cortes sobre
 * a mesma amostra, o maior EV é em parte o maior ruído. O que sustenta decisão é
 * uma faixa contígua de limiares com EV positivo; um pico solto entre vizinhos
 * negativos é o retrato do acaso.
 */
const DEFAULT_THRESHOLDS = [0.8, 0.85, 0.9, 0.92, 0.95];

interface Args {
  thresholds: number[];
  kellyFraction: number;
  maxStake: number;
  dryRun: boolean;
}

function parseArgs(argv: readonly string[]): Args | { error: string } {
  const args: Args = {
    thresholds: [...DEFAULT_THRESHOLDS],
    kellyFraction: 0.25,
    maxStake: 0.03,
    dryRun: false,
  };

  for (const arg of argv) {
    if (arg === '--dry-run') {
      args.dryRun = true;
      continue;
    }

    const match = /^--(thresholds|kelly-fraction|max-stake)=(.+)$/.exec(arg);
    if (match === null) return { error: `argumento desconhecido: ${arg}` };

    const [, key, raw = ''] = match;

    if (key === 'thresholds') {
      const parts = raw.split(',').map((part) => Number(part.trim()));
      if (parts.length === 0 || parts.some((n) => !Number.isFinite(n) || n <= 0.5 || n >= 1)) {
        return { error: `--thresholds=${raw} precisa ser uma lista em (0,5; 1,0)` };
      }
      args.thresholds = [...new Set(parts)].sort((a, b) => a - b);
      continue;
    }

    const value = Number(raw);
    if (!Number.isFinite(value) || value <= 0 || value > 1) {
      return { error: `--${key}=${raw} precisa estar em (0; 1]` };
    }

    if (key === 'kelly-fraction') args.kellyFraction = value;
    else args.maxStake = value;
  }

  return args;
}

// ---------------------------------------------------------------------------
// Formatação
// ---------------------------------------------------------------------------

function num(value: number | null, digits = 4): string {
  return value === null ? '—' : value.toFixed(digits);
}

function signed(value: number | null, digits = 4): string {
  if (value === null) return '—';
  return `${value >= 0 ? '+' : ''}${value.toFixed(digits)}`;
}

function pct(value: number | null, digits = 1): string {
  return value === null ? '—' : `${(value * 100).toFixed(digits)}%`;
}

function table(
  headers: readonly string[],
  rows: ReadonlyArray<readonly string[]>,
  leftAlign: readonly number[] = [],
): string {
  if (rows.length === 0) return '  (vazio)';

  const left = new Set([0, ...leftAlign]);
  const widths = headers.map((header, i) =>
    Math.max(header.length, ...rows.map((row) => (row[i] ?? '').length)),
  );

  const line = (cells: readonly string[]): string =>
    '  ' +
    cells
      .map((cell, i) => (left.has(i) ? cell.padEnd(widths[i] ?? 0) : cell.padStart(widths[i] ?? 0)))
      .join('  ')
      .trimEnd();

  const rule = ('  ' + widths.map((w) => '-'.repeat(w)).join('  ')).trimEnd();

  return [line(headers), rule, ...rows.map(line)].join('\n');
}

function section(title: string): string {
  return `\n${title}\n${'='.repeat(title.length)}\n`;
}

function sweepTable(results: readonly ThresholdResult[]): string {
  return table(
    [
      'limiar',
      'apostas',
      'partidas',
      'EV/aposta',
      'EV total',
      'drawdown',
      'acerto',
      'mid̄',
      'ask̄',
      'ask−mid',
    ],
    results.map((r) => [
      r.threshold.toFixed(2),
      String(r.bets),
      String(r.matches),
      signed(r.evPerBet),
      signed(r.evTotal, 3),
      num(r.maxDrawdown, 3),
      pct(r.hitRate),
      num(r.meanMid, 3),
      num(r.meanAsk, 3),
      signed(r.meanSlippage, 4),
    ]),
  );
}

/**
 * A leitura da curva: existe REGIÃO positiva, ou um pico solto?
 *
 * "Região" é uma sequência contígua de limiares com EV positivo. Um único limiar
 * positivo entre vizinhos negativos é o que uma varredura de cinco cortes produz
 * por acaso com facilidade, e chamá-lo de achado é o erro que esta função existe
 * para impedir.
 */
function readCurve(results: readonly ThresholdResult[], minBets: number): string {
  const usable = results.filter((r) => r.bets >= minBets);
  const positive = usable.filter((r) => (r.evPerBet ?? 0) > 0);

  if (usable.length === 0) {
    return (
      `  Nenhum limiar tem ao menos ${minBets} apostas. A curva inteira está apoiada em\n` +
      '  amostra curta demais para ter sinal — o que se vê aqui é ruído com formato.'
    );
  }

  if (positive.length === 0) {
    return (
      '  NENHUM limiar tem EV positivo depois do ask. O gap medido no mid não sobrevive\n' +
      '  à travessia do book: a regra existe, é real na calibração, e perde dinheiro.'
    );
  }

  // Maior sequência contígua de limiares positivos, na ordem da varredura.
  let best = 0;
  let current = 0;
  let bestEnd = -1;
  for (const [index, r] of usable.entries()) {
    if ((r.evPerBet ?? 0) > 0) {
      current += 1;
      if (current > best) {
        best = current;
        bestEnd = index;
      }
    } else current = 0;
  }

  const from = usable[bestEnd - best + 1]?.threshold ?? null;
  const to = usable[bestEnd]?.threshold ?? null;

  if (best === 1) {
    const isolated = positive.map((r) => r.threshold.toFixed(2)).join(', ');
    return (
      `  ${positive.length} limiar(es) positivo(s) — ${isolated} —, nenhum deles vizinho de outro.\n` +
      '  Isso é PICO SOLTO, não região. EV que aparece em 0,80, some em 0,85 e volta em\n' +
      '  0,90 não descreve um mercado torto: descreve uma amostra pequena reamostrada\n' +
      '  cinco vezes. Não sustenta regra.'
    );
  }

  return (
    `  REGIÃO positiva de ${num(from, 2)} a ${num(to, 2)} (${best} limiares contíguos). É a forma que uma\n` +
    '  vantagem real tem — o EV não deveria aparecer e sumir entre cortes vizinhos.\n' +
    '  Continua sendo um TETO: a simulação compra no topo do book, sem profundidade.'
  );
}

/** A checagem de sanidade, com os números da amostra. */
function sanityCheck(
  points: readonly ExecutionPoint[],
  threshold: number,
  feeRate: number,
): string {
  const fired = points.filter((p) => p.mid >= threshold && p.ask < 1);
  if (fired.length === 0) return `  (nenhuma aposta em ${threshold.toFixed(2)} para conferir)`;

  const meanMid = fired.reduce((s, p) => s + p.mid, 0) / fired.length;
  const meanAsk = fired.reduce((s, p) => s + p.ask, 0) / fired.length;
  const observed = fired.filter((p) => p.outcome === 1).length / fired.length;

  const evGross = observed * (1 - meanAsk) - (1 - observed) * meanAsk;
  const evNet = observed * (1 - meanAsk) * (1 - feeRate) - (1 - observed) * meanAsk;

  return [
    `  limiar ${threshold.toFixed(2)}: ${fired.length} aposta(s)`,
    `  mercado pedia (mid̄):        ${num(meanMid, 3)}`,
    `  pagou (ask̄):                ${num(meanAsk, 3)}`,
    `  desfecho observado:          ${num(observed, 3)}`,
    '',
    `  EV bruto = ${num(observed, 2)} × ${num(1 - meanAsk, 2)} − ${num(1 - observed, 2)} × ${num(meanAsk, 2)} = ${signed(evGross)}`,
    `  EV com taxa de ${pct(feeRate, 2)}:  ${signed(evNet)}`,
    '',
    '  É a conta inteira, com os números desta amostra. Se ela divergir do EV/aposta',
    '  da tabela acima, a divergência é aritmética e não interpretação — a tabela usa',
    '  cada ask individualmente, a conta acima usa a média, e as duas só coincidem',
    '  quando a dispersão do ask é pequena.',
  ].join('\n');
}

function kellyTable(results: readonly KellyResult[]): string {
  return table(
    [
      'limiar',
      'p (treino)',
      'apostas treino',
      'apostas teste',
      'stakē',
      'EV/unidade',
      'EV total',
      'drawdown',
    ],
    results.map((r) => [
      r.threshold.toFixed(2),
      num(r.probabilityFromTrain, 3),
      String(r.trainBets),
      String(r.bets),
      num(r.bets === 0 ? null : r.trades.reduce((s, t) => s + t.stake, 0) / r.bets, 4),
      signed(r.evPerBet),
      signed(r.evTotal, 4),
      num(r.maxDrawdown, 4),
    ]),
  );
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if ('error' in args) {
    console.error(`[${LABEL}] ${args.error}`);
    console.error(
      `[${LABEL}] uso: npm run backtest:favorite -- [--dry-run] [--thresholds=0.80,0.90] ` +
        `[--kelly-fraction=0.25] [--max-stake=0.03]`,
    );
    process.exit(1);
    return;
  }

  console.error(`[${LABEL}] lendo universo…`);
  const universe = await loadMarketUniverse();

  if (args.dryRun) {
    console.log(
      [
        'DRY RUN — dimensionamento, nenhuma série lida',
        '=============================================',
        '',
        `  partidas no universo:        ${universe.matches.length}`,
        `  consultas que a passada faria: ${universe.matches.length * CHECKPOINTS.length}`,
        `  (uma por partida × checkpoint, com event_id e janela de ±${TOLERANCE_SECONDS}s,`,
        '   sem filtro de outcome — os dois lados do book na mesma consulta)',
        '',
        `  limiares: ${args.thresholds.map((t) => t.toFixed(2)).join(', ')}`,
      ].join('\n'),
    );
    return;
  }

  const feeRate = currentFeeRate();
  console.error(`[${LABEL}] lendo book dos dois lados…`);
  const data = await loadExecutionDataset(universe);

  const byCheckpoint = new Map<number, ExecutionPoint[]>();
  for (const point of data.points) {
    const bucket = byCheckpoint.get(point.checkpointMinutes);
    if (bucket === undefined) byCheckpoint.set(point.checkpointMinutes, [point]);
    else bucket.push(point);
  }

  const out: string[] = [
    'BACKTEST — COMPRAR O FAVORITO ACIMA DE UM LIMIAR',
    '================================================',
    'Gatilho no mid, execução no best_ask, taxas de fees.ts. Uma aposta por',
    '(partida, checkpoint); os checkpoints são reportados separados porque duas',
    'apostas na mesma partida compartilham o desfecho e não são duas observações.',
    '',
    'O QUE ESTE NÚMERO NÃO INCLUI: profundidade de book. A compra é ao best_ask do',
    'topo, e uma ordem de tamanho real em mercado de CS2 anda o preço. O resultado',
    'abaixo é um TETO, não uma expectativa.',
    section('COBERTURA'),
    `  partidas no universo:      ${universe.matches.length}`,
    `  linhas compráveis:         ${data.points.length}`,
    `  consultas:                 ${data.queries}`,
    `  snapshots lidos:           ${data.snapshotsRead}`,
    `  taxa em vigor (fees.ts):   ${pct(feeRate, 2)}`,
    '',
    '  descartes (linha que não virou oportunidade):',
    table(
      ['motivo', 'n'],
      (Object.entries(data.discards) as Array<[ExecutionDiscardReason, number]>)
        .filter(([, n]) => n > 0)
        .sort((a, b) => b[1] - a[1])
        .map(([reason, n]) => [reason, String(n)]),
    ),
    '',
    '  `sem_ask` é o descarte que mantém esta simulação honesta: sem os dois lados do',
    '  book não há preço de execução, e estimar um seria inventar o resultado.',
  ];

  const minBets = 20;

  for (const checkpoint of [...CHECKPOINTS].sort((a, b) => b - a)) {
    const points = byCheckpoint.get(checkpoint) ?? [];
    const results = args.thresholds.map((t) => backtestFixed(points, t, feeRate));

    out.push(
      section(`STAKE FIXO — T-${checkpoint}min (${points.length} linha(s) compráveis)`),
      'Uma unidade por gatilho. Mede a VANTAGEM da regra, sem dimensionamento junto.',
      '',
      sweepTable(results),
      '',
      readCurve(results, minBets),
    );
  }

  // A checagem de sanidade roda no checkpoint mais próximo do jogo e no limiar
  // de 0,90 — é onde a aritmética prevista à mão pode ser conferida.
  const nearest = Math.min(...CHECKPOINTS);
  out.push(
    section('CHECAGEM DE SANIDADE — a conta aberta'),
    `  T-${nearest}min, para a aritmética poder ser conferida à mão:`,
    '',
    sanityCheck(byCheckpoint.get(nearest) ?? [], 0.9, feeRate),
  );

  out.push(
    section('KELLY FRACIONÁRIO — dimensionamento, com p estimado FORA da amostra'),
    `  fração ${args.kellyFraction}, teto de ${pct(args.maxStake, 1)} do bankroll por aposta.`,
    '  O p vem da metade ANTIGA (por partida) e as apostas acontecem na recente. Kelly',
    '  com p estimado da mesma amostra em que se aposta produz curva bonita por',
    '  construção — a diferença entre esta tabela e a de stake fixo é o que separa',
    '  vantagem de dimensionamento.',
  );

  for (const checkpoint of [...CHECKPOINTS].sort((a, b) => b - a)) {
    const points = byCheckpoint.get(checkpoint) ?? [];
    const { train, test } = splitExecutionByMatch(points);
    const trainIds = new Set(train.map((p) => p.matchId));
    const straddling = new Set(test.filter((p) => trainIds.has(p.matchId)).map((p) => p.matchId))
      .size;

    const results = args.thresholds.map((t) =>
      backtestKelly(train, test, t, feeRate, {
        fraction: args.kellyFraction,
        maxStakePct: args.maxStake,
      }),
    );

    out.push(
      '',
      `T-${checkpoint}min — treino ${new Set(train.map((p) => p.matchId)).size} partida(s), ` +
        `teste ${new Set(test.map((p) => p.matchId)).size} partida(s); ` +
        `partidas nas duas metades: ${straddling}${straddling === 0 ? ' (interseção vazia)' : ' — DEFEITO'}`,
      kellyTable(results),
    );
  }

  console.log(out.join('\n'));
}

main().catch((err: unknown) => {
  console.error(`[${LABEL}] falhou:`, err instanceof Error ? err.message : String(err));
  process.exit(1);
});
