import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { Livro } from './lado-oposto.js';
import {
  derivarOposto,
  ladoDaLeg,
  podeDerivar,
  rotulosDoMercado,
} from './lado-oposto.js';

/** Nada aqui toca a rede: aritmética e um jsonb copiado do banco. */

const YES_NO = { prices: ['0.18', '0.82'], values: ['Yes', 'No'] };

function livro(over: Partial<Livro> = {}): Livro {
  return { mid: 0.18, bid: 0.17, ask: 0.19, bidDepth: 823.76, askDepth: 400, ...over };
}

describe('derivarOposto — a identidade do mercado de dois resultados', () => {
  it('mid vira 1 menos mid', () => {
    assert.equal(derivarOposto(livro({ mid: 0.25, bid: 0.25, ask: 0.25 })).mid, 0.75);
  });

  it('bid e ask CRUZAM: bid_no = 1 - ask_yes', () => {
    const o = derivarOposto(livro());
    assert.equal(o.bid, 1 - 0.19);
    assert.equal(o.ask, 1 - 0.17);
  });

  it('o spread é preservado, não invertido', () => {
    const o = derivarOposto(livro());
    // Se bid e ask fossem copiados sem cruzar, o spread sairia negativo — e
    // livro invertido é observação legítima neste projeto, então passaria.
    assert.ok((o.ask as number) > (o.bid as number));
    const spreadOriginal = 0.19 - 0.17;
    assert.ok(Math.abs((o.ask as number) - (o.bid as number) - spreadOriginal) < 1e-9);
  });

  it('profundidade NÃO é derivável e sai nula dos dois lados', () => {
    const o = derivarOposto(livro());
    assert.equal(o.bidDepth, null);
    assert.equal(o.askDepth, null);
  });

  it('livro de um lado só deriva o lado que existe e mantém o nulo do outro', () => {
    // Azarão com só venda: ask 0,05, sem bid. O oposto tem bid 0,95 e sem ask.
    const o = derivarOposto(livro({ mid: null, bid: null, ask: 0.05 }));
    assert.equal(o.mid, null);
    assert.equal(o.bid, 0.95);
    assert.equal(o.ask, null);
  });

  it('sai no grão da coluna numeric(5,4), sem sujeira de float', () => {
    // `1 - 0.18` em JS é 0.8200000000000001. O Postgres calcula em decimal
    // exato, e a comparação entre os dois é o que o conferir-views faz.
    assert.equal(derivarOposto(livro()).mid, 0.82);
  });

  it('derivar duas vezes volta ao original', () => {
    const original = livro();
    const ida = derivarOposto(original);
    const volta = derivarOposto(ida);
    assert.ok(Math.abs((volta.mid as number) - (original.mid as number)) < 1e-9);
    assert.ok(Math.abs((volta.bid as number) - (original.bid as number)) < 1e-9);
    assert.ok(Math.abs((volta.ask as number) - (original.ask as number)) < 1e-9);
    // Mas a profundidade não volta: ela foi perdida, e continua perdida.
    assert.equal(volta.bidDepth, null);
  });
});

describe('podeDerivar — quando a identidade vale', () => {
  it('vale para o outro rótulo de um mercado de dois', () => {
    assert.equal(podeDerivar(YES_NO, 'Yes', 'No'), true);
  });

  it('não vale para o mesmo rótulo (aí é coletado, não derivado)', () => {
    assert.equal(podeDerivar(YES_NO, 'Yes', 'Yes'), false);
  });

  it('não vale para rótulo fora dos outcomes do mercado', () => {
    // O caso real das 61 legs: nome de time num mercado Yes/No.
    assert.equal(podeDerivar(YES_NO, 'Yes', 'Team Falcons'), false);
  });

  it('não vale com três resultados: 1 - p(A) é a soma dos outros dois', () => {
    const tres = { values: ['A', 'B', 'C'] };
    assert.equal(podeDerivar(tres, 'A', 'B'), false);
  });

  it('não vale sem outcomes, com forma inesperada, ou com values não-texto', () => {
    assert.equal(podeDerivar(null, 'Yes', 'No'), false);
    assert.equal(podeDerivar({}, 'Yes', 'No'), false);
    assert.equal(podeDerivar({ values: 'Yes,No' }, 'Yes', 'No'), false);
    assert.equal(podeDerivar({ values: [1, 2] }, 'Yes', 'No'), false);
  });

  it('rótulo é comparado exato, sem normalizar caixa', () => {
    // Normalizar aqui esconderia divergência de rótulo entre coleta e registro,
    // que é informação — não ruído.
    assert.equal(podeDerivar(YES_NO, 'Yes', 'no'), false);
  });
});

describe('rotulosDoMercado', () => {
  it('lê o formato real de events.outcomes', () => {
    assert.deepEqual(rotulosDoMercado(YES_NO), ['Yes', 'No']);
  });

  it('devolve null para o que não é a forma esperada', () => {
    assert.equal(rotulosDoMercado(null), null);
    assert.equal(rotulosDoMercado('Yes'), null);
    assert.equal(rotulosDoMercado({ prices: ['0.1'] }), null);
  });
});

describe('ladoDaLeg — a orquestração, e a origem declarada', () => {
  it('rótulo igual: devolve o livro coletado, com profundidade', () => {
    const r = ladoDaLeg(livro(), 'Yes', 'Yes', YES_NO);
    assert.equal(r.origem, 'coletado');
    assert.equal(r.mid, 0.18);
    assert.equal(r.bidDepth, 823.76);
  });

  it('outro lado do binário: derivado, sem profundidade', () => {
    const r = ladoDaLeg(livro(), 'Yes', 'No', YES_NO);
    assert.equal(r.origem, 'derivado');
    assert.equal(r.mid, 0.82);
    assert.equal(r.bid, 1 - 0.19);
    assert.equal(r.bidDepth, null);
    assert.equal(r.askDepth, null);
  });

  it('rótulo estranho: tudo nulo e origem nula — nunca 1 - mid por descuido', () => {
    const r = ladoDaLeg(livro(), 'Yes', 'Team Falcons', YES_NO);
    assert.equal(r.origem, null);
    assert.equal(r.mid, null);
    assert.equal(r.bid, null);
    assert.equal(r.ask, null);
  });

  it('mid nulo continua nulo dos dois lados', () => {
    const r = ladoDaLeg(livro({ mid: null, bid: null, ask: 0.05 }), 'Yes', 'No', YES_NO);
    assert.equal(r.origem, 'derivado');
    assert.equal(r.mid, null);
    assert.equal(r.bid, 0.95);
  });
});
