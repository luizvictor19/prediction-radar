import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  LIMIAR_BOILERPLATE,
  mascararParaGate,
  montarIndice,
  separarBoilerplate,
  type LinhaDeTrecho,
} from './boilerplate.js';

/**
 * O gate de boilerplate — seção 5 da spec.
 *
 * Os eixos de mutação que estes testes existem para travar:
 *
 * 1. **denominador = textos COM achado** em vez de textos LIDOS — infla toda
 *    fração e empurra achado normal para dentro do gate.
 * 2. **contar linhas** em vez de textos distintos — o mesmo trecho lido três
 *    vezes no mesmo texto passaria a valer três.
 * 3. **máscara desligada na chave** — as variantes de data param de colapsar e
 *    o terceiro par cai para fora do gate.
 * 4. **máscara ligada no trecho exibido** — a tela mostraria `<mes> #, #` no
 *    lugar da citação, que é P1 quebrado.
 * 5. **limiar de volta aos 80% chutados** — o gate recolhe zero.
 */

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

/**
 * Cinco textos de regra. O boilerplate da plataforma está em quatro deles, com
 * a data trocada em cada um — que é a forma real: medido em 22/08/2026, o par
 * `fuso_ausente` sobre a data com `ET` aparece em 31,8% dos 267 textos só
 * depois que a máscara junta as variantes.
 */
const LINHAS: LinhaDeTrecho[] = [
  { sha: 't1', classe: 'ambiguidade', tipo: 'fuso_ausente', trecho: 'December 31, 2026, 11:59 PM ET' },
  { sha: 't2', classe: 'ambiguidade', tipo: 'fuso_ausente', trecho: 'June 30, 2027, 11:59 PM ET' },
  { sha: 't3', classe: 'ambiguidade', tipo: 'fuso_ausente', trecho: 'March 31, 2027, 11:59 PM ET' },
  { sha: 't4', classe: 'ambiguidade', tipo: 'fuso_ausente', trecho: 'September 30, 2026, 11:59 PM ET' },
  // Peculiaridade de um mercado só: 1 em 5 = 20%... mas de OUTRO tipo.
  { sha: 't1', classe: 'pegadinha', tipo: 'muda_resultado', trecho: 'Replies will NOT count towards the total' },
];

/** Todos os textos lidos, INCLUSIVE o que não produziu achado nenhum. */
const TEXTOS = ['t1', 't2', 't3', 't4', 't5'];

function achado(over: {
  classe?: 'pegadinha' | 'ambiguidade' | 'contradicao';
  subtipos?: string[] | null;
  trecho: string | null;
}) {
  return {
    classe: over.classe ?? ('ambiguidade' as const),
    subtipos: over.subtipos ?? ['fuso_ausente'],
    trecho: over.trecho,
  };
}

// ---------------------------------------------------------------------------
// EIXO 1 e 2 — o denominador
// ---------------------------------------------------------------------------

test('o denominador é todo texto LIDO, mesmo o que não produziu achado', () => {
  const indice = montarIndice(LINHAS, TEXTOS);

  // `t5` foi lido e não achou nada. Ele conta: é uma chance que o trecho teve
  // de aparecer e não apareceu. Sem ele o denominador seria 4 e toda fração
  // subiria — o boilerplate a 80% e a peculiaridade a 25%.
  assert.equal(indice.denominador, 5);
});

test('a frequência vem sempre com o denominador junto', () => {
  const f = montarIndice(LINHAS, TEXTOS).frequenciaDe(
    achado({ trecho: 'December 31, 2026, 11:59 PM ET' }),
  );

  // Fração sem denominador é a armadilha do 1/1: "100%" de uma leitura só.
  assert.equal(f?.textos, 4);
  assert.equal(f?.denominador, 5);
  assert.equal(f?.fracao, 0.8);
});

test('o mesmo trecho repetido no MESMO texto conta uma vez', () => {
  // Três leituras do mesmo texto acham a mesma passagem. É um texto, não três.
  const repetido: LinhaDeTrecho[] = [
    ...LINHAS,
    { sha: 't1', classe: 'ambiguidade', tipo: 'fuso_ausente', trecho: 'December 31, 2026, 11:59 PM ET' },
    { sha: 't1', classe: 'ambiguidade', tipo: 'fuso_ausente', trecho: 'december 31, 2026, 11:59 pm et' },
  ];

  const f = montarIndice(repetido, TEXTOS).frequenciaDe(
    achado({ trecho: 'December 31, 2026, 11:59 PM ET' }),
  );

  assert.equal(f?.textos, 4);
});

