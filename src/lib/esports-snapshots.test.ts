import { test } from 'node:test';
import assert from 'node:assert/strict';

// O módulo importa o cliente do Supabase no topo, que exige env. Criar o cliente
// não abre conexão — os valores abaixo só permitem o import. Nenhum teste aqui
// toca no banco ou na rede.
process.env['SUPABASE_URL'] ??= 'http://localhost:54321';
process.env['SUPABASE_SERVICE_KEY'] ??= 'test-key';

const { toLegacySnapshotRow, gammaLiquidity, gammaVolume24h } = await import('./esports-snapshots.js');

const row = {
  event_id: 'ev1',
  captured_at: '2026-08-05T12:00:00.000Z',
  outcome: 'Team A',
  best_bid: 0.4,
  best_ask: 0.6,
  mid_price: 0.5,
  volume_24h: 120,
  liquidity: 17.4,
};

test('a linha do fallback não leva liquidity — a coluna não existe lá', () => {
  // Uma chave a mais no payload derruba o chunk inteiro no PostgREST, e o chunk
  // é de 500 linhas.
  const legacy = toLegacySnapshotRow(row);
  assert.equal('liquidity' in legacy, false);
  assert.deepEqual(legacy, {
    event_id: 'ev1',
    captured_at: '2026-08-05T12:00:00.000Z',
    outcome: 'Team A',
    best_bid: 0.4,
    best_ask: 0.6,
    mid_price: 0.5,
    volume_24h: 120,
  });
});

test('liquidez: liquidityNum manda, string é convertida, ausência é null', () => {
  assert.equal(gammaLiquidity({ liquidityNum: 17.4, liquidity: '99' }), 17.4);
  assert.equal(gammaLiquidity({ liquidity: '17.4' }), 17.4);
  assert.equal(gammaLiquidity({}), null);
  // 0 é liquidez real do market recém-nascido, não ausência de dado.
  assert.equal(gammaLiquidity({ liquidityNum: 0 }), 0);
});

test('volume 24h cai para a variante do CLOB antes de virar null', () => {
  assert.equal(gammaVolume24h({ volume24hr: 120 }), 120);
  assert.equal(gammaVolume24h({ volume24hrClob: 80 }), 80);
  assert.equal(gammaVolume24h({}), null);
});
