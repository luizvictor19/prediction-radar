# 0007 · A boilerplate gate on rule defects that every market carries

- **Status**: accepted (documenting an existing decision)
- **Date**: 2026-11-03, recorded retrospectively. The decision was made on 2026-08-22.

## Context

The rule screen lists defects found in each rule text. Some defects come from phrases that
nearly every Polymarket rule shares (for example a vague "consensus of credible reporting"
source, or a time without a time zone), so they are platform boilerplate, not a trait of the
market, and they drowned the defects that matter.

## Decision

A defect whose `(type, masked passage)` pair appears in at least 20% of the rule texts read is
moved to a collapsed group, shown with its frequency. The 20% cut sits in a measured valley of
the distribution (`npm run medir:tela-regra`, 267 texts on 2026-08-22). The gate lives in
`web/src/lib/boilerplate.ts` and does not delete, recount or write anything.

## Consequences

- The frequency itself becomes context for the operator.
- The cut must be re-measured as the corpus grows; it is a measurement, not a constant.
- Bands that bypass the gate are open work, tracked in issues.
