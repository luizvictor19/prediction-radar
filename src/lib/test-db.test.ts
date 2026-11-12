import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { SupabaseClient } from '@supabase/supabase-js';

import {
  isLocalDatabase,
  requireLocalDatabase,
  SKIP_REASON,
  testDatabase,
  type TestDatabaseDeps,
} from './test-db.js';

/**
 * The guard that keeps a writing test off the project's database.
 *
 * The mutation axes these exist to hold down:
 *
 * 1. **substring instead of hostname** — `url.includes('127.0.0.1')` passes every
 *    test below except `a host that merely CONTAINS a local one is not local`,
 *    which is the one that matters: an attacker-shaped or typo-shaped host that
 *    happens to embed the loopback address would be written to.
 * 2. **failing open on a bad URL** — returning `true` from the `catch` keeps the
 *    positive cases green and only breaks `garbage is not local`.
 * 3. **a host dropped from the set** — each accepted spelling has its own case,
 *    so narrowing the set cannot pass unnoticed.
 * 4. **a guard that measures and does not stop** — `requireLocalDatabase`
 *    returning instead of throwing is only caught by the two `throws` cases.
 */

test('the stack this machine publishes is local', () => {
  assert.equal(isLocalDatabase('http://127.0.0.1:54321'), true);
});

test('every accepted spelling of this machine is local', () => {
  for (const url of ['http://localhost:54321', 'http://[::1]:54321', 'https://127.0.0.1/rest']) {
    assert.equal(isLocalDatabase(url), true, url);
  }
});

test('the project database is not local', () => {
  assert.equal(isLocalDatabase('https://abcdefghijklm.supabase.co'), false);
});

/**
 * The case that separates a hostname check from a substring check. Both hosts
 * below contain `127.0.0.1` and neither resolves to this machine.
 */
test('a host that merely CONTAINS a local one is not local', () => {
  assert.equal(isLocalDatabase('http://127.0.0.1.attacker.example/rest/v1'), false);
  assert.equal(isLocalDatabase('https://127.0.0.1.supabase.co'), false);
});

test('garbage is not local', () => {
  for (const url of ['', 'not a url', '127.0.0.1:54321']) {
    assert.equal(isLocalDatabase(url), false, JSON.stringify(url));
  }
});

test('requireLocalDatabase lets a local URL through', () => {
  assert.doesNotThrow(() => requireLocalDatabase('http://127.0.0.1:54321'));
});

test('requireLocalDatabase throws on a remote URL, naming it', () => {
  assert.throws(() => requireLocalDatabase('https://abcdefghijklm.supabase.co'), {
    message: /refusing to use https:\/\/abcdefghijklm\.supabase\.co/,
  });
});

test('requireLocalDatabase throws on a host that only contains a local one', () => {
  assert.throws(() => requireLocalDatabase('http://127.0.0.1.attacker.example'), /refusing to use/);
});

/**
 * Whose stack is this?
 *
 * Something answering on the port is not enough: on 2026-11-12 another project's
 * local Supabase held 54321, and the pagination test's cleanup ran its DELETEs
 * there (issue 77). The guard reads the OpenAPI root once and accepts the stack
 * only if it lists all three relations below, which only this project's
 * migrations create.
 *
 * Every case asserts the whole call log, not just the result: a guard that skips
 * AFTER building the client, or that probes twice, ends in the same result and a
 * different log.
 *
 * The mutation axes these exist to hold down:
 *
 * 1. **no marker check** (any 200 is ours): breaks the foreign, `required` and
 *    `events`-only cases.
 * 2. **failing open on a body that is not JSON** (`catch` returns ours): breaks
 *    only the HTML case.
 * 3. **client built before the probe**: breaks the call order in every case.
 */

// A dead port: if a fake is ever bypassed, nothing answers and nothing is written.
const URL_TESTE = 'http://127.0.0.1:1';
const CHAVE_TESTE = 'chave-de-teste';
const MARCADORES = ['market_rule_texts', 'market_rule_digests', 'digest_achados_por_mercado'];
const CLIENTE = {} as SupabaseClient;

function openapi(relacoes: string[]): Response {
  const definitions = Object.fromEntries(relacoes.map((r) => [r, { type: 'object' }]));
  return new Response(JSON.stringify({ swagger: '2.0', definitions }), {
    status: 200,
    headers: { 'content-type': 'application/openapi+json' },
  });
}

