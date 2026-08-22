import type {
  ContagemDigest,
  LeituraRegra,
  LinhaAchados,
  MercadoRadar,
  MercadoNaLista,
} from './tipos';

/**
 * A junção do radar com a digestão — pura, sem React e sem fetch.
 *
 * Separada de `App.tsx` pelo mesmo motivo que `radar-selection.ts` é separada do
 * coletor: a regra de como as duas leituras se casam é testável sem navegador e
 * sem banco, e dentro de um `useEffect` não é.
 *
 * ## A granularidade é (mercado, texto de regra), não mercado
 *
 * Casar as duas leituras num `Map` chaveado só por `event_id` faz a segunda
 * linha de um mercado com dois textos sobrescrever a primeira em silêncio — as
 * contagens de um dos textos somem da tela sem aviso. Por isso o campo é lista.
 *
 * Nenhum mercado tem dois textos hoje — 1033 linhas para 1033 mercados, medido
 * em 22/08/2026 por `npm run medir:tela-regra` —, então isto é defeito latente
 * e não sintoma. `dados.ts` já registra a mesma expectativa, evitando
 * `.single()` no `lerAchados`.
 */
export function juntarRadarComDigest(
  radar: readonly MercadoRadar[],
  contagens: readonly ContagemDigest[],
): MercadoNaLista[] {
  const porEvento = agruparPorEvento(contagens);

  // LEFT join: mercado do radar sem digestão existe e tem que aparecer.
  return radar.map(m => ({ ...m, digests: porEvento.get(m.id) ?? [] }));
}

/**
 * As contagens agrupadas por mercado, sem perder texto.
 *
 * Não reordena: a ordem dentro do grupo é a de chegada.
 *
 * E a de chegada é a que `lerContagens` PEDE — `event_id, description_sha256` —,
 * não a da própria view. A view declara `order by e.liquidity desc nulls last,
 * pm.event_id`, mas o `select` da tela sobrescreve isso para poder paginar por
 * chave estável. Nada aqui depende da ordem (soma e mínimo não dependem), e o
 * aviso existe para quem vier acrescentar uma leitura de `digests[]` que dependa.
 */
export function agruparPorEvento(
  contagens: readonly ContagemDigest[],
): Map<string, ContagemDigest[]> {
  const porEvento = new Map<string, ContagemDigest[]>();
  for (const c of contagens) {
    const grupo = porEvento.get(c.event_id);
    if (grupo === undefined) porEvento.set(c.event_id, [c]);
    else grupo.push(c);
  }
  return porEvento;
}

/**
 * O mercado foi digerido?
 *
 * Lista vazia é "não digerido", que é fato sobre o dado e não defeito: 20 dos
 * 942 mercados do roster (2,1%) não têm digestão nenhuma, medido em 22/08/2026
 * por `npm run medir:tela-regra`.
 */
export function temDigestao(m: Pick<MercadoNaLista, 'digests'>): boolean {
  return m.digests.length > 0;
}

/**
 * A soma de uma contagem sobre TODOS os textos de regra do mercado.
 *
 * Soma, e não "a do primeiro texto": a pergunta da lista é "quantas contradições
 * este mercado carrega", e um mercado com dois textos carrega as dos dois.
 *
 * Sem digestão devolve `null` e não 0 — "não foi lido" não é "foi lido e não
 * achou nada", e a lista ordena por este valor, onde nulo vai para o fim.
 */
export function somaDigest(
  m: Pick<MercadoNaLista, 'digests'>,
  campo: 'achados_total' | 'achados_acusados' | 'achados_herdados' | 'contradicoes',
): number | null {
  if (m.digests.length === 0) return null;
  return m.digests.reduce((acc, d) => acc + d[campo], 0);
}

// ---------------------------------------------------------------------------
// Quais textos de regra a tela de detalhe precisa ler
// ---------------------------------------------------------------------------

/**
 * Os hashes de texto a buscar em `market_rule_digests`, para UM mercado.
 *
 * `lerLeituras` filtra por `(event_id, description_sha256)`, então cada texto é
 * uma leitura própria do banco. Quem decide quantas são é esta função.
 *
 * TODOS os textos, e não só o primeiro: a tela renderiza um bloco por texto, e
 * um bloco sem as leituras do seu hash exibiria a regra do outro texto no lugar
 * da própria — uma regra apresentada como se fosse outra, que é pior do que não
 * mostrar nada.
 *
 * Sem `distinct`: a view agrupa por `(event_id, description_sha256)`, então cada
 * hash aparece uma vez por mercado por construção.
 */
export function textosParaLer(linhas: readonly LinhaAchados[]): string[] {
  return linhas.map(l => l.description_sha256);
}

/**
 * As leituras agrupadas pelo texto a que pertencem.
 *
 * Cada bloco da tela é um texto de regra, e tem que receber as leituras DAQUELE
 * texto. `leituraExibida` e `divergem` operam sobre o grupo, não sobre a mistura
 * — comparar leituras de textos diferentes acusaria divergência onde há apenas
 * duas regras diferentes.
 */
export function leiturasPorTexto(
  leituras: readonly LeituraRegra[],
): Map<string, LeituraRegra[]> {
  const porTexto = new Map<string, LeituraRegra[]>();
  for (const l of leituras) {
    const grupo = porTexto.get(l.description_sha256);
    if (grupo === undefined) porTexto.set(l.description_sha256, [l]);
    else grupo.push(l);
  }
  return porTexto;
}
