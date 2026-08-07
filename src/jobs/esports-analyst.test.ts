import { test } from 'node:test';
import assert from 'node:assert/strict';

// O módulo importa o cliente do Supabase no topo. Criar o cliente não abre
// conexão — o que se testa aqui são as guardas que decidem se a chamada paga
// acontece: checkpoint devido, estado do conhecimento, e o portão de abstenção.
process.env['SUPABASE_URL'] ??= 'http://localhost:54321';
process.env['SUPABASE_SERVICE_KEY'] ??= 'test-key';

const {
  dueCheckpoints,
  latestPerKind,
  marketFrom,
  gateDecision,
  toPromptFragments,
  cycleStatus,
  emptyAnalystStats,
} = await import('./esports-analyst.js');

type StoredFragment = Parameters<typeof latestPerKind>[0][number];

const NOW = new Date('2026-08-07T12:00:00.000Z');
const TOLERANCE = 20 * 60_000;

function fragment(overrides: Partial<StoredFragment> = {}): StoredFragment {
  return {
    id: 1,
    enricherId: 'market-history',
    kind: 'odds',
    asOf: '2026-08-07T11:59:00.000Z',
    observedAt: '2026-08-07T11:59:30.000Z',
    confidence: 1,
    summary: 'preço em 0.620',
    payload: { mid_price: 0.62, outcome: 'Natus Vincere' },
    ...overrides,
  };
}

function liquidityFragment(liquidity: number | null, spread: number | null): StoredFragment {
  return fragment({
    id: 2,
    kind: 'liquidity',
    payload: { liquidity, spread },
  });
}

const THRESHOLDS = { minLiquidityUsd: 5000, maxSpread: 0.15, minFragments: 3 };

// ---------------------------------------------------------------------------
// Checkpoints
// ---------------------------------------------------------------------------

test('o checkpoint vence no horário nominal e vale pela tolerância', () => {
  // Partida às 18:00; o checkpoint de 360 min vence às 12:00, que é agora.
  const start = '2026-08-07T18:00:00.000Z';
  assert.deepEqual(dueCheckpoints(NOW, start, [360, 60], TOLERANCE), [360]);

  const tenLate = new Date(NOW.getTime() + 10 * 60_000);
  assert.deepEqual(dueCheckpoints(tenLate, start, [360, 60], TOLERANCE), [360]);
});

test('passada a tolerância o checkpoint é perdido, não adiado', () => {
  // Refazê-lo mais tarde produziria uma linha rotulada "T-6h" com o que se sabia
  // em T-5h — exatamente a mentira que as_of existe para impedir.
  const late = new Date(NOW.getTime() + 25 * 60_000);
  assert.deepEqual(dueCheckpoints(late, '2026-08-07T18:00:00.000Z', [360], TOLERANCE), []);
});

test('checkpoint que ainda não chegou não vence', () => {
  assert.deepEqual(dueCheckpoints(NOW, '2026-08-07T19:00:00.000Z', [360], TOLERANCE), []);
});

test('checkpoint negativo é a leitura ao vivo', () => {
  // -15 = quinze minutos DEPOIS do início. Partida começou às 11:45.
  assert.deepEqual(dueCheckpoints(NOW, '2026-08-07T11:45:00.000Z', [-15], TOLERANCE), [-15]);
});

test('vencendo dois de uma vez, o mais próximo do jogo vem primeiro', () => {
  // Se o teto por ciclo cortar, corta o menos urgente.
  const start = '2026-08-07T12:30:00.000Z';
  assert.deepEqual(dueCheckpoints(NOW, start, [360, 30], TOLERANCE), [30]);
  assert.deepEqual(dueCheckpoints(NOW, '2026-08-07T12:10:00.000Z', [30, 10], TOLERANCE), [10, 30]);
});

test('scheduled_at ilegível não vence checkpoint nenhum', () => {
  assert.deepEqual(dueCheckpoints(NOW, 'amanhã', [360], TOLERANCE), []);
});

// ---------------------------------------------------------------------------
// Estado do conhecimento
// ---------------------------------------------------------------------------

test('só a observação mais recente de cada (enricher, kind) entra', () => {
  // A evolução que importa já está DENTRO do fragmento, nas janelas de
  // 1h/6h/24h. Mandar as duas seria pagar token para o modelo reconstruir o que
  // o enricher já reconstruiu.
  const kept = latestPerKind([
    fragment({ id: 9, observedAt: '2026-08-07T11:59:00.000Z' }),
    fragment({ id: 3, observedAt: '2026-08-07T10:00:00.000Z' }),
    fragment({ id: 8, kind: 'liquidity', observedAt: '2026-08-07T11:58:00.000Z' }),
  ]);

  assert.deepEqual(
    kept.map(f => f.id),
    [9, 8],
  );
});

