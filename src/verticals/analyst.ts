import { createHash } from 'node:crypto';
import { anthropicClient } from '../llm/anthropic.js';
import type { CompletionResult, LlmClient, TokenUsage } from '../llm/client.js';
import {
  ANALYSIS_SCHEMA,
  getPrompt,
  type BuiltPrompt,
  type PromptFragment,
  type PromptInput,
} from './analyst-prompts.js';

/**
 * O agente analista (spec 001).
 *
 * Topologia single agent: UMA chamada, sem orquestração e sem grafo. A decisão
 * não é minimalismo — é que não há tarefa aqui que um segundo agente resolva. O
 * contexto já chega estruturado (os enrichers fizeram a leitura da série), a
 * saída é um objeto pequeno, e não há ferramenta para o modelo usar. Um grafo
 * acrescentaria latência, custo e superfície de falha para reproduzir o que uma
 * chamada já faz.
 *
 * Este arquivo é o contrato e a chamada. Quem decide QUANDO analisar, e se vale
 * o gasto, é `src/jobs/esports-analyst.ts`. Quem fala com o fornecedor é
 * `src/llm/` — aqui não há nada específico da Anthropic além da tabela de preço.
 */

const COMPONENT = 'esports_analyst';

/**
 * Teto de saída da chamada.
 *
 * Generoso para uma resposta de poucas centenas de tokens porque `max_tokens`
 * limita PENSAMENTO + texto juntos nos modelos atuais, e o pensamento está
 * ligado por padrão. Apertar aqui não economiza — trunca a resposta no meio e
 * perde a chamada inteira, que é o gasto sem o produto.
 */
const MAX_TOKENS = 8_000;

// ---------------------------------------------------------------------------
// Preço
// ---------------------------------------------------------------------------

interface ModelPrice {
  /** US$ por milhão de tokens. */
  input: number;
  output: number;
}

/**
 * Preço por modelo, em US$/MTok.
 *
 * Tabela no código e não em config de propósito: é fato do fornecedor, não
 * escolha do dono. O que é escolha — qual modelo usar — está em
 * `system_config.analyst_model`.
 *
 * **Modelo fora desta tabela não roda.** Sem preço não há como somar gasto, sem
 * soma não há teto, e um teto que não sabe contar é o mesmo que não ter teto —
 * com a agravante de parecer que tem.
 */
const MODEL_PRICING: Record<string, ModelPrice> = {
  'claude-opus-5': { input: 5, output: 25 },
  'claude-opus-4-8': { input: 5, output: 25 },
  'claude-sonnet-5': { input: 3, output: 15 },
  'claude-sonnet-4-6': { input: 3, output: 15 },
  'claude-haiku-4-5': { input: 1, output: 5 },
  'claude-fable-5': { input: 10, output: 50 },
};

export function knownModel(model: string): boolean {
  return model in MODEL_PRICING;
}

/**
 * Custo estimado da chamada. `null` para modelo sem preço conhecido.
 *
 * Leitura de cache custa ~0,1x a entrada; escrita de cache, ~1,25x. Hoje os dois
 * são zero — não usamos prompt caching, e não por esquecimento: o prompt estável
 * (o system) tem ~1k tokens e as chamadas são espaçadas por dezenas de minutos,
 * muito além do TTL de 5 min do cache. Toda chamada pagaria o prêmio de ESCRITA
 * e quase nenhuma leria. Os dois termos ficam na conta para o dia em que a
 * cadência mudar e a decisão for revista.
 */
export function estimateCostUsd(model: string, usage: TokenUsage): number | null {
  const price = MODEL_PRICING[model];
  if (price === undefined) return null;

  const perToken = (rate: number): number => rate / 1_000_000;

  const cost =
    usage.input * perToken(price.input) +
    usage.output * perToken(price.output) +
    usage.cacheRead * perToken(price.input) * 0.1 +
    usage.cacheWrite * perToken(price.input) * 1.25;

  // 6 casas: `cost_usd` é numeric(10,6) e uma análise custa centavos.
  return Math.round(cost * 1_000_000) / 1_000_000;
}

// ---------------------------------------------------------------------------
// Fingerprint
// ---------------------------------------------------------------------------

export interface FingerprintInput {
  fragmentId: number;
  asOf: string;
}

/**
 * Identidade do conjunto de fragmentos que entrou no prompt.
 *
 * Igual ao da análise anterior significa mesma entrada — e mesma entrada, mesmo
 * prompt e mesmo modelo dão a mesma resposta. A chamada seria dinheiro gasto
 * para reescrever a linha que já existe.
 *
 * Inclui `as_of` além do id porque a tabela é append-only: um fragmento nunca é
 * editado, mas o par (id, as_of) documenta na própria impressão digital a que
 * instante cada peça se referia. Ordenado por id para a impressão não depender
 * da ordem em que o banco devolveu as linhas.
 */
