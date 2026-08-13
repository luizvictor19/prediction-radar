# Radar — lista candidata

Preços lidos em 2026-08-13T21:02:49.520Z por `scripts/montar-lista-radar.ts`. **Nada foi marcado como `tracked`** — a lista existe para ser aprovada, e marcar é escrita no banco (H4).

## Como ela foi montada

- Mercados **abertos** (`closed=false, active=true, archived=false`) com `endDate` entre 2026-09-10 e 2026-10-08 — 28 a 56 dias.
- Preço do YES entre 0.15 e 0.85.
- Liquidez ≥ 5k USD.  Book de dois lados com spread ≤ 0.1.
- Descartados os mercados cujo `endDate` cai depois do limite externo que a própria regra nomeia.
- Ordenados por tamanho da `description`, com teto de 12 por categoria e 2 por evento — 34 eventos distintos.

Universo da janela: 3904 mercados. Passaram nos filtros: 175. Mediana da descrição: 975 (universo) → 1582 (escolhidos), 1.62×.

**Onde a proxy para de discriminar.** 28 dos 40 têm regra mais comprida que a mediana do universo (975 caracteres); os outros 12 entraram porque as vagas sobraram depois dos tetos, não porque a regra deles seja complicada. O topo da lista é onde a tese vive; a cauda é preenchimento, e vale ler como tal.

## Os mercados

