/**
 * A janela temporal e a escolha de base da `v_radar`, escritas uma segunda vez.
 *
 * Isto NÃO é a implementação — a implementação é o SQL das migrations
 * `20260814142958_views_do_radar.sql` (janela) e
 * `20260814151752_variacao_sem_mid_e_lado_oposto.sql` (base), e é ele que roda
 * em produção. Isto é uma segunda opinião independente, usada por
 * `scripts/conferir-views.ts` para conferir o que a view devolveu contra o que
 * a série crua diz.
 *
 * Duas implementações da mesma regra só valem alguma coisa se forem escritas a
 * partir da REGRA e não uma da outra. As três regras aqui são:
 *
 *   1. A âncora de "X atrás" é a foto mais próxima de `agora - X`, dentro de
 *      uma tolerância. Não é "N fotos atrás": contar linhas dá salto errado no
 *      primeiro buraco da série, e a cobertura medida por ciclo é 95,9%.
 *
 *   2. A variação usa o MESMO LADO do livro nas duas pontas: mid se houver nas
 *      duas, senão ask nas duas, senão bid nas duas, senão nada. Nunca ask de
 *      uma ponta contra mid da outra.
 *
 *   3. Mid nulo continua nulo. O que a base recupera é a VARIAÇÃO, não o mid:
 *      livro de um lado só não tem meio, mas tem movimento.
 */

/** Uma foto da série: o instante e os três valores do livro. */
export interface Foto {
  capturedAt: number; // epoch ms
  mid: number | null;
  bid: number | null;
  ask: number | null;
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

/** A base sobre a qual a variação foi calculada. */
export type Base = 'mid' | 'ask' | 'bid';

/**
 * A ordem da cascata. `ask` antes de `bid` porque o caso que motivou a base
 * alternativa é o azarão com só venda: `ladosDoLivro` trata `bid <= 0` como
 * "ninguém comprando", então livro de um lado só costuma ser o lado do ask.
 *
 * A ordem é dado, não `if` encadeado, para que ela seja UMA coisa que se lê e
 * se muda — do mesmo jeito que no SQL ela é uma cascata de `case` só.
 */
export const ORDEM_DAS_BASES: readonly Base[] = ['mid', 'ask', 'bid'];

function valorNaBase(foto: Foto, base: Base): number | null {
  if (base === 'mid') return foto.mid;
  if (base === 'ask') return foto.ask;
  return foto.bid;
}

export interface Variacao {
  base: Base | null;
  variacao: number | null;
  /** O valor da âncora na base escolhida. A outra ponta é `ref + variacao`. */
  ref: number | null;
}

const SEM_VARIACAO: Variacao = { base: null, variacao: null, ref: null };

/**
 * A variação entre duas fotos, e a base que a produziu.
 *
 * As três saídas vêm juntas de propósito: é o que garante que ponta e âncora
 * nunca usem bases diferentes. Ask de agora contra mid de uma hora atrás é
 * ruído com cara de sinal, e a única defesa possível contra isso é não existir
 * um caminho de código que produza a combinação.
 *
 * Devolve `variacao: null` — nunca `0` — quando nenhuma base tem valor nas duas
 * pontas. Zero significa "não mudou", que é uma afirmação sobre o mercado; nulo
 * significa "não sei", que é uma afirmação sobre o dado.
 */
export function variacaoComBase(agora: Foto | null, ancora: Foto | null): Variacao {
  if (agora === null || ancora === null) return SEM_VARIACAO;

  for (const base of ORDEM_DAS_BASES) {
    const a = valorNaBase(agora, base);
    const b = valorNaBase(ancora, base);
    if (a !== null && b !== null) {
      return { base, variacao: a - b, ref: b };
    }
  }

  return SEM_VARIACAO;
}

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

export interface Leitura {
  /** A última foto da série, ou `null` se não há nenhuma. */
  agora: Foto | null;
  ancoras: Record<Janela, Foto | null>;
  variacoes: Record<Janela, Variacao>;
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
  const variacoes = {} as Record<Janela, Variacao>;

  for (const j of Object.keys(JANELA_MS) as Janela[]) {
    const ancora =
      agora === null
        ? null
        : escolherAncora(fotos, agora.capturedAt - JANELA_MS[j], TOLERANCIA_MS[j]);
    ancoras[j] = ancora;
    variacoes[j] = variacaoComBase(agora, ancora);
  }

  return { agora, ancoras, variacoes };
}
