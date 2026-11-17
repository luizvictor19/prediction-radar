import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';

import { deepseekClient } from './deepseek.js';

// `fetch` is replaced per test: nothing leaves the machine and no real key is
// read. The adapter reads the key from the environment at call time.

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

function answerWith(finishReason: string, content: string | null): void {
  process.env['DEEPSEEK_API_KEY'] = 'test-key';
  globalThis.fetch = () =>
    Promise.resolve(
      new Response(
        JSON.stringify({
          choices: [{ message: { content }, finish_reason: finishReason }],
          usage: { prompt_tokens: 50, completion_tokens: 7, prompt_cache_hit_tokens: 10 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
}

const REQUEST = {
  model: 'deepseek-v4-flash',
  system: 'sistema',
  user: 'usuário',
  schema: { type: 'object' },
  maxTokens: 100,
  timeoutMs: 5_000,
};

test('deepseek: content_filter vira stop refusal e texto nulo, nunca ok', async () => {
  answerWith('content_filter', null);
  const result = await deepseekClient.complete(REQUEST);
  assert.equal(result.stop, 'refusal');
  assert.equal(result.text, null);
});

test('deepseek: length vira truncated', async () => {
  answerWith('length', '{"meio":');
  const result = await deepseekClient.complete(REQUEST);
  assert.equal(result.stop, 'truncated');
  assert.equal(result.text, null);
});

test('deepseek: stop devolve o texto e a entrada sem o cache contado duas vezes', async () => {
  answerWith('stop', '{"ok":true}');
  const result = await deepseekClient.complete(REQUEST);
  assert.equal(result.stop, 'ok');
  assert.equal(result.text, '{"ok":true}');
  assert.equal(result.usage.input, 40);
  assert.equal(result.usage.cacheRead, 10);
  assert.equal(result.usage.output, 7);
});
