import { test } from 'node:test';
import assert from 'node:assert/strict';

/**
 * A montagem do dataset market-cêntrico, sem rede.
 *
 * O que se confere aqui são as três decisões que fazem a amostra mentir se
 * saírem erradas, e que nenhuma delas falha alto:
 *
 *   1. a escolha do snapshot (vizinho mais próximo, tolerância, empate),
 *   2. o descarte quando não há snapshot na tolerância — a linha tem que SUMIR,
 *      não virar preço interpolado,
 *   3. o corte temporal por PARTIDA, para que nenhum desfecho apareça nas duas
 *      metades da comparação que existe para ser independente.
 *
 * `market-dataset.ts` importa `../lib/supabase.js`, que exige as variáveis de
 * ambiente no import — daí o mesmo preâmbulo dos outros testes do eval.
 */
process.env['SUPABASE_URL'] ??= 'http://localhost:54321';
process.env['SUPABASE_SERVICE_KEY'] ??= 'test-key';

const {
  CHECKPOINTS,
  FAVORITE,
  PRICE,
  TOLERANCE_SECONDS,
  distinctMatches,
  favoritePrice,
  oneRowPerMatch,
  pickNearest,
  spreadOf,
  splitByMatchTime,
  toFavoriteSample,
} = await import('./market-dataset.js');

const { FAVORITE_GRID, reliabilityBuckets, typicalSpread, executionBar, bucketVerdict, bucketGap } =
  await import('./metrics.js');

type MarketPoint = import('./market-dataset.js').MarketPoint;
type SnapshotRow = import('./market-dataset.js').SnapshotRow;

const T0 = Date.parse('2026-08-10T12:00:00.000Z');

function snapshot(offsetSeconds: number, overrides: Partial<SnapshotRow> = {}): SnapshotRow {
  return {
    capturedAtMs: T0 + offsetSeconds * 1000,
    mid: 0.5,
    bid: 0.49,
    ask: 0.51,
    ...overrides,
  };
}

