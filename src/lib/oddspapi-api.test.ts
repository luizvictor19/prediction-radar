import { test } from 'node:test';
import assert from 'node:assert/strict';

const {
  collectOdds,
  groupByBookmaker,
  toFixture,
  safeParam,
  isExpectedOutage,
  BillableBudget,
  OddsPapiError,
  markSuspended,
  suspendedForMs,
  resetOddsPapiState,
  readConfig,
  describeConfig,
  SPORT_ID_BY_VERTICAL,
  MONTHLY_BILLABLE_LIMIT,
  BILLABLE_RESERVE,
  cacheRead,
  cacheWrite,
  MAX_CACHE_ENTRIES,
} = await import('./oddspapi-api.js');

type OddsEntry = Parameters<typeof collectOdds>[1][number];

// ---------------------------------------------------------------------------
// Parsing defensivo — a forma da resposta não é contrato
// ---------------------------------------------------------------------------

test('qualquer objeto com price é entrada, em qualquer profundidade', () => {
  // A doc descreve `bookmakers -> markets -> outcomes -> players`, e o parsing
  // não depende disso de propósito: foi assim que a sonda mediu, e é o que
  // sobrevive a eles mudarem a envelopagem sem avisar.
  const out: OddsEntry[] = [];
  collectOdds(
    { qualquer: { coisa: [{ price: 1.8, createdAt: '2026-07-10T12:00:00Z', active: true }] } },
    out,
  );

  assert.equal(out.length, 1);
  assert.equal(out[0]?.price, 1.8);
  assert.equal(out[0]?.path, 'qualquer.coisa.0');
});

test('o nome do outcome vem do ancestral mais próximo', () => {
  // É o que dá o LADO sem depender da posição no array.
  const out: OddsEntry[] = [];
  collectOdds({ outcomes: [{ name: 'NAVI', odds: [{ price: 1.8 }, { price: 1.85 }] }] }, out);

  assert.equal(out.length, 2);
  assert.ok(out.every((e) => e.outcome === 'NAVI'));
  // A série é o caminho sem o índice — os dois pertencem à mesma.
  assert.equal(out[0]?.path, 'outcomes.0.odds.0');
  assert.equal(out[1]?.path, 'outcomes.0.odds.1');
});

test('active ausente é null, e null não é false', () => {
  // Colapsar os dois inventaria mercado suspenso onde só falta campo.
  const out: OddsEntry[] = [];
  collectOdds(
    [{ price: 1.8 }, { price: 1.9, active: false }, { price: 2.0, is_active: true }],
    out,
  );

  assert.equal(out[0]?.active, null);
  assert.equal(out[1]?.active, false);
  // `false` sobrevive ao encadeamento de `??` — o bug clássico deste padrão.
  assert.equal(out[2]?.active, true);
});

test('bookmakers como MAPA e como LISTA dão o mesmo agrupamento', () => {
  // Medido: é um mapa slug -> conteúdo. A lista fica suportada porque o mapa não
  // é contrato de ninguém.
  const asMap = groupByBookmaker({
    bookmakers: { pinnacle: { odds: [{ price: 1.8 }] }, stake: { odds: [{ price: 1.85 }] } },
  });
  assert.deepEqual([...asMap.keys()], ['pinnacle', 'stake']);
  assert.equal(asMap.get('pinnacle')?.[0]?.path, 'bookmakers.pinnacle.odds.0');

  const asList = groupByBookmaker({
    bookmakers: [
      { slug: 'pinnacle', odds: [{ price: 1.8 }] },
      { slug: 'stake', odds: [{ price: 1.85 }] },
    ],
  });
  assert.deepEqual([...asList.keys()], ['pinnacle', 'stake']);

  // Resposta sem `bookmakers` não explode: devolve vazio e quem chama decide.
  assert.equal(groupByBookmaker({ erro: 'x' }).size, 0);
});

