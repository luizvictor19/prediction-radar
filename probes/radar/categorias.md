# Radar — o mapeamento de categoria

Lido em 2026-08-14T02:08:51.134Z por `scripts/radar-categorias.ts`. **Nada foi gravado.** Mesma regra do coletor, mesmo universo, rodada em memória.

O que este arquivo existe para responder: o recorte por tag da Gamma está deixando de fora algo que interessa? Coletar lixo é barato — a view esconde. **Não coletar o que interessa é o erro caro**, porque a API não devolve orderbook histórico: o mercado que não foi coletado em agosto não tem série em novembro.

## Como ler

- **Entraram** — os mais líquidos de cada categoria, com as tags do evento. A tag que causou a classificação é a que aparece na coluna `via`.
- **Perto de entrar** — os que o teto por categoria cortou, em ordem de liquidez. Estes voltam sozinhos se subirem de liquidez na próxima renovação.
- **Descartados pela regra** — caíram na triagem. Não voltam, mas foi decisão explícita.
- **Fora de todas as categorias** — a seção que importa. São os mercados mais líquidos da janela que NENHUMA tag do recorte alcançou. Se algo aqui interessa, o mapa está errado.

## Resumo

| categoria | tags | candidatos | no roster | liquidez do corte |
| --- | --- | ---: | ---: | ---: |
| brasil | `brazil` | 244 | 50 | 36k |
| ia-e-tecnologia | `ai`, `tech` | 482 | 50 | 51k |
| macro-e-mercados | `economy`, `finance`, `business`, `crypto` | 730 | 50 | 99k |
| eleicoes-e-politica | `elections`, `politics` | 322 | 50 | 151k |
| esporte-de-temporada | `sports` | 87 | 50 | 108k |
| geopolitica-e-conflitos | `geopolitics`, `world` | 182 | 50 | 46k |

Universo baixado: 3571 markets (2489 únicos). Passaram na regra: 2047. No roster: 300.

### Descartes da regra, por motivo

| motivo | markets |
| --- | ---: |
| livro de um lado só (ou invertido) | 274 |
| mercado de partida (jogo único) | 132 |
| esports (coleta desligada) | 36 |

## brasil

Tags: `brazil`

### Entraram (10)

| pergunta | liquidez | vol 24h | prazo | via | tags do evento |
| --- | ---: | ---: | --- | --- | --- |
| Will Camilo Santana win the 2026 Brazilian presidential election? | 417k | 5.9k | 2026-10-04 | `brazil` | politics, macro-election-2, main-election, brazil, global-e… |
| Will Romeu Zema win the 2026 Brazilian presidential election? | 412k | 42k | 2026-10-04 | `brazil` | politics, macro-election-2, main-election, brazil, global-e… |
| Will Luiz Inácio Lula da Silva win the 2026 Brazilian presidential election? | 395k | 12k | 2026-10-04 | `brazil` | politics, macro-election-2, main-election, brazil, global-e… |
| Will Jair Bolsonaro win the 2026 Brazilian presidential election? | 345k | 9.3k | 2026-10-04 | `brazil` | politics, macro-election-2, main-election, brazil, global-e… |
| Will Renan Santos win the 2026 Brazilian presidential election? | 338k | 23k | 2026-10-04 | `brazil` | politics, macro-election-2, main-election, brazil, global-e… |
| Will Ronaldo Caiado win the 2026 Brazilian presidential election? | 313k | 9.0k | 2026-10-04 | `brazil` | politics, macro-election-2, main-election, brazil, global-e… |
| Will Michelle Bolsonaro win the 2026 Brazilian presidential election? | 279k | 21k | 2026-10-04 | `brazil` | politics, macro-election-2, main-election, brazil, global-e… |
| Will Geraldo Alckmin win the 2026 Brazilian presidential election? | 248k | 4.6k | 2026-10-04 | `brazil` | politics, macro-election-2, main-election, brazil, global-e… |
| Will Tereza Cristina win the 2026 Brazilian presidential election? | 236k | 2.7k | 2026-10-04 | `brazil` | politics, macro-election-2, main-election, brazil, global-e… |
| Will Flávio Bolsonaro win the 2026 Brazilian presidential election? | 206k | 32k | 2026-10-04 | `brazil` | politics, macro-election-2, main-election, brazil, global-e… |

### Perto de entrar — cortados pelo teto de 50 (10)

