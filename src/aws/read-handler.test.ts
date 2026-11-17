import { test } from 'node:test';
import assert from 'node:assert/strict';

import { hashDescription } from '../digest/digest.js';
import type { DigestRows } from '../digest/rows.js';
import type { MarketToDigest } from '../digest/store.js';
import type { RecordOutcome } from '../digest/persist.js';
import type { CompletionResult, CompletionStop, LlmClient } from '../llm/client.js';
import { createReadHandler, type ReadInput, type ReadingCheck } from './read-handler.js';
import {
  InMemoryRecordStore,
  monthOf,
  readingKey,
  type RawReading,
  type ReadingKey,
  type RecordStore,
} from './record-store.js';

const RULE = 'This market resolves YES if X happens before the deadline.';
const SHA = hashDescription(RULE);
const NOW = new Date('2026-11-17T09:01:00.000Z');
const MONTH = monthOf(NOW);

const VALID = JSON.stringify({
  resolve_sim: ['Resolve SIM se X acontecer.'],
  resolve_nao: ['Senão, NÃO.'],
  fonte: 'Fonte oficial',
  anula_se: [],
  prazo: null,
  pegadinhas: [],
  ambiguidades: [],
});
// Missing `resolve_sim`: the guard rejects it after the call was billed.
const INVALID = JSON.stringify({ resolve_nao: ['x'], fonte: 'y', anula_se: [], prazo: null });

const USAGE = { input: 1000, output: 2000, cacheRead: 0, cacheWrite: 0 };
// claude-haiku-5-5 at US$ 0.10 / 0.50 per MTok.
const COST = 1000 * 0.1e-6 + 2000 * 0.5e-6;

function input(overrides: Partial<ReadInput> = {}): ReadInput {
  return {
    event_id: 'ev1',
    sha256: SHA,
    run_started_at: '2026-11-17T09:00:00.000Z',
    model: 'claude-haiku-5-5',
    prompt_version: 'v4',
    timeout_ms: 1_000,
    ...overrides,
  };
}

function market(): MarketToDigest {
  return {
    eventId: 'ev1',
    polymarketId: 'pm1',
    tema: null,
    liquidez: null,
    status: 'active',
    input: {
      question: 'Will X happen?',
      description: RULE,
      slug: null,
      endDate: null,
      outcomes: null,
    },
  };
}

/** A store that writes every call it receives into the shared call log. */
class LoggingStore implements RecordStore {
  constructor(
    private readonly inner: RecordStore,
    private readonly calls: string[],
  ) {}
  async getReading(key: ReadingKey): Promise<RawReading | null> {
    const found = await this.inner.getReading(key);
    this.calls.push(found === null ? 'store-get' : 'store-get(hit)');
    return found;
  }
  async putReading(reading: RawReading): Promise<void> {
    this.calls.push('store-put');
    await this.inner.putReading(reading);
  }
  async readSpend(month: string): Promise<number> {
    this.calls.push('spend-read');
    return this.inner.readSpend(month);
  }
  async addSpend(month: string, usd: number): Promise<void> {
    this.calls.push('spend-add');
    await this.inner.addSpend(month, usd);
  }
}

interface Setup {
  calls: string[];
  logs: string[];
  store: InMemoryRecordStore;
  persisted: DigestRows[];
}

function setup(
  options: {
    check?: ReadingCheck;
    completion?: Partial<CompletionResult> | (() => Promise<CompletionResult>);
    persist?: (call: number) => RecordOutcome;
    capUsd?: number;
  } = {},
) {
  const s: Setup = { calls: [], logs: [], store: new InMemoryRecordStore(), persisted: [] };
  const model: LlmClient = {
    complete: () => {
      s.calls.push('model');
      if (typeof options.completion === 'function') return options.completion();
      return Promise.resolve({
        text: VALID,
        stop: 'ok' as CompletionStop,
        usage: USAGE,
        ...options.completion,
      });
    },
  };
  let persistCalls = 0;
  const handler = createReadHandler({
    checkReading: () => {
      s.calls.push('supabase-check');
      return Promise.resolve(options.check ?? { status: 'todo', market: market() });
    },
    store: new LoggingStore(s.store, s.calls),
    clientForRoute: () => model,
    persist: (rows) => {
      persistCalls += 1;
      s.calls.push('persist');
      const outcome = options.persist?.(persistCalls) ?? 'inserted';
      s.persisted.push(rows);
      return Promise.resolve(outcome);
    },
    monthlyCapUsd: options.capUsd ?? 3,
    now: () => NOW,
    log: (line) => s.logs.push(line),
  });
  return { handler, s };
}

