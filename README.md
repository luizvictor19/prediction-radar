# Prediction Radar

A research system that investigates whether a **systematic, exploitable opening**
exists in prediction markets — and measures each hypothesis until it either
survives or dies.

The interesting question isn't "can an LLM write a plausible match preview" — it
can. It's whether any of this produces a number the market doesn't already
publish. This repository is mostly the machinery required to answer that
honestly, plus a record of the answers.

**Status: eight hypotheses tested, eight negative.** Each one is below, with the
measurement that killed it. The harness that produced those numbers is the part
worth reading.

---

## Why this exists

Prediction markets publish a probability for every event. That number is a strong
baseline — aggregated, incentive-aligned, continuously updated. Beating it
requires either information the market prices poorly, or a computation nobody
bothers to run.

The project started narrow: esports, where the mispriced information tends to be
**textual and unstructured** — last-minute roster changes, stand-ins, visa
problems, a team already qualified and playing with nothing at stake. Statistical
models don't read those. Language models might.

They didn't. So the project widened into a general question — *where, if
anywhere, is there an opening?* — and the answer to each attempt is recorded
rather than quietly dropped.

The discipline is the point: **every hypothesis carries a death criterion
declared before the result.**

---

## Architecture

Six components, each with its own lock, cron, heartbeat, and kill switch in
config.

```
discovery ──► watchlist ──► resolver ──► enricher ──► analyst ──► eval
   3 min        5 s          10 min       5 min      2/match    on demand
```

**discovery** — finds markets the moment they open, ordered by creation date
rather than volume. This distinction is the whole ballgame: esports markets are
born with zero volume, so a volume-ranked sweep is structurally blind to them
until the price has already formed.

**watchlist** — price snapshots at a cadence anchored on actual match start time:
12 s while a match is live, 1 min within 6 h, 5 min beyond. Derivative markets
(handicaps, totals) run at a fraction of that.

**resolver** — turns `cs2-navi-vit-2026-05-03` into "Natus Vincere vs Vitality,
IEM Cologne, BO3". Two paths: exact, from the team objects the API now exposes;
and a slug parser as fallback for anything predating that.

**enricher** — assembles per-match context into an append-only,
point-in-time-safe store.

**analyst** — reads the context at a fixed checkpoint (T-6h, T-1h) and produces a
probability, a thesis, and per-claim traceability to the fragments that support
it. Or abstains, with a recorded reason.

**eval** — scores every forecast against the outcome, with the market price as
the baseline that matters.

Alongside these, a growing set of **probes** — single-purpose scripts that size a
hypothesis before anything is built for it. Several of the negative results below
cost minutes because a probe ran first.

---

## The part that took the most care: point-in-time correctness

A backtest that can see the future is worse than no backtest, because it produces
confident numbers that are wrong. Three mechanisms defend against it:

**`as_of` and `observed_at` are different columns.** When a fact was true is not
when we learned it. Replay filters on `observed_at`, never `as_of` — a source
that backfills would otherwise leak information that didn't exist at decision
time.

**`observed_at` is not forgeable.** A `BEFORE INSERT` trigger stamps it with the
server clock, overwriting whatever the client sends. The residual error has a
known direction and it's the harmless one: the server stamp is always ≥ the real
fetch, so replay considers *less* than we knew. Underestimating knowledge is
conservative.

**The context store is append-only, enforced by the database.** The same trigger
raises on `UPDATE` — which catches `UPSERT` too, the most likely way the mistake
gets in unnoticed. `DELETE` stays open because retention needs it: truncating the
end of a series shortens history, rewriting the middle corrupts it.

Each enricher declares `supportsPointInTime`. Sources that can't honestly claim
it are refused in replay — both when the caller asks, and when `asOf` is in the
past even if nobody asked. That second guard is the one that protects against
forgetting.

---

## Hypotheses tested

Each of these was a real attempt at an edge, with a death criterion written
before the measurement. All seven are closed negative. The value of the list is
that the reasons differ.

**1. The agent forecasts better than the price.** The original thesis. At n = 167
scorable forecasts, skill vs market is **−0.029** — the agent loses. Numbers in
the section below.

