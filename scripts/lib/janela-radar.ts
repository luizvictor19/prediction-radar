/**
 * A janela temporal da `v_radar`, escrita uma segunda vez.
 *
 * Isto NÃO é a implementação — a implementação é o SQL da migration
 * `20260814142958_views_do_radar.sql`, e é ele que roda em produção. Isto é uma
 * segunda opinião independente, usada por `scripts/conferir-views.ts` para
 * conferir o que a view devolveu contra o que a série crua diz.
 *
 * Duas implementações da mesma regra só valem alguma coisa se forem escritas a
 * partir da REGRA e não uma da outra. As duas regras aqui são:
 *
 *   1. A âncora de "X atrás" é a foto mais próxima de `agora - X`, dentro de
 *      uma tolerância. Não é "N fotos atrás": contar linhas dá salto errado no
 *      primeiro buraco da série, e a cobertura medida por ciclo é 95,9%.
 *
 *   2. Mid nulo continua nulo. Variação contra mid nulo é NULA, não zero.
 *      Livro de um lado só é 18,3% das linhas medidas — não é canto raro, e
 *      `?? 0` em cima disso viraria "não mudou" onde a verdade é "não sei".
 */

/** Uma foto da série: o instante e o meio-preço, que pode não existir. */
export interface Foto {
  capturedAt: number; // epoch ms
  mid: number | null;
}

/** As três janelas da view, em milissegundos. */
export const JANELA_MS = {
  h1: 60 * 60_000,
  h24: 24 * 60 * 60_000,
  d7: 7 * 24 * 60 * 60_000,
} as const;

/**
 * As tolerâncias da view, em milissegundos — os mesmos números do SQL.
 *
 * O piso é a cadência do coletor (15 min): um alvo que caia no meio de um
 * intervalo está a no máximo 7,5 min da foto mais próxima. ±15 min cobre um
 * ciclo inteiro perdido sem perder a âncora.
 *
 * As janelas longas ganham tolerância maior em valor absoluto e MENOR em
 * proporção (±1h é 4% de 24h; ±6h é 3,6% de 7d): quanto mais longa a janela,
 * menos um desvio absoluto distorce a variação.
 */
export const TOLERANCIA_MS = {
  h1: 15 * 60_000,
  h24: 60 * 60_000,
  d7: 6 * 60 * 60_000,
} as const;

export type Janela = keyof typeof JANELA_MS;

/**
 * A foto mais próxima de `alvoMs`, ou `null` se a mais próxima está além da
 * tolerância.
 *
 * Empate (alvo exatamente entre duas fotos) resolve pela MAIS ANTIGA, que é o
 * mesmo desempate do SQL (`order by abs(...), s.captured_at`). Sem desempate
 * explícito as duas implementações poderiam discordar num caso raro e ninguém
 * saberia qual estava certa.
 *
 * Não assume ordenação da entrada. Ordenar aqui custa nada no tamanho que essa
 * lista tem (uma série de mercado), e depender de ordem de chegada é o tipo de
 * suposição que quebra quando a query muda de `order by`.
 */
export function escolherAncora(
  fotos: readonly Foto[],
  alvoMs: number,
  toleranciaMs: number,
): Foto | null {
  let melhor: Foto | null = null;
  let melhorDist = Infinity;

  for (const foto of fotos) {
    const dist = Math.abs(foto.capturedAt - alvoMs);
    if (dist > toleranciaMs) continue;
    if (dist < melhorDist || (dist === melhorDist && melhor !== null && foto.capturedAt < melhor.capturedAt)) {
      melhor = foto;
      melhorDist = dist;
    }
  }

  return melhor;
}

/**
 * A variação entre dois meios-preços.
 *
 * `null` quando qualquer uma das duas pontas é nula — e é a função inteira.
 * Existe separada, com nome, porque `a - b` em TypeScript com `null` dá `0`
 * silenciosamente (`null` vira 0 na coerção numérica), que é exatamente o bug
 * que o Postgres não tem e que uma reimplementação em JS introduziria de graça.
 */
export function variacao(agora: number | null, ancora: number | null): number | null {
  if (agora === null || ancora === null) return null;
  return agora - ancora;
}

export interface Leitura {
  /** A última foto da série, ou `null` se não há nenhuma. */
  agora: Foto | null;
  ancoras: Record<Janela, Foto | null>;
  variacoes: Record<Janela, number | null>;
}

/**
 * A leitura completa de um mercado: o "agora" e as três janelas.
 *
 * O alvo de cada janela é `agora.capturedAt - janela`, e NÃO `Date.now() -
 * janela`. A última foto pode ter até 15 min de idade, e ancorar no relógio
 * faria a janela "1h" medir 45 min de verdade. Ancorada na própria foto, ela
 * mede 1h de dado observado, sempre. O SQL faz igual.
 */
export function lerJanelas(fotos: readonly Foto[]): Leitura {
  let agora: Foto | null = null;
  for (const foto of fotos) {
    if (agora === null || foto.capturedAt > agora.capturedAt) agora = foto;
  }

  const ancoras = {} as Record<Janela, Foto | null>;
  const variacoes = {} as Record<Janela, number | null>;

  for (const j of Object.keys(JANELA_MS) as Janela[]) {
    const ancora =
      agora === null
        ? null
        : escolherAncora(fotos, agora.capturedAt - JANELA_MS[j], TOLERANCIA_MS[j]);
    ancoras[j] = ancora;
    variacoes[j] = variacao(agora?.mid ?? null, ancora?.mid ?? null);
  }

  return { agora, ancoras, variacoes };
}
