import { test } from 'node:test';
import assert from 'node:assert/strict';

// Nada aqui toca banco: `metrics.ts` é função pura sobre uma lista de pontos, e
// `resolveOutcome` recebe os ids já lidos. O que se confere é aritmética contra
// valores calculados à mão — um Brier errado não falha, mente com três casas.
process.env['SUPABASE_URL'] ??= 'http://localhost:54321';
process.env['SUPABASE_SERVICE_KEY'] ??= 'test-key';

const {
  AGENT,
  COIN,
  MARKET,
  bias,
  brierScore,
  calibrationError,
  cut,
  liquidityBand,
  murphyDecomposition,
  pairedSample,
  reliabilityBuckets,
  skillScore,
} = await import('./metrics.js');

const { resolveOutcome } = await import('./dataset.js');

type EvalPoint = import('./metrics.js').EvalPoint;

function point(overrides: Partial<EvalPoint> = {}): EvalPoint {
  return {
    analysisId: 'a1',
    matchSlug: 'cs2-navi-faze-2026-08-07',
    checkpointMinutes: 360,
    asOf: '2026-08-07T12:00:00.000Z',
    model: 'claude-opus-5',
    promptVersion: 'v1',
    probability: 0.6,
    marketMid: 0.55,
    liquidity: 12_000,
    outcome: 1,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Brier
// ---------------------------------------------------------------------------

test('Brier é a média de (p - y)²', () => {
  const points = [
    point({ probability: 0.8, outcome: 1 }), // 0.04
    point({ probability: 0.3, outcome: 0 }), // 0.09
    point({ probability: 0.5, outcome: 1 }), // 0.25
  ];
  // (0.04 + 0.09 + 0.25) / 3 = 0.126666...
  assert.equal(brierScore(points, AGENT)?.toFixed(6), '0.126667');
});

test('a moeda dá exatamente 0,25, sempre', () => {
  const points = [point({ outcome: 1 }), point({ outcome: 0 }), point({ outcome: 1 })];
  assert.equal(brierScore(points, COIN), 0.25);
});

test('previsão perfeita dá zero e a pior possível dá um', () => {
  assert.equal(brierScore([point({ probability: 1, outcome: 1 })], AGENT), 0);
  assert.equal(brierScore([point({ probability: 0, outcome: 1 })], AGENT), 1);
});

test('amostra vazia devolve null, não NaN', () => {
  // NaN se propaga em silêncio pela tabela inteira e só vira "—" no fim.
  assert.equal(brierScore([], AGENT), null);
  assert.equal(bias([], AGENT), null);
  assert.equal(murphyDecomposition([], AGENT), null);
});

test('ponto sem opinião do previsor sai da conta dele, não conta como zero', () => {
  const points = [
    point({ probability: 0.8, outcome: 1, marketMid: 0.8 }),
    point({ probability: 0.8, outcome: 1, marketMid: null }),
  ];
  // O mercado só opina no primeiro: 0.04, e não (0.04 + 0.64)/2 que seria tratar
  // o null como 0.
  assert.equal(brierScore(points, MARKET)?.toFixed(4), '0.0400');
  assert.equal(pairedSample(points).length, 1);
});

test('skill é a fração do erro da referência que se economiza', () => {
  // Metade do erro do mercado = skill 0,5.
  assert.equal(skillScore(0.1, 0.2)?.toFixed(4), '0.5000');
  assert.equal(skillScore(0.2, 0.2), 0);
  assert.equal(skillScore(0.3, 0.2)?.toFixed(4), '-0.5000');
  // Referência perfeita não tem denominador — null em vez de divisão por zero.
  assert.equal(skillScore(0.1, 0), null);
  assert.equal(skillScore(null, 0.2), null);
});

// ---------------------------------------------------------------------------
// Viés e calibração
// ---------------------------------------------------------------------------

test('viés positivo = apostou no time A mais do que o time A venceu', () => {
  const points = [point({ probability: 0.9, outcome: 1 }), point({ probability: 0.9, outcome: 0 })];
  // média prevista 0,9; frequência observada 0,5.
  assert.equal(bias(points, AGENT)?.toFixed(4), '0.4000');
});

test('os baldes de calibração são a escala declarada, não decis da amostra', () => {
  const points = [
    point({ probability: 0.72, outcome: 1 }),
    point({ probability: 0.78, outcome: 0 }),
    point({ probability: 0.31, outcome: 0 }),
  ];

  const buckets = reliabilityBuckets(points, AGENT);
  // Baldes vazios não entram: dez linhas com sete zeradas fingem cobertura.
  assert.equal(buckets.length, 2);

  const seventies = buckets.find((b) => b.from.toFixed(1) === '0.7');
  assert.equal(seventies?.n, 2);
  assert.equal(seventies?.meanPredicted.toFixed(2), '0.75');
  assert.equal(seventies?.observedRate, 0.5);
});

test('p = 1,0 cai no último balde em vez de sumir da calibração', () => {
  // Sem o clamp, Math.floor(1/0.1) = 10, índice inexistente, e o ponto some sem
  // erro nenhum — a calibração ficaria certa e incompleta.
  const buckets = reliabilityBuckets([point({ probability: 1, outcome: 1 })], AGENT);
  assert.equal(buckets.length, 1);
  assert.equal(buckets[0]?.n, 1);
  assert.equal(buckets[0]?.to, 1);
});

test('ECE é a distância média entre dito e observado, ponderada pelo balde', () => {
  const points = [
    // balde 0.8–0.9: 2 pontos, previsto 0,8, observado 0,5 → gap 0,3
    point({ probability: 0.8, outcome: 1 }),
    point({ probability: 0.8, outcome: 0 }),
    // balde 0.2–0.3: 1 ponto, previsto 0,2, observado 0 → gap 0,2
    point({ probability: 0.2, outcome: 0 }),
  ];
  // (2 * 0,3 + 1 * 0,2) / 3 = 0,266...
  assert.equal(calibrationError(reliabilityBuckets(points, AGENT))?.toFixed(4), '0.2667');
});

test('a identidade de Murphy fecha: Brier = confiabilidade - resolução + incerteza', () => {
  // É o teste que protege a decomposição inteira: se os baldes não forem os
  // mesmos usados no Brier, a soma não bate.
  const points = [
    point({ probability: 0.85, outcome: 1 }),
    point({ probability: 0.85, outcome: 1 }),
    point({ probability: 0.85, outcome: 0 }),
    point({ probability: 0.25, outcome: 0 }),
    point({ probability: 0.25, outcome: 0 }),
    point({ probability: 0.45, outcome: 1 }),
  ];

  const murphy = murphyDecomposition(points, AGENT);
  const brier = brierScore(points, AGENT);
  assert.ok(murphy !== null && brier !== null);

  const rebuilt = murphy.reliability - murphy.resolution + murphy.uncertainty;
  assert.ok(Math.abs(rebuilt - brier) < 1e-12, `identidade não fecha: ${rebuilt} vs ${brier}`);
});

test('agente que responde a frequência-base é calibrado e não resolve nada', () => {
  // O modo de falha silencioso: Brier aceitável, calibração perfeita, inútil.
  const points = [
    point({ probability: 0.5, outcome: 1 }),
    point({ probability: 0.5, outcome: 0 }),
    point({ probability: 0.5, outcome: 1 }),
    point({ probability: 0.5, outcome: 0 }),
  ];

  const murphy = murphyDecomposition(points, AGENT);
  assert.equal(murphy?.reliability, 0);
  assert.equal(murphy?.resolution, 0);
  assert.equal(murphy?.uncertainty, 0.25);
});

// ---------------------------------------------------------------------------
// Recortes
// ---------------------------------------------------------------------------

test('o recorte compara os três previsores sobre a MESMA amostra', () => {
  const points = [
    point({ checkpointMinutes: 360, probability: 0.9, marketMid: 0.6, outcome: 1 }),
    point({ checkpointMinutes: 360, probability: 0.9, marketMid: null, outcome: 0 }),
    point({ checkpointMinutes: 60, probability: 0.4, marketMid: 0.5, outcome: 0 }),
  ];

  const rows = cut(points, (p) => `T-${p.checkpointMinutes}min`);
  const t6 = rows.find((r) => r.label === 'T-360min');

  // O ponto sem preço sai do grupo inteiro, não só da coluna do mercado — senão
  // as colunas da mesma linha falariam de amostras diferentes.
  assert.equal(t6?.n, 1);
  assert.equal(t6?.agent?.toFixed(4), '0.0100');
  assert.equal(t6?.market?.toFixed(4), '0.1600');
  assert.equal(t6?.coin, 0.25);
});

test('faixa de liquidez inclui o piso e trata ausência como faixa própria', () => {
  assert.equal(liquidityBand(null), 'sem liquidez');
  assert.equal(liquidityBand(0), '< 5k');
  assert.equal(liquidityBand(4_999), '< 5k');
  assert.equal(liquidityBand(5_000), '5k-20k');
  assert.equal(liquidityBand(20_000), '20k-100k');
  assert.equal(liquidityBand(100_000), '>= 100k');
  assert.equal(liquidityBand(1_000_000), '>= 100k');
});

// ---------------------------------------------------------------------------
// Orientação — a parte que inverte o eval inteiro se estiver errada
// ---------------------------------------------------------------------------

const NAVI = '11111111-1111-1111-1111-111111111111';
const FAZE = '22222222-2222-2222-2222-222222222222';
const G2 = '33333333-3333-3333-3333-333333333333';

const RESOLVED_AT = '2026-08-06T20:15:00.000Z';

test('o desfecho é do ponto de vista do time A da ANÁLISE', () => {
  assert.deepEqual(
    resolveOutcome(NAVI, {
      teamAId: NAVI,
      teamBId: FAZE,
      winnerTeamId: NAVI,
      resolvedAt: RESOLVED_AT,
    }),
    { outcome: 1 },
  );
  assert.deepEqual(
    resolveOutcome(NAVI, {
      teamAId: NAVI,
      teamBId: FAZE,
      winnerTeamId: FAZE,
      resolvedAt: RESOLVED_AT,
    }),
    { outcome: 0 },
  );
});

test('lados trocados na partida depois da análise não invertem o desfecho', () => {
  // O recompute semanal do resolver pode reescrever team_a_id/team_b_id. A conta
  // é contra o team_a_id que a ANÁLISE gravou; comparar com o lado A de hoje
  // trocaria o sinal de toda análise anterior à troca.
  assert.deepEqual(
    resolveOutcome(NAVI, {
      teamAId: FAZE,
      teamBId: NAVI,
      winnerTeamId: NAVI,
      resolvedAt: RESOLVED_AT,
    }),
    { outcome: 1 },
  );
});

test('void e "ainda sem desfecho" são exclusões DIFERENTES', () => {
  // O par (winner_team_id, resolved_at) é o que separa os dois, e a diferença
  // não é cosmética: void nunca vai entrar na amostra, pendente vai.
  assert.deepEqual(
    resolveOutcome(NAVI, {
      teamAId: NAVI,
      teamBId: FAZE,
      winnerTeamId: null,
      resolvedAt: RESOLVED_AT,
    }),
    { excluded: 'partida_void' },
  );
  assert.deepEqual(
    resolveOutcome(NAVI, { teamAId: NAVI, teamBId: FAZE, winnerTeamId: null, resolvedAt: null }),
    { excluded: 'sem_desfecho' },
  );
});

test('sem lado ou com lado incoerente, o ponto sai da amostra', () => {
  assert.deepEqual(
    resolveOutcome(null, {
      teamAId: NAVI,
      teamBId: FAZE,
      winnerTeamId: NAVI,
      resolvedAt: RESOLVED_AT,
    }),
    { excluded: 'analise_sem_lado' },
  );
  // A análise aponta para um time que não é lado desta partida: adivinhar aqui
  // inverteria o sinal, então não se adivinha.
  assert.deepEqual(
    resolveOutcome(G2, {
      teamAId: NAVI,
      teamBId: FAZE,
      winnerTeamId: NAVI,
      resolvedAt: RESOLVED_AT,
    }),
    { excluded: 'lado_incoerente' },
  );
  // Vencedor que não é nenhum dos dois lados.
  assert.deepEqual(
    resolveOutcome(NAVI, {
      teamAId: NAVI,
      teamBId: FAZE,
      winnerTeamId: G2,
      resolvedAt: RESOLVED_AT,
    }),
    { excluded: 'lado_incoerente' },
  );
  // Partida com os dois lados iguais daria desfecho 1 sempre.
  assert.deepEqual(
    resolveOutcome(NAVI, {
      teamAId: NAVI,
      teamBId: NAVI,
      winnerTeamId: NAVI,
      resolvedAt: RESOLVED_AT,
    }),
    { excluded: 'lado_incoerente' },
  );
});