| pergunta | liquidez | vol 24h | via | tags do evento |
| --- | ---: | ---: | --- | --- |
| Will Geraldo Alckmin finish in third place in the first round of the 2026 B… | 36k | 0 | `brazil` | brazil, world, politics, global-elections, international-el… |
| Will Rodrigo Pacheco win the 2026 Minas Gerais gubernatorial election? | 36k | 0 | `brazil` | brazil, global-elections, elections, main-election, politics |
| Will Partido Socialista Brasileiro (PSB) hold the most seats in the Brazili… | 36k | 0 | `brazil` | world-elections, elections, politics, brazil, global-electi… |
| Will Dr. Luizinho win the Governor of Rio de Janeiro election? | 35k | 0 | `brazil` | brazil, politics, elections, main-election, global-elections |
| Will Capitão Wagner win the 2026 Ceará gubernatorial election? | 35k | 343 | `brazil` | politics, elections, main-election, global-elections, brazil |
| Will José Carlos Aleluia win the 2026 Bahia gubernatorial election? | 35k | 0 | `brazil` | brazil, elections, global-elections, main-election, politics |
| Will Tarcísio Motta win the Governor of Rio de Janeiro election? | 34k | 0 | `brazil` | brazil, politics, elections, main-election, global-elections |
| Will Eduardo Girão win the 2026 Ceará gubernatorial election? | 34k | 10 | `brazil` | politics, elections, main-election, global-elections, brazil |
| Will Tarcísio de Freitas win the 2026 São Paulo gubernatorial election? | 34k | 30 | `brazil` | brazil, main-election, politics, global-elections, elections |
| Will Erika Hilton win the 2026 São Paulo gubernatorial election? | 34k | 0 | `brazil` | brazil, main-election, politics, global-elections, elections |

### Descartados pela regra (10 mais líquidos)

| pergunta | liquidez | motivo | tags do evento |
| --- | ---: | --- | --- |
| Will Eduardo Leite win the 2026 Brazilian presidential election? | 1.8M | livro de um lado só (ou invertido) | politics, macro-election-2, main-election, brazil… |
| Will Aldo Rebelo win the 2026 Brazilian presidential election? | 1.6M | livro de um lado só (ou invertido) | politics, macro-election-2, main-election, brazil… |
| Will Carlos Roberto Massa Júnior win the 2026 Brazilian presidential electi… | 1.6M | livro de um lado só (ou invertido) | politics, macro-election-2, main-election, brazil… |
| Will Eduardo Bolsonaro win the 2026 Brazilian presidential election? | 986k | livro de um lado só (ou invertido) | politics, macro-election-2, main-election, brazil… |
| Will Helder Barbalho win the 2026 Brazilian presidential election? | 523k | livro de um lado só (ou invertido) | politics, macro-election-2, main-election, brazil… |
| Will Tarcisio de Freitas win the 2026 Brazilian presidential election? | 436k | livro de um lado só (ou invertido) | politics, macro-election-2, main-election, brazil… |
| Will Fernando Haddad win the 2026 Brazilian presidential election? | 280k | livro de um lado só (ou invertido) | politics, macro-election-2, main-election, brazil… |
| Will Márcio França win the 2026 São Paulo gubernatorial election? | 51k | livro de um lado só (ou invertido) | brazil, main-election, politics, global-elections… |
| Will Helder Barbalho finish in second place in the first round of the 2026 … | 51k | livro de um lado só (ou invertido) | — |
| Will Eduardo Leite finish in third place in the first round of the 2026 Bra… | 33k | livro de um lado só (ou invertido) | brazil, world, politics, global-elections, intern… |

## ia-e-tecnologia

Tags: `ai`, `tech`

### Entraram (10)

| pergunta | liquidez | vol 24h | prazo | via | tags do evento |
| --- | ---: | ---: | --- | --- | --- |
| Will Tesla be the largest company in the world by market cap on December 31? | 260k | 62k | 2026-12-31 | `tech` | economy, business, finance, tech, big-tech |
| Will Amazon be the largest company in the world by market cap on December 3… | 184k | 3.4k | 2026-12-31 | `tech` | economy, business, finance, tech, big-tech |
| Will Microsoft be the largest company in the world by market cap on Decembe… | 177k | 1.2k | 2026-12-31 | `tech` | economy, business, finance, tech, big-tech |
| Will Apple be the largest company in the world by market cap on December 31? | 144k | 3.9k | 2026-12-31 | `tech` | economy, business, finance, tech, big-tech |
| Will Microsoft be the largest company in the world by market cap on August … | 143k | 4.0k | 2026-08-31 | `tech` | tech, economy, finance, big-tech, business |
| Will Saudi Aramco be the largest company in the world by market cap on Dece… | 142k | 327 | 2026-12-31 | `tech` | economy, business, finance, tech, big-tech |
| Will Alphabet be the largest company in the world by market cap on December… | 140k | 638 | 2026-12-31 | `tech` | economy, business, finance, tech, big-tech |
| Will NVIDIA be the largest company in the world by market cap on August 31? | 139k | 40k | 2026-08-31 | `tech` | tech, economy, finance, big-tech, business |
| Will SpaceX be the largest company in the world by market cap on December 3… | 139k | 3.2k | 2026-12-31 | `tech` | economy, business, finance, tech, big-tech |
| Will Amazon be the largest company in the world by market cap on August 31? | 132k | 9.0k | 2026-08-31 | `tech` | tech, economy, finance, big-tech, business |