**2. Favorite–longshot bias.** The classic sportsbook distortion, if it existed
here, would be mechanically tradeable. Two independent falsifications: the same
price bucket scored +0.027 at T-360 and −0.071 at T-60. Sign flips between
neighbouring buckets are the signature of noise, not of a tilted market.

**3. Correcting the agent's bias.** Cheapest possible fix — subtract a constant.
It fails for an instructive reason: **the market carries the same bias, in the
same direction and magnitude** (agent +0.029, market +0.028). What both are
measuring is sample composition — how often the side labelled "team A" happened
to win — not a defect in the agent. Estimated on the first half of the calendar
and charged to the second, the correction moves Brier by 0.0002.

**4. A live in-play agent.** Killed by measurement before it was built. The live
*market* scores Brier 0.016 under 5 minutes to resolution and 0.113 over 60 — the
pre-match agent scores 0.176. The thing to beat was already better than the thing
proposed.

**5. Tail events in count markets.** Elon Musk posting-rate markets. Posting is
genuinely overdispersed — variance measured at 27.8× the Poisson expectation over
284 days — but the market prices it: implied-SD z-scores of 0.936 and 1.090,
within ±10% of correct. The anomaly is real and already in the price.

**6. Reading logical relations between markets.** The task changes from
*predicting* to *reading*: find pairs where `A implies B`, then check whether
prices respect the constraint. 219 model calls, US$ 5.19, 927 proposed relations
graded automatically against resolved outcomes. Refutation rate **9.5%** — but
the relations concentrate in table-tennis handicaps, the most arbitraged corner
available, because the free answer key (resolved markets) selects for markets
that resolve within days. Two defects found in the process: the taxonomy has no
negation, so "A implies **not** B" gets mislabelled; and 8.3% of generated groups
contained the same market twice, which made 62 of 95 `equivale` relations a
comparison of a market with itself.

**7. News lead-lag between linked markets.** If a headline market reprices in
seconds and a logically linked, less-watched market takes hours, the lag is
tradeable. The probe measured the cost of entry before measuring the lag: median
spread on the slow side is **0.90¢** — cheap — but median **depth at top of book
is US$ 15**, and US$ 11 in the subset where a 2–4¢ move is arithmetically
possible. Of 12 tradeable pairs, the only two with real depth sit inside the 2028
Democratic nomination partition, which is exactly where the lag cannot exist.

**8. Composite markets priced outside their Fréchet bounds.** If "A and B" trades
below `P(A) + P(B) − 1`, that is arithmetically impossible and requires no
forecast at all. A full sweep of **134,026 open markets** found ~3,836 genuine
composites — far more than expected. **Zero of them are tradeable, because the
legs do not exist.** "Both Teams to Score" is listed; "Team A scores" is not.
"Republicans sweep the Michigan Senate and Governor elections" is listed; the
individual Senate market is a ten-bucket margin ladder and there is no governor
market at all. The venue lists the *product*, not the *parts*, so there is
nothing for the bound to bind against — this is structural, not scarcity. The 10
composites that could be priced carry median depth of US$ 22 and a 3¢ spread,
which would have killed it a second time.

The eight share a shape:

> **Where this market has size, it is efficient. Where it is inefficient, it has
> no size.**

That is not eight pieces of bad luck. It is eight measurements of the same fact —
market efficiency is proportional to attention, and attention is proportional to
the money available.

---

## Findings

Things that turned out not to be what they looked like. These are measured, not
assumed.

**The market scan never saw what it thought it saw.** The system paginated an
"active markets" feed believing it covered ~46,000 markets. The API has a hard
offset ceiling of 2,000, regardless of ordering — no parameter works around it.
Every architectural decision downstream had been made on a false premise. A later
census by calendar bisection put the real open-market universe at **133,543** —
67× the figure a spec had assumed.

**Ordering by volume is blind to the thing you want.** Switching discovery to
creation-date ordering: 60 of 61 new esports markets found in one hour, versus 1
by the volume sweep. All 60 had `volume_24h = 0` and median liquidity around
US$ 17 — below every threshold the old system filtered on.

