# Radar — lista candidata v2

Preços lidos em 2026-08-13T21:02:49.520Z por `scripts/montar-lista-radar.ts`. **Nada foi marcado como `tracked`** — a lista existe para ser aprovada, e marcar é escrita no banco (H4).

## Como ela foi montada

- Mercados **abertos** (`closed=false, active=true, archived=false`) com `endDate` entre 2026-09-10 e 2026-10-08 — 28 a 56 dias.
- Preço do YES entre 0.15 e 0.85.
- Liquidez ≥ 5k USD e **volume 24h ≥ 500 USD**.  Book de dois lados com spread ≤ 0.1.
- Espelhos removidos: dentro do mesmo evento, dois mercados com YES somando 0,97–1,03 são um só. Caíram 4.
- Tetos: 3 por assunto, 2 por evento, 20 por categoria — 21 assuntos e 28 eventos distintos.

## Os dois papéis

**tese** (21, volume mediano 3k) — regra acima de 975 caracteres: ressalva, fonte nomeada, cláusula de escape. É onde ler com cuidado deveria dar vantagem.

**controle** (8, volume mediano 6k) — regra curta porque delega a resolução a um placar: resultado oficial, decisão anunciada, score final, feed de preço. Ler com atenção não deveria ajudar. Se a vantagem aparecer igual nos dois lados, o que se achou foi sorte, não leitura — é para isso que o controle está aqui, e ele passa no mesmo piso de volume.

Universo da janela: 3904 mercados. Passaram nos filtros: 44. Depois de espelho e tetos: 29. Mediana da descrição: 975 (universo) → 1398 (escolhidos), 1.43×; 21 dos 29 estão acima da mediana do universo.

## Os mercados

