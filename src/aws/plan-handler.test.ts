import { test } from 'node:test';
import assert from 'node:assert/strict';

import { hashDescription } from '../digest/digest.js';
import { keyOf, type DigestedIndex } from '../digest/leituras.js';
import type { MarketToDigest } from '../digest/store.js';
import { createPlanHandler, type DigestConfig } from './plan-handler.js';

const NOW = new Date('2026-11-17T09:00:00.000Z');

function market(
  id: string,
  status: string | null = 'active',
  text = `Rule text of ${id}.`,
): MarketToDigest {
  return {
    eventId: id,
    polymarketId: `pm-${id}`,
    tema: null,
    liquidez: null,
    status,
    input: { question: id, description: text, slug: null, endDate: null, outcomes: null },
  };
}

function index(keys: string[] = []): DigestedIndex {
  return {
    tabelaExiste: true,
    colunaLeituraN: true,
    keys: new Set(keys),
    keysComLeitura: new Set(),
    leiturasPorTexto: new Map(),
    maxLeituraPorChave: new Map(),
    combinacoes: new Map(),
  };
}

const CONFIG: DigestConfig = {
  model: 'claude-haiku-5-5',
  promptVersion: 'v4',
  timeoutMs: 300_000,
};

function setup(
  options: {
    config?: DigestConfig;
    markets?: MarketToDigest[];
    digested?: DigestedIndex;
    spend?: number;
    maxItems?: number;
  } = {},
) {
  const calls: string[] = [];
  const logs: string[] = [];
  const handler = createPlanHandler({
    readConfig: () => {
      calls.push('config');
      return Promise.resolve(options.config ?? CONFIG);
    },
    readSpend: () => {
      calls.push('spend');
      return Promise.resolve(options.spend ?? 0);
    },
    readMarkets: () => {
      calls.push('markets');
      return Promise.resolve(options.markets ?? []);
    },
    readDigested: () => {
      calls.push('digested');
      return Promise.resolve(options.digested ?? index());
    },
    monthlyCapUsd: 3,
    maxItems: options.maxItems ?? 100,
    now: () => NOW,
    log: (line) => logs.push(line),
  });
  return { handler, calls, logs };
}

test('plano: modelo sem rota devolve CONFIG_ERROR e lista vazia, sem ler o roster', async () => {
  const { handler, calls } = setup({ config: { ...CONFIG, model: 'claude-sonnet-5' } });
  const plan = await handler({});
  assert.equal(plan.reason, 'CONFIG_ERROR');
  assert.deepEqual(plan.items, []);
  assert.deepEqual(calls, ['config']);
});

test('plano: modelo com rota mas sem preço também é CONFIG_ERROR', async () => {
  const routes = { 'sem-preco': 'anthropic:sem-preco' };
  const { handler } = setup({ config: { ...CONFIG, model: 'sem-preco' } });
  // The default table has no route for it; with a route but no price it still stops.
  const withRoute = createPlanHandler({
    readConfig: () => Promise.resolve({ ...CONFIG, model: 'sem-preco' }),
    readSpend: () => Promise.resolve(0),
    readMarkets: () => Promise.resolve([market('a')]),
    readDigested: () => Promise.resolve(index()),
    monthlyCapUsd: 3,
    routes,
    log: () => undefined,
  });
  assert.equal((await handler({})).reason, 'CONFIG_ERROR');
  assert.equal((await withRoute({})).reason, 'CONFIG_ERROR');
});

test('plano: teto do mês esgotado devolve BUDGET e nenhum item', async () => {
  const { handler, calls } = setup({ spend: 3, markets: [market('a')] });
  const plan = await handler({});
  assert.equal(plan.reason, 'BUDGET');
  assert.deepEqual(plan.items, []);
  assert.deepEqual(calls, ['config', 'spend']);
});

test('plano: status terminal sai da fila e é contado no log', async () => {
  const { handler, logs } = setup({
    markets: [market('a'), market('b', 'resolved'), market('c', 'inactive'), market('d', null)],
  });
  const plan = await handler({});
  assert.deepEqual(
    plan.items.map((i) => i.event_id),
    ['a', 'd'],
  );
  const line = JSON.parse(logs[0] ?? '{}') as { descartados_por_status?: Record<string, number> };
  assert.deepEqual(line.descartados_por_status, { resolved: 1, inactive: 1 });
});

test('plano: o que já foi digerido por este modelo e versão sai da fila', async () => {
  const a = market('a');
  const done = keyOf({
    eventId: 'a',
    descriptionSha256: hashDescription(a.input.description),
    model: CONFIG.model,
    promptVersion: CONFIG.promptVersion,
  });
  const { handler } = setup({ markets: [a, market('b')], digested: index([done]) });
  const plan = await handler({});
  assert.deepEqual(
    plan.items.map((i) => i.event_id),
    ['b'],
  );
});

test('plano: o corte de 100 vale e cada item leva o hash do texto atual', async () => {
  const markets = Array.from({ length: 150 }, (_, i) => market(`m${String(i).padStart(3, '0')}`));
  const { handler } = setup({ markets });
  const plan = await handler({});
  assert.equal(plan.items.length, 100);
  assert.equal(plan.items[0]?.sha256, hashDescription('Rule text of m000.'));
});

test('plano: carrega modelo, versão, prazo e o início da corrida para as leituras', async () => {
  const { handler } = setup({ markets: [market('a')] });
  const fromInput = await handler({ run_started_at: '2026-11-17T08:59:58.000Z' });
  assert.equal(fromInput.run_started_at, '2026-11-17T08:59:58.000Z');
  assert.equal(fromInput.model, 'claude-haiku-5-5');
  assert.equal(fromInput.prompt_version, 'v4');
  assert.equal(fromInput.timeout_ms, 300_000);
  const fromClock = await handler({});
  assert.equal(fromClock.run_started_at, NOW.toISOString());
});
