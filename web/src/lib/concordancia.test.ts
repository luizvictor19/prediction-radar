import { test } from 'node:test';
import assert from 'node:assert/strict';

import { anexarLeituras, chaveDaLinha, chavesDoAchado } from './concordancia.js';

/**
 * A junção entre o achado da view e as leituras que o apontaram — etapa 6.
 *
 * `digest_achados_por_mercado` entrega `vezes_encontrado`, um NÚMERO, e união de
 * leituras não se calcula com números: `min(soma, leituras_do_texto)` erra em
 * 5,3% das fusões e infla a concordância. Então a fusão precisa do CONJUNTO de
 * `digest_id`, e ele só existe nas tabelas-filhas.
 *
 * O `achado_id` da view é um md5 do Postgres cuja collation o projeto se recusa
 * a reproduzir em JS — é uma forma a mais de divergir. A junção é pela
 * identidade do achado: classe, tipo quando ele conta, e trecho normalizado. A
 * MESMA chave dos dois lados, construída por esta função nos dois lados.
 *
 * Os eixos de mutação que estes testes existem para travar:
 *
 * 1. **conjunto vazio em silêncio** — um achado que não casa recebe `[]` em vez
 *    de ser reportado. A concordância dele vira 0/n sem nada na tela dizendo que
 *    foi falha de junção, e concordância é o número mais sensível desta tela.
 * 2. **severidade dentro da chave da pegadinha** — duas leituras que discordam
 *    do peso da mesma passagem são UM achado na view. Com a severidade na chave,
 *    metade das leituras não casaria e a concordância cairia pela metade.
 * 3. **contradição sem ordenar as duas passagens** — `A||B` e `B||A` viram
 *    chaves diferentes e o achado não casa com as próprias leituras.
 */

const SHA = 'a'.repeat(64);

// ---------------------------------------------------------------------------
// EIXO 2 -- a severidade fica fora da chave da pegadinha
// ---------------------------------------------------------------------------

test('pegadinha: a severidade NÃO entra na chave', () => {
  // A view junta as duas leituras num achado só; a junção tem que juntar também.
  const forte = chaveDaLinha(SHA, 'pegadinha', 'muda_resultado', 'at 12:00 PM ET', null);
  const fraca = chaveDaLinha(SHA, 'pegadinha', 'detalhe', 'at 12:00 PM ET', null);

  assert.equal(forte, fraca);
});

test('ambiguidade: o tipo ENTRA na chave', () => {
  // `fuso_ausente` e `data_ambigua` sobre a mesma passagem são dois defeitos
  // dela, e a view os mantém separados.
  const fuso = chaveDaLinha(SHA, 'ambiguidade', 'fuso_ausente', '11:59 PM ET', null);
  const data = chaveDaLinha(SHA, 'ambiguidade', 'data_ambigua', '11:59 PM ET', null);

  assert.notEqual(fuso, data);
});

test('a chave ignora caixa e espaço repetido, como o achado_id da view', () => {
  assert.equal(
    chaveDaLinha(SHA, 'pegadinha', 'muda_resultado', 'At  12:00 PM ET', null),
    chaveDaLinha(SHA, 'pegadinha', 'muda_resultado', 'at 12:00 pm et', null),
  );
});

// ---------------------------------------------------------------------------
// EIXO 3 -- contradição: as duas passagens ordenadas
// ---------------------------------------------------------------------------

test('contradição: a ordem das duas passagens não muda a chave', () => {
  const ida = chaveDaLinha(SHA, 'contradicao', 'contradicao_interna', 'resolve em julho', 'resolve em agosto');
  const volta = chaveDaLinha(SHA, 'contradicao', 'contradicao_interna', 'resolve em agosto', 'resolve em julho');

  assert.equal(ida, volta);
});

test('contradição sem a segunda passagem não tem chave', () => {
  // Sem as duas passagens não há defeito de contradição para identificar.
  assert.equal(chaveDaLinha(SHA, 'contradicao', 'contradicao_interna', 'resolve em julho', null), null);
});

// ---------------------------------------------------------------------------
// Os dois lados produzem a MESMA chave
// ---------------------------------------------------------------------------

test('o achado da view e a linha-filha caem na mesma chave', () => {
  const daLinha = chaveDaLinha(SHA, 'pegadinha', 'muda_resultado', 'on December 31, 2026', null);
  const doAchado = chavesDoAchado(SHA, {
    classe: 'pegadinha',
    subtipos: ['detalhe', 'muda_resultado'],
    trecho: 'on December 31, 2026',
    trecho_conflito: null,
  });

  assert.deepEqual(doAchado, [daLinha]);
});

