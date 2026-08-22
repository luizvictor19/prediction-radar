import { test } from 'node:test';
import assert from 'node:assert/strict';

import { destacar, type PedidoDeDestaque } from './destaque.js';

/**
 * Destaque dentro do regulamento — etapa 3 do item 5.
 *
 * A coluna direita mostra a cláusula ONDE ELA VIVE, em vez de recortada. Recorte
 * fora de contexto é como a manchete engana; o antídoto é o texto inteiro com a
 * passagem marcada dentro dele.
 *
 * Os eixos de mutação que estes testes existem para travar:
 *
 * 1. **sumir com o não localizado** — a coluna mostraria menos destaques do que
 *    a esquerda mostra achados, e ninguém contaria os dois para perceber. O
 *    achado que não bate no texto tem que sair marcado como tal.
 * 2. **casar espaço em branco literalmente** — o `trecho` vem do modelo com
 *    espaço simples e o regulamento tem quebra de linha no meio da frase, então
 *    `indexOf` cru não acha e o achado vira "não localizado" por engano.
 * 3. **deixar a marca clara vencer, ou aninhar marcação** — `<mark>` não aninha
 *    em HTML: sobreposição vira SEGMENTAÇÃO de intervalos, e no pedaço comum
 *    vence o tom forte, porque "muda o resultado" é a informação que não pode
 *    ser encoberta por "isto é padrão da casa".
 * 4. **devolver o texto alterado** — a concatenação dos segmentos tem que ser o
 *    regulamento caractere por caractere. É P1: citação não se reescreve, e o
 *    regulamento é a maior citação da tela.
 */

const REGULAMENTO = [
  'This market will resolve to "Yes" if the top two candidates',
  'are separated by more than 5 points by December 31, 2026,',
  '11:59 PM ET, according to a consensus of credible reporting.',
].join('\n');

function pedido(over: Partial<PedidoDeDestaque> & { id: string }): PedidoDeDestaque {
  return { trecho: null, marca: 'forte', ...over };
}

// ---------------------------------------------------------------------------
// AXIS 4 -- o regulamento sai inteiro
// ---------------------------------------------------------------------------

test('a concatenação dos segmentos é o regulamento, caractere por caractere', () => {
  const { segmentos } = destacar(REGULAMENTO, [
    pedido({ id: 'a', trecho: '11:59 PM ET', marca: 'clara' }),
    pedido({ id: 'b', trecho: 'more than 5 points' }),
  ]);

  assert.equal(segmentos.map(s => s.texto).join(''), REGULAMENTO);
});

test('sem pedido nenhum, o texto sai num segmento sem marca', () => {
  const { segmentos, naoLocalizados } = destacar(REGULAMENTO, []);

  assert.deepEqual(segmentos, [{ texto: REGULAMENTO, marca: null, ids: [] }]);
  assert.equal(naoLocalizados.length, 0);
});

// ---------------------------------------------------------------------------
// AXIS 1 -- o não localizado aparece
// ---------------------------------------------------------------------------

test('trecho que não está no regulamento vai para naoLocalizados', () => {
  const { segmentos, naoLocalizados } = destacar(REGULAMENTO, [
    pedido({ id: 'fantasma', trecho: 'uma cláusula que este texto não tem' }),
  ]);

  assert.deepEqual(naoLocalizados.map(p => p.id), ['fantasma']);
  // E o texto continua inteiro, sem marca nenhuma.
  assert.equal(segmentos.map(s => s.texto).join(''), REGULAMENTO);
  assert.ok(segmentos.every(s => s.marca === null));
});

test('achado sem trecho também é contabilizado, não descartado', () => {
  const { naoLocalizados } = destacar(REGULAMENTO, [
    pedido({ id: 'sem-trecho', trecho: null }),
    pedido({ id: 'vazio', trecho: '   ' }),
  ]);

  assert.deepEqual(naoLocalizados.map(p => p.id).sort(), ['sem-trecho', 'vazio']);
});

test('localizado e não localizado somam os pedidos, sempre', () => {
  const pedidos = [
    pedido({ id: 'acha', trecho: '11:59 PM ET' }),
    pedido({ id: 'nao-acha', trecho: 'texto ausente' }),
    pedido({ id: 'acha2', trecho: 'credible reporting', marca: 'clara' }),
  ];

  const { segmentos, naoLocalizados } = destacar(REGULAMENTO, pedidos);
  const localizados = new Set(segmentos.flatMap(s => s.ids));

  assert.equal(localizados.size + naoLocalizados.length, pedidos.length);
});

// ---------------------------------------------------------------------------
// AXIS 2 -- espaço em branco não pode derrubar a localização
// ---------------------------------------------------------------------------

test('trecho com espaço simples acha o texto quebrado em linhas', () => {
  // O `trecho` vem do modelo numa linha só; o regulamento tem `\n` no meio.
  // Casar literalmente falharia e o achado viraria "não localizado" por engano,
  // que é o pior desfecho: uma falha inventada onde não houve nenhuma.
  const { segmentos, naoLocalizados } = destacar(REGULAMENTO, [
    pedido({ id: 'quebrado', trecho: 'candidates are separated by' }),
  ]);

  assert.equal(naoLocalizados.length, 0);
  const marcado = segmentos.filter(s => s.marca !== null).map(s => s.texto).join('');
  // Sai com a quebra de linha ORIGINAL dentro, não normalizada.
  assert.ok(marcado.includes('\n'), JSON.stringify(marcado));
  assert.equal(marcado, 'candidates\nare separated by');
});

