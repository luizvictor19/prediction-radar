import type { CompletionRequest, CompletionResult, CompletionStop, LlmClient } from './client.js';

/**
 * O adaptador DeepSeek: tudo que é dialeto do fornecedor mora aqui.
 *
 * A API fala o formato da OpenAI (`POST /chat/completions`, `messages`,
 * `response_format`, `usage.prompt_tokens`), então este arquivo é tradução e não
 * reescrita — a interface de `client.ts` já era a certa.
 *
 * Sem SDK, e é decisão: `fetch` está no runtime desde o Node 18, a superfície
 * usada aqui é uma rota só, e trazer o pacote `openai` para isso adicionaria uma
 * dependência de produção inteira (com o próprio retry ligado por padrão, que é
 * exatamente o que este arquivo não quer — ver `maxRetries` em `anthropic.ts`).
 */

const BASE_URL = 'https://api.deepseek.com';

/**
 * Lida na chamada e não no topo do módulo, pelo mesmo motivo do `anthropicClient`:
 * o topo roda no import, e a falta da chave derrubaria o processo inteiro por
 * causa de um componente que nasce desligado. Aqui ela falha só esta chamada.
 *
 * **`process.env`, nunca o arquivo.** O `.env` é do dono.
 */
function apiKey(): string {
  const key = process.env['DEEPSEEK_API_KEY'];
  if (key === undefined || key.trim().length === 0) {
    throw new Error('DEEPSEEK_API_KEY não está no ambiente');
  }
  return key;
}

/**
 * Por que a geração parou, na taxonomia deles.
 *
 * `content_filter` vira `refusal` e `length` vira `truncated` porque quem chama
 * precisa distinguir: recusa não adianta retentar com o mesmo prompt, truncagem
 * pede teto maior. `insufficient_system_resource` é o 503 deles disfarçado de
 * finish_reason — sobe como exceção, que é onde falha de transporte mora.
 */
function readStop(reason: string | null | undefined): CompletionStop {
  if (reason === 'content_filter') return 'refusal';
  if (reason === 'length') return 'truncated';
  return 'ok';
}

interface ChatCompletionResponse {
  choices?: Array<{
    message?: { content?: string | null };
    finish_reason?: string | null;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_cache_hit_tokens?: number;
    prompt_cache_miss_tokens?: number;
  };
}

/**
 * Como se pede JSON aqui, e por que não é o mesmo que na Anthropic.
 *
 * A Anthropic recebe o JSON Schema em `output_config.format` e GARANTE a forma.
 * A DeepSeek tem `response_format: {type: 'json_object'}`, que garante que a
 * saída é JSON válido e nada além disso — as chaves e os tipos ficam por conta
 * do prompt.
 *
 * Então o schema vai no texto do sistema. Não é gambiarra nem meio-termo: a
 * validação que decide se a resposta vira linha nunca foi a da API. É
 * `parseDigest`, que roda igual nos dois fornecedores porque a forma garantida
 * pela API já não cobria faixa nem coerência entre campos. O que muda entre um e
 * outro é só QUANTAS respostas chegam malformadas — e essa é justamente uma das
 * medidas do degrau 2 (`taxa de saída inválida`).
 */
function systemWithSchema(system: string, schema: Record<string, unknown>): string {
  return [
    system,
    '',
    '## Formato da resposta',
    '',
    'Responda com um único objeto JSON, sem texto antes ou depois, aderente a este JSON Schema:',
    '',
    JSON.stringify(schema, null, 2),
  ].join('\n');
}

/**
 * Uma chamada, um prazo, nenhum retry — a mesma escolha de `anthropic.ts`, e
 * pela mesma razão: retry multiplica o prazo pelo número de tentativas, e é
 * assim que um ciclo fica pendurado. `fetch` não retenta por conta própria, que
 * é outro motivo de não haver SDK aqui.
 *
 * `effort` é ignorado EM SILÊNCIO. A DeepSeek não tem controle equivalente, e o
 * contrato de `CompletionRequest` manda ignorar em vez de errar — um erro aqui
 * derrubaria uma chamada que funcionaria bem sem o ajuste.
 */
export const deepseekClient: LlmClient = {
  async complete(request: CompletionRequest): Promise<CompletionResult> {
    const response = await fetch(`${BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey()}`,
      },
      body: JSON.stringify({
        model: request.model,
        max_tokens: request.maxTokens,
        messages: [
          { role: 'system', content: systemWithSchema(request.system, request.schema) },
          { role: 'user', content: request.user },
        ],
        response_format: { type: 'json_object' },
      }),
      signal: AbortSignal.timeout(request.timeoutMs),
    });

    if (!response.ok) {
      // O corpo do erro é onde mora o motivo útil ("model not found", saldo,
      // 429). Truncado porque um 5xx pode devolver uma página inteira de HTML e
      // isso vira mensagem de log.
      const body = (await response.text().catch(() => '')).slice(0, 300);
      throw new Error(`deepseek ${response.status} ${response.statusText}: ${body}`);
    }

    const payload = (await response.json()) as ChatCompletionResponse;
    const choice = payload.choices?.[0];
    const stop = readStop(choice?.finish_reason);

    const usage = payload.usage ?? {};
    const promptTokens = usage.prompt_tokens ?? 0;
    // `prompt_cache_hit_tokens` é parte de `prompt_tokens`, não uma parcela a
    // mais. Somar os dois contaria a entrada duas vezes na conta de custo.
    const cacheRead = usage.prompt_cache_hit_tokens ?? 0;

    return {
      text: stop === 'ok' ? (choice?.message?.content ?? null) : null,
      stop,
      usage: {
        input: Math.max(0, promptTokens - cacheRead),
        output: usage.completion_tokens ?? 0,
        cacheRead,
        // Não existe escrita de cache cobrada aqui: o cache é automático e o
        // fornecedor não cobra a gravação. O termo fica em zero, não some.
        cacheWrite: 0,
      },
    };
  },
};

/**
 * Os modelos que a conta enxerga, pelo endpoint gratuito `/models`.
 *
 * Existe para o `--dry-run` conferir o nome do modelo ANTES de qualquer chamada
 * paga. É a falha mais barata de evitar e a mais cara de descobrir tarde: nome
 * errado devolve 404 por chamada, e num laço de 673 isso é um laço inteiro de
 * erro. `deepseek-chat` e `deepseek-reasoner` foram aposentados em 24/07/2026 —
 * exatamente os dois nomes que qualquer um escreveria de memória.
 */
export async function listDeepseekModels(timeoutMs = 15_000): Promise<string[]> {
  const response = await fetch(`${BASE_URL}/models`, {
    headers: { authorization: `Bearer ${apiKey()}` },
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!response.ok) {
    throw new Error(`deepseek /models ${response.status} ${response.statusText}`);
  }

  const payload = (await response.json()) as { data?: Array<{ id?: string }> };
  return (payload.data ?? [])
    .map(m => m.id)
    .filter((id): id is string => typeof id === 'string');
}
