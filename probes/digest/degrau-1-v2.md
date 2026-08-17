# Digestão de regras — degrau 1, prompt `v2`

10 mercados, um modelo só — a leitura antes de qualquer escala

- **mercados:** 10
- **modelos:** `deepseek-v4-flash`
- **prompt:** `v2`
- **chamadas:** 10
- **amostra:** aleatória, semente fixa `20260815` (reprodutível: mesma semente, mesma lista)
- **custo estimado antes de rodar:** US$ 0.0163
- **custo real:** US$ 0.0204 (+25.8% sobre o estimado)

## Medidas

| modelo | chamadas | inválidas | taxa | custo total | por mercado | latência mediana | pegadinhas (mediana) | ambiguidades (mediana) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `deepseek-v4-flash` | 10 | 0 | 0.0% | US$ 0.0204 | US$ 0.00204 | 59658 ms | 3.0 | 2.0 |


**Pegadinhas:** 28 em 10 digestões válidas — 0 mercado(s) vieram com ZERO, que é resposta desejada quando a regra é direta.

| severidade | n | % |
| --- | ---: | ---: |
| `muda_resultado` | 21 | 75.0% |
| `muda_timing` | 5 | 17.9% |
| `detalhe` | 2 | 7.1% |

**Ambiguidades:** 24 — taxa de `outro`: **8.3%** (abaixo de 20%: a lista fechada dá conta)

| tipo | n | % |
| --- | ---: | ---: |
| `fonte_vaga` | 7 | 29.2% |
| `fuso_ausente` | 8 | 33.3% |
| `data_ambigua` | 1 | 4.2% |
| `janela_inclusiva` | 2 | 8.3% |
| `escopo_de_entidade` | 1 | 4.2% |
| `limiar_de_borda` | 1 | 4.2% |
| `formato_do_mercado` | 2 | 8.3% |
| `outro` | 2 | 8.3% |

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

- O candle de 1 minuto da Binance para BTC/USDT às 12:00 ET (meio-dia) de 15 de agosto de 2026 tem preço de fechamento ('Close') final maior que US$ 76.000.

**Resolve NÃO:**

- Qualquer outro caso, incluindo fechamento do candle igual ou inferior a US$ 76.000.

**Fonte:** Binance, especificamente os preços de fechamento BTC/USDT atualmente disponíveis em https://www.binance.com/en/trade/BTC_USDT com '1m' e 'Candles' selecionados.

**Prazo:** 12:00 ET (meio-dia) de 15 de agosto de 2026

**Anula se:** —

**Pegadinhas (3):**

- `muda_resultado` — A regra usa o preço do par BTC/USDT na Binance, não o preço do Bitcoin em outras corretoras ou outros pares.
- `muda_resultado` — A resolução usa o fechamento do candle de 1 minuto às 12:00 ET (meio-dia), não o preço em qualquer outro momento do dia.
- `muda_resultado` — O preço precisa ser estritamente maior que US$ 76.000; um fechamento exatamente em US$ 76.000 resolve NÃO.

**Ambiguidades (1):**

- `fuso_ausente` — trecho: *"12:00 in the ET timezone (noon)"*
  - **leitura A:** ET significa Eastern Daylight Time (EDT), UTC-4, então 12:00 ET corresponde a 16:00 UTC.
  - **leitura B:** ET significa Eastern Standard Time (EST), UTC-5, então 12:00 ET corresponde a 17:00 UTC.

<sub>deepseek-v4-flash · 110+3994 tok · US$ 0.00117 · 32134 ms</sub>

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

- O Chicago White Sox vence a World Series de 2026 da MLB.

**Resolve NÃO:**

- O Chicago White Sox é eliminado da disputa pela World Series de 2026, tornando-se matematicamente impossível vencer, de acordo com as regras da MLB.

