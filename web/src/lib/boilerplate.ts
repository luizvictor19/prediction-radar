import { normalizarTrecho } from './dedup';
import type { Achado } from './tipos';

/**
 * O gate de boilerplate — seção 5 da spec da tela de Regra.
 *
 * `fonte_vaga` sobre `a consensus of credible reporting` e `fuso_ausente` sobre
 * `11:59 PM ET` aparecem em quase todo regulamento da Polymarket. São texto
 * padrão da plataforma, não característica deste mercado. Eles não somem — vão
 * para um grupo recolhido, com a frequência ao lado.
 *
 * A frequência é o produto, não o efeito colateral: saber que um defeito
 * `aparece em 47% dos 267 regulamentos lidos` transforma ruído em contexto.
 * Quem opera passa a saber que aquilo é padrão da casa.
 *
 * **Este gate não apaga nada, não altera contagem e não toca no banco.**
 */

/**
 * O corte, em fração dos textos de regra lidos.
 *
 * **20%, medido em 22/08/2026 por `npm run medir:tela-regra`.**
 *
 * O número não é escolha: é o meio de um vale. Sobre 267 textos, a distribuição
 * de `(tipo, trecho mascarado)` tem três pares acima de 30% — 47,2%, 42,3% e
 * 31,8% — e o quarto colocado despenca para 9,7%. Entre 9,7% e 31,8% não existe
 * NENHUM par, num vazio de 22,1 pontos. 20% cai com 10,3 pontos de folga para
 * baixo e 11,8 para cima.
 *
 * A spec chutava 80% antes de medir. A 80% o gate recolheria zero: nenhum par
 * chega a 50%. É o tipo de número que só a medição derruba.
 *
 * O vale é propriedade da distribuição e pode se mover quando o corpus crescer
 * — ele foi de 191 para 267 textos em três dias. `npm run medir:tela-regra`
 * recalcula o vale e o imprime; se ele andar, este número anda junto.
 */
export const LIMIAR_BOILERPLATE = 0.2;

/**
 * Uma linha crua de `digest_pegadinhas` ou `digest_ambiguidades`, já com o hash
 * do texto que a produziu.
 *
 * O `sha` vem de `market_rule_digests` — é a junção que a tela tem que fazer,
 * porque a linha do achado só conhece o `digest_id` e o denominador do gate é o
 * TEXTO.
 */
export type LinhaDeTrecho = {
  /** `market_rule_digests.description_sha256` do texto que produziu a linha. */
  sha: string;
  classe: Achado['classe'];
  /** `severidade` na pegadinha, `tipo` na ambiguidade. Nulo nas linhas da v1. */
  tipo: string | null;
  trecho: string | null;
};

/** O que o gate precisa saber de um achado para classificá-lo. */
export type Classificavel = {
  classe: Achado['classe'];
  subtipos: string[] | null;
  trecho: string | null;
};

/**
 * A frequência de um `(tipo, trecho)` no corpus.
 *
 * `textos` e `denominador` andam JUNTOS de propósito. Fração solta é a
 * armadilha do `1/1`: "100%" de uma leitura só parece consenso e é uma opinião.
 * Quem renderiza tem os dois números na mão e não consegue mostrar um sem o
 * outro por descuido.
 */
export type Frequencia = {
  /** Em quantos textos de regra DISTINTOS este par aparece ao menos uma vez. */
  textos: number;
  /** Quantos textos de regra foram lidos ao todo. */
  denominador: number;
  fracao: number;
  boilerplate: boolean;
};

export type IndiceDeBoilerplate = {
  /** Textos de regra lidos. É o denominador de toda fração deste índice. */
  denominador: number;
  /** `null` quando o achado não tem trecho, ou quando o índice nunca o viu. */
  frequenciaDe(achado: Classificavel): Frequencia | null;
};

const MESES =
  /\b(january|february|march|april|may|june|july|august|september|october|november|december)\b/g;

/**
 * Data e número virando marca, PARA A CHAVE DE CONTAGEM DO GATE E MAIS NADA.
 *
 * O boilerplate da Polymarket é o mesmo texto com a data trocada:
 * `December 31, 2026, 11:59 PM ET` e `June 30, 2027, 11:59 PM ET` são a mesma
 * omissão de fuso. Sem a máscara cada data é um par raro, e o padrão da casa
 * fica invisível — medido, a máscara é o que leva o terceiro par de 11,6% para
 * 31,8% e o põe dentro do gate.
 *
 * **Nunca sai daqui para a tela.** O trecho exibido é o literal (P1: citação não
 * se traduz nem se reescreve), e a dedup da seção 4 opera sobre o literal —
 * mascarar ali fundiria dois prazos DIFERENTES do mesmo regulamento num achado
 * só, que é falsificar a regra em vez de limpá-la.
 *
 * ## Limite conhecido: a máscara normaliza o miolo, não o recorte
 *
 * Ela troca número e mês, e nada mais. Duas leituras que citam a MESMA omissão
 * com recortes diferentes continuam em pares diferentes, porque a palavra a
 * mais entra na chave.
 *
 * Medido em 22/08/2026: `by December 31, 2026, 11:59 PM ET` parou em 9,7% e
 * ficou de fora do gate, enquanto as outras variantes de data colapsaram em
 * 31,8% e entraram. A diferença é o `by`.
 *
 * **Não é bug corrigido, é limite documentado.** Está escrito aqui e travado em
 * `boilerplate.test.ts` para que ninguém olhe aquele 9,7% no relatório daqui a
 * seis meses e ache que descobriu um tipo novo de defeito. Consertar exigiria
 * ancorar o trecho por posição no regulamento, que é outra decisão e outro
 * custo.
 */
export function mascararParaGate(s: string): string {
  return normalizarTrecho(s).replace(MESES, '<mes>').replace(/\d+/g, '#');
}

