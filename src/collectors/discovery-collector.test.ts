import { test } from 'node:test';
import assert from 'node:assert/strict';

// O módulo importa o cliente do Supabase no topo, que exige env. Criar o cliente
// não abre conexão — os valores abaixo só permitem o import. Nenhum teste aqui
// toca no banco ou na rede.
process.env['SUPABASE_URL'] ??= 'http://localhost:54321';
process.env['SUPABASE_SERVICE_KEY'] ??= 'test-key';

const { hasMatchShape, matchedPrefix, resolveCutoffMs, splitForUpsert, harvestEvents } = await import(
  './discovery-collector.js'
);

const PREFIXES = ['cs2-', 'lol-', 'dota2-'];

// Slugs reais colhidos da Gamma em 2026-08-04.
test('aceita o formato de partida, com e sem data e variante', () => {
  for (const slug of [
    'cs2-mana1-bw-2026-08-04',
    'cs2-mana1-bw-2026-08-04-game1',
    'cs2-mana1-bw-2026-08-04-total-games-2pt5',
    'cs2-yaw-guara',
    'lol-t1-geng-2026-08-04',
  ]) {
    const prefix = matchedPrefix(slug, PREFIXES);
    assert.notEqual(prefix, null, slug);
    assert.equal(hasMatchShape(slug, prefix as string), true, slug);
  }
});

test('descarta slug sem dois times — não há partida', () => {
  const prefix = matchedPrefix('cs2-major', PREFIXES);
  assert.equal(prefix, 'cs2-');
  assert.equal(hasMatchShape('cs2-major', prefix as string), false);
});

test('mercado de qualificação não bate prefixo nenhum', () => {
  assert.equal(matchedPrefix('will-furia-qualify-for-the-cblol-split-2-playoffs-2026', PREFIXES), null);
});

test('mercado fora da vertical não bate prefixo', () => {
  assert.equal(matchedPrefix('bitcoin-up-or-down-august-4', PREFIXES), null);
  // Prefixo tem que casar no começo, não em qualquer posição.
  assert.equal(matchedPrefix('nba-lol-lakers-celtics', PREFIXES), null);
});

test('ciclo frio usa o lookback como piso', () => {
  const now = Date.parse('2026-08-04T16:00:00Z');
  const { cutoffMs, coldStart } = resolveCutoffMs(now, null, 20);
  assert.equal(coldStart, true);
  assert.equal(new Date(cutoffMs).toISOString(), '2026-08-04T15:40:00.000Z');
});

test('com marca d\'água recente, pagina só até ela menos a margem', () => {
  const now = Date.parse('2026-08-04T16:00:00Z');
  const { cutoffMs, coldStart } = resolveCutoffMs(now, '2026-08-04T15:57:00Z', 20);
  assert.equal(coldStart, false);
  assert.equal(new Date(cutoffMs).toISOString(), '2026-08-04T15:55:00.000Z');
});

const PREPARED = [
  { polymarketId: 'a', event: { polymarket_id: 'a', slug: 'cs2-x-y-2026-08-04' } },
  { polymarketId: 'b', event: { polymarket_id: 'b', slug: 'cs2-w-z-2026-08-04' } },
];

test('sem a coluna aplicada, nenhuma linha leva discovered_via', () => {
  const { firstSeen, alreadyKnown } = splitForUpsert(PREPARED, new Set(['a']), false);
  assert.equal(firstSeen.length, 0);
  assert.equal(alreadyKnown.length, 2);
  for (const row of alreadyKnown) assert.equal('discovered_via' in row, false);
});

test('com a coluna, só o market visto pela primeira vez é carimbado', () => {
  const { firstSeen, alreadyKnown } = splitForUpsert(PREPARED, new Set(['a']), true);
  assert.deepEqual(firstSeen, [
    { polymarket_id: 'a', slug: 'cs2-x-y-2026-08-04', discovered_via: 'discovery' },
  ]);
  // A linha que já existia sai sem a chave: mandá-la apagaria o carimbo original.
  assert.deepEqual(alreadyKnown, [{ polymarket_id: 'b', slug: 'cs2-w-z-2026-08-04' }]);
});

