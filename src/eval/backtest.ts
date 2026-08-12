import { getFeeRate } from '../lib/fees.js';
import { kelly } from '../lib/kelly.js';
import type { ExecutionPoint } from './market-dataset.js';

/**
 * A simulação de "comprar o favorito acima de um limiar", com execução real.
 *
 * Sem I/O e sem banco: recebe as linhas compráveis e devolve números. A parte
 * que precisa estar certa é esta, e ela é toda aritmética conferível à mão.
 *
 * TRÊS DECISÕES QUE DEFINEM SE A CONTA VALE:
 *
 * 1. O gatilho é o MID, a execução é o ASK. É assim que se opera: o preço de
 *    mercado é o que dispara a regra, e o que sai da conta bancária é o ask.
 *    Medir o retorno no mid seria medir um trade que ninguém consegue fazer.
 *
 * 2. Uma aposta por (partida, checkpoint), e o relatório separa por checkpoint.
 *    Duas apostas na mesma partida não são duas observações — compartilham o
 *    desfecho, e somá-las como se fossem independentes infla tudo: n, EV total e,
 *    principalmente, a aparência de que a curva de capital é lisa.
 *
 * 3. O Kelly estima a probabilidade na metade ANTIGA e aposta na recente. Kelly
 *    com `p` estimado da mesma amostra em que se aposta é a forma mais elegante
 *    de transformar uma vantagem inexistente numa curva de capital bonita.
 */

/** Um trade simulado, com a conta aberta. */
export interface Trade {
  matchId: string;
  matchSlug: string;
  checkpointMinutes: number;
  scheduledAt: string;
  /** Preço de mercado que disparou a regra. */
  mid: number;
  /** Preço pago. */
  ask: number;
  /** Fração do bankroll apostada. 1 = stake fixo de uma unidade. */
  stake: number;
  outcome: 0 | 1;
  /** Resultado líquido em unidades de bankroll, já com taxa. */
  pnl: number;
}

/**
 * O P&L de UM contrato comprado a `ask`, com taxa.
 *
 * Ganhando: o contrato paga 1,00, então o lucro bruto é `1 − ask`. Perdendo,
 * perde-se o `ask` inteiro. A taxa da Polymarket incide sobre o GANHO, não sobre
 * o principal — e hoje `getFeeRate` devolve 0 para toda categoria (medido em
 * trades reais de maio/2026, ver `fees.ts`). Continua entrando na fórmula porque
 * uma taxa que volta a ser cobrada não pode exigir que alguém lembre de reabrir
 * esta conta.
 */
export function contractPnl(ask: number, outcome: 0 | 1, feeRate: number): number {
  if (outcome === 0) return -ask;
  const gross = 1 - ask;
  return gross - gross * feeRate;
}

export interface ThresholdResult {
  threshold: number;
  bets: number;
  /** Partidas distintas. Com uma aposta por partida, é igual a `bets`. */
  matches: number;
  /** Média de `pnl` por unidade apostada. É o EV por aposta. */
  evPerBet: number | null;
  /** Soma de `pnl`. Em stake fixo, é EV × apostas. */
  evTotal: number;
  /** Maior queda do pico ao vale na curva cronológica de capital. */
  maxDrawdown: number;
  /**
   * Fração de apostas vencedoras.
   *
   * INFORMATIVA, NUNCA O ALVO: comprar favorito a 0,95 acerta 95% das vezes por
   * construção e perde dinheiro se a frequência real for 0,93. A taxa de acerto
   * alta é o que a regra promete, não o que ela entrega.
   */
  hitRate: number | null;
  /** Média do mid no gatilho — o que o mercado pedia. */
  meanMid: number | null;
  /** Média do ask pago — o que se pagou de verdade. */
  meanAsk: number | null;
  /** Média de `ask − mid`: o custo da travessia, em unidades de probabilidade. */
  meanSlippage: number | null;
  /** Fração observada de vitórias do favorito. É o que decide o sinal do EV. */
  observedRate: number | null;
  trades: Trade[];
}