### Perto de entrar — cortados pelo teto de 50 (10)

| pergunta | liquidez | vol 24h | via | tags do evento |
| --- | ---: | ---: | --- | --- |
| Will Lionel Messi be the #1 searched person on Google this year? | 49k | 0 | `tech` | tech, google, pop-culture, celebrities, best-of-2026, googl… |
| Will Microsoft be the second-largest company in the world by market cap on … | 49k | 4.7k | `tech` | tech, economy, finance, big-tech, business |
| Will Microsoft have the best AI model at the end of December 2026? | 49k | 1.3k | `ai` | tech, ai, grok, openai, anthropic, ai-rankings |
| Will Billie Eilish be the #1 searched person on Google in the US this year? | 48k | 0 | `tech` | tech, google, pop-culture, celebrities, best-of-2026, googl… |
| Will DeepSeek have the best Chinese AI model at the end of August 2026? | 48k | 25k | `ai` | ai, tech, china, ai-rankings, moonshot |
| Will Alysa Liu be the #1 searched person on Google this year? | 48k | 10 | `tech` | tech, google, pop-culture, celebrities, best-of-2026, googl… |
| Will Meituan have the best AI model at the end of December 2026? | 48k | 200 | `ai` | tech, ai, grok, openai, anthropic, ai-rankings |
| Will Swapped be the #1 searched TV show on Google this year? | 47k | 0 | `tech` | tv, tech, google, pop-culture, best-of-2026, google-search |
| Will Neymar be the #1 searched person on Google this year? | 47k | 0 | `tech` | tech, google, pop-culture, celebrities, best-of-2026, googl… |
| Will Pedro Pascal be the #1 searched person on Google this year? | 47k | 0 | `tech` | tech, google, pop-culture, celebrities, best-of-2026, googl… |

### Descartados pela regra (10 mais líquidos)

| pergunta | liquidez | motivo | tags do evento |
| --- | ---: | --- | --- |
| Will Saudi Aramco be the largest company in the world by market cap on Augu… | 144k | livro de um lado só (ou invertido) | tech, economy, finance, big-tech, business |
| Will Broadcom be the largest company in the world by market cap on August 3… | 126k | livro de um lado só (ou invertido) | tech, economy, finance, big-tech, business |
| Will Tesla be the largest company in the world by market cap on August 31? | 108k | livro de um lado só (ou invertido) | tech, economy, finance, big-tech, business |
| Will Tencent have the best AI model at the end of August 2026? | 60k | livro de um lado só (ou invertido) | — |
| Will Mistral have the best AI model at the end of August 2026? | 59k | livro de um lado só (ou invertido) | — |
| Will Meituan have the best AI model at the end of August 2026? | 59k | livro de um lado só (ou invertido) | — |
| Will Nvidia have the best AI model at the end of August 2026? | 57k | livro de um lado só (ou invertido) | — |
| Will Baidu have the best AI model at the end of August 2026? | 57k | livro de um lado só (ou invertido) | — |
| Will Microsoft have the best AI model at the end of August 2026? | 57k | livro de um lado só (ou invertido) | — |
| Will Amazon have the best AI model at the end of August 2026? | 55k | livro de um lado só (ou invertido) | — |

## macro-e-mercados

Tags: `economy`, `finance`, `business`, `crypto`

### Entraram (10)