**Index bloat, not data.** A snapshot table showed 2,087 MB. The heap was 80 MB;
a single B-tree index held 1,492 MB. Delete-in-cycle frees heap pages but never
index pages. Rebuilding recovered 96% of the table. The permanent fix was
partitioning, so retention becomes `DROP PARTITION` instead of `DELETE`.

**Silent failure is the expensive kind.** A collector had been stuck for at least
48 hours, skipping every cycle on a lock it never released. No error was logged,
because the failure mode was a fetch that hung rather than threw — `finally`
never ran. The fix was `AbortSignal` timeouts plus lock takeover on staleness;
the lesson was that a component which stops reporting looks identical to one with
nothing to report, and the system now has heartbeats to tell them apart.

**Retention was destroying the asset.** The cleanup routine deleted price
snapshots for any market whose event had resolved, with no age condition. Matches
resolve hours after they end — so the pre-match series and the in-play series,
features and label together, were erased at exactly the moment they became
complete. The damage is permanent and quantified: of 1,755 resolved matches
probed for recoverable history, **zero** have a usable price series.

**An empty order book has a mid of 0.50 by arithmetic.** Not by consensus. In one
calibration probe, 36 of 346 market-instants had price sums up to 4.53; removing
them moved a headline gap from +0.1306 to −0.0058, and every bucket calibrated.
The finding had been an artifact of dividing by nothing.

**The venue already publishes half of what you'd build.** Match payloads carry
team objects with canonical names, abbreviations, and provider IDs; league, tier,
and tournament; scheduled start; and an LLM-generated context paragraph. Weeks of
planned entity-resolution work collapsed into reading fields — after measuring
that the team abbreviation matched the slug code in 2,307 of 2,307 cases.

---

## Results

**The agent does not beat the price.** Reported because reporting a negative
result is the point of building the harness.

At n = 167 scorable forecasts (2026-08-13):

| forecaster        | Brier  | skill vs market |
| ----------------- | ------ | --------------- |
| agent             | 0.1762 | −0.029          |
| market at `as_of` | 0.1712 | —               |
| 50/50             | 0.2500 | −0.460          |

Both beat the coin flip decisively. The agent does not beat the market, and
without that there is no edge — the rest is diagnosis.

**By prompt version.** `v2` introduced an explicit source hierarchy telling the
model which evidence outranks which:

| version | n  | agent  | market | skill  |
| ------- | -- | ------ | ------ | ------ |
| v1      | 93 | 0.1500 | 0.1405 | −0.068 |
| v2      | 74 | 0.2091 | 0.2098 | **+0.004** |

`v2` reaches parity with the price, which is a real change from `v1`. The sample
still cannot support the claim that the prompt caused it: the `v2` sample is
**harder** — the *market* scores 0.2098 on it versus 0.1405 on `v1`'s — and it is
easier to tie a price that is itself close to a coin flip. Parity is not edge.

The hierarchy did change behaviour, measurably: citations of the venue's own
LLM-generated blurb fell from 58.1% to 3.4%, and citations of measured
head-to-head and recent form rose from 0.6% to 64.0%.

**By liquidity:**

| band      | n  | skill  |
| --------- | -- | ------ |
| 5k–20k    | 71 | −0.073 |
| 20k–100k  | 43 | +0.006 |
| ≥ 100k    | 53 | −0.005 |

The agent is worst in the band immediately above the gate's US$ 5,000 floor. Thin
markets move on noise, and the agent grounds a share of its claims in price
movement — it is reading noise as signal. Raising the floor has to be run
forward: raising it *because* a band scored badly in one sample is choosing on
the outcome.

**Calibration.** ECE 0.0759, global bias +0.029 — against a market ECE of 0.0700
and a market bias of +0.028, which is why the bias is read as sample composition
rather than agent optimism. Murphy decomposition gives resolution 0.0772 against
uncertainty 0.2496, so the quiet failure mode — answering ~0.5 to everything,
scoring acceptably, being useless — is not what is happening.

