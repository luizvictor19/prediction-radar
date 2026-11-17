import { test } from 'node:test';
import assert from 'node:assert/strict';

import { RECORD_DIGEST_FUNCTION, recordDigest, type RpcClient } from './persist.js';
import type { DigestRows } from './rows.js';

// The contract of `recordDigest` with the client, without a database: one rpc
// call per reading, the four parts in four named arguments, and only the two
// answers the function can give. What the function does with them is the job of
// `persist.db.test.ts`, against a real Postgres.

const ROWS: DigestRows = {
  text: { description_sha256: 'a'.repeat(64), description: 'regra', guardado_por: 'digestao' },
  digest: { event_id: 'e1', description_sha256: 'a'.repeat(64), leitura_n: 1 },
  pegadinhas: [{ ordinal: 1, texto: 'p1' }],
  ambiguidades: [{ ordinal: 1, leitura_a: 'a1' }],
};

interface Call {
  fn: string;
  args: Record<string, unknown>;
}

/** A client that records every call and answers from a queue. */
function fakeClient(answers: Array<{ data: unknown; error: { message: string } | null }>): {
  client: RpcClient;
  calls: Call[];
} {
  const calls: Call[] = [];
  const client: RpcClient = {
    rpc(fn, args) {
      calls.push({ fn, args });
      const answer = answers.shift();
      if (answer === undefined) throw new Error('o fake recebeu mais chamadas que respostas');
      return Promise.resolve(answer);
    },
  };
  return { client, calls };
}

test('recordDigest: uma chamada rpc por leitura, com as quatro partes nos quatro argumentos', async () => {
  const { client, calls } = fakeClient([{ data: 'inserted', error: null }]);

  await recordDigest(client, ROWS);

  assert.deepEqual(
    calls,
    [
      {
        fn: 'record_rule_digest',
        args: {
          p_text: ROWS.text,
          p_digest: ROWS.digest,
          p_pegadinhas: ROWS.pegadinhas,
          p_ambiguidades: ROWS.ambiguidades,
        },
      },
    ],
    'a gravação de uma leitura tem que ser UMA chamada; duas chamadas são duas transações',
  );
  assert.equal(RECORD_DIGEST_FUNCTION, 'record_rule_digest');
});

test('recordDigest: devolve a sequência que o banco devolve, inserted e depois duplicate', async () => {
  const { client, calls } = fakeClient([
    { data: 'inserted', error: null },
    { data: 'duplicate', error: null },
  ]);

  const respostas = [await recordDigest(client, ROWS), await recordDigest(client, ROWS)];

  assert.deepEqual(respostas, ['inserted', 'duplicate']);
  assert.equal(calls.length, 2, 'cada recordDigest faz exatamente uma chamada');
});

test('recordDigest: incomplete passa adiante como resposta, não como erro nem como duplicate', async () => {
  const { client } = fakeClient([
    { data: 'incomplete', error: null },
    { data: 'incomplete', error: null },
  ]);

  const respostas = [await recordDigest(client, ROWS), await recordDigest(client, ROWS)];

  assert.deepEqual(respostas, ['incomplete', 'incomplete']);
});

test('recordDigest: erro do banco vira exceção com o nome da função e a mensagem do banco', async () => {
  const { client } = fakeClient([
    { data: null, error: { message: 'violates check constraint "digest_pegadinhas_x"' } },
  ]);

  await assert.rejects(
    () => recordDigest(client, ROWS),
    (err: Error) =>
      err.message.includes('record_rule_digest') &&
      err.message.includes('violates check constraint "digest_pegadinhas_x"'),
  );
});

test('recordDigest: resposta fora de inserted|duplicate é exceção, nunca sucesso', async () => {
  for (const data of [null, 'ok', 'INSERTED', 1, { status: 'inserted' }]) {
    const { client } = fakeClient([{ data, error: null }]);
    await assert.rejects(
      () => recordDigest(client, ROWS),
      (err: Error) => err.message.includes('resposta inesperada'),
      `a resposta ${JSON.stringify(data)} não pode passar como gravação`,
    );
  }
});
