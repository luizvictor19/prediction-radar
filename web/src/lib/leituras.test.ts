import { test } from 'node:test';
import assert from 'node:assert/strict';

import { MINIMO_LEITURAS, seloDeConfirmacao, seloDeCobertura } from './leituras.js';

/**
 * O gate de exibição do selo de confirmação.
 *
 * `k/n` só é concordância entre leituras quando há maioria para medir. Com duas
 * leituras, um achado que aparece numa e não na outra fica 1/2 — empate, sem
 * maioria. Com UMA leitura, `1/1` não é concordância nenhuma: é não medido.
 *
 * Exibir os dois com a mesma forma tipográfica sugere comparabilidade que não
 * existe — `1/1` ao lado de `2/3` lê como "este é mais confirmado", e não é.
 *
 * O mesmo número de `scripts/nivelar-leituras.ts`, e pela mesma razão.
 */

test('com três leituras o selo é a fração, e é comparável', () => {
  const selo = seloDeConfirmacao(2, 3);

  assert.equal(selo.comparavel, true);
  assert.equal(selo.texto, '2/3');
});

test('com uma leitura o selo diz não comparável, e nunca 1/1', () => {
  const selo = seloDeConfirmacao(1, 1);

  assert.equal(selo.comparavel, false);
  assert.equal(selo.texto, '1 leitura — não comparável');
  assert.ok(!selo.texto.includes('1/1'), 'o selo não pode exibir a fração');
});

test('com duas leituras também não há maioria', () => {
  // 1/2 é empate. 2/2 é duas leituras que concordam, o que não é maioria de
  // três — e a tela não pode sugerir que é.
  const empate = seloDeConfirmacao(1, 2);
  const acordo = seloDeConfirmacao(2, 2);

  assert.equal(empate.comparavel, false);
  assert.equal(empate.texto, '2 leituras — não comparável');
  assert.equal(acordo.comparavel, false);
  assert.equal(acordo.texto, '2 leituras — não comparável');
});

test('o mínimo é três', () => {
  assert.equal(MINIMO_LEITURAS, 3);
  assert.equal(seloDeConfirmacao(3, MINIMO_LEITURAS).comparavel, true);
  assert.equal(seloDeConfirmacao(1, MINIMO_LEITURAS - 1).comparavel, false);
});

// ---------------------------------------------------------------------------
// O selo de cobertura, na lista
// ---------------------------------------------------------------------------

test('mercado cujo texto tem menos de três leituras é marcado na lista', () => {
  const selo = seloDeCobertura([1]);

  assert.equal(selo?.comparavel, false);
  assert.equal(selo?.texto, '1 leitura — não comparável');
});

test('mercado com três leituras não ganha marca nenhuma', () => {
  // Marca só onde há o que avisar. Selo em toda linha vira ruído e some.
  assert.equal(seloDeCobertura([3]), null);
});

test('mercado sem digestão não ganha marca de leitura', () => {
  // "Sem digestão" já é dito em outro lugar da linha. Dizer duas vezes por
  // caminhos diferentes é o começo de dois números que discordam.
  assert.equal(seloDeCobertura([]), null);
});

test('com dois textos manda o PIOR deles', () => {
  // FIXTURE SINTÉTICO: nenhum mercado tem dois textos hoje — 1033 linhas para
  // 1033 mercados, medido em 22/08/2026 por `npm run medir:tela-regra`.
  // O pior manda porque a linha é uma só — dizer "3
  // leituras" com um texto medido uma vez esconde o texto fraco.
  const selo = seloDeCobertura([3, 1]);

  assert.equal(selo?.comparavel, false);
  assert.equal(selo?.texto, '1 leitura — não comparável');
});
