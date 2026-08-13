import type { Relacao, TipoRelacao } from './taxonomia.js';

/**
 * O gabarito: o que o desfecho de um mercado resolvido é, e o que ele refuta.
 *
 * **Nada deste arquivo pode chegar ao prompt.** O desfecho é do corretor, não do
 * aluno: se ele vazar, o modelo deduz a relação do resultado em vez de ler as
 * perguntas, e a precisão medida vira ficção. É por isso que o desfecho mora
 * aqui e não em `prompts.ts`, e por isso `prompts.ts` não importa este módulo —
 * a separação é a defesa, e `extrator.test.ts` tem um teste com sentinela que
 * falha se ela cair.
 *
 * ## O que é "SIM" num mercado que não é sim/não
 *
 * A pergunta que quase matou o gabarito: dos 80 mercados resolvidos do snapshot,
 * só 9 têm `outcomes: ["Yes","No"]`. O resto é `["Over","Under"]` ou nome de
 * time. Exigir sim/não jogaria fora 89% do material.
 *
 * A saída é definir a proposição pelo PRIMEIRO desfecho listado:
 *
 *   **M é a afirmação "a pergunta de M resolve em `outcomes[0]`".**
 *
 * "Total Games O/U 4.5 → Over" é uma proposição perfeitamente formada, e é
 * exatamente entre proposições desse tipo que moram as `implica` que interessam
 * (Over 5.5 implica Over 4.5). `outcomes[0]` é definição do mercado, existe
 * antes de resolver e VAI para o prompt; `outcomePrices` é o desfecho e NÃO vai.
 *
 * Conferido antes de adotar: em 80 mercados resolvidos, `outcomes[0]` venceu 22
 * vezes e perdeu 58. A ordem da lista não é o vencedor, então a convenção não
 * embute a resposta.
 */

export type Desfecho = 'sim' | 'nao';

/**
 * Lê o desfecho de um mercado resolvido, ou `null` quando ele não é legível.
 *
 * Estrito de propósito. Só conta como desfecho o par exato {"0","1"} sobre duas
 * saídas — mercado antigo devolve `["0","0"]`, que não é nem sim nem não, e
 * mercado multi-saída não tem proposição binária. Inventar leitura aqui seria
 * fabricar gabarito, e gabarito fabricado é pior que gabarito ausente: o
 * ausente aparece como "não testável" e o fabricado aparece como precisão.
 */
export function lerDesfecho(outcomes: readonly string[], precos: readonly string[]): Desfecho | null {
  if (outcomes.length !== 2 || precos.length !== 2) return null;

  const a = precos[0]?.trim();
  const b = precos[1]?.trim();
  if (a === '1' && b === '0') return 'sim';
  if (a === '0' && b === '1') return 'nao';
  return null;
}

// ---------------------------------------------------------------------------
// A conferência
// ---------------------------------------------------------------------------

/**
 * Três resultados, não dois.
 *
 * `compativel` NÃO é `correta`, e colapsar os dois seria a mentira central desta
 * medição. Duas perguntas sem relação nenhuma cujos desfechos calharam de não se
 * contradizer aparecem como compatíveis — `A implica B` com A=NÃO e B=NÃO passa
 * sem dizer nada. É por isso que o número que decide a spec é a taxa de
 * REFUTAÇÃO, que só sobe com violação objetiva, e por isso a amostra humana da
 * Parte G continua existindo.
 */
export type Veredito = 'refutada' | 'compativel' | 'nao_testavel';

export interface Conferencia {
  veredito: Veredito;
  /** Por que, em uma linha. Entra no relatório e no CSV de rotulagem. */
  motivo: string;
}

const NAO_TESTAVEL = (motivo: string): Conferencia => ({ veredito: 'nao_testavel', motivo });
const REFUTADA = (motivo: string): Conferencia => ({ veredito: 'refutada', motivo });
const COMPATIVEL = (motivo: string): Conferencia => ({ veredito: 'compativel', motivo });

/**
 * Confere uma relação proposta contra os desfechos observados.
 *
 * Objetivo e sem opinião: ou a restrição da Parte B foi violada ou não foi. O
 * único julgamento embutido é o de quando a restrição NÃO FOI EXERCIDA, e ele
 * está explícito em cada ramo — `A implica B` com A=NÃO não diz nada sobre a
 * relação, e contá-lo como acerto seria inflar a precisão com vácuo.
 */