| # | papel | pergunta | **vol 24h** | assunto | categoria | preço | liquidez | prazo | desc | link |
| --- | --- | --- | ---: | --- | --- | ---: | ---: | --- | ---: | --- |
| 1 | tese | US-Iran Final Nuclear Deal by December 31, 2026? | **35k** | iran+us* | geopolitics | 0.18 | 305k | 2026-09-30 | 5456 | [abrir](https://polymarket.com/event/us-iran-final-nuclear-deal-by-20260621201254412/us-iran-final-nuclear-deal-by-december-31-2026-191) |
| 2 | tese | Will no qualifying diplomatic US-Iran meeting occur by September 30, 2026? | **34k** | iran+us* | geopolitics | 0.59 | 104k | 2026-09-30 | 3317 | [abrir](https://polymarket.com/event/where-will-the-next-next-round-of-us-iran-peace-talks-beptptpt-20260623023740663/will-no-qualifying-diplomatic-us-iran-meeting-occur-by-september-30-2026-20260622185050763) |
| 3 | tese | Israel x Iran ceasefire continues through September 30? | **6k** | iran+us* | geopolitics | 0.78 | 48k | 2026-09-30 | 3203 | [abrir](https://polymarket.com/event/israel-x-iran-ceasefire-continues-throughptptpt-20260716224448963/israel-x-iran-ceasefire-continues-through-september-30) |
| 4 | tese | Will Russia capture Kostyantynivka by September 30? | **1k** | — | geopolitics | 0.70 | 25k | 2026-09-30 | 2269 | [abrir](https://polymarket.com/event/will-russia-capture-kostyantynivka-by/will-russia-capture-kostyantynivka-by-september-30-256-333-352) |
| 5 | tese | Will the Bank of Japan announce no change at the September 2026 meeting? | **3k** | russia+bank* | economy | 0.27 | 9k | 2026-09-18 | 1911 | [abrir](https://polymarket.com/event/bank-of-japan-decision-in-september-20260616002734979/will-the-bank-of-japan-announce-no-change-at-the-september-2026-meeting-20260616223724869) |
| 6 | tese | Strait of Hormuz traffic returns to normal by September 30? | **172k** | — | geopolitics | 0.15 | 477k | 2026-09-30 | 1842 | [abrir](https://polymarket.com/event/strait-of-hormuz-traffic-returns-to-normal-by-september-30-20260702154339440/strait-of-hormuz-traffic-returns-to-normal-by-september-30-20260702154339440) |
| 7 | tese | Will RNI win the next Moroccan legislative elections? | **2k** | — | elections | 0.24 | 24k | 2026-09-23 | 1831 | [abrir](https://polymarket.com/event/morocco-legislative-elections-party-winner-20260728174826232/will-rni-win-the-next-moroccan-legislative-elections-20260728174826233) |
| 8 | tese | Will AfD win 28-31 seats in the 2026 Mecklenburg-Vorpommern parliamentary elections? | **984** | mecklenburg | elections | 0.64 | 8k | 2026-09-20 | 1604 | [abrir](https://polymarket.com/event/mecklenburg-vorpommern-parliamentary-elections-afd-of-seats-20260805192827457/will-afd-win-28-31-seats-in-the-2026-mecklenburg-vorpommern-parliamentary-elections-20260805192828535) |
| 9 | tese | Will SPD win 22-25 seats in the 2026 Mecklenburg-Vorpommern parliamentary elections? | **1k** | mecklenburg | elections | 0.54 | 10k | 2026-09-20 | 1604 | [abrir](https://polymarket.com/event/mecklenburg-vorpommern-parliamentary-elections-spd-of-seats-20260805193137880/will-spd-win-22-25-seats-in-the-2026-mecklenburg-vorpommern-parliamentary-elections-20260805193138007) |
| 10 | tese | Will the Safeguarding Swiss neutrality (neutrality initiative) initiative be approved in Switzerland’s September 27, 2026 popular vote? | **803** | — | elections | 0.16 | 30k | 2026-09-27 | 1572 | [abrir](https://polymarket.com/event/switzerlands-september-referendum-what-will-pass-20260713144919276/will-the-safeguarding-swiss-neutrality-neutrality-initiative-initiative-be-approved-in-switzerlands-september-27-2026-popular-vote-20260713144919277) |
| 11 | tese | Russia-Ukraine peace talks by September 30, 2026? | **4k** | — | geopolitics | 0.23 | 25k | 2026-09-30 | 1563 | [abrir](https://polymarket.com/event/russia-x-ukraine-peace-talks-byptptpt-20260609012540716/russia-ukraine-peace-talks-by-september-30-2026-20260609012542188) |
| 12 | tese | Sweden Parliamentary Election: More Votes to SD or M? | **2k** | — | elections | 0.82 | 9k | 2026-09-13 | 1505 | [abrir](https://polymarket.com/event/sweden-parliamentary-election-more-votes-to-sd-or-m-20260812170140800/sweden-parliamentary-election-more-votes-to-sd-or-m-20260812170140800) |
| 13 | tese | Will Luiz Inácio Lula da Silva win the first round of the 2026 Brazilian presidential election by 10–15%? | **739** | brazilian | elections | 0.30 | 53k | 2026-10-04 | 1499 | [abrir](https://polymarket.com/event/brazil-presidential-election-first-round-margin-of-victory/will-luiz-incio-lula-da-silva-win-the-first-round-of-the-2026-brazilian-presidential-election-by-1015-995) |
| 14 | tese | Russia Elections: United Russia Wins Every Region? | **3k** | russia+bank* | elections | 0.55 | 112k | 2026-09-20 | 1479 | [abrir](https://polymarket.com/event/russia-elections-united-russia-wins-every-region/russia-elections-united-russia-wins-every-region) |
| 15 | tese | Will the Fed decide differently in the next three decisions (Jun–Jul–Sep)? | **10k** | — | economy | 0.28 | 31k | 2026-09-16 | 1398 | [abrir](https://polymarket.com/event/fed-decisions-jun-sep/will-the-fed-decide-differently-in-the-next-three-decisions-junjulsep) |
| 16 | tese | Will Partido Liberal (PL) hold the most seats in the Brazilian Chamber of Deputies after the 2026 election? | **5k** | — | elections | 0.72 | 19k | 2026-10-04 | 1360 | [abrir](https://polymarket.com/event/brazil-chamber-of-deputies-election-winner/will-partido-liberal-pl-hold-the-most-seats-in-the-brazilian-chamber-of-deputies-after-the-2026-election) |
| 17 | tese | Will there be no change in Fed interest rates after the September 2026 meeting? | **480k** | russia+bank* | economy | 0.70 | 442k | 2026-09-16 | 1324 | [abrir](https://polymarket.com/event/fed-decision-in-september-762/will-there-be-no-change-in-fed-interest-rates-after-the-september-2026-meeting-615) |
| 18 | tese | Gemini 4.0 released by September 30, 2026? | **1k** | — | tech | 0.23 | 24k | 2026-09-30 | 1311 | [abrir](https://polymarket.com/event/gemini-4pt0-released-by-june-30-2026/gemini-4pt0-released-by-september-30-2026) |
| 19 | tese | Will the Moderate Party (M) win the third most seats in the 2026 Swedish parliamentary election? | **762** | swedish | elections | 0.81 | 25k | 2026-09-13 | 1168 | [abrir](https://polymarket.com/event/sweden-parliamentary-election-3rd-place/will-the-moderate-party-m-win-the-third-most-seats-in-the-2026-swedish-parliamentary-election) |
| 20 | tese | Will Tidö parties win a majority in the 2026 Swedish parliamentary elections? | **758** | swedish | elections | 0.24 | 10k | 2026-09-14 | 1148 | [abrir](https://polymarket.com/event/will-tido-parties-win-a-majority-in-the-2026-swedish-parliamentary-elections-20260603233725849/will-tido-parties-win-a-majority-in-the-2026-swedish-parliamentary-elections-20260603233725849) |
| 21 | tese | Will CDU win the most seats in the 2026 Berlin state elections? | **3k** | — | elections | 0.24 | 63k | 2026-09-20 | 1054 | [abrir](https://polymarket.com/event/berlin-state-election-winner/will-cdu-win-the-most-seats-in-the-2026-berlin-state-elections) |
| 22 | controle | Will Flávio Bolsonaro win the 2026 Brazilian presidential election? | **40k** | brazilian | politics | 0.28 | 199k | 2026-10-04 | 683 | [abrir](https://polymarket.com/event/brazil-presidential-election/will-flvio-bolsonaro-win-the-2026-brazilian-presidential-election) |
| 23 | controle | Will Luiz Inácio Lula da Silva win the 2026 Brazilian presidential election? | **16k** | brazilian | politics | 0.64 | 384k | 2026-10-04 | 683 | [abrir](https://polymarket.com/event/brazil-presidential-election/will-luiz-incio-lula-da-silva-win-the-2026-brazilian-presidential-election) |
| 24 | controle | Tampa Bay Rays vs. New York Yankees | **10k** | — | sports | 0.43 | 18k | 2026-09-29 | 817 | [abrir](https://polymarket.com/event/mlb-tb-nyy-2026-05-23/mlb-tb-nyy-2026-05-23) |
| 25 | controle | Will Elif Eralp be the next Governing Mayor of Berlin? | **6k** | berlin | elections | 0.45 | 6k | 2026-09-20 | 744 | [abrir](https://polymarket.com/event/next-governing-mayor-of-berlin-1786117615442/will-elif-eralp-be-the-next-governing-mayor-of-berlin-1786117615446) |
| 26 | controle | Will Magdalena Andersson be the next Prime Minister of Sweden? | **6k** | — | elections | 0.84 | 49k | 2026-09-13 | 692 | [abrir](https://polymarket.com/event/next-prime-minister-of-sweden/will-magdalena-andersson-be-the-next-prime-minister-of-sweden) |
| 27 | controle | Will Ciro Gomes win the 2026 Ceará gubernatorial election? | **3k** | — | elections | 0.66 | 8k | 2026-10-04 | 880 | [abrir](https://polymarket.com/event/cear-governor-election-winner/will-ciro-gomes-win-the-2026-cear-gubernatorial-election) |
| 28 | controle | Will Jannik Sinner win the 2026 Men's US Open? | **3k** | — | sports | 0.51 | 79k | 2026-09-13 | 744 | [abrir](https://polymarket.com/event/2026-mens-us-open-winner-tennis/will-jannik-sinner-win-the-2026-mens-us-open) |
| 29 | controle | Will STRC hit $100 by September 30? | **2k** | — | crypto | 0.37 | 15k | 2026-09-30 | 654 | [abrir](https://polymarket.com/event/strc-hits-100-by-20260618001620693/will-strc-hit-100-by-september-30-20260618001621118) |