test('enrichers diferentes com o mesmo kind não se anulam', () => {
  const kept = latestPerKind([
    fragment({ id: 1, enricherId: 'market-history', kind: 'news' }),
    fragment({ id: 2, enricherId: 'polymarket-context', kind: 'news' }),
  ]);
  assert.equal(kept.length, 2);
});

test('o preço sai dos próprios fragmentos, não de uma releitura', () => {
  // O portão e o modelo precisam ver o mesmo instante. Ler do mesmo conjunto
  // torna a divergência impossível por construção.
  const market = marketFrom([fragment(), liquidityFragment(1_200_000, 0.02)]);
  assert.equal(market.mid, 0.62);
  assert.equal(market.liquidity, 1_200_000);
  assert.equal(market.spread, 0.02);
  assert.equal(market.outcomeLabel, 'Natus Vincere');
});

test('sem fragmento de preço o mercado vem vazio, não zerado', () => {
  const market = marketFrom([liquidityFragment(1000, 0.05)]);
  assert.equal(market.mid, null);
  assert.equal(market.outcomeLabel, null);
});

// ---------------------------------------------------------------------------
// O portão de abstenção
// ---------------------------------------------------------------------------

test('mercado formado passa', () => {
  const fragments = [fragment(), liquidityFragment(1_200_000, 0.02), fragment({ id: 3, kind: 'news' })];
  assert.deepEqual(gateDecision(fragments, marketFrom(fragments), THRESHOLDS), { ok: true });
});

test('spread de 0,90 com US$ 67 de liquidez não é preço formado', () => {
  // O caso que motiva a abstenção existir: não há com o que discordar.
  const fragments = [fragment(), liquidityFragment(67, 0.9), fragment({ id: 3, kind: 'news' })];
  const verdict = gateDecision(fragments, marketFrom(fragments), THRESHOLDS);

  assert.equal(verdict.ok, false);
  // A liquidez falha primeiro: com liquidez de brinquedo, o spread não importa.
  assert.equal(verdict.ok === false && verdict.reason, 'low_liquidity');
  assert.match(verdict.ok === false ? verdict.detail : '', /US\$ 67/);
});

test('cada critério tem seu próprio motivo, e a ordem segue o que falta antes', () => {
  const withNews = (liquidity: number, spread: number | null): StoredFragment[] => [
    fragment(),
    liquidityFragment(liquidity, spread),
    fragment({ id: 3, kind: 'news' }),
  ];

  const wide = withNews(1_000_000, 0.4);
  assert.equal(
    gateDecision(wide, marketFrom(wide), THRESHOLDS).ok === false &&
      (gateDecision(wide, marketFrom(wide), THRESHOLDS) as { reason: string }).reason,
    'wide_spread',
  );

  // Book com um lado só é a forma extrema do mesmo defeito, não "desconhecido".
  const oneSided = withNews(1_000_000, null);
  const verdict = gateDecision(oneSided, marketFrom(oneSided), THRESHOLDS);
  assert.equal(verdict.ok === false && verdict.reason, 'wide_spread');
  assert.match(verdict.ok === false ? verdict.detail : '', /um lado só/);

  // Sem preço, nada mais importa.
  const noPrice = [liquidityFragment(1_000_000, 0.02)];
  assert.equal(
    gateDecision(noPrice, marketFrom(noPrice), THRESHOLDS).ok === false &&
      (gateDecision(noPrice, marketFrom(noPrice), THRESHOLDS) as { reason: string }).reason,
    'no_price',
  );
});

test('contexto só de preço abstém — tese sobre a própria série não precisa de LLM', () => {
  const priceOnly = [fragment(), liquidityFragment(1_000_000, 0.02)];
  const verdict = gateDecision(priceOnly, marketFrom(priceOnly), THRESHOLDS);

  assert.equal(verdict.ok === false && verdict.reason, 'insufficient_context');
});

// ---------------------------------------------------------------------------
// Rótulos e status
// ---------------------------------------------------------------------------

test('os fragmentos entram no prompt com rótulo curto e na ordem', () => {
  const labelled = toPromptFragments([fragment({ id: 7 }), fragment({ id: 8, kind: 'liquidity' })]);
  assert.deepEqual(
    labelled.map(f => f.label),
    ['F1', 'F2'],
  );
  assert.equal(labelled[0]?.kind, 'odds');
});

test('falha e parada de orçamento são partial; ciclo vazio é sucesso', () => {
  const failed = emptyAnalystStats();
  failed.failed = 1;
  assert.equal(cycleStatus(failed), 'partial');

  const stopped = emptyAnalystStats();
  stopped.budgetStop = true;
  assert.equal(cycleStatus(stopped), 'partial');

  // Abstenção não é falha — é o produto funcionando.
  const abstained = emptyAnalystStats();
  abstained.abstainedGate = 4;
  abstained.abstainedModel = 1;
  assert.equal(cycleStatus(abstained), 'success');
});
