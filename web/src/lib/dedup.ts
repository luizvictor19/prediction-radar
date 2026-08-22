import type { Achado } from './tipos';

/**
 * A dedup por absorção — seção 4 da spec da tela de Regra.
 *
 * O mesmo defeito citado com recortes diferentes vira um achado só. No mercado
 * do Bolsonaro, `This market will resolve according to the margin of victory
 * between the top two candidates` e a mesma frase com `in the first round of
 * the next Brazil Presidential Election.` no fim são duas linhas na tela e um
 * defeito no regulamento.
 *
 * Medido em 22/08/2026 (`npm run medir:tela-regra`): tira 33,8% dos achados em
 * tela, e a mediana por mercado cai de 16 para 12.
 *
 * ## Absorção, e não componentes conexos
 *
 * O direito de esconder um achado vem de UM invariante: **o sobrevivente contém
 * literalmente todo trecho que absorveu**. É o que garante que a citação
 * escondida continua na tela, dentro de um recorte maior.
 *
 * Fecho transitivo não preserva isso, e trocar sobreposição por continência não
 * conserta. Com `A ⊃ B` e `C ⊃ B` mas `A ⊅ C`, union-find põe os três no mesmo
 * componente e o sobrevivente não contém o `C`. Medido, isso acontecia em 340
 * fusões só com continência, e em 410 com sobreposição.
 *
 * Aqui cada achado é absorvido pelo MAIS LONGO que o contém, e quem não tem
 * container sobrevive sozinho. O invariante passa a ser verdade por construção,
 * e é isso que `dedup.test.ts` trava — sem esse teste, alguém "otimiza" isto de
 * volta para union-find em seis meses e nada quebra visivelmente.
 *
 * A forma `A ⊃ B`, `C ⊃ B`, `A ⊅ C` aparece 2.035 vezes em 217 mercados. Não é
 * caso de laboratório.
 *
 * ## Por que a entrada não é `Achado`
 *
 * `Achado.vezes_encontrado` é uma CONTAGEM, e a união de leituras não se calcula
 * a partir de contagens. `min(soma, leituras_do_texto)` acerta em 94,7% das
 * fusões e infla a concordância nas outras — em até +3 leituras. Inflar
 * concordância por conveniência de apresentação é o que a seção 11 da spec
 * proíbe, então a entrada carrega o conjunto e quem chama tem que buscá-lo.
 */

/**
 * O contrato mínimo da fusão: o que ela lê para decidir, e nada além.
 *
 * Estrutural e não `Achado` inteiro para que a função seja genérica — quem
 * chama passa o seu próprio tipo, com os campos que a tela usa, e recebe o
 * mesmo tipo de volta com os extras intactos. Amarrar em `Achado` obrigaria
 * todo fixture de teste a inventar `leituras_do_texto` e `achado_id` que a
 * regra não olha.
 */
export type AchadoFundivel = {
  classe: Achado['classe'];
  origem: Achado['origem'];
  subtipos: string[] | null;
  trecho: string | null;
  /** Os `market_rule_digests.id` que apontaram este trecho. */
  leituras: readonly string[];
} & Prosa;

/**
 * O que o modelo escreveu PARA UM MERCADO, e que por isso é nulo no herdado —
 * os mesmos quatro campos que a view recusa a propagar
 * (`20260817040920_...sql:118`).
 *
 * `descricao` e `cenario` são a prosa da pegadinha; `leitura_a` e `leitura_b`
 * são a da ambiguidade e da contradição. Uma regra que cobrisse só as duas
 * primeiras perderia a prosa em toda fusão de ambiguidade.
 */
type Prosa = {
  descricao: string | null;
  cenario: string | null;
  leitura_a: string | null;
  leitura_b: string | null;
};

const SEM_PROSA: Prosa = { descricao: null, cenario: null, leitura_a: null, leitura_b: null };

function temProsa(a: Prosa): boolean {
  return a.descricao !== null || a.cenario !== null || a.leitura_a !== null || a.leitura_b !== null;
}