test('fixture: quem diz que acabou é trueEndTime, não statusId', () => {
  // Medido: `statusId` volta null em toda fixture de CS2 da amostra, apesar de a
  // doc descrevê-lo como 0-3.
  const fixture = toFixture({
    fixtureId: 'f1',
    statusId: null,
    trueEndTime: '2026-07-10T20:00:00Z',
    hasOdds: true,
    participant1Name: 'Natus Vincere',
    participant1Abbr: 'navi',
    participant2Name: 'Team Spirit',
  });

  assert.equal(fixture?.finished, true);
  assert.deepEqual(fixture?.sides[0], ['Natus Vincere', 'navi']);
  assert.deepEqual(fixture?.sides[1], ['Team Spirit']);

  assert.equal(toFixture({ semId: true }), null);
});

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

test('parâmetro fora do léxico é recusado antes de virar requisição', () => {
  // `&` ou `=` num id não falhariam: mudariam o sentido da requisição em
  // silêncio, e uma resposta sobre outra partida é o pior modo de falha possível
  // numa fonte de preço.
  assert.equal(safeParam('fixtureId', ' id1704591169167084 '), 'id1704591169167084');

  for (const torto of ['a&b=c', 'a b', '', 'x,y']) {
    assert.throws(() => safeParam('fixtureId', torto), OddsPapiError);
  }
});

// ---------------------------------------------------------------------------
// Orçamento e cortesia
// ---------------------------------------------------------------------------

test('o orçamento respeita a reserva, e a reserva existe porque ele é estimativa', () => {
  // A cota real não é observável (medido: /v4/account não traz contador nenhum).
  // Gastar até o último token confiando numa estimativa é como não ter orçamento.
  const budget = new BillableBudget(10, 60_000);

  assert.equal(budget.remaining(), 10);
  assert.equal(budget.canSpend(8), true);

  for (let i = 0; i < 2; i += 1) budget.take();
  assert.equal(budget.spent(), 2);
  assert.equal(budget.canSpend(8), false, 'com 8 restantes e reserva 8, não cabe mais');
  assert.equal(budget.canSpend(0), true);
});

test('o orçamento é janela deslizante — o mês passado não conta', () => {
  const budget = new BillableBudget(250, 30 * 24 * 3_600_000);
  const now = Date.now();

  budget.take(now - 40 * 24 * 3_600_000);
  budget.take(now - 1 * 24 * 3_600_000);

  assert.equal(budget.spent(now), 1);
  assert.equal(budget.remaining(now), 249);
});

test('corte de acesso vira estado com prazo, não erro repetido', () => {
  // O tier gratuito é cortesia e some sem aviso. Insistir contra isso só produz
  // log e queima relação com o fornecedor.
  resetOddsPapiState();
  assert.equal(suspendedForMs(), 0);

  const now = Date.now();
  markSuspended(now);
  assert.ok(suspendedForMs(now) > 5 * 3_600_000);
  assert.equal(suspendedForMs(now + 7 * 3_600_000), 0);

  resetOddsPapiState();
  assert.equal(suspendedForMs(), 0);
});

test('os estados esperados da fonte são separados das anomalias', () => {
  // Os primeiros viram aviso por hora; os últimos, aviso por partida. A
  // diferença é se há ação a tomar.
  for (const kind of ['not_configured', 'budget_exhausted', 'suspended', 'rate_limited'] as const) {
    assert.equal(isExpectedOutage(new OddsPapiError(kind, 'x')), true, kind);
  }
  for (const kind of ['http', 'timeout', 'shape', 'unsafe_param'] as const) {
    assert.equal(isExpectedOutage(new OddsPapiError(kind, 'x')), false, kind);
  }
});

test('credencial ausente é descrita sem nunca dizer o valor', () => {
  const saved = process.env['ODDSPAPI_API_KEY'];
  delete process.env['ODDSPAPI_API_KEY'];

  assert.equal(readConfig(), null);
  assert.equal(describeConfig(), 'faltando: ODDSPAPI_API_KEY');

  process.env['ODDSPAPI_API_KEY'] = 'segredo-que-nao-pode-vazar';
  assert.equal(readConfig()?.apiKey, 'segredo-que-nao-pode-vazar');
  assert.equal(describeConfig(), 'configurado');

  if (saved === undefined) delete process.env['ODDSPAPI_API_KEY'];
  else process.env['ODDSPAPI_API_KEY'] = saved;
});

