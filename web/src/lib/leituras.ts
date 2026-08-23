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

// ---------------------------------------------------------------------------
// O selo de confirmação
// ---------------------------------------------------------------------------

/**
 * Quantas leituras um texto precisa ter para o selo `k/n` significar alguma
 * coisa. Mesmo número de `scripts/nivelar-leituras.ts` (`MINIMO_PADRAO`), e pela
 * mesma razão.
 */
export const MINIMO_LEITURAS = 3;

export interface Selo {
  /** O selo pode ser lido como concordância entre leituras? */
  comparavel: boolean;
  texto: string;
}

/** "1 leitura" / "2 leituras" — o rótulo do que não dá para comparar. */
function naoComparavel(leituras: number): Selo {
  const plural = leituras === 1 ? 'leitura' : 'leituras';
  return { comparavel: false, texto: `${leituras} ${plural} — não comparável` };
}

/**
 * O selo de um achado: quantas leituras daquele texto o apontaram.
 *
 * Abaixo de `MINIMO_LEITURAS` a fração NÃO é exibida, e a razão é que ela
 * mentiria pela forma. Com duas leituras, um achado que aparece numa e não na
 * outra fica 1/2 — empate, sem maioria. Com uma leitura, `1/1` não é
 * concordância: é não medido, escrito com a mesma tipografia de um `3/3` que foi
 * medido três vezes.
 *
 * O olho compara `1/1` com `2/3` e conclui "o primeiro é mais confirmado". Não
 * é. Por isso o gate troca a forma inteira em vez de acrescentar um asterisco:
 * o que não é comparável não pode parecer comparável.
 */
export function seloDeConfirmacao(vezesEncontrado: number, leiturasDoTexto: number): Selo {
  if (leiturasDoTexto < MINIMO_LEITURAS) return naoComparavel(leiturasDoTexto);
  return { comparavel: true, texto: `${vezesEncontrado}/${leiturasDoTexto}` };
}

/**
 * O selo de cobertura de um mercado na lista.
 *
 * `null` quando não há o que avisar — mercado sem digestão (que a linha já diz
 * por outro caminho) ou textos todos no mínimo. Selo em toda linha vira ruído e
 * para de ser lido.
 *
 * Com mais de um texto manda o PIOR: a linha é uma só, e anunciar "3 leituras"
 * num mercado que tem um texto medido uma vez esconderia justamente o texto
 * fraco.
 */
export function seloDeCobertura(leiturasPorTexto: readonly number[]): Selo | null {
  if (leiturasPorTexto.length === 0) return null;

  const pior = Math.min(...leiturasPorTexto);
  return pior < MINIMO_LEITURAS ? naoComparavel(pior) : null;
}

/**
 * A procedência da leitura exibida, com o escopo de CADA número dito em voz
 * alta.
 *
 * A faixa do veredito mostrava `12/12` ao lado de `1 leitura`, e os dois
 * denominadores são de coisas diferentes: o selo conta leituras do TEXTO — que
 * é onde a concordância existe, porque o mesmo regulamento é lido por vários
 * mercados — e a linha contava leituras DESTE mercado. Lado a lado e sem
 * rótulo, isso lê como contradição, e o leitor não tem como saber qual dos dois
 * números confiar.
 *
 * Os dois ficam, porque medem coisas que importam separadamente: a
 * concordância é do texto, e a assinatura do modelo é da leitura que preencheu
 * os campos desta tela. Unificar o denominador perderia um dos dois.
 *
 * Quando o texto só foi lido por este mercado, os números coincidem e a frase
 * diz um só — repetir `1 deste mercado, 1 do texto` é ruído que sugere
 * distinção onde não há.
 */
export function procedencia(doMercado: number, doTexto: number): string {
  const plural = (n: number) => (n === 1 ? 'leitura' : 'leituras');
  if (doMercado === doTexto) return `${doTexto} ${plural(doTexto)} do texto`;
  return `${doMercado} ${plural(doMercado)} deste mercado, ${doTexto} do texto`;
}
