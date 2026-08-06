import { test } from 'node:test';
import assert from 'node:assert/strict';

// O módulo importa o cliente do Supabase no topo. Criar o cliente não abre
// conexão — o que este arquivo testa é a decisão de quais partidas entram no
// ciclo, que é pura de propósito: é ela que governa o volume da tabela.
process.env['SUPABASE_URL'] ??= 'http://localhost:54321';
process.env['SUPABASE_SERVICE_KEY'] ??= 'test-key';

const { enrichmentWindow, selectMatches, countFragments, cycleStatus, emptyEnrichStats } =
  await import('./esports-enricher.js');

type EnrichCandidate = Parameters<typeof selectMatches>[0][number];
type ContextFragment = Parameters<typeof countFragments>[1][number];

const NOW = new Date('2026-08-06T18:00:00.000Z');
const MIN_INTERVAL_MS = 30 * 60_000;

function candidate(matchId: string, minutesFromNow: number): EnrichCandidate {
  return {
    matchId,
    verticalId: 'cs2',
    matchSlug: `cs2-${matchId}-2026-08-06`,
    scheduledAt: new Date(NOW.getTime() + minutesFromNow * 60_000).toISOString(),
  };
}

function fragment(enricherId: string, kind: string): ContextFragment {
  return { enricherId, kind, asOf: NOW, payload: {}, summary: 's', confidence: 1 };
}

// ---------------------------------------------------------------------------
// A janela
// ---------------------------------------------------------------------------

test('a janela abre 24h à frente e 6h atrás de agora', () => {
  assert.deepEqual(enrichmentWindow(NOW, 1440, 360), {
    from: '2026-08-06T12:00:00.000Z',
    to: '2026-08-07T18:00:00.000Z',
  });
});

test('janela negativa é tratada como zero, não como inversão', () => {
  // Config com número negativo não pode virar um intervalo invertido, que o
  // PostgREST devolveria vazio sem reclamar de nada.
  const { from, to } = enrichmentWindow(NOW, -100, -100);
  assert.equal(from, NOW.toISOString());
  assert.equal(to, NOW.toISOString());
});

// ---------------------------------------------------------------------------
// A seleção — o parâmetro que governa o volume de context_fragments
// ---------------------------------------------------------------------------

test('partida enriquecida há menos que o intervalo mínimo é pulada', () => {
  const result = selectMatches(
    [candidate('a', 60), candidate('b', 120)],
    new Map([['a', NOW.getTime() - 10 * 60_000]]),
    NOW,
    MIN_INTERVAL_MS,
    50,
  );

  assert.deepEqual(
    result.selected.map(c => c.matchId),
    ['b'],
  );
  assert.equal(result.skippedRecent, 1);
});

test('passado o intervalo, a partida volta a ser elegível', () => {
  const result = selectMatches(
    [candidate('a', 60)],
    new Map([['a', NOW.getTime() - 31 * 60_000]]),
    NOW,
    MIN_INTERVAL_MS,
    50,
  );

  assert.equal(result.selected.length, 1);
  assert.equal(result.skippedRecent, 0);
});

test('o teto corta as mais distantes, não as mais próximas', () => {
  // As candidatas chegam ordenadas por scheduled_at crescente. A partida que
  // começa em 20h pode esperar 5 minutos; a que está ao vivo, não.
  const result = selectMatches(
    [candidate('ao-vivo', -30), candidate('logo', 60), candidate('longe', 1200)],
    new Map(),
    NOW,
    MIN_INTERVAL_MS,
    2,
  );

  assert.deepEqual(
    result.selected.map(c => c.matchId),
    ['ao-vivo', 'logo'],
  );
  assert.equal(result.truncated, true);
});

test('o filtro de cadência vem ANTES do teto', () => {
  // Se o teto viesse primeiro, um ciclo inteiro seria gasto em partidas que
  // seriam puladas, e as elegíveis esperariam o ciclo seguinte.
  const recent = new Map([
    ['a', NOW.getTime()],
    ['b', NOW.getTime()],
  ]);

  const result = selectMatches(
    [candidate('a', 10), candidate('b', 20), candidate('c', 30)],
    recent,
    NOW,
    MIN_INTERVAL_MS,
    2,
  );

  assert.deepEqual(
    result.selected.map(c => c.matchId),
    ['c'],
  );
  assert.equal(result.truncated, false);
});

test('intervalo mínimo zero enriquece tudo em todo tick', () => {
  const result = selectMatches(
    [candidate('a', 10)],
    new Map([['a', NOW.getTime()]]),
    NOW,
    0,
    50,
  );
  assert.equal(result.selected.length, 1);
});

test('batch_size inválido não zera o ciclo', () => {
  const result = selectMatches([candidate('a', 10)], new Map(), NOW, MIN_INTERVAL_MS, 0);
  assert.equal(result.selected.length, 1);
});

// ---------------------------------------------------------------------------
// Contagem e status
// ---------------------------------------------------------------------------

test('os fragmentos são contados por enricher e por kind', () => {
  const stats = emptyEnrichStats();

  countFragments(stats, [
    fragment('market-history', 'odds'),
    fragment('market-history', 'liquidity'),
    fragment('polymarket-context', 'news'),
  ]);
  countFragments(stats, [fragment('market-history', 'odds')]);

  assert.equal(stats.fragments, 4);
  assert.deepEqual(stats.byEnricher, { 'market-history': 3, 'polymarket-context': 1 });
  assert.deepEqual(stats.byKind, { odds: 2, liquidity: 1, news: 1 });
});

test('tabela ausente é partial, não error — é o estado entre deploy e apply', () => {
  const missing = emptyEnrichStats();
  missing.tableMissing = true;
  assert.equal(cycleStatus(missing), 'partial');

  const failed = emptyEnrichStats();
  failed.errors.push('boom');
  assert.equal(cycleStatus(failed), 'partial');

  // Ciclo sem nada a fazer é sucesso, não meia-falha.
  assert.equal(cycleStatus(emptyEnrichStats()), 'success');
});

test('teto batido não muda o status, mas fica registrado', () => {
  // Truncar é freio funcionando, não incidente — mas o log precisa dizer.
  const stats = emptyEnrichStats();
  stats.truncated = true;
  assert.equal(cycleStatus(stats), 'success');
});
