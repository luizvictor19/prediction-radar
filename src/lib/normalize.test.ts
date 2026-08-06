import { test } from 'node:test';
import assert from 'node:assert/strict';

// O módulo puxa o categorizador, que puxa o cliente do Supabase. Criar o cliente
// não abre conexão — os valores abaixo só permitem o import.
process.env['SUPABASE_URL'] ??= 'http://localhost:54321';
process.env['SUPABASE_SERVICE_KEY'] ??= 'test-key';

const { gammaGameStartTime, gammaEventMetadata, gammaToEvent } = await import('./normalize.js');

type GammaMarket = Parameters<typeof gammaGameStartTime>[0];
type GammaEvent = NonNullable<Parameters<typeof gammaEventMetadata>[0]>;

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

test('o market aninhado em /events não tem events[] — a rede vem do pai explícito', () => {
  // Sem o segundo argumento, a terceira rede de `gammaGameStartTime` sumiria
  // justamente no caminho novo de coleta.
  const parent = { id: 'e1', slug: 'cs2-a-b-2026-08-06', startTime: '2026-08-06T18:30:00Z' };
  assert.equal(gammaGameStartTime(market(), parent), '2026-08-06T18:30:00.000Z');
});

// --- event_metadata --------------------------------------------------------

function parentEvent(overrides: Partial<GammaEvent> = {}): GammaEvent {
  return { id: 'e1', slug: 'cs2-vita-bw-2026-08-06', ...overrides } as GammaEvent;
}

const TEAMS = [
  { id: 3270870, name: 'Vitality Academy', league: 'csgo', abbreviation: 'vita', providerId: 138618, ordering: 'home' },
  { id: 169138, name: 'Bushido Wildcats', league: 'csgo', abbreviation: 'bw', providerId: 136934, ordering: 'away' },
];

/** `gammaToEvent` exige outcomes/outcomePrices; os testes de horário, não. */
function m2(base: GammaMarket): GammaMarket {
  return { ...base, outcomes: '["A","B"]', outcomePrices: '["0.5","0.5"]' } as GammaMarket;
}

test('event_metadata sai do evento, não da raiz do market', () => {
  // A raiz do market nunca traz o campo: 0 de 464 markets de esports medidos.
  // A versão anterior lia de lá e deixou a coluna NULL desde a migration 003.
  const m = market({ eventMetadata: { league: 'NUNCA LER DAQUI' } } as Partial<GammaMarket>);
  const parent = parentEvent({ eventMetadata: { league: 'European Pro League', leagueTier: '5' } });

  const meta = gammaToEvent(m2(m), 'other', parent).event_metadata;
  assert.equal(meta?.['league'], 'European Pro League');
  assert.equal(meta?.['leagueTier'], '5');
});

test('teams e sport entram com prefixo, fora do vocabulário da Gamma', () => {
  // Prefixo snake_case não colide com o camelCase de `eventMetadata`, que é
  // aberto e cresce sem aviso. Colisão aqui seria perda silenciosa de dado.
  const meta = gammaEventMetadata(
    parentEvent({ eventMetadata: { league: 'LPL' }, teams: TEAMS, sport: { sport: 'cs2' } }),
  );

  assert.equal(meta?.['league'], 'LPL');
  assert.deepEqual(meta?.['polymarket_teams'], TEAMS);
  assert.deepEqual(meta?.['polymarket_sport'], { sport: 'cs2' });
  // O id do evento não tem coluna própria e é a chave para re-buscá-lo.
  assert.equal(meta?.['polymarket_event_id'], 'e1');
});

test('evento sem metadado nenhum devolve null, não objeto vazio', () => {
  // Objeto vazio sobrescreveria no upsert um metadado já gravado.
  assert.equal(gammaEventMetadata(parentEvent()), null);
  assert.equal(gammaEventMetadata(null), null);
});

test('teams vazio não vira chave — só /events preenche, /markets não', () => {
  const meta = gammaEventMetadata(parentEvent({ eventMetadata: { league: 'LPL' }, teams: [] }));
  assert.equal('polymarket_teams' in (meta ?? {}), false);
});

test('series cai para o evento pai — o market de esports vem sem ela', () => {
  const parent = parentEvent({
    series: [{ id: '10310', slug: 'counter-strike', recurrence: 'daily' }],
  });
  const row = gammaToEvent(m2(market()), 'other', parent);

  assert.equal(row.series_id, '10310');
  assert.equal(row.series_slug, 'counter-strike');
  assert.equal(row.series_recurrence, 'daily');
  // O slug do evento é o mesmo `event_group_slug` que o embed de /markets dava.
  assert.equal(row.event_group_slug, 'cs2-vita-bw-2026-08-06');
});

test('sem evento pai explícito, o embed de /markets ainda serve', () => {
  // A varredura por volume e o detector de resolvidos continuam em /markets.
  const m = m2(market({ events: [{ id: 'e9', slug: 'cs2-x-y-2026-08-06', eventMetadata: { league: 'ESEA' } }] }));
  const row = gammaToEvent(m);

  assert.equal(row.event_group_slug, 'cs2-x-y-2026-08-06');
  assert.equal(row.event_metadata?.['league'], 'ESEA');
  // Mas o embed não tem teams: é por isso que a varredura por volume remove a
  // chave do payload em vez de gravar esta versão incompleta.
  assert.equal('polymarket_teams' in (row.event_metadata ?? {}), false);
});
