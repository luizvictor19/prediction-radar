# 0012 · AWS for the scheduled rule digestion

- **Status**: accepted. Amends 0010; does not supersede it.
- **Date**: 2026-11-17. The plan was approved on 2026-11-16 and the model route was decided
  on 2026-11-17 (both on issue 86).

## Context

Rule digestion is the core of the product since the decision of 2026-11-12 to slim the
project down to "rule vs headline reading", and it was the only core step that did not run
by itself: a model read a rule only when someone ran `npm run digerir` and then
`npm run carregar-digest -- --confirmar` by hand. The raw model output was dropped after
parsing, so a reading that failed validation left nothing, and the evals could not replay
one under a changed guard. The write was three separate calls with no transaction.

The plan also had to fit facts about the AWS account and the models, measured on
2026-11-16 and 2026-11-17:

- The account is on the AWS **Free plan**: US$ 100 of credit, valid until 2027-05-16. When
  the plan ends or the credit runs out, AWS suspends the account and everything running in
  it; the data is kept for 90 days and then deleted.
- On that plan, Amazon Bedrock refused Claude Haiku 5.5 with
  `ValidationException: Operation not allowed` (playground, 2026-11-17).
- PR 83 measured `claude-haiku-5-5` on the Anthropic API at a median of US$ 0.00231 per
  reading, against US$ 0.00345 for the stored `deepseek-v4-flash` readings, on the same 100
  texts. Haiku was less consistent between two readings of the same text (62.3% against
  71.0%), almost all of it in ambiguities.

## Decision

The scheduled digestion runs on AWS: an EventBridge schedule starts a Step Functions
state machine whose Map calls two Lambda functions (Node 24, bundled with esbuild): a plan
handler that builds the run, and a read handler that digests one rule per invocation. The
model is called **directly through the Anthropic API**, with `claude-haiku-5-5` as the
target, not through Bedrock; the key is a SecureString in SSM Parameter Store, next to the
Supabase key. The raw output, stop reason, token counts and cost of every call, valid or
not, go to DynamoDB with a conditional write keyed by the rule hash and the run, and a
monthly counter there caps model spend at US$ 3. Supabase stays the source of truth that
the screen and the bot read, written in one transaction per reading
(`record_rule_digest`). Railway keeps the collectors and the bot (0010).

## Consequences

- A rule is read with no manual step, and a Step Functions retry does not pay twice for the
  same reading: the read handler replays the stored raw output instead of calling again. The
  exception is a failed write of the raw item itself; then the retry pays again, and both
  calls are counted against the cap.
- A reading that keeps failing validation is paid for again on every run until it passes:
  failures are not remembered across runs. The cap bounds the cost, and a daily rotation of
  the queue keeps such markets from taking every run.
- Every billed output is kept, so the evals can replay readings under a changed guard.
- The model choice is a route table (`src/llm/registry.ts`), not code: a model with no
  route stops the run with `CONFIG_ERROR` before any paid call. Moving to Bedrock later is
  an adapter and a route, not a redesign.
- The model is billed by Anthropic, outside the AWS credit and outside the AWS Budgets
  alarm; the cap in code is what bounds it.
- The schedule lives in an account on the Free plan, which stops on 2027-05-16 at the
  latest. Keeping it running past that date requires upgrading the account before then.
- The process now has two hosts, and the Lambda has a build step (`npm run build:lambda`)
  that the Railway process does not.
- Switching `system_config.digest_model` to `claude-haiku-5-5` re-reads the roster under
  the new model key (0006): at most 800 readings, about US$ 1.85, over about 8 days. The
  DeepSeek readings stay in the database.