test('retry depois de falha na escrita do Supabase: o modelo é chamado uma vez só', async () => {
  const sequences: string[][] = [];
  const reasons: string[] = [];
  const { handler, s } = setup({
    persist: (call) => {
      if (call === 1) throw new Error('supabase fora do ar');
      return 'inserted';
    },
  });

  await assert.rejects(handler(input()), /supabase fora do ar/);
  reasons.push('throws');
  sequences.push(s.calls.splice(0));

  const second = await handler(input());
  reasons.push(second.reason);
  sequences.push(s.calls.splice(0));

  // The whole sequence, not the final state: calling the model twice would
  // reach the same final state and is exactly the bug this guards against.
  assert.deepEqual(sequences, [
    ['supabase-check', 'store-get', 'spend-read', 'model', 'store-put', 'spend-add', 'persist'],
    ['supabase-check', 'store-get(hit)', 'persist'],
  ]);
  assert.deepEqual(reasons, ['throws', 'REPLAYED']);
  assert.equal(await s.store.readSpend(MONTH), COST, 'o retry não pode somar o gasto de novo');
});

test('caminho feliz: OK, um item bruto gravado e as linhas do digest com leitura_n 1', async () => {
  const { handler, s } = setup();
  const result = await handler(input());
  assert.equal(result.reason, 'OK');
  const raw = await s.store.getReading(readingKey(SHA, '2026-11-17T09:00:00.000Z', 'ev1'));
  assert.equal(raw?.raw_text, VALID);
  assert.equal(raw?.stop, 'ok');
  assert.equal(raw?.route, 'anthropic:claude-haiku-5-5');
  assert.equal(raw?.cost_usd, COST);
  assert.equal(s.persisted.length, 1);
  assert.equal(s.persisted[0]?.digest['leitura_n'], 1);
  assert.equal(s.persisted[0]?.digest['model'], 'claude-haiku-5-5');
  assert.equal(s.persisted[0]?.digest['description_sha256'], SHA);
});

test('ALREADY_DONE: leitura já no Supabase não chama o modelo nem o DynamoDB', async () => {
  const { handler, s } = setup({ check: { status: 'done' } });
  const result = await handler(input());
  assert.equal(result.reason, 'ALREADY_DONE');
  assert.deepEqual(s.calls, ['supabase-check']);
});

test('STALE: o texto mudou desde o plano, nada é pago', async () => {
  const { handler, s } = setup({ check: { status: 'stale' } });
  const result = await handler(input());
  assert.equal(result.reason, 'STALE');
  assert.deepEqual(s.calls, ['supabase-check']);
});

test('BUDGET: teto do mês atingido para antes da chamada paga', async () => {
  const { handler, s } = setup({ capUsd: 3 });
  await s.store.addSpend(MONTH, 3);
  const result = await handler(input());
  assert.equal(result.reason, 'BUDGET');
  assert.deepEqual(s.calls, ['supabase-check', 'store-get', 'spend-read']);
});

test('BUDGET: abaixo do teto ainda chama', async () => {
  const { handler, s } = setup({ capUsd: 3 });
  await s.store.addSpend(MONTH, 2.99);
  const result = await handler(input());
  assert.equal(result.reason, 'OK');
  assert.ok(s.calls.includes('model'));
});

test('CONFIG_ERROR: modelo sem rota para antes de qualquer leitura ou chamada', async () => {
  const { handler, s } = setup();
  const result = await handler(input({ model: 'claude-sonnet-5' }));
  assert.equal(result.reason, 'CONFIG_ERROR');
  assert.deepEqual(s.calls, []);
});