export function conferirRelacao(
  relacao: Relacao,
  desfechos: ReadonlyMap<string, Desfecho>,
): Conferencia {
  if (relacao.tipo === 'nenhuma') {
    return NAO_TESTAVEL('`nenhuma` não afirma restrição; não há o que o desfecho possa violar');
  }

  const lidos: Desfecho[] = [];
  for (const rotulo of relacao.mercados) {
    const d = desfechos.get(rotulo);
    if (d === undefined) return NAO_TESTAVEL(`desfecho de ${rotulo} ilegível ou ausente`);
    lidos.push(d);
  }

  return CONFERENCIAS[relacao.tipo](relacao.mercados, lidos);
}

type Regra = (rotulos: readonly string[], desfechos: readonly Desfecho[]) => Conferencia;

const CONFERENCIAS: Record<Exclude<TipoRelacao, 'nenhuma'>, Regra> = {
  // A=SIM ⇒ B=SIM. Com A=NÃO a implicação é vacuamente verdadeira e o desfecho
  // não a testou — é o caso que mais enche a coluna de "não testável", e é
  // esperado: a maioria das proposições resolve em NÃO.
  implica: (r, d) => {
    const [a, b] = d as [Desfecho, Desfecho];
    const [ra, rb] = r as [string, string];
    if (a === 'nao') return NAO_TESTAVEL(`${ra}=NÃO: antecedente não disparou`);
    if (b === 'sim') return COMPATIVEL(`${ra}=SIM e ${rb}=SIM`);
    return REFUTADA(`${ra}=SIM mas ${rb}=NÃO`);
  },

  // Não podem acontecer juntos. Com os dois em NÃO a restrição não foi
  // exercida: nunca houve oportunidade de eles colidirem.
  exclui: (r, d) => {
    const [a, b] = d as [Desfecho, Desfecho];
    const [ra, rb] = r as [string, string];
    if (a === 'sim' && b === 'sim') return REFUTADA(`${ra}=SIM e ${rb}=SIM ao mesmo tempo`);
    if (a === 'nao' && b === 'nao') return NAO_TESTAVEL(`${ra}=NÃO e ${rb}=NÃO: nenhum disparou`);
    return COMPATIVEL(`exatamente um de ${ra}/${rb} deu SIM`);
  },

  // Exatamente um do conjunto. Sempre testável quando todos os desfechos são
  // legíveis — não existe configuração vácua aqui.
  particiona: (r, d) => {
    const sims = d.filter((x) => x === 'sim').length;
    if (sims === 1) return COMPATIVEL(`exatamente 1 SIM entre ${r.length} membros`);
    return REFUTADA(`${sims} SIM entre ${r.length} membros; a partição exige exatamente 1`);
  },

  // Mesmo evento, roupas diferentes. Sempre testável.
  equivale: (r, d) => {
    const [a, b] = d as [Desfecho, Desfecho];
    const [ra, rb] = r as [string, string];
    return a === b
      ? COMPATIVEL(`${ra} e ${rb} deram ${a.toUpperCase()}`)
      : REFUTADA(`${ra}=${a.toUpperCase()} e ${rb}=${b.toUpperCase()}`);
  },

  // C ⇔ A e B. Bicondicional, então sempre testável: tanto "C=SIM sem A e B"
  // quanto "A e B sem C" refutam.
  conjuncao: (r, d) => {
    const [c, a, b] = d as [Desfecho, Desfecho, Desfecho];
    const [rc, ra, rb] = r as [string, string, string];
    const esperado: Desfecho = a === 'sim' && b === 'sim' ? 'sim' : 'nao';
    return c === esperado
      ? COMPATIVEL(`${rc}=${c.toUpperCase()} bate com ${ra}=${a.toUpperCase()} e ${rb}=${b.toUpperCase()}`)
      : REFUTADA(
          `${rc}=${c.toUpperCase()} mas ${ra}=${a.toUpperCase()} e ${rb}=${b.toUpperCase()} pedem ${esperado.toUpperCase()}`,
        );
  },
};