| pergunta | liquidez | vol 24h | prazo | via | tags do evento |
| --- | ---: | ---: | --- | --- | --- |
| Will the Fed increase interest rates by 50+ bps after the September 2026 me… | 1.0M | 348k | 2026-09-16 | `economy` | fomc, economic-policy, fed-rates, jerome-powell, politics, … |
| Will the Fed decrease interest rates by 25 bps after the September 2026 mee… | 777k | 416k | 2026-09-16 | `economy` | fomc, economic-policy, fed-rates, jerome-powell, politics, … |
| Will the Fed decrease interest rates by 50+ bps after the September 2026 me… | 680k | 415k | 2026-09-16 | `economy` | fomc, economic-policy, fed-rates, jerome-powell, politics, … |
| Will the Fed increase interest rates by 25 bps after the September 2026 mee… | 535k | 345k | 2026-09-16 | `economy` | fomc, economic-policy, fed-rates, jerome-powell, politics, … |
| Will 11 Fed rate cuts happen in 2026? | 510k | 282 | 2026-12-31 | `economy` | rewards-200-4pt5-50, fed-rates, economic-policy, fed, busin… |
| Will 10 Fed rate cuts happen in 2026? | 483k | 414 | 2026-12-31 | `economy` | rewards-200-4pt5-50, fed-rates, economic-policy, fed, busin… |
| Will there be no change in Fed interest rates after the September 2026 meet… | 479k | 498k | 2026-09-16 | `economy` | fomc, economic-policy, fed-rates, jerome-powell, politics, … |
| Will 9 Fed rate cuts happen in 2026? | 437k | 638 | 2026-12-31 | `economy` | rewards-200-4pt5-50, fed-rates, economic-policy, fed, busin… |
| Strait of Hormuz traffic returns to normal by December 31? | 291k | 115k | 2026-12-31 | `economy` | politics, ships, geopolitics, economy, diplomacy-ceasefire,… |
| Fed rate hike in 2026? | 278k | 103k | 2026-12-09 | `economy` | cpi-release, fed, economic-policy, jerome-powell, economy, … |

### Perto de entrar — cortados pelo teto de 50 (10)

| pergunta | liquidez | vol 24h | via | tags do evento |
| --- | ---: | ---: | --- | --- |
| Will Bitcoin dip to $47,500 in August? | 97k | 83k | `crypto` | bitcoin, monthly, hit-price, crypto, crypto-prices, recurri… |
| Will Bitcoin dip to $5,000 by December 31, 2026? | 96k | 309 | `crypto` | bitcoin, yearly, hit-price, crypto-prices, crypto |
| Will Bitcoin reach $200,000 by December 31, 2026? | 94k | 653 | `crypto` | bitcoin, yearly, hit-price, crypto-prices, crypto |
| Will Bitcoin reach $85,000 in August? | 94k | 18k | `crypto` | bitcoin, monthly, hit-price, crypto, crypto-prices, recurri… |
| Will Ethereum dip to $800 by December 31, 2026? | 91k | 3.1k | `crypto` | ethereum, hit-price, crypto-prices, yearly, crypto |
| Will Bitcoin dip to $42,500 in August? | 90k | 52k | `crypto` | bitcoin, monthly, hit-price, crypto, crypto-prices, recurri… |
| Will Bitcoin dip to $50,000 by December 31, 2026? | 87k | 11k | `crypto` | bitcoin, yearly, hit-price, crypto-prices, crypto |
| Will Crude Oil reach a new all-time high by December 31? | 84k | 550 | `finance` | oil, geopolitics, commodities, finance, iran |
| Will XRP reach $3.00 in August? | 83k | 2.9k | `crypto` | xrp, ripple, monthly, hit-price, crypto, crypto-prices, rec… |
| Will Bitcoin reach $90,000 by December 31, 2026? | 82k | 5.5k | `crypto` | bitcoin, yearly, hit-price, crypto-prices, crypto |

### Descartados pela regra (10 mais líquidos)

| pergunta | liquidez | motivo | tags do evento |
| --- | ---: | --- | --- |
| Will the price of Bitcoin be above $74,000 on August 14? | 171k | livro de um lado só (ou invertido) | — |
| Will the price of Bitcoin be above $54,000 on August 14? | 131k | livro de um lado só (ou invertido) | — |
| Will the price of Bitcoin be above $56,000 on August 14? | 123k | livro de um lado só (ou invertido) | — |
| Will the price of Bitcoin be above $72,000 on August 14? | 99k | livro de um lado só (ou invertido) | — |
| Will Kraken have the highest IPO Market Cap 2026? | 90k | livro de um lado só (ou invertido) | — |
| Will Perplexity AI have the highest IPO Market Cap 2026? | 83k | livro de um lado só (ou invertido) | — |
| Will Waymo have the highest IPO Market Cap 2026? | 81k | livro de um lado só (ou invertido) | — |
| Will Discord have the highest IPO Market Cap 2026? | 77k | livro de um lado só (ou invertido) | — |
| Will Revolut have the highest IPO Market Cap 2026? | 76k | livro de um lado só (ou invertido) | — |
| Will SHEIN have the highest IPO Market Cap 2026? | 73k | livro de um lado só (ou invertido) | — |

## eleicoes-e-politica

Tags: `elections`, `politics`