function empty(threshold: number): ThresholdResult {
  return {
    threshold,
    bets: 0,
    matches: 0,
    evPerBet: null,
    evTotal: 0,
    maxDrawdown: 0,
    hitRate: null,
    meanMid: null,
    meanAsk: null,
    meanSlippage: null,
    observedRate: null,
    trades: [],
  };
}

/**
 * Maior queda do pico ao vale, em ordem CRONOLÓGICA.
 *
 * A ordem é o que dá sentido ao número: drawdown de uma lista embaralhada é uma
 * estatística de permutação, não a experiência de quem operou. Ordenar por
 * `scheduledAt` é a aproximação certa — é quando a aposta teria sido feita.
 */
export function maxDrawdown(trades: readonly Trade[]): number {
  const ordered = [...trades].sort((a, b) =>
    a.scheduledAt < b.scheduledAt ? -1 : a.scheduledAt > b.scheduledAt ? 1 : 0,
  );

  let equity = 0;
  let peak = 0;
  let worst = 0;

  for (const trade of ordered) {
    equity += trade.pnl;
    if (equity > peak) peak = equity;
    const drawdown = peak - equity;
    if (drawdown > worst) worst = drawdown;
  }

  return worst;
}

function summarise(threshold: number, trades: readonly Trade[]): ThresholdResult {
  if (trades.length === 0) return empty(threshold);

  const staked = trades.reduce((sum, t) => sum + t.stake, 0);
  const pnl = trades.reduce((sum, t) => sum + t.pnl, 0);

  return {
    threshold,
    bets: trades.length,
    matches: new Set(trades.map((t) => t.matchId)).size,
    // Por unidade APOSTADA, não por aposta: com Kelly os stakes diferem, e a
    // média simples de `pnl` misturaria tamanho com vantagem.
    evPerBet: staked === 0 ? null : pnl / staked,
    evTotal: pnl,
    maxDrawdown: maxDrawdown(trades),
    hitRate: trades.filter((t) => t.outcome === 1).length / trades.length,
    meanMid: trades.reduce((sum, t) => sum + t.mid, 0) / trades.length,
    meanAsk: trades.reduce((sum, t) => sum + t.ask, 0) / trades.length,
    meanSlippage: trades.reduce((sum, t) => sum + (t.ask - t.mid), 0) / trades.length,
    observedRate: trades.filter((t) => t.outcome === 1).length / trades.length,
    trades: [...trades],
  };
}

/**
 * Stake fixo: uma unidade por gatilho.
 *
 * A primeira passada tem que ser esta. Stake fixo mede a VANTAGEM da regra;
 * qualquer dimensionamento por cima mede vantagem e dimensionamento juntos, e
 * quando o resultado é bom não se sabe qual dos dois o produziu.
 */
export function backtestFixed(
  points: readonly ExecutionPoint[],
  threshold: number,
  feeRate: number,
): ThresholdResult {
  const trades: Trade[] = [];

  for (const point of points) {
    if (point.mid < threshold) continue;
    // Ask acima de 1 não é comprável; ask exatamente 1 paga zero e só adiciona
    // risco. Os dois são erro de dado, não oportunidade.
    if (point.ask >= 1) continue;

    trades.push({
      matchId: point.matchId,
      matchSlug: point.matchSlug,
      checkpointMinutes: point.checkpointMinutes,
      scheduledAt: point.scheduledAt,
      mid: point.mid,
      ask: point.ask,
      stake: 1,
      outcome: point.outcome,
      pnl: contractPnl(point.ask, point.outcome, feeRate),
    });
  }

  return summarise(threshold, trades);
}

export interface KellyResult extends ThresholdResult {
  /** A frequência observada na metade antiga. É o `p` que dimensiona as apostas. */
  probabilityFromTrain: number | null;
  trainBets: number;
}

