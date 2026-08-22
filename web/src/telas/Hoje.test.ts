import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ORDENS } from '../lib/ordens.js';
import type { ContagemDigest, MercadoNaLista } from '../lib/tipos.js';

/**
 * O invariante da lista: **ordenar por FATO, nunca por nota.**
 *
 * Não testa renderização. Trava a constante, que é onde a regra quebra: alguém
 * acrescenta "mais promissores" ao seletor e a tela passa a sugerir. No instante
 * em que ela sugere, o dono deixa de ser o previsor e a medição passa a medir o
 * sistema com ele no meio.
 *
 * O teste não recita a lista de opções — isso seria tautologia, e passaria mesmo
 * se o extrator lesse outra coluna. Ele exige que cada opção **declare** o fato
 * que ordena e confere o extrator contra um valor esperado que o teste conhece
 * pelo FIXTURE, não por chamar o código de produção.
 */

/**
 * As colunas que são FATO sobre o mercado — medidas, não julgadas.
 *
 * `prob_self` fica de fora de propósito: é a probabilidade que o DONO declarou.
 * Ordenar a lista por ela devolveria ao previsor a opinião dele próprio como se
 * fosse ordenação neutra, que é a mesma armadilha por outro caminho.
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

function contagem(sha: string, campos: Partial<ContagemDigest> = {}): ContagemDigest {
  return {
    event_id: 'e1',
    description_sha256: sha,
    leituras_do_texto: 3,
    mercados_do_texto: 1,
    achados_total: 0,
    achados_acusados: 0,
    achados_herdados: 0,
    pegadinhas: 0,
    ambiguidades: 0,
    contradicoes: 0,
    pegadinhas_muda_resultado: 0,
    confirmacao_maxima: 0,
    ...campos,
  };
}

/**
 * O mercado de prova.
 *
 * Duas escolhas de propósito, e as duas existem para o teste MORDER:
 *
 *   - As variações são NEGATIVAS. Com fixture positivo, um extrator que
 *     esquecesse `Math.abs` passaria — o valor bruto e o módulo seriam iguais.
 *   - `digests` tem DOIS textos com contagens diferentes. As ordens de digestão
 *     somam sobre os textos, e com um texto só a soma seria indistinguível de
 *     "pega o primeiro".
 */
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
    var_7d: -0.2,
    var_7d_base: 'mid',
    liquidez: 12345,
    fecha_em: null,
    dias_restantes: 7.5,
    tamanho_regra: null,
    prob_self: 0.9,
    prob_self_em: null,
    prob_self_estrategia: null,
    digests: [
      contagem('sha-a', { contradicoes: 2, achados_total: 5 }),
      contagem('sha-b', { contradicoes: 1, achados_total: 3 }),
    ],
    ...campos,
  };
}

/**
 * O que um extrator correto DEVE devolver para o mercado de prova, por fato.
 *
 * Calculado à mão a partir do fixture, e não chamando o código de produção —
 * asserção que recomputa o valor do mesmo jeito que o código passa por
 * construção e nunca discorda dele.
 *
 * Fato novo sem entrada aqui faz o primeiro teste falhar. Isso é de propósito:
 * acrescentar uma ordem obriga a declarar, à mão, qual número ela produz.
 */
const ESPERADO: Record<string, number | null> = {
  dias_restantes: 7.5,
  // Módulo: cair 11 pontos é o mesmo tamanho de movimento que subir 11.
  var_24h: 0.11,
  var_7d: 0.2,
  liquidez: 12345,
  spread: 0.03,
  mid_price: 0.42,
  // Soma sobre os DOIS textos: 2 + 1 e 5 + 3.
  contradicoes: 3,
  achados_total: 8,
};

interface Opcao {
  chave: string;
  fato: string;
  dir: 'asc' | 'desc';
  valor: (m: MercadoNaLista) => number | null;
}

const opcoes = ORDENS as unknown as Opcao[];

test('toda opção de ordenação declara o fato que ordena', () => {
  for (const o of opcoes) {
    assert.equal(typeof o.fato, 'string', `a opção "${o.chave}" não declara fato`);
    assert.ok(FATOS.has(o.fato), `"${o.chave}" ordena por algo que não é fato`);
    assert.ok(
      o.fato in ESPERADO,
      `"${o.chave}" ordena por ${o.fato}, que não tem valor esperado no fixture`,
    );
  }
});

test('o extrator de cada opção devolve exatamente o fato que ela declara', () => {
  // O que impede a declaração de virar etiqueta decorativa. Igualdade EXATA:
  // sem escape de módulo, porque o fixture já é negativo e o esperado já é o
  // módulo — um extrator sem `Math.abs` devolve o negativo e falha aqui.
  const m = mercado();

  for (const o of opcoes) {
    assert.equal(typeof o.valor, 'function', `a opção "${o.chave}" não tem extrator`);
    assert.equal(
      o.valor(m),
      ESPERADO[o.fato],
      `"${o.chave}" declara ${o.fato}, que vale ${ESPERADO[o.fato]} neste mercado`,
    );
  }
});

test('nenhuma opção ordena por prob_self', () => {
  // A nota do dono não é ordenação neutra.
  for (const o of opcoes) {
    assert.notEqual(o.fato, 'prob_self');
  }
});

test('cada fato é lido por no máximo uma opção', () => {
  // Duas opções sobre o mesmo fato são a mesma ordem com dois nomes — e o mais
  // provável é que uma delas tenha sido copiada e o `fato` não tenha sido
  // ajustado junto, que é exatamente o defeito que este arquivo caça.
  const fatos = opcoes.map(o => o.fato);
  assert.equal(new Set(fatos).size, fatos.length, `fato repetido em ${JSON.stringify(fatos)}`);
});

test('mercado sem digestão vale null e não 0 nas ordens de digestão', () => {
  // Nulo vai para o fim em qualquer direção. Tratar "não lido" como zero achado
  // colocaria os 320 não digeridos empatados com os lidos que nada acharam.
  const semDigest = mercado({ digests: [] });

  for (const o of opcoes) {
    if (o.fato === 'contradicoes' || o.fato === 'achados_total') {
      assert.equal(
        o.valor(semDigest),
        null,
        `"${o.chave}" devolveu ${o.valor(semDigest)} para mercado sem digestão`,
      );
    }
  }
});