### Entraram (10)

| pergunta | liquidez | vol 24h | prazo | via | tags do evento |
| --- | ---: | ---: | --- | --- | --- |
| Strait of Hormuz traffic returns to normal by August 15? | 1.1M | 334k | 2026-08-15 | `politics` | oil, iran, politics, geopolitics, strait-of-hormuz |
| Will the U.S. invade Iran before 2027? | 977k | 23k | 2026-12-31 | `politics` | military-strikes, politics, geopolitics, world, middle-east… |
| Will the Iranian regime fall before 2027? | 760k | 21k | 2026-12-31 | `politics` | reza-pahlavi, iranian-leadership-regime, iran, israel, worl… |
| Putin out as President of Russia by December 31, 2026? | 739k | 18k | 2026-12-31 | `politics` | putin, geopolitics, ukraine, politics, world, russia, earn-4 |
| Will the US confirm that aliens exist before 2027? | 719k | 15k | 2026-12-31 | `politics` | aliens, politics, pop-culture, science |
| Will China invade Taiwan by end of 2026? | 677k | 79k | 2026-12-31 | `politics` | politics, world, geopolitics, foreign-policy, china, earn-4 |
| Strait of Hormuz traffic returns to normal by August 31? | 676k | 386k | 2026-08-31 | `politics` | oil, iran, politics, geopolitics, strait-of-hormuz |
| Strait of Hormuz traffic returns to normal by September 30? | 507k | 139k | 2026-09-30 | `politics` | oil, iran, politics, geopolitics, strait-of-hormuz |
| Trump out as President before 2027? | 503k | 35k | 2026-12-31 | `elections` | politics, trump, geopolitics, elections, epstein |
| Will Donald Trump win the Nobel Peace Prize in 2026? | 490k | 11k | 2026-10-10 | `politics` | awards, politics, geopolitics, world |

### Perto de entrar — cortados pelo teto de 50 (10)

| pergunta | liquidez | vol 24h | via | tags do evento |
| --- | ---: | ---: | --- | --- |
| 2026 Balance of Power: Other | 150k | 681 | `elections` | united-states, rewards-20-4pt5-50, politics, us-presidentia… |
| Will A Just Russia – For Truth (SRZP) win the most seats in the next Russia… | 148k | 3.4k | `elections` | politics, russia-election, main-election, putin, russia, wo… |
| Will Yariv Levin be the next Prime Minister of Israel? | 148k | 737 | `elections` | main-election, israel-election, politics, middle-east, isra… |
| Trump out as President by August 31? | 148k | 73k | `politics` | resign, politics, donald-trump, trump |
| Will Avigdor Lieberman be the next Prime Minister of Israel? | 146k | 4.0k | `elections` | main-election, israel-election, politics, middle-east, isra… |
| Will the Liberal Democratic Party of Russia (LDPR) gain the most seats in t… | 143k | 5.8k | `elections` | politics, international-election-props, world-elections, el… |
| Will Volodymyr Zelenskyy win the Nobel Peace Prize in 2026? | 142k | 645 | `politics` | awards, politics, geopolitics, world |
| Will the Communist Party of the Russian Federation (KPRF) win the most seat… | 140k | 4.0k | `elections` | politics, russia-election, main-election, putin, russia, wo… |
| US announces end of Iranian blockade by October 31, 2026? | 140k | 22k | `politics` | iran, trump, blockade, politics, shipping, peace-deal, geop… |
| Jeffrey Epstein confirmed to be alive before 2027? | 138k | 871 | `politics` | epstein, politics, trump |

### Descartados pela regra (10 mais líquidos)

| pergunta | liquidez | motivo | tags do evento |
| --- | ---: | --- | --- |
| Will Civic Platform (GP) gain the most seats in the next Russian parliament… | 393k | livro de um lado só (ou invertido) | politics, international-election-props, world-ele… |
| Will Elaine Culotti win the California Governor Election in 2026? | 353k | livro de um lado só (ou invertido) | — |
| Will Eleni Kounalakis win the California Governor Election in 2026? | 351k | livro de um lado só (ou invertido) | — |
| Will Betty Yee win the California Governor Election in 2026? | 349k | livro de um lado só (ou invertido) | — |
| Will Leo Zacky win the California Governor Election in 2026? | 349k | livro de um lado só (ou invertido) | — |
| Will Butch Ware win the California Governor Election in 2026? | 349k | livro de um lado só (ou invertido) | — |
| Will Rick Caruso win the California Governor Election in 2026? | 348k | livro de um lado só (ou invertido) | — |
| Will Toni Atkins win the California Governor Election in 2026? | 347k | livro de um lado só (ou invertido) | — |
| Will Alex Padilla win the California Governor Election in 2026? | 345k | livro de um lado só (ou invertido) | — |
| Will Michael Younger win the California Governor Election in 2026? | 344k | livro de um lado só (ou invertido) | — |

