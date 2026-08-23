import { test } from 'node:test';
import assert from 'node:assert/strict';

import { contemTrecho, fundirPorAbsorcao, type AchadoFundivel } from './dedup.js';

/**
 * A dedup por absorção — seção 4 da spec.
 *
 * Os três eixos de mutação que estes testes existem para travar:
 *
 * 1. **igualdade exata em vez de continência** — derruba `funde trechos que se
 *    contêm` e o fixture real.
 * 2. **máximo em vez de união** — derruba `a contagem de leituras é a união`.
 * 3. **componentes conexos em vez de absorção** — derruba
 *    `dois containers do mesmo trecho continuam dois achados`, que é o fixture
 *    real e o único que pega alguém trocando isto por union-find.
 */

// ---------------------------------------------------------------------------
// O fixture real
// ---------------------------------------------------------------------------

/**
 * Mercado `will-hassan-khomeini-be-head-of-state-in-iran-end-of-2026`, texto de
 * regra lido 30 vezes. Medido em 22/08/2026 por `npm run medir:tela-regra`.
 *
 * Os três trechos são LITERAIS do banco. As leituras são sintéticas — os
 * `digest_id` reais são uuids —, mas as CARDINALIDADES e a disjunção são as
 * medidas: A em 11 das 30 leituras, C em 2, B em 1, e a leitura de B não está
 * entre as 11 de A. É por isso que a união dá 12 e o máximo daria 11.
 *
 * A forma é a que a spec exige do teste:
 *
 *   A = "on December 31, 2026 at 12:00 PM ET"
 *   B = "at 12:00 PM ET"
 *   C = "December 31, 2026 at 12:00 PM ET."
 *
 * `A ⊃ B` e `C ⊃ B`, e `A ⊅ C` — A não tem o ponto final e C não tem o "on".
 * Nenhum dos dois containers contém o outro, e é aí que union-find erra.
 *
 * Ela não é rara: a busca sobre o corpus inteiro achou 2.035 ocorrências desta
 * forma em 217 mercados.
 */
/** O `achado_id` não é lido pela fusão; anda junto para os testes poderem citá-lo. */
type Item = AchadoFundivel & { achado_id: string };

const A: Item = {
  achado_id: 'a',
  classe: 'pegadinha',
  origem: 'acusado',
  subtipos: ['muda_resultado', 'muda_timing'],
  trecho: 'on December 31, 2026 at 12:00 PM ET',
  descricao:
    'O título diz "end of 2026", mas a regra resolve com base em um instante exato: 12:00 PM ET de 31/12/2026, não no final do dia.',
  cenario:
    'Se Hassan Khomeini assumir o poder efetivo às 14h ET de 31/12/2026, quem lê o título espera SIM, mas a regra resolve NÃO.',
  leitura_a: null,
  leitura_b: null,
  leituras: ['l01', 'l02', 'l03', 'l04', 'l05', 'l06', 'l07', 'l08', 'l09', 'l10', 'l11'],
};

const B: Item = {
  achado_id: 'b',
  classe: 'pegadinha',
  origem: 'herdado',
  subtipos: ['muda_resultado'],
  trecho: 'at 12:00 PM ET',
  descricao: null,
  cenario: null,
  leitura_a: null,
  leitura_b: null,
  leituras: ['l12'],
};

const C: Item = {
  achado_id: 'c',
  classe: 'pegadinha',
  origem: 'herdado',
  subtipos: ['muda_resultado', 'muda_timing'],
  trecho: 'December 31, 2026 at 12:00 PM ET.',
  descricao: null,
  cenario: null,
  leitura_a: null,
  leitura_b: null,
  leituras: ['l02', 'l13'],
};

function achado(over: Partial<Item> & { trecho: string }): Item {
  return {
    achado_id: over.trecho,
    classe: 'ambiguidade',
    origem: 'acusado',
    subtipos: ['fuso_ausente'],
    descricao: null,
    cenario: null,
    leitura_a: null,
    leitura_b: null,
    leituras: ['l1'],
    ...over,
  };
}

// ---------------------------------------------------------------------------
// EIXO 3 — absorção, e não componentes conexos
// ---------------------------------------------------------------------------

