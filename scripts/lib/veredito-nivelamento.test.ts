import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  MINIMO_ACHADOS_PARA_JULGAR,
  MINIMO_TEXTOS_PARA_JULGAR,
  vereditoDoNivelamento,
} from './veredito-nivelamento.js';

/**
 * Nada aqui toca rede: o veredito é decidido por três números, e é por isso que
 * ele mora fora de `nivelar-leituras.ts`, que fala com o banco ao importar.
 *
 * As asserções são sobre a CLASSE do veredito e não sobre o percentual. O
 * percentual existe nos dois lados do piso; o que o piso muda é o direito de
 * concluir a partir dele, e é isso que precisa estar travado.
 */

/** Um ganho que estoura os 30% com folga, para o piso ser a única variável. */
function comGanhoDe30PorCento(antes: number): number {
  return antes + Math.ceil(antes * 0.5);
}

describe('o piso de achados, na fronteira', () => {
  const textos = MINIMO_TEXTOS_PARA_JULGAR + 5;

  it('19 achados não conclui, mesmo com textos de sobra', () => {
    const v = vereditoDoNivelamento(textos, 19, comGanhoDe30PorCento(19));
    assert.equal(v.classe, 'amostra_curta');
  });

  it('20 achados já conclui: o piso é inclusivo', () => {
    const v = vereditoDoNivelamento(textos, 20, comGanhoDe30PorCento(20));
    assert.equal(v.classe, 'confirma');
  });

  it('21 achados conclui', () => {
    const v = vereditoDoNivelamento(textos, 21, comGanhoDe30PorCento(21));
    assert.equal(v.classe, 'confirma');
  });

  it('a fronteira é 19 -> 20 e não 20 -> 21', () => {
    // A sequência inteira, e não só o destino: 20 sozinho passaria mesmo se o
    // piso fosse 19, e 21 sozinho passaria com qualquer piso abaixo dele.
    const classes = [19, 20, 21].map(
      a => vereditoDoNivelamento(textos, a, comGanhoDe30PorCento(a)).classe,
    );
    assert.deepEqual(classes, ['amostra_curta', 'confirma', 'confirma']);
  });
});

describe('o piso de textos, na fronteira', () => {
  const antes = MINIMO_ACHADOS_PARA_JULGAR + 30;
  const depois = comGanhoDe30PorCento(antes);

  it('19 textos não conclui, mesmo com achados de sobra', () => {
    assert.equal(vereditoDoNivelamento(19, antes, depois).classe, 'amostra_curta');
  });

  it('20 textos já conclui: o piso é inclusivo', () => {
    assert.equal(vereditoDoNivelamento(20, antes, depois).classe, 'confirma');
  });

  it('21 textos conclui', () => {
    assert.equal(vereditoDoNivelamento(21, antes, depois).classe, 'confirma');
  });

  it('a fronteira é 19 -> 20 e não 20 -> 21', () => {
    const classes = [19, 20, 21].map(t => vereditoDoNivelamento(t, antes, depois).classe);
    assert.deepEqual(classes, ['amostra_curta', 'confirma', 'confirma']);
  });
});

describe('por que o piso de TEXTOS existe, além do de achados', () => {
  it('um texto só segurando trinta achados não conclui', () => {
    // O caso que motiva a segunda trava. O denominador está folgado (30 >= 20),
    // a aritmética é estável, e mesmo assim não há amostra: são trinta achados
    // de UM regulamento, lidos numa leitura. Com só o piso de achados isto
    // imprimiria CONFIRMA.
    const v = vereditoDoNivelamento(1, 30, 45);
    assert.equal(v.classe, 'amostra_curta');
  });

  it('e o percentual continua lá, calculado, para ser olhado', () => {
    // O piso não apaga o número: ele tira dele o direito de concluir.
    const v = vereditoDoNivelamento(1, 30, 45);
    assert.equal(v.ganhoPct, 50);
    assert.match(v.frase, /INCONCLUSIVO POR AMOSTRA/);
  });

  it('os mesmos trinta achados espalhados em vinte textos concluem', () => {
    // A única diferença entre este caso e o anterior é de quantos textos vieram
    // os achados. Se os dois dessem a mesma classe, o piso de textos não estaria
    // travando nada.
    const v = vereditoDoNivelamento(20, 30, 45);
    assert.equal(v.classe, 'confirma');
  });
});

describe('as duas travas são independentes', () => {
  it('achados de sobra não compram o piso de textos', () => {
    assert.equal(vereditoDoNivelamento(2, 500, 750).classe, 'amostra_curta');
  });

  it('textos de sobra não compram o piso de achados', () => {
    assert.equal(vereditoDoNivelamento(500, 2, 3).classe, 'amostra_curta');
  });

  it('o caso da issue, um texto com um achado que virou dois', () => {
    // 100% de ganho, e era isto que imprimia CONFIRMA.
    const v = vereditoDoNivelamento(1, 1, 2);
    assert.equal(v.ganhoPct, 100);
    assert.equal(v.classe, 'amostra_curta');
  });
});

describe('acima dos dois pisos, a barra volta a decidir', () => {
  const textos = 40;

  it('>= 30% confirma', () => {
    assert.equal(vereditoDoNivelamento(textos, 100, 130).classe, 'confirma');
  });

  it('< 10% é achado, não fracasso', () => {
    assert.equal(vereditoDoNivelamento(textos, 100, 105).classe, 'achado_nao_fracasso');
  });

  it('entre 10% e 30% é inconclusivo, e não é o inconclusivo de amostra', () => {
    const v = vereditoDoNivelamento(textos, 100, 120);
    assert.equal(v.classe, 'inconclusivo');
    assert.notEqual(v.classe, 'amostra_curta');
  });

  it('ganho zero acima do piso não vira amostra curta', () => {
    // Sem achado novo nenhum, a resposta é sobre o TAMANHO do efeito, e a
    // amostra não tem nada a ver com isso.
    assert.equal(vereditoDoNivelamento(textos, 100, 100).classe, 'achado_nao_fracasso');
  });
});

describe('a ordem é amostra primeiro, barra depois', () => {
  it('amostra curta ganha de um ganho que confirmaria', () => {
    // 200% de ganho, e ainda assim a resposta é sobre a amostra. Se a ordem se
    // invertesse, este caso viraria `confirma`.
    const v = vereditoDoNivelamento(1, 5, 15);
    assert.equal(v.classe, 'amostra_curta');
  });

  it('amostra zero é amostra curta, e não "sem base"', () => {
    // `antes = 0` falha o piso de achados antes de chegar ao ramo do null, e
    // essa ordem é a que faz a mensagem falar de amostra em vez de falar de
    // divisão por zero.
    const v = vereditoDoNivelamento(0, 0, 0);
    assert.equal(v.classe, 'amostra_curta');
    assert.equal(v.ganhoPct, null);
  });
});
