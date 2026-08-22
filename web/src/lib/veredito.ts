import { normalizarTrecho } from './dedup';
import type { Achado } from './tipos';

/**
 * The headline verdict -- step 2 of item 5, section 8 of the rule-screen spec.
 *
 * The thesis of the project is one sentence: the market prices the HEADLINE, the
 * market resolves by the RULE, and the difference is the opportunity. The screen
 * has never said that anywhere, which is why a reader cannot tell in ten seconds
 * where the title lies.
 *
 * It needs no new generation to say it. `descricao` and `cenario` of the
 * strongest accused `muda_resultado` trap already carry exactly that shape --
 * "whoever read only the title expects YES, but the rule gives NO". This is
 * selection and presentation, nothing more.
 *
 * Measured on 22/08/2026 (M4): 807 of 1033 markets (78.1%) have an accused
 * `muda_resultado` trap with both fields filled. The band is the rule, not the
 * exception -- and the other ~22% get an empty state that says "read and clean",
 * which is different information from "not read".
 */

/** What the choice reads, and nothing beyond it. */
export type Veredicavel = {
  classe: Achado['classe'];
  origem: Achado['origem'];
  subtipos: string[] | null;
  vezes_encontrado: number;
  leituras_do_texto: number;
  trecho: string | null;
  descricao: string | null;
  cenario: string | null;
};

/**
 * A trap this market was read for, that changes WHO WINS.
 *
 * Exported because the number band counts the same thing the verdict is chosen
 * from. Two copies of this predicate would drift, and the screen would show a
 * headline drawn from a trap its own counter does not count.
 *
 * `muda_timing` is deliberately out: it changes WHEN, and section 2 of the
 * hierarchy shows both, but the verdict band is about the outcome. `herdado` is
 * out because the model never read this market -- its prose is null by
 * construction, so a propagated finding could never be the headline anyway.
 */
export function ehArmadilhaDeResultado(a: Veredicavel): boolean {
  return (
    a.classe === 'pegadinha' &&
    a.origem === 'acusado' &&
    (a.subtipos ?? []).includes('muda_resultado')
  );
}

function prosa(s: string | null): s is string {
  return s !== null && s.trim() !== '';
}

/**
 * The trap the band speaks with, or `null` when there is none.
 *
 * **Both fields or nothing.** `descricao` says what the rule demands; `cenario`
 * is the case where it bites, and it is the half that convinces. M4 counted the
 * markets with BOTH for exactly this reason. A band with one of them states a
 * claim and never shows it landing.
 *
 * **The strongest, and deterministically.** Ties resolve by the quoted span,
 * which is a property of the text -- the view promises no order inside
 * `jsonb_agg`, so a positional tiebreak would change the headline of the screen
 * between two loads of the same market.
 *
 * **No agreement threshold, on purpose.** M4 measured coverage using a 2/3 cut,
 * but the band carries the badge of the trap it came from, and that badge is
 * what lets the reader weigh a 1/5 headline. Gating instead of labelling would
 * make the screen say "no trap that changes the outcome" about a market that has
 * one -- an empty state that lies, which section 7 forbids. Below three readings
 * `seloDeConfirmacao` already refuses to print a fraction at all.
 *
 * The chosen finding comes back whole, narrowed so the caller cannot render a
 * verdict with missing prose. Does not modify the input.
 */
export function escolherVeredito<T extends Veredicavel>(
  achados: readonly T[],
): (T & { descricao: string; cenario: string }) | null {
  let melhor: T | null = null;

  for (const a of achados) {
    if (!ehArmadilhaDeResultado(a)) continue;
    if (!prosa(a.descricao) || !prosa(a.cenario)) continue;

    if (
      melhor === null ||
      a.vezes_encontrado > melhor.vezes_encontrado ||
      (a.vezes_encontrado === melhor.vezes_encontrado &&
        normalizarTrecho(a.trecho ?? '').localeCompare(normalizarTrecho(melhor.trecho ?? '')) < 0)
    ) {
      melhor = a;
    }
  }

  return melhor as (T & { descricao: string; cenario: string }) | null;
}
