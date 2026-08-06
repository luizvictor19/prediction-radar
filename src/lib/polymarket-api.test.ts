import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  fetchMarketsByIds,
  fetchEsportsEvents,
  fetchEventsBySlugs,
  MAX_IDS_PER_REQUEST,
  MAX_EVENTS_PER_REQUEST,
} from './polymarket-api.js';

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

/**
 * `/events` repete as duas armadilhas do filtro por id e acrescenta uma
 * terceira: `limit` satura em 100 e pedir 500 devolve 100 sem erro. Como todas
 * falham em silêncio, o teste é sobre a URL montada.
 */

test('a paginação de eventos carrega a tag e o closed explícito', async () => {
  const url = await captureUrl(() => fetchEsportsEvents({ offset: 300, order: 'startDate', ascending: false }));

  assert.match(url, /\/events\?/);
  assert.match(url, /[?&]tag_slug=esports(&|$)/);
  assert.match(url, /[?&]closed=false(&|$)/);
  assert.match(url, /[?&]offset=300(&|$)/);
  assert.match(url, /[?&]order=startDate(&|$)/);
  assert.match(url, /[?&]ascending=false(&|$)/);
});

test('o limit default não passa do teto de 100 da Gamma', async () => {
  // Pedir mais devolve 100 calado — o default tem que já ser o teto.
  const url = await captureUrl(() => fetchEsportsEvents({}));
  assert.match(url, new RegExp(`[?&]limit=${MAX_EVENTS_PER_REQUEST}(&|$)`));
});

test('busca por slug manda limit explícito igual ao tamanho do lote', async () => {
  const slugs = Array.from({ length: 37 }, (_, i) => `cs2-a${i}-b-2026-08-06`);
  const url = await captureUrl(() => fetchEventsBySlugs(slugs, { closed: false }));

  assert.match(url, /[?&]limit=37(&|$)/);
  assert.equal(url.match(/[&?]slug=/g)?.length, 37);
});

test('busca por slug leva closed nos dois sentidos', async () => {
  const open = await captureUrl(() => fetchEventsBySlugs(['cs2-a-b-2026-08-06'], { closed: false }));
  assert.match(open, /[?&]closed=false(&|$)/);

  const closed = await captureUrl(() => fetchEventsBySlugs(['cs2-a-b-2026-08-06'], { closed: true }));
  assert.match(closed, /[?&]closed=true(&|$)/);
});

test('lote de slugs acima de 100 é erro, não 422 na cara da Gamma', async () => {
  const slugs = Array.from({ length: MAX_EVENTS_PER_REQUEST + 1 }, (_, i) => `cs2-a${i}-b-2026-08-06`);
  await assert.rejects(() => fetchEventsBySlugs(slugs, { closed: false }), /excede o máximo/);
});

test('lote de slugs vazio não vira requisição', async () => {
  assert.equal(await captureUrl(() => fetchEventsBySlugs([], { closed: false })), '');
});
