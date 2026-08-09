import { test } from 'node:test';
import assert from 'node:assert/strict';

// O módulo importa o cliente do Supabase no topo. Criar o cliente não abre
// conexão — tudo testado aqui é puro: a leitura do desfecho, a aritmética da
// calibração e a montagem dos fragmentos, que é onde as decisões moram.
process.env['SUPABASE_URL'] ??= 'http://localhost:54321';
process.env['SUPABASE_SERVICE_KEY'] ??= 'test-key';

const {
  verdictFor,
  tallyFor,
  bandOf,
  calibrate,
  labelFor,
  shouldSkip,
  buildH2hFragment,
  buildFormFragment,
  buildCalibrationFragment,
  MATCH_HISTORY_ID,
  MIN_CALIBRATION_SAMPLE,
  FAVORITE_THRESHOLD,
  UNDERDOG_THRESHOLD,
} = await import('./match-history.js');

type PastMatch = Parameters<typeof verdictFor>[0];
type PricedObservation = Parameters<typeof calibrate>[0][number];

const TEAM_A = '11111111-1111-4111-8111-111111111111';
const TEAM_B = '22222222-2222-4222-8222-222222222222';
const TEAM_C = '33333333-3333-4333-8333-333333333333';

const A = { teamId: TEAM_A, name: 'FaZe' };
const B = { teamId: TEAM_B, name: 'Natus Vincere' };

/** Média e Brier são somas de floats. Comparar por igualdade exata testa o IEEE 754, não o código. */
function close(actual: number | null, expected: number): void {
  assert.ok(
    actual !== null && Math.abs(actual - expected) < 1e-12,
    `esperava ~${expected}, veio ${actual}`,
  );
}

let seq = 0;

function past(overrides: Partial<PastMatch> = {}): PastMatch {
  seq++;
  return {
    matchId: `match-${seq}`,
    matchSlug: `cs2-faze-navi-2026-06-${String(seq).padStart(2, '0')}`,
    teamAId: TEAM_A,
    teamBId: TEAM_B,
    winnerTeamId: TEAM_A,
    resolvedAt: `2026-06-${String(seq).padStart(2, '0')}T20:00:00.000Z`,
    scheduledAt: `2026-06-${String(seq).padStart(2, '0')}T18:00:00.000Z`,
    bestOf: 3,
    stage: 'Playoffs',
    leagueTier: '1',
    needsReview: false,
    ...overrides,
  };
}

