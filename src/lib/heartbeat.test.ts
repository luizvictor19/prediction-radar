import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env['SUPABASE_URL'] ??= 'http://localhost:54321';
process.env['SUPABASE_SERVICE_KEY'] ??= 'test-key';

const { shouldWriteHeartbeat, resetHeartbeatState } = await import('./heartbeat.js');

const T0 = Date.parse('2026-08-06T12:00:00Z');

test('o primeiro batimento de um componente sempre escreve', () => {
  resetHeartbeatState();
  assert.equal(shouldWriteHeartbeat('discovery_collector', T0), true);
});

test('dentro da janela de 60s não escreve de novo', () => {
  // A watchlist tica a cada 5s: sem isto seriam ~17k upserts/dia só dela.
  resetHeartbeatState();
  shouldWriteHeartbeat('watchlist_collector', T0);

  assert.equal(shouldWriteHeartbeat('watchlist_collector', T0 + 5_000), false);
  assert.equal(shouldWriteHeartbeat('watchlist_collector', T0 + 59_000), false);
});

test('passada a janela, escreve', () => {
  resetHeartbeatState();
  shouldWriteHeartbeat('watchlist_collector', T0);
  assert.equal(shouldWriteHeartbeat('watchlist_collector', T0 + 60_000), true);
});

test('a janela é por componente, não global', () => {
  // Senão o coletor de tick rápido engoliria o batimento do de tick lento.
  resetHeartbeatState();
  shouldWriteHeartbeat('watchlist_collector', T0);
  assert.equal(shouldWriteHeartbeat('discovery_collector', T0), true);
});

test('ciclo com erro fura a janela', () => {
  // A transição de estado é o que o monitor mais quer ver; atrasá-la em até um
  // minuto não economizaria nada relevante.
  resetHeartbeatState();
  shouldWriteHeartbeat('open_legs_collector', T0);
  assert.equal(shouldWriteHeartbeat('open_legs_collector', T0 + 1_000, true), true);
});

test('escrita forçada reinicia a janela', () => {
  resetHeartbeatState();
  shouldWriteHeartbeat('open_legs_collector', T0, true);
  assert.equal(shouldWriteHeartbeat('open_legs_collector', T0 + 30_000), false);
});
