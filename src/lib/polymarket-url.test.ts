import assert from 'node:assert/strict';
import test from 'node:test';

import { polymarketUrl } from './polymarket-url.js';

/**
 * The axes here are the ones a mutation has to die on. Each test names the
 * mutation it exists to kill, because a test whose purpose is implicit is a
 * test the next person deletes as redundant.
 */

const MERCADO = 'will-oscar-piastri-be-the-2026-f1-drivers-champion';
const GRUPO = '2026-f1-drivers-champion';

test('com os dois slugs, monta /event/<grupo>/<mercado> — nessa ordem', () => {
  assert.equal(
    polymarketUrl(MERCADO, GRUPO),
    `https://polymarket.com/event/${GRUPO}/${MERCADO}`,
    'o grupo vem primeiro e o mercado depois; inverter os dois dá 404',
  );
});

test('trocar event_group_slug por slug quebra a URL', () => {
  // O eixo da mutação. Os dois slugs são DIFERENTES de propósito: com slugs
  // iguais qualquer troca entre eles produz a mesma string e a asserção passa
  // sem nunca ter alcançado a regra. Medido: /event/<mercado> deu 404 em 40 de
  // 40 mercados divergentes.
  const url = polymarketUrl(MERCADO, GRUPO) as string;

  assert.notEqual(MERCADO, GRUPO, 'o fixture perde o sentido se os dois slugs coincidirem');
  assert.equal(
    url,
    `https://polymarket.com/event/${GRUPO}/${MERCADO}`,
    'a URL montada com o slug errado no lugar do grupo',
  );
  assert.notEqual(
    url,
    `https://polymarket.com/event/${MERCADO}/${MERCADO}`,
    'slug de mercado no lugar do grupo: é exatamente o defeito que isto trava',
  );
  assert.notEqual(
    url,
    `https://polymarket.com/event/${MERCADO}`,
    'slug de mercado num caminho de evento: o defeito original da tela',
  );
});

test('sem slug de mercado, devolve null — o ramo do nulo tem caso próprio', () => {
  assert.equal(polymarketUrl(null, GRUPO), null, 'sem mercado não há URL, nem com grupo');
  assert.equal(polymarketUrl(undefined, GRUPO), null, 'undefined é ausente igual a null');
  assert.equal(polymarketUrl(null, null), null, 'sem nenhum dos dois, null');
});

test('slug em branco conta como ausente, não vira /market/', () => {
  assert.equal(polymarketUrl('', GRUPO), null, 'string vazia montaria uma URL sem mercado');
  assert.equal(polymarketUrl('   ', GRUPO), null, 'só espaço é ausente');
});

test('sem grupo, cai para /market/<mercado> e não para /event/<mercado>', () => {
  // O outro ramo do nulo, e o que ele NÃO pode virar. /event/<mercado> é o
  // defeito original; /market/<mercado> foi medido abrindo 55/55.
  const url = polymarketUrl(MERCADO, null);

  assert.equal(url, `https://polymarket.com/market/${MERCADO}`, 'o fallback é /market/');
  assert.notEqual(
    url,
    `https://polymarket.com/event/${MERCADO}`,
    'cair para o caminho de evento é reintroduzir o 404',
  );
});

test('grupo em branco também cai para o fallback', () => {
  assert.equal(polymarketUrl(MERCADO, ''), `https://polymarket.com/market/${MERCADO}`);
  assert.equal(polymarketUrl(MERCADO, '  '), `https://polymarket.com/market/${MERCADO}`);
});

test('slugs iguais não têm caso especial: viram /event/<slug>/<slug>', () => {
  // Evento de mercado único. A forma repetida foi medida abrindo 15/15, então
  // um ramo próprio aqui seria galho que a medição diz não existir — e é o tipo
  // de ramo que só é alcançado quando alguém o acrescenta.
  const unico = 'will-russia-invade-another-country-in-2026';

  assert.equal(
    polymarketUrl(unico, unico),
    `https://polymarket.com/event/${unico}/${unico}`,
    'mercado único segue a mesma regra dos outros',
  );
});

test('a ordem das guardas: mercado ausente vence grupo presente', () => {
  // Trocar a ordem dos dois ifs faria esta linha devolver uma URL de evento sem
  // mercado nenhum. É a mutação que nenhum dos outros casos alcança.
  assert.equal(
    polymarketUrl(null, GRUPO),
    null,
    'grupo sozinho não endereça mercado nenhum, e um link para a lista não é o link da regra',
  );
});