## esporte-de-temporada

Tags: `sports`

### Entraram (10)

| pergunta | liquidez | vol 24h | prazo | via | tags do evento |
| --- | ---: | ---: | --- | --- | --- |
| Will Vitinha win the 2026 Ballon d'Or? | 650k | 8.8k | 2026-10-31 | `sports` | soccer, sports, awards |
| Will Kimi Antonelli be the 2026 F1 Drivers' Champion? | 551k | 7.9k | 2026-12-06 | `sports` | sports, formula1, f1 |
| Will Declan Rice win the 2026 Ballon d'Or? | 508k | 3.8k | 2026-10-31 | `sports` | soccer, sports, awards |
| Will Oscar Piastri be the 2026 F1 Drivers' Champion? | 491k | 45k | 2026-12-06 | `sports` | sports, formula1, f1 |
| Will Javokhir Sindarov win the 2026 World Chess Championship? | 388k | 0 | 2027-01-01 | `sports` | chess, fide, world-championship, sports |
| Will Jude Bellingham win the 2026 Ballon d'Or? | 377k | 8.8k | 2026-10-31 | `sports` | soccer, sports, awards |
| Will Michael Olise win the 2026 Ballon d'Or? | 344k | 3.9k | 2026-10-31 | `sports` | soccer, sports, awards |
| Will Erling Haaland win the 2026 Ballon d'Or? | 298k | 3.6k | 2026-10-31 | `sports` | soccer, sports, awards |
| Will Harry Kane win the 2026 Ballon d'Or? | 291k | 14k | 2026-10-31 | `sports` | soccer, sports, awards |
| Will Max Verstappen be the 2026 F1 Drivers' Champion? | 288k | 3.5k | 2026-12-06 | `sports` | sports, formula1, f1 |

### Perto de entrar — cortados pelo teto de 50 (10)

| pergunta | liquidez | vol 24h | via | tags do evento |
| --- | ---: | ---: | --- | --- |
| Will Washington Commanders win the 2027 NFL NFC Championship? | 108k | 0 | `sports` | nfl, sports, nfl-playoffs, football, nfc, nfl-team-futures |
| Will the Houston Astros win the 2026 World Series? | 108k | 7 | `sports` | sports, world-series, mlb, mlb-playoffs, baseball |
| Will the Seattle Mariners win the 2026 World Series? | 106k | 830 | `sports` | sports, world-series, mlb, mlb-playoffs, baseball |
| Will Notre Dame Fighting Irish win the 2027 CFP National Championship? | 106k | 0 | `sports` | college-football-playoffs, national-championship, sports, f… |
| Will Minnesota Vikings win the 2027 NFL NFC Championship? | 105k | 0 | `sports` | nfl, sports, nfl-playoffs, football, nfc, nfl-team-futures |
| Will Oregon Ducks win the 2027 CFP National Championship? | 105k | 0 | `sports` | college-football-playoffs, national-championship, sports, f… |
| Will New England Patriots win the 2027 NFL AFC Championship? | 102k | 0 | `sports` | football, sports, afc, nfl-playoffs, nfl, nfl-team-futures |
| Will Arizona Cardinals win the 2027 NFL NFC Championship? | 101k | 0 | `sports` | nfl, sports, nfl-playoffs, football, nfc, nfl-team-futures |
| Will Flavio Cobolli win the 2026 Men's US Open? | 101k | 0 | `sports` | sports, atp, tennis |
| Will the Miami Marlins win the 2026 World Series? | 100k | 25 | `sports` | sports, world-series, mlb, mlb-playoffs, baseball |

### Descartados pela regra (10 mais líquidos)

