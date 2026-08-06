import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  guessMarketRole,
  learnedMarketRole,
  learnRoles,
  roleLearnKey,
  suffixFamily,
  MAX_GUESS_CONFIDENCE,
  UNKNOWN_ROLE,
} from './market-role.js';

/**
 * O vocabulário que o próprio Polymarket usa em `sports_market_type`. Nada que
 * sai do mapa ESTÁTICO pode estar fora dele — senão `market_match_links` passa a
 * ter dois vocabulários misturados e nenhuma query sabe qual está lendo.
 *
 * (O mapa APRENDIDO não precisa desta lista: por construção ele só devolve
 * valores lidos da própria coluna.)
 */
const POLYMARKET_VOCAB = new Set([
  'moneyline',
  'child_moneyline',
  'map_handicap',
  'totals',
  'round_handicap_game_1',
  'round_handicap_game_2',
  'round_handicap_game_3',
  'round_over_under_game_1',
  'round_over_under_game_2',
  'round_over_under_game_3',
  'kill_over_under_game',
  'first_blood_game',
  'esports_match_result',
]);

const CASES: Array<[suffix: string | null, role: string]> = [
  [null, 'moneyline'],
  ['', 'moneyline'],
  ['game1', 'child_moneyline'],
  ['game4', 'child_moneyline'],
  ['total-games-2pt5', 'totals'],
  ['total-game-1pt5', 'totals'],
  ['map-handicap-away-1pt5', 'map_handicap'],
  ['handicap-home-1pt5', 'map_handicap'],
  ['round-handicap-game-1-5pt5', 'round_handicap_game_1'],
  ['round-over-under-game-2-13pt5', 'round_over_under_game_2'],
  ['kill-over-under-game-1-25pt5', 'kill_over_under_game'],
  ['first-blood-game1', 'first_blood_game'],

  // As famílias medidas no dry-run de 2026-08-06, que a versão anterior do mapa
  // não enxergava por ancorar `^game(\d+)$` nas duas pontas.
  ['game2-round-total-24pt5', 'round_over_under_game_2'],
  ['game1-round-total-21pt5', 'round_over_under_game_1'],
  ['game1-round-handicap-navi-5pt5', 'round_handicap_game_1'],
  ['game3-round-handicap-vit-3pt5', 'round_handicap_game_3'],
  ['game2-map-handicap-away-1pt5', 'map_handicap'],
  ['game1-kill-over-under-25pt5', 'kill_over_under_game'],
];

for (const [suffix, role] of CASES) {
  test(`sufixo ${suffix === null ? '(nenhum)' : suffix} → ${role}`, () => {
    assert.equal(guessMarketRole(suffix)?.role, role);
  });
}

test('sufixo composto por game era o buraco: 3.692 markets numa família só', () => {
  // `gameN-round-total-X` foi a maior família sem papel do primeiro dry-run.
  // Este teste é a regressão da FORMA do mapa, não de uma regra.
  assert.equal(guessMarketRole('game2-round-total-24pt5')?.role, 'round_over_under_game_2');
  assert.notEqual(guessMarketRole('game2-round-total-24pt5'), null);
});

test('regra que precisa do número do game não o inventa quando ele falta', () => {
  // `round-total-24pt5` sem prefixo de game não diz de qual game é. Devolver
  // `round_over_under_game_1` seria fabricar um fato.
  assert.equal(guessMarketRole('round-total-24pt5'), null);
});

test('sufixo ausente é o market da série, e é a inferência mais forte que existe aqui', () => {
  assert.deepEqual(guessMarketRole(null), { role: 'moneyline', confidence: MAX_GUESS_CONFIDENCE });
});

test('sufixo desconhecido devolve null em vez de aproximar', () => {
  for (const suffix of ['bo3-winner', 'pistol-round-winner', 'mvp', 'x', 'game']) {
    assert.equal(guessMarketRole(suffix), null, suffix);
  }
  assert.equal(UNKNOWN_ROLE, 'unknown');
});

test('nenhuma inferência estática passa do teto de 0.7 da spec', () => {
  for (const [suffix] of CASES) {
    const guess = guessMarketRole(suffix);
    assert.ok(guess !== null);
    assert.ok(guess.confidence <= MAX_GUESS_CONFIDENCE, `${String(suffix)}: ${guess.confidence}`);
  }
});

test('todo papel do mapa estático pertence ao vocabulário do Polymarket', () => {
  for (const [suffix] of CASES) {
    const guess = guessMarketRole(suffix);
    assert.ok(guess !== null);
    assert.ok(POLYMARKET_VOCAB.has(guess.role), `${String(suffix)} inventou ${guess.role}`);
  }
});