test('cada lote sai com o mesmo conjunto de chaves em todas as linhas', () => {
  // O upsert do PostgREST derruba o chunk inteiro se as chaves divergirem.
  const prepared = [
    ...PREPARED,
    { polymarketId: 'c', event: { polymarket_id: 'c', slug: 'lol-t1-geng-2026-08-04' } },
  ];
  const { firstSeen, alreadyKnown } = splitForUpsert(prepared, new Set(['a', 'c']), true);

  for (const group of [firstSeen, alreadyKnown]) {
    const shapes = new Set(group.map(row => Object.keys(row).sort().join(',')));
    assert.equal(shapes.size, 1, JSON.stringify([...shapes]));
  }
  assert.equal(firstSeen.length, 2);
  assert.equal(alreadyKnown.length, 1);
});

test('marca d\'água velha não faz o ciclo furar o teto de offset', () => {
  // Processo parado 3h: perseguir a marca antiga significaria paginar muito além
  // do offset 2000, que alcança ~36min de markets. O lookback trunca.
  const now = Date.parse('2026-08-04T16:00:00Z');
  const { cutoffMs } = resolveCutoffMs(now, '2026-08-04T13:00:00Z', 20);
  assert.equal(new Date(cutoffMs).toISOString(), '2026-08-04T15:40:00.000Z');
});

// --- colheita por evento ---------------------------------------------------

type HarvestEvent = Parameters<typeof harvestEvents>[0][number];

function evt(slug: string, marketSlugs: string[]): HarvestEvent {
  return {
    id: `ev-${slug}`,
    slug,
    markets: marketSlugs.map((s, i) => ({ id: `${slug}#${i}`, slug: s })),
  } as HarvestEvent;
}

function harvest(events: HarvestEvent[], seen = new Set<string>()) {
  const capturedAt = new Map<string, string>();
  const out = harvestEvents(events, PREFIXES, seen, capturedAt, '2026-08-06T12:00:00Z');
  return { ...out, capturedAt, seen };
}

test('o filtro de prefixo continua sendo por market, não pela tag do evento', () => {
  // A tag só delimita o universo a paginar. Um evento de esports pode carregar
  // markets de jogos que a config não pediu, e eles não entram.
  const { candidates } = harvest([
    evt('cs2-vita-bw-2026-08-06', ['cs2-vita-bw-2026-08-06', 'cs2-vita-bw-2026-08-06-game1']),
    evt('val-gx-sge-2026-08-06', ['val-gx-sge-2026-08-06']),
  ]);

  assert.deepEqual(
    candidates.map(c => c.market.slug),
    ['cs2-vita-bw-2026-08-06', 'cs2-vita-bw-2026-08-06-game1'],
  );
});

test('cada candidato carrega o evento de onde veio', () => {
  // É o pai que tem teams[] e sport; perder o vínculo aqui é perder o dado.
  const { candidates } = harvest([evt('cs2-vita-bw-2026-08-06', ['cs2-vita-bw-2026-08-06-game1'])]);

  assert.equal(candidates.length, 1);
  assert.equal(candidates[0]?.parent.slug, 'cs2-vita-bw-2026-08-06');
});

test('market sem dois times é rejeitado mesmo dentro de evento de esports', () => {
  const { candidates, rejectedShape } = harvest([evt('cs2-major', ['cs2-major'])]);

  assert.equal(candidates.length, 0);
  assert.equal(rejectedShape, 1);
});

test('evento sem markets não quebra a colheita', () => {
  const noMarkets = { id: 'e', slug: 'cs2-a-b-2026-08-06' } as HarvestEvent;
  assert.equal(harvest([noMarkets]).candidates.length, 0);
});

test('seenIds atravessa as duas varreduras — pendente não duplica a linha', () => {
  // A varredura de pendentes revisita eventos que a paginação acabou de ver. Sem
  // o conjunto compartilhado, a mesma linha entraria duas vezes no upsert.
  const seen = new Set<string>();
  const events = [evt('cs2-vita-bw-2026-08-06', ['cs2-vita-bw-2026-08-06'])];

  assert.equal(harvest(events, seen).candidates.length, 1);
  assert.equal(harvest(events, seen).candidates.length, 0);
});

test('o instante da colheita é carimbado por market', () => {
  // Um timestamp único no fim do ciclo empilharia todas as páginas no mesmo
  // ponto da série temporal.
  const { capturedAt } = harvest([evt('cs2-a-b-2026-08-06', ['cs2-a-b-2026-08-06'])]);
  assert.equal(capturedAt.get('cs2-a-b-2026-08-06#0'), '2026-08-06T12:00:00Z');
});
