import { test } from 'node:test';
import assert from 'node:assert/strict';

// O módulo importa o cliente do Supabase no topo, que exige env. Criar o cliente
// não abre conexão — os valores abaixo só permitem o import. Nenhum teste aqui
// toca no banco ou na rede.
process.env['SUPABASE_URL'] ??= 'http://localhost:54321';
process.env['SUPABASE_SERVICE_KEY'] ??= 'test-key';

const {
  reconcile,
  buildSnapshotRows,
  readCadence,
  classifyBand,
  isPrimaryMarket,
  bucketOf,
  intervalMsFor,
  isBucketDue,
  cycleStatus,
  windowStatus,
} = await import('./watchlist-collector.js');

const cadence = readCadence({});
const NOW = Date.parse('2026-08-06T12:00:00.000Z');
const inMinutes = (minutes: number): string => new Date(NOW + minutes * 60_000).toISOString();

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
  const rows = buildSnapshotRows('ev1', market({ liquidityNum: 17.4 }), '2026-08-04T18:00:00.000Z');
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], {
    event_id: 'ev1',
    outcome: 'Team A',
    best_bid: 0.4,
    best_ask: 0.6,
    mid_price: 0.5,
    volume_24h: null,
    liquidity: 17.4,
    captured_at: '2026-08-04T18:00:00.000Z',
  });
  assert.deepEqual(rows[1], {
    event_id: 'ev1',
    outcome: 'Team B',
    best_bid: 0.4,
    best_ask: 0.6,
    mid_price: 0.5,
    volume_24h: null,
    liquidity: 17.4,
    captured_at: '2026-08-04T18:00:00.000Z',
  });
});

