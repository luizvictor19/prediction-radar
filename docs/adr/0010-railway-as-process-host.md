# 0010 · Railway as the process host

- **Status**: accepted (documenting an existing decision)
- **Date**: 2026-11-03, recorded retrospectively. The decision dates from the start of the project.

## Context

The collectors and jobs run on cron schedules, from seconds to weekly, inside one long-running
Node process. Hosting it should take no server administration.

## Decision

Railway runs the process, configured by `railway.toml`: nixpacks builder, restart on failure
with up to 3 retries. The start command is `npm start`, which is `tsx src/index.ts`, with no
build step. Variables are set in the Railway dashboard.

## Consequences

- No infrastructure to run, and no build to keep in sync.
- How deploys are triggered and how the bot is run as a service live in the Railway dashboard,
  not in this repository; check there before stating either.
- The Node version follows `.nvmrc`, which moves from 20 to 24 with the CI work.
