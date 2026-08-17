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