/**
 * Kelly fracionário com `p` estimado FORA da amostra em que se aposta.
 *
 * A metade antiga (por partida, nunca por linha) estima com que frequência o
 * favorito acima do limiar de fato vence; a metade recente é onde as apostas
 * acontecem. Sem essa separação, o `p` do Kelly conhece o resultado das apostas
 * que ele dimensiona, e o resultado é uma curva que sobe por construção.
 *
 * `p` do treino menor ou igual ao preço zera o stake — e é o comportamento
 * certo: sem vantagem estimada não se aposta.
 */
export function backtestKelly(
  train: readonly ExecutionPoint[],
  test: readonly ExecutionPoint[],
  threshold: number,
  feeRate: number,
  options: { fraction: number; maxStakePct: number },
): KellyResult {
  const trainBets = train.filter((p) => p.mid >= threshold && p.ask < 1);
  const probability =
    trainBets.length === 0
      ? null
      : trainBets.filter((p) => p.outcome === 1).length / trainBets.length;

  const trades: Trade[] = [];

  if (probability !== null) {
    for (const point of test) {
      if (point.mid < threshold || point.ask >= 1) continue;

      // O Kelly dimensiona contra o preço PAGO. Usar o mid aqui inflaria o stake
      // com uma vantagem que a travessia do book já comeu.
      const stake = kelly({
        probability,
        marketPrice: point.ask,
        fraction: options.fraction,
        maxStakePct: options.maxStakePct,
      });

      if (stake <= 0) continue;

      // `contractPnl` é por contrato de US$ 1 de payout; o stake compra
      // `stake / ask` contratos, então o P&L escala por `stake / ask`.
      const contracts = stake / point.ask;

      trades.push({
        matchId: point.matchId,
        matchSlug: point.matchSlug,
        checkpointMinutes: point.checkpointMinutes,
        scheduledAt: point.scheduledAt,
        mid: point.mid,
        ask: point.ask,
        stake,
        outcome: point.outcome,
        pnl: contractPnl(point.ask, point.outcome, feeRate) * contracts,
      });
    }
  }

  return {
    ...summarise(threshold, trades),
    probabilityFromTrain: probability,
    trainBets: trainBets.length,
  };
}

/**
 * Metade antiga / metade recente, com a PARTIDA como unidade.
 *
 * Mesma regra do resto do eval: os dois checkpoints de uma partida têm o mesmo
 * desfecho e não podem ficar em lados opostos, ou o `p` do Kelly já conhece o
 * resultado da aposta que ele dimensiona.
 */
export function splitExecutionByMatch(points: readonly ExecutionPoint[]): {
  train: ExecutionPoint[];
  test: ExecutionPoint[];
} {
  const firstSeen = new Map<string, string>();
  for (const point of points) {
    const current = firstSeen.get(point.matchId);
    if (current === undefined || point.scheduledAt < current) {
      firstSeen.set(point.matchId, point.scheduledAt);
    }
  }

  const ordered = [...firstSeen.entries()].sort(([idA, a], [idB, b]) =>
    a < b ? -1 : a > b ? 1 : idA < idB ? -1 : 1,
  );

  const half = Math.floor(ordered.length / 2);
  const trainIds = new Set(ordered.slice(0, half).map(([id]) => id));

  return {
    train: points.filter((p) => trainIds.has(p.matchId)),
    test: points.filter((p) => !trainIds.has(p.matchId)),
  };
}

/**
 * A taxa em vigor, lida de `fees.ts` e não chutada aqui.
 *
 * Hoje é 0 para toda categoria e não existe taxa de resolução na Polymarket
 * Internacional — o que significa que o veredito deste backtest é sobre o SPREAD
 * e mais nada. Se a taxa voltar, esta função é o único ponto a mudar, e o
 * relatório imprime o número que ela devolveu.
 */
export function currentFeeRate(): number {
  return getFeeRate('sports', null);
}
