# 0005 · `radar_tracked` only grows

- **Status**: accepted (documenting an existing decision)
- **Date**: 2026-11-03, recorded retrospectively. The decision dates from migrations `20260813210119_retencao_protege_radar.sql` and `20260813224150_retencao_manual_protege_radar.sql`.

## Context

The retention job has a `finalized` branch that deletes the series of a resolved event with
no age condition, at the moment the outcome makes that series valuable. Of 1,755 resolved
matches probed for recoverable history, zero had a usable series (`docs/research-record.md`).
The branch was worked around, never fixed.

## Decision

`events.radar_tracked` is a protection mark. The radar collector sets it and nothing unsets
it: a market that leaves the roster because it resolved keeps the mark, and retention skips
marked events (`src/collectors/radar-collector.ts`, `NUNCA_DESMARCAR`).

## Consequences

- The protected set grows without bound; disk is the cost, and it is accepted.
- Unmarking an event, by code or by hand, is data loss and needs its own decision.
- The retention bug remains; any new retention path must respect the mark.
