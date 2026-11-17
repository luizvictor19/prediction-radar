import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { CompletionRequest, CompletionResult, LlmClient } from './client.js';
import { DEFAULT_MODEL_ROUTES, parseRoutes, routeFor, routedClient } from './registry.js';

test('rota: claude-haiku-5-5 vai para a Anthropic com o mesmo id', () => {
  assert.deepEqual(routeFor('claude-haiku-5-5'), {
    provider: 'anthropic',
    modelId: 'claude-haiku-5-5',
  });
});

test('rota: deepseek-v4-flash vai para a DeepSeek com o mesmo id', () => {
  assert.deepEqual(routeFor('deepseek-v4-flash'), {
    provider: 'deepseek',
    modelId: 'deepseek-v4-flash',
  });
});

test('rota: modelo fora da tabela devolve null, mesmo com prefixo conhecido', () => {
  // `providerFor` aceitaria pelo prefixo; a tabela de rotas não, e é de propósito:
  // modelo sem rota declarada para a corrida antes de qualquer chamada paga.
  assert.equal(routeFor('claude-sonnet-5'), null);
  assert.equal(routeFor('gpt-5'), null);
});

test('rota: tabela sem nenhum fornecedor conhecido ou sem id devolve null', () => {
  const routes = {
    a: 'bedrock:global.anthropic.claude-haiku-5-5',
    b: 'anthropic:',
    c: 'semdoispontos',
  };
  assert.equal(routeFor('a', routes), null);
  assert.equal(routeFor('b', routes), null);
  assert.equal(routeFor('c', routes), null);
});

test('rota: a tabela padrão tem exatamente as duas rotas da decisão de 17/11', () => {
  assert.deepEqual(Object.keys(DEFAULT_MODEL_ROUTES).sort(), [
    'claude-haiku-5-5',
    'deepseek-v4-flash',
  ]);
});

test('parseRoutes: JSON de objeto com strings vira tabela; o resto lança', () => {
  assert.deepEqual(parseRoutes('{"m":"anthropic:m"}'), { m: 'anthropic:m' });
  assert.throws(() => parseRoutes('[1]'), /tabela de rotas inválida/);
  assert.throws(() => parseRoutes('{"m":1}'), /tabela de rotas inválida/);
  assert.throws(() => parseRoutes('não é json'), /tabela de rotas inválida/);
});

test('routedClient: troca o nome canônico pelo id da rota antes de chamar', async () => {
  const seen: string[] = [];
  const inner: LlmClient = {
    complete(request: CompletionRequest): Promise<CompletionResult> {
      seen.push(request.model);
      return Promise.resolve({
        text: '{}',
        stop: 'ok',
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      });
    },
  };
  const client = routedClient({ provider: 'anthropic', modelId: 'id-do-fornecedor' }, () => inner);
  await client.complete({
    model: 'nome-canonico',
    system: 's',
    user: 'u',
    schema: {},
    maxTokens: 1,
    timeoutMs: 1,
  });
  assert.deepEqual(seen, ['id-do-fornecedor']);
});
