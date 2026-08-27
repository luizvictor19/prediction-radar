# The research record

Three months of asking whether an LLM agent could out-forecast a prediction
market. Eight hypotheses, each a real attempt with a death criterion declared
before the measurement. All eight closed negative.

This document is kept because the negatives are the expensive part. Each one
carries the number that killed it, so the door it closed stays closed for a
reason someone can check rather than for a reason someone remembers.

Every number here is dated. Nothing in this file is re-measured on a schedule:
it is a record of what was true when it was measured, not a dashboard.

---

## The eight hypotheses

| # | hypothesis | what killed it |
| --- | --- | --- |
| 1 | The agent forecasts better than the price | skill **−0.029** at n=167 |
| 2 | Favorite–longshot bias | same bucket +0.027 at T-360, −0.071 at T-60: sign flips are noise |
| 3 | Correcting the agent's bias | the market carries the same bias (+0.028 vs +0.029): it's sample composition |
| 4 | A live in-play agent | the live *market* scores 0.016–0.113; the agent scores 0.176 |
| 5 | Tail events in count markets | overdispersion is real (27.8× Poisson) **and already priced**: implied-SD z of 0.936 / 1.090 |
| 6 | Reading logical relations between markets | reads at 9.5% refutation, but relations concentrate in table-tennis handicaps |
| 7 | News lead-lag between linked markets | spread is cheap (0.90¢) but **depth is US$ 11–15** on the slow side |
| 8 | Composite markets outside Fréchet bounds | ~3,836 composites exist; **the legs do not**: the venue lists the product, not the parts |

The pattern across all eight is one sentence:

> **Where this market has size, it is efficient. Where it is inefficient, it has
> no size.**

That is not eight pieces of bad luck. It is eight measurements of one fact:
market efficiency is proportional to attention, and attention is proportional to
the money available.

Detail on 6, 7 and 8 is worth keeping:

**6.** 219 model calls, US$ 5.19, 927 proposed relations graded automatically
against resolved outcomes. Two defects found in passing: the taxonomy has no
negation, so "A implies **not** B" gets mislabelled; and 8.3% of generated groups
contained the same market twice, which made 62 of 95 `equivale` relations a
comparison of a market with itself.

**7.** The probe measured the cost of entry before measuring the lag. Of 12
tradeable pairs, the only two with real depth sit inside the 2028 Democratic
nomination partition, exactly where a lag cannot exist.

**8.** A full sweep of 134,026 open markets. "Both Teams to Score" is listed;
"Team A scores" is not. There is nothing for the bound to bind against, and that
is structural, not scarcity.

---

## Results

**The agent does not beat the price.** Reported because reporting a negative
result is the point of building the harness.

At n = 167 scorable forecasts (2026-08-13):

| forecaster        | Brier  | skill vs market |
| ----------------- | ------ | --------------- |
| agent             | 0.1762 | −0.029          |
| market at `as_of` | 0.1712 | n/a             |
| 50/50             | 0.2500 | −0.460          |

**By prompt version.** `v2` introduced an explicit source hierarchy:

| version | n  | agent  | market | skill  |
| ------- | -- | ------ | ------ | ------ |
| v1      | 93 | 0.1500 | 0.1405 | −0.068 |
| v2      | 74 | 0.2091 | 0.2098 | **+0.004** |

`v2` reaches parity, which is a real change. The sample cannot support the claim
that the prompt caused it: `v2`'s sample is harder (the *market* scores 0.2098
on it versus 0.1405 on `v1`'s) and it is easier to tie a price that is itself
close to a coin flip. **Parity is not edge.**

The hierarchy did change behaviour, measurably: citations of the venue's own
LLM-generated blurb fell from 58.1% to 3.4%, and citations of measured
head-to-head and recent form rose from 0.6% to 64.0%.