export function fingerprintFragments(fragments: readonly FingerprintInput[]): string {
  const canonical = [...fragments]
    .sort((a, b) => a.fragmentId - b.fragmentId)
    .map(f => `${f.fragmentId}:${f.asOf}`)
    .join('|');

  return createHash('sha256').update(canonical).digest('hex').slice(0, 32);
}

// ---------------------------------------------------------------------------
// O contrato de saída, e sua validação
// ---------------------------------------------------------------------------

export interface AnalysisClaim {
  claim: string;
  /** Rótulo do fragmento: `F1`, `F2`, ... */
  fragment: string;
}

export interface AnalysisOutput {
  abstain: boolean;
  abstainReason: string | null;
  probability: number | null;
  confidence: number | null;
  thesis: string | null;
  claims: AnalysisClaim[];
}

export type AnalystFailureCode =
  | 'not_json'
  | 'schema'
  | 'probability_range'
  | 'confidence_range'
  | 'missing_thesis'
  | 'no_claims'
  | 'unknown_fragment'
  | 'refusal'
  | 'truncated'
  | 'no_text'
  | 'unknown_model'
  | 'unknown_prompt'
  | 'api_error';

export class AnalystError extends Error {
  constructor(
    readonly code: AnalystFailureCode,
    message: string,
  ) {
    super(message);
    this.name = 'AnalystError';
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

/**
 * Valida a resposta e falha ALTO. Nunca devolve algo pela metade.
 *
 * Não é redundante com o structured output da API. A API garante a FORMA — as
 * chaves existem, os tipos batem, nada sobra. O que ela não garante:
 *
 *   - **Faixa numérica.** `minimum`/`maximum` não são suportados em structured
 *     outputs; o SDK remove essas restrições do schema antes de enviar. Uma
 *     probabilidade de 1.4 passa pela API e só morre aqui.
 *   - **Coerência entre campos.** "não me abstive" com tese nula é forma válida
 *     e conteúdo sem sentido.
 *   - **Citação existente.** Um rótulo que não foi entregue no prompt é uma
 *     citação inventada — o defeito exato que a rastreabilidade existe para
 *     medir. Gravar seria envenenar o dataset com a própria coisa que ele mede.
 *
 * Cada uma dessas falhas custa uma chamada paga e não gravada. É o preço
 * combinado: melhor perder o gasto que gravar linha ruim, porque o gasto é de
 * centavos e a linha ruim contamina todo backtest que a ler depois.
 */
export function parseAnalysis(raw: unknown, knownLabels: ReadonlySet<string>): AnalysisOutput {
  const record = asRecord(raw);
  if (record === null) throw new AnalystError('schema', 'resposta não é um objeto');

  const abstain = record['abstain'];
  if (typeof abstain !== 'boolean') {
    throw new AnalystError('schema', `abstain não é booleano: ${JSON.stringify(abstain)}`);
  }

  const claims = readClaims(record['claims'], knownLabels);

  if (abstain) {
    const reason = nonEmptyString(record['abstain_reason']);
    if (reason === null) {
      throw new AnalystError('schema', 'abstain = true sem abstain_reason');
    }
    // Abstenção com claims é aceitável — o modelo pode citar o que faltou. O que
    // não pode é vir com probabilidade: abster-se e opinar ao mesmo tempo não é
    // uma resposta, são duas.
    return {
      abstain: true,
      abstainReason: reason,
      probability: null,
      confidence: null,
      thesis: null,
      claims,
    };
  }

  const probability = record['probability'];
  if (typeof probability !== 'number' || !Number.isFinite(probability)) {
    throw new AnalystError('schema', `probability não é número: ${JSON.stringify(probability)}`);
  }
  if (probability < 0 || probability > 1) {
    throw new AnalystError('probability_range', `probability fora de [0,1]: ${probability}`);
  }

  const confidence = record['confidence'];
  if (typeof confidence !== 'number' || !Number.isFinite(confidence)) {
    throw new AnalystError('schema', `confidence não é número: ${JSON.stringify(confidence)}`);
  }
  if (confidence < 0 || confidence > 1) {
    throw new AnalystError('confidence_range', `confidence fora de [0,1]: ${confidence}`);
  }

  const thesis = nonEmptyString(record['thesis']);
  if (thesis === null) throw new AnalystError('missing_thesis', 'tese vazia sem abstenção');

  // Tese sem nenhuma afirmação rastreável derrota o propósito da camada inteira:
  // seria um número com uma história, e a história é justamente o que se quer
  // conferir depois.
  if (claims.length === 0) {
    throw new AnalystError('no_claims', 'tese sem nenhuma afirmação rastreável');
  }

  return { abstain: false, abstainReason: null, probability, confidence, thesis, claims };
}

function readClaims(raw: unknown, knownLabels: ReadonlySet<string>): AnalysisClaim[] {
  if (!Array.isArray(raw)) throw new AnalystError('schema', 'claims não é lista');

  const claims: AnalysisClaim[] = [];
  for (const entry of raw) {
    const record = asRecord(entry);
    if (record === null) throw new AnalystError('schema', 'claim não é objeto');

    const claim = nonEmptyString(record['claim']);
    const fragment = nonEmptyString(record['fragment']);
    if (claim === null || fragment === null) {
      throw new AnalystError('schema', `claim incompleta: ${JSON.stringify(entry)}`);
    }
    if (!knownLabels.has(fragment)) {
      throw new AnalystError(
        'unknown_fragment',
        `claim cita fragmento inexistente: ${fragment} (recebidos: ${[...knownLabels].join(', ')})`,
      );
    }

    claims.push({ claim, fragment });
  }

  return claims;
}

// ---------------------------------------------------------------------------
// A chamada
// ---------------------------------------------------------------------------

export interface AnalysisRequest {
  model: string;
  promptVersion: string;
  effort: string;
  timeoutMs: number;
  input: PromptInput;
  /**
   * O cliente do modelo. Omitido, usa a Anthropic.
   *
   * Existe para o teste poder exercer esta função sem rede — não para escolher
   * fornecedor em produção. Essa escolha, quando houver duas, é de configuração
   * e vai nascer em `system_config`, junto com `analyst_model`.
   */
  client?: LlmClient;
}

export interface AnalysisResult {
  output: AnalysisOutput;
  usage: TokenUsage;
  costUsd: number | null;
  latencyMs: number;
  /** O que foi de fato enviado — útil para depurar uma resposta estranha. */
  prompt: BuiltPrompt;
}

/**
 * Uma chamada, um prazo, nenhum retry — ver `src/llm/anthropic.ts` para o porquê
 * de não retentar.
 *
 * O que se perde com isso: um 429 ou um 500 transitório derruba esta análise. É
 * aceitável, e não por resignação — o checkpoint É um instante. Retentá-lo
 * depois produziria uma análise rotulada "T-6h" feita com o que se sabia em
 * T-5h, que é exatamente a mentira que o `as_of` existe para impedir. A perda
 * fica visível como linha ausente.
 */
export async function runAnalysis(request: AnalysisRequest): Promise<AnalysisResult> {
  if (!knownModel(request.model)) {
    throw new AnalystError(
      'unknown_model',
      `modelo sem preço conhecido: ${request.model} — sem preço não há teto de gasto`,
    );
  }

  const build = getPrompt(request.promptVersion);
  if (build === null) {
    throw new AnalystError(
      'unknown_prompt',
      `versão de prompt desconhecida: ${request.promptVersion}`,
    );
  }

  const prompt = build(request.input);
  const labels = new Set(request.input.fragments.map(f => f.label));
  const startedAt = Date.now();

  let completion: CompletionResult;
  try {
    completion = await (request.client ?? anthropicClient).complete({
      model: request.model,
      system: prompt.system,
      user: prompt.user,
      schema: ANALYSIS_SCHEMA as unknown as Record<string, unknown>,
      effort: request.effort,
      maxTokens: MAX_TOKENS,
      timeoutMs: request.timeoutMs,
    });
  } catch (err) {
    throw new AnalystError('api_error', err instanceof Error ? err.message : String(err));
  }

  const latencyMs = Date.now() - startedAt;

  // Recusa e truncagem antes de qualquer leitura do texto: as duas custam a
  // chamada e nenhuma delas é uma resposta. Colapsá-las em "veio vazio"
  // esconderia que uma não adianta retentar e a outra pede teto maior.
  if (completion.stop === 'refusal') {
    throw new AnalystError('refusal', 'a chamada foi recusada pelos classificadores');
  }
  if (completion.stop === 'truncated') {
    throw new AnalystError('truncated', `resposta truncada em max_tokens (${MAX_TOKENS})`);
  }
  if (completion.text === null) {
    throw new AnalystError('no_text', 'resposta sem bloco de texto');
  }

  let raw: unknown;
  try {
    raw = JSON.parse(completion.text);
  } catch (err) {
    throw new AnalystError('not_json', `resposta não é JSON: ${String(err)}`);
  }

  const output = parseAnalysis(raw, labels);
  const usage = completion.usage;

  return {
    output,
    usage,
    costUsd: estimateCostUsd(request.model, usage),
    latencyMs,
    prompt,
  };
}

export { COMPONENT as ANALYST_COMPONENT };
export type { PromptFragment, PromptInput };
// Reexportado: `TokenUsage` é o tipo de `estimateCostUsd`, e quem usa a conta
// não precisa saber que ela nasce em `src/llm/`.
export type { TokenUsage };