**Is the market itself miscalibrated?** Measured separately, on a market-centric
dataset with no agent and no gate: 267 matches, 443 rows. Market ECE is 0.0709 on
the team-A axis and 0.0931 on the label-free favourite axis — so the price is
*wrong*, by 7–9 percentage points per bucket. It is not, however, *biased*: on the
favourite axis the conclusive buckets read +0.012, +0.142, −0.205, −0.042,
+0.162. Signs alternate between neighbours, which is noise. One bucket survives a
temporal split, and its observed rate (52.4%) equals the base rate of the side
labelled "team A" (52.1%) — a labelling artifact, not a market error.

**A note on what "beating the market" would have to mean.** The eval compares
against the mid. Trading happens against the ask. With a mid of 0.50 and a 0.01
spread, an estimate of 0.505 is "better than the market" and still loses money.
So the operational bar is not skill > 0; it is skill positive by enough to clear
the spread, on a subset declarable *before* the outcome is known. No band above
clears it.

**Fidelity.** 802 recorded claims, 802 pointing at a fragment that was actually
in the prompt, zero analyses discarded in validation. The model is not inventing
citations. That is enforced structurally: a claim citing a label that was never
supplied causes the whole analysis to be dropped rather than stored.

---

## Engineering notes

Decisions that were less obvious than they look, kept short.

**Cost guardrails come before capability.** The analyst is the only component
that spends money per cycle, so it's the only one that ships disabled by default.
A model without a known price refuses to run — a spend ceiling that can't count
is worse than none, because it looks like it works.

**Abstention is a design feature, not a fallback.** Markets with a 0.90 spread
and US$ 67 of liquidity have no formed price to disagree with. Analysing them
pollutes the eval with noise. The gate records why it refused; the distribution
of reasons is the evidence that lets the thresholds be tuned later.

**Fingerprint before spend.** If the fragment set hasn't changed since the last
run, the call is skipped. Deterministic, no infrastructure.

**Every discard is counted, with its reason.** A sample that shrinks quietly is
how an eval lies. Coverage tables reconcile every row read against either the
metric or an exclusion reason, and probes report what each filter layer dropped.
This caught a 29% silent discard in one probe and a 10% dropped stratum in
another, both of which would have produced confident wrong answers.

**One flag governs three consumers.** The vertical prefix list drives discovery,
watchlist, and resolver candidates. Retention has its own embedded default,
because turning off collection must not authorise deleting its history.

**Every long-running component reports a heartbeat.** Health alerting reads the
heartbeat table, not the log — a collector with nothing to do writes nothing, and
a monitor reading logs would alarm forever.

**Probes before construction.** Single-purpose scripts that size a hypothesis
against reality before code is written for it. Three of the seven dead
hypotheses above cost under an hour each because the probe ran first; the
quota-burn fix that took daily API spend from 32 to 2.3 calls came out of the
same habit.

---

## Stack

TypeScript on Node (ESM, no build step), Supabase/Postgres, Railway, Telegram.
Data from the Polymarket Gamma and CLOB APIs. LLM calls through a thin provider
interface so the model is a config value, not a code dependency.

---

## Current state

Working and running: collection, entity resolution, context assembly,
forecasting, evaluation, and a probe harness.

**Open question:** whether any systematic opening exists that survives the cost
of trading it. Eight attempts say no, and the eighth closed on a structural fact
rather than a marginal number: the venue does not list the components that a
logical constraint would need in order to bind.

The most useful artifact is not any single result. It is that a wrong number was
caught on the way to each of them — a 29% silent discard, a 10% dropped stratum,
an empty book read as a 50% consensus, a leg-matcher that projected 1,918
tradeable pairs where there were none. Every one of those would have produced a
confident, wrong, actionable answer.

This is a personal research project, built solo, as the practical component of a
postgraduate program in applied AI engineering. It has no users, no revenue, and
no product. Its output is measurements, including the ones that closed doors.

---

## License

Code: MIT. Market data belongs to its respective sources and is subject to their
terms.

Nothing here is financial advice. Prediction markets are regulated differently
across jurisdictions and are restricted or prohibited in some, including Brazil.
