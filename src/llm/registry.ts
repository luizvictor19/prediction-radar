import { anthropicClient } from './anthropic.js';
import type { LlmClient } from './client.js';
import { deepseekClient } from './deepseek.js';

/**
 * De um nome de modelo para o adaptador que fala com ele.
 *
 * Existe porque agora há dois fornecedores e um componente — a digestão de
 * regras — que roda o MESMO prompt nos dois lado a lado. Sem isto, escolher
 * fornecedor voltaria a ser um `import` no chamador, e a comparação viraria
 * dois caminhos de código diferentes medindo coisas diferentes.
 *
 * O analista continua importando `anthropicClient` direto, e isso não é
 * esquecimento: ele roda um modelo só, decidido por `analyst_model`, e trocar o
 * import dele por esta função mudaria um componente que funciona para ganhar
 * nada hoje. Quando ele precisar de dois, entra por aqui.
 *
 * O prefixo do nome é a chave, e é o que o fornecedor promete: `claude-*` é da
 * Anthropic, `deepseek-*` é da DeepSeek. Nome que não bate com nenhum prefixo
 * não cai em fornecedor padrão — devolve `null`, e quem chama para. Um padrão
 * aqui mandaria o prompt para a API errada e a falha apareceria como 404 de
 * modelo inexistente, que é o sintoma mais confuso possível.
 */
export type Provider = 'anthropic' | 'deepseek';

export function providerFor(model: string): Provider | null {
  if (model.startsWith('claude-')) return 'anthropic';
  if (model.startsWith('deepseek-')) return 'deepseek';
  return null;
}

export function clientFor(model: string): LlmClient | null {
  switch (providerFor(model)) {
    case 'anthropic':
      return anthropicClient;
    case 'deepseek':
      return deepseekClient;
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Routes: the unattended path (issue 93)
// ---------------------------------------------------------------------------

/**
 * Canonical model name to `provider:model-id`, for the scheduled digestion.
 *
 * The prefix lookup above accepts any `claude-*` name; the scheduled run must
 * not. A route table makes "which model may this run pay for" an explicit list:
 * a name with no route stops the run with `CONFIG_ERROR` before any paid call,
 * instead of reaching a provider that answers 404 in the middle of a batch.
 *
 * The canonical name is what the `model` column stores, so a reading made here
 * and one made by the manual script share the dedup key. The model id is what
 * the provider is called with; today both are equal, and the split exists for
 * a provider that names the same model differently.
 *
 * Decision of 2026-11-17 on issue 86: the target is `claude-haiku-5-5` through
 * the Anthropic API; `deepseek-v4-flash` stays routed because it is the value
 * `system_config.digest_model` holds until the switch.
 */
export const DEFAULT_MODEL_ROUTES: Readonly<Record<string, string>> = {
  'claude-haiku-5-5': 'anthropic:claude-haiku-5-5',
  'deepseek-v4-flash': 'deepseek:deepseek-v4-flash',
};

export interface ModelRoute {
  provider: Provider;
  modelId: string;
}

const PROVIDERS: readonly Provider[] = ['anthropic', 'deepseek'];

export function routeFor(
  model: string,
  routes: Readonly<Record<string, string>> = DEFAULT_MODEL_ROUTES,
): ModelRoute | null {
  const route = Object.hasOwn(routes, model) ? routes[model] : undefined;
  if (route === undefined) return null;
  const separator = route.indexOf(':');
  if (separator < 0) return null;
  const provider = route.slice(0, separator);
  const modelId = route.slice(separator + 1);
  if (!PROVIDERS.includes(provider as Provider) || modelId.length === 0) return null;
  return { provider: provider as Provider, modelId };
}

/** Reads a route table from its JSON text (an environment variable in the Lambda). */
export function parseRoutes(json: string): Record<string, string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error('tabela de rotas inválida: não é JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('tabela de rotas inválida: esperado um objeto');
  }
  const routes: Record<string, string> = {};
  for (const [model, route] of Object.entries(parsed)) {
    if (typeof route !== 'string') {
      throw new Error(`tabela de rotas inválida: a rota de ${model} não é texto`);
    }
    routes[model] = route;
  }
  return routes;
}

function providerClient(provider: Provider): LlmClient {
  return provider === 'anthropic' ? anthropicClient : deepseekClient;
}

/**
 * The client for a route, calling the provider with the route's model id.
 *
 * `clientForProvider` is a parameter so a test can see the id that reaches the
 * provider without a network call.
 */
export function routedClient(
  route: ModelRoute,
  clientForProvider: (provider: Provider) => LlmClient = providerClient,
): LlmClient {
  const inner = clientForProvider(route.provider);
  return {
    complete: (request) => inner.complete({ ...request, model: route.modelId }),
  };
}
