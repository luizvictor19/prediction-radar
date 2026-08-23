import { test } from 'node:test';
import assert from 'node:assert/strict';

import { mostraTrechoNaEsquerda, type Evidenciavel } from './evidencia.js';

/**
 * O invariante da evidência: **o trecho de um achado aparece EXATAMENTE uma
 * vez** — à direita quando está destacado dentro do regulamento, à esquerda
 * quando não está. Nunca nos dois, nunca em nenhum.
 *
 * A tela violou os dois lados em momentos diferentes, e o segundo é pior:
 *
 * - Até a etapa 3, o trecho saía recortado à esquerda E destacado à direita —
 *   duplicação, que é o que a coluna direita foi feita para acabar.
 * - Depois dela, o recorte saiu da esquerda para TODO achado, mas a direita só
 *   destaca armadilhas. Ambiguidade acusada, boilerplate e herdado não-
 *   contradição passaram a não mostrar evidência em lugar nenhum. Sumir com a
 *   citação é pior que repeti-la: a repetição incomoda, a ausência engana.
 *
 * Os eixos de mutação:
 *
 * 1. **mostrar sempre à esquerda** — volta a duplicação, e a interseção deixa
 *    de ser vazia.
 * 2. **nunca mostrar à esquerda** — a união para de cobrir, que é o defeito
 *    que este arquivo existe para travar.
 * 3. **ignorar a ausência de trecho** — um achado sem citação passaria a
 *    "mostrar o trecho", afirmando evidência que não existe.
 */

type Item = Evidenciavel & { achado_id: string };

const A: Item = { achado_id: 'armadilha-destacada', trecho: 'at 12:00 PM ET' };
const B: Item = { achado_id: 'ambiguidade', trecho: '11:59 PM ET' };
const C: Item = { achado_id: 'boilerplate', trecho: 'a consensus of credible reporting' };
const D: Item = { achado_id: 'sem-trecho', trecho: null };
const E: Item = { achado_id: 'trecho-em-branco', trecho: '   ' };

/** Só `A` foi realmente marcado dentro do regulamento. */
const DESTACADOS = new Set(['armadilha-destacada']);

const TODOS = [A, B, C, D, E];

// ---------------------------------------------------------------------------
// O invariante, sobre a lista inteira
// ---------------------------------------------------------------------------

test('a união cobre todo achado com trecho, e a interseção é vazia', () => {
  const esquerda = TODOS.filter(a => mostraTrechoNaEsquerda(a, DESTACADOS)).map(a => a.achado_id);
  const direita = TODOS.filter(a => DESTACADOS.has(a.achado_id)).map(a => a.achado_id);

  // Achado sem citação não participa: não há trecho para colocar em lugar
  // nenhum, e isso não é violação — é ausência de conteúdo, não de evidência.
  const comTrecho = TODOS.filter(a => a.trecho !== null && a.trecho.trim() !== '')
    .map(a => a.achado_id)
    .sort();

  assert.deepEqual([...esquerda, ...direita].sort(), comTrecho, 'a união não cobre');
  assert.deepEqual(
    esquerda.filter(id => direita.includes(id)),
    [],
    'algum trecho aparece nos dois lados',
  );
});

test('nenhum achado com trecho fica sem lado', () => {
  // O "nunca em nenhum", dito como asserção direta: para cada achado com
  // citação, exatamente uma das duas colunas a mostra.
  for (const a of TODOS) {
    if (a.trecho === null || a.trecho.trim() === '') continue;
    const lados = [mostraTrechoNaEsquerda(a, DESTACADOS), DESTACADOS.has(a.achado_id)].filter(
      Boolean,
    ).length;
    assert.equal(lados, 1, `${a.achado_id} apareceu em ${lados} lados`);
  }
});

// ---------------------------------------------------------------------------
// EIXO 1 e 2 — cada lado, isolado
// ---------------------------------------------------------------------------

test('destacado à direita NÃO repete o trecho à esquerda', () => {
  assert.equal(mostraTrechoNaEsquerda(A, DESTACADOS), false);
});

test('não destacado MOSTRA o trecho à esquerda', () => {
  assert.equal(mostraTrechoNaEsquerda(B, DESTACADOS), true);
  assert.equal(mostraTrechoNaEsquerda(C, DESTACADOS), true);
});

test('sem nenhum destaque, tudo que tem trecho aparece à esquerda', () => {
  // O regulamento não carregou, ou é de outra versão da regra e por isso não
  // se destaca nada. A evidência não pode sumir junto: ela volta para o item.
  const vazio = new Set<string>();

  assert.deepEqual(
    TODOS.filter(a => mostraTrechoNaEsquerda(a, vazio)).map(a => a.achado_id),
    ['armadilha-destacada', 'ambiguidade', 'boilerplate'],
  );
});

test('armadilha cujo trecho não foi localizado volta para a esquerda', () => {
  // `destacar` devolve em `naoLocalizados` o que não casou no texto, e esses
  // NÃO entram no conjunto de destacados. Sem isto, uma armadilha com âncora
  // quebrada não mostraria a citação em lado nenhum — o pior dos dois casos,
  // e o mais fácil de não notar.
  const naoLocalizada = { achado_id: 'ancora-quebrada', trecho: 'uma passagem ausente' };

  assert.equal(mostraTrechoNaEsquerda(naoLocalizada, DESTACADOS), true);
});

// ---------------------------------------------------------------------------
// EIXO 3 — sem trecho não é evidência
// ---------------------------------------------------------------------------

test('achado sem trecho não mostra trecho em lado nenhum', () => {
  assert.equal(mostraTrechoNaEsquerda(D, DESTACADOS), false);
  assert.equal(mostraTrechoNaEsquerda(E, DESTACADOS), false);
});