test('dois containers do mesmo trecho continuam dois achados', () => {
  const saida = fundirPorAbsorcao([A, B, C]);

  // Union-find responderia UM: A–B e C–B são arestas, e o fecho transitivo
  // junta os três num componente cujo sobrevivente (A) não contém o C.
  assert.equal(saida.length, 2);
  assert.deepEqual(
    saida.map(x => x.trecho),
    ['on December 31, 2026 at 12:00 PM ET', 'December 31, 2026 at 12:00 PM ET.'],
  );
});

test('o sobrevivente contém literalmente todo trecho que absorveu', () => {
  // O invariante que dá o direito de esconder os absorvidos. Se ele não vale,
  // a tela escondeu uma citação que o item visível não sustenta.
  for (const entrada of [
    [A, B, C],
    [A, B],
    [C, B],
  ]) {
    const saida = fundirPorAbsorcao(entrada);
    const absorvidos = entrada.filter(x => !saida.some(s => s.achado_id === x.achado_id));
    for (const sumiu of absorvidos) {
      const dono = saida.find(s => contemTrecho(s.trecho ?? '', sumiu.trecho ?? ''));
      assert.ok(dono !== undefined, `nada no resultado contém ${JSON.stringify(sumiu.trecho)}`);
    }
  }
});

test('C sobrevive intacto: não herda leitura nem subtipo de quem não o contém', () => {
  const c = fundirPorAbsorcao([A, B, C]).find(x => x.trecho === C.trecho);

  assert.deepEqual(c?.leituras, ['l02', 'l13']);
  assert.equal(c?.origem, 'herdado');
});

// ---------------------------------------------------------------------------
// EIXO 2 — união, e não máximo
// ---------------------------------------------------------------------------

test('a contagem de leituras do fundido é a UNIÃO, não o máximo', () => {
  const fundido = fundirPorAbsorcao([A, B]).at(0);

  // A em 11 leituras, B numa 12ª que não é nenhuma das 11. Máximo daria 11.
  assert.equal(fundido?.leituras.length, 12);
  assert.ok(fundido?.leituras.includes('l12'));
});

test('leitura que apontou os dois trechos conta UMA vez', () => {
  // `l02` está em A e em C. Soma daria 13 e inflaria a concordância — que é
  // exatamente a mudança de contagem que a seção 11 proíbe.
  const fundido = fundirPorAbsorcao([A, C, B]).find(x => x.trecho === A.trecho);

  assert.equal(fundido?.leituras.length, 12);
  assert.equal(new Set(fundido?.leituras).size, 12);
});

// ---------------------------------------------------------------------------
// EIXO 1 — continência, e não igualdade exata
// ---------------------------------------------------------------------------

test('funde trechos que se contêm sem serem iguais', () => {
  const saida = fundirPorAbsorcao([A, B]);

  assert.equal(saida.length, 1);
  assert.equal(saida[0]?.trecho, A.trecho);
});

test('continência ignora caixa e espaço repetido, como o achado_id da view', () => {
  const longo = achado({ trecho: 'By  DECEMBER 31, 2026, 11:59 PM ET the market resolves' });
  const curto = achado({ trecho: 'december 31, 2026, 11:59 pm et' });

  assert.equal(fundirPorAbsorcao([longo, curto]).length, 1);
});

// ---------------------------------------------------------------------------
// Sobreposição não é continência
// ---------------------------------------------------------------------------

test('A B C e B C D se sobrepõem e NÃO fundem', () => {
  // O caso que a spec original mandava fundir. Nenhum dos dois pode representar
  // o outro, então esconder qualquer um deles esconde citação.
  const abc = achado({ trecho: 'the margin of victory between the top two' });
  const bcd = achado({ trecho: 'victory between the top two candidates in the first round' });

  const saida = fundirPorAbsorcao([abc, bcd]);

  assert.equal(saida.length, 2);
});

test('continência é alinhada a borda de palavra', () => {
  // "et" está dentro de "market", e um `indexOf` cru fundiria os dois.
  const frase = achado({ trecho: 'the market will resolve to Other' });
  const fragmento = achado({ trecho: 'et' });

  assert.equal(fundirPorAbsorcao([frase, fragmento]).length, 2);
});

