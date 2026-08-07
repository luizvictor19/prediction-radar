# Prediction Radar

A research system that collects esports prediction-market data and tests whether an
LLM agent can produce **better-calibrated forecasts than the market price itself**.

The interesting question isn't "can an LLM write a plausible match preview" — it can.
It's whether the forecast is *measurably* better than the number the market already
publishes. This repository is mostly the machinery required to answer that honestly.

**Status: the answer is not in yet.** The evaluation section below has the numbers.

---

## Why this exists

Prediction markets publish a probability for every match. That number is a strong
baseline — aggregated, incentive-aligned, continuously updated. Beating it requires
information the market prices poorly.

In esports, that information tends to be **textual and unstructured**: last-minute
roster changes, stand-ins, visa problems, a team already qualified and playing with
nothing at stake, map pool mismatches. Statistical models don't read those. Language
models might.

The system exists to find out, with a number rather than an impression.

---

## Architecture

Six components, each with its own lock, cron, heartbeat, and kill switch in config.

```
discovery ──► watchlist ──► resolver ──► enricher ──► analyst ──► eval
   3 min        5 s          10 min       5 min      2/match    on demand
```

**discovery** — finds markets the moment they open, ordered by creation date rather
than volume. This distinction is the whole ballgame: esports markets are born with
zero volume, so a volume-ranked sweep is structurally blind to them until the price
has already formed.

**watchlist** — price snapshots at a cadence anchored on actual match start time:
12 s while a match is live, 1 min within 6 h, 5 min beyond. Derivative markets
(handicaps, totals) run at a fraction of that.

**resolver** — turns `cs2-navi-vit-2026-05-03` into "Natus Vincere vs Vitality,
IEM Cologne, BO3". Two paths: exact, from the team objects the API now exposes; and
a slug parser as fallback for anything predating that.

**enricher** — assembles per-match context into an append-only, point-in-time-safe
store.

**analyst** — reads the context at a fixed checkpoint (T-6h, T-1h) and produces a
probability, a thesis, and per-claim traceability to the fragments that support it.
Or abstains, with a recorded reason.

**eval** — scores every forecast against the outcome, with the market price as the
baseline that matters.

---

## The part that took the most care: point-in-time correctness

A backtest that can see the future is worse than no backtest, because it produces
confident numbers that are wrong. Three mechanisms defend against it:

**`as_of` and `observed_at` are different columns.** When a fact was true is not when
we learned it. Replay filters on `observed_at`, never `as_of` — a source that
backfills would otherwise leak information that didn't exist at decision time.

**`observed_at` is not forgeable.** A `BEFORE INSERT` trigger stamps it with the
server clock, overwriting whatever the client sends. The residual error has a known
direction and it's the harmless one: the server stamp is always ≥ the real fetch, so
replay considers *less* than we knew. Underestimating knowledge is conservative.

**The context store is append-only, enforced by the database.** The same trigger
raises on `UPDATE` — which catches `UPSERT` too, the most likely way the mistake
gets in unnoticed. `DELETE` stays open because retention needs it: truncating the
end of a series shortens history, rewriting the middle corrupts it.

Each enricher declares `supportsPointInTime`. Sources that can't honestly claim it
are refused in replay — both when the caller asks, and when `asOf` is in the past
even if nobody asked. That second guard is the one that protects against forgetting.

---

## Findings

Things that turned out not to be what they looked like. These are measured, not
assumed.

**The market scan never saw what it thought it saw.** The system paginated an
"active markets" feed believing it covered ~46,000 markets. The API has a hard
offset ceiling of 2,000, regardless of ordering — no parameter works around it.
Every architectural decision downstream had been made on a false premise.

**Ordering by volume is blind to the thing you want.** Switching discovery to
creation-date ordering: 60 of 61 new esports markets found in one hour, versus 1 by
the volume sweep. All 60 had `volume_24h = 0` and median liquidity around US$ 17 —
below every threshold the old system filtered on.

