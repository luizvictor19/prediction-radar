import { test } from 'node:test';
import assert from 'node:assert/strict';

// O módulo importa o cliente do Supabase no topo. Criar o cliente não abre
// conexão — nenhum teste aqui toca banco ou rede: tudo é `decideMarket`,
// `combineVerdicts` e `decideMatch`, que são puros de propósito.
process.env['SUPABASE_URL'] ??= 'http://localhost:54321';
process.env['SUPABASE_SERVICE_KEY'] ??= 'test-key';

const { decideMarket, combineVerdicts, decideMatch } = await import('./match-outcome.js');

type MoneylineMarket = Parameters<typeof decideMarket>[0];

const NAVI = '11111111-1111-1111-1111-111111111111';
const FAZE = '22222222-2222-2222-2222-222222222222';
const RESOLVED_AT = '2026-08-06T20:15:00.000Z';

/** Um moneyline resolvido com a NAVI vencendo, e a NAVI no índice 0. */
function market(overrides: Partial<MoneylineMarket> = {}): MoneylineMarket {
  return {
    eventId: 'evt-1',
    status: 'resolved',
    resolvedOutcome: 'Natus Vincere',
    resolvedAt: RESOLVED_AT,
    outcomes: ['Natus Vincere', 'FaZe Clan'],
    outcomeAIndex: 0,
    ...overrides,
  };
}

const SIDES = { teamAId: NAVI, teamBId: FAZE };

// ---------------------------------------------------------------------------
// A tradução rótulo -> lado
// ---------------------------------------------------------------------------

test('o vencedor é o lado cujo índice bate com outcome_a_index', () => {
  assert.deepEqual(decideMarket(market()), {
    kind: 'winner',
    side: 'a',
    resolvedAt: RESOLVED_AT,
  });

  // Mesmo evento, mesmo rótulo vencedor — só o índice do time A muda. É o caso
  // dos markets irmãos com outcomes em ordens diferentes (19 de 79 medidos), e
  // é exatamente onde resolver o índice por PARTIDA gravaria o time errado.
  assert.deepEqual(decideMarket(market({ outcomeAIndex: 1 })), {
    kind: 'winner',
    side: 'b',
    resolvedAt: RESOLVED_AT,
  });
});

test('a comparação de rótulo ignora caixa e espaço em volta', () => {
  assert.equal(decideMarket(market({ resolvedOutcome: '  natus vincere ' })).kind, 'winner');
});

test('mercado ainda aberto é pendente, não desfecho', () => {
  assert.deepEqual(decideMarket(market({ status: 'active' })), { kind: 'pending' });
  assert.deepEqual(decideMarket(market({ status: 'closed_manual' })), { kind: 'pending' });
});

// ---------------------------------------------------------------------------
// Void
// ---------------------------------------------------------------------------

test('resolvido sem rótulo vencedor é void, e o índice não muda isso', () => {
  assert.deepEqual(decideMarket(market({ resolvedOutcome: null })), {
    kind: 'void',
    resolvedAt: RESOLVED_AT,
  });

  // A ordem das guardas importa: perguntar pelo índice antes faria a partida
  // void virar estado B e ficar pendente para sempre, esperando um índice que
  // não mudaria nada.
  assert.deepEqual(decideMarket(market({ resolvedOutcome: null, outcomeAIndex: null })), {
    kind: 'void',
    resolvedAt: RESOLVED_AT,
  });
});

// ---------------------------------------------------------------------------
// Estado B — sem índice
// ---------------------------------------------------------------------------

test('sem outcome_a_index não se orienta nada, e não se chuta', () => {
  assert.deepEqual(decideMarket(market({ outcomeAIndex: null })), { kind: 'no_index' });
});

// ---------------------------------------------------------------------------
// Estado A — contradição
// ---------------------------------------------------------------------------

test('rótulo vencedor fora de outcomes.values é contradição, não pobreza', () => {
  const verdict = decideMarket(market({ resolvedOutcome: 'G2 Esports' }));
  assert.equal(verdict.kind, 'ambiguous');
});

test('rótulo que casa nos dois outcomes não desempata sozinho', () => {
  const verdict = decideMarket(
    market({ outcomes: ['Natus Vincere', 'Natus Vincere'], resolvedOutcome: 'Natus Vincere' }),
  );
  assert.equal(verdict.kind, 'ambiguous');
});