| pergunta | liquidez | motivo | tags do evento |
| --- | ---: | --- | --- |
| National Bank Open: Ben Shelton vs Brandon Nakashima | 1.4M | mercado de partida (jogo único) | tennis, sports, games |
| Will Franco Colapinto be the 2026 F1 Drivers' Champion? | 923k | livro de um lado só (ou invertido) | sports, formula1, f1 |
| Will Valtteri Bottas be the 2026 F1 Drivers' Champion? | 920k | livro de um lado só (ou invertido) | sports, formula1, f1 |
| Will Arvid Lindblad be the 2026 F1 Drivers' Champion? | 918k | livro de um lado só (ou invertido) | sports, formula1, f1 |
| Will Nico Hülkenberg be the 2026 F1 Drivers' Champion? | 911k | livro de um lado só (ou invertido) | sports, formula1, f1 |
| Will Liam Lawson be the 2026 F1 Drivers' Champion? | 908k | livro de um lado só (ou invertido) | sports, formula1, f1 |
| Will Alexander Albon be the 2026 F1 Drivers' Champion? | 903k | livro de um lado só (ou invertido) | sports, formula1, f1 |
| Will Oliver Bearman be the 2026 F1 Drivers' Champion? | 890k | livro de um lado só (ou invertido) | sports, formula1, f1 |
| Will Gabriel Bortoleto be the 2026 F1 Drivers' Champion? | 888k | livro de um lado só (ou invertido) | sports, formula1, f1 |
| Will Lance Stroll be the 2026 F1 Drivers' Champion? | 880k | livro de um lado só (ou invertido) | sports, formula1, f1 |

## geopolitica-e-conflitos

Tags: `geopolitics`, `world`

### Entraram (10)

| pergunta | liquidez | vol 24h | prazo | via | tags do evento |
| --- | ---: | ---: | --- | --- | --- |
| US-Iran Final Nuclear Deal by August 31, 2026? | 387k | 34k | 2026-08-31 | `geopolitics` | iran, us-iran, peace-deal, geopolitics, middle-east, diplom… |
| US-Iran Final Nuclear Deal by December 31, 2026? | 322k | 21k | 2026-09-30 | `geopolitics` | iran, us-iran, peace-deal, geopolitics, middle-east, diplom… |
| US-Iran Final Nuclear Deal by August 18, 2026? | 265k | 7.0k | 2026-08-18 | `geopolitics` | iran, us-iran, peace-deal, geopolitics, middle-east, diplom… |
| Kharg Island no longer under Iranian control by September 30? | 265k | 30k | 2026-09-30 | `geopolitics` | iranian-leadership-regime, iran, mojtaba-khamenei, khamenei… |
| US-Iran Final Nuclear Deal by September 30, 2026? | 263k | 8.1k | 2026-09-30 | `geopolitics` | iran, us-iran, peace-deal, geopolitics, middle-east, diplom… |
| Xi Jinping out before 2027? | 247k | 3.3k | 2026-12-31 | `geopolitics` | hfc, geopolitics, world, world-affairs, earn-4, macro-geopo… |
| Russia x Ukraine ceasefire by December 31, 2026? | 130k | 16k | 2026-12-31 | `geopolitics` | geopolitics, ukraine-peace-deal, putin, zelensky, trump, uk… |
| Will Reza Pahlavi enter Iran by December 31? | 128k | 8 | 2026-12-31 | `geopolitics` | shah, reza-pahlavi, iranian-leadership-regime, iran, world,… |
| NATO x Russia military clash by December 31, 2026? | 115k | 8.2k | 2026-12-31 | `geopolitics` | nato, trump-presidency, trump, russia, geopolitics, world, … |
| Russia x Ukraine ceasefire by October 31, 2026? | 99k | 7.6k | 2026-12-31 | `geopolitics` | geopolitics, ukraine-peace-deal, putin, zelensky, trump, uk… |

### Perto de entrar — cortados pelo teto de 50 (10)

| pergunta | liquidez | vol 24h | via | tags do evento |
| --- | ---: | ---: | --- | --- |
| Will Strait of Hormuz traffic return to normal in December? | 46k | 0 | `geopolitics` | oil, iran, politics, geopolitics, trump-iran, strait-of-hor… |
| US announces end of Iranian blockade by August 22, 2026? | 46k | 133k | `geopolitics` | iran, trump, blockade, politics, shipping, peace-deal, geop… |
| Will Alireza Arafi be head of state in Iran end of 2026? | 46k | 126 | `geopolitics` | middle-east, iran, world, geopolitics, politics, iranian-le… |
| Iran-Oman Hormuz Agreement by September 30? | 45k | 1.7k | `geopolitics` | iran, trump, peace-deal, geopolitics, strait-of-hormuz |
| Will Strait of Hormuz traffic return to normal in October? | 45k | 0 | `geopolitics` | oil, iran, politics, geopolitics, trump-iran, strait-of-hor… |
| Will the next diplomatic US-Iran meeting be in Oman by September 30, 2026? | 45k | 635 | `geopolitics` | iran, trump, vance, nuclear, us-iran, khamenei, politics, p… |
| Will Russia capture all of Kostyantynivka by December 31, 2026? | 45k | 9.3k | `geopolitics` | politics, ukraine-map, geopolitics |
| Will there be between 60 and 80 average daily transits of the Strait of Hor… | 45k | 149 | `geopolitics` | oil, iran, hormuz, geopolitics, strait-of-hormuz |
| Will no listed leader be out before 2027? | 45k | 1.2k | `geopolitics` | starmer, politics, geopolitics, uk-labour-leadership |
| Will Strait of Hormuz traffic return to normal in November? | 44k | 0 | `geopolitics` | oil, iran, politics, geopolitics, trump-iran, strait-of-hor… |

