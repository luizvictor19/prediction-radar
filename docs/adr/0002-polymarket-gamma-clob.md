# 0002 · Polymarket Gamma and CLOB as the market data source

- **Status**: accepted (documenting an existing decision)
- **Date**: 2026-11-03, recorded retrospectively. The decision dates from the start of the project (April 2026).

## Context

The system studies Polymarket markets: what they are, how their price moves, and how they
resolve. Polymarket exposes market metadata through the Gamma API and order book prices through
the CLOB API, both public and free.

## Decision

Collectors and discovery read Gamma for markets and events, and CLOB for prices and books.
The base URLs come from `POLYMARKET_GAMMA_URL` and `POLYMARKET_CLOB_URL`, with the public
endpoints as defaults (`src/lib/polymarket-api.ts`, `src/collectors/*`). Calls are batched.

## Consequences

- No API key and no cost per call; the bottleneck is disk, not the API.
- Field meaning is Polymarket's, and it has bitten more than once: `event.startDate` is a creation
  date, and Gamma's `endDate` is the scheduled date of the event, not the moment of resolution.
- Gamma `status` can disagree with what the system inferred (an open issue tracks an upsert that
  overwrites an inferred resolution).
- `events.slug` is a market slug; links to an event use `event_group_slug`.
- On Luiz's machine Polymarket only resolves with the VPN on; Railway is not affected.
