import { test } from 'node:test';
import assert from 'node:assert/strict';

// O módulo puxa o categorizador, que puxa o cliente do Supabase. Criar o cliente
// não abre conexão — os valores abaixo só permitem o import.
process.env['SUPABASE_URL'] ??= 'http://localhost:54321';
process.env['SUPABASE_SERVICE_KEY'] ??= 'test-key';

const { gammaGameStartTime } = await import('./normalize.js');

type GammaMarket = Parameters<typeof gammaGameStartTime>[0];

function market(overrides: Partial<GammaMarket> = {}): GammaMarket {
  return { id: 'm1', slug: 'cs2-a-b-2026-08-06', ...overrides } as GammaMarket;
}

test('gameStartTime vem sem T e sem Z — normaliza para ISO', () => {
  // Formato medido na Gamma em 2026-08-06, em 171/171 markets de esports.
  assert.equal(
    gammaGameStartTime(market({ gameStartTime: '2026-08-06 18:30:00+00' })),
    '2026-08-06T18:30:00.000Z',
  );
});

test('offset diferente de zero é respeitado, não assumido UTC', () => {
  assert.equal(
    gammaGameStartTime(market({ gameStartTime: '2026-08-06 18:30:00-03' })),
    '2026-08-06T21:30:00.000Z',
  );
});

test('eventStartTime cobre quando gameStartTime falta', () => {
  assert.equal(
    gammaGameStartTime(market({ eventStartTime: '2026-08-06T18:30:00Z' })),
    '2026-08-06T18:30:00.000Z',
  );
});

test('events[0].startTime é a última rede — só ele tem cobertura total em ISO', () => {
  assert.equal(
    gammaGameStartTime(market({ events: [{ id: 'e', slug: 's', startTime: '2026-08-06T18:30:00Z' }] })),
    '2026-08-06T18:30:00.000Z',
  );
});

test('a ordem de preferência é gameStartTime, eventStartTime, events[0]', () => {
  const m = market({
    gameStartTime: '2026-08-06 18:30:00+00',
    eventStartTime: '2026-08-06T19:00:00Z',
    events: [{ id: 'e', slug: 's', startTime: '2026-08-06T20:00:00Z' }],
  });
  assert.equal(gammaGameStartTime(m), '2026-08-06T18:30:00.000Z');
});

test('market sem nenhum dos três não inventa âncora', () => {
  // Cai na faixa lenta da watchlist em vez de virar Invalid Date no banco.
  assert.equal(gammaGameStartTime(market()), null);
  assert.equal(gammaGameStartTime(market({ gameStartTime: null, eventStartTime: null })), null);
  assert.equal(gammaGameStartTime(market({ gameStartTime: 'não é data' })), null);
});
