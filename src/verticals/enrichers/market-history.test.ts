import { test } from 'node:test';
import assert from 'node:assert/strict';

// O módulo importa o cliente do Supabase no topo. Criar o cliente não abre
// conexão — tudo testado aqui é puro: a matemática da série e a montagem dos
// fragmentos, que é onde as decisões moram.
process.env['SUPABASE_URL'] ??= 'http://localhost:54321';
process.env['SUPABASE_SERVICE_KEY'] ??= 'test-key';

const {
  impliedSeriesProbability,
  gameNumberOf,
  resolveBestOf,
  anchorToleranceSeconds,
  buildPriceFragments,
  buildConsistencyFragment,
  formatUsd,
  spreadOf,
  MARKET_HISTORY_ID,
} = await import('./market-history.js');

type AnchorSnapshot = Parameters<typeof spreadOf>[0];
type ResolvedWindow = Parameters<typeof buildPriceFragments>[0]['windows'][number];

const T0 = '2026-08-06T17:59:00.000Z';

function anchor(overrides: Partial<AnchorSnapshot> = {}): AnchorSnapshot {
  return {
    capturedAt: T0,
    midPrice: 0.62,
    bestBid: 0.61,
    bestAsk: 0.63,
    liquidity: 1_200_000,
    volume24h: 5_000_000,
    ...overrides,
  };
}

function windows(): ResolvedWindow[] {
  return [
    {
      key: '1h',
      target: '2026-08-06T17:00:00.000Z',
      snapshot: anchor({ capturedAt: '2026-08-06T16:58:00.000Z', midPrice: 0.588 }),
    },
    { key: '6h', target: '2026-08-06T12:00:00.000Z', snapshot: null },
    {
      key: '24h',
      target: '2026-08-05T18:00:00.000Z',
      snapshot: anchor({
        capturedAt: '2026-08-05T17:55:00.000Z',
        midPrice: 0.536,
        bestBid: 0.51,
        bestAsk: 0.56,
        liquidity: 1_000_000,
      }),
    },
  ];
}

// ---------------------------------------------------------------------------
// A matemática da consistência série × games
// ---------------------------------------------------------------------------

test('BO3 e BO5 com games equiprováveis batem com a fórmula fechada', () => {
  // p = 0.5 em toda parte: a série é moeda justa em qualquer formato.
  assert.equal(impliedSeriesProbability([0.5, 0.5, 0.5], 3), 0.5);
  assert.equal(impliedSeriesProbability([0.5, 0.5, 0.5, 0.5, 0.5], 5), 0.5);

  // BO3 com p=0.6: 3p²(1-p) + p³ = 0.648
  assert.ok(Math.abs((impliedSeriesProbability([0.6, 0.6, 0.6], 3) ?? 0) - 0.648) < 1e-12);
  // BO5 com p=0.6: 0.68256
  assert.ok(
    Math.abs((impliedSeriesProbability([0.6, 0.6, 0.6, 0.6, 0.6], 5) ?? 0) - 0.68256) < 1e-12,
  );
});

test('a série amplifica a vantagem — é o que torna a divergência informativa', () => {
  const game = 0.55;
  const series = impliedSeriesProbability([game, game, game], 3) ?? 0;
  assert.ok(series > game);
});

test('game já decidido entra como o fato que é', () => {
  // Time A ganhou o game 1 (preço colado em 1) e o resto é moeda justa: basta um
  // dos dois games restantes.
  const p = impliedSeriesProbability([1, 0.5, 0.5], 3) ?? 0;
  assert.ok(Math.abs(p - 0.75) < 1e-12);
});

test('conjunto incompleto ou preço inválido não vira número', () => {
  assert.equal(impliedSeriesProbability([0.5, 0.5], 3), null);
  assert.equal(impliedSeriesProbability([0.5, 0.5, 0.5, 0.5], 3), null);
  assert.equal(impliedSeriesProbability([0.5, 1.4, 0.5], 3), null);
  assert.equal(impliedSeriesProbability([0.5, NaN, 0.5], 3), null);
  assert.equal(impliedSeriesProbability([0.5, 0.5, 0.5], 0), null);
});

// ---------------------------------------------------------------------------
// Identificação dos markets de game
// ---------------------------------------------------------------------------