test('SCHEMA_INVALID: a saída inválida ainda deixa o item bruto e soma o gasto', async () => {
  const { handler, s } = setup({ completion: { text: INVALID } });
  const result = await handler(input());
  assert.equal(result.reason, 'SCHEMA_INVALID');
  const raw = await s.store.getReading(readingKey(SHA, '2026-11-17T09:00:00.000Z', 'ev1'));
  assert.equal(raw?.raw_text, INVALID);
  assert.equal(await s.store.readSpend(MONTH), COST);
  assert.equal(s.persisted.length, 0, 'saída inválida não pode chegar ao Supabase');
});

test('TRUNCATED e não BUDGET: truncagem pede teto maior, não é falta de verba', async () => {
  const { handler, s } = setup({ completion: { text: null, stop: 'truncated' } });
  const result = await handler(input());
  assert.equal(result.reason, 'TRUNCATED');
  const raw = await s.store.getReading(readingKey(SHA, '2026-11-17T09:00:00.000Z', 'ev1'));
  assert.equal(raw?.stop, 'truncated');
  assert.equal(await s.store.readSpend(MONTH), COST);
});

test('REFUSED: recusa vira REFUSED, com item bruto e sem escrita no Supabase', async () => {
  const { handler, s } = setup({ completion: { text: null, stop: 'refusal' } });
  const result = await handler(input());
  assert.equal(result.reason, 'REFUSED');
  assert.equal(s.store.readingCount(), 1);
  assert.equal(s.persisted.length, 0);
});

test('MODEL_ERROR: falha de transporte não deixa item bruto nem soma gasto', async () => {
  const { handler, s } = setup({ completion: () => Promise.reject(new Error('503')) });
  const result = await handler(input());
  assert.equal(result.reason, 'MODEL_ERROR');
  assert.equal(s.store.readingCount(), 0);
  assert.equal(await s.store.readSpend(MONTH), 0);
});

test('TIMEOUT: o prazo do handler vale mesmo se o cliente não respeitar o dele', async () => {
  const { handler, s } = setup({ completion: () => new Promise<never>(() => undefined) });
  const result = await handler(input({ timeout_ms: 20 }));
  assert.equal(result.reason, 'TIMEOUT');
  assert.equal(s.store.readingCount(), 0);
});

test('duplicate do Supabase vira ALREADY_DONE; incomplete vira INCOMPLETE', async () => {
  const dup = setup({ persist: () => 'duplicate' });
  assert.equal((await dup.handler(input())).reason, 'ALREADY_DONE');
  const half = setup({ persist: () => 'incomplete' });
  assert.equal((await half.handler(input())).reason, 'INCOMPLETE');
});

test('replay de uma saída inválida devolve o mesmo motivo sem pagar de novo', async () => {
  const { handler, s } = setup({ completion: { text: INVALID } });
  assert.equal((await handler(input())).reason, 'SCHEMA_INVALID');
  s.calls.splice(0);
  assert.equal((await handler(input())).reason, 'SCHEMA_INVALID');
  assert.deepEqual(s.calls, ['supabase-check', 'store-get(hit)']);
  assert.equal(await s.store.readSpend(MONTH), COST);
});

test('uma linha de log JSON por chamada, com o motivo', async () => {
  const { handler, s } = setup();
  await handler(input());
  assert.equal(s.logs.length, 1);
  const line = JSON.parse(s.logs[0] ?? '{}') as Record<string, unknown>;
  assert.equal(line['component'], 'aws_digest_read');
  assert.equal(line['reason'], 'OK');
  assert.equal(line['event_id'], 'ev1');
  assert.equal(line['cost_usd'], COST);
});

test('entrada malformada é CONFIG_ERROR, sem tocar em nada', async () => {
  const { handler, s } = setup();
  const result = await handler({ ...input(), sha256: '' });
  assert.equal(result.reason, 'CONFIG_ERROR');
  assert.deepEqual(s.calls, []);
});
