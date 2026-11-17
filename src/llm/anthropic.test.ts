import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';

// A local fake of the Messages endpoint: nothing leaves the machine and no real
// key is read. The SDK client inside the adapter is created on the first call,
// so the environment set here is the one it sees.

interface Captured {
  body: Record<string, unknown>;
}

function sse(events: ReadonlyArray<Record<string, unknown>>): string {
  return events.map((e) => `event: ${String(e['type'])}\ndata: ${JSON.stringify(e)}\n\n`).join('');
}

const STREAM = sse([
  {
    type: 'message_start',
    message: {
      id: 'msg_test',
      type: 'message',
      role: 'assistant',
      model: 'claude-haiku-5-5',
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: {
        input_tokens: 120,
        output_tokens: 1,
        cache_read_input_tokens: 30,
        cache_creation_input_tokens: 0,
      },
    },
  },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '{"ok":' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'true}' } },
  { type: 'content_block_stop', index: 0 },
  {
    type: 'message_delta',
    delta: { stop_reason: 'end_turn', stop_sequence: null },
    usage: { output_tokens: 4200 },
  },
  { type: 'message_stop' },
]);

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

async function withFakeApi(run: (captured: Captured[]) => Promise<void>): Promise<void> {
  const captured: Captured[] = [];
  const server = createServer((req, res) => {
    void readBody(req).then((raw) => {
      const body = JSON.parse(raw) as Record<string, unknown>;
      captured.push({ body });
      if (body['stream'] === true) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end(STREAM);
        return;
      }
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error' } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  process.env['ANTHROPIC_API_KEY'] = 'test-key';
  process.env['ANTHROPIC_BASE_URL'] = `http://127.0.0.1:${port}`;
  delete process.env['ANTHROPIC_AUTH_TOKEN'];
  try {
    await run(captured);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test('a chamada com o teto de 32.000 tokens da digestão chega à API, por streaming', async () => {
  await withFakeApi(async (captured) => {
    const { anthropicClient } = await import('./anthropic.js');

    // 32,000 is the digest ceiling (`MAX_TOKENS` in src/digest/digest.ts). Above
    // ~21,333 the SDK refuses a non-streaming request before sending it, so
    // without streaming this call never reaches the server.
    const result = await anthropicClient.complete({
      model: 'claude-haiku-5-5',
      system: 'sistema',
      user: 'usuário',
      schema: { type: 'object' },
      maxTokens: 32_000,
      timeoutMs: 5_000,
    });

    assert.equal(captured.length, 1, 'a requisição tem que chegar ao servidor');
    assert.equal(captured[0]?.body['stream'], true);
    assert.equal(captured[0]?.body['max_tokens'], 32_000);
    assert.deepEqual(result, {
      text: '{"ok":true}',
      stop: 'ok',
      usage: { input: 120, output: 4200, cacheRead: 30, cacheWrite: 0 },
    });
  });
});
