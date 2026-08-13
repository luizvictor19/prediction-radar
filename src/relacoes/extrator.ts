import { anthropicClient } from '../llm/anthropic.js';
import type { CompletionResult, LlmClient, TokenUsage } from '../llm/client.js';
import {
  RELACOES_SCHEMA,
  obterPrompt,
  type EntradaDoPrompt,
  type PromptMontado,
} from './prompts.js';
import { ARIDADE, ehTipoDeRelacao, type Relacao } from './taxonomia.js';

/**
 * O extrator de relações lógicas (spec 003, Parte D).
 *
 * Mora em `src/relacoes/` e não em `scripts/` porque tem dois consumidores: o
 * runner que gasta dinheiro (`scripts/extrair-relacoes.ts`) e o harness que
 * confere (`scripts/medir-relacoes.ts`) — mesma relação que `analyst.ts` tem com
 * `src/jobs/`. Contrato e chamada aqui; QUANDO chamar e se vale o gasto, lá.
 *
 * Topologia single agent, um grupo por chamada. É a decisão de custo da fase 1:
 * doze perguntas numa chamada em vez de 66 pares em 66 chamadas.
 */

/**
 * Teto de saída da chamada.
 *
 * Generoso porque `max_tokens` limita PENSAMENTO + texto juntos e o pensamento
 * está ligado por padrão. Apertar não economiza: trunca no meio e perde a
 * chamada inteira, que é o gasto sem o produto. Um grupo de 12 mercados são 66
 * pares a considerar, e o raciocínio é o termo que domina.
 */
const MAX_TOKENS = 16_000;

// ---------------------------------------------------------------------------
// Preço
// ---------------------------------------------------------------------------

interface PrecoDoModelo {
  /** US$ por milhão de tokens. */
  entrada: number;
  saida: number;
}

/**
 * Preço por modelo, em US$/MTok. Espelha `MODEL_PRICING` de `analyst.ts`.
 *
 * Duplicado, e de propósito: `analyst.ts` está em `src/verticals/`, que esta
 * frente não toca. Compartilhar a tabela exigiria mover o arquivo de lá, que é
 * mudança em código de produção medido, por conveniência de uma medição. A
 * duplicação é de seis linhas de fato do fornecedor e some quando as duas
 * frentes convergirem.
 *
 * **Modelo fora desta tabela não roda.** Sem preço não há como somar gasto, sem
 * soma não há teto, e um teto que não sabe contar é o mesmo que não ter teto —
 * com a agravante de parecer que tem.
 */
const PRECOS: Record<string, PrecoDoModelo> = {
  'claude-opus-5': { entrada: 5, saida: 25 },
  'claude-opus-4-8': { entrada: 5, saida: 25 },
  'claude-sonnet-5': { entrada: 3, saida: 15 },
  'claude-sonnet-4-6': { entrada: 3, saida: 15 },
  'claude-haiku-4-5': { entrada: 1, saida: 5 },
  'claude-fable-5': { entrada: 10, saida: 50 },
};

export function modeloConhecido(modelo: string): boolean {
  return modelo in PRECOS;
}

export function modelosComPreco(): string[] {
  return Object.keys(PRECOS).sort();
}

export function estimarCustoUsd(modelo: string, uso: TokenUsage): number | null {
  const preco = PRECOS[modelo];
  if (preco === undefined) return null;

  const porToken = (taxa: number): number => taxa / 1_000_000;
  const custo =
    uso.input * porToken(preco.entrada) +
    uso.output * porToken(preco.saida) +
    uso.cacheRead * porToken(preco.entrada) * 0.1 +
    uso.cacheWrite * porToken(preco.entrada) * 1.25;

  return Math.round(custo * 1_000_000) / 1_000_000;
}

// ---------------------------------------------------------------------------
// Falhas
// ---------------------------------------------------------------------------

export type CodigoDeFalha =
  | 'not_json'
  | 'schema'
  | 'tipo_invalido'
  | 'aridade'
  | 'rotulo_desconhecido'
  | 'rotulo_repetido'
  | 'confianca_fora_de_faixa'
  | 'justificativa_vazia'
  | 'refusal'
  | 'truncated'
  | 'no_text'
  | 'modelo_desconhecido'
  | 'prompt_desconhecido'
  | 'api_error';

