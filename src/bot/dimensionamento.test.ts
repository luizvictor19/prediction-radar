import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { calcStake, qtd, usd } from './format.js';
import { calcCalendarDrivenStake, explicarSemMarcacao } from '../lib/format-helpers.js';
import type { BankrollState } from '../lib/bankroll.js';

/** Nada aqui toca a rede: são funções puras e um objeto de estado montado à mão. */

describe('calcStake — carteira desconhecida RECUSA, não vira zero', () => {
  it('dimensiona normalmente com carteira conhecida', () => {
    assert.equal(calcStake(1000, 0.03, 5), 25);
  });

  it('bankroll nulo devolve null', () => {
    assert.equal(calcStake(null, 0.03, 5), null);
  });

  it('o perigo concreto: bankroll ZERO devolveria $0.50 por causa do piso', () => {
    // É por isso que o nulo tem que sair ANTES do piso. Tratar "não sei" como
    // zero produziria uma sugestão de cinquenta centavos com cara de conta.
    assert.equal(calcStake(0, 0.03, 5), 0.5);
    assert.equal(calcStake(null, 0.03, 5), null);
  });

  it('carteira zero de verdade não é a mesma coisa que carteira desconhecida', () => {
    assert.notEqual(calcStake(0, 0.03, 5), calcStake(null, 0.03, 5));
  });
});

describe('calcCalendarDrivenStake — mesma recusa', () => {
  it('dimensiona com carteira conhecida', () => {
    assert.equal(calcCalendarDrivenStake(1000, 0.03, 0.5), 15);
  });

  it('bankroll nulo devolve null', () => {
    assert.equal(calcCalendarDrivenStake(null, 0.03, 0.5), null);
  });

  it('bankroll zero devolve 0, que é número — e por isso não serve de nulo', () => {
    assert.equal(calcCalendarDrivenStake(0, 0.03, 0.5), 0);
  });
});

describe('usd / qtd — o desconhecido aparece como "—", nunca como 0', () => {
  it('formata número', () => {
    assert.equal(usd(12.3), '$12.30');
    assert.equal(qtd(12.34), '12.3');
  });

  it('formata nulo como travessão', () => {
    assert.equal(usd(null), '—');
    assert.equal(qtd(null), '—');
  });

  it('zero continua sendo zero, e é visivelmente diferente do desconhecido', () => {
    assert.equal(usd(0), '$0.00');
    assert.notEqual(usd(0), usd(null));
  });
});

function estado(over: Partial<BankrollState> = {}): BankrollState {
  return {
    cash: 100,
    portfolio_value: null,
    portfolio_value_parcial: 40,
    bankroll: null,
    legs_count: 3,
    legs_sem_marcacao: 2,
    motivos_sem_marcacao: {
      'livro de um lado so': 1,
      'mercado sem foto (fora do radar)': 1,
    },
    stake_committed: 60,
    ...over,
  };
}

describe('explicarSemMarcacao — o número visível que impede a falha silenciosa', () => {
  it('não diz nada quando a carteira está marcada', () => {
    assert.equal(explicarSemMarcacao(estado({ bankroll: 140, portfolio_value: 40 })), '');
  });

  it('diz quantas legs e por quê', () => {
    const texto = explicarSemMarcacao(estado());
    assert.match(texto, /2 legs abertas sem preço de mercado/);
    assert.match(texto, /livro de um lado so/);
    assert.match(texto, /mercado sem foto/);
  });

  it('mostra o parcial e diz que é parcial', () => {
    const texto = explicarSemMarcacao(estado());
    assert.match(texto, /\$40\.00/);
    assert.match(texto, /parcial, não é o total/);
  });

  it('concorda em número no singular', () => {
    const texto = explicarSemMarcacao(
      estado({ legs_sem_marcacao: 1, motivos_sem_marcacao: { 'livro de um lado so': 1 } }),
    );
    assert.match(texto, /1 leg aberta sem preço/);
  });

  it('ordena os motivos do mais frequente para o menos', () => {
    const texto = explicarSemMarcacao(
      estado({
        legs_sem_marcacao: 5,
        motivos_sem_marcacao: { raro: 1, comum: 4 },
      }),
    );
    assert.ok(texto.indexOf('4× comum') < texto.indexOf('1× raro'));
  });
});
