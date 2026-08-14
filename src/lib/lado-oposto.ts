/**
 * O lado oposto do livro, derivado por aritmética em vez de coletado.
 *
 * O coletor grava só o rótulo do outcome 0 — medido em 20260814: 27.204 linhas
 * em 24h, um rótulo só ('Yes'). Uma leg comprada no outro lado nunca casa por
 * rótulo, e por isso 61 de 61 legs registradas não achavam preço.
 *
 * Dobrar a coleta seria dobrar a linha/dia de uma série que a retenção não
 * apaga, para gravar um número que já é conhecido: em mercado de dois
 * resultados o outro lado sai por identidade.
 *
 *   mid_no = 1 - mid_yes
 *   bid_no = 1 - ask_yes
 *   ask_no = 1 - bid_yes
 *
 * ## O cruzamento não é detalhe
 *
 * `bid` e `ask` trocam de lugar. O melhor preço de COMPRA de um lado é o
 * espelho do melhor preço de VENDA do outro: quem paga 0,19 para comprar Yes
 * está disposto a vender No por 0,81. Copiar sem cruzar inverteria o spread —
 * `ask` ficaria abaixo de `bid` — e um livro invertido é lido por este projeto
 * como observação legítima (`triar` deixou de barrá-lo de propósito), então o
 * erro passaria sem alarme.
 *
 * ## O que NÃO dá para derivar: profundidade
 *
 * `bidDepth` e `askDepth` são o tamanho das ordens no topo do livro daquele
 * token. O livro do outro token é outro livro, com outras ordens: não existe
 * identidade que leve um no outro. Um número derivado ali pareceria
 * profundidade do outro lado e não seria — então sai NULO, e `origem` declara.
 *
 * Este módulo é a segunda escrita da regra que a `v_minhas_posicoes` implementa
 * em SQL. As duas existem porque a leg precisa do preço em dois momentos: na
 * tela (view) e no INSTANTE DO REGISTRO (aqui, via `register.ts`), e um preço
 * de entrada que não foi gravado não é recuperável depois.
 */

export interface Livro {
  mid: number | null;
  bid: number | null;
  ask: number | null;
  bidDepth: number | null;
  askDepth: number | null;
}

export type Origem = 'coletado' | 'derivado';

export interface LadoDaLeg extends Livro {
  /** `null` quando não há como responder pelo lado da leg. */
  origem: Origem | null;
}

const SEM_LADO: LadoDaLeg = {
  mid: null,
  bid: null,
  ask: null,
  bidDepth: null,
  askDepth: null,
  origem: null,
};

/**
 * Os rótulos possíveis do mercado, de `events.outcomes`.
 *
 * O campo é `{ prices: string[], values: string[] }` — medido em 20260814:
 * `values` tem 2 elementos em 138.497 de 138.497 events. A forma é conferida
 * mesmo assim, porque payload de API não é contrato e este projeto já foi
 * mordido por significado de campo três vezes.
 */
export function rotulosDoMercado(outcomes: unknown): string[] | null {
  if (outcomes === null || typeof outcomes !== 'object') return null;
  const values = (outcomes as { values?: unknown }).values;
  if (!Array.isArray(values)) return null;
  if (!values.every(v => typeof v === 'string')) return null;
  return values as string[];
}

/**
 * A derivação é permitida?
 *
 * Só quando o mercado tem exatamente DOIS resultados e os dois rótulos — o da
 * foto e o da leg — estão entre eles. Sem isso, uma leg com rótulo de time num
 * mercado Yes/No receberia `1 - mid`, que seria invenção pura.
 *
 * Dois resultados é o que torna a identidade válida: `p(A) + p(B) = 1` só vale
 * quando A e B esgotam o espaço. Num mercado de três, `1 - p(A)` é a soma dos
 * outros dois, não o preço de nenhum deles.
 */
export function podeDerivar(
  outcomes: unknown,
  rotuloColetado: string,
  rotuloDaLeg: string,
): boolean {
  if (rotuloColetado === rotuloDaLeg) return false;
  const rotulos = rotulosDoMercado(outcomes);
  if (rotulos === null || rotulos.length !== 2) return false;
  return rotulos.includes(rotuloColetado) && rotulos.includes(rotuloDaLeg);
}

/**
 * `1 - v`, no grão da coluna.
 *
 * O arredondamento para 4 casas não é cosmético: as colunas de preço são
 * `numeric(5,4)` e o Postgres calcula `1 - mid` em decimal exato, enquanto o
 * JavaScript devolve `1 - 0.18 = 0.8200000000000001`. Sem o arredondamento, o
 * `conferir-views.ts` acusaria divergência entre a view e este módulo em
 * praticamente toda linha derivada — um alarme falso que ensinaria a ignorar o
 * alarme.
 */
function complemento(v: number | null): number | null {
  return v === null ? null : Math.round((1 - v) * 10_000) / 10_000;
}

/**
 * O livro do outro lado. Profundidade sai nula porque não é derivável.
 *
 * Exportada separada de `ladoDaLeg` para poder ser testada como identidade
 * pura, sem passar por rótulo nenhum.
 */
export function derivarOposto(livro: Livro): Livro {
  return {
    mid: complemento(livro.mid),
    // Cruzado: o melhor bid de um lado é o espelho do melhor ask do outro.
    bid: complemento(livro.ask),
    ask: complemento(livro.bid),
    bidDepth: null,
    askDepth: null,
  };
}

/**
 * O livro do lado da leg: coletado quando o rótulo bate, derivado quando é o
 * outro lado de um mercado de dois, nulo quando nenhum dos dois.
 */
export function ladoDaLeg(
  livro: Livro,
  rotuloColetado: string,
  rotuloDaLeg: string,
  outcomes: unknown,
): LadoDaLeg {
  if (rotuloColetado === rotuloDaLeg) return { ...livro, origem: 'coletado' };
  if (podeDerivar(outcomes, rotuloColetado, rotuloDaLeg)) {
    return { ...derivarOposto(livro), origem: 'derivado' };
  }
  return SEM_LADO;
}
