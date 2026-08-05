import { test } from 'node:test';
import assert from 'node:assert/strict';

// O módulo importa o cliente do Supabase no topo, que exige env. Criar o cliente
// não abre conexão — os valores abaixo só permitem o import. Nenhum teste aqui
// toca no banco ou na rede.
process.env['SUPABASE_URL'] ??= 'http://localhost:54321';
process.env['SUPABASE_SERVICE_KEY'] ??= 'test-key';

const { reconcile, buildSnapshotRows } = await import('./watchlist-collector.js');

type GammaMarket = Parameters<typeof buildSnapshotRows>[1];

function market(overrides: Partial<GammaMarket> = {}): GammaMarket {
  return {
    id: 'm1',
    outcomes: '["Team A", "Team B"]',
    bestBid: 0.4,
    bestAsk: 0.6,
    spread: 0.2,
    closed: false,
    ...overrides,
  } as GammaMarket;
}

function lookup(present: string[], failed: string[] = []) {
  return {
    byId: new Map(present.map(id => [id, market({ id })])),
    failedIds: new Set(failed),
  };
}

test('id que voltou vivo não é contado como fechado nem como ausente', () => {
  const r = reconcile(['a', 'b'], lookup(['a', 'b']), lookup([]));
  assert.deepEqual(r.openIds, ['a', 'b']);
  assert.deepEqual(r.closedIds, []);
  assert.deepEqual(r.unknownIds, []);
  assert.equal(r.unaccounted, 0);
});

test('ausente do lote aberto e presente no closed=true conta como fechado', () => {
  // É a armadilha do item 2b: o filtro `id=` aplica closed=false por padrão, e
  // sem a segunda chamada o market resolvido seria só um buraco no lote.
  const r = reconcile(['a', 'b'], lookup(['a']), lookup(['b']));
  assert.deepEqual(r.openIds, ['a']);
  assert.deepEqual(r.closedIds, ['b']);
  assert.deepEqual(r.unknownIds, []);
  assert.equal(r.unaccounted, 0);
});

test('ausente dos dois lotes fica em unknown — resolveu ou o lote truncou', () => {
  const r = reconcile(['a', 'b'], lookup(['a']), lookup([]));
  assert.deepEqual(r.unknownIds, ['b']);
  assert.equal(r.unaccounted, 0);
});

test('id de chunk que falhou não vira ausente', () => {
  // Ler falha de rede como "sumiu do feed" é exatamente o falso positivo que o
  // item 2c mandou parar de produzir.
  const r = reconcile(['a', 'b'], lookup(['a'], ['b']), lookup([]));
  assert.deepEqual(r.failedIds, ['b']);
  assert.deepEqual(r.unknownIds, []);
  assert.deepEqual(r.closedIds, []);
});

test('todo id enviado cai em exatamente um balde', () => {
  const r = reconcile(['a', 'b', 'c', 'd'], lookup(['a'], ['d']), lookup(['b']));
  assert.equal(
    r.openIds.length + r.closedIds.length + r.unknownIds.length + r.failedIds.length,
    4,
  );
  assert.equal(r.unaccounted, 0);
});

test('watchlist vazia não inventa divergência', () => {
  const r = reconcile([], lookup([]), lookup([]));
  assert.equal(r.unaccounted, 0);
});

test('snapshot do par binário deriva o segundo outcome do primeiro', () => {
  const rows = buildSnapshotRows('ev1', market(), '2026-08-04T18:00:00.000Z');
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], {
    event_id: 'ev1',
    outcome: 'Team A',
    best_bid: 0.4,
    best_ask: 0.6,
    mid_price: 0.5,
    spread: 0.2,
    volume_24h: null,
    captured_at: '2026-08-04T18:00:00.000Z',
  });
  assert.deepEqual(rows[1], {
    event_id: 'ev1',
    outcome: 'Team B',
    best_bid: 0.4,
    best_ask: 0.6,
    mid_price: 0.5,
    spread: 0.2,
    volume_24h: null,
    captured_at: '2026-08-04T18:00:00.000Z',
  });
});

test('grava com um lado só do book', () => {
  // Perto da resolução um dos lados perde liquidez. Exigir os dois apagaria a
  // série justamente no trecho mais informativo.
  const rows = buildSnapshotRows('ev1', market({ bestAsk: null as never }), '2026-08-04T18:00:00.000Z');
  assert.equal(rows.length, 2);
  assert.equal(rows[0]?.['best_bid'], 0.4);
  assert.equal(rows[0]?.['best_ask'], null);
  assert.equal(rows[0]?.['mid_price'], null);
  assert.equal(rows[1]?.['best_bid'], null);
  assert.equal(rows[1]?.['best_ask'], 0.6);
});

test('sem nenhum lado do book não há o que registrar', () => {
  const rows = buildSnapshotRows(
    'ev1',
    market({ bestBid: null as never, bestAsk: null as never }),
    '2026-08-04T18:00:00.000Z',
  );
  assert.deepEqual(rows, []);
});

test('outcomes malformado não derruba o chunk do insert', () => {
  assert.deepEqual(buildSnapshotRows('ev1', market({ outcomes: 'not json' }), 'now'), []);
  assert.deepEqual(buildSnapshotRows('ev1', market({ outcomes: '["Only One"]' }), 'now'), []);
});

test('volume_24h cai para o valor do CLOB quando o principal falta', () => {
  const rows = buildSnapshotRows('ev1', market({ volume24hrClob: 1234 }), 'now');
  assert.equal(rows[0]?.['volume_24h'], 1234);
});