// ---------------------------------------------------------------------------
// O que separa um grupo do outro
// ---------------------------------------------------------------------------

test('tipos diferentes de ambiguidade não fundem, mesmo com um trecho dentro do outro', () => {
  const fuso = achado({ trecho: 'by December 31, 2026, 11:59 PM ET', subtipos: ['fuso_ausente'] });
  const data = achado({ trecho: 'December 31, 2026', subtipos: ['data_ambigua'] });

  assert.equal(fundirPorAbsorcao([fuso, data]).length, 2);
});

test('classes diferentes não fundem', () => {
  const peg = achado({ trecho: 'resolves at 12:00 PM ET sharp', classe: 'pegadinha', subtipos: ['muda_resultado'] });
  const amb = achado({ trecho: '12:00 PM ET', classe: 'ambiguidade', subtipos: ['fuso_ausente'] });

  assert.equal(fundirPorAbsorcao([peg, amb]).length, 2);
});

test('severidade fica FORA da chave: pegadinhas do mesmo trecho fundem e unem os subtipos', () => {
  // Discordância de severidade sobre a mesma passagem é divergência de leitura,
  // não defeito diferente. Mostrar duas vezes seria mostrar a discordância como
  // se fossem dois achados.
  const forte = achado({
    trecho: 'on December 31, 2026 at 12:00 PM ET',
    classe: 'pegadinha',
    subtipos: ['muda_resultado'],
  });
  const fraca = achado({ trecho: 'at 12:00 PM ET', classe: 'pegadinha', subtipos: ['detalhe'] });

  const saida = fundirPorAbsorcao([forte, fraca]);

  assert.equal(saida.length, 1);
  assert.deepEqual(saida[0]?.subtipos, ['detalhe', 'muda_resultado']);
});

// ---------------------------------------------------------------------------
// Origem e prosa
// ---------------------------------------------------------------------------

test('o fundido é acusado se QUALQUER um dos fundidos for acusado', () => {
  const fundido = fundirPorAbsorcao([{ ...A, origem: 'herdado' }, { ...B, origem: 'acusado' }]).at(0);

  assert.equal(fundido?.origem, 'acusado');
});

test('a prosa vem do de maior concordância ENTRE OS QUE TÊM prosa', () => {
  // Aresta medida em 9,6% das fusões: o de maior concordância é herdado e não
  // tem prosa nenhuma. "Fica a do maior" jogaria fora a única que existe, e
  // deixaria um item marcado `acusado` sem descrição.
  const herdadoForte = { ...A, origem: 'herdado' as const, descricao: null, cenario: null };
  const acusadoFraco = {
    ...B,
    origem: 'acusado' as const,
    descricao: 'a descrição que existe',
    cenario: 'o cenário que existe',
  };

  const fundido = fundirPorAbsorcao([herdadoForte, acusadoFraco]).at(0);

  assert.equal(fundido?.descricao, 'a descrição que existe');
  assert.equal(fundido?.cenario, 'o cenário que existe');
});

test('entre duas prosas, vence a de maior concordância', () => {
  const fraca = { ...B, descricao: 'a fraca', cenario: 'cenário fraco', origem: 'acusado' as const };
  const forte = { ...A, descricao: 'a forte', cenario: 'cenário forte' };

  assert.equal(fundirPorAbsorcao([fraca, forte]).at(0)?.descricao, 'a forte');
});

test('na ambiguidade a prosa são as leituras, e elas viajam junto', () => {
  // `descricao` e `cenario` são nulos em ambiguidade por construção da view: a
  // prosa dela é `leitura_a`/`leitura_b`. Uma regra que só olhasse os dois
  // primeiros campos perderia a prosa em toda fusão de ambiguidade.
  const longo = achado({
    trecho: 'by December 31, 2026, 11:59 PM ET',
    origem: 'herdado',
    leituras: ['l1', 'l2', 'l3'],
  });
  const curto = achado({
    trecho: '11:59 PM ET',
    origem: 'acusado',
    leitura_a: 'ET pode ser EST ou EDT',
    leitura_b: 'ET é sempre o fuso de Nova York no dia',
    leituras: ['l4'],
  });

  const fundido = fundirPorAbsorcao([longo, curto]).at(0);

  assert.equal(fundido?.trecho, longo.trecho);
  assert.equal(fundido?.leitura_a, 'ET pode ser EST ou EDT');
  assert.equal(fundido?.leitura_b, 'ET é sempre o fuso de Nova York no dia');
});