test('índice fora da faixa de outcomes.values é ambíguo', () => {
  assert.equal(decideMarket(market({ outcomeAIndex: 5 })).kind, 'ambiguous');
  assert.equal(decideMarket(market({ outcomeAIndex: -1 })).kind, 'ambiguous');
});

test('com três outcomes, "não é o A" não identifica o B', () => {
  // O empate de futebol, quando a vertical existir. Excluir o A deixaria dois
  // candidatos, e escolher um inverteria metade da amostra sem avisar.
  const verdict = decideMarket(
    market({
      outcomes: ['Natus Vincere', 'FaZe Clan', 'Draw'],
      resolvedOutcome: 'Draw',
      outcomeAIndex: 0,
    }),
  );
  assert.equal(verdict.kind, 'ambiguous');
});

test('evento resolvido sem outcomes.values é ambíguo', () => {
  assert.equal(decideMarket(market({ outcomes: [] })).kind, 'ambiguous');
});

// ---------------------------------------------------------------------------
// Combinação entre markets da mesma partida
// ---------------------------------------------------------------------------

test('moneylines que concordam concluem; o carimbo é o mais antigo', () => {
  const cedo = '2026-08-06T20:10:00.000Z';

  assert.deepEqual(
    combineVerdicts([
      { kind: 'winner', side: 'a', resolvedAt: RESOLVED_AT },
      { kind: 'winner', side: 'a', resolvedAt: cedo },
    ]),
    { kind: 'winner', side: 'a', resolvedAt: cedo },
  );
});

test('moneylines que discordam não concluem nada', () => {
  const conflito = combineVerdicts([
    { kind: 'winner', side: 'a', resolvedAt: RESOLVED_AT },
    { kind: 'winner', side: 'b', resolvedAt: RESOLVED_AT },
  ]);
  assert.equal(conflito.kind, 'ambiguous');

  const vencedorEVoid = combineVerdicts([
    { kind: 'winner', side: 'a', resolvedAt: RESOLVED_AT },
    { kind: 'void', resolvedAt: RESOLVED_AT },
  ]);
  assert.equal(vencedorEVoid.kind, 'ambiguous');
});

test('um market ambíguo contamina a partida mesmo com outro concluindo', () => {
  const verdict = combineVerdicts([
    { kind: 'ambiguous', reason: 'rótulo desconhecido' },
    { kind: 'winner', side: 'a', resolvedAt: RESOLVED_AT },
  ]);
  assert.equal(verdict.kind, 'ambiguous');
});

test('estado B tem precedência sobre pendente', () => {
  // Contar como pendente esconderia o que o recompute semanal ainda deve.
  assert.deepEqual(combineVerdicts([{ kind: 'pending' }, { kind: 'no_index' }]), {
    kind: 'no_index',
  });
});

// ---------------------------------------------------------------------------
// Do lado ao id do time
// ---------------------------------------------------------------------------

test('o lado vencedor vira o id do time daquele lado', () => {
  assert.deepEqual(decideMatch(SIDES, [market()]), {
    kind: 'winner',
    teamId: NAVI,
    resolvedAt: RESOLVED_AT,
  });
  assert.deepEqual(decideMatch(SIDES, [market({ outcomeAIndex: 1 })]), {
    kind: 'winner',
    teamId: FAZE,
    resolvedAt: RESOLVED_AT,
  });
});

test('partida sem moneyline linkado não conclui', () => {
  assert.deepEqual(decideMatch(SIDES, []), { kind: 'no_moneyline' });
});

test('lado vencedor sem linha de time não vira escrita', () => {
  // O CHECK esports_matches_winner_is_a_side rejeitaria a linha de qualquer
  // jeito; melhor contar e seguir do que perder o chunk inteiro.
  assert.deepEqual(decideMatch({ teamAId: null, teamBId: FAZE }, [market()]), {
    kind: 'no_team_row',
  });
});

test('void e pendente atravessam decideMatch sem virar vencedor', () => {
  assert.deepEqual(decideMatch(SIDES, [market({ resolvedOutcome: null })]), {
    kind: 'void',
    resolvedAt: RESOLVED_AT,
  });
  assert.deepEqual(decideMatch(SIDES, [market({ status: 'active' })]), { kind: 'pending' });
});