test('espaço repetido no regulamento também casa', () => {
  const texto = 'resolve   to    Yes when';
  const { naoLocalizados, segmentos } = destacar(texto, [
    pedido({ id: 'x', trecho: 'resolve to Yes' }),
  ]);

  assert.equal(naoLocalizados.length, 0);
  assert.equal(segmentos.find(s => s.marca !== null)?.texto, 'resolve   to    Yes');
});

// ---------------------------------------------------------------------------
// AXIS 3 -- sobreposição vira segmentação, e o forte vence
// ---------------------------------------------------------------------------

test('no pedaço compartilhado, forte vence clara', () => {
  const texto = 'by December 31, 2026, 11:59 PM ET, the market resolves';
  const { segmentos } = destacar(texto, [
    pedido({ id: 'boiler', trecho: '11:59 PM ET', marca: 'clara' }),
    pedido({ id: 'armadilha', trecho: 'December 31, 2026, 11:59 PM ET', marca: 'forte' }),
  ]);

  const compartilhado = segmentos.find(s => s.texto.includes('11:59'));
  assert.equal(compartilhado?.marca, 'forte');
  // O segmento compartilhado sabe dos DOIS achados: a marca escolhe o tom, não
  // apaga o outro achado da lista de quem cobre aquele pedaço.
  assert.deepEqual(compartilhado?.ids.slice().sort(), ['armadilha', 'boiler']);
});

test('a saída é plana: nenhum segmento contém outro', () => {
  // `<mark>` não aninha em HTML. Se a função devolvesse intervalos aninhados, o
  // componente teria que decidir sozinho como achatá-los — e decidiria errado.
  const texto = 'by December 31, 2026, 11:59 PM ET, the market resolves';
  const { segmentos } = destacar(texto, [
    pedido({ id: 'boiler', trecho: '11:59 PM ET', marca: 'clara' }),
    pedido({ id: 'armadilha', trecho: 'December 31, 2026, 11:59 PM ET', marca: 'forte' }),
  ]);

  assert.equal(segmentos.map(s => s.texto).join(''), texto);
  // Nenhum segmento vazio, e a soma dos comprimentos é o texto.
  assert.ok(segmentos.every(s => s.texto.length > 0));
});

test('sobreposição parcial reparte em três pedaços', () => {
  const texto = 'aaa bbb ccc ddd';
  const { segmentos } = destacar(texto, [
    pedido({ id: 'esq', trecho: 'aaa bbb ccc', marca: 'clara' }),
    pedido({ id: 'dir', trecho: 'bbb ccc ddd', marca: 'forte' }),
  ]);

  assert.equal(segmentos.map(s => s.texto).join(''), texto);
  assert.deepEqual(
    segmentos.map(s => [s.texto, s.marca]),
    [
      ['aaa ', 'clara'],
      ['bbb ccc', 'forte'],
      [' ddd', 'forte'],
    ],
  );
});

// ---------------------------------------------------------------------------
// Bordas
// ---------------------------------------------------------------------------

test('borda de palavra: ET não é destacado dentro de market', () => {
  // Mesma razão de `contemTrecho` na dedup: sem a borda, um fragmento curto
  // marca pedaço de palavra e a coluna fica pintada de ruído.
  const texto = 'the market resolves at noon';
  const { segmentos, naoLocalizados } = destacar(texto, [pedido({ id: 'et', trecho: 'et' })]);

  assert.deepEqual(naoLocalizados.map(p => p.id), ['et']);
  assert.ok(segmentos.every(s => s.marca === null));
});

test('todas as ocorrências do mesmo trecho são destacadas', () => {
  // Duas datas com o mesmo defeito. Marcar só a primeira deixaria a segunda
  // idêntica e sem marca ao lado dela, que se lê como falha da tela.
  const texto = 'by 11:59 PM ET, or by 11:59 PM ET at the latest';
  const { segmentos } = destacar(texto, [
    pedido({ id: 'fuso', trecho: '11:59 PM ET', marca: 'clara' }),
  ]);

  assert.equal(segmentos.filter(s => s.marca === 'clara').length, 2);
  assert.equal(segmentos.map(s => s.texto).join(''), texto);
});

test('regulamento vazio não inventa segmento', () => {
  const { segmentos, naoLocalizados } = destacar('', [pedido({ id: 'x', trecho: 'algo' })]);

  assert.deepEqual(segmentos, []);
  assert.deepEqual(naoLocalizados.map(p => p.id), ['x']);
});

test('a entrada não é modificada', () => {
  const pedidos = [pedido({ id: 'a', trecho: '11:59 PM ET' })];
  const antes = JSON.stringify(pedidos);

  destacar(REGULAMENTO, pedidos);

  assert.equal(JSON.stringify(pedidos), antes);
});
