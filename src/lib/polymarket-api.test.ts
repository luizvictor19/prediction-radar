import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchMarketsByIds, MAX_IDS_PER_REQUEST } from './polymarket-api.js';

/**
 * As duas armadilhas do filtro `id=` falham em silêncio: sem `limit` explícito a
 * Gamma devolve 20 de 100, e sem `closed=true` devolve vazio justamente para os
 * markets resolvidos. Nenhuma das duas produz erro — só resultado errado. Daí o
 * teste ser sobre a URL montada.
 */
async function captureUrl(run: () => Promise<unknown>): Promise<string> {
  const original = globalThis.fetch;
  let captured = '';

  globalThis.fetch = (input: string | URL | Request) => {
    captured = String(input);
    return Promise.resolve(new Response('[]', { headers: { 'content-type': 'application/json' } }));
  };

  try {
    await run();
  } finally {
    globalThis.fetch = original;
  }

  return captured;
}

test('manda limit explícito igual ao tamanho do lote', async () => {
  const ids = Array.from({ length: 42 }, (_, i) => `id${i}`);
  const url = await captureUrl(() => fetchMarketsByIds(ids, { closed: false }));

  assert.match(url, /[?&]limit=42(&|$)/);
  assert.equal(url.match(/[&?]id=/g)?.length, 42);
});

test('closed vai explícito na URL nos dois sentidos', async () => {
  const openUrl = await captureUrl(() => fetchMarketsByIds(['a'], { closed: false }));
  assert.match(openUrl, /[?&]closed=false(&|$)/);

  const closedUrl = await captureUrl(() => fetchMarketsByIds(['a'], { closed: true }));
  assert.match(closedUrl, /[?&]closed=true(&|$)/);
});

test('lote acima de 100 ids é erro, não truncamento calado', async () => {
  const ids = Array.from({ length: MAX_IDS_PER_REQUEST + 1 }, (_, i) => `id${i}`);
  await assert.rejects(() => fetchMarketsByIds(ids, { closed: false }), /excede o máximo/);
});

test('lote vazio não vira requisição', async () => {
  const url = await captureUrl(() => fetchMarketsByIds([], { closed: false }));
  assert.equal(url, '');
});