### Descartados pela regra (3 mais líquidos)

| pergunta | liquidez | motivo | tags do evento |
| --- | ---: | --- | --- |
| Will 100 or more ships transit the Strait of Hormuz between August 10-Augus… | 32k | livro de um lado só (ou invertido) | — |
| Will the next diplomatic US-Iran meeting be in Russia by September 30, 2026? | 28k | livro de um lado só (ou invertido) | iran, trump, vance, nuclear, us-iran, khamenei, p… |
| Will there be 80 or more average daily transits of the Strait of Hormuz on … | 26k | livro de um lado só (ou invertido) | oil, iran, hormuz, geopolitics, strait-of-hormuz |

## Fora de todas as categorias

Os 18 mercados mais líquidos da janela de 180 dias que nenhuma tag do recorte alcançou. É aqui que um buraco no mapa aparece: se alguma destas linhas interessa, a categoria dela precisa de uma tag nova.

Varridos 600 mercados por liquidez decrescente; 18 estavam fora do recorte.

| pergunta | liquidez | prazo | tags do evento |
| --- | ---: | --- | --- |
| Will Jesus Christ return before 2027? | 781k | 2026-12-31 | parent-for-derivative, pop-culture |
| Hantavirus pandemic in 2026? | 365k | 2026-12-31 | pandemics, weather, hantavirus |
| Will The Hunger Games: Sunrise on the Reaping be the top grossing movie of … | 275k | 2026-12-31 | rewards-20-4pt5-50, the-odyssey, pop-culture, movies, spide… |
| Will Star Wars: The Mandalorian and Grogu be the top grossing movie of 2026? | 263k | 2026-12-31 | rewards-20-4pt5-50, the-odyssey, pop-culture, movies, spide… |
| Will Wuthering Heights be the top grossing movie of 2026? | 257k | 2026-12-31 | rewards-20-4pt5-50, the-odyssey, pop-culture, movies, spide… |
| Will Jumanji 3 be the top grossing movie of 2026? | 240k | 2026-12-31 | rewards-20-4pt5-50, the-odyssey, pop-culture, movies, spide… |
| Will The Super Mario Galaxy Movie be the top grossing movie of 2026? | 238k | 2026-12-31 | rewards-20-4pt5-50, the-odyssey, pop-culture, movies, spide… |
| Will Michael be the top grossing movie of 2026? | 227k | 2026-12-31 | rewards-20-4pt5-50, the-odyssey, pop-culture, movies, spide… |
| Will Scream 7 be the top grossing movie of 2026? | 222k | 2026-12-31 | rewards-20-4pt5-50, the-odyssey, pop-culture, movies, spide… |
| Will Wicked: For Good be the top grossing movie of 2026? | 216k | 2026-12-31 | rewards-20-4pt5-50, the-odyssey, pop-culture, movies, spide… |
| Will Project Hail Mary be the top grossing movie of 2026? | 205k | 2026-12-31 | rewards-20-4pt5-50, the-odyssey, pop-culture, movies, spide… |
| Will Dune: Messiah be the top grossing movie of 2026? | 194k | 2026-12-31 | rewards-20-4pt5-50, the-odyssey, pop-culture, movies, spide… |
| Will Avengers: Doomsday be the top grossing movie of 2026? | 193k | 2026-12-31 | rewards-20-4pt5-50, the-odyssey, pop-culture, movies, spide… |
| Is Earth flat? | 157k | 2027-01-01 | pop-culture, conspiracy, earthquake, flat-earth, conspiracy… |
| Will Toy Story 5 be the top grossing movie of 2026? | 148k | 2026-12-31 | rewards-20-4pt5-50, the-odyssey, pop-culture, movies, spide… |
| Will The Odyssey be the top grossing movie of 2026? | 123k | 2026-12-31 | rewards-20-4pt5-50, the-odyssey, pop-culture, movies, spide… |
| Ebola pandemic in 2026? | 106k | 2026-12-31 | weather, hantavirus, pandemics |
| New "Stranger Things" episode released by December 31? | 102k | 2026-12-31 | pop-culture, tv, netflix, movies |

---

58 chamadas à Gamma.