test('caixa e espaço no sufixo não mudam a inferência', () => {
  assert.equal(guessMarketRole('  GAME3  ')?.role, 'child_moneyline');
  assert.equal(guessMarketRole('Map-Handicap-Away-1pt5')?.role, 'map_handicap');
});

// ---------------------------------------------------------------------------
// Normalização
// ---------------------------------------------------------------------------

test('a família mascara o código de time do meio do sufixo', () => {
  // Sem isto, `gameN-round-handicap-{code}-X` aparecia como 36 famílias
  // distintas no relatório — uma por time. É uma regra só.
  const codes = ['navi', 'vit'];
  assert.equal(suffixFamily('game1-round-handicap-navi-5pt5', codes), 'gameN-round-handicap-{code}-X');
  assert.equal(suffixFamily('game1-round-handicap-vit-5pt5', codes), 'gameN-round-handicap-{code}-X');
  assert.equal(suffixFamily('game2-round-total-24pt5'), 'gameN-round-total-X');
  assert.equal(suffixFamily(null), '(sem sufixo)');
});

test('a chave de aprendizado preserva o número do game; a família não', () => {
  // O papel do Polymarket carrega o número (`round_over_under_game_2`). Se a
  // chave de aprendizado colapsasse os games, a forma apareceria com dois
  // papéis distintos e seria descartada por ambiguidade.
  assert.equal(roleLearnKey('game2-round-total-24pt5'), 'game2-round-total-X');
  assert.equal(roleLearnKey('game3-round-total-25pt5'), 'game3-round-total-X');
  assert.equal(suffixFamily('game2-round-total-24pt5'), suffixFamily('game3-round-total-25pt5'));
  assert.notEqual(roleLearnKey('game2-round-total-24pt5'), roleLearnKey('game3-round-total-25pt5'));
});

test('a chave de aprendizado também mascara o código de time', () => {
  const codes = ['navi', 'vit'];
  assert.equal(
    roleLearnKey('game1-round-handicap-navi-5pt5', codes),
    roleLearnKey('game1-round-handicap-vit-5pt5', codes),
  );
});

// ---------------------------------------------------------------------------
// Mapa aprendido
// ---------------------------------------------------------------------------

const obs = (learnKey: string, role: string, times: number) =>
  Array.from({ length: times }, () => ({ learnKey, role }));

test('aprende a forma que aparece consistentemente nos eventos com a coluna', () => {
  // É assim que `gameN-odd-even-total-rounds` (1.365 markets) ganha papel sem
  // ninguém inventar rótulo: o nome oficial já está no banco, nos eventos
  // recentes em que `sports_market_type` está preenchido.
  const learned = learnRoles(obs('game1-odd-even-total-rounds', 'odd_even_rounds_game_1', 40));

  assert.equal(learned['game1-odd-even-total-rounds'], 'odd_even_rounds_game_1');
  assert.deepEqual(learnedMarketRole('game1-odd-even-total-rounds', learned), {
    role: 'odd_even_rounds_game_1',
    confidence: MAX_GUESS_CONFIDENCE,
  });
});

test('forma com poucas observações não é aprendida', () => {
  // Uma observação isolada pode ser um market atípico, e um mapa construído
  // sobre ela teria cara de medição sendo palpite.
  const learned = learnRoles(obs('game1-alguma-coisa', 'papel_x', 2));
  assert.equal(learned['game1-alguma-coisa'], undefined);
  assert.equal(learnedMarketRole('game1-alguma-coisa', learned), null);
});

test('forma ambígua é DESCARTADA, não decidida pelo mais comum', () => {
  // Se a mesma forma de sufixo aparece com dois papéis, ela não determina
  // papel. Escolher a maioria seria transformar ambiguidade medida em fato.
  const learned = learnRoles([
    ...obs('game1-x', 'papel_a', 30),
    ...obs('game1-x', 'papel_b', 20),
  ]);
  assert.equal(learned['game1-x'], undefined);
});

test('maioria esmagadora com ruído mínimo continua sendo aprendida', () => {
  const learned = learnRoles([...obs('game1-y', 'papel_a', 99), ...obs('game1-y', 'papel_b', 1)]);
  assert.equal(learned['game1-y'], 'papel_a');
});

test('mapa aprendido vazio ou ausente devolve null sem quebrar', () => {
  assert.equal(learnedMarketRole('qualquer', undefined), null);
  assert.equal(learnedMarketRole('qualquer', {}), null);
});