// ---------------------------------------------------------------------------
// EIXO 3 — a máscara agrupa
// ---------------------------------------------------------------------------

test('a máscara junta as variantes de data num par só', () => {
  const indice = montarIndice(LINHAS, TEXTOS);

  // Quatro datas diferentes, quatro textos, um par. Sem a máscara cada uma
  // valeria 1 de 5 — 20% cada, e nenhuma seria reconhecida como padrão da casa.
  for (const trecho of [
    'December 31, 2026, 11:59 PM ET',
    'June 30, 2027, 11:59 PM ET',
    'March 31, 2027, 11:59 PM ET',
    'September 30, 2026, 11:59 PM ET',
  ]) {
    assert.equal(montarIndice(LINHAS, TEXTOS).frequenciaDe(achado({ trecho }))?.textos, 4, trecho);
  }
  assert.equal(indice.denominador, 5);
});

test('a máscara troca número e mês, e nada mais', () => {
  assert.equal(mascararParaGate('December 31, 2026, 11:59 PM ET'), '<mes> #, #, #:# pm et');
  assert.equal(mascararParaGate('a consensus of credible reporting'), 'a consensus of credible reporting');
});

test('tipos diferentes sobre o mesmo trecho são pares diferentes', () => {
  const linhas: LinhaDeTrecho[] = [
    { sha: 't1', classe: 'ambiguidade', tipo: 'fuso_ausente', trecho: '11:59 PM ET' },
    { sha: 't2', classe: 'ambiguidade', tipo: 'fuso_ausente', trecho: '11:59 PM ET' },
    { sha: 't3', classe: 'ambiguidade', tipo: 'data_ambigua', trecho: '11:59 PM ET' },
  ];
  const indice = montarIndice(linhas, ['t1', 't2', 't3']);

  assert.equal(indice.frequenciaDe(achado({ trecho: '11:59 PM ET', subtipos: ['fuso_ausente'] }))?.textos, 2);
  assert.equal(indice.frequenciaDe(achado({ trecho: '11:59 PM ET', subtipos: ['data_ambigua'] }))?.textos, 1);
});

test('LIMITE CONHECIDO: a máscara normaliza o miolo, não o recorte', () => {
  // `by December 31, 2026, 11:59 PM ET` e `December 31, 2026, 11:59 PM ET` são
  // a MESMA omissão de fuso e ficam em pares diferentes, porque o `by` entra na
  // chave. Medido em 22/08/2026: por isso o par com `by` parou em 9,7% e ficou
  // de fora do gate, enquanto as outras variantes colapsaram em 31,8%.
  //
  // Está escrito como teste de propósito. Sem isto, alguém olha o 9,7% no
  // relatório daqui a seis meses e acha que descobriu um tipo novo.
  assert.notEqual(
    mascararParaGate('by December 31, 2026, 11:59 PM ET'),
    mascararParaGate('December 31, 2026, 11:59 PM ET'),
  );

  const linhas: LinhaDeTrecho[] = [
    { sha: 't1', classe: 'ambiguidade', tipo: 'fuso_ausente', trecho: 'by December 31, 2026, 11:59 PM ET' },
    { sha: 't2', classe: 'ambiguidade', tipo: 'fuso_ausente', trecho: 'June 30, 2027, 11:59 PM ET' },
  ];
  const indice = montarIndice(linhas, ['t1', 't2']);

  assert.equal(indice.frequenciaDe(achado({ trecho: 'by December 31, 2026, 11:59 PM ET' }))?.textos, 1);
  assert.equal(indice.frequenciaDe(achado({ trecho: 'June 30, 2027, 11:59 PM ET' }))?.textos, 1);
});

// ---------------------------------------------------------------------------
// EIXO 5 — o limiar
// ---------------------------------------------------------------------------

test('o limiar é 20%, o meio do vale medido', () => {
  assert.equal(LIMIAR_BOILERPLATE, 0.2);
});

test('acima do limiar é boilerplate, abaixo não é', () => {
  const indice = montarIndice(LINHAS, TEXTOS);

  const padrao = indice.frequenciaDe(achado({ trecho: 'June 30, 2027, 11:59 PM ET' }));
  const peculiar = indice.frequenciaDe(
    achado({ trecho: 'Replies will NOT count towards the total', classe: 'pegadinha', subtipos: ['muda_resultado'] }),
  );

  assert.equal(padrao?.boilerplate, true);
  // 1 de 5 = 20%, exatamente no limiar. Inclusivo: o corte cai no vazio do vale,
  // então o que empata com ele está do lado do padrão da casa.
  assert.equal(peculiar?.fracao, 0.2);
  assert.equal(peculiar?.boilerplate, true);
});

