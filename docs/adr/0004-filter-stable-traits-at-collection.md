# 0004 · Filter stable traits at collection, volatile traits in views

- **Status**: accepted (documenting an existing decision)
- **Date**: 2026-11-03, recorded retrospectively. The decision dates from the radar collector, migration `20260813224149_coletor_radar.sql`.

## Context

The radar roster decides which markets get a price series. A filter on something that moves
(price, volume, spread) removes a market from the roster exactly when it moves, which is the
event the series exists to capture.

## Decision

Traits that do not change, such as category, are filtered when collecting. Traits that change,
such as price, minimum volume or description length, become `where` clauses in the radar views,
never a reason to stop collecting. Topic is a column, not a filter: grouping related markets is
the measurement's problem.

## Consequences

- The roster is larger than what the screen shows; disk, not the API, sets the ceiling, and the
  ceiling comes from measurement.
- Changing a view threshold never loses history.
- Every filter counts and reports what it dropped, with a reason.
