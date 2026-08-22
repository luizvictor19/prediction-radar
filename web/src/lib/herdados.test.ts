import { test } from 'node:test';
import assert from 'node:assert/strict';

import { separarHerdados, type Recolhivel } from './herdados.js';
import { fundirPorAbsorcao, type AchadoFundivel } from './dedup.js';

/**
 * Inherited findings, collapsed -- section 6 of the spec.
 *
 * The mutation axes these tests exist to lock:
 *
 * 1. **no split at all** -- the list goes back to being one, sorted by
 *    agreement, which is what the screen does today (`Regra.tsx:113`). An
 *    inherited 11/30 shows above an accused 2/30, and the least actionable item
 *    on the screen ends up at the top.
 * 2. **discard instead of collapse** -- `herdados` disappears from the return.
 *    That is the prohibition in section 11 of the spec: nothing leaves the
 *    screen, and what leaves the main view stays reachable.
 * 3. **split by absent prose instead of by origin** -- the temptation is in the
 *    spec's own justification ("a finding with no description and no scenario
 *    is the least actionable one"). Absent prose is a PROXY; origin is a FACT,
 *    and the origin is what the block header asserts.
 */

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

/**
 * The Flávio Bolsonaro market, which is the case that opens section 6: ten
 * inherited findings on the same screen, each carrying the whole mechanism
 * paragraph.
 *
 * The cardinalities are the ones measured on 22/08/2026 (M3): a median of 5
 * accused and 11 inherited per market. The strong inherited finding at 11 of 30
 * readings against the weak accused one at 2 of 30 is the shape that matters --
 * it is the one a sort by agreement inverts.
 */
type Item = Recolhivel & {
  achado_id: string;
  vezes_encontrado: number;
  descricao: string | null;
  cenario: string | null;
};

function item(over: Partial<Item> & { achado_id: string }): Item {
  return {
    origem: 'acusado',
    vezes_encontrado: 1,
    descricao: null,
    cenario: null,
    ...over,
  };
}

const HERDADO_FORTE = item({
  achado_id: 'herdado-forte',
  origem: 'herdado',
  vezes_encontrado: 11,
});

const ACUSADO_FRACO = item({
  achado_id: 'acusado-fraco',
  vezes_encontrado: 2,
  descricao: 'A regra exige o acordo público, não a entrega física.',
  cenario: 'Se o acordo sair em agosto e a entrega em 2027, resolve SIM.',
});

// ---------------------------------------------------------------------------
// AXIS 1 -- inherited never ranks above accused
// ---------------------------------------------------------------------------

test('o herdado mais confirmado fica abaixo do acusado menos confirmado', () => {
  const { acusados, herdados } = separarHerdados([HERDADO_FORTE, ACUSADO_FRACO]);

  // Sorted by agreement -- what the screen does today -- the inherited 11/30
  // would open the list and the accused 2/30 would follow it. The split is what
  // prevents that, and it does not look at `vezes_encontrado`: the origin is
  // the primary key, always.
  assert.deepEqual(acusados.map(a => a.achado_id), ['acusado-fraco']);
  assert.deepEqual(herdados.map(a => a.achado_id), ['herdado-forte']);
});

test('em qualquer ordem de entrada, nenhum herdado precede um acusado', () => {
  const entrada = [
    HERDADO_FORTE,
    ACUSADO_FRACO,
    item({ achado_id: 'h2', origem: 'herdado', vezes_encontrado: 30 }),
    item({ achado_id: 'a2', vezes_encontrado: 1 }),
  ];

  for (const ordem of [entrada, [...entrada].reverse(), [entrada[2]!, entrada[0]!, entrada[3]!, entrada[1]!]]) {
    const { acusados, herdados } = separarHerdados(ordem);
    const tela = [...acusados, ...herdados];
    const origens = tela.map(a => a.origem);
    const primeiroHerdado = origens.indexOf('herdado');

    // No accused finding after the first inherited one: once the block starts,
    // it is not interrupted by an item from the main view.
    assert.ok(primeiroHerdado !== -1);
    assert.ok(
      !origens.slice(primeiroHerdado).includes('acusado'),
      `${JSON.stringify(tela.map(a => a.achado_id))}`,
    );
  }
});

// ---------------------------------------------------------------------------
// AXIS 2 -- collapsing is not discarding
// ---------------------------------------------------------------------------

test('nada é apagado: os dois grupos somam a entrada', () => {
  const entrada = [
    HERDADO_FORTE,
    ACUSADO_FRACO,
    item({ achado_id: 'h2', origem: 'herdado' }),
    item({ achado_id: 'h3', origem: 'herdado' }),
  ];

  const { acusados, herdados } = separarHerdados(entrada);

  assert.equal(acusados.length + herdados.length, entrada.length);
  assert.deepEqual(
    [...acusados, ...herdados].map(a => a.achado_id).sort(),
    entrada.map(a => a.achado_id).sort(),
  );
});

// ---------------------------------------------------------------------------
// AXIS 3 -- the key is the origin, not the absence of prose
// ---------------------------------------------------------------------------

test('um acusado sem prosa continua no grupo principal', () => {
  // The spec's justification for collapsing is "no description and no
  // scenario", and that is why absent prose looks like a reasonable key. It is
  // not: a terse accused finding was read in THIS market, and the block header
  // claims the opposite -- "inherited from other markets with the same rule
  // text".
  const lacônico = item({ achado_id: 'acusado-sem-prosa' });

  const { acusados, herdados } = separarHerdados([lacônico, HERDADO_FORTE]);

  assert.deepEqual(acusados.map(a => a.achado_id), ['acusado-sem-prosa']);
  assert.equal(herdados.length, 1);
});

