import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  SEM_STATUS,
  filtrarDigeriveis,
  montarElegiveis,
  resumoDoDescarte,
  type MercadoFiltravel,
} from './fila-digestao.js';

/** Nada aqui toca banco: o filtro recebe a lista pronta, por desenho. */
function mercado(eventId: string, status: string | null): MercadoFiltravel {
  return { eventId, status };
}

/**
 * Um mercado de cada valor que `events.status` já viu, mais os dois que ela não
 * promete não ver: `null` e um valor fora do vocabulário. A ordem é a da lista,
 * e as asserções abaixo comparam a SEQUÊNCIA inteira e não o tamanho: uma
 * asserção de tamanho passaria com o mercado errado sobrevivendo.
 */
const ROSTER: MercadoFiltravel[] = [
  mercado('a-active', 'active'),
  mercado('b-resolved', 'resolved'),
  mercado('c-closed-manual', 'closed_manual'),
  mercado('d-inactive', 'inactive'),
  mercado('e-nulo', null),
  mercado('f-desconhecido', 'quarantined'),
];

describe('filtrarDigeriveis', () => {
  it('tira da fila resolved e inactive, e SÓ eles', () => {
    const { digeriveis } = filtrarDigeriveis(ROSTER);
    assert.deepEqual(
      digeriveis.map(m => m.eventId),
      ['a-active', 'c-closed-manual', 'e-nulo', 'f-desconhecido'],
    );
  });

  it('mantém closed_manual: o dono fechou a posição, o mercado segue aberto', () => {
    const { digeriveis } = filtrarDigeriveis([mercado('x', 'closed_manual')]);
    assert.deepEqual(digeriveis.map(m => m.eventId), ['x']);
  });

  it('mantém status nulo e status desconhecido, porque o filtro REMOVE trabalho', () => {
    // A coluna é text sem NOT NULL e sem CHECK: um `status === active` mandaria
    // os dois para o lado descartado sem ninguém ver.
    const { digeriveis } = filtrarDigeriveis([mercado('n', null), mercado('q', 'quarantined')]);
    assert.deepEqual(digeriveis.map(m => m.eventId), ['n', 'q']);
  });

  it('conta o descarte por status', () => {
    const { descartados } = filtrarDigeriveis(ROSTER);
    assert.deepEqual([...descartados].sort(), [
      ['inactive', 1],
      ['resolved', 1],
    ]);
  });

  it('não descarta nada quando o roster inteiro está aberto', () => {
    const abertos = [mercado('a', 'active'), mercado('b', 'active')];
    const { digeriveis, descartados } = filtrarDigeriveis(abertos);
    assert.deepEqual(digeriveis.map(m => m.eventId), ['a', 'b']);
    assert.equal(descartados.size, 0);
  });

  it('preserva a ordem de entrada', () => {
    const invertido = [...ROSTER].reverse();
    const { digeriveis } = filtrarDigeriveis(invertido);
    assert.deepEqual(
      digeriveis.map(m => m.eventId),
      ['f-desconhecido', 'e-nulo', 'c-closed-manual', 'a-active'],
    );
  });
});

describe('montarElegiveis', () => {
  it('aplica os dois filtros: excluído por artefato E com desfecho', () => {
    const { digeriveis } = montarElegiveis(ROSTER, new Set(['a-active']));
    assert.deepEqual(
      digeriveis.map(m => m.eventId),
      ['c-closed-manual', 'e-nulo', 'f-desconhecido'],
    );
  });

  it('o excluído por artefato não entra na contagem de descarte por desfecho', () => {
    // Os dois motivos de saída são contados em lugares diferentes de propósito:
    // juntar "excluído da régua do prompt" com "já tem desfecho" produziria um
    // número que não responde nem uma pergunta nem a outra.
    const { descartados } = montarElegiveis(ROSTER, new Set(['b-resolved']));
    assert.deepEqual([...descartados], [['inactive', 1]]);
  });

  it('conjunto de exclusão vazio devolve o mesmo que filtrarDigeriveis', () => {
    const comMontar = montarElegiveis(ROSTER, new Set());
    const comFiltrar = filtrarDigeriveis(ROSTER);
    assert.deepEqual(
      comMontar.digeriveis.map(m => m.eventId),
      comFiltrar.digeriveis.map(m => m.eventId),
    );
  });
});

describe('resumoDoDescarte', () => {
  it('devolve vazio quando nada saiu', () => {
    assert.equal(resumoDoDescarte(new Map()), '');
  });

  it('soma o total e detalha por status, do maior para o menor', () => {
    const linha = resumoDoDescarte(new Map([['inactive', 2], ['resolved', 7]]));
    assert.equal(linha, '9 mercados fora da fila por já terem desfecho (resolved: 7, inactive: 2)');
  });

  it('o balde de status ausente tem rótulo próprio', () => {
    assert.equal(SEM_STATUS, '(nulo/ausente)');
  });
});
