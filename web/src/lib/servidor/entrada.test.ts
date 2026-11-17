import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  MAXIMO_DE_IDS,
  lerDefeitoIds,
  lerEventId,
  lerSha,
  validarLeg,
  validarPrevisao,
} from './entrada';

/**
 * What the two insert routes accept, and what they build from it.
 *
 * The rows are built from a whitelist: a body with extra keys must produce a
 * row with exactly the keys the old `gravarPrevisao` and `gravarLeg` wrote, so
 * someone with the password cannot set `estrategia`, `placed_at` or `id`.
 */

const EVENTO = '0b0e6a3e-3f1f-4a54-9a51-7d1c2e6f8a10';
const APOSTA = '6c9f2d1a-1b2c-4d3e-8f4a-5b6c7d8e9f00';

const PREVISAO = {
  eventId: EVENTO,
  prob: 0.62,
  categoria: 'politics',
  nota: 'a regra fala em anúncio oficial',
  precoMercado: 0.55,
  precoMercadoEm: '2026-11-16T12:00:00Z',
  precoMercadoOutcome: 'Yes',
  probSelfOutcome: 'Yes',
};

const LEG = { betId: APOSTA, eventId: EVENTO, outcome: 'Yes', entryPrice: 0.6, stakeUsd: 30 };

test('previsão: a linha tem exatamente as colunas da lista, mesmo com chaves a mais', () => {
  const r = validarPrevisao({
    ...PREVISAO,
    id: 'x',
    placed_at: '2020-01-01',
    estrategia: 'outra',
    prob_self: 1,
  });
  assert.ok(r.ok, `previsão válida recusada: ${r.ok ? '' : r.motivo}`);
  assert.deepEqual(r.valor, {
    event_id: EVENTO,
    prob_self: 0.62,
    estrategia: 'radar',
    polymarket_category: 'politics',
    preco_mercado: 0.55,
    preco_mercado_em: '2026-11-16T12:00:00Z',
    preco_mercado_outcome: 'Yes',
    prob_self_outcome: 'Yes',
    thesis: 'a regra fala em anúncio oficial',
    thesis_type: 'radar',
  });
});

test('previsão sem nota não grava thesis, e preço nulo fica nulo', () => {
  const r = validarPrevisao({ ...PREVISAO, nota: null, precoMercado: null });
  assert.ok(r.ok);
  assert.deepEqual(Object.keys(r.valor).sort(), [
    'estrategia',
    'event_id',
    'polymarket_category',
    'preco_mercado',
    'preco_mercado_em',
    'preco_mercado_outcome',
    'prob_self',
    'prob_self_outcome',
  ]);
  // `mid_price` null records NULL, never 0.50 (docs/context.md, princípio 4).
  assert.equal(r.valor['preco_mercado'], null);
});

test('previsão inválida é recusada', () => {
  const casos: Record<string, unknown> = {
    'corpo nulo': null,
    'corpo lista': [PREVISAO],
    'prob acima de 1': { ...PREVISAO, prob: 1.01 },
    'prob negativa': { ...PREVISAO, prob: -0.01 },
    'prob em %': { ...PREVISAO, prob: 62 },
    'prob texto': { ...PREVISAO, prob: '0.62' },
    'prob NaN': { ...PREVISAO, prob: Number.NaN },
    'sem prob': { ...PREVISAO, prob: undefined },
    'eventId malformado': { ...PREVISAO, eventId: 'abc' },
    'eventId com injeção': { ...PREVISAO, eventId: `${EVENTO},id.neq.0` },
    'preço acima de 1': { ...PREVISAO, precoMercado: 2 },
    'data ilegível': { ...PREVISAO, precoMercadoEm: 'ontem' },
    'categoria número': { ...PREVISAO, categoria: 3 },
    'nota gigante': { ...PREVISAO, nota: 'x'.repeat(20_001) },
  };
  const aceitos = Object.entries(casos)
    .filter(([, corpo]) => validarPrevisao(corpo).ok)
    .map(([nome]) => nome);
  assert.deepEqual(aceitos, [], 'previsão inválida passou');
});

test('leg: a linha tem exatamente as colunas da lista e as shares calculadas', () => {
  const r = validarLeg({ ...LEG, shares: 999, id: 'x', preco_mercado: 0.1 });
  assert.ok(r.ok, `leg válida recusada: ${r.ok ? '' : r.motivo}`);
  assert.deepEqual(r.valor, {
    bet_id: APOSTA,
    event_id: EVENTO,
    outcome: 'Yes',
    entry_price: 0.6,
    stake_usd: 30,
    shares: 50,
  });
});

test('leg inválida é recusada', () => {
  const casos: Record<string, unknown> = {
    'corpo nulo': null,
    'preço zero': { ...LEG, entryPrice: 0 },
    'preço negativo': { ...LEG, entryPrice: -0.5 },
    'preço acima de 1': { ...LEG, entryPrice: 1.2 },
    'stake zero': { ...LEG, stakeUsd: 0 },
    'stake negativo': { ...LEG, stakeUsd: -10 },
    'stake infinito': { ...LEG, stakeUsd: Number.POSITIVE_INFINITY },
    'betId malformado': { ...LEG, betId: 'abc' },
    'eventId malformado': { ...LEG, eventId: '' },
    'lado vazio': { ...LEG, outcome: '   ' },
  };
  const aceitos = Object.entries(casos)
    .filter(([, corpo]) => validarLeg(corpo).ok)
    .map(([nome]) => nome);
  assert.deepEqual(aceitos, [], 'leg inválida passou');
});

test('id, hash e lista de defeitos: só o formato exato passa', () => {
  const sha = 'a'.repeat(64);
  const md5 = 'b'.repeat(32);
  assert.deepEqual(
    [
      lerEventId(EVENTO).ok,
      lerEventId(EVENTO.toUpperCase()).ok,
      lerEventId('abc').ok,
      lerSha(sha).ok,
      lerSha('A'.repeat(64)).ok,
      lerSha(sha + 'a').ok,
      lerSha(null).ok,
    ],
    [true, true, false, true, false, false, false],
    'formato de id ou de hash',
  );

  assert.deepEqual(lerDefeitoIds(null), { ok: true, valor: [] }, 'sem ids é lista vazia');
  assert.deepEqual(lerDefeitoIds(`${md5},${md5}`), { ok: true, valor: [md5, md5] });
  assert.equal(lerDefeitoIds(`${md5},xyz`).ok, false, 'id de defeito malformado passou');
  assert.equal(MAXIMO_DE_IDS, 200);
  assert.equal(
    lerDefeitoIds(Array<string>(MAXIMO_DE_IDS).fill(md5).join(',')).ok,
    true,
    '200 ids deviam passar',
  );
  assert.equal(
    lerDefeitoIds(
      Array<string>(MAXIMO_DE_IDS + 1)
        .fill(md5)
        .join(','),
    ).ok,
    false,
    'mais de 200 ids passaram',
  );
});