test('a prosa vem toda de UM achado, nunca montada de dois', () => {
  // Descrição de uma leitura com cenário de outra é um par que ninguém
  // escreveu, e a tela o mostraria como se fosse.
  const longo = achado({
    trecho: 'resolves on December 31, 2026 at 12:00 PM ET sharp',
    classe: 'pegadinha',
    subtipos: ['muda_resultado'],
    descricao: 'a descrição do longo',
    cenario: null,
    leituras: ['l1', 'l2', 'l3'],
  });
  const curto = achado({
    trecho: 'at 12:00 PM ET',
    classe: 'pegadinha',
    subtipos: ['muda_resultado'],
    descricao: 'a descrição do curto',
    cenario: 'o cenário do curto',
    leituras: ['l4'],
  });

  const fundido = fundirPorAbsorcao([longo, curto]).at(0);

  // O longo vence por concordância (3 contra 1), então leva o `cenario` NULO
  // dele — e não o do curto.
  assert.equal(fundido?.descricao, 'a descrição do longo');
  assert.equal(fundido?.cenario, null);
});

// ---------------------------------------------------------------------------
// Determinismo
// ---------------------------------------------------------------------------

test('a ordem da entrada não muda a saída', () => {
  const entrada = [A, B, C];
  const esperado = JSON.stringify(fundirPorAbsorcao(entrada));

  for (const ordem of [
    [C, B, A],
    [B, A, C],
    [B, C, A],
    [C, A, B],
    [A, C, B],
  ]) {
    assert.equal(JSON.stringify(fundirPorAbsorcao(ordem)), esperado);
  }
});

test('empate de comprimento resolve pelo trecho normalizado, não pela chegada', () => {
  // Dois containers do mesmo tamanho, ambos contendo o mesmo curto. O desempate
  // tem que ser uma propriedade do texto — a ordem do banco não é estável.
  const zzz = achado({ trecho: 'zzz the deadline is 11:59 PM ET yes', leituras: ['l1'] });
  const aaa = achado({ trecho: 'aaa the deadline is 11:59 PM ET yes', leituras: ['l2'] });
  const curto = achado({ trecho: '11:59 PM ET', leituras: ['l3'] });

  const um = fundirPorAbsorcao([zzz, aaa, curto]);
  const outro = fundirPorAbsorcao([curto, aaa, zzz]);

  assert.deepEqual(um.map(x => x.trecho), outro.map(x => x.trecho));
  assert.equal(um.length, 2);
  // O curto foi para o `aaa`, que ganha o desempate lexicográfico — e é ele,
  // não o `zzz`, que fica com a leitura absorvida.
  assert.equal(um.find(x => x.leituras.length === 2)?.trecho, aaa.trecho);
  assert.deepEqual(um.find(x => x.trecho === zzz.trecho)?.leituras, ['l1']);
});

// ---------------------------------------------------------------------------
// Bordas
// ---------------------------------------------------------------------------

test('lista vazia devolve lista vazia', () => {
  assert.deepEqual(fundirPorAbsorcao([]), []);
});

test('achado sem trecho não é fundido nem some', () => {
  // Não existe hoje na view, que exclui achado sem âncora. Se voltar a existir,
  // sumir em silêncio é o pior desfecho possível.
  const semTrecho = achado({ trecho: 'x', achado_id: 'sem' });
  const nulo = { ...semTrecho, trecho: null };
  const outro = achado({ trecho: 'the deadline is 11:59 PM ET' });

  const saida = fundirPorAbsorcao([nulo, outro]);

  assert.equal(saida.length, 2);
  assert.ok(saida.some(x => x.trecho === null));
});

test('a entrada não é modificada', () => {
  const antes = JSON.stringify([A, B, C]);
  fundirPorAbsorcao([A, B, C]);

  assert.equal(JSON.stringify([A, B, C]), antes);
});