test('só as verticais com sportId medido são atendidas', () => {
  // LoL e Dota 2 estão anotados na sonda como "conferir com /v4/sports depois".
  // sportId errado não falha: devolve fixtures de outro jogo, ninguém casa, e a
  // requisição billable foi gasta para descobrir nada.
  assert.deepEqual(Object.keys(SPORT_ID_BY_VERTICAL), ['cs2']);
  assert.equal(SPORT_ID_BY_VERTICAL['cs2'], 17);
});

test('os tetos do plano Free estão onde o código os lê', () => {
  assert.equal(MONTHLY_BILLABLE_LIMIT, 250);
  assert.ok(BILLABLE_RESERVE > 0 && BILLABLE_RESERVE < MONTHLY_BILLABLE_LIMIT);
});

// ---------------------------------------------------------------------------
// Cache — o endpoint livre não paga a conta do caro
// ---------------------------------------------------------------------------

test('a rotatividade do endpoint livre não despeja a entrada billable', () => {
  // REGRESSÃO MEDIDA (09/08): 65 das 250 requisições billable do mês gastas em 2
  // dias. Havia UM cache para os dois endpoints e, ao encher, um `cache.clear()`.
  // `/v4/historical-odds` é livre e roda uma vez por partida por ciclo (~38
  // partidas, tick de 5 min): enchia o teto em poucos ciclos e levava junto a
  // entrada de `/v4/fixtures`, que é billable e vale 1h. Cada redescoberta depois
  // disso custava do orçamento mensal.
  resetOddsPapiState();

  const t0 = Date.UTC(2026, 7, 9, 12, 0, 0);
  const fixturesParams = { sportId: '17', from: '2026-08-09', to: '2026-08-10' };

  cacheWrite('/v4/fixtures', fixturesParams, 3_600, { fixtures: ['f1'] }, t0);

  // Bem mais que o teto, como um dia inteiro de ciclos produz.
  for (let i = 0; i < MAX_CACHE_ENTRIES * 3; i += 1) {
    cacheWrite(
      '/v4/historical-odds',
      { fixtureId: `f${i}`, bookmakers: 'pinnacle,stake' },
      120,
      { bookmakers: {} },
      t0 + i * 1_000,
    );
  }

  // Meia hora depois: dentro da 1h de TTL, e a entrada cara continua servindo.
  const meiaHora = t0 + 30 * 60_000;
  const hit = cacheRead('/v4/fixtures', fixturesParams, 3_600, meiaHora);
  assert.notEqual(hit, undefined, 'a entrada billable foi despejada pelo endpoint livre');
  assert.deepEqual(hit?.body, { fixtures: ['f1'] });

  // Passado o TTL ela vence normalmente — a proteção é contra despejo, não contra
  // o vencimento.
  assert.equal(cacheRead('/v4/fixtures', fixturesParams, 3_600, t0 + 3_601_000), undefined);
});

test('o cache livre despeja o vencido antes do válido, e nunca zera inteiro', () => {
  // O `clear()` era o defeito em si: jogava fora entrada válida para acomodar uma
  // nova. Com N+1 escritas, quem sai é UMA — a mais antiga —, não as N.
  resetOddsPapiState();

  const t0 = Date.UTC(2026, 7, 9, 12, 0, 0);
  const params = (i: number) => ({ fixtureId: `f${i}`, bookmakers: 'pinnacle' });

  for (let i = 0; i < MAX_CACHE_ENTRIES + 1; i += 1) {
    cacheWrite('/v4/historical-odds', params(i), 120, { i }, t0 + i);
  }

  // Todas ainda dentro dos 120s: a primeira saiu por idade, a segunda ficou.
  const agora = t0 + MAX_CACHE_ENTRIES + 1;
  assert.equal(cacheRead('/v4/historical-odds', params(0), 120, agora), undefined);
  assert.notEqual(cacheRead('/v4/historical-odds', params(1), 120, agora), undefined);
  assert.deepEqual(
    cacheRead('/v4/historical-odds', params(MAX_CACHE_ENTRIES), 120, agora)?.body,
    { i: MAX_CACHE_ENTRIES },
  );
});
