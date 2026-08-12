import { test } from 'node:test';
import assert from 'node:assert/strict';

/**
 * A simulação de execução, sem rede.
 *
 * Um backtest erra de um jeito específico: ele não quebra, ele fica otimista. As
 * três formas disso acontecer aqui têm teste — comprar pelo mid em vez do ask,
 * contar a mesma partida duas vezes, e dimensionar com um `p` que já conhece o
 * resultado da aposta que está dimensionando.
 */
process.env['SUPABASE_URL'] ??= 'http://localhost:54321';
process.env['SUPABASE_SERVICE_KEY'] ??= 'test-key';

const { backtestFixed, backtestKelly, contractPnl, maxDrawdown, splitExecutionByMatch } =
  await import('./backtest.js');

type ExecutionPoint = import('./market-dataset.js').ExecutionPoint;

function exec(overrides: Partial<ExecutionPoint> = {}): ExecutionPoint {
  return {
    matchId: 'm1',
    matchSlug: 'cs2-navi-faze',
    eventId: 'e1',
    checkpointMinutes: 60,
    scheduledAt: '2026-08-10T12:00:00.000Z',
    capturedAt: '2026-08-10T11:00:00.000Z',
    favoriteLabel: 'NAVI',
    favoriteIsTeamA: true,
    mid: 0.93,
    ask: 0.94,
    bid: 0.92,
    spread: 0.02,
    outcome: 1,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// A aritmética de um contrato
// ---------------------------------------------------------------------------

test('ganhar paga 1 − ask; perder custa o ask inteiro', () => {
  assert.equal(contractPnl(0.94, 1, 0).toFixed(4), '0.0600');
  assert.equal(contractPnl(0.94, 0, 0).toFixed(4), '-0.9400');
});

test('a taxa incide sobre o ganho, não sobre o principal', () => {
  // 10% sobre um ganho bruto de 0,06 = 0,054. A perda não muda.
  assert.equal(contractPnl(0.94, 1, 0.1).toFixed(4), '0.0540');
  assert.equal(contractPnl(0.94, 0, 0.1).toFixed(4), '-0.9400');
});

test('a checagem de sanidade fecha: mercado 0,93, observado 0,97, compra a 0,94', () => {
  // 100 apostas a 0,94 com 97 vitórias. EV esperado à mão:
  //   0,97 × 0,06 − 0,03 × 0,94 = 0,0582 − 0,0282 = +0,030 por contrato.
  const points = Array.from({ length: 100 }, (_, i) =>
    exec({
      matchId: `m${i}`,
      matchSlug: `cs2-p${i}`,
      scheduledAt: `2026-08-10T${String(i % 24).padStart(2, '0')}:00:00.000Z`,
      outcome: i < 97 ? 1 : 0,
    }),
  );

  const result = backtestFixed(points, 0.9, 0);
  assert.equal(result.bets, 100);
  assert.equal(result.evPerBet?.toFixed(3), '0.030');
  assert.equal(result.hitRate?.toFixed(2), '0.97');
});

// ---------------------------------------------------------------------------
// O que dispara, e por qual preço
// ---------------------------------------------------------------------------

test('o gatilho é o mid e a execução é o ask — nunca o contrário', () => {
  // mid 0,91 dispara em 0,90; o pagamento é 0,95, e é o 0,95 que entra no P&L.
  const result = backtestFixed([exec({ mid: 0.91, ask: 0.95, outcome: 1 })], 0.9, 0);

  assert.equal(result.bets, 1);
  assert.equal(result.evPerBet?.toFixed(4), '0.0500');
  assert.equal(result.meanSlippage?.toFixed(4), '0.0400');
});

test('mid abaixo do limiar não dispara, mesmo com ask atraente', () => {
  assert.equal(backtestFixed([exec({ mid: 0.89, ask: 0.5 })], 0.9, 0).bets, 0);
});

test('ask em 1,00 ou acima não é oportunidade, é dado ruim', () => {
  // Pagar 1,00 por um contrato que paga no máximo 1,00 é risco puro sem retorno.
  assert.equal(backtestFixed([exec({ ask: 1 })], 0.9, 0).bets, 0);
  assert.equal(backtestFixed([exec({ ask: 1.02 })], 0.9, 0).bets, 0);
});

test('drawdown é medido em ordem cronológica, não na ordem da lista', () => {
  // Perde primeiro (−0,94), depois ganha duas: o vale é 0,94 e ele existe mesmo
  // que a lista chegue com a vitória na frente.
  const trades = [
    exec({ matchId: 'm2', scheduledAt: '2026-08-11T12:00:00.000Z', outcome: 1 }),
    exec({ matchId: 'm1', scheduledAt: '2026-08-10T12:00:00.000Z', outcome: 0 }),
    exec({ matchId: 'm3', scheduledAt: '2026-08-12T12:00:00.000Z', outcome: 1 }),
  ];

  const result = backtestFixed(trades, 0.9, 0);
  assert.equal(result.maxDrawdown.toFixed(4), '0.9400');
  assert.equal(maxDrawdown([]).toFixed(4), '0.0000');
});

// ---------------------------------------------------------------------------
// O corte que impede o Kelly de trapacear
// ---------------------------------------------------------------------------

test('splitExecutionByMatch não deixa partida atravessar o corte', () => {
  const points = [1, 2, 3, 4].flatMap((n) =>
    [360, 60].map((checkpoint) =>
      exec({
        matchId: `m${n}`,
        checkpointMinutes: checkpoint,
        scheduledAt: `2026-08-0${n}T12:00:00.000Z`,
      }),
    ),
  );

  const { train, test: held } = splitExecutionByMatch(points);
  const trainIds = new Set(train.map((p) => p.matchId));

  assert.deepEqual([...trainIds].sort(), ['m1', 'm2']);
  assert.equal(
    held.some((p) => trainIds.has(p.matchId)),
    false,
  );
});

test('o p do Kelly vem do treino, e sem vantagem estimada não se aposta', () => {
  // Treino: favoritos a 0,94 que venceram só 80% das vezes. Comprando a 0,94, uma
  // probabilidade de 0,80 é vantagem NEGATIVA — o stake tem que ser zero.
  const train = Array.from({ length: 10 }, (_, i) =>
    exec({ matchId: `t${i}`, scheduledAt: '2026-08-01T12:00:00.000Z', outcome: i < 8 ? 1 : 0 }),
  );
  const test_ = [exec({ matchId: 'x1', scheduledAt: '2026-08-09T12:00:00.000Z' })];

  const result = backtestKelly(train, test_, 0.9, 0, { fraction: 0.25, maxStakePct: 0.03 });

  assert.equal(result.probabilityFromTrain?.toFixed(2), '0.80');
  assert.equal(result.bets, 0);
});

test('com vantagem estimada no treino, o stake respeita o teto', () => {
  const train = Array.from({ length: 20 }, (_, i) =>
    exec({ matchId: `t${i}`, scheduledAt: '2026-08-01T12:00:00.000Z', outcome: 1 }),
  );
  const test_ = [exec({ matchId: 'x1', scheduledAt: '2026-08-09T12:00:00.000Z', outcome: 1 })];

  const result = backtestKelly(train, test_, 0.9, 0, { fraction: 0.25, maxStakePct: 0.03 });

  // p do treino = 1,0 (vitória em todas), o que satura o Kelly; o teto é o que
  // impede a aposta de virar o bankroll inteiro em cima de 20 partidas.
  assert.equal(result.probabilityFromTrain, 1);
  assert.equal(result.bets, 1);
  assert.equal(result.trades[0]?.stake, 0.03);
});

test('sem treino não há p, e sem p não há aposta nenhuma', () => {
  const result = backtestKelly([], [exec()], 0.9, 0, { fraction: 0.25, maxStakePct: 0.03 });
  assert.equal(result.probabilityFromTrain, null);
  assert.equal(result.bets, 0);
});
