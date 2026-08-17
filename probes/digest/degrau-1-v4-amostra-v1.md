# Digestão de regras — degrau 1, prompt `v4`

10 mercados, um modelo só — a leitura antes de qualquer escala

- **mercados:** 10
- **modelos:** `deepseek-v4-flash`
- **prompt:** `v4`
- **chamadas:** 10
- **amostra:** aleatória, semente fixa `20260815` (reprodutível: mesma semente, mesma lista)
- **custo estimado antes de rodar:** US$ 0.0378
- **custo real:** US$ 0.0344 (-8.9% sobre o estimado)

## Medidas

| modelo | chamadas | inválidas | taxa | custo total | por mercado | latência mediana | pegadinhas (mediana) | ambiguidades (mediana) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `deepseek-v4-flash` | 10 | 0 | 0.0% | US$ 0.0344 | US$ 0.00344 | 92251 ms | 2.5 | 2.5 |


**Pegadinhas:** 28 em 10 digestões válidas — 0 mercado(s) vieram com ZERO, que é resposta desejada quando a regra é direta.

**Podadas pela conferência:** 1 de 29 (3.4%) — 1 por trecho inexistente, 0 por trecho repetido, 0 por trecho curto demais. 0 severidade(s) rebaixada(s) para `detalhe` por falta de cenário.

<details><summary>o que foi podado</summary>

- `trecho não está na regra` — A unidade que disputa o maior número de cadeiras pode ser uma federação partidária, tratada como entidade separada. Se o PL integrar uma federação e a federação tiver o maior número de cadeiras, isso não conta como o PL tendo o maior número.  
  trecho citado: *"This market will resolve according to the political party or electoral federation that holds the greatest number of seats in the next Brazilian Chamber of Deputies as a result of the next Brazilian Chamber of Deputies election."*

</details>

| severidade | n | % |
| --- | ---: | ---: |
| `muda_resultado` | 23 | 82.1% |
| `muda_timing` | 5 | 17.9% |
| `detalhe` | 0 | 0.0% |

**Ambiguidades:** 23 — taxa de `outro`: **0.0%** (abaixo de 20%: a lista fechada dá conta)

| tipo | n | % |
| --- | ---: | ---: |
| `contradicao_interna` | 0 | 0.0% |
| `precedencia_de_fonte` | 2 | 8.7% |
| `criterio_discricionario` | 3 | 13.0% |
| `fonte_vaga` | 6 | 26.1% |
| `fuso_ausente` | 5 | 21.7% |
| `momento_ambiguo` | 1 | 4.3% |
| `data_ambigua` | 1 | 4.3% |
| `janela_inclusiva` | 1 | 4.3% |
| `escopo_de_entidade` | 1 | 4.3% |
| `limiar_de_borda` | 1 | 4.3% |
| `formato_do_mercado` | 2 | 8.7% |
| `outro` | 0 | 0.0% |

A comparação de QUALIDADE não está aqui de propósito: as medidas acima são as
objetivas, e o texto de cada modelo sai inteiro abaixo. Quem julga é quem lê.

## As digestões
### 1. Will the price of Bitcoin be above $76,000 on August 15?

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

- O candle de 1 minuto da Binance para BTC/USDT às 12:00 ET (meio-dia) na data do título tem um preço 'Close' final maior que US$ 76.000.

**Resolve NÃO:**

- Caso contrário — em particular, se o 'Close' do candle das 12:00 ET for igual ou inferior a US$ 76.000.

**Fonte:** Binance, especificamente os preços 'Close' do BTC/USDT atualmente disponíveis em https://www.binance.com/en/trade/BTC_USDT com '1m' e 'Candles' selecionados.

**Prazo:** 12:00 ET (meio-dia) na data do título (15/08).

**Anula se:** —

**Pegadinhas (2):**

- `muda_resultado` — A resolução usa exclusivamente o candle de 1 minuto das 12:00 ET — qualquer outro momento do dia em que o Bitcoin esteja acima de US$ 76.000 não conta.
  - trecho: *"the Binance 1 minute candle for BTC/USDT 12:00 in the ET timezone (noon) on the date specified in the title has a final "Close" price higher than the price specified in the title"*
  - cenário: Se o preço do Bitcoin ficar acima de US$ 76.000 em qualquer outro minuto do dia 15/08, mas no candle das 12:00 ET o Close for igual ou abaixo, quem leu só o título espera SIM, mas a regra resolve NÃO.
- `muda_resultado` — A referência é o par BTC/USDT da Binance — outras corretoras ou pares de negociação são irrelevantes.
  - trecho: *"this market is about the price according to Binance BTC/USDT, not according to other exchanges or trading pairs"*
  - cenário: Se outras corretoras mostrarem o Bitcoin acima de US$ 76.000 ao meio-dia ET, mas a Binance mostrar igual ou abaixo, quem leu só o título espera SIM, mas a regra resolve NÃO.