/** The fakes, and the log both write to, in call order. */
function cenario(
  resposta: () => Promise<Response>,
  env: Record<string, string> = {},
): { chamadas: string[]; chavesEnviadas: (string | null)[]; deps: TestDatabaseDeps } {
  const chamadas: string[] = [];
  const chavesEnviadas: (string | null)[] = [];
  const fetchFalso = (async (entrada: string | URL | Request, init?: RequestInit) => {
    chamadas.push(`${init?.method ?? 'GET'} ${new URL(String(entrada)).pathname}`);
    chavesEnviadas.push(new Headers(init?.headers).get('apikey'));
    return resposta();
  }) as typeof fetch;
  const createClientFalso = (): SupabaseClient => {
    chamadas.push('createClient');
    return CLIENTE;
  };
  return {
    chamadas,
    chavesEnviadas,
    deps: {
      url: URL_TESTE,
      key: CHAVE_TESTE,
      env,
      fetch: fetchFalso,
      createClient: createClientFalso,
    },
  };
}

test('stack de outro projeto: pula, com uma única leitura e sem criar cliente', async () => {
  const { chamadas, deps } = cenario(async () => openapi(['clientes', 'pedidos', 'faturas']));

  const resultado = await testDatabase(deps);

  assert.deepEqual(
    chamadas,
    ['GET /rest/v1/'],
    'a única chamada à stack alheia deve ser o GET da raiz',
  );
  assert.ok('skipReason' in resultado, 'uma stack alheia deve virar skip, não cliente');
  assert.match(resultado.skipReason, /não é a deste projeto/);
});

test('stack de outro projeto com RADAR_TEST_DB=required: falha nomeando a URL e os marcadores', async () => {
  const { chamadas, deps } = cenario(async () => openapi(['clientes', 'pedidos']), {
    RADAR_TEST_DB: 'required',
  });

  await assert.rejects(testDatabase(deps), (erro: Error) => {
    assert.match(erro.message, /RADAR_TEST_DB=required/);
    assert.ok(
      erro.message.includes(URL_TESTE),
      `a mensagem deve nomear ${URL_TESTE}: ${erro.message}`,
    );
    for (const marcador of MARCADORES) {
      assert.ok(
        erro.message.includes(marcador),
        `a mensagem deve nomear ${marcador}: ${erro.message}`,
      );
    }
    return true;
  });
  assert.deepEqual(
    chamadas,
    ['GET /rest/v1/'],
    'com required, a falha vem antes de criar o cliente',
  );
});

/** `events` is a name any project could have, so it must not be what decides. */
test('stack que só tem uma tabela events genérica: pula', async () => {
  const { chamadas, deps } = cenario(async () => openapi(['events', 'system_logs']));

  const resultado = await testDatabase(deps);

  assert.deepEqual(chamadas, ['GET /rest/v1/']);
  assert.ok('skipReason' in resultado, 'ter events não faz a stack ser deste projeto');
});

/** A guard that fails open on a parse error would accept anything that is not JSON. */
test('resposta 200 em HTML: pula, sem tratar o erro de parse como sucesso', async () => {
  const { chamadas, deps } = cenario(
    async () =>
      new Response('<html><body>ok</body></html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      }),
  );

  const resultado = await testDatabase(deps);

  assert.deepEqual(chamadas, ['GET /rest/v1/']);
  assert.ok('skipReason' in resultado, 'um corpo que não é JSON não prova nada sobre a stack');
});

test('stack ausente (conexão recusada): pula com SKIP_REASON, como antes', async () => {
  const { chamadas, deps } = cenario(async () => {
    throw new TypeError('fetch failed');
  });

  const resultado = await testDatabase(deps);

  assert.deepEqual(chamadas, ['GET /rest/v1/']);
  assert.deepEqual(resultado, { skipReason: SKIP_REASON });
});

test('stack deste projeto: lê a raiz com a mesma chave e só DEPOIS cria o cliente', async () => {
  const { chamadas, chavesEnviadas, deps } = cenario(async () =>
    openapi(['events', ...MARCADORES]),
  );

  const resultado = await testDatabase(deps);

  assert.deepEqual(
    chamadas,
    ['GET /rest/v1/', 'createClient'],
    'a conferência da stack tem que vir antes do cliente que escreve',
  );
  assert.deepEqual(
    chavesEnviadas,
    [CHAVE_TESTE],
    'a leitura usa a mesma chave que o cliente vai usar',
  );
  assert.ok('client' in resultado, 'a stack deste projeto deve devolver o cliente');
  assert.equal(resultado.client, CLIENTE);
});
