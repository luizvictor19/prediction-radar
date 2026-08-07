import { test } from 'node:test';
import assert from 'node:assert/strict';

// Nenhum teste aqui toca a rede. Tudo é orçamento, sintaxe de condição e
// desempacotamento de resposta — as três coisas que, erradas, ou violam os
// termos de uso ou perguntam silenciosamente sobre outra coisa.
process.env['SUPABASE_URL'] ??= 'http://localhost:54321';
process.env['SUPABASE_SERVICE_KEY'] ??= 'test-key';

const {
  RateBudget,
  conditionValue,
  eq,
  or,
  and,
  before,
  extractRows,
  describeConfig,
  readConfig,
  LiquipediaError,
  HOURLY_LIMIT,
  PROCESS_HOURLY_LIMIT,
} = await import('./liquipedia-api.js');

// ---------------------------------------------------------------------------
// Orçamento — a regra dos termos que é fácil de violar sem perceber
// ---------------------------------------------------------------------------

test('o teto do processo fica abaixo do teto dos termos', () => {
  // A diferença é a reserva do script de sonda, que roda noutro processo e tem
  // contador próprio. Dois contadores independentes somando 60 estourariam o
  // limite de verdade.
  assert.ok(PROCESS_HOURLY_LIMIT < HOURLY_LIMIT);
});

test('o orçamento recusa depois do teto e libera pela janela deslizante', () => {
  const budget = new RateBudget(3, 60_000);
  const t0 = 1_000_000;

  assert.equal(budget.take(t0).ok, true);
  assert.equal(budget.take(t0 + 1_000).ok, true);
  assert.equal(budget.take(t0 + 2_000).ok, true);

  const refused = budget.take(t0 + 3_000);
  assert.equal(refused.ok, false);
  assert.equal(budget.remaining(t0 + 3_000), 0);

  // A janela é deslizante, não um balde que zera: em t0+60,5s só a PRIMEIRA
  // chamada saiu, e libera uma vaga — não as três.
  assert.equal(budget.remaining(t0 + 60_500), 1);
  assert.equal(budget.take(t0 + 60_500).ok, true);
  assert.equal(budget.remaining(t0 + 60_500), 0);

  // Em t0+61,5s a segunda também saiu.
  assert.equal(budget.remaining(t0 + 61_500), 1);
});

test('recusa por teto informa quando libera', () => {
  const budget = new RateBudget(1, 60_000);
  budget.take(1_000);

  const refused = budget.take(2_000);
  assert.equal(refused.ok, false);
  if (!refused.ok) assert.ok(refused.retryInMs > 0 && refused.retryInMs <= 60_000);
});

test('o espaçamento mínimo vale entre chamadas, não antes da primeira', () => {
  const budget = new RateBudget(10, 60_000);

  assert.equal(budget.waitMs(1_000), 0);
  budget.take(1_000);
  assert.ok(budget.waitMs(1_100) > 0);
  assert.equal(budget.waitMs(5_000), 0);
});

// ---------------------------------------------------------------------------
// Condições — errar aqui não falha, responde sobre outra coisa
// ---------------------------------------------------------------------------

test('valor com caractere de estrutura é recusado, não escapado', () => {
  // `[`, `]`, `|` e `::` são sintaxe do LPDB. Um nome de time com qualquer um
  // deles mudaria o sentido da condição em silêncio.
  for (const bad of ['Team [A]', 'A|B', 'a::b', '   ']) {
    assert.throws(() => conditionValue(bad), LiquipediaError);
  }
});

test('nome normal passa e vira condição', () => {
  assert.equal(eq('name', 'Natus Vincere'), '[[name::Natus Vincere]]');
  assert.equal(eq('pagename', '  FaZe Clan  '), '[[pagename::FaZe Clan]]');
});

