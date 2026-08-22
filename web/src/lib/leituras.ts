import type { LeituraRegra } from './tipos';

/**
 * O mesmo texto de regra é lido N vezes pelo modelo (`leitura_n`). As N leituras
 * discordam entre si — e a discordância é o dado, não o ruído.
 *
 * Duas decisões, e as duas são de FATO, não de juízo:
 *
 * 1. **Qual leitura exibir**: a de maior `leitura_n` daquele mercado. Escolha
 *    determinística. Não é média (média de texto não existe), não é união
 *    (que fabricaria uma leitura que nenhuma leitura disse), não é "a melhor"
 *    (isso seria o sistema julgando).
 *
 * 2. **Se elas divergem**: comparação de texto, normalizada como o `achado_id`
 *    normaliza (`lower`, `btrim`, `\s+` → espaço). Divergência em "resolve SIM
 *    se" sobre a mesma regra é sinal de que a regra é ambígua — que é
 *    exatamente o que se quer saber na hora de decidir.
 */

/** A mesma normalização que `20260817040920_...sql:174` usa antes do md5. */
export function normalizar(s: string): string {
  return s.trim().replace(/\s+/g, ' ').toLowerCase();
}

export const CAMPOS = [
  { chave: 'resolve_sim', rotulo: 'Resolve SIM se' },
  { chave: 'resolve_nao', rotulo: 'Resolve NÃO se' },
  { chave: 'fonte', rotulo: 'Fonte' },
  { chave: 'prazo', rotulo: 'Prazo' },
  { chave: 'anula_se', rotulo: 'Anula se' },
] as const;

export type CampoRegra = (typeof CAMPOS)[number]['chave'];

/** O valor de um campo como lista, para os campos que são `text[]` e os que não são. */
export function valores(leitura: LeituraRegra, campo: CampoRegra): string[] {
  const bruto = leitura[campo];
  if (bruto === null || bruto === undefined) return [];
  return Array.isArray(bruto) ? bruto : [bruto];
}

/** A leitura exibida: maior `leitura_n`. `null` se não há leitura nenhuma. */
export function leituraExibida(leituras: LeituraRegra[]): LeituraRegra | null {
  if (leituras.length === 0) return null;
  return leituras.reduce((a, b) => (b.leitura_n > a.leitura_n ? b : a));
}

/**
 * As leituras divergem neste campo?
 *
 * Compara como CONJUNTO de itens normalizados: ordem diferente não é
 * divergência (a lista não é ordenada por nada), item a mais ou texto diferente
 * é. Campo nulo numa leitura e preenchido em outra também é — "a regra não
 * nomeia fonte" contra "a fonte é X" é a divergência mais importante que existe.
 */
export function divergem(leituras: LeituraRegra[], campo: CampoRegra): boolean {
  if (leituras.length < 2) return false;
  const assinaturas = leituras.map(l => {
    const itens = valores(l, campo).map(normalizar).filter(Boolean);
    return [...new Set(itens)].sort().join(' ⁞ ');
  });
  return new Set(assinaturas).size > 1;
}

/** Em quantos campos as leituras divergem. Para o selo do topo. */
export function camposDivergentes(leituras: LeituraRegra[]): CampoRegra[] {
  return CAMPOS.map(c => c.chave).filter(c => divergem(leituras, c));
}
