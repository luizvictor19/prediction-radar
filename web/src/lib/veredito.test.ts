import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ehArmadilhaDeResultado, escolherVeredito, type Veredicavel } from './veredito.js';

/**
 * The headline verdict -- step 2 of item 5, section 8 of the rule-screen spec.
 *
 * The market prices the HEADLINE and resolves by the RULE, and the difference is
 * the opportunity. The screen has never said that anywhere. It does not need new
 * generation to say it: `descricao` and `cenario` of the strongest accused
 * `muda_resultado` trap already carry exactly that sentence. This is selection,
 * not writing.
 *
 * The mutation axes these tests exist to lock:
 *
 * 1. **not requiring `cenario`** -- M4 measured the deciding line as accused
 *    traps with description AND scenario (807 of 1033, 78.1%). A verdict with a
 *    description and no scenario states what the rule demands without ever
 *    showing the case where it bites, which is the half that convinces.
 * 2. **first match instead of strongest** -- the view promises no order inside
 *    `jsonb_agg`, so "first" means "whatever the database returned", and the
 *    headline of the screen would change between two loads of the same market.
 * 3. **any trap, not just `muda_resultado`** -- a `detalhe`-severity finding
 *    becomes the headline. The whole point of the band is what changes the
 *    OUTCOME.
 */

function achado(over: Partial<Veredicavel> = {}): Veredicavel {
  return {
    classe: 'pegadinha',
    origem: 'acusado',
    subtipos: ['muda_resultado'],
    vezes_encontrado: 1,
    leituras_do_texto: 5,
    trecho: 'a passagem',
    descricao: 'uma descrição',
    cenario: 'um cenário',
    ...over,
  };
}

// ---------------------------------------------------------------------------
// AXIS 3 -- only what changes the outcome
// ---------------------------------------------------------------------------

test('só pegadinha muda_resultado acusada vira veredito', () => {
  assert.equal(ehArmadilhaDeResultado(achado()), true);
  assert.equal(ehArmadilhaDeResultado(achado({ subtipos: ['detalhe'] })), false);
  assert.equal(ehArmadilhaDeResultado(achado({ origem: 'herdado' })), false);
  assert.equal(ehArmadilhaDeResultado(achado({ classe: 'ambiguidade' })), false);
  assert.equal(ehArmadilhaDeResultado(achado({ subtipos: null })), false);
});

test('uma pegadinha de detalhe não vira manchete, mesmo sendo a única', () => {
  assert.equal(escolherVeredito([achado({ subtipos: ['detalhe'], vezes_encontrado: 5 })]), null);
});

test('muda_timing não é muda_resultado', () => {
  // Section 2 of the hierarchy shows both. The verdict band is only the one
  // that changes WHO WINS, not the one that changes WHEN.
  assert.equal(escolherVeredito([achado({ subtipos: ['muda_timing'] })]), null);
});

test('a armadilha que traz as duas severidades continua valendo', () => {
  // Readings disagree about weight and `subtipos` keeps both -- that is one
  // finding two readings weighed differently, and the strong reading counts.
  const v = escolherVeredito([achado({ subtipos: ['detalhe', 'muda_resultado'] })]);
  assert.equal(v?.descricao, 'uma descrição');
});

// ---------------------------------------------------------------------------
// AXIS 1 -- description AND scenario
// ---------------------------------------------------------------------------

test('sem cenário não vira veredito, mesmo com descrição forte', () => {
  const so_descricao = achado({ cenario: null, vezes_encontrado: 5 });
  const completa = achado({ vezes_encontrado: 2, descricao: 'a mais fraca', cenario: 'o cenário' });

  const v = escolherVeredito([so_descricao, completa]);

  // The 5/5 loses to the 2/5 because half a verdict is not a verdict.
  assert.equal(v?.descricao, 'a mais fraca');
});

test('sem descrição não vira veredito', () => {
  assert.equal(escolherVeredito([achado({ descricao: null })]), null);
});

test('prosa em branco conta como ausente', () => {
  // `''` and `'   '` reach the screen as an empty paragraph, which reads as a
  // rendering bug rather than as missing data.
  assert.equal(escolherVeredito([achado({ cenario: '   ' })]), null);
  assert.equal(escolherVeredito([achado({ descricao: '' })]), null);
});

// ---------------------------------------------------------------------------
// AXIS 2 -- the strongest, deterministically
// ---------------------------------------------------------------------------

test('vence a de maior concordância, não a primeira da lista', () => {
  const fraca = achado({ vezes_encontrado: 1, descricao: 'a fraca' });
  const forte = achado({ vezes_encontrado: 4, descricao: 'a forte' });

  assert.equal(escolherVeredito([fraca, forte])?.descricao, 'a forte');
  assert.equal(escolherVeredito([forte, fraca])?.descricao, 'a forte');
});

test('a ordem da entrada não muda o veredito', () => {
  const entrada = [
    achado({ vezes_encontrado: 3, descricao: 'tres', trecho: 'bbb' }),
    achado({ vezes_encontrado: 3, descricao: 'tres também', trecho: 'aaa' }),
    achado({ vezes_encontrado: 1, descricao: 'um', trecho: 'ccc' }),
  ];

  // Tie on agreement resolves by the quoted span, which is a property of the
  // TEXT. A positional tiebreak would show a different headline on every load,
  // because the view promises no order inside `jsonb_agg`.
  const esperado = escolherVeredito(entrada)?.descricao;
  assert.equal(esperado, 'tres também');
  for (const ordem of [[...entrada].reverse(), [entrada[2]!, entrada[0]!, entrada[1]!]])
    assert.equal(escolherVeredito(ordem)?.descricao, esperado);
});

// ---------------------------------------------------------------------------
// The empty state is a fact, not an absence
// ---------------------------------------------------------------------------

test('mercado lido e limpo devolve null, e null é resposta', () => {
  // ~22% of markets, by M4. `null` is what lets the band say "3 leituras,
  // nenhuma armadilha que mude o resultado" instead of not rendering -- "read
  // and clean" is different information from "not read".
  assert.equal(escolherVeredito([]), null);
  assert.equal(escolherVeredito([achado({ classe: 'contradicao', subtipos: null })]), null);
});

test('o veredito carrega a concordância da armadilha de onde saiu', () => {
  // The band shows the badge, so the reader can weigh the headline. Without
  // these two numbers travelling with the prose, the caller would have to go
  // find them again and could pair the wrong ones.
  const v = escolherVeredito([achado({ vezes_encontrado: 4, leituras_do_texto: 5 })]);

  assert.equal(v?.vezes_encontrado, 4);
  assert.equal(v?.leituras_do_texto, 5);
});

test('a entrada não é modificada', () => {
  const entrada = [achado({ vezes_encontrado: 2 }), achado({ vezes_encontrado: 4 })];
  const antes = JSON.stringify(entrada);

  escolherVeredito(entrada);

  assert.equal(JSON.stringify(entrada), antes);
});
