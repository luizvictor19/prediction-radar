import type { Achado } from './tipos';

/**
 * Inherited findings, collapsed -- section 6 of the rule-screen spec.
 *
 * A finding marked `herdado` came from a sibling market with the SAME rule
 * text: the model never read this market, which is why `descricao`, `cenario`,
 * `leitura_a` and `leitura_b` are null by construction
 * (`20260817033302_...sql:170`). What is left is the quoted span and the count.
 *
 * They are most of the screen -- M3 measured a median of 11 inherited against 5
 * accused per market, across 1033 markets -- and they are the least actionable
 * item on it. Today they mix into the accused in a single list sorted by
 * agreement, and an inherited 11/30 opens the screen above an accused 2/30.
 *
 * **Collapsing is not deleting.** The two groups always sum to the input. The
 * block opens, and every item keeps its literal span and its agreement badge.
 */

/**
 * The minimal contract: the origin, and nothing beyond it.
 *
 * The split never looks at agreement. If it did, the strong inherited finding
 * would climb back up -- and that ordering is exactly what section 6 forbids.
 * Agreement orders WITHIN each group, and section 7 is what does that.
 */
export type Recolhivel = { origem: Achado['origem'] };

/**
 * Splits what this market accused from what it inherited.
 *
 * ## The key is the origin, and not the absence of prose
 *
 * The spec justifies collapsing by saying a finding with no description and no
 * scenario is the least actionable one on screen, and that makes "has no prose"
 * look like the right key. It is not. Absent prose is a PROXY; origin is a FACT
 * -- it is what the view records, and it is what the block header asserts when
 * it says *"inherited from other markets with the same rule text"*. A terse
 * accused finding was read in THIS market, and collapsing it for being terse
 * would make that header false about it.
 *
 * ## The `else` stays outside
 *
 * Only `herdado` collapses; any other value of `origem` stays visible.
 * `tipos.ts` is hand-written, so a new value in the database reaches this code
 * without breaking the build -- collapsing it would assert a provenance nobody
 * checked. Same path `separarBoilerplate` takes when it has no frequency: in
 * doubt, the finding shows.
 *
 * ## The caller passes ONE (market, rule text)
 *
 * The grain of `digest_achados_por_mercado`. Mixing two texts into one block
 * would make the header's "with the same rule text" lie.
 *
 * The order of each list is the input's. Does not modify the input.
 */
export function separarHerdados<T extends Recolhivel>(
  achados: readonly T[],
): { acusados: T[]; herdados: T[] } {
  const acusados: T[] = [];
  const herdados: T[] = [];

  for (const a of achados) {
    if (a.origem === 'herdado') herdados.push(a);
    else acusados.push(a);
  }

  return { acusados, herdados };
}
