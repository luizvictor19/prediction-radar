import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import type { CompletionResult, LlmClient } from '../../src/llm/client.js';
import { hashDescription } from '../../src/digest/digest.js';
import { createHandler, type DigestEvent } from './handler.js';
import { replayClientFor, type Recordings } from './replay-client.js';
import { InMemoryStore } from './store.js';

interface GoldenItem {
  id: string;
  headline: string;
  rule_text: string;
}

const here = new URL('.', import.meta.url);
const golden = JSON.parse(readFileSync(new URL('golden-rules.json', here), 'utf8')) as GoldenItem[];
const recordings = JSON.parse(
  readFileSync(new URL('recorded-outputs.json', here), 'utf8'),
) as Recordings;

const NOW = new Date('2026-11-16T12:00:00.000Z');

function item(id: string): DigestEvent {
  const found = golden.find((g) => g.id === id);
  if (found === undefined) throw new Error(`golden item missing: ${id}`);
  return { rule_text: found.rule_text, headline: found.headline };
}

function fixedClient(result: Partial<CompletionResult>): () => LlmClient {
  return () => ({
    complete: () =>
      Promise.resolve({
        text: null,
        stop: 'ok',
        usage: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0 },
        ...result,
      }),
  });
}

function setup(clientFor: (sha256: string) => LlmClient, timeoutMs = 1_000) {
  const store = new InMemoryStore();
  const logs: string[] = [];
  const handler = createHandler({
    clientFor,
    store,
    timeoutMs,
    now: () => NOW,
    log: (line) => logs.push(line),
  });
  return { handler, store, logs };
}

describe('aws digest slice handler', () => {
  it('warships: the trap survives with a passage that is in the rule, and the record is keyed by rule and reading', async () => {
    const event = item('warships-hormuz');
    const { handler, store } = setup(replayClientFor(recordings));

    const result = await handler(event);

    assert.equal(result.reason, 'OK');
    const cargo = result.findings.find((f) =>
      f.trecho?.includes('Military cargo or support vessels'),
    );
    assert.ok(cargo, 'the cargo-ship trap must survive the guard');
    assert.ok(event.rule_text.includes('Military cargo or support vessels will be considered'));

    const sha = hashDescription(event.rule_text);
    assert.equal(result.sha256, sha);
    const stored = await store.get(`RULE#${sha}`, 'READING#2026-11-16T12:00:00.000Z');
    assert.ok(stored, 'the reading must be written under RULE#<sha256> / READING#<iso>');
    assert.deepEqual(stored.findings, result.findings);
  });

  it('injection: a passage the rule does not contain is pruned by code, not trusted', async () => {
    const { handler } = setup(replayClientFor(recordings));

    const result = await handler(item('injection-fabricated-quote'));

    assert.equal(result.reason, 'OK');
    assert.deepEqual(result.findings, []);
    assert.equal(result.pruned, 1);
  });

  it('malformed output: SCHEMA_INVALID and nothing is written', async () => {
    const { handler, store } = setup(fixedClient({ text: JSON.stringify({ not: 'a digest' }) }));

    const result = await handler(item('fed-hike'));

    assert.equal(result.reason, 'SCHEMA_INVALID');
    assert.equal(store.size(), 0);
  });

  it('a model that hangs: TIMEOUT at the deadline and nothing is written', async () => {
    const hangs = () => ({ complete: () => new Promise<CompletionResult>(() => {}) });
    const { handler, store } = setup(hangs, 50);

    const result = await handler(item('fed-hike'));

    assert.equal(result.reason, 'TIMEOUT');
    assert.equal(store.size(), 0);
  });

  it('output cut at the token cap: BUDGET and nothing is written', async () => {
    const { handler, store } = setup(fixedClient({ stop: 'truncated' }));

    const result = await handler(item('fed-hike'));

    assert.equal(result.reason, 'BUDGET');
    assert.equal(store.size(), 0);
  });

  it('refusal: REFUSED and nothing is written', async () => {
    const { handler, store } = setup(fixedClient({ stop: 'refusal' }));

    const result = await handler(item('fed-hike'));

    assert.equal(result.reason, 'REFUSED');
    assert.equal(store.size(), 0);
  });

  it('logs exactly one JSON line per call, with reason, latency, tokens and sha256', async () => {
    const event = item('fed-hike');
    const { handler, logs } = setup(fixedClient({ stop: 'truncated' }));

    await handler(event);

    assert.equal(logs.length, 1);
    const line = JSON.parse(logs[0] ?? '') as Record<string, unknown>;
    assert.equal(line['component'], 'aws_digest_slice');
    assert.equal(line['reason'], 'BUDGET');
    assert.equal(line['sha256'], hashDescription(event.rule_text));
    assert.equal(typeof line['latency_ms'], 'number');
    assert.deepEqual(line['tokens'], { input: null, output: null });
  });

  it('the store refuses to overwrite a reading: a retried call cannot replace it silently', async () => {
    const { handler, store } = setup(replayClientFor(recordings));
    const event = item('warships-hormuz');

    assert.equal((await handler(event)).reason, 'OK');
    const second = await handler(event);

    assert.equal(second.reason, 'STORE_CONFLICT');
    assert.equal(store.size(), 1);
  });
});
