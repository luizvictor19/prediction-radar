/**
 * Which text the right-hand column shows, and whether it may highlight on it.
 *
 * Pure: it takes the two loading states and returns the decision. It does not
 * know what React is and it does not fetch. Split out of `Regra.tsx` for the
 * same reason as `destaque.ts` -- the rule is testable without a browser and
 * without a database, and inside a `useEffect` it is not.
 *
 * ## The two questions the screen was answering as one
 *
 * 1. **Is this text the one that produced these findings?** Answered by the
 *    hash, and the screen already answered it.
 * 2. **Does the text that produced these findings still exist anywhere?**
 *    Before `market_rule_texts` this one had no possible answer: the database
 *    kept `description_sha256` and never the text, so "the current description
 *    is a different one" implied "the digested version is gone". Both came out
 *    as the same sentence.
 *
 * With the text stored they come apart, and the difference is the one that
 * matters to a reader: a span that does not match is an anchor failure, and a
 * document that does not exist is a storage failure. Blaming the anchor for a
 * missing document is exactly what issue #9 calls an expired guarantee.
 */

/** What reading `events.description` -- the CURRENT description -- returned. */
export type DescricaoAtual =
  | { fase: 'lendo' }
  | { fase: 'ausente' }
  | { fase: 'erro'; motivo: string }
  | { fase: 'lido'; texto: string; sha: string };

/**
 * What querying `market_rule_texts` returned for THIS block's hash.
 *
 * `ausente` is an answer -- "I asked and it is not there" -- and it is the only
 * one that lets the screen say the digested text is not stored. `erro` is "I
 * could not ask", and the two must not print the same thing.
 */
export type TextoGuardado =
  | { fase: 'lendo' }
  | { fase: 'ausente' }
  | { fase: 'erro'; motivo: string }
  | { fase: 'guardado'; texto: string };

/**
 * The decision.
 *
 * `guardado` and `atual` are the two states where the column CAN highlight: in
 * both, the text on screen is provably the one that produced the findings --
 * in one because the database stored it under the hash, in the other because
 * the current description's hash was checked and matched.
 *
 * `nao-guardado` is the new state: the findings came from a version of the rule
 * nobody stored, and the current description is a different document. The
 * column shows the current document WITHOUT highlights and says what happened.
 */
export type Regulamento =
  | { fase: 'lendo' }
  | { fase: 'guardado'; texto: string }
  | { fase: 'atual'; texto: string }
  | { fase: 'nao-guardado'; atual: string }
  | { fase: 'ausente' }
  | { fase: 'erro'; motivo: string };

export function escolherRegulamento(
  shaDoBloco: string,
  atual: DescricaoAtual,
  guardado: TextoGuardado,
): Regulamento {
  // The stored text comes first, unconditionally. It is fetched BY the block's
  // hash, so being this text is a property of the query rather than a
  // conclusion drawn here -- and it goes on existing after Polymarket edits the
  // description, which is the entire reason the table exists.
  if (guardado.fase === 'guardado') return { fase: 'guardado', texto: guardado.texto };

  // A current description whose hash checks out is the SAME document, proven.
  // Holding the column on a spinner waiting for `market_rule_texts` would be
  // waiting for a second copy of the text already in hand.
  if (atual.fase === 'lido' && atual.sha === shaDoBloco) {
    return { fase: 'atual', texto: atual.texto };
  }

  // From here down the current description is no good for highlighting. While
  // either read is unfinished the answer is "loading" -- and that is not a
  // courtesy: deciding here announces "the digested text is not stored" an
  // instant before the stored text arrives.
  if (guardado.fase === 'lendo' || atual.fase === 'lendo') return { fase: 'lendo' };

  // "I could not ask" never becomes "I asked and it is not there". The stored
  // lookup's error surfaces only here, after the current description has
  // already failed to serve -- when it does serve, nobody needs to hear that
  // the other read fell over.
  if (guardado.fase === 'erro') return { fase: 'erro', motivo: guardado.motivo };

  if (atual.fase === 'erro') return { fase: 'erro', motivo: atual.motivo };

  // No stored text and no current description: there is no document at all to
  // put on screen. Still different from "the span was not found".
  if (atual.fase === 'ausente') return { fase: 'ausente' };

  return { fase: 'nao-guardado', atual: atual.texto };
}
