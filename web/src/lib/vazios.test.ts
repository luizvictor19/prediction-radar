import { test } from 'node:test';
import assert from 'node:assert/strict';

import { estadoVazio } from './vazios.js';

/**
 * O estado vazio de uma seção — item 5, seção 5.
 *
 * Cada situação diz uma coisa DIFERENTE, e nenhuma pode ser a ausência da
 * seção: some a seção, e a ausência lê como "o sistema não olhou isto".
 *
 * Os eixos de mutação que estes testes existem para travar:
 *
 * 1. **dizer "nenhuma" havendo herdadas** — é falso, e é a mesma classe de
 *    afirmação velha que o `caa73b9` foi consertar. As herdadas estão logo
 *    abaixo, recolhidas; anunciar zero enquanto elas existem faz a tela mentir
 *    sobre o que ela própria está mostrando.
 * 2. **devolver "nada a dizer" no lugar de "lido e limpo"** — a seção sumiria, e
 *    sumir é a única resposta que a seção 5 proíbe em todas as linhas.
 * 3. **tratar não lido como lido e limpo** — são fatos diferentes. A distinção
 *    já existe no `somaDigest` devolvendo `null` em vez de `0`, e a tela tem que
 *    honrar. `0 leituras, nenhuma armadilha` afirma uma limpeza que ninguém
 *    verificou.
 */

test('com achado acusado, não há estado vazio nenhum', () => {
  assert.equal(estadoVazio({ leituras: 3, acusados: 2, herdados: 0 }), null);
  assert.equal(estadoVazio({ leituras: 3, acusados: 1, herdados: 9 }), null);
});

// ---------------------------------------------------------------------------
// EIXO 3 -- não lido não é lido e limpo
// ---------------------------------------------------------------------------

test('sem leitura nenhuma, a seção diz que não foi lida', () => {
  assert.deepEqual(estadoVazio({ leituras: 0, acusados: 0, herdados: 0 }), {
    tipo: 'sem-leitura',
  });
});

test('sem leitura, o herdado não transforma em "lido e limpo"', () => {
  // Herdado existe sem que este mercado tenha sido lido — é a definição dele.
  // "Lido e limpo" continuaria falso.
  assert.deepEqual(estadoVazio({ leituras: 0, acusados: 0, herdados: 4 }), {
    tipo: 'sem-leitura',
  });
});

// ---------------------------------------------------------------------------
// EIXO 1 -- "nenhuma" havendo herdadas é mentira
// ---------------------------------------------------------------------------

test('nenhuma acusada mas há herdadas: a seção conta as herdadas', () => {
  assert.deepEqual(estadoVazio({ leituras: 3, acusados: 0, herdados: 7 }), {
    tipo: 'so-herdados',
    herdados: 7,
  });
});

test('o N do estado vazio é o número de herdados, não um "há algumas"', () => {
  // Sem o número, o leitor não sabe se abre o bloco por 1 ou por 30.
  const e = estadoVazio({ leituras: 5, acusados: 0, herdados: 1 });
  assert.equal(e?.tipo, 'so-herdados');
  assert.equal((e as { herdados: number }).herdados, 1);
});

// ---------------------------------------------------------------------------
// EIXO 2 -- lido e limpo é uma afirmação, não uma omissão
// ---------------------------------------------------------------------------

test('lido e limpo devolve estado, e carrega quantas leituras', () => {
  // "3 leituras, nenhuma armadilha" só vale como afirmação com o 3 junto: é a
  // diferença entre uma limpeza medida e uma limpeza suposta.
  assert.deepEqual(estadoVazio({ leituras: 3, acusados: 0, herdados: 0 }), {
    tipo: 'limpo',
    leituras: 3,
  });
});

test('uma leitura só ainda é lido e limpo, com o 1 à mostra', () => {
  // O selo `k/n` se recusa a mostrar fração abaixo de três leituras; aqui o
  // número aparece porque ele é o denominador da limpeza, não uma concordância.
  assert.deepEqual(estadoVazio({ leituras: 1, acusados: 0, herdados: 0 }), {
    tipo: 'limpo',
    leituras: 1,
  });
});