**Ambiguidades (1):**

- `fuso_ausente` — trecho: *"12:00 in the ET timezone (noon)"*
  - **leitura A:** ET significa Eastern Standard Time (UTC-5), então 12:00 ET = 17:00 UTC.
  - **leitura B:** ET significa Eastern Daylight Time (UTC-4), então 12:00 ET = 16:00 UTC, correspondendo ao fim registrado pela plataforma.

<sub>deepseek-v4-flash · 4357+8508 tok · US$ 0.00300 · 65252 ms</sub>

---

### 2. Will the Chicago White Sox win the 2026 World Series?

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

- Se o Chicago White Sox não for o time vencedor da World Series de 2026 da MLB.
- Se em algum momento se tornar impossível para o Chicago White Sox vencer a World Series de 2026 conforme as regras da MLB (ex.: eliminação nos playoffs).

**Fonte:** Informações oficiais da MLB (https://www.mlb.com/); um consenso de reportagens confiáveis também pode ser usado.

**Prazo:** 31 de dezembro de 2026, ET (horário da costa leste dos EUA).

**Anula se:** —

**Pegadinhas (2):**

- `muda_timing` — O mercado pode resolver NÃO antes do fim da temporada, no momento da eliminação do White Sox nos playoffs — não espera a World Series terminar.
  - trecho: *"If at any point it becomes impossible for a listed team to win the 2026 MLB World Series per the rules of MLB (e.g., they are eliminated in the playoffs), the corresponding market will resolve to “No”."*
  - cenário: Se o Chicago White Sox for eliminado nos playoffs de 2026 antes da World Series, quem leu só o título espera que o mercado resolva somente após a World Series, mas a regra resolve NÃO já no momento da eliminação.
- `muda_resultado` — A regra prevê um terceiro desfecho 'Other' para cancelamento ou ausência de vencedor no prazo — não é NÃO automático.
  - trecho: *"If the 2026 MLB season is cancelled, postponed after December 31, 2026 ET, or there is otherwise no winner declared within that timeframe, this market will resolve to “Other”."*
  - cenário: Se a temporada de 2026 da MLB for cancelada, quem leu só o título espera NÃO (não houve World Series), mas a regra resolve 'Other'.

**Ambiguidades (1):**

- `precedencia_de_fonte` — trecho: *"The primary resolution source will be official information from MLB (https://www.mlb.com/); however, a consensus of credible reporting may also be used."*
  - **leitura A:** A MLB é a fonte primária; reportagens confiáveis só são usadas se a informação oficial estiver ausente.
  - **leitura B:** O consenso de reportagens confiáveis pode ser usado mesmo quando divirja da informação oficial, já que a regra diz 'may also be used'.

<sub>deepseek-v4-flash · 4330+4114 tok · US$ 0.00176 · 32051 ms</sub>

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

**Resolve SIM:**

- O atual regime da República Islâmica do Irã for derrubado, entrar em colapso ou deixar de governar até 30 de setembro de 2026, 23:59 ET, havendo um consenso amplo de reportagens indicando que as estruturas centrais da República Islâmica (por exemplo, o cargo de Líder Supremo, o Conselho dos Guardiões e o controle da IRGC sob autoridade clerical) foram dissolvidas, incapacitadas, substituídas por um sistema de governo fundamentalmente diferente, ou perderam o poder de facto sobre a maioria da população do Irã, de modo que a República Islâmica deixe de exercer poder soberano; a derrubada pode ocorrer por revolução, guerra civil, golpe militar ou abdicação voluntária, mas só qualifica se houver uma ruptura clara na continuidade do regime.

**Resolve NÃO:**

- Resolve NÃO se as condições do SIM não forem atendidas até 30 de setembro de 2026, 23:59 ET, inclusive quando a mudança for apenas um evento político rotineiro (eleições, reformas, sucessão de liderança), um golpe interno ou mudança de poder que preserve as estruturas centrais da República Islâmica, ou uma perda parcial de território ou desafio de grupos rebeldes/exilados sem que a República Islâmica deixe de administrar a maioria da população iraniana dentro do Irã.

**Fonte:** Consenso de reportagens confiáveis (consensus of credible reporting).

**Prazo:** September 30, 2026, 11:59 PM ET

**Anula se:** —

**Pegadinhas (5):**

- `muda_resultado` — Eleições, reformas ou sucessão de liderança não qualificam como queda do regime; o título esconde que é preciso dissolver as estruturas centrais.
  - trecho: *"Routine political events such as elections, reforms, or leadership succession do not qualify."*
  - cenário: Se um novo presidente for eleito ou o líder supremo for substituído sem que as estruturas da República Islâmica sejam dissolvidas, quem leu só o título espera SIM, mas a regra dá NÃO.
- `muda_resultado` — Um golpe militar não basta se as estruturas centrais da República Islâmica (como o Líder Supremo e a IRGC sob autoridade clerical) forem preservadas.
  - trecho: *"Internal coups or power shifts that preserve the Islamic Republic’s core structures also do not qualify."*
  - cenário: Se um general da IRGC tomar o poder nominal, mas o cargo de Líder Supremo e o Conselho dos Guardiões continuarem funcionando, quem leu só o título espera SIM, mas a regra dá NÃO.
- `muda_resultado` — Perda parcial de território ou desafios de rebeldes/exilados só qualificam se a República Islâmica deixar de administrar a maioria da população iraniana dentro do Irã.
  - trecho: *"Partial loss of territory or challenges from rebel or exile groups will not qualify unless the Islamic Republic no longer administers the majority of the Iranian population within Iran."*
  - cenário: Se grupos rebeldes controlarem uma região, mas o governo ainda administrar a maioria da população, quem leu só o título espera SIM, mas a regra dá NÃO.
- `muda_resultado` — A abdicação voluntária do líder só qualifica se a República Islâmica deixar de exercer poder soberano; abdicar sem desmontar o sistema não conta.
  - trecho: *"but only qualifies if the Islamic Republic no longer exercises sovereign power."*
  - cenário: Se o Líder Supremo abdicar, mas outro ocupar o cargo e as instituições seguirem intactas, quem leu só o título espera SIM, mas a regra dá NÃO.
- `muda_resultado` — A resolução exige consenso amplo de reportagens; uma queda real do regime sem cobertura convergente até o prazo não basta.
  - trecho: *"This requires a broad consensus of reporting indicating that core structures of the Islamic Republic (e.g. the office of the Supreme Leader, the Guardian Council, IRGC control under clerical authority) have been dissolved, incapacitated, or replaced by a fundamentally different governing system or otherwise lost de facto power over a majority of the population of Iran."*
  - cenário: Se o regime for derrubado de fato, mas a cobertura da imprensa ainda não tiver convergido até 30 de setembro, quem leu só o título espera SIM, mas a regra pode dar NÃO por falta do consenso exigido.

**Ambiguidades (3):**

- `fuso_ausente` — trecho: *"September 30, 2026, 11:59 PM ET"*
  - **leitura A:** O prazo é 30/09/2026 às 23:59 no horário padrão do Leste (EST, UTC-5).
  - **leitura B:** O prazo é 30/09/2026 às 23:59 no horário de verão do Leste (EDT, UTC-4).
- `fonte_vaga` — trecho: *"The resolution source will be a consensus of credible reporting."*
  - **leitura A:** O consenso é maioria simples entre reportagens confiáveis.
  - **leitura B:** O consenso exige concordância quase unânime entre as principais fontes.
- `criterio_discricionario` — trecho: *"replaced by a fundamentally different governing system"*
  - **leitura A:** Qualquer sistema que não seja a teocracia atual (ex.: uma república secular ou um governo militar não clerical) é fundamentalmente diferente e qualifica.
  - **leitura B:** Só uma mudança que desmonte as instituições clericais e estabeleça uma nova ordem constitucional explícita é fundamentalmente diferente.

<sub>deepseek-v4-flash · 4458+13681 tok · US$ 0.00446 · 106701 ms</sub>

---

### 4. Will Apple be the largest company in the world by market cap on August 31?

<sub>`will-apple-be-the-largest-company-in-the-world-by-market-cap-on-august-31-20260715202138601` · ia-e-tecnologia · hash `e57adb0f05f8` · 196 caracteres de regra</sub>

<details><summary>a regra, íntegra</summary>

```
This market will resolve to the largest company in the world by market cap on August 31, 2026, as of market close.

The resolution source for this market will be a consensus of credible reporting.
```

</details>

**Resolve SIM:**

- A Apple for a maior empresa do mundo em capitalização de mercado em 31 de agosto de 2026, no fechamento do mercado.

**Resolve NÃO:**

- Se a Apple não for a maior empresa do mundo em capitalização de mercado em 31 de agosto de 2026, no fechamento do mercado (a regra só descreve o SIM; o NÃO é o complemento).

**Fonte:** Consenso de reportagens confiáveis (a consensus of credible reporting)

**Prazo:** 31 de agosto de 2026, no fechamento do mercado; a regra não especifica fuso horário.

**Anula se:** —

**Pegadinhas (2):**

- `muda_resultado` — A liderança intradiária não conta; o que define a resolução é a posição no fechamento do mercado.
  - trecho: *"as of market close"*
  - cenário: Se a Apple for a maior durante o pregão de 31/08/2026 mas cair para segunda colocada no fechamento, quem leu só o título espera SIM, mas a regra dá NÃO.
- `muda_resultado` — A resolução segue o consenso de reportagens confiáveis, não necessariamente o dado objetivo de fechamento; se as reportagens apontarem outra empresa, a regra prevalece.
  - trecho: *"The resolution source for this market will be a consensus of credible reporting."*
  - cenário: Se os dados de fechamento mostrarem a Apple como a maior, mas o consenso das reportagens confiáveis indicar outra empresa, quem leu só o título espera SIM, mas a regra dá NÃO.

**Ambiguidades (2):**

- `fonte_vaga` — trecho: *"The resolution source for this market will be a consensus of credible reporting."*
  - **leitura A:** É preciso que múltiplas reportagens de veículos confiáveis concordem sobre qual é a maior empresa.
  - **leitura B:** Uma única reportagem de um veículo confiável pode bastar, se for a única a cobrir o assunto de forma confiável.
- `limiar_de_borda` — trecho: *"the largest company in the world by market cap"*
  - **leitura A:** Se houver empate exato no topo, não há uma única maior empresa; a Apple só resolve SIM se for estritamente a maior.
  - **leitura B:** Se a Apple estiver empatada com outra no topo, ela ainda é uma das maiores, então resolve SIM.

<sub>deepseek-v4-flash · 4254+6848 tok · US$ 0.00252 · 54583 ms</sub>

---

### 5. Will Angel Reese be the #1 searched person on Google this year?

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

- Angel Reese for #1 na lista oficial 'People' Global do Year in Search do Google para 2026.

**Resolve NÃO:**

- Se Angel Reese não for a pessoa #1 na lista especificada.
- Se o Google não publicar a lista até 31 de março de 2027, 23:59 ET, o mercado resolve para 'Other'.

**Fonte:** A lista especificada, conforme publicada pelo Google.

**Prazo:** March 31, 2027, 11:59 PM ET

**Anula se:** —

**Pegadinhas (3):**

- `muda_resultado` — O ranking é o da categoria 'People' com filtro Global, não o de buscas em geral nem o de um país específico.
  - trecho: *"This market will resolve according to the individual ranked #1 in Google’s official Year in Search Global "People" list for 2026."*
  - cenário: Se Angel Reese for a pessoa mais buscada em 2026 no ranking geral ou nos EUA, mas não estiver em 1º na lista Global 'People', quem leu só o título espera SIM, mas a regra dá NÃO.
- `muda_timing` — O mercado pode resolver assim que a lista for publicada, antes mesmo do fim do ano civil.
  - trecho: *"This market may resolve as soon as the specified list for 2026 is released."*
  - cenário: Se o Google publicar a lista em dezembro de 2026 antes do dia 31, quem esperava resolução apenas no fim do ano verá o mercado resolver antecipadamente.
- `muda_timing` — A data-limite para a lista é 31/03/2027, muito depois do fim registrado pela plataforma (31/12/2026).
  - trecho: *"If Google does not release the specified list by March 31, 2027, 11:59 PM ET, this market will resolve to “Other.”"*
  - cenário: Se a lista não sair até 31/12/2026, quem confia na data da plataforma espera resolução no fim de 2026, mas a regra mantém o mercado aberto até 31/03/2027.

**Ambiguidades (4):**

- `fuso_ausente` — trecho: *"March 31, 2027, 11:59 PM ET"*
  - **leitura A:** 11:59 PM Eastern Standard Time (EST, UTC-5).
  - **leitura B:** 11:59 PM Eastern Daylight Time (EDT, UTC-4).
- `criterio_discricionario` — trecho: *"This market may resolve as soon as the specified list for 2026 is released."*
  - **leitura A:** O mercado será resolvido imediatamente após a publicação da lista.
  - **leitura B:** O mercado tem permissão para resolver nesse momento, mas pode esperar por decisão do operador.
- `escopo_de_entidade` — trecho: *"This market will resolve according to the individual ranked #1 in Google’s official Year in Search Global "People" list for 2026."*
  - **leitura A:** Se houver empate no topo da lista e Angel Reese estiver entre os #1, resolve SIM.
  - **leitura B:** Se houver empate no topo, resolve SIM apenas se Angel Reese for a única #1.
- `formato_do_mercado` — trecho: *"this market will resolve to “Other.”"*
  - **leitura A:** O mercado tem três resultados possíveis: SIM (Angel Reese #1), NÃO (outra pessoa #1) e OUTRO (lista não publicada).
  - **leitura B:** O mercado é binário; 'Other' é apenas um rótulo para NÃO, já que Angel Reese não fica #1 sem lista.

<sub>deepseek-v4-flash · 3369+14423 tok · US$ 0.00453 · 107694 ms</sub>

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

- Se qualquer candle de 1 minuto do par BTC/USDT da Binance, no período entre 24/11/2025 14:00 e 31/12/2026 23:59 (ET), tiver preço 'High' final igual ou maior que US$ 150.000.

**Resolve NÃO:**

- O mercado resolve NÃO se nenhum candle de 1 minuto do par BTC/USDT da Binance na janela especificada tiver High final igual ou maior que US$ 150.000. A regra define apenas o SIM; o NÃO é o complemento desse critério.

**Fonte:** Binance, especificamente o preço 'High' do par BTC/USDT, com gráfico de 1 minuto (1m), conforme https://www.binance.com/en/trade/BTC_USDT.

**Prazo:** December 31, 2026, 23:59 in the ET timezone

**Anula se:** —

**Pegadinhas (4):**

- `muda_resultado` — A janela de contagem começa em 24/11/2025, não no início do mercado ou em qualquer data anterior; um atingimento antes desse início não conta.
  - trecho: *"between November 24, 2025, 14:00 and December 31, 2026, 23:59 in the ET timezone"*
  - cenário: Se o Bitcoin atingir US$ 150.000 antes de 24 de novembro de 2025, quem leu só o título espera SIM, mas a regra resolve NÃO, pois nenhum candle dentro da janela teria High nesse valor.
- `muda_resultado` — Só o par BTC/USDT da Binance importa; preços de outras corretoras, outros pares ou mercado à vista são ignorados.
  - trecho: *"Prices from other exchanges, different trading pairs, or spot markets will not be considered for the resolution of this market."*
  - cenário: Se o Bitcoin atingir US$ 150.000 apenas na Coinbase ou em outro par que não o BTC/USDT da Binance, quem leu só o título espera SIM, mas a regra resolve NÃO.
- `muda_resultado` — Basta o High de um candle de 1 minuto; não é necessário que o preço feche acima de US$ 150.000.
  - trecho: *"has a final "High" price equal to or greater than the price specified in the title."*
  - cenário: Se o Bitcoin tocar US$ 150.000 em um único candle de 1 minuto e depois cair, quem leu só o título pode esperar NÃO se achar que é preciso fechar acima, mas a regra resolve SIM pelo High final do candle.
- `muda_resultado` — O preço de referência é o do par BTC/USDT (em USDT), não necessariamente o preço em dólar americano (USD).
  - trecho: *"any Binance 1 minute candle for Bitcoin (BTC/USDT)"*
  - cenário: Se o Bitcoin valer US$ 150.000 em dólares, mas o par BTC/USDT da Binance não atingir esse valor (por exemplo, se o USDT desvalorizar), quem leu só o título espera SIM, mas a regra resolve NÃO.

**Ambiguidades (1):**

- `janela_inclusiva` — trecho: *"between November 24, 2025, 14:00 and December 31, 2026, 23:59 in the ET timezone"*
  - **leitura A:** Os extremos estão incluídos: contam os candles com início às 14:00 de 24/11/2025 e às 23:59 de 31/12/2026.
  - **leitura B:** 'Between' é exclusivo: só contam candles estritamente depois das 14:00 de 24/11/2025 e estritamente antes das 23:59 de 31/12/2026; a vela das 23:59 ficaria de fora.

<sub>deepseek-v4-flash · 296+12080 tok · US$ 0.00349 · 98980 ms</sub>

---

### 7. Will Microsoft be the largest company in the world by market cap on September 30?

<sub>`will-company-b-be-the-largest-company-in-the-world-by-market-cap-on-september-30` · ia-e-tecnologia · hash `7af37b690c8a` · 199 caracteres de regra</sub>

<details><summary>a regra, íntegra</summary>

```
This market will resolve to the largest company in the world by market cap on September 30, 2026, as of market close.

The resolution source for this market will be a consensus of credible reporting.
```

</details>

**Resolve SIM:**

- Se, em 30 de setembro de 2026, no fechamento do mercado, a Microsoft for a empresa com a maior capitalização de mercado do mundo.

**Resolve NÃO:**

- A regra define que o mercado resolve para a maior empresa do mundo; se essa empresa não for a Microsoft, o mercado resolve NÃO.

**Fonte:** consensus of credible reporting

**Prazo:** 30 de setembro de 2026, as of market close (fuso não especificado)

**Anula se:** —

**Pegadinhas (1):**

- `muda_resultado` — O desfecho não é determinado por dados oficiais de mercado, mas por um consenso de reportagens confiáveis; se os números oficiais e as reportagens divergirem, o mercado segue o consenso.
  - trecho: *"The resolution source for this market will be a consensus of credible reporting."*
  - cenário: Se no dia 30/09/2026 a Microsoft for a maior empresa segundo os dados oficiais da bolsa, mas as reportagens confiáveis apontarem outra empresa como a maior, quem leu apenas o título espera SIM, mas a regra resolve NÃO, pois a fonte é o consenso das reportagens.

**Ambiguidades (3):**

- `fonte_vaga` — trecho: *"a consensus of credible reporting"*
  - **leitura A:** O consenso é formado quando múltiplos veículos de imprensa confiáveis apontam o mesmo resultado; não há número mínimo definido.
  - **leitura B:** Não há critério para o que conta como 'consenso' nem como 'credible', de modo que qualquer conjunto de reportagens pode ser invocado para justificar uma resolução.
- `momento_ambiguo` — trecho: *"as of market close"*
  - **leitura A:** Refere-se ao fechamento do pregão da bolsa onde a Microsoft está listada (por exemplo, NASDAQ), tipicamente às 16h no fuso do leste dos EUA.
  - **leitura B:** Refere-se ao fechamento de qualquer mercado de valores global, sem especificar qual bolsa ou horário, podendo variar conforme a fonte.
- `formato_do_mercado` — trecho: *"This market will resolve to the largest company in the world by market cap"*
  - **leitura A:** O mercado resolve SIM se a Microsoft for essa maior empresa; caso contrário, NÃO — a pergunta binária é a lente pela qual a afirmação é lida.
  - **leitura B:** A regra define apenas que o mercado resolve para a maior empresa (um resultado categórico), sem conectar isso a sim/não; o formato binário da pergunta não é contemplado na regra.

<sub>deepseek-v4-flash · 151+9984 tok · US$ 0.00288 · 85522 ms</sub>

---

### 8. Will Washington Commanders win the 2027 NFL NFC Championship?

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

- O Washington Commanders vencer o jogo do Campeonato da NFC de 2027.

**Resolve NÃO:**

- Se a qualquer momento for impossível para o Washington Commanders vencer o Campeonato da NFC de 2027, segundo as regras da NFL (por exemplo, eliminação nos playoffs), o mercado resolve NÃO.
- Se o Washington Commanders não vencer o jogo do Campeonato da NFC (qualquer outro time vencer), o mercado resolve NÃO (complemento do SIM).

**Fonte:** Informações oficiais da NFL (https://www.nfl.com/); consenso de reportagens confiáveis pode ser usado.

**Prazo:** March 31, 2027 ET

**Anula se:**

- Se o jogo do Campeonato da NFC de 2027 for cancelado, adiado para depois de 31 de março de 2027 ET, ou se nenhum vencedor for declarado dentro desse prazo, o mercado resolve para 'Other' (não é SIM nem NÃO).

**Pegadinhas (3):**

- `muda_resultado` — Se o jogo do campeonato for cancelado, o mercado não resolve NÃO — resolve para 'Other' (tratado como N/A em um mercado binário).
  - trecho: *"If the 2027 NFL NFC championship game is cancelled, postponed after March 31, 2027 ET, or there is otherwise no winner declared within that timeframe, this market will resolve to “Other”."*
  - cenário: Se o jogo do Campeonato da NFC for cancelado, quem leu só o título espera NÃO, mas a regra resolve para 'Other'.
- `muda_timing` — O mercado pode resolver NÃO antes do jogo do campeonato, já na eliminação do time nos playoffs.
  - trecho: *"If at any point it becomes impossible for a listed team to win the 2027 NFL NFC championship per the rules of the NFL (e.g., they are eliminated in the playoffs), the corresponding market will resolve to “No”."*
  - cenário: Se o Washington Commanders for eliminado nos playoffs antes do jogo final, quem leu só o título espera esperar o jogo do campeonato, mas a regra resolve NÃO no momento da eliminação.
- `muda_timing` — O mercado pode resolver depois da data de término registrada na plataforma, pois a regra permite que o jogo aconteça (ou o vencedor seja declarado) até 31 de março de 2027 ET.
  - trecho: *"postponed after March 31, 2027 ET"*
  - cenário: Se o jogo for adiado para uma data após 25 de janeiro de 2027 (data de término da plataforma), mas antes de 31 de março de 2027, quem leu só o título espera que o mercado resolva em 25 de janeiro, mas a regra permite que a resolução ocorra só depois do jogo.

**Ambiguidades (3):**

- `precedencia_de_fonte` — trecho: *"The primary resolution source will be official information from NFL (https://www.nfl.com/); however, a consensus of credible reporting may also be used."*
  - **leitura A:** A fonte primária é a informação oficial da NFL; o consenso de reportagens só é usado quando não há informação oficial disponível.
  - **leitura B:** O consenso de reportagens confiáveis pode ser usado mesmo quando há informação oficial, e pode divergir dela; a regra não diz qual prevalece em conflito.
- `fonte_vaga` — trecho: *"a consensus of credible reporting"*
  - **leitura A:** O consenso exige concordância de múltiplas reportagens confiáveis; o número mínimo de reportagens e o critério de confiabilidade não são definidos.
  - **leitura B:** Qualquer reportagem confiável, ou um pequeno número, pode caracterizar o consenso; não há régua para medir 'credible'.
- `data_ambigua` — trecho: *"the 2027 NFC championship game"*
  - **leitura A:** O jogo do Campeonato da NFC da temporada de 2027 da NFL, disputado em janeiro de 2028.
  - **leitura B:** O jogo do Campeonato da NFC disputado no ano civil de 2027, correspondente à temporada de 2026.

<sub>deepseek-v4-flash · 242+15065 tok · US$ 0.00432 · 108339 ms</sub>

---

### 9. China x Japan military clash before 2027?

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

- Houver um encontro militar entre as forças militares da China (República Popular da China) e do Japão entre 17 de novembro de 2025 e 31 de dezembro de 2026, 23h59 ET, definido como qualquer incidente envolvendo uso de força, como ataques de mísseis, fogo de artilharia, troca de tiros ou outras formas de engajamento militar direto entre as forças militares chinesas e japonesas.
- Dentro desse período, o abalroamento intencional de um navio militar por outro que resulte em dano significativo (por exemplo, um buraco no casco) ou no afundamento do navio contará para resolução 'Sim'.

**Resolve NÃO:**

- Não houver um encontro militar qualificado entre as forças militares da China e do Japão dentro do período, ou seja, nada que se enquadre na definição acima.
- Ações não violentas, como tiros de advertência, fogo de artilharia em áreas desabitadas, ou lançamentos de mísseis que caiam em águas territoriais ou atravessem espaço aéreo, não contam para 'Sim' e, portanto, resolvem 'Não'.
- Abalroamento intencional que cause apenas dano menor (arranhões, amassados) não conta para 'Sim' e, portanto, resolve 'Não'.
- Encontros envolvendo a Guarda Costeira do Japão (JCG) não contam, pois a JCG não é força militar; portanto, um incidente apenas com a JCG resolve 'Não'.

**Fonte:** consensus of credible reporting

**Prazo:** December 31, 2026, 11:59 PM ET

**Anula se:** —

**Pegadinhas (4):**

- `muda_resultado` — Tiros de advertência, fogo de artilharia em áreas desabitadas e lançamentos de mísseis que caiam em águas territoriais ou passem por espaço aéreo são explicitamente excluídos: um incidente apenas com essas ações não resolve 'Sim'.
  - trecho: *"Non-violent actions, such as warning shots, artillery fire into uninhabited areas, or missile launches that land in territorial waters or pass through airspace, will not qualify for a "Yes" resolution."*
  - cenário: Se houver apenas tiros de advertência ou lançamento de míssil que caia em águas territoriais, quem leu só o título espera 'Sim', mas a regra dá 'Não'.
- `muda_resultado` — A Guarda Costeira Chinesa (CCG) conta como força militar, mas a Guarda Costeira Japonesa (JCG) não: um confronto envolvendo a JCG não é um encontro militar, enquanto um envolvendo a CCG é.
  - trecho: *"the China Coast Guard (CCG) is part of the military, however Japan Coast Guard (JCG) is not."*
  - cenário: Se a Marinha chinesa e a Guarda Costeira japonesa se enfrentarem, quem leu só o título pode considerar um conflito militar, mas a regra exclui a JCG, então resolve 'Não'.
- `muda_resultado` — O abalroamento intencional só conta se causar dano significativo (ex.: buraco no casco) ou afundamento; danos menores como arranhões e amassados não contam.
  - trecho: *"Intentional ship ramming that results in significant damage to (e.g., a hole in the hull) or the sinking of a military ship by another will count toward a "Yes" resolution, however minor damage (scrapes, dents) will not."*
  - cenário: Se houver um abalroamento intencional entre navios militares que cause apenas arranhões ou amassados, quem leu só o título espera 'Sim', mas a regra dá 'Não'.
- `muda_resultado` — A janela de tempo começa em 17 de novembro de 2025, não na criação do mercado nem em 1º de janeiro de 2025: um encontro antes dessa data não conta.
  - trecho: *"between November 17, 2025, and December 31, 2026, 11:59 PM ET"*
  - cenário: Se houver um encontro militar em outubro de 2025, antes do início da janela, quem leu o título 'before 2027' espera 'Sim', mas a regra dá 'Não'.

**Ambiguidades (3):**

- `fonte_vaga` — trecho: *"a consensus of credible reporting"*
  - **leitura A:** Exige a concordância de múltiplas reportagens independentes de veículos considerados confiáveis.
  - **leitura B:** Pode ser interpretado como qualquer conjunto de reportagens que o resolvedor considere confiável, mesmo sem consenso amplo ou com poucas fontes.
- `fuso_ausente` — trecho: *"11:59 PM ET"*
  - **leitura A:** ET refere-se ao horário local no fuso Eastern Time, que em 31 de dezembro seria EST (UTC-5).
  - **leitura B:** ET é uma abreviatura sem especificação de horário de verão, podendo ser EDT (UTC-4), deslocando o limite em uma hora.
- `criterio_discricionario` — trecho: *"significant damage to (e.g., a hole in the hull)"*
  - **leitura A:** Dano significativo é apenas aquele que cria um buraco no casco ou afunda o navio, conforme os exemplos.
  - **leitura B:** Dano significativo é qualquer dano substancial que comprometa a operação do navio, mesmo que não seja exatamente um buraco ou afundamento.

<sub>deepseek-v4-flash · 338+11004 tok · US$ 0.00319 · 81442 ms</sub>

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

- O Partido Liberal (PL) for a entidade com o maior número de cadeiras na Câmara dos Deputados resultante da eleição de 2026, considerando o desempate alfabético previsto na regra, se houver empate.

**Resolve NÃO:**

- Qualquer outra entidade (partido político ou federação partidária) tiver o maior número de cadeiras na Câmara dos Deputados resultante da eleição de 2026, após a aplicação do critério de desempate, se aplicável.
- O resultado da eleição não for definitivamente conhecido até 30/06/2027 23:59 ET, caso em que o mercado resolve 'Other' (não resolve SIM).

**Fonte:** Consenso de reportagens credíveis; em caso de ambiguidade, os resultados oficiais do Tribunal Superior Eleitoral (TSE) ou da Câmara dos Deputados.

**Prazo:** June 30, 2027, 11:59 PM ET

**Anula se:** —

**Pegadinhas (2):**

- `muda_resultado` — A regra exclui coligações: os assentos de uma coligação da qual o PL faça parte não são contabilizados como do PL. Se a coligação tiver o maior número de cadeiras, mas o PL individualmente não, o mercado resolve NÃO.
  - trecho: *"This market's resolution will be based solely on the number of seats held by the named party or electoral federation in the Brazilian Chamber of Deputies as a result of the next Brazilian Chamber of Deputies election, not by any coalition it may be a part of."*
  - cenário: Se o PL fizer parte de uma coligação que, no total, eleja o maior número de deputados, mas o PL sozinho não for o partido com mais cadeiras, quem leu apenas o título esperaria SIM (pois a coligação do PL venceu), mas a regra dá NÃO.
- `muda_resultado` — Em caso de empate no número de cadeiras, o desempate é feito por ordem alfabética das siglas. O PL pode vencer mesmo empatado, se 'PL' for a primeira sigla em ordem alfabética, ou perder se a outra sigla vier antes.
  - trecho: *"In the event of a tie between multiple entities for the most seats held, this market will resolve in favor of the entity whose listed abbreviation appears first in alphabetical order."*
  - cenário: Se o PL e outro partido (por exemplo, 'PCdoB') empatarem em número de cadeiras, a sigla 'PCdoB' vem antes de 'PL' em ordem alfabética, então o PL perde; se o empate for com um partido de sigla posterior (por exemplo, 'PSDB'), o PL vence.

**Ambiguidades (2):**

- `fuso_ausente` — trecho: *"June 30, 2027, 11:59 PM ET"*
  - **leitura A:** ET significa Eastern Standard Time (UTC-5).
  - **leitura B:** ET significa Eastern Daylight Time (UTC-4).
- `fonte_vaga` — trecho: *"This market will resolve based on the result of the election, as indicated by a consensus of credible reporting."*
  - **leitura A:** Consenso significa concordância entre a maioria dos grandes veículos de imprensa do país.
  - **leitura B:** Consenso significa qualquer concordância entre reportagens consideradas críveis, sem critério objetivo definido.

<sub>deepseek-v4-flash · 419+14835 tok · US$ 0.00428 · 117154 ms</sub>