/**
 * A mesma normalização do `achado_id` da view (`20260817040920_...sql:172`):
 * colapso de espaço e caixa baixa. Pontuação NÃO é removida — ela distingue
 * dois recortes de propósito, e removê-la aqui faria a fusão engolir trechos
 * que o sobrevivente não contém literalmente.
 */
export function normalizarTrecho(s: string): string {
  return s.trim().replace(/\s+/g, ' ').toLowerCase();
}

const PALAVRA = /[\p{L}\p{N}]/u;

function bordaDePalavra(s: string, i: number): boolean {
  if (i < 0 || i >= s.length) return true;
  return !PALAVRA.test(s[i] as string);
}

/**
 * `menor` aparece dentro de `maior`, alinhado a borda de palavra.
 *
 * Continência de CARACTERES e não de tokens: `...11:59 PM ET` está dentro de
 * `...11:59 PM ET, the market...` e uma comparação por token separaria os dois
 * por causa da vírgula colada no `ET`.
 *
 * A borda é o que impede `et` de ser encontrado dentro de `market`. Sem ela, um
 * fragmento curto absorveria frases que não têm nada a ver com ele.
 */
export function contemTrecho(maior: string, menor: string): boolean {
  const m = normalizarTrecho(maior);
  const n = normalizarTrecho(menor);
  if (n === '' || n.length > m.length) return false;
  for (let i = m.indexOf(n); i !== -1; i = m.indexOf(n, i + 1)) {
    if (bordaDePalavra(m, i - 1) && bordaDePalavra(m, i + n.length)) return true;
  }
  return false;
}

/**
 * O grupo dentro do qual dois achados podem ser o mesmo defeito.
 *
 * Severidade fica FORA da chave da pegadinha. Duas leituras que citam a mesma
 * passagem e discordam do peso — `muda_resultado` numa, `detalhe` na outra —
 * acharam um defeito, não dois, e a discordância é para preservar em `subtipos`
 * e não para duplicar o item na tela.
 *
 * Para ambiguidade e contradição o `tipo` ESTÁ na chave, e ali ele é a
 * categoria do defeito: `fuso_ausente` sobre `December 31, 2026, 11:59 PM ET` e
 * `data_ambigua` sobre `December 31, 2026` são dois defeitos da mesma passagem.
 */
function grupoDe(a: AchadoFundivel): string {
  if (a.classe === 'pegadinha') return 'pegadinha';
  return `${a.classe}|${(a.subtipos ?? []).join(',')}`;
}

/**
 * Ordem determinística: trecho mais longo primeiro, empate pelo normalizado.
 *
 * O desempate é uma propriedade do TEXTO e não da chegada. A view não promete
 * ordem estável dentro do `jsonb_agg`, e um desempate posicional faria dois
 * carregamentos da mesma tela mostrarem trechos diferentes.
 */
function maisLongoPrimeiro(a: AchadoFundivel, b: AchadoFundivel): number {
  const ta = a.trecho ?? '';
  const tb = b.trecho ?? '';
  return tb.length - ta.length || normalizarTrecho(ta).localeCompare(normalizarTrecho(tb));
}

/**
 * Funde os achados de UM mercado, um texto de regra.
 *
 * Quem chama passa a lista de um `(mercado, texto)` — o grão de
 * `digest_achados_por_mercado`. Fundir através de textos diferentes juntaria
 * passagens de dois regulamentos.
 *
 * Não modifica a entrada. Devolve os sobreviventes na mesma ordem determinística
 * do critério de absorção: mais longo primeiro.
 */