test('só `gameN` puro é moneyline de game — derivado dele não é', () => {
  assert.equal(gameNumberOf('game1', 'child_moneyline'), 1);
  assert.equal(gameNumberOf('game4', 'child_moneyline'), 4);
  // Histórico sem `sports_market_type`: o sufixo é a única evidência, e é
  // determinística.
  assert.equal(gameNumberOf('game2', 'unknown'), 2);

  assert.equal(gameNumberOf('game1-total-rounds', 'child_moneyline'), null);
  assert.equal(gameNumberOf('total-games-2pt5', 'totals'), null);
  assert.equal(gameNumberOf(null, 'moneyline'), null);
});

test('papel declarado diferente de child_moneyline é veto, não dúvida', () => {
  // `sports_market_type` é autoritativo quando existe (Parte B da spec).
  assert.equal(gameNumberOf('game1', 'round_handicap_game_1'), null);
});

// ---------------------------------------------------------------------------
// best_of: coluna quando existe, inferência estreita quando não
// ---------------------------------------------------------------------------

test('a coluna manda sobre a inferência', () => {
  assert.deepEqual(resolveBestOf(5, [1, 2, 3]), { bestOf: 5, source: 'column' });
  assert.deepEqual(resolveBestOf(3, []), { bestOf: 3, source: 'column' });
});

test('coluna e markets se contradizendo não viram número', () => {
  // Game 5 numa série declarada BO3: um dos dois está errado, e calcular sobre
  // os três primeiros devolveria um valor plausível e sem sentido.
  assert.equal(resolveBestOf(3, [1, 2, 3, 4, 5]), null);
});

test('a inferência exige o conjunto {1..n} completo e n de formato real', () => {
  assert.deepEqual(resolveBestOf(null, [1, 2, 3]), { bestOf: 3, source: 'inferred' });
  assert.deepEqual(resolveBestOf(null, [3, 1, 2]), { bestOf: 3, source: 'inferred' });
  assert.deepEqual(resolveBestOf(null, [1, 2, 3, 3]), { bestOf: 3, source: 'inferred' });
  assert.deepEqual(resolveBestOf(null, [1, 2, 3, 4, 5]), { bestOf: 5, source: 'inferred' });

  // Listagem parcial de um BO3/BO5 não é formato. Inferir daqui daria um número
  // errado com cara de certo.
  assert.equal(resolveBestOf(null, [1, 2]), null);
  assert.equal(resolveBestOf(null, [1, 2, 3, 4]), null);
  // Buraco no meio.
  assert.equal(resolveBestOf(null, [1, 3, 5]), null);
  assert.equal(resolveBestOf(null, []), null);
});

test('a tolerância da âncora acompanha a janela, com piso', () => {
  assert.equal(anchorToleranceSeconds(3_600), 900);
  assert.equal(anchorToleranceSeconds(21_600), 5_400);
  assert.equal(anchorToleranceSeconds(86_400), 21_600);
});

// ---------------------------------------------------------------------------
// Fragmentos de preço e liquidez
// ---------------------------------------------------------------------------

function priceFragments() {
  return buildPriceFragments({
    eventId: 'evt-1',
    slug: 'cs2-ntr-btf-2026-08-06',
    matchSlug: 'cs2-ntr-btf-2026-08-06',
    teamLabel: 'Nuclear TigeRES',
    now: anchor(),
    windows: windows(),
  });
}

test('as_of é o captured_at do snapshot, não o asOf perguntado', () => {
  // A coluna é "quando o fato era verdade". O preço foi 0.62 no instante em que
  // o coletor o viu, não no instante em que decidimos perguntar.
  for (const fragment of priceFragments()) {
    assert.equal(fragment.asOf.toISOString(), T0);
    assert.equal(fragment.enricherId, MARKET_HISTORY_ID);
  }
});

test('saem dois fragmentos, com kinds distintos', () => {
  assert.deepEqual(
    priceFragments().map(f => f.kind),
    ['odds', 'liquidity'],
  );
});

test('o movimento é medido em pontos percentuais, e a janela sem dado some do texto', () => {
  const odds = priceFragments()[0];
  assert.ok(odds);
  assert.match(odds.summary, /Nuclear TigeRES em 0\.620/);
  assert.match(odds.summary, /\+3\.2 pp em 1h/);
  assert.match(odds.summary, /\+8\.4 pp em 24h/);
  assert.doesNotMatch(odds.summary, /em 6h/);
  assert.equal(odds.confidence, 1.0);
});