function point(overrides: Partial<MarketPoint> = {}): MarketPoint {
  return {
    matchId: 'm1',
    matchSlug: 'cs2-navi-faze-2026-08-10',
    eventId: 'e1',
    checkpointMinutes: 60,
    scheduledAt: '2026-08-10T12:00:00.000Z',
    anchorSource: 'scheduled_at',
    targetAt: '2026-08-10T11:00:00.000Z',
    capturedAt: '2026-08-10T11:00:05.000Z',
    offsetSeconds: 5,
    price: 0.6,
    spread: 0.02,
    outcome: 1,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// A escolha do snapshot
// ---------------------------------------------------------------------------

test('pickNearest pega o vizinho mais próximo dos dois lados', () => {
  const rows = [snapshot(-200), snapshot(-40), snapshot(90)];
  assert.equal(pickNearest(rows, T0, 300_000)?.capturedAtMs, T0 - 40_000);
});

test('pickNearest devolve null quando o vizinho mais próximo está fora da tolerância', () => {
  // O ponto do método: sem snapshot na tolerância a linha é DESCARTADA. Se esta
  // função algum dia devolver o vizinho distante "porque é o que tem", o dataset
  // ganha um preço de outro instante com cara de preço do instante pedido.
  const rows = [snapshot(-600), snapshot(700)];
  assert.equal(pickNearest(rows, T0, 300_000), null);
});

test('pickNearest devolve null em janela vazia', () => {
  assert.equal(pickNearest([], T0, 300_000), null);
});

test('pickNearest aceita o snapshot exatamente na borda da tolerância', () => {
  const rows = [snapshot(300)];
  assert.equal(pickNearest(rows, T0, 300_000)?.capturedAtMs, T0 + 300_000);
});

test('pickNearest desempata para o snapshot POSTERIOR, e o faz sempre igual', () => {
  const rows = [snapshot(-60), snapshot(60)];
  const first = pickNearest(rows, T0, 300_000);
  const again = pickNearest([...rows].reverse(), T0, 300_000);

  assert.equal(first?.capturedAtMs, T0 + 60_000);
  // Determinismo é o requisito de verdade: a mesma partida não pode cair em
  // baldes diferentes entre duas rodadas por causa da ordem que o banco devolveu.
  assert.equal(again?.capturedAtMs, first?.capturedAtMs);
});

test('spreadOf exige os dois lados do book', () => {
  // `toFixed` porque 0,52 − 0,48 em ponto flutuante não é exatamente 0,04 — o
  // spread entra em mediana e comparação, nunca em igualdade exata.
  assert.equal(spreadOf(snapshot(0, { bid: 0.48, ask: 0.52 }))?.toFixed(4), '0.0400');
  assert.equal(spreadOf(snapshot(0, { bid: null })), null);
  assert.equal(spreadOf(snapshot(0, { ask: null })), null);
});

test('a tolerância declarada cobre um ciclo inteiro da cadência mais lenta', () => {
  // `watchlist_interval_far_seconds` é 300s. Tolerância menor que isso descartaria
  // linha por arredondamento de agenda, não por falta de coleta.
  assert.ok(TOLERANCE_SECONDS >= 300);
  assert.deepEqual([...CHECKPOINTS], [360, 60]);
});

// ---------------------------------------------------------------------------
// O corte temporal
// ---------------------------------------------------------------------------

test('splitByMatchTime nunca deixa uma partida atravessar o corte', () => {
  const points = [1, 2, 3, 4].flatMap((n) =>
    [360, 60].map((checkpoint) =>
      point({
        matchId: `m${n}`,
        matchSlug: `cs2-partida-${n}`,
        checkpointMinutes: checkpoint,
        scheduledAt: `2026-08-0${n}T12:00:00.000Z`,
      }),
    ),
  );

  const { older, newer } = splitByMatchTime(points);

  assert.deepEqual([...new Set(older.map((p) => p.matchId))].sort(), ['m1', 'm2']);
  assert.deepEqual([...new Set(newer.map((p) => p.matchId))].sort(), ['m3', 'm4']);

  // A garantia que importa: interseção vazia. Os dois checkpoints da mesma
  // partida dividem o mesmo desfecho — separá-los colocaria a mesma evidência dos
  // dois lados de uma comparação que só vale se os lados forem independentes.
  const olderIds = new Set(older.map((p) => p.matchId));
  assert.equal(
    newer.some((p) => olderIds.has(p.matchId)),
    false,
  );
  assert.equal(older.length + newer.length, points.length);
});

test('splitByMatchTime com número ímpar de partidas põe a do meio na metade recente', () => {
  const points = [1, 2, 3].map((n) =>
    point({ matchId: `m${n}`, scheduledAt: `2026-08-0${n}T12:00:00.000Z` }),
  );

  const { older, newer } = splitByMatchTime(points);
  assert.equal(distinctMatches(older), 1);
  assert.equal(distinctMatches(newer), 2);
});

test('splitByMatchTime é estável quando duas partidas têm o mesmo horário', () => {
  const same = '2026-08-10T12:00:00.000Z';
  const points = ['b', 'a', 'd', 'c'].map((id) => point({ matchId: id, scheduledAt: same }));

  const first = splitByMatchTime(points);
  const again = splitByMatchTime([...points].reverse());

  assert.deepEqual(
    [...new Set(first.older.map((p) => p.matchId))].sort(),
    [...new Set(again.older.map((p) => p.matchId))].sort(),
  );
});

// ---------------------------------------------------------------------------
// A ligação com a máquina de baldes do eval
// ---------------------------------------------------------------------------

test('reliabilityBuckets conta PARTIDAS distintas, não linhas, num MarketPoint', () => {
  // Os dois checkpoints da mesma partida: n = 2, partidas = 1. É a distinção que
  // decide se um balde conclui alguma coisa.
  const points = [
    point({ matchId: 'm1', matchSlug: 'cs2-a', checkpointMinutes: 360, price: 0.72 }),
    point({ matchId: 'm1', matchSlug: 'cs2-a', checkpointMinutes: 60, price: 0.75 }),
  ];

  const buckets = reliabilityBuckets(points, PRICE);
  assert.equal(buckets.length, 1);
  assert.equal(buckets[0]?.n, 2);
  assert.equal(buckets[0]?.distinctMatches, 1);
  assert.equal(buckets[0]?.observedRate, 1);
});

test('o gap e a barra saem do preço e do spread da MESMA amostra', () => {
  // Quatro partidas no balde 0,70–0,80; o time A venceu uma. Previsto 0,75,
  // observado 0,25, gap +0,50 — muito acima de meio spread de 0,02.
  const points = [1, 2, 3, 4].map((n) =>
    point({
      matchId: `m${n}`,
      matchSlug: `cs2-p${n}`,
      price: 0.75,
      spread: 0.02,
      outcome: n === 1 ? 1 : 0,
    }),
  );

  const bucket = reliabilityBuckets(points, PRICE)[0];
  assert.ok(bucket !== undefined);
  assert.equal(bucketGap(bucket).toFixed(2), '0.50');

  const bar = executionBar(typicalSpread(points));
  assert.equal(bar, 0.01);

  // E ainda assim: quatro partidas não concluem nada. A ordem das perguntas é
  // amostra primeiro, barra depois — um gap de +0,50 sobre 4 partidas é a linha
  // mais fácil de achar e a mais cara de acreditar.
  assert.equal(bucketVerdict(bucket, bar), 'nao_conclusivo');
});

test('sem spread em nenhuma linha não existe barra, e nenhum balde é candidato', () => {
  const points = Array.from({ length: 25 }, (_, i) =>
    point({ matchId: `m${i}`, matchSlug: `cs2-p${i}`, price: 0.75, spread: null, outcome: 0 }),
  );

  const bucket = reliabilityBuckets(points, PRICE)[0];
  assert.ok(bucket !== undefined);
  assert.equal(bucket.distinctMatches, 25);
  assert.equal(typicalSpread(points), null);
  assert.equal(bucketVerdict(bucket, executionBar(null)), 'sem_spread');
});

// ---------------------------------------------------------------------------
// O corte pelo preço do favorito
// ---------------------------------------------------------------------------

test('o favorito é o lado caro, e o desfecho vira junto', () => {
  // Time A a 0,30 e perdeu: o favorito é o adversário, a 0,70, e ele VENCEU.
  const azarao = favoritePrice(point({ price: 0.3, outcome: 0 }));
  assert.equal(azarao?.price.toFixed(4), '0.7000');
  assert.equal(azarao?.outcome, 1);
  assert.equal(azarao?.favoriteIsTeamA, false);

  // Time A a 0,70 e perdeu: o favorito é ele, e ele perdeu.
  const favorito = favoritePrice(point({ price: 0.7, outcome: 0 }));
  assert.equal(favorito?.price.toFixed(4), '0.7000');
  assert.equal(favorito?.outcome, 0);
  assert.equal(favorito?.favoriteIsTeamA, true);
});

test('preço exatamente 0,50 não tem favorito, e vira descarte contado', () => {
  // Escolher um lado no empate criaria uma observação cujo desfecho é moeda.
  assert.equal(favoritePrice(point({ price: 0.5 })), null);

  const { points, empates } = toFavoriteSample([point({ price: 0.5 }), point({ price: 0.8 })]);
  assert.equal(empates, 1);
  assert.equal(points.length, 1);
});

test('o rótulo do time A não muda nada no corte por favorito', () => {
  // A MESMA partida, com a convenção invertida: preço e desfecho espelhados. Se o
  // rótulo influenciasse a medida, estas duas linhas cairiam em baldes ou lados
  // diferentes — e é exatamente isso que este corte existe para impossibilitar.
  const comoA = favoritePrice(point({ price: 0.85, outcome: 1 }));
  const comoB = favoritePrice(point({ price: 0.15, outcome: 0 }));

  assert.equal(comoA?.price.toFixed(4), comoB?.price.toFixed(4));
  assert.equal(comoA?.outcome, comoB?.outcome);
});

test('oneRowPerMatch fica com o checkpoint mais próximo do jogo', () => {
  const rows = toFavoriteSample([
    point({ matchId: 'm1', checkpointMinutes: 360, price: 0.7 }),
    point({ matchId: 'm1', checkpointMinutes: 60, price: 0.8 }),
    point({ matchId: 'm2', checkpointMinutes: 360, price: 0.9 }),
  ]).points;

  const perMatch = oneRowPerMatch(rows);
  assert.equal(perMatch.length, 2);
  assert.equal(perMatch.find((p) => p.matchId === 'm1')?.checkpointMinutes, 60);
  assert.equal(perMatch.find((p) => p.matchId === 'm2')?.checkpointMinutes, 360);
});

test('sem oneRowPerMatch a mesma partida entraria duas vezes com um desfecho só', () => {
  const rows = toFavoriteSample([
    point({ matchId: 'm1', checkpointMinutes: 360, price: 0.72, outcome: 1 }),
    point({ matchId: 'm1', checkpointMinutes: 60, price: 0.78, outcome: 1 }),
  ]).points;

  const inflado = reliabilityBuckets(rows, FAVORITE, FAVORITE_GRID);
  assert.equal(
    inflado.reduce((sum, b) => sum + b.n, 0),
    2,
  );

  const honesto = reliabilityBuckets(oneRowPerMatch(rows), FAVORITE, FAVORITE_GRID);
  assert.equal(
    honesto.reduce((sum, b) => sum + b.n, 0),
    1,
  );
});

test('a grade do favorito é de 5pp e começa em 0,50', () => {
  const rows = toFavoriteSample([
    point({ matchId: 'a', price: 0.92 }),
    point({ matchId: 'b', price: 0.97 }),
  ]).points;

  const buckets = reliabilityBuckets(rows, FAVORITE, FAVORITE_GRID);
  assert.equal(buckets.length, 2);
  assert.equal(buckets[0]?.from.toFixed(2), '0.90');
  assert.equal(buckets[0]?.to.toFixed(2), '0.95');
  assert.equal(buckets[1]?.from.toFixed(2), '0.95');
});

test('a grade decimal e a do favorito separam o que a outra junta', () => {
  // Duas partidas que o corte por time A põe no mesmo balde de 10pp e o corte por
  // favorito separa em dois de 5pp. É a resolução que o eixo pela metade compra.
  const rows = toFavoriteSample([
    point({ matchId: 'a', price: 0.91 }),
    point({ matchId: 'b', price: 0.98 }),
  ]).points;

  // Mesmos pontos, duas grades: a decimal junta 0,91 e 0,98 no balde 0,9–1,0; a
  // do favorito os separa em 0,90–0,95 e 0,95–1,00.
  assert.equal(reliabilityBuckets(rows, FAVORITE).length, 1);
  assert.equal(reliabilityBuckets(rows, FAVORITE, FAVORITE_GRID).length, 2);
});
