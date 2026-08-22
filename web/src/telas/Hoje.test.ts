import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ORDENS } from './Hoje.js';
import type { MercadoNaLista } from '../lib/tipos.js';

/**
 * O invariante da lista: **ordenar por FATO, nunca por nota.**
 *
 * Não testa renderização. Trava a constante, que é onde a regra quebra: alguém
 * acrescenta "mais promissores" ao seletor e a tela passa a sugerir. No instante
 * em que ela sugere, o dono deixa de ser o previsor e a medição passa a medir o
 * sistema com ele no meio.
 *
 * O teste não recita a lista de opções — isso seria tautologia, e passaria
 * mesmo se o extrator lesse outra coluna. Ele exige que cada opção **declare**
 * o fato que ordena e verifica que o extrator lê ESSE fato num mercado de
 * fixture. Opção nova sem fato declarado, ou com extrator que lê coisa
 * diferente do que declara, falha aqui.
 */

/**
 * As colunas que são FATO sobre o mercado — medidas, não julgadas.
 *
 * `prob_self` fica de fora de propósito: é a probabilidade que o DONO declarou.
 * Ordenar a lista por ela faria a tela devolver ao previsor a opinião dele
 * próprio como se fosse ordenação neutra, que é a mesma armadilha por outro
 * caminho.
 */
const FATOS = new Set([
  'dias_restantes',
  'var_24h',
  'var_7d',
  'liquidez',
  'spread',
  'mid_price',
  'contradicoes',
  'achados_total',
]);

function mercado(campos: Partial<MercadoNaLista> = {}): MercadoNaLista {
  return {
    id: 'e1',
    slug: 'slug-e1',
    pergunta: 'pergunta',
    categoria: null,
    tema: null,
    assunto: null,
    outcome: 'Yes',
    best_bid: null,
    best_ask: null,
    mid_price: 0.42,
    spread: 0.03,
    preco_em: null,
    preco_idade_min: null,
    var_24h: -0.11,
    var_24h_base: 'mid',
    var_7d: 0.2,
    var_7d_base: 'mid',
    liquidez: 12345,
    fecha_em: null,
    dias_restantes: 7.5,
    tamanho_regra: null,
    prob_self: 0.9,
    prob_self_em: null,
    prob_self_estrategia: null,
    digests: [],
    ...campos,
  };
}

test('toda opção de ordenação declara o fato que ordena', () => {
  for (const o of ORDENS) {
    assert.ok(
      'fato' in o && typeof (o as { fato?: unknown }).fato === 'string',
      `a opção "${o.chave}" não declara fato`,
    );
    assert.ok(FATOS.has((o as unknown as { fato: string }).fato), `"${o.chave}" ordena por algo que não é fato`);
  }
});

test('o extrator de cada opção lê o fato que ela declara', () => {
  // O que impede a declaração de virar etiqueta decorativa: o valor tem que sair
  // da coluna declarada, e não de outra.
  const m = mercado({ digests: [] });

  for (const o of ORDENS) {
    const { fato, valor } = o as unknown as {
      fato: string;
      valor: (x: MercadoNaLista) => number | null;
    };
    assert.equal(typeof valor, 'function', `a opção "${o.chave}" não tem extrator`);

    const bruto = (m as unknown as Record<string, number | null | undefined>)[fato];
    if (bruto !== undefined) {
      const lido = valor(m);
      // A ordenação pode usar o módulo (variação de -0,11 e +0,11 são o mesmo
      // tamanho de movimento), mas nunca outra coluna.
      assert.ok(
        lido === bruto || (bruto !== null && lido === Math.abs(bruto)),
        `"${o.chave}" declara ${fato}=${bruto} mas o extrator devolveu ${lido}`,
      );
    }
  }
});

test('nenhuma opção ordena por prob_self', () => {
  // A nota do dono não é ordenação neutra.
  for (const o of ORDENS) {
    assert.notEqual((o as unknown as { fato?: string }).fato, 'prob_self');
  }
});

test('mercado sem digestão vale null e não 0 nas ordens de digestão', () => {
  // Nulo vai para o fim em qualquer direção. Tratar "não lido" como zero achado
  // colocaria os 320 não digeridos empatados com os lidos que nada acharam.
  const semDigest = mercado({ digests: [] });

  for (const o of ORDENS) {
    const { fato, valor } = o as unknown as {
      fato: string;
      valor: (x: MercadoNaLista) => number | null;
    };
    if (fato === 'contradicoes' || fato === 'achados_total') {
      assert.equal(valor(semDigest), null, `"${o.chave}" devolveu 0 para mercado sem digestão`);
    }
  }
});
