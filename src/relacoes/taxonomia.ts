/**
 * A taxonomia fechada da Parte B, e as regras de forma que ela impõe.
 *
 * Fica em arquivo próprio porque três consumidores precisam dela e nenhum deles
 * deve ser dono: o prompt (que a apresenta ao modelo), o extrator (que valida a
 * resposta) e o gabarito (que confere contra o desfecho). Se a lista morasse num
 * deles, os outros dois importariam a peça errada — e o dia em que um tipo novo
 * entrasse, algum dos três ficaria para trás em silêncio.
 *
 * A escolha central: o tipo carrega ARIDADE e ORDEM, não só nome. `implica` com
 * três mercados não é uma relação com um extra — é uma resposta que ninguém sabe
 * ler. E `implica [A,B]` é diferente de `implica [B,A]`; sem ordem declarada, a
 * conferência contra o desfecho vira sorteio.
 */

export const TIPOS_DE_RELACAO = [
  'implica',
  'exclui',
  'particiona',
  'equivale',
  'conjuncao',
  'nenhuma',
] as const;

export type TipoRelacao = (typeof TIPOS_DE_RELACAO)[number];

export interface Relacao {
  tipo: TipoRelacao;
  /**
   * Os mercados envolvidos, por rótulo (`M1`, `M2`, ...), e a ORDEM importa:
   *
   *   `implica`   [A, B]     — A só acontece se B acontecer
   *   `conjuncao` [C, A, B]  — C é "A e B"
   *
   * Nos outros tipos a ordem é indiferente, mas continua sendo registrada como
   * veio: reordenar aqui apagaria a informação de como o modelo apresentou a
   * relação, que é o que se lê ao conferir uma justificativa à mão.
   */
  mercados: string[];
  confianca: number;
  justificativa: string;
  /**
   * `null` significa "li as regras de resolução das duas pontas e não vi
   * diferença" — nunca "não olhei". A distinção está escrita no prompt, e é o
   * que separa o campo de um enfeite.
   */
  ressalvaDeResolucao: string | null;
}

/** Quantos mercados cada tipo exige. `null` no máximo = sem teto. */
export const ARIDADE: Record<TipoRelacao, { min: number; max: number | null }> = {
  implica: { min: 2, max: 2 },
  exclui: { min: 2, max: 2 },
  // A partição é a única de aridade aberta: um evento neg-risk de 30 saídas é
  // uma partição de 30, e limitá-la a dois destruiria justamente o tipo que a
  // API já entrega pronto.
  particiona: { min: 2, max: null },
  equivale: { min: 2, max: 2 },
  conjuncao: { min: 3, max: 3 },
  nenhuma: { min: 2, max: 2 },
};

export function ehTipoDeRelacao(value: unknown): value is TipoRelacao {
  return typeof value === 'string' && (TIPOS_DE_RELACAO as readonly string[]).includes(value);
}

/**
 * Os tipos que dizem alguma coisa. `nenhuma` não é uma relação — é a declaração
 * de que não há uma, e ela nunca entra em taxa de refutação nem em precisão.
 */
export function ehRelacaoAfirmativa(tipo: TipoRelacao): boolean {
  return tipo !== 'nenhuma';
}