**Is the market itself miscalibrated?** Measured separately, on a market-centric
dataset with no agent and no gate: 267 matches, 443 rows. Market ECE is 0.0709 on
the team-A axis and 0.0931 on the label-free favourite axis, so the price *is*
wrong, by 7–9 percentage points per bucket. It is not, however, *biased*: on the
favourite axis the conclusive buckets read +0.012, +0.142, −0.205, −0.042,
+0.162. Signs alternate between neighbours, which is noise. One bucket survives a
temporal split, and its observed rate (52.4%) equals the base rate of the side
labelled "team A" (52.1%), a labelling artifact.

**What "beating the market" would have to mean.** The eval compares against the
mid; trading happens against the ask. With a mid of 0.50 and a 0.01 spread, an
estimate of 0.505 is "better than the market" and still loses money. The bar is
not skill > 0: it is skill positive by enough to clear the spread, on a subset
declarable *before* the outcome is known. No band clears it.

**Fidelity.** 802 recorded claims, 802 pointing at a fragment actually in the
prompt, zero analyses discarded in validation. Enforced structurally: a claim
citing a label that was never supplied causes the whole analysis to be dropped.

---

## Findings

Things that turned out not to be what they looked like. Measured, not assumed.
These are mostly infrastructure defects, and they are kept for the same reason as
the negative hypotheses: each one is a mistake that is cheap to repeat.

**The market scan never saw what it thought it saw.** The system paginated an
"active markets" feed believing it covered ~46,000 markets. The API has a hard
offset ceiling of 2,000 regardless of ordering. Every downstream decision had
been made on a false premise. A later census by calendar bisection put the real
open universe at **134,026**.

**Ordering by volume is blind to the thing you want.** Switching discovery to
creation-date ordering found 60 of 61 new esports markets in one hour, versus 1
by the volume sweep. All 60 had `volume_24h = 0`.

**Index bloat, not data.** A snapshot table showed 2,087 MB. The heap was 80 MB;
a single B-tree index held 1,492 MB. Delete-in-cycle frees heap pages but never
index pages. The permanent fix was partitioning.

**Silent failure is the expensive kind.** A collector was stuck for 48 hours,
skipping every cycle on a lock it never released, logging nothing: the failure
mode was a fetch that hung rather than threw, so `finally` never ran. A component
that stops reporting looks identical to one with nothing to report; hence
heartbeats.

**A migration can report success while failing.** The partitioning migration ran
green: its `INSERT … SELECT` ran before the partitions were created, the rows
landed in `_default`, creating the correct partition then failed against it, and
the error was swallowed by an `EXCEPTION WHEN others` that returned it in a jsonb
nobody read.

**Retention was destroying the asset.** The cleanup deleted price snapshots for
any market whose event had resolved, with no age condition: features and label
erased together, at the moment they became complete. Of 1,755 resolved matches
probed for recoverable history, **zero** have a usable series. The bug was never
fixed, only given an esports exception; anything entering without one repeats it.

**An empty order book has a mid of 0.50 by arithmetic.** Not by consensus. In one
probe, 36 of 346 market-instants had price sums up to 4.53; removing them moved a
headline gap from +0.1306 to −0.0058 and every bucket calibrated.

**A guard that duplicates an existing guard is not free.** Requiring a two-sided
book to avoid empty-book artifacts excluded **205 high-liquidity markets** (median
US$ 292k, up to 1.8M) and protected against **zero** empty books: the liquidity
floor already did that. The trap was real; it was just already guarded.

**The venue already publishes half of what you'd build.** Match payloads carry
team objects with canonical names and provider IDs, league, tier, scheduled
start. Weeks of planned entity-resolution collapsed into reading fields, after
measuring that the abbreviation matched the slug code in 2,307 of 2,307 cases.

**A query that reads is still a query that can fall over.** A retention job took
the database down with a `LIKE ANY` whose patterns came from a variable, so the
prefix index went unused and what remained was a sequential scan of 711 MB. Read
access is not the same as safe access.

---

## What this record is for

The thesis these eight hypotheses failed to support has been replaced, and the
replacement is described in the [README](../README.md). The short version: the
project stopped trying to out-forecast the price and started reading the text
that decides resolution.

The eight negatives are the argument for that change. They are the reason the
current system finds and records instead of predicting.
