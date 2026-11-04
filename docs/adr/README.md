# Architecture decision records

One file per decision, numbered in the order they were recorded. A record is
never edited after the fact: a change of mind gets a new record that
supersedes the old one.

Format, kept short on purpose:

- **Status**: proposed, accepted, superseded by NNNN.
- **Date**: when the record was written. Decisions made earlier say so.
- **Context**: what was true when the decision was made.
- **Decision**: one paragraph.
- **Consequences**: what we accept as a result, good and bad.

Records 0001 to 0011 were written on 2026-11-03 to document decisions already
in force. Each one says when the decision itself was made, and cites the code,
migration or document that shows it.

| Number | Title                                                                      | Status   |
| ------ | -------------------------------------------------------------------------- | -------- |
| 0001   | Supabase Postgres, accessed through the service role                       | accepted |
| 0002   | Polymarket Gamma and CLOB as the market data source                        | accepted |
| 0003   | A radar, not a forecaster: the human judges, the system records            | accepted |
| 0004   | Filter stable traits at collection, volatile traits in views               | accepted |
| 0005   | `radar_tracked` only grows                                                 | accepted |
| 0006   | Rule digestion keyed by content hash and prompt version                    | accepted |
| 0007   | A boilerplate gate on rule defects that every market carries               | accepted |
| 0008   | The Vite dev server as the Supabase proxy for `web/`                       | accepted |
| 0009   | grammy as the Telegram bot library                                         | accepted |
| 0010   | Railway as the process host                                                | accepted |
| 0011   | Specs and `docs/context.md` give the direction; `PROJECT.md` is historical | accepted |