**Fonte:** MLB (https://www.mlb.com/), com consenso de reportagens confiáveis como fonte secundária.

**Prazo:** 31 de dezembro de 2026 ET

**Anula se:**

- Se a temporada de 2026 da MLB for cancelada, adiada para depois de 31 de dezembro de 2026 ET, ou se nenhum vencedor for declarado até esse prazo, o mercado resolve para 'Other' (em vez de SIM ou NÃO).

**Pegadinhas (2):**

- `muda_timing` — O mercado pode resolver NÃO antes do fim da World Series: basta o White Sox ser matematicamente eliminado (ex.: eliminado nos playoffs), mesmo que isso ocorra antes da final.
- `muda_resultado` — Há um terceiro desfecho 'Other' para cancelamento/adiamento além de 31/12/2026 — não é simplesmente NÃO.

**Ambiguidades (3):**

- `fonte_vaga` — trecho: *"The primary resolution source will be official information from MLB (https://www.mlb.com/); however, a consensus of credible reporting may also be used."*
  - **leitura A:** A MLB é a fonte primária e o consenso de reportagens é apenas um complemento quando a informação oficial não estiver disponível.
  - **leitura B:** O consenso de reportagens confiáveis pode ser usado como fonte alternativa ou até sobrepor a informação oficial, dependendo da interpretação de 'may also be used'.
- `fuso_ausente` — trecho: *"December 31, 2026 ET"*
  - **leitura A:** 'ET' significa Eastern Standard Time (UTC-5), pois em dezembro vigora o horário padrão.
  - **leitura B:** 'ET' é uma abreviação ambígua: pode ser Eastern Daylight Time (UTC-4) ou Eastern Standard Time, sem definir qual.
- `formato_do_mercado` — trecho: *"this market will resolve to 'Other'"*
  - **leitura A:** O mercado aceita um terceiro resultado 'Other', além de SIM e NÃO, para cancelamento/adiamento.
  - **leitura B:** A pergunta é binária (sim/não) e 'Other' deve ser tratado como anulação/void, pois não há espaço para um terceiro resultado na plataforma.

<sub>deepseek-v4-flash · 83+7013 tok · US$ 0.00201 · 59682 ms</sub>

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

- A República Islâmica do Irã é derrubada, entra em colapso ou deixa de governar até 30 de setembro de 2026, 11:59 PM ET, com consenso amplo de reportagens confiáveis indicando que as estruturas centrais (líder supremo, Conselho Guardião, controle da IRGC sob autoridade clerical) foram dissolvidas, incapacitadas ou substituídas por um sistema de governo fundamentalmente diferente, e que o regime perdeu o poder de facto sobre a maioria da população do Irã, deixando de exercer poder soberano.

**Resolve NÃO:**

- O regime da República Islâmica do Irã não é derrubado, não entra em colapso ou continua a governar até 30 de setembro de 2026, 11:59 PM ET.
- Eventos políticos rotineiros, como eleições, reformas ou sucessão de liderança, não qualificam para SIM.
- Golpes internos ou mudanças de poder que preservam as estruturas centrais da República Islâmica não qualificam.
- Perda parcial de território ou desafios de grupos rebeldes ou exilados não qualificam, a menos que a República Islâmica deixe de administrar a maioria da população iraniana dentro do Irã.

**Fonte:** Consenso de reportagens confiáveis

**Prazo:** September 30, 2026, 11:59 PM ET

**Anula se:** —

**Pegadinhas (5):**

- `muda_resultado` — Eleições, reformas ou sucessão de liderança rotineiras não contam como queda do regime; o título 'fall' pode sugerir o contrário.
- `muda_resultado` — Golpes internos que preservam as estruturas centrais (ex.: novo líder, mas mesmo sistema) não qualificam como SIM.
- `muda_resultado` — Perda parcial de território ou desafios de rebeldes/exilados não bastam; é preciso que o regime perca o controle sobre a MAIORIA da população.
- `muda_resultado` — A resolução depende de um consenso amplo de reportagens; um relato isolado ou disputado pode não levar ao SIM.
- `muda_timing` — O prazo efetivo é 11:59 PM ET, não a meia-noite UTC da data final da plataforma; eventos no dia 30 de setembro até esse horário (ET) contam.

**Ambiguidades (2):**

- `fonte_vaga` — trecho: *"The resolution source will be a consensus of credible reporting."*
  - **leitura A:** Exige que a grande maioria das fontes de mídia confiáveis relate o fato para haver consenso.
  - **leitura B:** Basta que não haja discordância significativa entre as principais fontes, mesmo sem unanimidade.
- `escopo_de_entidade` — trecho: *"core structures of the Islamic Republic (e.g. the office of the Supreme Leader, the Guardian Council, IRGC control under clerical authority)"*
  - **leitura A:** Apenas as estruturas listadas são consideradas centrais.
  - **leitura B:** Outras estruturas também podem ser consideradas centrais, já que a lista é exemplificativa ('e.g.').

<sub>deepseek-v4-flash · 83+9396 tok · US$ 0.00268 · 82015 ms</sub>

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

- Apple é a maior empresa do mundo por capitalização de mercado em 31 de agosto de 2026, no fechamento do mercado.

**Resolve NÃO:**

- A regra não descreve explicitamente o NÃO; resolve NÃO quando Apple não for a maior empresa do mundo por capitalização de mercado em 31 de agosto de 2026, no fechamento do mercado.

**Fonte:** Consensus of credible reporting

**Prazo:** 31 de agosto de 2026, ao fechamento do mercado

**Anula se:** —

**Pegadinhas (1):**

- `muda_resultado` — A capitalização é medida no fechamento do mercado em 31 de agosto de 2026 — valores durante o pregão não contam.

**Ambiguidades (3):**

- `outro` — trecho: *"as of market close"*
  - **leitura A:** O fechamento do mercado de ações dos EUA (NYSE/Nasdaq) em 31 de agosto de 2026.
  - **leitura B:** O fechamento de um mercado global relevante, como o de Tóquio ou Londres, que ocorre em horário diferente.
- `fuso_ausente` — trecho: *"August 31, 2026, as of market close"*
  - **leitura A:** O fechamento às 16h no horário de Nova York (ET), comumente usado para ações dos EUA.
  - **leitura B:** O fechamento no horário de outro fuso, sem definição clara, podendo ser interpretado como 23h59 UTC.
- `fonte_vaga` — trecho: *"The resolution source for this market will be a consensus of credible reporting."*
  - **leitura A:** A resolução será baseada em um consenso de reportagens de veículos de imprensa amplamente reconhecidos como confiáveis.
  - **leitura B:** A resolução será baseada em qualquer reportagem que o resolvedor julgue credível, sem critérios objetivos pré-definidos.

<sub>deepseek-v4-flash · 7+5044 tok · US$ 0.00145 · 42114 ms</sub>

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

- Angel Reese for o indivíduo classificado em 1º lugar na lista oficial 'People' do Google Year in Search Global de 2026.

**Resolve NÃO:**

- Se outro indivíduo for o 1º lugar na lista (Angel Reese não for o 1º), o mercado resolve NÃO.
- Se o Google não publicar a lista especificada até 31 de março de 2027, 23:59 ET, o mercado resolve para 'Other'.

**Fonte:** Google — lista oficial 'People' do Year in Search Global 2026

**Prazo:** 31 de março de 2027, 23:59 ET

**Anula se:** —

**Pegadinhas (3):**

- `muda_resultado` — O mercado não trata de buscas em geral, mas da lista específica 'People' do Year in Search Global: Angel Reese pode ser a pessoa mais pesquisada no Google e ainda assim não ser a #1 nessa lista.
- `muda_timing` — O mercado pode resolver antes de 31/12/2026: assim que o Google divulgar a lista de 2026, o mercado resolve.
- `muda_resultado` — Se o Google não divulgar a lista até 31/03/2027, o mercado resolve para 'Other' — o que não é um SIM. Muitos podem assumir que a lista sai obrigatoriamente; a regra prevê o caso de não sair.

**Ambiguidades (2):**

- `fuso_ausente` — trecho: *"March 31, 2027, 11:59 PM ET"*
  - **leitura A:** 23:59 Eastern Daylight Time (EDT)
  - **leitura B:** 23:59 Eastern Standard Time (EST)
- `formato_do_mercado` — trecho: *"this market will resolve to “Other.”"*
  - **leitura A:** O resultado 'Other' é equivalente a NÃO, já que o mercado é binário (sim/não).
  - **leitura B:** O resultado 'Other' é um terceiro resultado distinto de SIM e NÃO, e o mercado não é estritamente binário.

<sub>deepseek-v4-flash · 18+6869 tok · US$ 0.00197 · 59634 ms</sub>

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

- Se qualquer vela de 1 minuto do par BTC/USDT na Binance, entre 24/11/2025 14:00 e 31/12/2026 23:59 no fuso ET, tiver preço 'High' final igual ou maior que US$ 150.000, o mercado resolve 'Sim'.

**Resolve NÃO:**

- Se nenhuma vela de 1 minuto do par BTC/USDT na Binance no período especificado tiver preço 'High' final igual ou maior que US$ 150.000, o mercado resolve 'Não'.

**Fonte:** Binance (par BTC/USDT, preço 'High' em velas de 1 minuto, conforme https://www.binance.com/en/trade/BTC_USDT)

**Prazo:** 31 de dezembro de 2026, 23:59 ET

**Anula se:** —

**Pegadinhas (3):**

- `muda_resultado` — A condição é o preço 'High' de qualquer vela de 1 minuto da Binance BTC/USDT — não o preço de fechamento, não o preço de outras corretoras e não o preço em outros pares. Basta um pico momentâneo.
- `muda_resultado` — A janela de análise começa em 24/11/2025, 14:00 ET. Se o Bitcoin já tiver atingido US$ 150.000 antes desse instante, isso não conta para o mercado.
- `muda_timing` — O mercado resolve 'Sim' imediatamente quando qualquer vela atinge o preço — não é preciso esperar o fim do prazo em 31/12/2026.

**Ambiguidades (2):**

- `fuso_ausente` — trecho: *"in the ET timezone"*
  - **leitura A:** ET refere-se à hora oficial da costa leste dos EUA, alternando entre EST (UTC-5) no inverno e EDT (UTC-4) no verão.
  - **leitura B:** ET é tratado como um fuso fixo, sempre EST (UTC-5), sem aplicar horário de verão.
- `janela_inclusiva` — trecho: *"between November 24, 2025, 14:00 and December 31, 2026, 23:59"*
  - **leitura A:** O intervalo inclui as velas de 1 minuto que começam exatamente às 14:00 do dia 24/11/2025 e às 23:59 do dia 31/12/2026; ambos os extremos são inclusos.
  - **leitura B:** O intervalo exclui as velas que começam exatamente nos extremos; valem apenas velas com início depois das 14:00 e antes das 23:59.

<sub>deepseek-v4-flash · 17+5929 tok · US$ 0.00170 · 50208 ms</sub>

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

- Microsoft for a maior empresa do mundo por capitalização de mercado em 30 de setembro de 2026, no fechamento do mercado.

**Resolve NÃO:**

- Microsoft não for a maior empresa do mundo por capitalização de mercado em 30 de setembro de 2026, no fechamento do mercado.

**Fonte:** Consenso de reportagens confiáveis

**Prazo:** 30 de setembro de 2026, no fechamento do mercado

**Anula se:** —

**Pegadinhas (2):**

- `muda_resultado` — O valor considerado é o do fechamento do mercado; oscilações durante o dia não contam.
- `detalhe` — A resolução depende de um consenso de reportagens confiáveis, não de uma fonte única oficial.

**Ambiguidades (2):**

- `fonte_vaga` — trecho: *"The resolution source for this market will be a consensus of credible reporting."*
  - **leitura A:** Basta que uma reportagem confiável indique a maior empresa; consenso é interpretado como falta de controvérsia significativa.
  - **leitura B:** É necessário que múltiplas fontes independentes concordem explicitamente sobre qual é a maior empresa, e a ausência de consenso impede a resolução (ou adia).
- `outro` — trecho: *"as of market close"*
  - **leitura A:** Refere-se ao fechamento da bolsa onde a Microsoft tem listagem principal (ex.: NASDAQ, 16h00 no fuso do leste dos EUA).
  - **leitura B:** Refere-se ao último fechamento de qualquer mercado relevante no dia 30/09/2026, ou a um horário padrão como 23:59 UTC.

<sub>deepseek-v4-flash · 128+3672 tok · US$ 0.00108 · 30494 ms</sub>

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

- O Washington Commanders vence o NFC Championship de 2027.

**Resolve NÃO:**

- Se o Washington Commanders não vencer o NFC Championship de 2027, o mercado resolve NÃO. A regra menciona explicitamente que isso inclui o cenário em que se torna impossível vencer conforme as regras da NFL (ex.: eliminado nos playoffs).

**Fonte:** NFL (https://www.nfl.com/) como fonte primária; consenso de relatos credíveis pode ser usado como fonte secundária.

**Prazo:** 31 de março de 2027 ET

**Anula se:**

- Se o jogo do NFC Championship de 2027 for cancelado, adiado para depois de 31 de março de 2027 ET, ou não houver vencedor declarado dentro desse prazo, o mercado resolve 'Other' (não resolve SIM nem NÃO).

**Pegadinhas (2):**

- `muda_timing` — O mercado pode resolver NÃO antecipadamente: assim que o Washington Commanders se tornar matematicamente impossibilitado de vencer o NFC Championship (por exemplo, eliminado nos playoffs), o NÃO é acionado naquele momento, não no fim do jogo.
- `detalhe` — A regra prevê uma resolução 'Other' (nem SIM nem NÃO) se o jogo for cancelado, adiado para depois de 31/03/2027 ET ou sem vencedor declarado nesse prazo — e não uma simples devolução ou anulação.

**Ambiguidades (3):**

- `fuso_ausente` — trecho: *"March 31, 2027 ET"*
  - **leitura A:** ET se refere a Eastern Standard Time (EST, UTC-5).
  - **leitura B:** ET se refere a Eastern Daylight Time (EDT, UTC-4).
- `data_ambigua` — trecho: *"postponed after March 31, 2027 ET"*
  - **leitura A:** O jogo é adiado para uma data posterior a 31 de março de 2027.
  - **leitura B:** A decisão de adiar é tomada em data posterior a 31 de março de 2027 (o jogo podendo ocorrer antes).
- `fonte_vaga` — trecho: *"a consensus of credible reporting"*
  - **leitura A:** Basta que a maioria dos veículos de imprensa confiáveis concorde, sem critério formal.
  - **leitura B:** Exige um consenso explícito e formal entre fontes específicas predeterminadas.

<sub>deepseek-v4-flash · 91+10057 tok · US$ 0.00287 · 84806 ms</sub>

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

- Houver um encontro militar entre as forças militares da China (incluindo a Guarda Costeira Chinesa) e do Japão (excluindo a Guarda Costeira Japonesa) no período de 17 de novembro de 2025 a 31 de dezembro de 2026, 23h59 ET.
- O encontro militar é definido como incidente com uso de força, como ataques de mísseis, fogo de artilharia, troca de tiros ou outra forma de engajamento militar direto; ou abalroamento intencional que cause dano significativo (ex.: buraco no casco) ou afundamento de navio militar.

**Resolve NÃO:**

- Não houver encontro militar conforme a definição dentro do período.
- Ações não violentas, como tiros de advertência, fogo de artilharia em áreas desabitadas ou lançamentos de mísseis que caiam em águas territoriais ou atravessem espaço aéreo, não qualificam para SIM.
- Abalroamento que cause apenas danos menores (arranhões, amassados) não qualifica.
- Encontros que envolvam a Guarda Costeira Japonesa (JCG) como única força japonesa não qualificam, pois a JCG não é força militar.

**Fonte:** Consenso de reportagens confiáveis

**Prazo:** 31 de dezembro de 2026, 23h59 ET

**Anula se:** —

**Pegadinhas (4):**

- `muda_resultado` — A janela de resolução começa em 17 de novembro de 2025, não na criação do mercado. Um confronto antes dessa data não conta, mesmo que seja 'antes de 2027'.
- `muda_resultado` — Tiros de advertência, artilharia em área desabitada e mísseis que caiam em águas territoriais são explicitamente excluídos.
- `muda_resultado` — A Guarda Costeira Chinesa (CCG) conta como militar; a Guarda Costeira Japonesa (JCG) não. Um confronto entre a CCG e as forças japonesas conta, mas um confronto entre forças chinesas e a JCG não conta.
- `muda_resultado` — Abalroamento intencional só conta se causar dano significativo (ex.: buraco no casco) ou afundamento; danos menores não contam.

**Ambiguidades (4):**

- `janela_inclusiva` — trecho: *"between November 17, 2025, and December 31, 2026, 11:59 PM ET"*
  - **leitura A:** Inclui o dia 17 de novembro de 2025 a partir de 00:00.
  - **leitura B:** Exclui o dia 17 de novembro de 2025; o período começa em 18 de novembro de 2025.
- `fuso_ausente` — trecho: *"11:59 PM ET"*
  - **leitura A:** 11:59 PM EST (UTC-5).
  - **leitura B:** 11:59 PM EDT (UTC-4).
- `fonte_vaga` — trecho: *"a consensus of credible reporting"*
  - **leitura A:** Consenso entre veículos de mídia respeitáveis que reportem o evento.
  - **leitura B:** Exige confirmação explícita de múltiplas fontes; se houver divergência, não há consenso e o caso é decidido de outra forma.
- `limiar_de_borda` — trecho: *"Intentional ship ramming that results in significant damage to (e.g., a hole in the hull) or the sinking of a military ship by another will count toward a 'Yes' resolution, however minor damage (scrapes, dents) will not."*
  - **leitura A:** Dano significativo inclui qualquer avaria que comprometa a operação do navio, como rachaduras ou alagamento parcial.
  - **leitura B:** Dano significativo exige buraco no casco ou perda do navio (afundamento).

<sub>deepseek-v4-flash · 59+11178 tok · US$ 0.00318 · 89183 ms</sub>

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

- O Partido Liberal (PL) é a entidade que detém o maior número de assentos na Câmara dos Deputados como resultado da eleição de 4 de outubro de 2026, considerando apenas os assentos do próprio PL (sem coligações), e, se houver empate em número de assentos com outra entidade, a sigla 'PL' for a primeira em ordem alfabética entre as entidades empatadas.

**Resolve NÃO:**

- Qualquer outra entidade (partido ou federação) tiver mais assentos que o PL, ou, havendo empate no maior número de assentos, a sigla de outra entidade for alfabeticamente anterior a 'PL', ou, de qualquer forma, o PL não for a entidade com o maior número de assentos conforme a regra.

**Fonte:** Consenso de reportagens confiáveis; em caso de ambiguidade, os resultados oficiais do Tribunal Superior Eleitoral (TSE) ou da Câmara dos Deputados.

**Prazo:** 30 de junho de 2027, 23:59 ET

**Anula se:**

- Se o resultado da eleição não for conhecido definitivamente até 30 de junho de 2027, 23:59 ET, o mercado resolverá para 'Other' (nem SIM nem NÃO).

**Pegadinhas (3):**

- `muda_resultado` — A resolução considera apenas os assentos do partido, não os de coligações ou federações eleitorais das quais o partido participe; uma coalizão majoritária não faz o PL vencer.
- `muda_resultado` — Em caso de empate no número de assentos, o desempate é feito pela ordem alfabética da sigla; o PL pode perder o mercado para um partido com a mesma quantidade de assentos se a sigla deste vier antes de 'PL'.
- `muda_resultado` — Se o resultado da eleição não for conhecido até a data-limite, o mercado resolve para 'Other', e não para NÃO — há um terceiro desfecho além do binário.

**Ambiguidades (2):**

- `fuso_ausente` — trecho: *"June 30, 2027, 11:59 PM ET"*
  - **leitura A:** 23:59 no horário padrão do leste (EST).
  - **leitura B:** 23:59 no horário de verão do leste (EDT).
- `fonte_vaga` — trecho: *"as indicated by a consensus of credible reporting"*
  - **leitura A:** A maioria dos veículos de imprensa confiáveis aponta o mesmo resultado.
  - **leitura B:** Exige concordância unânime ou um consenso formal entre as fontes credíveis.

<sub>deepseek-v4-flash · 12+8131 tok · US$ 0.00232 · 66640 ms</sub>

