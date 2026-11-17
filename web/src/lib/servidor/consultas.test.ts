import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SupabaseClient } from '@supabase/supabase-js';

import {
  gravarLeg,
  gravarPrevisao,
  lerAchados,
  lerContagens,
  lerContradicoes,
  lerCorpus,
  lerLeituras,
  lerRadar,
  lerTextoDaRegra,
  lerTextoGuardado,
} from './consultas';
import { COLUNAS_CONTAGEM } from '../paginacao';

/**
 * Every query the route handlers can run, against a fake client that records
 * each call. The point is the whole list: a function that starts reading a
 * second table, or another column, or that writes, changes the list and fails
 * here. The pagination itself is measured against a real Postgres in
 * `dados.db.test.ts`.
 */

type Passo = [string, ...unknown[]];
type Chamada = { tabela: string; passos: Passo[] };
type Resposta = { data: unknown; error: { message: string; code?: string } | null };

function clienteFalso(responder: (c: Chamada) => Resposta = () => ({ data: [], error: null })) {
  const chamadas: Chamada[] = [];
  const cliente = {
    from(tabela: string) {
      const chamada: Chamada = { tabela, passos: [] };
      chamadas.push(chamada);
      const consulta: object = new Proxy(
        {},
        {
          get(_alvo, nome) {
            if (nome === 'then') {
              return (ok: (r: Resposta) => unknown, falha: (e: unknown) => unknown) =>
                Promise.resolve(responder(chamada)).then(ok, falha);
            }
            return (...args: unknown[]) => {
              chamada.passos.push([String(nome), ...args]);
              return consulta;
            };
          },
        },
      );
      return consulta;
    },
  };
  return { db: cliente as unknown as SupabaseClient, chamadas };
}

const EVENTO = '0b0e6a3e-3f1f-4a54-9a51-7d1c2e6f8a10';
const SHA = 'a'.repeat(64);

test('lerRadar lê só v_radar, paginando em 500 por id', async () => {
  const { db, chamadas } = clienteFalso();
  await lerRadar(db);
  assert.equal(chamadas.length, 1);
  const [c] = chamadas;
  assert.equal(c!.tabela, 'v_radar');
  assert.deepEqual(
    c!.passos.map((p) => p[0]),
    ['select', 'order', 'range'],
  );
  assert.deepEqual(c!.passos[1], ['order', 'id']);
  assert.deepEqual(c!.passos[2], ['range', 0, 499]);
  const colunas = String(c!.passos[0]![1]).split(', ');
  assert.ok(colunas.includes('prob_self'), 'v_radar perdeu prob_self');
  assert.ok(!colunas.includes('description'), 'v_radar não tem description');
});

test('lerContagens lê digest_achados_por_mercado em ordem total', async () => {
  const { db, chamadas } = clienteFalso();
  await lerContagens(db);
  assert.deepEqual(chamadas, [
    {
      tabela: 'digest_achados_por_mercado',
      passos: [
        ['select', COLUNAS_CONTAGEM],
        ['order', 'event_id'],
        ['order', 'description_sha256'],
        ['range', 0, 499],
      ],
    },
  ]);
});

test('a paginação pede a página seguinte enquanto a anterior vem cheia', async () => {
  let pagina = 0;
  const { db, chamadas } = clienteFalso(() => ({
    data: Array.from({ length: pagina++ === 0 ? 500 : 3 }, (_, i) => ({ id: i })),
    error: null,
  }));
  const linhas = await lerRadar(db);
  assert.equal(linhas.length, 503);
  assert.deepEqual(
    chamadas.map((c) => c.passos.at(-1)),
    [
      ['range', 0, 499],
      ['range', 500, 999],
    ],
  );
});

test('lerAchados, lerLeituras, lerTextoDaRegra e lerTextoGuardado filtram pela chave', async () => {
  const { db, chamadas } = clienteFalso((c) =>
    c.tabela === 'events'
      ? { data: { description: 'texto' }, error: null }
      : c.tabela === 'market_rule_texts'
        ? { data: { description: 'guardado' }, error: null }
        : { data: [], error: null },
  );
  await lerAchados(db, EVENTO);
  await lerLeituras(db, EVENTO, SHA);
  assert.deepEqual(await lerTextoDaRegra(db, EVENTO), { encontrado: true, texto: 'texto' });
  assert.deepEqual(await lerTextoGuardado(db, SHA), { fase: 'guardado', texto: 'guardado' });

  assert.deepEqual(
    chamadas.map((c) => [c.tabela, ...c.passos.filter((p) => p[0] !== 'select')]),
    [
      ['digest_achados_por_mercado', ['eq', 'event_id', EVENTO]],
      [
        'market_rule_digests',
        ['eq', 'event_id', EVENTO],
        ['eq', 'description_sha256', SHA],
        ['order', 'leitura_n'],
      ],
      ['events', ['eq', 'id', EVENTO], ['maybeSingle']],
      ['market_rule_texts', ['eq', 'description_sha256', SHA], ['maybeSingle']],
    ],
  );
  assert.deepEqual(
    chamadas.slice(2).map((c) => c.passos[0]),
    [
      ['select', 'description'],
      ['select', 'description'],
    ],
    'de events e de market_rule_texts só sai description',
  );
});