test('liquidez ausente é null, não 0 — 0 é um fato sobre o book', () => {
  const rows = buildSnapshotRows('ev1', market(), '2026-08-04T18:00:00.000Z');
  assert.equal(rows[0]?.liquidity, null);

  const zero = buildSnapshotRows('ev1', market({ liquidityNum: 0 }), '2026-08-04T18:00:00.000Z');
  assert.equal(zero[0]?.liquidity, 0);
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

// ---------------------------------------------------------------------------
// Cadência por estado da partida (spec 000, itens 3b e 7)
// ---------------------------------------------------------------------------

test('a faixa sai da distância até game_start_time', () => {
  // Default: faixa "falta pouco" nos 360 min antes do jogo.
  assert.equal(classifyBand(inMinutes(361), NOW, cadence), 'far');
  assert.equal(classifyBand(inMinutes(359), NOW, cadence), 'soon');
  assert.equal(classifyBand(inMinutes(1), NOW, cadence), 'soon');
});

test('partida começada é ao vivo até o teto, não até o end_date', () => {
  // A âncora antiga (180 min antes do end_date) só abriria o ao vivo em
  // game_start_time + 3h — medido: end_date cai ~6h depois do jogo.
  assert.equal(classifyBand(inMinutes(0), NOW, cadence), 'live');
  assert.equal(classifyBand(inMinutes(-1), NOW, cadence), 'live');
  assert.equal(classifyBand(inMinutes(-359), NOW, cadence), 'live');
});

test('passado o teto sem resolver, cai para a faixa lenta', () => {
  // Partida adiada com âncora velha, ou resolução travada na UMA: o preço ainda
  // se move, mas não a 12s. Quem tira da lista é a janela de 24h do roster.
  assert.equal(classifyBand(inMinutes(-361), NOW, cadence), 'far');
  assert.equal(classifyBand(inMinutes(-6000), NOW, cadence), 'far');
});

test('sem âncora, ou com âncora inválida, fica na faixa lenta em vez de virar NaN', () => {
  // É o estado do roster inteiro antes do apply da migration e do backfill —
  // degradação segura, medida pelo `null_game_start_time` no log.
  assert.equal(classifyBand(null, NOW, cadence), 'far');
  assert.equal(classifyBand('não é data', NOW, cadence), 'far');
});

test('o teto do ao vivo é configurável', () => {
  const curto = readCadence({ watchlist_live_max_minutes: 120 });
  assert.equal(classifyBand(inMinutes(-119), NOW, curto), 'live');
  assert.equal(classifyBand(inMinutes(-121), NOW, curto), 'far');
});

test('só o tipo listado em config conta como mercado da série', () => {
  assert.equal(isPrimaryMarket('moneyline', cadence), true);
  assert.equal(isPrimaryMarket('spread', cadence), false);
  assert.equal(isPrimaryMarket(null, cadence), false);
  // Lista vazia trata todo mundo como derivado — some a faixa rápida, e é o
  // `occupancy_by_bucket` no log que denuncia.
  assert.equal(isPrimaryMarket('moneyline', readCadence({ watchlist_primary_market_types: [] })), false);
});

test('o multiplicador só atrasa o derivado, e vale nas três faixas', () => {
  assert.equal(intervalMsFor('live:primary', cadence), 12_000);
  assert.equal(intervalMsFor('live:derived', cadence), 60_000);
  assert.equal(intervalMsFor('soon:primary', cadence), 60_000);
  assert.equal(intervalMsFor('soon:derived', cadence), 300_000);
  assert.equal(intervalMsFor('far:primary', cadence), 300_000);
  assert.equal(intervalMsFor('far:derived', cadence), 1_500_000);

  // multiplicador 1 = todo mercado tratado igual, que é o volume que a spec
  // aponta como inaceitável (~4,3M linhas/dia).
  const flat = readCadence({ watchlist_derived_interval_multiplier: 1 });
  assert.equal(intervalMsFor('live:derived', flat), 12_000);
});

test('o bucket combina faixa e classe', () => {
  const entry = {
    id: 'e1',
    polymarket_id: 'p1',
    // Partida rolando há 30 min, com o end_date lá na frente (~6h depois do
    // jogo, como a Gamma manda). É o caso que a âncora antiga classificava como
    // 'soon' e esta como 'live'.
    end_date: inMinutes(330),
    game_start_time: inMinutes(-30),
    sports_market_type: 'moneyline',
  };
  assert.equal(bucketOf(entry, NOW, cadence), 'live:primary');
  assert.equal(bucketOf({ ...entry, sports_market_type: 'total' }, NOW, cadence), 'live:derived');
  assert.equal(bucketOf({ ...entry, game_start_time: inMinutes(600) }, NOW, cadence), 'far:primary');
  assert.equal(bucketOf({ ...entry, game_start_time: null }, NOW, cadence), 'far:primary');
});

test('a tolerância do tick impede o aliasing de 12s virar 15s', () => {
  // O tick é de 5s. Sem tolerância, o vencimento aos 12s só seria atendido aos
  // 15s — fora da faixa de 10-15s que a spec pede.
  assert.equal(isBucketDue('live:primary', NOW, cadence, undefined), true);
  assert.equal(isBucketDue('live:primary', NOW + 5_000, cadence, NOW), false);
  assert.equal(isBucketDue('live:primary', NOW + 10_000, cadence, NOW), true);
});

// ---------------------------------------------------------------------------
// Status: `partial` só quando algo falhou
// ---------------------------------------------------------------------------

const cleanCycle = { rosterError: null, writeErrors: 0, lookupFailedIds: 0 };
const cleanWindow = { ...cleanCycle, unaccounted: 0, rosterTruncated: false };

test('ciclo sem falha nenhuma bate success', () => {
  assert.equal(cycleStatus(cleanCycle), 'success');
});

test('cada falha real do ciclo, sozinha, rebaixa para partial', () => {
  assert.equal(cycleStatus({ ...cleanCycle, writeErrors: 1 }), 'partial');
  assert.equal(cycleStatus({ ...cleanCycle, lookupFailedIds: 3 }), 'partial');
  assert.equal(cycleStatus({ ...cleanCycle, rosterError: 'roster query: timeout' }), 'partial');
});

test('janela com divergência de lote continua success', () => {
  // A regressão que motivou isto: divergência é "enviados != recebidos" num
  // chunk, e o filtro `id=` da Gamma aplica closed=false — todo market que
  // resolveu falta no primeiro lote. Como a watchlist segura o market por 24h
  // depois do end_date, quase toda janela tem alguma, e o status vivia em
  // `partial` sem nada ter falhado.
  //
  // O contrato agora é: divergência não aparece na assinatura de windowStatus.
  // O que ela poderia esconder de verdade tem contador próprio (unaccounted).
  assert.equal(windowStatus(cleanWindow), 'success');
});

test('aritmética que não fecha e roster truncado continuam partial', () => {
  // unaccounted != 0 é bug de contagem no reconcile; roster truncado é market
  // de esports ativo fora da watchlist. Os dois são degradação de fato.
  assert.equal(windowStatus({ ...cleanWindow, unaccounted: 2 }), 'partial');
  assert.equal(windowStatus({ ...cleanWindow, unaccounted: -1 }), 'partial');
  assert.equal(windowStatus({ ...cleanWindow, rosterTruncated: true }), 'partial');
});

test('falha de escrita, de lookup ou de roster na janela é error', () => {
  assert.equal(windowStatus({ ...cleanWindow, writeErrors: 1 }), 'error');
  assert.equal(windowStatus({ ...cleanWindow, lookupFailedIds: 1 }), 'error');
  assert.equal(windowStatus({ ...cleanWindow, rosterError: 'boom' }), 'error');
});

test('erro pesa mais que degradação quando os dois aparecem na mesma janela', () => {
  assert.equal(
    windowStatus({ ...cleanWindow, writeErrors: 1, rosterTruncated: true, unaccounted: 5 }),
    'error',
  );
});

test('config zerada ou negativa cai no default em vez de refrescar todo tick', () => {
  const broken = readCadence({
    watchlist_interval_live_seconds: 0,
    watchlist_interval_far_seconds: -1,
    watchlist_derived_interval_multiplier: 0,
  });
  assert.equal(broken.liveSeconds, 12);
  assert.equal(broken.farSeconds, 300);
  assert.equal(broken.derivedMultiplier, 5);
});
