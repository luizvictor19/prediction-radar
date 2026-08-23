/**
 * Onde a citação de um achado aparece — e o invariante que garante que ela
 * aparece.
 *
 * **O trecho de um achado aparece EXATAMENTE uma vez:** à direita quando está
 * destacado dentro do regulamento, à esquerda quando não está. Nunca nos dois,
 * nunca em nenhum.
 *
 * A tela quebrou os dois lados, em momentos diferentes:
 *
 * - Antes das duas colunas, o trecho saía recortado no item E destacado no
 *   regulamento. Duplicação — o que a coluna direita foi feita para acabar.
 * - Depois, o recorte saiu do item para TODO achado, mas só armadilha é
 *   destacada. Ambiguidade acusada, boilerplate e herdado não-contradição
 *   passaram a não mostrar citação em lugar nenhum.
 *
 * O segundo é pior, e é a razão de isto virar função com teste em vez de regra
 * na cabeça de quem escreve o componente: **repetição incomoda, ausência
 * engana**. Um leitor que vê o mesmo trecho duas vezes percebe; um leitor que
 * não vê nenhuma conclui que o achado não tem âncora.
 */

/** O que a decisão lê: a citação, e nada além dela. */
export type Evidenciavel = {
  achado_id: string;
  trecho: string | null;
};

/**
 * A coluna esquerda mostra o trecho deste achado?
 *
 * `destacados` é o conjunto dos achados REALMENTE marcados dentro do
 * regulamento — os ids que saíram nos segmentos de `destacar`, não os que
 * foram pedidos. A diferença importa: uma armadilha cujo trecho não casou no
 * texto volta em `naoLocalizados` e não é marcada em lugar nenhum, então a
 * citação dela tem que voltar para o item. Passar a lista PEDIDA aqui faria
 * exatamente o "nunca em nenhum" que este arquivo existe para impedir, e no
 * caso mais difícil de notar.
 *
 * Sem trecho não há o que mostrar, e isso não viola o invariante: é ausência de
 * conteúdo, não de evidência.
 */
export function mostraTrechoNaEsquerda(
  achado: Evidenciavel,
  destacados: ReadonlySet<string>,
): boolean {
  if (achado.trecho === null || achado.trecho.trim() === '') return false;
  return !destacados.has(achado.achado_id);
}
