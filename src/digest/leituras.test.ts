import { test } from 'node:test';
import assert from 'node:assert/strict';
import { jaCarregado, jaDigerido, proximaLeitura, type DigestedIndex } from './leituras.js';

/**
 * A armadilha do passo 2b, virada teste.
 *
 * `jaDigerido` e `jaCarregado` respondem perguntas diferentes sobre a MESMA
 * linha, e trocar uma pela outra é o defeito que faz um job de nivelamento
 * terminar verde tendo gravado zero. O teste existe para que a troca quebre
 * aqui, e não em produção com a fatura já paga.
 *
 * Sem rede: as duas funções são puras sobre o índice.
 */

const CHAVE = {
  eventId: 'ev-1',
  descriptionSha256: 'a'.repeat(64),
  model: 'deepseek-v4-flash',
  promptVersion: 'v4',
};

function indice(leituras: readonly number[]): DigestedIndex {
  const flat = `${CHAVE.eventId}|${CHAVE.descriptionSha256}|${CHAVE.model}|${CHAVE.promptVersion}`;
  return {
    tabelaExiste: true,
    colunaLeituraN: true,
    keys: new Set(leituras.length > 0 ? [flat] : []),
    keysComLeitura: new Set(leituras.map(n => `${flat}|${n}`)),
    leiturasPorTexto: new Map([[CHAVE.descriptionSha256, leituras.length]]),
    maxLeituraPorChave: new Map(leituras.length > 0 ? [[flat, Math.max(...leituras)]] : []),
    combinacoes: new Map([[`${CHAVE.model}|${CHAVE.promptVersion}`, leituras.length]]),
  };
}

test('a leitura 2 de um texto já digerido NÃO está carregada, mesmo com jaDigerido true', () => {
  const index = indice([1]);

  // É este par que arma a armadilha: a chave de quatro diz "já foi", a de cinco
  // diz "esta leitura não". Quem filtrar a carga pela primeira pula tudo.
  assert.equal(jaDigerido(index, CHAVE), true);
  assert.equal(jaCarregado(index, CHAVE, 1), true);
  assert.equal(jaCarregado(index, CHAVE, 2), false);
});

test('proximaLeitura devolve max + 1, e 1 quando a chave nunca foi lida', () => {
  assert.equal(proximaLeitura(indice([1, 2]), CHAVE), 3);
  assert.equal(proximaLeitura(indice([]), CHAVE), 1);
});

test('um buraco na sequência não faz a leitura faltante parecer carregada', () => {
  // O caso que `leituraN <= max` erraria: com a 1 e a 3 gravadas, a 2 está
  // FALTANDO e `2 <= 3` diria que não. A pertinência em conjunto acerta.
  const index = indice([1, 3]);
  assert.equal(jaCarregado(index, CHAVE, 2), false);
  assert.equal(jaCarregado(index, CHAVE, 3), true);
});

test('chave de outro modelo não conta como carregada', () => {
  const index = indice([1]);
  assert.equal(jaCarregado(index, { ...CHAVE, model: 'claude-sonnet-5' }, 1), false);
});
