import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { decideSide } from './prob-self-outcome.js';

/** Nada aqui toca rede nem banco: a decisão é pura, por desenho. */

describe('decideSide: de que lado é a probabilidade', () => {
  it('aposta única com lado devolve o rótulo, inalterado', () => {
    const d = decideSide({ kind: 'single_market', outcome: 'Yes' });
    assert.deepEqual(d, { kind: 'label', outcome: 'Yes' });
  });

  it('o lado pode ser No, e não é normalizado para o Yes da pergunta', () => {
    // O caso que motiva a coluna existir: o bot registra o lado que a pessoa
    // digitou, e ele nem sempre é o índice 0 do mercado.
    const d = decideSide({ kind: 'single_market', outcome: 'No' });
    assert.deepEqual(d, { kind: 'label', outcome: 'No' });
  });

  it('rótulo que não é Yes nem No atravessa igual', () => {
    // `events.resolved_outcome` é rótulo livre: pontuar é comparar string com
    // string, então qualquer tradução aqui quebraria a comparação.
    for (const rotulo of ['T1', 'Bilibili Gaming', 'Nothing', 'Over 2.5']) {
      assert.deepEqual(decideSide({ kind: 'single_market', outcome: rotulo }), {
        kind: 'label',
        outcome: rotulo,
      });
    }
  });

  it('cesta não escreve rótulo, e não inventa um', () => {
    const d = decideSide({ kind: 'basket' });
    assert.deepEqual(d, { kind: 'no_label' });
  });

  it('cesta NÃO é recusa: a probabilidade da cesta é gravada, sem lado', () => {
    // Se `no_label` virasse `refuse`, o registro de cesta pararia de funcionar
    // inteiro. As duas respostas são diferentes de propósito.
    const d = decideSide({ kind: 'basket' });
    assert.equal(d.kind, 'no_label');
    assert.notEqual(d.kind, 'refuse');
  });

  it('mercado sem lado é RECUSA, não rótulo nulo', () => {
    // A distinção inteira do módulo. Nulo aqui pareceria a mesma coisa que o
    // nulo legítimo da cesta, e a linha viraria uma probabilidade que ninguém
    // consegue pontuar depois.
    const d = decideSide({ kind: 'single_market', outcome: null });
    assert.deepEqual(d, { kind: 'refuse', reason: 'market_without_side' });
  });

  it('lado em branco conta como ausente, não como rótulo vazio', () => {
    for (const vazio of ['', '   ', '\t']) {
      assert.deepEqual(decideSide({ kind: 'single_market', outcome: vazio }), {
        kind: 'refuse',
        reason: 'market_without_side',
      });
    }
  });

  it('cesta e mercado-sem-lado nunca devolvem a mesma resposta', () => {
    // A asserção que trava a fusão dos dois casos: ambos "não têm rótulo", e
    // tratá-los igual é exatamente o defeito.
    const cesta = decideSide({ kind: 'basket' });
    const semLado = decideSide({ kind: 'single_market', outcome: null });
    assert.notEqual(cesta.kind, semLado.kind);
  });

  it('a decisão não olha nada além do sujeito que recebeu', () => {
    // Mesma entrada, mesma saída, sempre. Sem relógio, sem banco, sem ordem.
    const a = decideSide({ kind: 'single_market', outcome: 'Yes' });
    const b = decideSide({ kind: 'single_market', outcome: 'Yes' });
    assert.deepEqual(a, b);
  });
});
