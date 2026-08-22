import type { ContagemDigest, MercadoRadar, MercadoNaLista } from './tipos';

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
 * Nenhum mercado tem dois textos hoje (734 linhas para 734 mercados em
 * 22/08/2026), então isto é defeito latente e não sintoma. `dados.ts` já
 * registra a mesma expectativa, evitando `.single()` no `lerAchados`.
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
 * A ordem dentro do grupo é a de chegada, que é a da view (`order by
 * e.liquidity desc nulls last, pm.event_id`). Não reordena.
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
 * Lista vazia é "não digerido", que é fato sobre o dado e não defeito: medido em
 * 22/08/2026, 320 dos 1054 mercados do roster (30,4%) não têm digestão nenhuma.
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