function observation(overrides: Partial<PricedObservation> = {}): PricedObservation {
  return {
    matchId: 'match-x',
    matchSlug: null,
    teamId: TEAM_A,
    price: 0.7,
    capturedAt: '2026-06-01T17:55:00.000Z',
    lagSeconds: 300,
    resolvedAt: '2026-06-01T20:00:00.000Z',
    verdict: 'win',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// O desfecho, e o void como estado de primeira classe
// ---------------------------------------------------------------------------

test('vencedor ausente é void, e não derrota', () => {
  // O par (winner nulo, resolved_at presente) é VOID, não pendência — a leitura
  // que a migration 20260807182110 registra. Contar como derrota inverteria o
  // saldo de todo time que já teve partida anulada.
  assert.equal(verdictFor(past({ winnerTeamId: null }), TEAM_A), 'void');
  assert.equal(verdictFor(past({ winnerTeamId: TEAM_A }), TEAM_A), 'win');
  assert.equal(verdictFor(past({ winnerTeamId: TEAM_B }), TEAM_A), 'loss');
});

test('vencedor que não é este time é derrota mesmo com o outro lado sem id', () => {
  // O histórico vindo só do slug tem `team_b_id` nulo. O CHECK
  // `esports_matches_winner_is_a_side` garante que o vencedor é um dos dois
  // lados, então "não é este" só pode ser o outro.
  const match = past({ teamBId: null, winnerTeamId: TEAM_C });
  assert.equal(verdictFor(match, TEAM_A), 'loss');
});

test('a contagem separa vitória, derrota e void', () => {
  const matches = [
    past({ winnerTeamId: TEAM_A }),
    past({ winnerTeamId: TEAM_A }),
    past({ winnerTeamId: TEAM_B }),
    past({ winnerTeamId: null }),
  ];

  assert.deepEqual(tallyFor(matches, TEAM_A), { wins: 2, losses: 1, voids: 1 });
  assert.deepEqual(tallyFor(matches, TEAM_B), { wins: 1, losses: 2, voids: 1 });
});

// ---------------------------------------------------------------------------
// A faixa de favorito
// ---------------------------------------------------------------------------

test('a faixa central é pickem, e não favorito por um centésimo', () => {
  assert.equal(bandOf(0.51), 'pickem');
  assert.equal(bandOf(0.49), 'pickem');
  assert.equal(bandOf(FAVORITE_THRESHOLD), 'favorite');
  assert.equal(bandOf(UNDERDOG_THRESHOLD), 'underdog');
  assert.equal(bandOf(0.9), 'favorite');
  assert.equal(bandOf(0.1), 'underdog');
});

// ---------------------------------------------------------------------------
// A calibração
// ---------------------------------------------------------------------------

test('favorito que perde entra na conta do balde certo', () => {
  const result = calibrate([
    observation({ price: 0.8, verdict: 'win' }),
    observation({ price: 0.7, verdict: 'win' }),
    observation({ price: 0.6, verdict: 'loss' }),
    observation({ price: 0.3, verdict: 'loss' }),
    observation({ price: 0.5, verdict: 'win' }),
  ]);

  assert.equal(result.n, 5);
  assert.equal(result.favorite?.n, 3);
  assert.equal(result.favorite?.wins, 2);
  close(result.favorite?.avgPrice ?? null, 0.7);
  assert.deepEqual(result.underdog, { n: 1, wins: 0, avgPrice: 0.3 });
  assert.deepEqual(result.pickem, { n: 1, wins: 1, avgPrice: 0.5 });
});

test('o Brier é o do mercado, e a moeda justa vale 0,25', () => {
  const coin = calibrate([
    observation({ price: 0.5, verdict: 'win' }),
    observation({ price: 0.5, verdict: 'loss' }),
  ]);
  assert.equal(coin.brier, 0.25);

  // Mercado perfeito: 1,0 no que venceu, 0,0 no que perdeu.
  const perfect = calibrate([
    observation({ price: 1, verdict: 'win' }),
    observation({ price: 0, verdict: 'loss' }),
  ]);
  assert.equal(perfect.brier, 0);
});

test('o confronto direto conta duas vezes e não enviesa o Brier', () => {
  // O mesmo jogo visto pelos dois lados: p e 1−p, com desfechos opostos.
  // (p − y)² = ((1−p) − (1−y))², então as duas entradas carregam o MESMO erro.
  // O peso dobra — que é o desejado — mas o número não se desloca.
  const oneSide = calibrate([observation({ price: 0.7, verdict: 'win' })]);
  const bothSides = calibrate([
    observation({ price: 0.7, verdict: 'win' }),
    observation({ teamId: TEAM_B, price: 0.3, verdict: 'loss' }),
  ]);

  close(bothSides.brier, oneSide.brier ?? Number.NaN);
});

test('sem observação não há Brier — é ausência de dado, não zero', () => {
  const empty = calibrate([]);
  assert.equal(empty.n, 0);
  assert.equal(empty.brier, null);
  assert.equal(empty.favorite, null);
});

// ---------------------------------------------------------------------------
// O rótulo do lado no moneyline
// ---------------------------------------------------------------------------

test('o lado B é o outro índice, e só em mercado binário', () => {
  const match = past();

  assert.equal(labelFor(match, TEAM_A, 0, ['FaZe', 'NAVI']), 'FaZe');
  assert.equal(labelFor(match, TEAM_B, 0, ['FaZe', 'NAVI']), 'NAVI');
  // Markets irmãos aparecem com os outcomes em ordens diferentes: medido, 19 de
  // 79 eventos. O índice é por market, e inverter os lados inverteria o preço.
  assert.equal(labelFor(match, TEAM_A, 1, ['FaZe', 'NAVI']), 'NAVI');
  assert.equal(labelFor(match, TEAM_B, 1, ['FaZe', 'NAVI']), 'FaZe');

  // Time que não é lado desta partida não tem rótulo aqui.
  assert.equal(labelFor(match, TEAM_C, 0, ['FaZe', 'NAVI']), null);
  // Três resultados: "o outro índice" deixa de ter sentido.
  assert.equal(labelFor(match, TEAM_B, 0, ['A', 'B', 'C']), null);
});

// ---------------------------------------------------------------------------
// A cadência própria
// ---------------------------------------------------------------------------

test('regrava quando uma partida nova resolveu, mesmo dentro do TTL', () => {
  const stamp = new Date('2026-06-10T20:00:00.000Z');
  const previous = {
    asOf: new Date('2026-06-08T20:00:00.000Z'),
    observedAt: new Date('2026-06-10T21:00:00.000Z'),
  };

  assert.equal(shouldSkip(previous, stamp, new Date('2026-06-10T21:30:00.000Z'), 6 * 3600), false);
});

test('suprime a linha idêntica, mas só até o TTL vencer', () => {
  const stamp = new Date('2026-06-10T20:00:00.000Z');
  const previous = { asOf: stamp, observedAt: new Date('2026-06-10T21:00:00.000Z') };

  // Nada resolveu e a observação é recente: regravar produziria linha idêntica.
  assert.equal(shouldSkip(previous, stamp, new Date('2026-06-10T23:00:00.000Z'), 6 * 3600), true);

  // Passadas as 6h, reobserva — é o que mantém o fragmento dentro das 200 linhas
  // que o analista lê perto do início da partida.
  assert.equal(shouldSkip(previous, stamp, new Date('2026-06-11T04:00:00.000Z'), 6 * 3600), false);
});

test('sem fragmento anterior, sempre grava', () => {
  assert.equal(shouldSkip(null, new Date('2026-06-10T20:00:00.000Z'), new Date(), 6 * 3600), false);
});

// ---------------------------------------------------------------------------
// Os fragmentos
// ---------------------------------------------------------------------------

test('o as_of do h2h é o desfecho mais recente, nunca o agora do ciclo', () => {
  const matches = [
    past({ resolvedAt: '2026-06-14T22:00:00.000Z', winnerTeamId: TEAM_B }),
    past({ resolvedAt: '2026-03-02T22:00:00.000Z', winnerTeamId: TEAM_A }),
  ];

  const fragment = buildH2hFragment({ teamA: A, teamB: B, matches });
  assert.ok(fragment !== null);

  // A afirmação "1-1 no confronto" passou a valer quando a partida de junho
  // resolveu. Carimbar o agora leria uma contagem antiga como notícia de hoje.
  assert.equal(fragment.asOf.toISOString(), '2026-06-14T22:00:00.000Z');
  assert.equal(fragment.kind, 'h2h');
  assert.equal(fragment.enricherId, MATCH_HISTORY_ID);
  assert.match(fragment.summary, /1-1 para FaZe/);
  assert.match(fragment.summary, /vitória de Natus Vincere/);
  // A ressalva de cobertura vai no TEXTO, que é o que o LLM lê.
  assert.match(fragment.summary, /mercado listado na Polymarket/);
});

test('h2h sem confronto anterior não vira fragmento vazio', () => {
  assert.equal(buildH2hFragment({ teamA: A, teamB: B, matches: [] }), null);
});

test('o void aparece no h2h sem contaminar o saldo', () => {
  const matches = [
    past({ resolvedAt: '2026-06-14T22:00:00.000Z', winnerTeamId: null }),
    past({ resolvedAt: '2026-05-01T22:00:00.000Z', winnerTeamId: TEAM_A }),
  ];

  const fragment = buildH2hFragment({ teamA: A, teamB: B, matches });
  assert.ok(fragment !== null);
  assert.match(fragment.summary, /1-0 para FaZe/);
  assert.match(fragment.summary, /1 sem vencedor/);
  assert.match(fragment.summary, /resolveu sem vencedor/);
});

test('a forma sai num fragmento só, porque o analista lê o último por kind', () => {
  // `latestPerKind` no analista fica com o primeiro `enricherId|kind` que
  // encontra. Dois fragmentos `form`, um por time, fariam o segundo time sumir
  // do prompt sem nenhum sintoma.
  const names = new Map([
    [TEAM_A, 'FaZe'],
    [TEAM_B, 'Natus Vincere'],
    [TEAM_C, 'Vitality'],
  ]);

  const fragment = buildFormFragment({
    sides: [
      {
        team: A,
        matches: [past({ teamBId: TEAM_C, resolvedAt: '2026-06-20T22:00:00.000Z' })],
      },
      {
        team: B,
        matches: [
          past({
            teamAId: TEAM_B,
            teamBId: TEAM_C,
            winnerTeamId: TEAM_C,
            resolvedAt: '2026-06-18T22:00:00.000Z',
          }),
        ],
      },
    ],
    names,
  });

  assert.ok(fragment !== null);
  assert.equal(fragment.kind, 'form');
  assert.match(fragment.summary, /FaZe 1V-0D/);
  assert.match(fragment.summary, /Natus Vincere 0V-1D/);
  assert.match(fragment.summary, /V vs Vitality/);
  assert.match(fragment.summary, /D vs Vitality/);
  // O mais recente entre os dois lados.
  assert.equal(fragment.asOf.toISOString(), '2026-06-20T22:00:00.000Z');
});

test('lado sem partida passada não zera o fragmento do outro', () => {
  const fragment = buildFormFragment({
    sides: [
      {
        team: A,
        matches: [past({ teamBId: TEAM_C, resolvedAt: '2026-06-20T22:00:00.000Z' })],
      },
      { team: B, matches: [] },
    ],
    names: new Map([
      [TEAM_A, 'FaZe'],
      [TEAM_C, 'Vitality'],
    ]),
  });

  assert.ok(fragment !== null);
  assert.match(fragment.summary, /FaZe 1V-0D/);
  // O lado sem partida some do texto em vez de virar "0V-0D nas últimas 0", que
  // seria lido como time que não joga há meses.
  assert.doesNotMatch(fragment.summary, /Natus Vincere/);

  const teams = (fragment.payload as Record<string, unknown>)['teams'] as unknown[];
  assert.equal(teams.length, 1);
});

test('amostra abaixo do piso não vira fragmento de calibração', () => {
  const sides = [
    {
      team: A,
      observations: Array.from({ length: MIN_CALIBRATION_SAMPLE - 1 }, () => observation()),
    },
    { team: B, observations: [] },
  ];

  assert.equal(buildCalibrationFragment({ sides, withoutPrice: 9, truncated: false }), null);
});

test('a calibração diz quantas vezes o favorito acertou, e com que amostra', () => {
  const fragment = buildCalibrationFragment({
    sides: [
      {
        team: A,
        observations: [
          observation({ price: 0.8, verdict: 'win', resolvedAt: '2026-06-01T20:00:00.000Z' }),
          observation({ price: 0.7, verdict: 'loss', resolvedAt: '2026-06-05T20:00:00.000Z' }),
          observation({ price: 0.6, verdict: 'win', resolvedAt: '2026-06-09T20:00:00.000Z' }),
        ],
      },
      {
        team: B,
        observations: [
          observation({
            teamId: TEAM_B,
            price: 0.3,
            verdict: 'loss',
            resolvedAt: '2026-06-11T20:00:00.000Z',
          }),
        ],
      },
    ],
    withoutPrice: 12,
    truncated: false,
  });

  assert.ok(fragment !== null);
  assert.equal(fragment.kind, 'market_calibration');
  assert.equal(fragment.asOf.toISOString(), '2026-06-11T20:00:00.000Z');
  assert.match(fragment.summary, /FaZe foi favorito em 3/);
  assert.match(fragment.summary, /venceu 2/);
  assert.match(fragment.summary, /Natus Vincere foi azarão em 1/);
  assert.match(fragment.summary, /Brier do mercado no conjunto/);
  // Amostra pequena entra com a confiança de amostra pequena.
  assert.equal(fragment.confidence, 0.5);

  const payload = fragment.payload as Record<string, unknown>;
  assert.equal(payload['without_price'], 12);
  assert.equal(payload['truncated'], false);
});

test('amostra maior sobe a confiança, e o payload guarda o preço de cada partida', () => {
  const observations = Array.from({ length: 10 }, (_, i) =>
    observation({
      matchId: `m-${i}`,
      price: 0.6 + i * 0.01,
      verdict: i % 2 === 0 ? 'win' : 'loss',
      resolvedAt: `2026-06-${String(i + 1).padStart(2, '0')}T20:00:00.000Z`,
    }),
  );

  const fragment = buildCalibrationFragment({
    sides: [
      { team: A, observations },
      { team: B, observations: [] },
    ],
    withoutPrice: 0,
    truncated: true,
  });

  assert.ok(fragment !== null);
  assert.equal(fragment.confidence, 0.8);

  const payload = fragment.payload as Record<string, unknown>;
  const teams = payload['teams'] as Array<Record<string, unknown>>;
  const first = (teams[0]?.['observations'] as Array<Record<string, unknown>>)[0];

  assert.equal(first?.['band'], 'favorite');
  assert.equal(first?.['result'], 'win');
  // O atraso entre o snapshot e o início fica gravado: quem lê decide se um
  // fechamento de horas antes ainda é um fechamento.
  assert.equal(first?.['lag_seconds'], 300);
});