test('abaixo do limiar não é boilerplate', () => {
  const linhas: LinhaDeTrecho[] = [
    { sha: 't1', classe: 'pegadinha', tipo: 'muda_resultado', trecho: 'a peculiaridade deste mercado' },
  ];
  const indice = montarIndice(linhas, ['t1', 't2', 't3', 't4', 't5', 't6']);

  const f = indice.frequenciaDe(
    achado({ trecho: 'a peculiaridade deste mercado', classe: 'pegadinha', subtipos: ['muda_resultado'] }),
  );

  assert.ok((f as { fracao: number }).fracao < LIMIAR_BOILERPLATE);
  assert.equal(f?.boilerplate, false);
});

// ---------------------------------------------------------------------------
// EIXO 4 — a máscara não encosta no que a tela mostra
// ---------------------------------------------------------------------------

test('o trecho que sai do separador é o LITERAL, nunca o mascarado', () => {
  const indice = montarIndice(LINHAS, TEXTOS);
  const entrada = [achado({ trecho: 'December 31, 2026, 11:59 PM ET' })];

  const { comuns } = separarBoilerplate(entrada, indice);

  // P1: citação não se traduz nem se reescreve. A máscara é chave de contagem.
  assert.equal(comuns[0]?.achado.trecho, 'December 31, 2026, 11:59 PM ET');
});

// ---------------------------------------------------------------------------
// O separador
// ---------------------------------------------------------------------------

test('nada é apagado: o que sai da vista principal está no grupo recolhido', () => {
  const indice = montarIndice(LINHAS, TEXTOS);
  const entrada = [
    achado({ trecho: 'December 31, 2026, 11:59 PM ET' }),
    achado({ trecho: 'uma passagem que só este mercado tem', subtipos: ['criterio_discricionario'] }),
    achado({ trecho: 'June 30, 2027, 11:59 PM ET' }),
  ];

  const { visiveis, comuns } = separarBoilerplate(entrada, indice);

  assert.equal(visiveis.length + comuns.length, entrada.length);
  assert.equal(comuns.length, 2);
  assert.equal(visiveis[0]?.trecho, 'uma passagem que só este mercado tem');
});

test('a ordem dentro de cada lista é a da entrada', () => {
  const indice = montarIndice(LINHAS, TEXTOS);
  const entrada = [
    achado({ trecho: 'June 30, 2027, 11:59 PM ET' }),
    achado({ trecho: 'March 31, 2027, 11:59 PM ET' }),
  ];

  const { comuns } = separarBoilerplate(entrada, indice);

  assert.deepEqual(
    comuns.map(c => c.achado.trecho),
    ['June 30, 2027, 11:59 PM ET', 'March 31, 2027, 11:59 PM ET'],
  );
});

test('sem índice, tudo fica visível e nada recolhe', () => {
  // O estado enquanto as três consultas não voltaram. O achado aparece de
  // qualquer jeito; ele só ainda não sabe se é padrão da casa.
  const entrada = [
    achado({ trecho: 'December 31, 2026, 11:59 PM ET' }),
    achado({ trecho: 'June 30, 2027, 11:59 PM ET' }),
  ];

  const { visiveis, comuns } = separarBoilerplate(entrada, null);

  assert.equal(visiveis.length, 2);
  assert.equal(comuns.length, 0);
});

test('achado sem trecho fica visível e sem frequência', () => {
  const indice = montarIndice(LINHAS, TEXTOS);

  const { visiveis, comuns } = separarBoilerplate([achado({ trecho: null })], indice);

  assert.equal(visiveis.length, 1);
  assert.equal(comuns.length, 0);
  assert.equal(indice.frequenciaDe(achado({ trecho: null })), null);
});

test('trecho que o índice nunca viu não é boilerplate', () => {
  // Não deveria acontecer — o índice é do corpus inteiro. Se acontecer, o
  // achado aparece; sumir por causa de um índice incompleto é descarte
  // silencioso.
  const indice = montarIndice(LINHAS, TEXTOS);

  const { visiveis } = separarBoilerplate([achado({ trecho: 'trecho de outro universo' })], indice);

  assert.equal(visiveis.length, 1);
});

test('a entrada não é modificada', () => {
  const indice = montarIndice(LINHAS, TEXTOS);
  const entrada = [achado({ trecho: 'December 31, 2026, 11:59 PM ET' })];
  const antes = JSON.stringify(entrada);

  separarBoilerplate(entrada, indice);

  assert.equal(JSON.stringify(entrada), antes);
});
