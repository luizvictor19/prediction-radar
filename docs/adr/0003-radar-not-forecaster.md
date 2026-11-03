# 0003 · A radar, not a forecaster: the human judges, the system records

- **Status**: accepted (documenting an existing decision)
- **Date**: 2026-11-03, recorded retrospectively. The decision was made on 2026-08-13 and 2026-08-14.

## Context

Three months went into asking whether an LLM agent could out-forecast a prediction market.
Eight hypotheses were measured, each with a death criterion, and all eight closed negative; the
analyst agent scored a skill of -0.029 over n=167 against the price (`README.md`,
`docs/research-record.md`). The working thesis that survived is that a market prices the headline
and resolves by the rule, and that the gap is a reading problem, not a forecasting one.

## Decision

The system stops deciding. It collects a roster of markets, keeps their price series, digests
the resolution rules, and shows them to Luiz, who records his own probability (`my_bets.prob_self`)
before the outcome. The measurement code in `src/eval/` compares his Brier score with the
market's. The analyst, the OddsPapi enricher and the esports pipeline were turned off by flag,
not deleted.

## Consequences

- The product is the series plus the human's recorded judgement; without recorded
  probabilities there is nothing to measure (0 of 58 rows on 2026-08-24, `npm run medir:serie`).
- Generic detectors are switched off, not extended.
- Turned-off code stays in the repository and its data stays in the database.
- Any return to automated forecasting needs new evidence and a new ADR.
