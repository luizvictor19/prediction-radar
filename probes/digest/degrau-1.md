# Digestão de regras — degrau 1

10 mercados, um modelo só — a leitura antes de qualquer escala

- **mercados:** 10
- **modelos:** `deepseek-v4-flash`
- **chamadas:** 10
- **amostra:** aleatória, semente fixa `20260815` (reprodutível: mesma semente, mesma lista)
- **custo estimado antes de rodar:** US$ 0.00353
- **custo real:** US$ 0.0136 (+285.6% sobre o estimado)

## Medidas

| modelo | chamadas | inválidas | taxa | custo total | por mercado | latência mediana | pegadinhas (mediana) | ambiguidades (mediana) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `deepseek-v4-flash` | 10 | 1 | 10.0% | US$ 0.0136 | US$ 0.00151 | 39063 ms | 3.0 | 2.0 |


A comparação de QUALIDADE não está aqui de propósito: as medidas acima são as
objetivas, e o texto de cada modelo sai inteiro abaixo. Quem julga é quem lê.

## As digestões
### 1. Will the Chicago White Sox win the 2026 World Series?

<sub>`will-the-chicago-white-sox-win-the-2026-world-series` · esporte-de-temporada · hash `789348b98098` · 618 caracteres de regra</sub>

<details><summary>a regra, íntegra</summary>

```
This market will resolve according to the team that wins the 2026 MLB World Series. 

If at any point it becomes impossible for a listed team to win the 2026 MLB World Series per the rules of MLB (e.g., they are eliminated in the playoffs), the corresponding market will resolve to “No”.

If the 2026 MLB season is cancelled, postponed after December 31, 2026 ET, or there is otherwise no winner declared within that timeframe, this market will resolve to “Other”.

The primary resolution source will be official information from MLB (https://www.mlb.com/); however, a consensus of credible reporting may also be used.
```

</details>

**Resolve SIM:**

- O Chicago White Sox vencer a World Series de 2026 da MLB.

**Resolve NÃO:**

- Se o Chicago White Sox não vencer a World Series de 2026, o mercado resolve 'Não' (complemento do Sim).
- Se em qualquer momento for impossível o Chicago White Sox vencer a World Series de 2026 segundo as regras da MLB (ex.: eliminado nos playoffs), o mercado resolve 'Não'.