test('OR só parentiza quando há mais de um termo', () => {
  assert.equal(or(eq('name', 'A')), '[[name::A]]');
  assert.equal(or(eq('name', 'A'), eq('name', 'B')), '([[name::A]] OR [[name::B]])');
  assert.equal(or(), '');
});

test('AND ignora termo vazio em vez de produzir "X AND "', () => {
  assert.equal(and(eq('opponent', 'A'), ''), '[[opponent::A]]');
  assert.equal(and(eq('opponent', 'A'), eq('opponent', 'B')), '[[opponent::A]] AND [[opponent::B]]');
});

test('a data da condição é UTC e sem hora', () => {
  assert.equal(before('date', new Date('2026-08-07T23:30:00.000Z')), '[[date::<2026-08-07]]');
});

// ---------------------------------------------------------------------------
// Resposta — escrita contra documentação, então tolerante por decisão
// ---------------------------------------------------------------------------

test('aceita a envelopagem em `result` e a lista crua', () => {
  assert.deepEqual(extractRows({ result: [{ a: 1 }] }), [{ a: 1 }]);
  assert.deepEqual(extractRows([{ a: 1 }]), [{ a: 1 }]);
  assert.deepEqual(extractRows({ result: [] }), []);
});

test('resposta sem lista vira erro nomeado, não exceção de acesso a campo', () => {
  assert.throws(() => extractRows({ error: 'nope' }, 'team'), (err: unknown) => {
    assert.ok(err instanceof LiquipediaError);
    assert.equal((err as InstanceType<typeof LiquipediaError>).kind, 'shape');
    return true;
  });
});

test('linha que não é objeto é descartada, não derruba a resposta', () => {
  assert.deepEqual(extractRows({ result: [{ a: 1 }, null, 'x', { b: 2 }] }), [{ a: 1 }, { b: 2 }]);
});

// ---------------------------------------------------------------------------
// Credenciais
// ---------------------------------------------------------------------------

test('sem as duas variáveis o cliente se declara não configurado', () => {
  const key = process.env['LIQUIPEDIA_API_KEY'];
  const agent = process.env['LIQUIPEDIA_USER_AGENT'];

  try {
    delete process.env['LIQUIPEDIA_API_KEY'];
    delete process.env['LIQUIPEDIA_USER_AGENT'];
    assert.equal(readConfig(), null);
    assert.match(describeConfig(), /LIQUIPEDIA_API_KEY/);
    assert.match(describeConfig(), /LIQUIPEDIA_USER_AGENT/);

    // User-Agent é exigência dos termos, não conveniência: chave sozinha não
    // habilita nada.
    process.env['LIQUIPEDIA_API_KEY'] = 'k';
    assert.equal(readConfig(), null);
    assert.match(describeConfig(), /LIQUIPEDIA_USER_AGENT/);

    process.env['LIQUIPEDIA_USER_AGENT'] = 'prediction-radar/0.1 (https://x; a@b)';
    assert.deepEqual(readConfig(), {
      apiKey: 'k',
      userAgent: 'prediction-radar/0.1 (https://x; a@b)',
    });
    assert.equal(describeConfig(), 'configurado');
  } finally {
    if (key === undefined) delete process.env['LIQUIPEDIA_API_KEY'];
    else process.env['LIQUIPEDIA_API_KEY'] = key;
    if (agent === undefined) delete process.env['LIQUIPEDIA_USER_AGENT'];
    else process.env['LIQUIPEDIA_USER_AGENT'] = agent;
  }
});

test('a chave nunca aparece no texto que vai para o log', () => {
  const key = process.env['LIQUIPEDIA_API_KEY'];
  try {
    process.env['LIQUIPEDIA_API_KEY'] = 'segredo-que-nao-pode-vazar';
    assert.ok(!describeConfig().includes('segredo-que-nao-pode-vazar'));
  } finally {
    if (key === undefined) delete process.env['LIQUIPEDIA_API_KEY'];
    else process.env['LIQUIPEDIA_API_KEY'] = key;
  }
});
