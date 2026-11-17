import { test } from 'node:test';
import assert from 'node:assert/strict';

import { GetParameterCommand } from '@aws-sdk/client-ssm';

import { createSecretLoader, type ParameterSender } from './secrets.js';

const SUPABASE_KEY = 'segredo-supabase-123';
const ANTHROPIC_KEY = 'segredo-anthropic-456';

function fakeSsm(values: Record<string, string | undefined>) {
  const asked: GetParameterCommand[] = [];
  const ssm: ParameterSender = {
    send(command) {
      asked.push(command);
      const name = command.input.Name ?? '';
      if (!(name in values)) {
        const err = new Error(`Parameter ${name} not found.`);
        err.name = 'ParameterNotFound';
        return Promise.reject(err);
      }
      return Promise.resolve({ Parameter: { Value: values[name] } });
    },
  };
  return { ssm, asked };
}

const VALUES = {
  '/radar/dev/supabase-url': 'https://exemplo.supabase.co',
  '/radar/dev/supabase-service-key': SUPABASE_KEY,
  '/radar/dev/anthropic-api-key': ANTHROPIC_KEY,
};

test('segredos: Supabase entra no ambiente, pedido com WithDecryption', async () => {
  const { ssm, asked } = fakeSsm(VALUES);
  const env: Record<string, string | undefined> = {};
  await createSecretLoader(ssm, '/radar/dev', { env, log: () => undefined }).loadSupabase();
  assert.equal(env['SUPABASE_URL'], 'https://exemplo.supabase.co');
  assert.equal(env['SUPABASE_SERVICE_KEY'], SUPABASE_KEY);
  assert.ok(asked.every((c) => c.input.WithDecryption === true));
});

test('segredos: a chave do modelo é a do fornecedor da rota, uma vez só', async () => {
  const { ssm, asked } = fakeSsm(VALUES);
  const env: Record<string, string | undefined> = {};
  const loader = createSecretLoader(ssm, '/radar/dev', { env, log: () => undefined });
  await loader.loadModelKey('anthropic');
  await loader.loadModelKey('anthropic');
  assert.equal(env['ANTHROPIC_API_KEY'], ANTHROPIC_KEY);
  assert.equal(
    env['DEEPSEEK_API_KEY'],
    undefined,
    'a chave da DeepSeek não pode ser lida sem rota',
  );
  assert.deepEqual(
    asked.map((c) => c.input.Name),
    ['/radar/dev/anthropic-api-key'],
  );
});

test('segredos: parâmetro ausente ou vazio falha nomeando o parâmetro', async () => {
  const empty = fakeSsm({ ...VALUES, '/radar/dev/supabase-service-key': '' });
  await assert.rejects(
    createSecretLoader(empty.ssm, '/radar/dev', { env: {}, log: () => undefined }).loadSupabase(),
    /\/radar\/dev\/supabase-service-key/,
  );
  const missing = fakeSsm({});
  await assert.rejects(
    createSecretLoader(missing.ssm, '/radar/dev', { env: {}, log: () => undefined }).loadModelKey(
      'deepseek',
    ),
    /\/radar\/dev\/deepseek-api-key/,
  );
});

test('segredos: o valor nunca aparece numa linha de log nem numa mensagem de erro', async () => {
  const logs: string[] = [];
  const { ssm } = fakeSsm(VALUES);
  const loader = createSecretLoader(ssm, '/radar/dev', { env: {}, log: (l) => logs.push(l) });
  await loader.loadSupabase();
  await loader.loadModelKey('anthropic');
  assert.ok(logs.length > 0, 'o carregamento deveria registrar os nomes lidos');
  for (const line of logs) {
    assert.ok(!line.includes(SUPABASE_KEY), `a chave do Supabase vazou no log: ${line}`);
    assert.ok(!line.includes(ANTHROPIC_KEY), `a chave da Anthropic vazou no log: ${line}`);
  }

  const leaky: ParameterSender = {
    send: () => Promise.reject(new Error(`AccessDenied for value ${SUPABASE_KEY}`)),
  };
  await assert.rejects(
    createSecretLoader(leaky, '/radar/dev', { env: {}, log: () => undefined }).loadSupabase(),
    (err: unknown) => err instanceof Error && !err.message.includes(SUPABASE_KEY),
  );
});
