import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { formatarProb, lerProbabilidade } from './prob-self.js';

/** Nada aqui toca a rede: é parser puro. */

function prob(raw: string): number | null {
  const r = lerProbabilidade(raw);
  return r.ok ? r.prob : null;
}

describe('lerProbabilidade — % entra, 0–1 sai', () => {
  it('converte o exemplo da pergunta', () => {
    assert.equal(prob('72'), 0.72);
  });

  it('aceita o sinal de porcentagem', () => {
    assert.equal(prob('72%'), 0.72);
  });

  it('aceita vírgula decimal', () => {
    assert.equal(prob('72,5'), 0.725);
  });

  it('aceita ponto decimal', () => {
    assert.equal(prob('72.5'), 0.725);
  });

  it('aceita espaço em volta', () => {
    assert.equal(prob('  72 %  '), 0.72);
  });

  it('arredonda para o grão da coluna numeric(4,3)', () => {
    // 33,33% = 0,3333 não cabe em 3 casas: o valor gravado tem que ser o
    // mesmo que o resumo mostrou.
    assert.equal(prob('33.33'), 0.333);
    assert.equal(prob('33.35'), 0.334);
  });
});

describe('lerProbabilidade — as bordas do intervalo', () => {
  it('aceita 0', () => {
    assert.equal(prob('0'), 0);
  });

  it('aceita 100', () => {
    assert.equal(prob('100'), 1);
  });

  it('recusa acima de 100', () => {
    const r = lerProbabilidade('101');
    assert.equal(r.ok, false);
    assert.match(r.ok === false ? r.motivo : '', /0–100/);
  });

  it('recusa negativo', () => {
    assert.equal(lerProbabilidade('-1').ok, false);
  });
});

describe('lerProbabilidade — o que NÃO pode ser adivinhado', () => {
  it('"0.72" é 0,72%, não 72% — o parser não adivinha a escala', () => {
    // Se um dia isto virar 0.72, a defesa contra o erro de digitação some e o
    // mercado de cauda vira impossível de registrar.
    assert.equal(prob('0.72'), 0.007);
  });

  it('recusa texto com número dentro', () => {
    assert.equal(lerProbabilidade('72 ou 73').ok, false);
    assert.equal(lerProbabilidade('72abc').ok, false);
  });

  it('recusa vazio e skip', () => {
    assert.equal(lerProbabilidade('').ok, false);
    assert.equal(lerProbabilidade('   ').ok, false);
    assert.equal(lerProbabilidade('skip').ok, false);
  });

  it('recusa notação exponencial', () => {
    assert.equal(lerProbabilidade('7e1').ok, false);
  });
});

describe('formatarProb — o resumo mostra as duas escalas', () => {
  it('mostra % e 0–1 lado a lado', () => {
    assert.equal(formatarProb(0.72), '72.0% (0.720)');
  });

  it('o erro de escala fica visível antes de gravar', () => {
    assert.equal(formatarProb(0.007), '0.7% (0.007)');
  });
});
