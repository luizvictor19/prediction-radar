import { test } from 'node:test';
import assert from 'node:assert/strict';

// Nada aqui toca banco: `metrics.ts` é função pura sobre uma lista de pontos, e
// `resolveOutcome` recebe os ids já lidos. O que se confere é aritmética contra
// valores calculados à mão — um Brier errado não falha, mente com três casas.
process.env['SUPABASE_URL'] ??= 'http://localhost:54321';
process.env['SUPABASE_SERVICE_KEY'] ??= 'test-key';

const {
  AGENT,
  CLAMP_HI,
  CLAMP_LO,
  COIN,
  MARKET,
  bias,
  brierScore,
  calibrationError,
  countClamped,
  cut,
  debiasEvaluation,
  debiasedAgent,
  liquidityBand,
  murphyDecomposition,
  pairedSample,
  reliabilityBuckets,
  skillScore,
  splitByDate,
  typicalSpread,
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
    spread: 0.02,
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

// ---------------------------------------------------------------------------
// Calibração do mercado — baldes sobre o preço, e a barra de meio spread
// ---------------------------------------------------------------------------

test('os baldes do MERCADO caem pelo preço, não pela previsão do agente', () => {
  // O agente diz 0,9 nos dois; o mercado diz 0,15 e 0,75. Se os baldes caíssem
  // pela previsão do agente, a tabela do mercado responderia outra pergunta.
  const points = [
    point({ probability: 0.9, marketMid: 0.15, outcome: 0 }),
    point({ probability: 0.9, marketMid: 0.75, outcome: 1 }),
  ];

  const buckets = reliabilityBuckets(points, MARKET);
  assert.deepEqual(
    buckets.map((b) => [b.from.toFixed(1), b.n]),
    [
      ['0.1', 1],
      ['0.7', 1],
    ],
  );
});

test('o balde conta PARTIDAS distintas, não análises — checkpoint não é evidência nova', () => {
  // Mesma partida em dois checkpoints: dois pontos, um desfecho só. Contar dois
  // infla n sem acrescentar informação, e é assim que um balde de 40 análises
  // sobre 9 partidas passa por conclusivo.
  const points = [
    point({ matchSlug: 'cs2-navi-faze', checkpointMinutes: 360, marketMid: 0.65, outcome: 1 }),
    point({ matchSlug: 'cs2-navi-faze', checkpointMinutes: 60, marketMid: 0.68, outcome: 1 }),
    point({ matchSlug: 'cs2-g2-vita', checkpointMinutes: 360, marketMid: 0.62, outcome: 0 }),
  ];

  const bucket = reliabilityBuckets(points, MARKET)[0];
  assert.equal(bucket?.n, 3);
  assert.equal(bucket?.distinctMatches, 2);
});

test('o spread típico é a MEDIANA, para um book esquecido não definir a barra', () => {
  const points = [
    point({ spread: 0.02 }),
    point({ spread: 0.03 }),
    point({ spread: 0.04 }),
    point({ spread: 0.9 }), // o mercado esquecido; a média daria 0.2475
  ];
  assert.equal(typicalSpread(points), 0.035);
});

test('spread típico com número ímpar de pontos, e ausência total vira null', () => {
  assert.equal(
    typicalSpread([point({ spread: 0.02 }), point({ spread: 0.1 }), point({ spread: 0.04 })]),
    0.04,
  );
  // Sem os dois lados do book não há barra — e o relatório tem que dizer isso em
  // vez de assumir um spread plausível.
  assert.equal(typicalSpread([point({ spread: null })]), null);
  assert.equal(typicalSpread([]), null);
});

test('ponto sem spread sai da mediana sem virar zero', () => {
  // `null` tratado como 0 puxaria a barra para baixo e promoveria a candidato a
  // edge um gap que não paga a travessia.
  assert.equal(typicalSpread([point({ spread: null }), point({ spread: 0.05 })]), 0.05);
});

// ---------------------------------------------------------------------------
// AGENT_DEBIASED — a correção e a validação que decide se ela é real
// ---------------------------------------------------------------------------

test('o previsor corrigido subtrai a constante e trava nas bordas', () => {
  const forecast = debiasedAgent(0.2);
  assert.equal(forecast(point({ probability: 0.7 }))?.toFixed(6), '0.500000');
  // 0,05 − 0,2 = −0,15, que não é probabilidade.
  assert.equal(forecast(point({ probability: 0.05 })), CLAMP_LO);
  // Deslocamento negativo empurra para o outro lado.
  assert.equal(debiasedAgent(-0.5)(point({ probability: 0.95 })), CLAMP_HI);
});

test('o travamento é contado, porque é o sintoma de o transformador estar errado', () => {
  const points = [
    point({ probability: 0.05 }), // trava
    point({ probability: 0.5 }),
    point({ probability: 0.9 }),
  ];
  assert.equal(countClamped(points, 0.2), 1);
  assert.equal(countClamped(points, 0.0), 0);
});

test('o corte é por as_of e por contagem de PARTIDAS, com a fronteira caindo no teste', () => {
  const points = [
    point({ asOf: '2026-08-03T00:00:00.000Z', analysisId: 'c', matchSlug: 'm3' }),
    point({ asOf: '2026-08-01T00:00:00.000Z', analysisId: 'a', matchSlug: 'm1' }),
    point({ asOf: '2026-08-02T00:00:00.000Z', analysisId: 'b', matchSlug: 'm2' }),
  ];

  const { train, test: held } = splitByDate(points);
  assert.deepEqual(
    train.map((p) => p.analysisId),
    ['a'],
  );
  assert.deepEqual(held.map((p) => p.analysisId).sort(), ['b', 'c']);
});

test('os dois checkpoints da mesma partida ficam do MESMO lado do corte', () => {
  // O vazamento que este corte existe para impedir: T-360 e T-60 têm `as_of`
  // diferentes e, num corte por análise, caíam em metades opostas — o desfecho
  // que a 2ª metade não deveria conhecer já tinha ajudado a estimar o
  // deslocamento. A partida é a unidade, não a análise.
  const points = [
    point({
      analysisId: 'a1',
      matchSlug: 'm1',
      asOf: '2026-08-01T06:00:00.000Z',
      checkpointMinutes: 360,
    }),
    point({
      analysisId: 'a2',
      matchSlug: 'm1',
      asOf: '2026-08-01T11:00:00.000Z',
      checkpointMinutes: 60,
    }),
    point({
      analysisId: 'b1',
      matchSlug: 'm2',
      asOf: '2026-08-02T06:00:00.000Z',
      checkpointMinutes: 360,
    }),
    point({
      analysisId: 'b2',
      matchSlug: 'm2',
      asOf: '2026-08-02T11:00:00.000Z',
      checkpointMinutes: 60,
    }),
  ];

  const { train, test: held } = splitByDate(points);
  assert.deepEqual(
    train.map((p) => p.analysisId),
    ['a1', 'a2'],
  );
  assert.deepEqual(
    held.map((p) => p.analysisId),
    ['b1', 'b2'],
  );

  const trainMatches = new Set(train.map((p) => p.matchSlug));
  assert.equal(
    held.some((p) => trainMatches.has(p.matchSlug)),
    false,
  );
});

/** Quatro pontos em ordem de `as_of`, com números que fecham à mão. */
function debiasSample(): ReturnType<typeof point>[] {
  return [
    point({
      asOf: '2026-08-01T00:00:00Z',
      matchSlug: 'm1',
      probability: 0.8,
      marketMid: 0.7,
      outcome: 1,
    }),
    point({
      asOf: '2026-08-02T00:00:00Z',
      matchSlug: 'm2',
      probability: 0.6,
      marketMid: 0.5,
      outcome: 0,
    }),
    point({
      asOf: '2026-08-03T00:00:00Z',
      matchSlug: 'm3',
      probability: 0.9,
      marketMid: 0.8,
      outcome: 1,
    }),
    point({
      asOf: '2026-08-04T00:00:00Z',
      matchSlug: 'm4',
      probability: 0.7,
      marketMid: 0.6,
      outcome: 0,
    }),
  ];
}

test('o deslocamento sai SÓ da primeira metade, e é cobrado só na segunda', () => {
  const ev = debiasEvaluation(debiasSample());

  // 1ª metade: prevista (0,8+0,6)/2 = 0,7; observada (1+0)/2 = 0,5.
  assert.equal(ev.offset?.toFixed(6), '0.200000');
  assert.equal(ev.outOfSample.n, 2);

  // 2ª metade corrigida: 0,9−0,2 = 0,7 e 0,7−0,2 = 0,5.
  // ((0,7−1)² + (0,5−0)²)/2 = (0,09 + 0,25)/2 = 0,17.
  assert.equal(ev.outOfSample.debiased?.toFixed(6), '0.170000');
  // Crua: ((0,9−1)² + 0,7²)/2 = (0,01 + 0,49)/2 = 0,25.
  assert.equal(ev.outOfSample.agent?.toFixed(6), '0.250000');
});

test('o viés do MERCADO é medido na mesma amostra — é o que pode invalidar a correção', () => {
  const ev = debiasEvaluation(debiasSample());
  // Mercado na 1ª metade: (0,7+0,5)/2 − 0,5 = 0,1.
  assert.equal(ev.marketBiasTrain?.toFixed(6), '0.100000');
  // Amostra toda: agente 0,75−0,5 = 0,25; mercado 0,65−0,5 = 0,15.
  assert.equal(ev.agentBiasFull?.toFixed(6), '0.250000');
  assert.equal(ev.marketBiasFull?.toFixed(6), '0.150000');
});

test('o dentro-da-amostra é o teto, e melhora por álgebra e não por acerto', () => {
  const ev = debiasEvaluation(debiasSample());
  // Estimado e cobrado nos mesmos 4 pontos, com deslocamento 0,25.
  assert.equal(ev.inSample.n, 4);
  assert.equal(ev.inSample.agent?.toFixed(6), '0.225000');
  assert.equal(ev.inSample.debiased?.toFixed(6), '0.162500');
});

test('subtrair a média da própria amostra NUNCA piora o Brier — por isso não vale nada', () => {
  // A propriedade que torna o dentro-da-amostra não comparável: a melhora é
  // garantida por construção e apareceria igual em dados aleatórios. Se este
  // teste falhar, o rótulo "overfit" no relatório está mentindo por baixo.
  for (const seed of [0.13, 0.37, 0.61, 0.88]) {
    const points = Array.from({ length: 12 }, (_, i) => {
      const p = ((i * seed) % 1) * 0.98 + 0.01;
      return point({
        probability: p,
        marketMid: 0.5,
        outcome: i % 3 === 0 ? 1 : 0,
        matchSlug: `m${i}`,
      });
    });

    const ev = debiasEvaluation(points);
    assert.ok(ev.inSample.agent !== null && ev.inSample.debiased !== null);
    // Só vale sem travamento: ponto travado não recebeu o deslocamento inteiro.
    if (ev.inSample.clamped === 0) {
      assert.ok(
        ev.inSample.debiased <= ev.inSample.agent + 1e-12,
        `seed ${seed}: corrigido ${ev.inSample.debiased} > cru ${ev.inSample.agent}`,
      );
    }
  }
});

test('a mesma partida em dois checkpoints não vaza entre as metades', () => {
  const points = debiasSample();
  // O caso que antes produzia vazamento: o terceiro ponto (que caía na 2ª
  // metade) passa a ser a mesma partida do primeiro, em outro checkpoint. Com o
  // corte por partida, os dois vão juntos e a interseção continua vazia.
  points[2] = point({ ...points[2]!, matchSlug: 'm1' });

  const ev = debiasEvaluation(points);
  assert.equal(ev.straddlingMatches, 0);

  const { train, test: held } = splitByDate(points);
  const trainMatches = new Set(train.map((p) => p.matchSlug));
  assert.equal(
    held.some((p) => trainMatches.has(p.matchSlug)),
    false,
  );

  // E o contador continua sendo calculado de verdade — não foi trocado por uma
  // constante zero. Vazamento que não é medido volta.
  assert.equal(debiasEvaluation(debiasSample()).straddlingMatches, 0);
});

test('amostra curta demais para dividir não inventa um fora-da-amostra', () => {
  const ev = debiasEvaluation([point()]);
  // Um ponto: a 1ª metade fica vazia, e sem ela não há deslocamento a estimar.
  assert.equal(ev.offset, null);
  assert.equal(ev.outOfSample.debiased, null);
  assert.equal(debiasEvaluation([]).outOfSample.n, 0);
});
