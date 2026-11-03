# 0009 · grammy as the Telegram bot library

- **Status**: accepted (documenting an existing decision)
- **Date**: 2026-11-03, recorded retrospectively. The decision dates from the bot's first commit, 2026-05-03.

## Context

The bot is how Luiz registers positions and receives alerts. Two libraries entered
`package.json`: `grammy` (with `@grammyjs/conversations`) and `node-telegram-bot-api`.

## Decision

The bot is written on `grammy`. Every file under `src/bot/` imports it; nothing in `src/`,
`scripts/` or `web/src` imports `node-telegram-bot-api`. `src/telegram/bot.ts` is an early stub
that is not wired to anything.

## Consequences

- Conversations (multi-step flows such as register) use `@grammyjs/conversations`.
- `node-telegram-bot-api` and its types are dead dependencies that still pull Dependabot
  updates; removing them, and the `src/telegram/` stub, is cleanup work for its own PR.
