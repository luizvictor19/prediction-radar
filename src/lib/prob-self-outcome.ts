/**
 * Which outcome a recorded probability is about.
 *
 * The decision lives here, in one file, for the reason `prob-self.ts` gives
 * about the parser: the screen and the bot both have to answer it, and two
 * copies of an answer drift until they disagree. Pure TypeScript, nothing from
 * Node, because `web/` imports it by relative path.
 *
 * There are exactly three answers, and the third is the one that keeps the
 * column honest. A probability about one market must carry its side; a basket
 * has none to carry; and a market whose side is unknown must not be recorded
 * at all, because a probability with no side cannot be scored later and a
 * probability with a guessed side scores as a bet nobody made.
 */

/** What the probability is about. */
export type ProbabilitySubject =
  /**
   * One market. `outcome` is the side the person was asked about: the screen's
   * `v_radar.outcome`, or the bot's leg outcome, which can be `No`.
   */
  | { kind: 'single_market'; outcome: string | null }
  /** N markets under one thesis. No single side exists. */
  | { kind: 'basket' };

export type SideDecision =
  /** Record this label in `my_bets.prob_self_outcome`. */
  | { kind: 'label'; outcome: string }
  /** Record nothing. Deliberate, and not the same as "unknown". */
  | { kind: 'no_label' }
  /** Do not record the probability at all. */
  | { kind: 'refuse'; reason: 'market_without_side' };

/**
 * `no_label` and `refuse` are different answers and collapsing them is the bug
 * this type exists to prevent. A basket genuinely has no side, so a null is the
 * truth about it. A market with no side has one and we do not know it, so a
 * null there would be a gap wearing the same shape as the truth.
 */
export function decideSide(subject: ProbabilitySubject): SideDecision {
  if (subject.kind === 'basket') return { kind: 'no_label' };

  const outcome = subject.outcome;
  if (outcome === null || outcome.trim() === '') {
    return { kind: 'refuse', reason: 'market_without_side' };
  }

  return { kind: 'label', outcome };
}