export class ExtratorError extends Error {
  constructor(
    readonly code: CodigoDeFalha,
    message: string,
  ) {
    super(message);
    this.name = 'ExtratorError';
  }
}

function comoRegistro(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function textoNaoVazio(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

// ---------------------------------------------------------------------------
// A validação
// ---------------------------------------------------------------------------

/**
 * Valida a resposta e falha ALTO. Nunca devolve algo pela metade.
 *
 * **Uma entrada ruim invalida a resposta INTEIRA**, não só aquela relação. É a
 * regra do `parseAnalysis` que segurou 584/584 de fidelidade no analista, e o
 * motivo é o mesmo: um grupo em que o modelo citou `M9` num conjunto de quatro é
 * um grupo em que ele perdeu a conta dos rótulos, e as outras entradas dele não
 * merecem mais confiança que a errada. Salvar as "boas" seria escolher no que
 * acreditar depois de saber que houve invenção.
 *
 * Custa uma chamada paga e não gravada. É o preço combinado: o gasto é de
 * centavos e a linha ruim contamina toda medição que a ler depois — e nesta fase
 * a medição É o produto.
 */
export function parseRelacoes(bruto: unknown, rotulosConhecidos: ReadonlySet<string>): Relacao[] {
  const registro = comoRegistro(bruto);
  if (registro === null) throw new ExtratorError('schema', 'resposta não é um objeto');

  const lista = registro['relacoes'];
  if (!Array.isArray(lista)) {
    throw new ExtratorError('schema', `relacoes não é lista: ${JSON.stringify(lista)}`);
  }

  const relacoes: Relacao[] = [];
  for (const entrada of lista) {
    relacoes.push(lerRelacao(entrada, rotulosConhecidos));
  }
  return relacoes;
}

function lerRelacao(bruto: unknown, rotulosConhecidos: ReadonlySet<string>): Relacao {
  const registro = comoRegistro(bruto);
  if (registro === null) throw new ExtratorError('schema', 'relação não é objeto');

  const tipo = registro['tipo'];
  if (!ehTipoDeRelacao(tipo)) {
    throw new ExtratorError('tipo_invalido', `tipo fora da lista fechada: ${JSON.stringify(tipo)}`);
  }

  const mercados = registro['mercados'];
  if (!Array.isArray(mercados) || mercados.some((m) => typeof m !== 'string')) {
    throw new ExtratorError('schema', `mercados não é lista de string: ${JSON.stringify(mercados)}`);
  }
  const rotulos = (mercados as string[]).map((m) => m.trim());

  // Rótulo inexistente é citação inventada — o defeito exato que a validação
  // existe para pegar. Gravar seria envenenar a medição com a própria coisa que
  // ela mede.
  for (const rotulo of rotulos) {
    if (!rotulosConhecidos.has(rotulo)) {
      throw new ExtratorError(
        'rotulo_desconhecido',
        `relação cita rótulo inexistente: ${rotulo} (entregues: ${[...rotulosConhecidos].join(', ')})`,
      );
    }
  }

  // Rótulo repetido dentro da mesma relação: "M1 implica M1" é forma válida e
  // conteúdo vazio, e passaria pela conferência de desfecho como compatível
  // sempre — um acerto de graça que inflaria a precisão.
  if (new Set(rotulos).size !== rotulos.length) {
    throw new ExtratorError('rotulo_repetido', `relação com rótulo repetido: ${rotulos.join(', ')}`);
  }

  const aridade = ARIDADE[tipo];
  if (rotulos.length < aridade.min || (aridade.max !== null && rotulos.length > aridade.max)) {
    const esperado = aridade.max === null ? `>= ${aridade.min}` : `${aridade.min}`;
    throw new ExtratorError(
      'aridade',
      `${tipo} exige ${esperado} mercados, veio ${rotulos.length}: ${rotulos.join(', ')}`,
    );
  }

  const confianca = registro['confianca'];
  if (typeof confianca !== 'number' || !Number.isFinite(confianca)) {
    throw new ExtratorError('schema', `confianca não é número: ${JSON.stringify(confianca)}`);
  }
  if (confianca < 0 || confianca > 1) {
    throw new ExtratorError('confianca_fora_de_faixa', `confianca fora de [0,1]: ${confianca}`);
  }

  // Relação sem justificativa é um veredito sem o que conferir, e a conferência
  // humana da Parte G é o produto desta spec.
  const justificativa = textoNaoVazio(registro['justificativa']);
  if (justificativa === null) {
    throw new ExtratorError('justificativa_vazia', `relação ${tipo} sem justificativa`);
  }

  // A ressalva é o único campo em que `null` é resposta e não omissão — ver o
  // system prompt. String vazia vira `null` porque o modelo às vezes preenche
  // com "" em vez de null, e as duas dizem a mesma coisa.
  const ressalva = textoNaoVazio(registro['ressalva_de_resolucao']);

  return { tipo, mercados: rotulos, confianca, justificativa, ressalvaDeResolucao: ressalva };
}

// ---------------------------------------------------------------------------
// A chamada
// ---------------------------------------------------------------------------

export interface PedidoDeExtracao {
  modelo: string;
  versaoDePrompt: string;
  esforco: string;
  timeoutMs: number;
  entrada: EntradaDoPrompt;
  /**
   * O cliente do modelo. Omitido, usa a Anthropic.
   *
   * Existe para o teste exercer esta função sem rede — não para escolher
   * fornecedor em produção.
   */
  client?: LlmClient;
}

export interface ResultadoDaExtracao {
  relacoes: Relacao[];
  uso: TokenUsage;
  custoUsd: number | null;
  latenciaMs: number;
  /** O que foi de fato enviado — útil para depurar uma resposta estranha. */
  prompt: PromptMontado;
}

/**
 * Uma chamada, um prazo, nenhum retry — ver `src/llm/anthropic.ts` para o porquê.
 *
 * Aqui o que se perde com um 429 é MENOS grave que no analista: relação lógica
 * não tem data (Parte F), então o grupo que falhou pode ser rodado de novo
 * amanhã sem mentir sobre quando foi lido. A retomada da fila cuida disso — o
 * grupo simplesmente não recebe registro e volta a entrar na próxima rodada.
 */
export async function extrairRelacoes(pedido: PedidoDeExtracao): Promise<ResultadoDaExtracao> {
  if (!modeloConhecido(pedido.modelo)) {
    throw new ExtratorError(
      'modelo_desconhecido',
      `modelo sem preço conhecido: ${pedido.modelo} — sem preço não há teto de gasto`,
    );
  }

  const construir = obterPrompt(pedido.versaoDePrompt);
  if (construir === null) {
    throw new ExtratorError(
      'prompt_desconhecido',
      `versão de prompt desconhecida: ${pedido.versaoDePrompt}`,
    );
  }

  const prompt = construir(pedido.entrada);
  const rotulos = new Set(pedido.entrada.mercados.map((m) => m.rotulo));
  const comecou = Date.now();

  let completion: CompletionResult;
  try {
    completion = await (pedido.client ?? anthropicClient).complete({
      model: pedido.modelo,
      system: prompt.system,
      user: prompt.user,
      schema: RELACOES_SCHEMA as unknown as Record<string, unknown>,
      effort: pedido.esforco,
      maxTokens: MAX_TOKENS,
      timeoutMs: pedido.timeoutMs,
    });
  } catch (err) {
    throw new ExtratorError('api_error', err instanceof Error ? err.message : String(err));
  }

  const latenciaMs = Date.now() - comecou;

  // Recusa e truncagem antes de ler o texto: as duas custam a chamada e nenhuma
  // é resposta. Colapsá-las em "veio vazio" esconderia que uma não adianta
  // retentar e a outra pede teto maior.
  if (completion.stop === 'refusal') {
    throw new ExtratorError('refusal', 'a chamada foi recusada pelos classificadores');
  }
  if (completion.stop === 'truncated') {
    throw new ExtratorError('truncated', `resposta truncada em max_tokens (${MAX_TOKENS})`);
  }
  if (completion.text === null) {
    throw new ExtratorError('no_text', 'resposta sem bloco de texto');
  }

  let bruto: unknown;
  try {
    bruto = JSON.parse(completion.text);
  } catch (err) {
    throw new ExtratorError('not_json', `resposta não é JSON: ${String(err)}`);
  }

  return {
    relacoes: parseRelacoes(bruto, rotulos),
    uso: completion.usage,
    custoUsd: estimarCustoUsd(pedido.modelo, completion.usage),
    latenciaMs,
    prompt,
  };
}

export type { TokenUsage };
