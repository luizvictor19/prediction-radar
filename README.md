# Prediction Radar

A research system that spent three months asking whether an LLM agent could
out-forecast a prediction market, measured that it could not — eight times, eight
different ways — and then rebuilt itself around what the measurements actually
supported.

It is now a **radar**: it watches price on a set of Polymarket markets so a human
can judge them. The system finds and records; it decides nothing.

**Status:** collection layer rebuilt and ready; measurement phase starting.

---

## Contents

- [The question, and why it changed](#the-question-and-why-it-changed)
- [The eight hypotheses](#the-eight-hypotheses)
- [What the system is now](#what-the-system-is-now)
- [Design principles](#design-principles)
- [Point-in-time correctness](#point-in-time-correctness)
- [Findings](#findings)
- [Results](#results)
- [Tests](#tests)
- [Stack](#stack)
- [Current state](#current-state)

---

## The question, and why it changed

Prediction markets publish a probability for every event. That number is a strong
baseline — aggregated, incentive-aligned, continuously updated. Beating it
requires either information the market prices poorly, or a computation nobody
bothers to run.

The original thesis was esports: the mispriced information there tends to be
**textual and unstructured** — roster changes, stand-ins, a team already
qualified and playing with nothing at stake. Statistical models don't read those.
Language models might.

They didn't. And seven other attempts didn't either. The pattern across all eight
is the same sentence:

> **Where this market has size, it is efficient. Where it is inefficient, it has
> no size.**

That is not eight pieces of bad luck. It is eight measurements of one fact —
market efficiency is proportional to attention, and attention is proportional to
the money available.

### The thesis that replaced it

> **The market prices the HEADLINE. The market resolves on the RULE. The gap
> between the two is the opening.**

This is a different kind of task. It does not require out-forecasting anyone; it
requires reading the resolution criteria that most traders skip. Measured: the
`description` field is populated in **100%** of markets, median **1,262
characters** of conditions, void clauses, named sources and tie-breaks.

Knowing that "City won three matches" is not "City won the league" is not a
forecast. It is reading.

---

## The eight hypotheses

Each was a real attempt with a death criterion declared before the measurement.
All eight closed negative, and the reasons differ — which is the useful part.

| # | hypothesis | what killed it |
| --- | --- | --- |
| 1 | The agent forecasts better than the price | skill **−0.029** at n=167 |
| 2 | Favorite–longshot bias | same bucket +0.027 at T-360, −0.071 at T-60 — sign flips are noise |
| 3 | Correcting the agent's bias | the market carries the same bias (+0.028 vs +0.029): it's sample composition |
| 4 | A live in-play agent | the live *market* scores 0.016–0.113; the agent scores 0.176 |
| 5 | Tail events in count markets | overdispersion is real (27.8× Poisson) **and already priced** — implied-SD z of 0.936 / 1.090 |
| 6 | Reading logical relations between markets | reads at 9.5% refutation, but relations concentrate in table-tennis handicaps |
| 7 | News lead-lag between linked markets | spread is cheap (0.90¢) but **depth is US$ 11–15** on the slow side |
| 8 | Composite markets outside Fréchet bounds | ~3,836 composites exist; **the legs do not** — the venue lists the product, not the parts |

Detail on 6, 7 and 8 is worth keeping:

**6.** 219 model calls, US$ 5.19, 927 proposed relations graded automatically
against resolved outcomes. Two defects found in passing: the taxonomy has no
negation, so "A implies **not** B" gets mislabelled; and 8.3% of generated groups
contained the same market twice, which made 62 of 95 `equivale` relations a
comparison of a market with itself.

**7.** The probe measured the cost of entry before measuring the lag. Of 12
tradeable pairs, the only two with real depth sit inside the 2028 Democratic
nomination partition — exactly where a lag cannot exist.

**8.** A full sweep of 134,026 open markets. "Both Teams to Score" is listed;
"Team A scores" is not. There is nothing for the bound to bind against, and that
is structural, not scarcity.

---

## What the system is now

```
seleção ──► coletor ──► views ──► radar (tela)  ──► eu julgo
  6h         15min       SQL         a construir      no sábado
                                          │
                                          └──► eval: meu Brier × o do mercado
```

**seleção** — recalcula o roster a cada 6h a partir de uma regra, não de uma
lista fixa. Mercado novo que passa entra; mercado que resolve sai. Hoje: ~622
mercados em 7 categorias.

**coletor** — foto de preço a cada 15 min: `best_bid`, `best_ask`, `mid_price`,
`spread`, `bid_depth`, `ask_depth`. 15 minutos porque uma reação que se desfaz em
3h rende 12 pontos; a cada hora renderia 3, e um salto entre duas fotos não deixa
rastro.

**views** — onde toda a opinião vive. Faixa de preço, volume mínimo, tamanho de
regra, agrupamento por assunto: tudo `where`, trocável em segundos.

**eval** — a máquina que mediu o agente, apontada para o humano. Ela não liga se
a previsão veio de um modelo ou de uma pessoa.

O que continua ligado do sistema antigo: heartbeat, alerta de saúde, bot do
Telegram. O que foi desligado: analista, todos os enrichers, coleta de esports,
resolver, detectores genéricos.

---

## Design principles

Six rules, each learned by breaking something.

**1. Filter at collection only what does not change; filter in the view what
does.** Category doesn't change → belongs in collection. Price changes → does
not, because filtering by price drops a market from the roster *exactly when it
moves*, which is the event being studied.

**2. `radar_tracked` is a protection mark and only grows.** Never unmark. A
market leaves the roster *because it resolved* — and unmarking hands its series
to the retention job's `finalized` branch, which deletes without an age
condition, at the moment the outcome makes the data valuable.

**3. Subject is a column, not a filter.** 22 markets about Iran are 22
opportunities to trade and **one observation** when measuring. Clustering belongs
to the measurement.

**4. `mid_price` is NULL when a side of the book is missing.** Never 0.50, never
the single side repeated. An empty book has a mid of 0.50 by arithmetic, and that
fabricated a +0.13 gap that did not exist.

**5. Ceilings come from measurement, not invention.** The API is not the
bottleneck — calls are batched, a thousand markets cost ~1.3k calls/day on a free
endpoint. Disk is.

**6. Deleted code is in git; deleted data is gone.** Delete code freely. Never
delete data.

---

## Point-in-time correctness

A backtest that can see the future is worse than no backtest, because it produces
confident numbers that are wrong. Three mechanisms defend against it:

**`as_of` and `observed_at` are different columns.** When a fact was true is not
when we learned it. Replay filters on `observed_at`, never `as_of`.

**`observed_at` is not forgeable.** A `BEFORE INSERT` trigger stamps it with the
server clock, overwriting whatever the client sends. The residual error has a
known direction and it is the harmless one: replay considers *less* than we knew.

**The context store is append-only, enforced by the database.** The same trigger
raises on `UPDATE` — which catches `UPSERT` too, the most likely way the mistake
gets in unnoticed.

Each source declares `supportsPointInTime`. Sources that cannot honestly claim it
are refused in replay — both when the caller asks, and when `asOf` is in the past
even if nobody asked. That second guard is the one that protects against
forgetting.

---

## Findings

Things that turned out not to be what they looked like. Measured, not assumed.

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
skipping every cycle on a lock it never released, logging nothing — the failure
mode was a fetch that hung rather than threw, so `finally` never ran. A component
that stops reporting looks identical to one with nothing to report; hence
heartbeats.

**A migration can report success while failing.** The partitioning migration ran
green: its `INSERT … SELECT` ran before the partitions were created, the rows
landed in `_default`, creating the correct partition then failed against it, and
the error was swallowed by an `EXCEPTION WHEN others` that returned it in a jsonb
nobody read.

**Retention was destroying the asset.** The cleanup deleted price snapshots for
any market whose event had resolved, with no age condition — features and label
erased together, at the moment they became complete. Of 1,755 resolved matches
probed for recoverable history, **zero** have a usable series. The bug was never
fixed, only given an esports exception; anything entering without one repeats it.

**An empty order book has a mid of 0.50 by arithmetic.** Not by consensus. In one
probe, 36 of 346 market-instants had price sums up to 4.53; removing them moved a
headline gap from +0.1306 to −0.0058 and every bucket calibrated.

**A guard that duplicates an existing guard is not free.** Requiring a two-sided
book to avoid empty-book artifacts excluded **205 high-liquidity markets** (median
US$ 292k, up to 1.8M) and protected against **zero** empty books — the liquidity
floor already did that. The trap was real; it was just already guarded.

**The venue already publishes half of what you'd build.** Match payloads carry
team objects with canonical names and provider IDs, league, tier, scheduled
start. Weeks of planned entity-resolution collapsed into reading fields — after
measuring that the abbreviation matched the slug code in 2,307 of 2,307 cases.

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

**By prompt version.** `v2` introduced an explicit source hierarchy:

| version | n  | agent  | market | skill  |
| ------- | -- | ------ | ------ | ------ |
| v1      | 93 | 0.1500 | 0.1405 | −0.068 |
| v2      | 74 | 0.2091 | 0.2098 | **+0.004** |

`v2` reaches parity, which is a real change. The sample cannot support the claim
that the prompt caused it: `v2`'s sample is harder — the *market* scores 0.2098
on it versus 0.1405 on `v1`'s — and it is easier to tie a price that is itself
close to a coin flip. **Parity is not edge.**

The hierarchy did change behaviour, measurably: citations of the venue's own
LLM-generated blurb fell from 58.1% to 3.4%, and citations of measured
head-to-head and recent form rose from 0.6% to 64.0%.

**Is the market itself miscalibrated?** Measured separately, on a market-centric
dataset with no agent and no gate: 267 matches, 443 rows. Market ECE is 0.0709 on
the team-A axis and 0.0931 on the label-free favourite axis — so the price *is*
wrong, by 7–9 percentage points per bucket. It is not, however, *biased*: on the
favourite axis the conclusive buckets read +0.012, +0.142, −0.205, −0.042,
+0.162. Signs alternate between neighbours, which is noise. One bucket survives a
temporal split, and its observed rate (52.4%) equals the base rate of the side
labelled "team A" (52.1%) — a labelling artifact.

**What "beating the market" would have to mean.** The eval compares against the
mid; trading happens against the ask. With a mid of 0.50 and a 0.01 spread, an
estimate of 0.505 is "better than the market" and still loses money. The bar is
not skill > 0 — it is skill positive by enough to clear the spread, on a subset
declarable *before* the outcome is known. No band clears it.

**Fidelity.** 802 recorded claims, 802 pointing at a fragment actually in the
prompt, zero analyses discarded in validation. Enforced structurally: a claim
citing a label that was never supplied causes the whole analysis to be dropped.

---

## Tests

```sh
npm test        # everything that runs without a database
npm run test:db # the same suite, with a local Postgres for the tests that need one
```

`npm test` is the whole suite and needs nothing installed. Tests that require a
database skip themselves, stating why.

`npm run test:db` starts a local Supabase stack — Postgres, PostgREST and the
gateway, with the schema built from `supabase/migrations` so it cannot drift from
production — and then runs the suite with `RADAR_TEST_DB=required`, which turns a
missing database into a failure instead of a skip. Stop it with
`npm run test:db:stop`.

Measured on 2026-08-23, images already pulled: **32s** from nothing — empty
volumes, all 48 migrations replayed, whole suite run — and **5s** with the stack
already up. The first run ever also downloads about 2 GB of container images.

Why a real Postgres and not a fake: some defects are the database exercising a
freedom no mock has. The one under test is pagination by `OFFSET` under a
non-total order, where equal-keyed rows shift between pages and the reader
silently sees one twice and another never. Two substitutes were tried and
rejected in `f755843` — spying on the query builder, and simulating PostgREST —
because both only assert that the code calls what it already calls. The
reproduction and the measured thresholds are in `web/src/lib/dados.db.test.ts`.

The test database is never this project's Supabase instance: every client goes
through a guard that refuses any host that is not this machine, so the writing
prohibition in `CLAUDE.md` holds everywhere else. Point it elsewhere with
`TEST_SUPABASE_URL` and the run aborts rather than writing.

---

## Stack

TypeScript on Node (ESM, no build step), Supabase/Postgres, Railway, Telegram.
Data from the Polymarket Gamma and CLOB APIs. LLM calls through a thin provider
interface so the model is a config value, not a code dependency.

---

## Current state

**Running:** selection, collection, retention, health monitoring, Telegram bot.

**Off, deliberately:** the analyst and every enricher (measured negative), esports
collection (no consumer), the generic detectors.

**Next:** accumulate two months of series, judge weekly, then run the eval with a
human forecaster in place of the agent. The question it answers is the one the
project has been circling since the start — *is there edge here, and is it
mine or the market's?*

This is a personal research project, built solo, as the practical component of a
postgraduate program in applied AI engineering. It has no users, no revenue, and
no product. Its output is measurements, including the ones that closed doors.

---

## License

Code: MIT. Market data belongs to its respective sources and is subject to their
terms.

Nothing here is financial advice. Prediction markets are regulated differently
across jurisdictions and are restricted or prohibited in some, including Brazil.