export function fundirPorAbsorcao<T extends AchadoFundivel>(achados: readonly T[]): T[] {
  const porGrupo = new Map<string, T[]>();
  for (const a of achados) {
    const k = grupoDe(a);
    const g = porGrupo.get(k);
    if (g === undefined) porGrupo.set(k, [a]);
    else g.push(a);
  }

  const sobreviventes: { item: T; absorvidos: T[] }[] = [];

  for (const grupo of porGrupo.values()) {
    const ordenados = [...grupo].sort(maisLongoPrimeiro);

    // `dono[j]` é o índice do container escolhido, ou -1 se `j` sobrevive.
    // A varredura vai do mais longo para o mais curto e para no PRIMEIRO
    // container: ele é o mais longo, e o empate já caiu no critério da ordem.
    const dono = ordenados.map(() => -1);
    for (let j = 1; j < ordenados.length; j++) {
      const alvo = ordenados[j] as T;
      if (alvo.trecho === null) continue;
      for (let i = 0; i < j; i++) {
        const cand = ordenados[i] as T;
        if (cand.trecho === null) continue;
        if (contemTrecho(cand.trecho, alvo.trecho)) {
          dono[j] = i;
          break;
        }
      }
    }

    // Um absorvido cujo dono também foi absorvido sobe para o dono final. O
    // invariante sobrevive à subida: o container final contém o intermediário,
    // e o intermediário contém o absorvido.
    const membros = new Map<number, T[]>();
    for (let j = 0; j < ordenados.length; j++) {
      let raiz = j;
      while (dono[raiz] !== -1) raiz = dono[raiz] as number;
      let lista = membros.get(raiz);
      if (lista === undefined) {
        lista = [];
        membros.set(raiz, lista);
      }
      if (j !== raiz) lista.push(ordenados[j] as T);
    }

    for (const [raiz, absorvidos] of membros) {
      sobreviventes.push({ item: ordenados[raiz] as T, absorvidos });
    }
  }

  return sobreviventes
    .sort((x, y) => maisLongoPrimeiro(x.item, y.item))
    .map(({ item, absorvidos }) => (absorvidos.length === 0 ? item : fundir(item, absorvidos)));
}

/** O sobrevivente com o que os absorvidos trouxeram. */
function fundir<T extends AchadoFundivel>(sobrevivente: T, absorvidos: readonly T[]): T {
  const todos = [sobrevivente, ...absorvidos];

  // UNIÃO, e não máximo nem soma. A leitura que citou o trecho curto e a que
  // citou o longo encontraram o mesmo defeito, então somam; a que citou os dois
  // conta uma vez. Medido, o máximo acertaria em 1,7% das fusões, e a soma
  // (mesmo limitada a `leituras_do_texto`) inflaria a concordância em 5,3%.
  const leituras = new Set<string>();
  for (const a of todos) for (const l of a.leituras) leituras.add(l);

  const subtipos = new Set<string>();
  for (const a of todos) for (const s of a.subtipos ?? []) subtipos.add(s);

  // A prosa vem do de maior concordância ENTRE OS QUE TÊM prosa. "O de maior
  // concordância", sem a ressalva, jogaria fora a única prosa existente em 9,6%
  // das fusões — onde o mais confirmado é herdado, e herdado é nulo por
  // construção. Empate pelo trecho mais longo, que é a ordem de `todos`.
  //
  // Em BLOCO, e nunca campo a campo: `descricao` de uma leitura com `cenario`
  // de outra é um par que ninguém escreveu, e a tela o apresentaria como se
  // fosse. Prosa fabricada é pior que prosa ausente.
  const fonte = todos
    .filter(temProsa)
    .reduce<T | null>(
      (melhor, a) => (melhor === null || a.leituras.length > melhor.leituras.length ? a : melhor),
      null,
    );

  const prosa: Prosa =
    fonte === null
      ? SEM_PROSA
      : {
          descricao: fonte.descricao,
          cenario: fonte.cenario,
          leitura_a: fonte.leitura_a,
          leitura_b: fonte.leitura_b,
        };

  // O `as T` cobre o que o compilador não sabe provar: os campos sobrescritos
  // são exatamente os de `AchadoFundivel`, e o resto vem do spread intacto.
  return {
    ...sobrevivente,
    ...prosa,
    origem: todos.some((a) => a.origem === 'acusado') ? 'acusado' : 'herdado',
    subtipos: [...subtipos].sort(),
    leituras: [...leituras],
  } as T;
}
