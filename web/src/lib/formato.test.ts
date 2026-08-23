import { test } from 'node:test';
import assert from 'node:assert/strict';

import { dinheiro } from './formato.js';

/**
 * `$` sozinho não diz qual dólar.
 *
 * A tela é lida em português e o mercado é precificado em dólar americano; `$`
 * ao lado de um número em português lê como real com o símbolo errado. `US$` é
 * a grafia que a spec usa e a que o resto da tela já escreve à mão.
 */

test('dinheiro escreve US$, não $', () => {
  assert.equal(dinheiro(53_000), 'US$ 53k');
  assert.equal(dinheiro(1_400_000), 'US$ 1.4M');
  assert.equal(dinheiro(812), 'US$ 812');
});

test('nulo continua vazio, e nunca US$ 0', () => {
  // Liquidez desconhecida não é liquidez zero. É a mesma distinção que
  // `mid_price` nulo faz, e que já fabricou um gap falso neste projeto.
  assert.equal(dinheiro(null), '—');
  assert.equal(dinheiro(0), 'US$ 0');
});