test('ambiguidade com dois subtipos gera uma chave por subtipo', () => {
  const chaves = chavesDoAchado(SHA, {
    classe: 'ambiguidade',
    subtipos: ['fuso_ausente', 'data_ambigua'],
    trecho: '11:59 PM ET',
    trecho_conflito: null,
  });

  assert.equal(chaves.length, 2);
  assert.ok(chaves.includes(chaveDaLinha(SHA, 'ambiguidade', 'fuso_ausente', '11:59 PM ET', null) as string));
  assert.ok(chaves.includes(chaveDaLinha(SHA, 'ambiguidade', 'data_ambigua', '11:59 PM ET', null) as string));
});

// ---------------------------------------------------------------------------
// EIXO 1 -- taxa de anexação, e o que não casa aparece
// ---------------------------------------------------------------------------

const PORCHAVE = new Map<string, Set<string>>([
  [chaveDaLinha(SHA, 'pegadinha', 'muda_resultado', 'at 12:00 PM ET', null) as string, new Set(['l1', 'l2'])],
  [chaveDaLinha(SHA, 'ambiguidade', 'fuso_ausente', '11:59 PM ET', null) as string, new Set(['l3'])],
]);

function achado(over: Partial<Parameters<typeof chavesDoAchado>[1]> & { achado_id: string }) {
  return {
    classe: 'pegadinha' as const,
    subtipos: ['muda_resultado'],
    trecho: 'at 12:00 PM ET',
    trecho_conflito: null,
    ...over,
  };
}

test('anexa o CONJUNTO de leituras, não a contagem', () => {
  const { comLeituras, semLeituras } = anexarLeituras(SHA, [achado({ achado_id: 'a' })], PORCHAVE);

  assert.equal(semLeituras.length, 0);
  assert.deepEqual([...comLeituras[0]!.leituras].sort(), ['l1', 'l2']);
});

test('achado que não casa é REPORTADO, nunca recebe conjunto vazio', () => {
  // Um conjunto vazio silencioso daria concordância 0 a um achado que a view
  // diz ter sido encontrado — e a tela mostraria `0/5` sem nada explicando.
  const orfao = achado({ achado_id: 'orfao', trecho: 'uma passagem que o índice não tem' });

  const { comLeituras, semLeituras } = anexarLeituras(SHA, [orfao], PORCHAVE);

  assert.equal(comLeituras.length, 0);
  assert.deepEqual(semLeituras.map(a => a.achado_id), ['orfao']);
});

test('a taxa de anexação soma: casados + não casados = entrada', () => {
  const entrada = [
    achado({ achado_id: 'a' }),
    achado({ achado_id: 'b', classe: 'ambiguidade', subtipos: ['fuso_ausente'], trecho: '11:59 PM ET' }),
    achado({ achado_id: 'orfao', trecho: 'ausente do índice' }),
  ];

  const { comLeituras, semLeituras } = anexarLeituras(SHA, entrada, PORCHAVE);

  assert.equal(comLeituras.length + semLeituras.length, entrada.length);
  assert.equal(comLeituras.length, 2);
});

test('subtipos múltiplos unem as leituras dos dois lados', () => {
  // A união é o ponto: a leitura que citou como `fuso_ausente` e a que citou
  // como `data_ambigua` acharam o mesmo defeito da passagem.
  const porChave = new Map([
    [chaveDaLinha(SHA, 'ambiguidade', 'fuso_ausente', '11:59 PM ET', null) as string, new Set(['l1'])],
    [chaveDaLinha(SHA, 'ambiguidade', 'data_ambigua', '11:59 PM ET', null) as string, new Set(['l2'])],
  ]);

  const { comLeituras } = anexarLeituras(
    SHA,
    [achado({ achado_id: 'x', classe: 'ambiguidade', subtipos: ['fuso_ausente', 'data_ambigua'], trecho: '11:59 PM ET' })],
    porChave,
  );

  assert.deepEqual([...comLeituras[0]!.leituras].sort(), ['l1', 'l2']);
});

test('a entrada não é modificada', () => {
  const entrada = [achado({ achado_id: 'a' })];
  const antes = JSON.stringify(entrada);

  anexarLeituras(SHA, entrada, PORCHAVE);

  assert.equal(JSON.stringify(entrada), antes);
});
