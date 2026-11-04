# 0006 · Rule digestion keyed by content hash and prompt version

- **Status**: accepted (documenting an existing decision)
- **Date**: 2026-11-03, recorded retrospectively. The decision dates from migration `20260815213832_digestao_de_regras.sql`.

## Context

Each market has a resolution rule text (median 1,262 characters). An LLM reads it into
structured fields. Rules rarely change, LLM calls cost money, and a prompt change must not be
mixed with the readings made under the previous prompt.

## Decision

A digestion is stored in `market_rule_digests` under `(event_id, description_sha256, model,
prompt_version)`, with `leitura_n` counting repeated readings. The text is identified by its
full sha256, so an unchanged rule is digested once and reused. `model` and `prompt_version` are
written per row, not inferred from config at read time. The active version lives in
`system_config` (`digest_prompt_version`, defaulted in `src/lib/config.ts`); the analyst uses
the same pattern (`analyst_prompt_version`, `src/verticals/analyst-prompts.ts`).

## Consequences

- Old and new prompt versions coexist, so evaluation can cut by version.
- Bumping a prompt means re-digesting what the new version should cover.
- `leitura_n` is still computed when planning a run, against a frozen snapshot, so a concurrent
  load can collide; this is known debt (`docs/context.md`).