| # | pergunta | categoria | preço | liquidez | vol 24h | prazo | desc | link |
| --- | --- | --- | ---: | ---: | ---: | --- | ---: | --- |
| 1 | US-Iran Final Nuclear Deal by December 31, 2026? | geopolitics | 0.18 | 305k | 35k | 2026-09-30 | 5456 | [abrir](https://polymarket.com/event/us-iran-final-nuclear-deal-by-20260621201254412/us-iran-final-nuclear-deal-by-december-31-2026-191) |
| 2 | Will no qualifying diplomatic US-Iran meeting occur by September 30, 2026? | politics | 0.59 | 104k | 34k | 2026-09-30 | 3317 | [abrir](https://polymarket.com/event/where-will-the-next-next-round-of-us-iran-peace-talks-beptptpt-20260623023740663/will-no-qualifying-diplomatic-us-iran-meeting-occur-by-september-30-2026-20260622185050763) |
| 3 | Israel x Iran ceasefire continues through September 30? | geopolitics | 0.78 | 48k | 6k | 2026-09-30 | 3203 | [abrir](https://polymarket.com/event/israel-x-iran-ceasefire-continues-throughptptpt-20260716224448963/israel-x-iran-ceasefire-continues-through-september-30) |
| 4 | US announces end of Iranian blockade by September 30, 2026? | politics | 0.59 | 112k | 52k | 2026-09-30 | 3113 | [abrir](https://polymarket.com/event/us-announces-end-of-iranian-blockade-byptptpt-20260713152715080/us-announces-end-of-iranian-blockade-by-september-30-2026-20260727171615364-722-649-646-561-213-644) |
| 5 | Will Russia capture all of Chasiv Yar by September 30? | geopolitics | 0.39 | 7k | 25 | 2026-09-30 | 2323 | [abrir](https://polymarket.com/event/will-russia-capture-all-of-chasiv-yar-by/will-russia-capture-all-of-chasiv-yar-by-september-30) |
| 6 | Will Russia capture Kostyantynivka by September 30? | politics | 0.70 | 25k | 1k | 2026-09-30 | 2269 | [abrir](https://polymarket.com/event/will-russia-capture-kostyantynivka-by/will-russia-capture-kostyantynivka-by-september-30-256-333-352) |
| 7 | Government shutdown by October 1? | politics | 0.17 | 13k | 1 | 2026-10-02 | 2230 | [abrir](https://polymarket.com/event/government-shutdown-by-october-1-20260610162414910/government-shutdown-by-october-1-20260610162414910) |
| 8 | US x Iran diplomatic meeting by September 30, 2026? | politics | 0.41 | 107k | 15k | 2026-09-30 | 2139 | [abrir](https://polymarket.com/event/next-round-of-us-iran-peace-talks-byptptpt-20260623022722982/us-x-iran-diplomatic-meeting-by-september-30-2026) |
| 9 | Will the Communist Party of the Russian Federation (KPRF) win the third-most seats in the next Russian parliamentary election? | politics | 0.15 | 29k | 77 | 2026-09-20 | 1996 | [abrir](https://polymarket.com/event/russia-parliamentary-election-3rd-place/will-the-communist-party-of-the-russian-federation-kprf-win-the-third-most-seats-in-the-next-russian-parliamentary-election) |
| 10 | Will the Liberal Democratic Party of Russia (LDPR) win the third-most seats in the next Russian parliamentary election? | politics | 0.39 | 12k | 89 | 2026-09-20 | 1996 | [abrir](https://polymarket.com/event/russia-parliamentary-election-3rd-place/will-the-liberal-democratic-party-of-russia-ldpr-win-the-third-most-seats-in-the-next-russian-parliamentary-election) |
| 11 | Will the Communist Party of the Russian Federation (KPRF) win the second-most seats in the next Russian parliamentary election? | politics | 0.83 | 50k | 211 | 2026-09-20 | 1990 | [abrir](https://polymarket.com/event/russia-parliamentary-election-2nd-place/will-the-communist-party-of-the-russian-federation-kprf-win-the-second-most-seats-in-the-next-russian-parliamentary-election) |
| 12 | Will RNI get the second-most number of seats in the next Moroccan legislative elections? | politics | 0.31 | 11k | 80 | 2026-09-23 | 1961 | [abrir](https://polymarket.com/event/morocco-legislative-elections-2nd-place-20260728175700575/will-rni-get-the-second-most-number-of-seats-in-the-next-moroccan-legislative-elections-20260728175700576) |
| 13 | Will PI get the second-most number of seats in the next Moroccan legislative elections? | politics | 0.31 | 35k | 10 | 2026-09-23 | 1961 | [abrir](https://polymarket.com/event/morocco-legislative-elections-2nd-place-20260728175700575/will-pi-get-the-second-most-number-of-seats-in-the-next-moroccan-legislative-elections-20260728175700578) |
| 14 | Iran charges Hormuz fees by September 30? | geopolitics | 0.17 | 21k | 106 | 2026-09-30 | 1945 | [abrir](https://polymarket.com/event/iran-charges-hormuz-fees-byptptpt-20260625175035466/iran-charges-hormuz-fees-by-september-30) |
| 15 | Will the Bank of Japan announce no change at the September 2026 meeting? | economy | 0.27 | 9k | 3k | 2026-09-18 | 1911 | [abrir](https://polymarket.com/event/bank-of-japan-decision-in-september-20260616002734979/will-the-bank-of-japan-announce-no-change-at-the-september-2026-meeting-20260616223724869) |
| 16 | Will the Bank of Japan announce a 25 bps increase at the September 2026 meeting? | economy | 0.72 | 7k | 3k | 2026-09-18 | 1911 | [abrir](https://polymarket.com/event/bank-of-japan-decision-in-september-20260616002734979/will-the-bank-of-japan-announce-a-25-bps-increase-at-the-september-2026-meeting-20260616223724870) |
| 17 | Strait of Hormuz traffic returns to normal by September 30? | politics | 0.15 | 477k | 172k | 2026-09-30 | 1842 | [abrir](https://polymarket.com/event/strait-of-hormuz-traffic-returns-to-normal-by-september-30-20260702154339440/strait-of-hormuz-traffic-returns-to-normal-by-september-30-20260702154339440) |
| 18 | Will RNI win the next Moroccan legislative elections? | politics | 0.24 | 24k | 2k | 2026-09-23 | 1831 | [abrir](https://polymarket.com/event/morocco-legislative-elections-party-winner-20260728174826232/will-rni-win-the-next-moroccan-legislative-elections-20260728174826233) |
| 19 | Will OpenAI’s Astra model be released by September 30, 2026? | tech | 0.76 | 6k | 172 | 2026-09-30 | 1819 | [abrir](https://polymarket.com/event/openais-astra-released-by-20260801214557729/will-openais-astra-model-be-released-by-september-30-2026-20260801214557732) |
| 20 | Will Netflix win the most Emmys? | pop-culture | 0.17 | 6k | 0 | 2026-09-14 | 1582 | [abrir](https://polymarket.com/event/which-streaming-service-will-win-the-most-emmys-20260710203956416/will-netflix-win-the-most-emmys-20260710203956418) |
| 21 | Will Anthropic have the best AI model at the end of September 2026? | tech | 0.84 | 9k | 59 | 2026-09-30 | 1423 | [abrir](https://polymarket.com/event/which-company-has-the-best-ai-model-end-of-september-20260717143435868/will-anthropic-have-the-best-ai-model-at-the-end-of-september-2026-20260717143137053) |
| 22 | Will the Fed Pause–Pause–Pause in the next three decisions (Jun–Jul–Sep)? | economy | 0.71 | 17k | 3k | 2026-09-16 | 1398 | [abrir](https://polymarket.com/event/fed-decisions-jun-sep/will-the-fed-pausepausepause-in-the-next-three-decisions-junjulsep) |
| 23 | Will the Fed decide differently in the next three decisions (Jun–Jul–Sep)? | economy | 0.28 | 31k | 10k | 2026-09-16 | 1398 | [abrir](https://polymarket.com/event/fed-decisions-jun-sep/will-the-fed-decide-differently-in-the-next-three-decisions-junjulsep) |
| 24 | Gemini 4.0 released by September 30, 2026? | tech | 0.23 | 24k | 1k | 2026-09-30 | 1311 | [abrir](https://polymarket.com/event/gemini-4pt0-released-by-june-30-2026/gemini-4pt0-released-by-september-30-2026) |
| 25 | Spread: New York Yankees (-1.5) | sports | 0.43 | 12k | 0 | 2026-09-22 | 1033 | [abrir](https://polymarket.com/event/mlb-tb-nyy-2026-05-23/mlb-tb-nyy-2026-05-23-spread-home-1pt5) |
| 26 | Will Colman Domingo – “Euphoria” win Emmys 2026: Outstanding guest actor in a drama series? | pop-culture | 0.35 | 8k | 0 | 2026-09-14 | 1000 | [abrir](https://polymarket.com/event/emmys-2026-outstanding-guest-actor-in-a-drama-series/will-colman-domingo-euphoria-win-emmys-2026-outstanding-guest-actor-in-a-drama-series-20260709174234066) |
| 27 | Tampa Bay Rays vs. New York Yankees: O/U 7.5 | sports | 0.48 | 8k | 0 | 2026-09-22 | 999 | [abrir](https://polymarket.com/event/mlb-tb-nyy-2026-05-23/mlb-tb-nyy-2026-05-23-total-7pt5) |
| 28 | Will “Widow’s Bay” win Emmys 2026: Outstanding comedy series? | pop-culture | 0.53 | 6k | 57 | 2026-09-14 | 985 | [abrir](https://polymarket.com/event/emmys-2026-outstanding-comedy-series/will-widows-bay-win-emmys-2026-outstanding-comedy-series-20260709174229096) |
| 29 | Detroit Tigers vs. Cleveland Guardians | sports | 0.58 | 14k | 421 | 2026-09-11 | 827 | [abrir](https://polymarket.com/event/mlb-det-cle-2026-06-14/mlb-det-cle-2026-06-14) |
| 30 | Will Aryna Sabalenka win the 2026 Women’s US Open? | sports | 0.26 | 20k | 245 | 2026-09-13 | 750 | [abrir](https://polymarket.com/event/2026-womens-us-open-winner-tennis/will-aryna-sabalenka-win-the-2026-womens-us-open) |
| 31 | Will Jannik Sinner win the 2026 Men's US Open? | sports | 0.51 | 79k | 3k | 2026-09-13 | 744 | [abrir](https://polymarket.com/event/2026-mens-us-open-winner-tennis/will-jannik-sinner-win-the-2026-mens-us-open) |
| 32 | Will the Bank of Russia decrease the key rate after the September Meeting? | economy | 0.38 | 11k | 273 | 2026-09-11 | 662 | [abrir](https://polymarket.com/event/bank-of-russia-decision-in-september-20260623013858993/will-the-bank-of-russia-decrease-the-key-rate-after-the-september-meeting-20260623013926067) |
| 33 | Will the Bank of Russia make no change to the key rate after the September Meeting? | economy | 0.62 | 13k | 763 | 2026-09-11 | 662 | [abrir](https://polymarket.com/event/bank-of-russia-decision-in-september-20260623013858993/will-the-bank-of-russia-make-no-change-to-the-key-rate-after-the-september-meeting-20260623013926068) |
| 34 | Will STRC hit $100 by September 30? | crypto | 0.37 | 15k | 2k | 2026-09-30 | 654 | [abrir](https://polymarket.com/event/strc-hits-100-by-20260618001620693/will-strc-hit-100-by-september-30-20260618001621118) |
| 35 | Floyd Mayweather vs. Manny Pacquiao 2 | boxing | 0.50 | 64k | 0 | 2026-09-20 | 627 | [abrir](https://polymarket.com/event/floyd-mayweather-vs-manny-pacquiao-2/floyd-mayweather-vs-manny-pacquiao-2) |
| 36 | Will T1 Esports Academy win LCK CL 2026? | sports | 0.40 | 6k | 8 | 2026-09-13 | 617 | [abrir](https://polymarket.com/event/lol-lck-cl-2026-winner/will-t1-esports-academy-win-lck-cl-2026) |
| 37 | Spread: Chargers (-10.5) | sports | 0.48 | 8k | 0 | 2026-09-13 | 458 | [abrir](https://polymarket.com/event/nfl-ari-lac-2026-09-13/nfl-ari-lac-2026-09-13-spread-home-10pt5) |
| 38 | Spread: Bengals (-3.5) | sports | 0.49 | 7k | 0 | 2026-09-13 | 457 | [abrir](https://polymarket.com/event/nfl-tb-cin-2026-09-13/nfl-tb-cin-2026-09-13-spread-home-3pt5) |
| 39 | Spread: Eagles (-4.5) | sports | 0.51 | 7k | 0 | 2026-09-13 | 455 | [abrir](https://polymarket.com/event/nfl-was-phi-2026-09-13/nfl-was-phi-2026-09-13-spread-home-4pt5) |
| 40 | Spread: Raiders (-3.5) | sports | 0.52 | 7k | 0 | 2026-09-13 | 453 | [abrir](https://polymarket.com/event/nfl-mia-lv-2026-09-13/nfl-mia-lv-2026-09-13-spread-home-3pt5) |
