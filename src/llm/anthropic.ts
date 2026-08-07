import Anthropic from '@anthropic-ai/sdk';
import type { CompletionRequest, CompletionResult, CompletionStop, LlmClient } from './client.js';

/**
 * O adaptador Anthropic: tudo que é dialeto do fornecedor mora aqui.
 */

/**
 * Criado sob demanda, não no topo do módulo.
 *
 * `new Anthropic()` lança quando não há credencial, e o topo do módulo roda no
 * import — o que derrubaria o processo inteiro por causa de um componente que
 * nasce desligado. Aqui a falta de chave falha só esta chamada.
 */
let sdk: Anthropic | null = null;

function client(): Anthropic {
  sdk ??= new Anthropic();
  return sdk;
}

function readStop(reason: Anthropic.Message['stop_reason']): CompletionStop {
  if (reason === 'refusal') return 'refusal';
  if (reason === 'max_tokens') return 'truncated';
  return 'ok';
}

/**
 * Uma chamada, um prazo, nenhum retry.
 *
 * `maxRetries: 0` é deliberado e é a parte que mais importa deste arquivo. O
 * padrão do SDK é 2 tentativas, e como timeouts também são retentados, um prazo
 * de 90s vira 4,5 minutos de relógio na pior hipótese — dentro de um ciclo de
 * cron com lock. É a mesma forma de falha do fetch da Gamma sem timeout que
 * custou 48h de coleta parada, só que mais cara.
 *
 * O que se perde: um 429 ou um 500 transitório derruba a chamada. Quem decide se
 * isso é aceitável é o chamador — no caso do analista, é, porque o checkpoint É
 * um instante e retentá-lo depois produziria uma análise rotulada "T-6h" feita
 * com o que se sabia em T-5h.
 *
 * O pensamento fica LIGADO, e o controle de custo é o `effort`. Desligá-lo tem
 * dois modos de falha conhecidos nos modelos atuais — texto interno vazando para
 * a resposta e chamadas de ferramenta escritas como texto — e economiza menos
 * que baixar o esforço. Como não passamos `thinking`, vale o padrão do modelo,
 * que é adaptativo.
 */
export const anthropicClient: LlmClient = {
  async complete(request: CompletionRequest): Promise<CompletionResult> {
    const message = await client().messages.create(
      {
        model: request.model,
        max_tokens: request.maxTokens,
        system: request.system,
        messages: [{ role: 'user', content: request.user }],
        output_config: {
          ...(request.effort === undefined
            ? {}
            : { effort: request.effort as Anthropic.OutputConfig['effort'] }),
          format: { type: 'json_schema', schema: request.schema },
        },
      },
      { signal: AbortSignal.timeout(request.timeoutMs), maxRetries: 0 },
    );

    // Antes de ler `content`: uma recusa devolve HTTP 200 com content vazio, e
    // truncagem devolve JSON pela metade. Os dois passariam por "resposta ok" num
    // código que indexa content[0] direto.
    const stop = readStop(message.stop_reason);
    const block = message.content.find(
      (candidate): candidate is Anthropic.TextBlock => candidate.type === 'text',
    );

    return {
      text: stop === 'ok' ? (block?.text ?? null) : null,
      stop,
      usage: {
        input: message.usage.input_tokens,
        output: message.usage.output_tokens,
        cacheRead: message.usage.cache_read_input_tokens ?? 0,
        cacheWrite: message.usage.cache_creation_input_tokens ?? 0,
      },
    };
  },
};
