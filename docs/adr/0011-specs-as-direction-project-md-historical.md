# 0011 · Specs and `docs/context.md` give the direction; `PROJECT.md` is historical

- **Status**: accepted (documenting an existing decision)
- **Date**: 2026-11-03, recorded retrospectively. The decision dates from 2026-08-04, when `CLAUDE.md` first flagged `PROJECT.md` as outdated.

## Context

`PROJECT.md` describes the system as of May 2026 (v7): tables, detectors, collectors and bot
commands. The strategy changed twice after that (the containment spec in August, then the radar
pivot of 0003), and a session reading `PROJECT.md` as direction would build the wrong thing.

## Decision

What to do now comes from the open issues, the numbered specs in `specs/` and
`docs/context.md`. `PROJECT.md` and `CONTEXTO-RADAR.md` stay as historical records, each pointing
to `docs/context.md` at the top; their bodies are not rewritten as if they were current.

## Consequences

- One place to read before planning: `docs/context.md`.
- The historical files keep their value for understanding how the system was built.
- When the direction changes, `docs/context.md` changes with it, and a decision with lasting
  consequences gets an ADR.