test('lerTextoGuardado: tabela ausente é resposta, falha de rede é erro', async () => {
  const ausente = clienteFalso(() => ({
    data: null,
    error: { code: 'PGRST205', message: 'not find market_rule_texts' },
  }));
  const rede = clienteFalso(() => ({ data: null, error: { message: 'fetch failed' } }));
  const vazio = clienteFalso(() => ({ data: null, error: null }));
  assert.deepEqual(
    [
      await lerTextoGuardado(ausente.db, SHA),
      await lerTextoGuardado(rede.db, SHA),
      await lerTextoGuardado(vazio.db, SHA),
    ],
    [{ fase: 'ausente' }, { fase: 'erro', motivo: 'fetch failed' }, { fase: 'ausente' }],
  );
});

test('lerContradicoes: lista vazia não consulta, lista cheia filtra por defeito_id', async () => {
  const { db, chamadas } = clienteFalso();
  assert.deepEqual(await lerContradicoes(db, []), []);
  assert.equal(chamadas.length, 0, 'lista vazia consultou o banco');
  await lerContradicoes(db, ['b'.repeat(32)]);
  assert.equal(chamadas[0]!.tabela, 'digest_contradicoes');
  assert.deepEqual(chamadas[0]!.passos[1], ['in', 'defeito_id', ['b'.repeat(32)]]);
});

test('lerCorpus lê as três tabelas do índice, só as colunas que ele usa', async () => {
  const { db, chamadas } = clienteFalso();
  const corpus = await lerCorpus(db);
  assert.deepEqual(corpus, { digests: [], pegadinhas: [], ambiguidades: [] });
  assert.deepEqual(
    chamadas.map((c) => [c.tabela, c.passos[0]]),
    [
      ['market_rule_digests', ['select', 'id, description_sha256']],
      ['digest_pegadinhas', ['select', 'digest_id, tipo:severidade, trecho']],
      ['digest_ambiguidades', ['select', 'digest_id, tipo, trecho, trecho_conflito']],
    ],
  );
});

test('as duas escritas são insert, e só nas suas tabelas', async () => {
  const { db, chamadas } = clienteFalso((c) =>
    c.tabela === 'my_bets' ? { data: { id: 'novo' }, error: null } : { data: null, error: null },
  );
  const linhaBet = { event_id: EVENTO, prob_self: 0.5 };
  const linhaLeg = { bet_id: 'novo', event_id: EVENTO };
  assert.equal(await gravarPrevisao(db, linhaBet), 'novo');
  await gravarLeg(db, linhaLeg);
  assert.deepEqual(chamadas, [
    { tabela: 'my_bets', passos: [['insert', linhaBet], ['select', 'id'], ['single']] },
    { tabela: 'my_bet_legs', passos: [['insert', linhaLeg]] },
  ]);
});

test('nenhuma consulta faz update, delete, upsert ou rpc', async () => {
  const { db, chamadas } = clienteFalso((c) =>
    c.tabela === 'events' || c.tabela === 'my_bets'
      ? { data: { description: null, id: 'x' }, error: null }
      : { data: [], error: null },
  );
  await Promise.all([
    lerRadar(db),
    lerContagens(db),
    lerAchados(db, EVENTO),
    lerLeituras(db, EVENTO, SHA),
    lerCorpus(db),
    lerContradicoes(db, ['b'.repeat(32)]),
    lerTextoDaRegra(db, EVENTO),
    lerTextoGuardado(db, SHA),
    gravarPrevisao(db, {}),
    gravarLeg(db, {}),
  ]);
  const verbos = new Set(chamadas.flatMap((c) => c.passos.map((p) => p[0])));
  for (const proibido of ['update', 'delete', 'upsert', 'rpc']) {
    assert.ok(!verbos.has(proibido), `uma consulta chamou ${proibido}`);
  }
  assert.deepEqual([...new Set(chamadas.map((c) => c.tabela))].sort(), [
    'digest_achados_por_mercado',
    'digest_ambiguidades',
    'digest_contradicoes',
    'digest_pegadinhas',
    'events',
    'market_rule_digests',
    'market_rule_texts',
    'my_bet_legs',
    'my_bets',
    'v_radar',
  ]);
});

test('erro do banco vira exceção com a mensagem dele', async () => {
  const { db } = clienteFalso(() => ({ data: null, error: { message: 'boom' } }));
  await assert.rejects(lerRadar(db), /boom/);
  await assert.rejects(gravarPrevisao(db, {}), /boom/);
  await assert.rejects(gravarLeg(db, {}), /boom/);
});

test('lerTextoDaRegra: mercado que não existe é resposta, não erro', async () => {
  const { db } = clienteFalso(() => ({ data: null, error: null }));
  assert.deepEqual(await lerTextoDaRegra(db, EVENTO), { encontrado: false });
});