**Fonte:** Informações oficiais da MLB (https://www.mlb.com/), podendo também ser usado um consenso de reportagens confiáveis.

**Prazo:** 31 de dezembro de 2026 ET

**Anula se:**

- Se a temporada de 2026 da MLB for cancelada, adiada para depois de 31 de dezembro de 2026 ET, ou se não houver vencedor declarado nesse prazo, o mercado resolve para 'Other' (nem Sim, nem Não).

**Pegadinhas:**

- O mercado resolve 'Não' assim que o White Sox for eliminado matematicamente, antes do fim da World Series — não espera o término da série.
- Se a temporada for cancelada ou adiada além de 31/12/2026, o resultado é 'Other', não 'Não'.

**Ambiguidades:**

- A frase 'postponed after December 31, 2026 ET' pode ser lida como 'adiada para depois de 31/12/2026' ou 'adiada depois de 31/12/2026 (ou seja, a decisão de adiar ocorre após essa data)' — a leitura mais natural é a primeira, mas há espaço para interpretação.
- A expressão 'consensus of credible reporting' não define o que constitui consenso — pode ser interpretada de diferentes maneiras.

<sub>deepseek-v4-flash · 1877+3776 tok · US$ 0.00132 · 33690 ms</sub>

---

### 2. Will the price of Bitcoin be above $76,000 on August 15?

<sub>`bitcoin-above-76k-on-august-15-2026` · macro-e-mercados · hash `43c4bf4589be` · 676 caracteres de regra</sub>

<details><summary>a regra, íntegra</summary>

```
This market will resolve to "Yes" if the Binance 1 minute candle for BTC/USDT 12:00 in the ET timezone (noon) on the date specified in the title has a final "Close" price higher than the price specified in the title. Otherwise, this market will resolve to "No".

The resolution source for this market is Binance, specifically the BTC/USDT "Close" prices currently available at https://www.binance.com/en/trade/BTC_USDT with "1m" and "Candles" selected on the top bar.

Please note that this market is about the price according to Binance BTC/USDT, not according to other exchanges or trading pairs.

Price precision is determined by the number of decimal places in the source.
```

</details>

**Resolve SIM:**

- O candle de 1 minuto da Binance para BTC/USDT às 12:00 no fuso ET (meio-dia) na data do título (15 de agosto de 2026) tem preço de fechamento ('Close') final maior que US$ 76.000.

**Resolve NÃO:**

- Se o fechamento do candle às 12:00 ET não for maior que US$ 76.000 (ou seja, menor ou igual), resolve 'Não'.

**Fonte:** Binance — preço de fechamento ('Close') do par BTC/USDT, com candle de 1 minuto, conforme disponível em https://www.binance.com/en/trade/BTC_USDT com '1m' e 'Candles' selecionados.

**Prazo:** 15 de agosto de 2026, às 12:00 ET (meio-dia, horário do leste dos EUA).

**Anula se:** —

**Pegadinhas:**

- O preço pode passar de US$ 76.000 em qualquer outro momento do dia 15 de agosto, mas só o fechamento do candle de 1 minuto às 12:00 ET conta — o restante do dia é ignorado.
- Se o fechamento for exatamente US$ 76.000, resolve 'Não', pois a regra exige 'higher than' (acima), não 'greater or equal'.
- O preço considerado é o do par BTC/USDT da Binance; valores em outras corretoras ou de outros pares (como BTC/USD) não contam.

**Ambiguidades:**

- A regra usa 'ET timezone' sem especificar se é EST (UTC-5) ou EDT (UTC-4). Em 15 de agosto, o horário de verão dos EUA está em vigor, então ET corresponde a EDT (UTC-4), mas a ausência de explicitação pode gerar leituras diferentes.

<sub>deepseek-v4-flash · 1904+3162 tok · US$ 0.00115 · 24530 ms</sub>

---

### 3. Will the Iranian regime fall by September 30?

<sub>`will-the-iranian-regime-fall-by-september-30-20260629143335077` · eleicoes-e-politica · hash `2a92f292289c` · 1372 caracteres de regra</sub>

<details><summary>a regra, íntegra</summary>

```
This market will resolve to "Yes" if the Islamic Republic of Iran’s current ruling regime is overthrown, collapsed, or otherwise ceases to govern by September 30, 2026, 11:59 PM ET. Otherwise, this market will resolve to “No”.

This requires a broad consensus of reporting indicating that core structures of the Islamic Republic (e.g. the office of the Supreme Leader, the Guardian Council, IRGC control under clerical authority) have been dissolved, incapacitated, or replaced by a fundamentally different governing system or otherwise lost de facto power over a majority of the population of Iran. This could occur via revolution, civil war, military coup, or voluntary abdication, but only qualifies if the Islamic Republic no longer exercises sovereign power.

Routine political events such as elections, reforms, or leadership succession do not qualify. Internal coups or power shifts that preserve the Islamic Republic’s core structures also do not qualify. Only a clear break in continuity—such as a new provisional government, revolutionary council, or constitution replacing the Islamic Republic will qualify.

Partial loss of territory or challenges from rebel or exile groups will not qualify unless the Islamic Republic no longer administers the majority of the Iranian population within Iran. 

The resolution source will be a consensus of credible reporting.
```

</details>

> **FALHOU** (`opiniao`): saída contém opinião sobre desfecho em ambiguidades ("provável"): ... leitura restritiva (residentes) é mais provável, mas não explícita; a leitura ampla incluiria milhõ...

---

### 4. Will Angel Reese be the #1 searched person on Google this year?

<sub>`will-angel-reese-be-the-1-searched-person-on-google-this-year-20260717214426286` · ia-e-tecnologia · hash `0fba60e03908` · 909 caracteres de regra</sub>

<details><summary>a regra, íntegra</summary>

```
This market will resolve according to the individual ranked #1 in Google’s official Year in Search Global "People" list for 2026.

The specified list is expected to be displayed on the Google Trends Year in Search hub, with location selected to Global. The navigation procedure as of market creation involves going to trends.withgoogle.com/year-in-search/ and clicking through Global → Trending → People. The 2026 page is expected to appear using the same navigation once released (as the 2025 page currently shows the specified ranking). This market will resolve based on the specified list regardless of navigation procedure.

This market may resolve as soon as the specified list for 2026 is released. If Google does not release the specified list by March 31, 2027, 11:59 PM ET, this market will resolve to “Other.”

The resolution source for this market will be the specified list as published by Google.
```

</details>

**Resolve SIM:**

- Angel Reese for o indivíduo classificado como #1 na lista oficial 'Year in Search Global People' do Google para 2026.

**Resolve NÃO:**

- A regra não descreve condição explícita de NÃO; por complemento, resolve NÃO se o #1 da lista for qualquer pessoa diferente de Angel Reese.
- Se o Google não publicar a lista especificada até 31 de março de 2027, 23:59 ET, o mercado resolve para 'Other', que também não é SIM.

**Fonte:** Google (lista oficial 'Year in Search Global People')

**Prazo:** 31 de março de 2027, 23:59 ET

**Anula se:** —

**Pegadinhas:**

- Pode parecer que ser a pessoa mais pesquisada em qualquer ranking do Google basta, mas a regra exige a lista oficial 'Year in Search Global People' de 2026 — rankings de outras categorias ou ferramentas de tendência não contam.
- Pode parecer que o #1 em uma lista regional (por exemplo, de um país específico) conta, mas a regra exige a seleção de local Global — listas de países individuais não são a fonte de resolução.
- Pode parecer que somente uma lista publicada durante o ano de 2026 é válida, mas a regra permite resolução até 31 de março de 2027; uma lista oficial de 2026 publicada em 2027 ainda conta.

**Ambiguidades:**

- O trecho "March 31, 2027, 11:59 PM ET" usa 'ET', que pode significar Eastern Standard Time (UTC-5) ou Eastern Daylight Time (UTC-4); a regra não especifica qual, criando uma ambiguidade de uma hora no prazo.
- O trecho "this market will resolve to “Other”" é ambíguo: pode significar que o mercado resolve para um terceiro resultado 'Other' (nem SIM nem NÃO), ou pode significar que resolve NÃO porque Angel Reese não é #1, já que não há lista.

<sub>deepseek-v4-flash · 1940+7404 tok · US$ 0.00234 · 64142 ms</sub>

---

### 5. Will Apple be the largest company in the world by market cap on August 31?

<sub>`will-apple-be-the-largest-company-in-the-world-by-market-cap-on-august-31-20260715202138601` · ia-e-tecnologia · hash `e57adb0f05f8` · 196 caracteres de regra</sub>

<details><summary>a regra, íntegra</summary>

```
This market will resolve to the largest company in the world by market cap on August 31, 2026, as of market close.

The resolution source for this market will be a consensus of credible reporting.
```

</details>

**Resolve SIM:**

- Apple é a maior empresa do mundo por valor de mercado em 31 de agosto de 2026, ao fechamento do mercado.

**Resolve NÃO:**

- Como a regra não descreve explicitamente o NÃO, o mercado resolve NÃO quando a condição de SIM não for satisfeita.

**Fonte:** consensus of credible reporting

**Prazo:** 31 de agosto de 2026, ao fechamento do mercado

**Anula se:** —

**Pegadinhas:**

- Pode parecer que a capitalização intradiária conta, mas a regra exige o valor no fechamento do mercado.
- Pode parecer que 'maior empresa' refere-se a receita ou lucro, mas a regra define especificamente 'by market cap'.
- Pode parecer que uma fonte oficial única decide, mas a regra usa um consenso de reportagens confiáveis, que pode divergir.

**Ambiguidades:**

- O trecho 'This market will resolve to the largest company in the world by market cap' pode ser lido como um mercado categórico (resolve para o nome da empresa) ou como uma condição sim/não (se a Apple é a maior). A pergunta sugere sim/não, mas o texto da regra é ambíguo.
- O trecho 'as of market close' não especifica qual mercado ou fuso horário; pode ser o fechamento da bolsa onde a empresa está listada ou um horário padrão.
- O trecho 'consensus of credible reporting' é vago: não define o que conta como 'credible' nem como o consenso é formado.

<sub>deepseek-v4-flash · 1801+4535 tok · US$ 0.00152 · 39063 ms</sub>

---

### 6. Will Bitcoin reach $150,000 by December 31, 2026?

<sub>`will-bitcoin-reach-150000-by-december-31-2026-557-246-971` · macro-e-mercados · hash `77bd0e1a0059` · 782 caracteres de regra</sub>

<details><summary>a regra, íntegra</summary>

```
This market will immediately resolve to "Yes" if any Binance 1 minute candle for Bitcoin (BTC/USDT) between November 24, 2025, 14:00 and December 31, 2026, 23:59 in the ET timezone has a final "High" price equal to or greater than the price specified in the title. Otherwise, this market will resolve to "No."

The resolution source for this market is Binance, specifically the BTC/USDT "High" prices available at https://www.binance.com/en/trade/BTC_USDT, with the chart settings on "1m" for one-minute candles selected on the top bar.

Please note that the outcome of this market depends solely on the price data from the Binance BTC/USDT trading pair. Prices from other exchanges, different trading pairs, or spot markets will not be considered for the resolution of this market.
```

</details>

**Resolve SIM:**

- O mercado resolve 'Sim' se qualquer candle de 1 minuto da Binance para BTC/USDT, entre 24 de novembro de 2025 às 14:00 e 31 de dezembro de 2026 às 23:59 no fuso ET, tiver preço 'High' final igual ou maior que US$ 150.000.

**Resolve NÃO:**

- Caso contrário, se nenhum candle no período tiver High final igual ou superior a US$ 150.000, o mercado resolve 'Não'.

**Fonte:** Binance, especificamente os preços 'High' do par BTC/USDT em https://www.binance.com/en/trade/BTC_USDT, com candles de 1 minuto.

**Prazo:** Entre 24 de novembro de 2025, 14:00 e 31 de dezembro de 2026, 23:59 no fuso ET.

**Anula se:** —

**Pegadinhas:**

- A pergunta sugere que basta o Bitcoin alcançar US$ 150.000 em qualquer exchange; a regra exige o High de um candle de 1 minuto especificamente na Binance no par BTC/USDT, ignorando outras plataformas e pares.
- Parece que o preço de toque em qualquer momento conta; na verdade, apenas o valor final do High do candle de 1 minuto da Binance é considerado, não o preço a cada negociação.
- Parece que a janela vai até 31 de dezembro de 2026 em qualquer fuso; a regra define o limite no fuso ET, então eventos em outros fusos precisam ser convertidos para o timestamp do candle no fuso ET.
- Parece que o período começa na criação do mercado; a regra só considera candles a partir de 24 de novembro de 2025 às 14:00 ET, então eventos anteriores não contam.

**Ambiguidades:**

- A expressão 'between November 24, 2025, 14:00 and December 31, 2026, 23:59' não esclarece se o intervalo é inclusivo nos extremos nem se o candle deve ter o tempo de abertura ou de fechamento dentro desse intervalo; a leitura usual é que candles com tempo de abertura entre esses momentos contam, mas outra leitura poderia excluir o candle que começa exatamente no limite final.
- O termo 'ET timezone' admite duas leituras: Eastern Time com horário de verão (EDT/EST alternando) ou um fuso fixo de UTC-5; a regra não especifica o tratamento do horário de verão, o que pode alterar quais candles estão no período.

<sub>deepseek-v4-flash · 403+3859 tok · US$ 0.00116 · 31508 ms</sub>

---

### 7. Will Washington Commanders win the 2027 NFL NFC Championship?

<sub>`will-washington-commanders-win-the-2027-nfl-nfc-championship-484` · esporte-de-temporada · hash `f02ae2e8e4c5` · 642 caracteres de regra</sub>

<details><summary>a regra, íntegra</summary>

```
This market will resolve according to the team that wins the 2027 NFC championship game.

If at any point it becomes impossible for a listed team to win the 2027 NFL NFC championship per the rules of the NFL (e.g., they are eliminated in the playoffs), the corresponding market will resolve to “No”.

If the 2027 NFL NFC championship game is cancelled, postponed after March 31, 2027 ET, or there is otherwise no winner declared within that timeframe, this market will resolve to “Other”.

The primary resolution source will be official information from NFL (https://www.nfl.com/); however, a consensus of credible reporting may also be used.
```

</details>

**Resolve SIM:**

- O Washington Commanders vence o jogo do campeonato da NFC de 2027.

**Resolve NÃO:**

- Se a qualquer momento se tornar impossível para o Washington Commanders vencer o campeonato da NFC de 2027 de acordo com as regras da NFL (por exemplo, eliminado nos playoffs), o mercado resolve 'Não'.
- Se o vencedor do jogo do campeonato da NFC de 2027 for outro time que não o Washington Commanders, o mercado resolve 'Não' (complemento do SIM).

**Fonte:** NFL (https://www.nfl.com/), com consenso de reportagens confiáveis como fonte alternativa.

**Prazo:** 31 de março de 2027, ET (Eastern Time)

**Anula se:**

- Se o jogo do campeonato da NFC de 2027 for cancelado, adiado para depois de 31 de março de 2027 ET, ou não houver vencedor declarado nesse prazo, o mercado resolve 'Other' (não resolve sim/não).

**Pegadinhas:**

- Pode parecer que o mercado só resolve depois do jogo do campeonato, mas a regra resolve 'Não' assim que o Washington Commanders for eliminado dos playoffs, mesmo antes do jogo.
- Pode parecer que um jogo cancelado ou adiado sem vencedor resolve 'Não', mas a regra resolve 'Other', não 'Não'.

**Ambiguidades:**

- O trecho '2027 NFL NFC championship' não especifica se refere ao jogo do campeonato da temporada de 2027 da NFL (que ocorreria em janeiro de 2028) ou ao jogo do campeonato realizado no ano civil de 2027 (da temporada de 2026).
- O trecho 'postponed after March 31, 2027 ET' pode significar: (a) o jogo foi adiado para uma data posterior a 31 de março, ou (b) a decisão de adiamento ocorre depois de 31 de março, ainda que a nova data seja anterior a essa data.

<sub>deepseek-v4-flash · 349+6232 tok · US$ 0.00181 · 51575 ms</sub>

---

### 8. China x Japan military clash before 2027?

<sub>`china-x-japan-military-clash-before-2027` · geopolitica-e-conflitos · hash `efb5fe8e29e4` · 1086 caracteres de regra</sub>

<details><summary>a regra, íntegra</summary>

```
This market will resolve to "Yes" if there is a military encounter between the military forces of China (People's Republic of China) and Japan between November 17, 2025, and December 31, 2026, 11:59 PM ET. Otherwise, this market will resolve to "No".

A "military encounter" is defined as any incident involving the use of force such as missile strikes, artillery fire, exchange of gunfire, or other forms of direct military engagement between Chinese and Japanese military forces. Non-violent actions, such as warning shots, artillery fire into uninhabited areas, or missile launches that land in territorial waters or pass through airspace, will not qualify for a "Yes" resolution. Intentional ship ramming that results in significant damage to (e.g., a hole in the hull) or the sinking of a military ship by another will count toward a "Yes" resolution, however minor damage (scrapes, dents) will not.

Note: the China Coast Guard (CCG) is part of the military, however Japan Coast Guard (JCG) is not.

The resolution source for this market will be a consensus of credible reporting.
```

</details>

**Resolve SIM:**

- Incidente com uso de força, como ataques com mísseis, fogo de artilharia, troca de tiros ou outras formas de engajamento militar direto, entre forças militares da China (República Popular da China) e do Japão, ocorrido entre 17 de novembro de 2025 e 31 de dezembro de 2026, 23h59 ET.
- Abalroamento intencional de um navio militar por outro que resulte em dano significativo (ex.: buraco no casco) ou afundamento, entre forças militares da China e do Japão, ocorrido no mesmo período de 17 de novembro de 2025 a 31 de dezembro de 2026, 23h59 ET.

**Resolve NÃO:**

- Na ausência de qualquer encontro militar conforme definido entre as forças militares da China e do Japão no período de 17 de novembro de 2025 a 31 de dezembro de 2026, 23h59 ET, o mercado resolve 'Não'.

**Fonte:** Consenso de reportagens confiáveis (consensus of credible reporting)

**Prazo:** 31 de dezembro de 2026, 23h59 ET

**Anula se:** —

**Pegadinhas:**

- Tiros de advertência, fogo de artilharia para áreas desabitadas e lançamentos de mísseis que caiam em águas territoriais ou cruzem espaço aéreo parecem encontro militar, mas a regra os exclui explicitamente da resolução 'Sim'.
- Abalroamento com danos menores (arranhões, amassados) não conta; apenas danos significativos (ex.: buraco no casco) ou afundamento contam.
- A Guarda Costeira Japonesa (JCG) não é considerada força militar, portanto confrontos envolvendo a JCG não contam; já a Guarda Costeira Chinesa (CCG) conta como militar.

**Ambiguidades:**

- 'other forms of direct military engagement' — a palavra 'direto' pode ser interpretada como exigindo confronto físico presencial, excluindo formas como guerra cibernética ou eletrônica, sem definição explícita na regra.
- 'missile launches that land in territorial waters or pass through airspace' — literalmente, qualquer lançamento de míssil que não atinja um alvo cairá em águas territoriais ou cruzará espaço aéreo; isso poderia excluir até disparos em combate que erram o alvo, embora a intenção pareça ser excluir apenas lançamentos não violentos (como avisos).

<sub>deepseek-v4-flash · 445+6547 tok · US$ 0.00192 · 54677 ms</sub>

---

### 9. Will Microsoft be the largest company in the world by market cap on September 30?

<sub>`will-company-b-be-the-largest-company-in-the-world-by-market-cap-on-september-30` · ia-e-tecnologia · hash `7af37b690c8a` · 199 caracteres de regra</sub>

<details><summary>a regra, íntegra</summary>

```
This market will resolve to the largest company in the world by market cap on September 30, 2026, as of market close.

The resolution source for this market will be a consensus of credible reporting.
```

</details>

**Resolve SIM:**

- Microsoft ser a maior empresa do mundo em capitalização de mercado em 30 de setembro de 2026, no fechamento do mercado.

**Resolve NÃO:**

- Se Microsoft não for a maior empresa do mundo em capitalização de mercado na data e no horário especificados, o mercado resolve NÃO.

**Fonte:** a consensus of credible reporting

**Prazo:** 30 de setembro de 2026, no fechamento do mercado (sem fuso horário explícito na regra)

**Anula se:** —

**Pegadinhas:**

- A posição de maior empresa durante o dia não conta: a regra exige 'as of market close', ou seja, apenas o valor no fechamento do mercado.
- A pergunta diz 'maior empresa do mundo', mas a regra define explicitamente 'by market cap', então métricas como receita, lucro ou número de funcionários não contam.

**Ambiguidades:**

- Trecho 'as of market close' — não especifica qual mercado: pode ser o fechamento da bolsa na qual a Microsoft está listada (NASDAQ) ou um horário de fechamento global padrão, gerando leituras diferentes.
- Trecho 'a consensus of credible reporting' — não define quais veículos são considerados confiáveis nem como o consenso é apurado, deixando margem para interpretações sobre qual reportagem prevalece.

<sub>deepseek-v4-flash · 258+2154 tok · US$ 0.00066 · 19403 ms</sub>

---

### 10. Will Partido Liberal (PL) hold the most seats in the Brazilian Chamber of Deputies after the 2026 election?

<sub>`will-partido-liberal-pl-hold-the-most-seats-in-the-brazilian-chamber-of-deputies-after-the-2026-election` · brasil · hash `545d2d6e82d2` · 1360 caracteres de regra</sub>

<details><summary>a regra, íntegra</summary>

```
The next federal Chamber of Deputies election is scheduled to take place in Brazil on October 4, 2026.

This market will resolve according to the political party or electoral federation that holds the greatest number of seats in the next Brazilian Chamber of Deputies (Câmara dos Deputados) as a result of the next Brazilian Chamber of Deputies election.

In the event of a tie between multiple entities for the most seats held, this market will resolve in favor of the entity whose listed abbreviation appears first in alphabetical order.

This market's resolution will be based solely on the number of seats held by the named party or electoral federation in the Brazilian Chamber of Deputies as a result of the next Brazilian Chamber of Deputies election, not by any coalition it may be a part of.

If the result of this election isn't known definitively by June 30, 2027, 11:59 PM ET, the market will resolve to "Other".

This market will resolve based on the result of the election, as indicated by a consensus of credible reporting. If there is ambiguity, this market will resolve based solely on the official results as reported by the Brazilian government, specifically the Superior Electoral Court (Tribunal Superior Eleitoral, TSE) (e.g., www.tse.jus.br/eleicoes/resultados-eleicoes) or the Brazilian Chamber of Deputies (https://www.camara.leg.br/).
```

</details>

**Resolve SIM:**

- O Partido Liberal (PL) for o partido ou federação eleitoral que detém o maior número de assentos na próxima Câmara dos Deputados, como resultado da eleição de 4 de outubro de 2026, contando apenas os assentos da entidade nomeada (PL).
- Em caso de empate no maior número de assentos, o PL for a entidade cuja abreviação ('PL') apareça primeiro em ordem alfabética entre as empatadas.

**Resolve NÃO:**

- O PL não for a entidade com o maior número de assentos, ou, em empate, não vencer pelo critério alfabético.
- Se o resultado da eleição não for definitivamente conhecido até 30 de junho de 2027, 23:59 ET, o mercado resolve para 'Other' (não-SIM).

**Fonte:** Consenso de reportagens confiáveis; em caso de ambiguidade, resultados oficiais do Tribunal Superior Eleitoral (TSE) ou da Câmara dos Deputados.

**Prazo:** Eleição em 4 de outubro de 2026; prazo para resultado definitivo: 30 de junho de 2027, 23:59 ET.

**Anula se:** —

**Pegadinhas:**

- Pode parecer que assentos de uma coligação ou federação eleitoral da qual o PL faça parte contam para o PL; a regra exclui expressamente coligações e considera apenas os assentos da entidade nomeada (partido ou federação), não de qualquer coligação da qual ela participe.

**Ambiguidades:**

- O trecho "if the result of this election isn't known definitively by June 30, 2027, 11:59 PM ET" admite duas leituras: (a) não houve divulgação de resultado oficial final até a data; (b) há qualquer contestação judicial ou recontagem em andamento, mesmo com um resultado provisório divulgado.

<sub>deepseek-v4-flash · 526+5822 tok · US$ 0.00172 · 54363 ms</sub>