**Index bloat, not data.** A snapshot table showed 2,087 MB. The heap was 80 MB; a
single B-tree index held 1,492 MB. Delete-in-cycle frees heap pages but never index
pages. Rebuilding recovered 96% of the table. The permanent fix was partitioning, so
retention becomes `DROP PARTITION` instead of `DELETE`.

**Silent failure is the expensive kind.** A collector had been stuck for at least 48
hours, skipping every cycle on a lock it never released. No error was logged, because
the failure mode was a fetch that hung rather than threw — `finally` never ran. The
fix was `AbortSignal` timeouts plus lock takeover on staleness; the lesson was that a
component which stops reporting looks identical to one with nothing to report, and
the system now has heartbeats to tell them apart.

**Retention was destroying the asset.** The cleanup routine deleted price snapshots
for any market whose event had resolved, with no age condition. Matches resolve hours
after they end — so the pre-match series and the in-play series, features and label
together, were erased at exactly the moment they became complete.

**The venue already publishes half of what you'd build.** Match payloads carry team
objects with canonical names, abbreviations, and provider IDs; league, tier, and
tournament; scheduled start; and an LLM-generated context paragraph. Weeks of planned
entity-resolution work collapsed into reading fields — after measuring that the team
abbreviation matched the slug code in 2,307 of 2,307 cases.

---

## Results

**Not enough data to say anything.** Reported because reporting a null result is the
point of building the harness.

At n = 12 scorable forecasts:

| forecaster       | Brier  | skill vs market |
| ---------------- | ------ | --------------- |
| agent            | 0.1017 | −0.011          |
| market at `as_of`| 0.1006 | —               |
| 50/50            | 0.2500 | −1.484          |

Both beat the coin flip decisively. The agent and the market are indistinguishable at
this sample size — the difference is noise, and the harness says so in the output
rather than letting the reader infer significance that isn't there.

The eval also reports the Murphy decomposition, because a Brier score alone hides the
quiet failure mode: an agent that answers ~0.5 to everything is well calibrated, scores
acceptably, and is useless. Resolution ≈ uncertainty here, so that's not what's
happening.

A plausible reading, to be tested: the agent ties the market because its only inputs
are the price and a generic summary. It has no information the market lacks. That's
the case for external sources, and it's what the current work is about.

---

## Engineering notes

Decisions that were less obvious than they look, kept short.

**Cost guardrails come before capability.** The analyst is the only component that
spends money per cycle, so it's the only one that ships disabled by default. A model
without a known price refuses to run — a spend ceiling that can't count is worse than
none, because it looks like it works.

**Abstention is a design feature, not a fallback.** Markets with a 0.90 spread and
US$ 67 of liquidity have no formed price to disagree with. Analysing them pollutes
the eval with noise. The gate records why it refused; the distribution of reasons is
the evidence that lets the thresholds be tuned later.

**Fingerprint before spend.** If the fragment set hasn't changed since the last run,
the call is skipped. Deterministic, no infrastructure.

**One flag governs three consumers.** The vertical prefix list drives discovery,
watchlist, and resolver candidates. Retention has its own embedded default, because
turning off collection must not authorise deleting its history.

**Every long-running component reports a heartbeat.** Health alerting reads the
heartbeat table, not the log — a collector with nothing to do writes nothing, and a
monitor reading logs would alarm forever.

---

## Stack

TypeScript on Node (ESM, no build step), Supabase/Postgres, Railway, Telegram.
Data from the Polymarket Gamma and CLOB APIs. LLM calls through a thin provider
interface so the model is a config value, not a code dependency.

---

## Current state

Working and running: collection, entity resolution, context assembly, forecasting,
evaluation. Two context sources are live; three external sources are under
evaluation, two of them pending access approval.

Not proven: whether the agent has any edge over the market price. That is the open
question, and the reason the evaluation harness was built before the conclusions.

This is a personal research project, built solo, as the practical component of a
postgraduate program in applied AI engineering. It has no users, no revenue, and no
product.

---

## License

Code: MIT. Market data belongs to its respective sources and is subject to their
terms.

Nothing here is financial advice. Prediction markets are regulated differently across
jurisdictions and are restricted or prohibited in some, including Brazil.