/**
 * A chave de contagem: a categoria do defeito mais a passagem mascarada.
 *
 * Para a pegadinha a categoria é a classe, e a severidade fica FORA — a mesma
 * escolha de `grupoDe` na dedup, e pelo mesmo motivo: duas leituras que
 * discordam do peso da mesma passagem acharam um defeito, não dois. Somar as
 * duas contagens separadas é fragmentar o padrão da casa em dois padrões raros.
 *
 * Para ambiguidade e contradição o tipo ENTRA: `fuso_ausente` e `data_ambigua`
 * sobre a mesma passagem são dois defeitos dela.
 */
export function chaveDoGate(
  classe: Achado['classe'],
  subtipos: readonly string[],
  trecho: string,
): string {
  const categoria =
    classe === 'pegadinha' ? 'pegadinha' : `${classe}|${[...subtipos].sort().join(',')}`;
  return `${categoria}||${mascararParaGate(trecho)}`;
}

function temTexto(s: string | null): s is string {
  return s !== null && s.trim() !== '';
}

/**
 * O índice de frequência, montado das linhas cruas.
 *
 * `textosLidos` são TODOS os `description_sha256` de `market_rule_digests`,
 * inclusive os que não produziram achado nenhum. Um texto lido e limpo é uma
 * chance que a passagem teve de aparecer e não apareceu, e tirá-lo do
 * denominador infla toda fração — no corpus de 22/08/2026 são 267 textos, e
 * usar só os que têm achado daria 266: pequeno aqui, mas é a mesma classe de
 * erro que a view evita ao contar `leituras_do_texto` sobre
 * `market_rule_digests` e não sobre os achados.
 *
 * Puro: recebe dado, devolve índice. Quem busca é a tela.
 */
export function montarIndice(
  linhas: readonly LinhaDeTrecho[],
  textosLidos: readonly string[],
): IndiceDeBoilerplate {
  const denominador = new Set(textosLidos).size;

  // Primeiro o grão do achado — (texto, classe, tipo, trecho normalizado) —,
  // para juntar as severidades que as leituras atribuíram à mesma passagem.
  // Sem esta etapa, a mesma pegadinha marcada `muda_resultado` numa leitura e
  // `detalhe` noutra viraria dois pares.
  const subtiposDoAchado = new Map<string, Set<string>>();
  for (const l of linhas) {
    if (!temTexto(l.trecho)) continue;
    const categoria = l.classe === 'pegadinha' ? 'pegadinha' : `${l.classe}|${l.tipo ?? ''}`;
    const k = `${l.sha}||${categoria}||${normalizarTrecho(l.trecho)}`;
    let s = subtiposDoAchado.get(k);
    if (s === undefined) {
      s = new Set();
      subtiposDoAchado.set(k, s);
    }
    if (l.tipo !== null) s.add(l.tipo);
  }

  // Agora a contagem por (chave do gate, texto distinto).
  const textosPorChave = new Map<string, Set<string>>();
  for (const l of linhas) {
    if (!temTexto(l.trecho)) continue;
    const categoria = l.classe === 'pegadinha' ? 'pegadinha' : `${l.classe}|${l.tipo ?? ''}`;
    const subtipos =
      subtiposDoAchado.get(`${l.sha}||${categoria}||${normalizarTrecho(l.trecho)}`) ?? new Set();
    const k = chaveDoGate(l.classe, [...subtipos], l.trecho);
    let s = textosPorChave.get(k);
    if (s === undefined) {
      s = new Set();
      textosPorChave.set(k, s);
    }
    // Conta TEXTO, não linha: o mesmo trecho achado por três leituras do mesmo
    // texto é um texto. Contar linha faria o texto muito lido parecer padrão.
    s.add(l.sha);
  }

  return {
    denominador,
    frequenciaDe(achado: Classificavel): Frequencia | null {
      if (!temTexto(achado.trecho)) return null;
      const alcance = textosPorChave.get(
        chaveDoGate(achado.classe, achado.subtipos ?? [], achado.trecho),
      );
      if (alcance === undefined) return null;
      const fracao = denominador === 0 ? 0 : alcance.size / denominador;
      return {
        textos: alcance.size,
        denominador,
        fracao,
        boilerplate: fracao >= LIMIAR_BOILERPLATE,
      };
    },
  };
}

/**
 * Separa o que é padrão da casa do que é peculiaridade deste mercado.
 *
 * **Nada é apagado.** `visiveis` e `comuns` somam a entrada, sempre. O grupo
 * recolhido abre, e cada item dele leva a frequência que o pôs ali.
 *
 * `indice` nulo é o estado enquanto as três consultas de frequência não
 * voltaram: tudo fica visível, nada recolhe. O achado aparece de qualquer jeito
 * — ele só ainda não sabe se é padrão da casa. Isso é estado legítimo e não
 * erro, e por isso é o tipo que o expressa, e não um `try`.
 *
 * A ordem de cada lista é a da entrada: quem ordena é a seção 7.
 */
export function separarBoilerplate<T extends Classificavel>(
  achados: readonly T[],
  indice: IndiceDeBoilerplate | null,
): { visiveis: T[]; comuns: { achado: T; frequencia: Frequencia }[] } {
  const visiveis: T[] = [];
  const comuns: { achado: T; frequencia: Frequencia }[] = [];

  for (const a of achados) {
    const f = indice?.frequenciaDe(a) ?? null;
    // Sem frequência o achado sobe. Sumir por causa de um índice incompleto
    // seria descarte silencioso, que é a armadilha que este projeto já pagou.
    if (f === null || !f.boilerplate) visiveis.push(a);
    else comuns.push({ achado: a, frequencia: f });
  }

  return { visiveis, comuns };
}
