/**
 * A fronteira com o modelo.
 *
 * Existe para que trocar de fornecedor seja escrever um adaptador novo, e não
 * mexer no agente. O que fica deste lado é o que todo fornecedor tem: um prompt,
 * um schema de saída, um texto de volta e uma contagem de tokens. O que fica do
 * lado do adaptador é tudo que é dialeto — nome do parâmetro, forma do erro,
 * como se pede JSON, como se desliga o retry.
 *
 * A superfície é estreita de propósito: uma chamada, sem ferramentas, sem
 * conversa de vários turnos. É o que o analista usa hoje (`src/verticals/
 * analyst.ts`), e alargar isto antes de haver um segundo chamador seria desenhar
 * para um requisito que ninguém pediu.
 *
 * DeepSeek fala o formato da OpenAI, então um adaptador cobre os dois.
 */

/**
 * Tokens da chamada, separados por tarifa.
 *
 * Cache entra como termo próprio porque custa diferente da entrada normal
 * (~0,1x na leitura, ~1,25x na escrita). Hoje os dois são zero — ver
 * `estimateCostUsd` em `analyst.ts` para por quê — mas a conta os carrega para o
 * dia em que a cadência mudar.
 */
export interface TokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface CompletionRequest {
  model: string;
  system: string;
  user: string;
  /** JSON Schema da resposta. O adaptador decide como pedir aderência. */
  schema: Record<string, unknown>;
  /**
   * Profundidade de raciocínio, quando o fornecedor tem esse controle.
   *
   * Opcional porque não porta: a Anthropic aceita `low`..`max`, a OpenAI só tem
   * `reasoning_effort` na linha de raciocínio, e a DeepSeek não tem equivalente.
   * Adaptador que não souber o que fazer com o valor deve ignorá-lo — em
   * silêncio, porque um erro aqui derrubaria uma chamada que funcionaria bem sem
   * o ajuste.
   */
  effort?: string;
  maxTokens: number;
  timeoutMs: number;
}

/**
 * Por que a geração parou.
 *
 * `refusal` e `truncated` são estados separados de `ok` porque significam coisas
 * diferentes para quem paga e para quem lê: recusa antes da saída não é cobrada
 * e não adianta retentar com o mesmo prompt; truncagem foi cobrada e devolve
 * JSON pela metade. Um cliente que só devolvesse texto colapsaria os dois em
 * "veio vazio".
 */
export type CompletionStop = 'ok' | 'refusal' | 'truncated';

export interface CompletionResult {
  /** O texto da resposta. `null` sempre que `stop` não for `ok`. */
  text: string | null;
  stop: CompletionStop;
  usage: TokenUsage;
}

/**
 * Falhas de transporte (rede, prazo, 429, 5xx) sobem como exceção — cada
 * adaptador com a sua. Quem chama trata como falha da chamada, sem inspecionar o
 * tipo; distinguir uma da outra só passaria a valer se houvesse retry, e não há.
 */
export interface LlmClient {
  complete(request: CompletionRequest): Promise<CompletionResult>;
}