test('origem que o tipo não previu fica VISÍVEL, não recolhida', () => {
  // `tipos.ts` is hand-written: a new value of `origem` in the database does
  // not break the build, reaches this code and falls into the `else`. It has to
  // land outside the block -- collapsing it would assert in the header a
  // provenance nobody verified. Same reasoning as the null index in
  // `separarBoilerplate`.
  const estranho = { ...item({ achado_id: 'origem-nova' }), origem: 'derivado' } as unknown as Item;

  const { acusados, herdados } = separarHerdados([estranho]);

  assert.equal(acusados.length, 1);
  assert.equal(herdados.length, 0);
});

// ---------------------------------------------------------------------------
// The ordering contract
// ---------------------------------------------------------------------------

test('a ordem dentro de cada grupo é a da entrada', () => {
  // Section 7 is what orders -- the same contract as `separarBoilerplate`. This
  // function decides which side a finding falls on, and nothing else.
  const entrada = [
    item({ achado_id: 'a1', vezes_encontrado: 1 }),
    item({ achado_id: 'h1', origem: 'herdado', vezes_encontrado: 1 }),
    item({ achado_id: 'a2', vezes_encontrado: 30 }),
    item({ achado_id: 'h2', origem: 'herdado', vezes_encontrado: 30 }),
  ];

  const { acusados, herdados } = separarHerdados(entrada);

  assert.deepEqual(acusados.map(a => a.achado_id), ['a1', 'a2']);
  assert.deepEqual(herdados.map(a => a.achado_id), ['h1', 'h2']);
});

// ---------------------------------------------------------------------------
// Composition with the section-4 dedup
// ---------------------------------------------------------------------------

/** The contract the dedup asks for, with the fields the block reads. */
type Fundivel = AchadoFundivel & { achado_id: string };

function fundivel(over: Partial<Fundivel> & { achado_id: string; trecho: string }): Fundivel {
  return {
    classe: 'pegadinha',
    origem: 'herdado',
    subtipos: ['muda_resultado'],
    descricao: null,
    cenario: null,
    leitura_a: null,
    leitura_b: null,
    leituras: ['l1'],
    ...over,
  };
}

test('o N do cabeçalho é o do bloco, e não a contagem da view', () => {
  // `ContagemDigest.achados_herdados` counts the view's rows, BEFORE the dedup.
  // Here four inherited rows are merged into two by absorption, and the header
  // has to say 2. Reading the number off the view would say 4, and the reader
  // would open the block to count two -- which is the divergence `caa73b9` went
  // to fix.
  const linhas = [
    fundivel({ achado_id: 'h1', trecho: 'on December 31, 2026 at 12:00 PM ET' }),
    fundivel({ achado_id: 'h2', trecho: 'at 12:00 PM ET' }),
    fundivel({ achado_id: 'h3', trecho: 'a consensus of credible reporting from major outlets' }),
    fundivel({ achado_id: 'h4', trecho: 'a consensus of credible reporting' }),
  ];

  const { herdados } = separarHerdados(fundirPorAbsorcao(linhas));

  assert.equal(herdados.length, 2);
  assert.notEqual(herdados.length, linhas.length);
});

test('nada que chega ao bloco de herdados tem prosa', () => {
  // This is the entire justification for collapsing: a finding with no
  // description and no scenario is the least actionable one on the screen. If
  // some step of the path ever fills an inherited finding's prose with the
  // accused neighbour's, propagation starts to look like detection -- and the
  // spec puts that decision out of discussion.
  //
  // The two spans cross without containment (`A B C` / `B C D`), so the dedup
  // does NOT merge them and the inherited one reaches the block on its own,
  // next to an accused finding of the same group that has prose to leak.
  const herdado = fundivel({
    achado_id: 'h',
    trecho: 'the margin of victory between the top two',
  });
  const acusado = fundivel({
    achado_id: 'a',
    origem: 'acusado',
    trecho: 'victory between the top two candidates in the first round',
    descricao: 'A regra mede a margem, não o vencedor.',
    cenario: 'Se o primeiro colocado vencer por 3 pontos, resolve NÃO.',
  });

  const { acusados, herdados } = separarHerdados(fundirPorAbsorcao([herdado, acusado]));

  assert.equal(acusados.length, 1);
  assert.equal(herdados.length, 1);
  assert.equal(herdados[0]?.descricao, null);
  assert.equal(herdados[0]?.cenario, null);
  assert.equal(herdados[0]?.leitura_a, null);
  assert.equal(herdados[0]?.leitura_b, null);
});

// ---------------------------------------------------------------------------
// Edges
// ---------------------------------------------------------------------------

test('mercado sem nenhum herdado devolve bloco vazio', () => {
  // The component needs to know not to draw a collapsed block that opens into
  // nothing. There are 14 markets out of 1033 with no trap at all (M3), and the
  // empty block is the same class of error: a section that exists and says
  // nothing.
  const { acusados, herdados } = separarHerdados([ACUSADO_FRACO]);

  assert.equal(acusados.length, 1);
  assert.deepEqual(herdados, []);
});

test('lista vazia devolve os dois grupos vazios', () => {
  assert.deepEqual(separarHerdados([]), { acusados: [], herdados: [] });
});

test('a entrada não é modificada', () => {
  const entrada = [HERDADO_FORTE, ACUSADO_FRACO];
  const antes = JSON.stringify(entrada);

  separarHerdados(entrada);

  assert.equal(JSON.stringify(entrada), antes);
});