test('a janela sem dado vira `missing` no payload, nunca zero', () => {
  const odds = priceFragments()[0];
  const rows = (odds?.payload as { windows: Array<Record<string, unknown>> }).windows;

  assert.equal(rows.length, 3);
  assert.deepEqual(rows[1], { window: '6h', target: '2026-08-06T12:00:00.000Z', missing: true });
  // Atraso entre a âncora pedida e o snapshot que a representa, exposto.
  assert.equal(rows[0]?.['lag_seconds'], 120);
});

test('o fragmento de liquidez traz book e comparação de 24h', () => {
  const liquidity = priceFragments()[1];
  assert.ok(liquidity);
  assert.match(liquidity.summary, /liquidez US\$ 1\.2M/);
  assert.match(liquidity.summary, /spread 0\.020/);
  assert.match(liquidity.summary, /liquidez era US\$ 1\.0M em 24h/);
  assert.match(liquidity.summary, /spread era 0\.050/);
});

test('sem mid_price não há fragmento de preço, mas o book ainda vale', () => {
  const fragments = buildPriceFragments({
    eventId: 'evt-1',
    slug: null,
    matchSlug: null,
    teamLabel: 'Butterfly',
    now: anchor({ midPrice: null }),
    windows: windows(),
  });

  assert.deepEqual(
    fragments.map(f => f.kind),
    ['liquidity'],
  );
});

test('spread só existe com os dois lados do book', () => {
  assert.ok(Math.abs((spreadOf(anchor()) ?? 0) - 0.02) < 1e-9);
  assert.equal(spreadOf(anchor({ bestBid: null })), null);
});

test('dinheiro é formatado sem depender do ICU do runtime', () => {
  assert.equal(formatUsd(1_234_567), 'US$ 1.2M');
  assert.equal(formatUsd(12_340), 'US$ 12.3k');
  assert.equal(formatUsd(17), 'US$ 17');
});

// ---------------------------------------------------------------------------
// Consistência série × games
// ---------------------------------------------------------------------------

function consistency(overrides: Partial<Parameters<typeof buildConsistencyFragment>[0]> = {}) {
  return buildConsistencyFragment({
    eventId: 'evt-serie',
    matchSlug: 'cs2-ntr-btf-2026-08-06',
    teamLabel: 'Nuclear TigeRES',
    bestOf: 3,
    bestOfSource: 'column',
    seriesMid: 0.62,
    seriesCapturedAt: T0,
    games: [
      { game: 1, eventId: 'g1', mid: 0.55, capturedAt: '2026-08-06T17:20:00.000Z' },
      { game: 2, eventId: 'g2', mid: 0.58, capturedAt: '2026-08-06T17:50:00.000Z' },
      { game: 3, eventId: 'g3', mid: 0.6, capturedAt: '2026-08-06T17:55:00.000Z' },
    ],
    ...overrides,
  });
}

test('a divergência sai do implícito pelos games', () => {
  const fragment = consistency();
  assert.ok(fragment);

  const payload = fragment.payload as Record<string, number | string>;
  assert.ok(Math.abs((payload['implied_from_games'] as number) - 0.6142) < 1e-12);
  assert.ok(Math.abs((payload['divergence'] as number) - 0.0058) < 1e-12);
  assert.equal(payload['model'], 'independent_games');
  assert.match(fragment.summary, /Divergência de \+0\.6 pp/);
});

test('as_of da consistência é o insumo MAIS ANTIGO', () => {
  // A afirmação é composta e só foi simultaneamente verdadeira até a perna mais
  // velha. Datar pelo mais novo alegaria que o game de 40 min atrás ainda valia.
  const fragment = consistency();
  assert.equal(fragment?.asOf.toISOString(), '2026-08-06T17:20:00.000Z');
  assert.equal((fragment?.payload as Record<string, number>)['max_staleness_seconds'], 2340);
});

test('best_of inferido rebaixa a confiança e aparece no texto', () => {
  const fromColumn = consistency();
  const inferred = consistency({ bestOfSource: 'inferred' });

  assert.equal(fromColumn?.confidence, 0.8);
  assert.equal(inferred?.confidence, 0.5);
  assert.match(inferred?.summary ?? '', /best_of inferido/);
  assert.doesNotMatch(fromColumn?.summary ?? '', /inferido/);
});

test('conjunto de games incompleto não vira fragmento', () => {
  // Um BO5 declarado pela coluna com só 3 games precificados: completar com a
  // média dos conhecidos seria inventar o preço que o mercado não deu.
  assert.equal(consistency({ bestOf: 5 }), null);
});
