import { test } from 'node:test';
import assert from 'node:assert/strict';

import { GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';

import {
  ConditionalCheckFailed,
  DynamoRecordStore,
  InMemoryRecordStore,
  monthOf,
  readingKey,
  spendKey,
  type DocumentSender,
  type RawReading,
} from './record-store.js';

function reading(overrides: Partial<RawReading> = {}): RawReading {
  return {
    ...readingKey('abc', '2026-11-17T09:00:00.000Z', 'ev1'),
    event_id: 'ev1',
    sha256: 'abc',
    model: 'claude-haiku-5-5',
    route: 'anthropic:claude-haiku-5-5',
    prompt_version: 'v4',
    raw_text: '{"x":1}',
    stop: 'ok',
    tokens_input: 10,
    tokens_output: 20,
    tokens_cache_read: 0,
    tokens_cache_write: 0,
    cost_usd: 0.001,
    latency_ms: 5,
    recorded_at: '2026-11-17T09:00:05.000Z',
    ...overrides,
  };
}

test('chave: a leitura bruta é RULE#<sha> e READING#<início da corrida>#<evento>', () => {
  assert.deepEqual(readingKey('abc', '2026-11-17T09:00:00.000Z', 'ev1'), {
    PK: 'RULE#abc',
    SK: 'READING#2026-11-17T09:00:00.000Z#ev1',
  });
});

test('chave: o contador de gasto é um item por mês UTC', () => {
  assert.equal(monthOf(new Date('2026-11-30T23:59:59.999Z')), '2026-11');
  assert.equal(monthOf(new Date('2026-12-01T00:00:00.000Z')), '2026-12');
  assert.deepEqual(spendKey('2026-11'), { PK: 'SPEND#2026-11', SK: 'TOTAL' });
});

test('memória: a segunda gravação da mesma chave é recusada e a primeira fica', async () => {
  const store = new InMemoryRecordStore();
  await store.putReading(reading({ raw_text: 'primeira' }));
  await assert.rejects(
    store.putReading(reading({ raw_text: 'segunda' })),
    (err: unknown) => err instanceof ConditionalCheckFailed,
  );
  const kept = await store.getReading(readingKey('abc', '2026-11-17T09:00:00.000Z', 'ev1'));
  assert.equal(kept?.raw_text, 'primeira');
});

test('memória: o gasto do mês soma e meses diferentes não se misturam', async () => {
  const store = new InMemoryRecordStore();
  assert.equal(await store.readSpend('2026-11'), 0);
  await store.addSpend('2026-11', 0.25);
  await store.addSpend('2026-11', 0.5);
  await store.addSpend('2026-12', 1);
  assert.equal(await store.readSpend('2026-11'), 0.75);
  assert.equal(await store.readSpend('2026-12'), 1);
});

class FakeSender implements DocumentSender {
  readonly sent: (GetCommand | PutCommand | UpdateCommand)[] = [];
  constructor(private readonly answer: (command: object) => unknown = () => ({})) {}
  send(command: GetCommand | PutCommand | UpdateCommand): Promise<unknown> {
    this.sent.push(command);
    try {
      return Promise.resolve(this.answer(command));
    } catch (err) {
      return Promise.reject(err instanceof Error ? err : new Error(String(err)));
    }
  }
}

test('dynamo: a gravação leva a condição que recusa sobrescrever', async () => {
  const sender = new FakeSender();
  await new DynamoRecordStore(sender, 'tabela').putReading(reading());
  const put = sender.sent[0];
  assert.ok(put instanceof PutCommand, 'o comando enviado não é um PutCommand');
  assert.equal(put.input.TableName, 'tabela');
  assert.equal(put.input.ConditionExpression, 'attribute_not_exists(PK)');
});

test('dynamo: a recusa condicional da AWS vira ConditionalCheckFailed', async () => {
  const sender = new FakeSender(() => {
    const err = new Error('The conditional request failed');
    err.name = 'ConditionalCheckFailedException';
    throw err;
  });
  await assert.rejects(
    new DynamoRecordStore(sender, 'tabela').putReading(reading()),
    (err: unknown) => err instanceof ConditionalCheckFailed,
  );
});

test('dynamo: outra falha da AWS sobe como veio', async () => {
  const sender = new FakeSender(() => {
    throw new Error('throttled');
  });
  await assert.rejects(new DynamoRecordStore(sender, 'tabela').putReading(reading()), /throttled/);
});

test('dynamo: leitura consistente, item ausente vira null e gasto ausente vira 0', async () => {
  const sender = new FakeSender(() => ({}));
  const store = new DynamoRecordStore(sender, 'tabela');
  assert.equal(await store.getReading({ PK: 'RULE#a', SK: 'READING#b' }), null);
  assert.equal(await store.readSpend('2026-11'), 0);
  for (const command of sender.sent) {
    assert.ok(command instanceof GetCommand, 'o comando enviado não é um GetCommand');
    assert.equal(command.input.ConsistentRead, true);
  }
});

test('dynamo: somar gasto é um ADD atômico no item do mês', async () => {
  const sender = new FakeSender();
  await new DynamoRecordStore(sender, 'tabela').addSpend('2026-11', 0.002);
  const update = sender.sent[0];
  assert.ok(update instanceof UpdateCommand, 'o comando enviado não é um UpdateCommand');
  assert.deepEqual(update.input.Key, { PK: 'SPEND#2026-11', SK: 'TOTAL' });
  assert.equal(update.input.UpdateExpression, 'ADD spend_usd :usd');
  assert.deepEqual(update.input.ExpressionAttributeValues, { ':usd': 0.002 });
});
