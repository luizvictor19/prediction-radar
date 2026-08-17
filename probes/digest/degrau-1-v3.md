# Digestão de regras — degrau 1, prompt `v3`

10 mercados, um modelo só — a leitura antes de qualquer escala

- **mercados:** 10
- **modelos:** `deepseek-v4-flash`
- **prompt:** `v3`
- **chamadas:** 10
- **amostra:** aleatória, semente fixa `20260815` (reprodutível: mesma semente, mesma lista)
- **custo estimado antes de rodar:** US$ 0.0368
- **custo real:** US$ 0.0364 (-0.8% sobre o estimado)

## Medidas

| modelo | chamadas | inválidas | taxa | custo total | por mercado | latência mediana | pegadinhas (mediana) | ambiguidades (mediana) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `deepseek-v4-flash` | 10 | 0 | 0.0% | US$ 0.0364 | US$ 0.00364 | 93932 ms | 3.5 | 2.5 |


**Pegadinhas:** 34 em 10 digestões válidas — 0 mercado(s) vieram com ZERO, que é resposta desejada quando a regra é direta.

**Podadas pela conferência:** 2 de 36 (5.6%) — 2 por trecho inexistente, 0 por trecho repetido, 0 por trecho curto demais. 0 severidade(s) rebaixada(s) para `detalhe` por falta de cenário.

<details><summary>o que foi podado</summary>

- `trecho não está na regra` — Um anúncio de renúncia/remoção antes do prazo resolve o mercado imediatamente, mesmo que a saída efetiva ocorra depois de 31 de agosto.  
  trecho citado: *"An announcement of Donald Trump's resignation/removal before this market's end date will immediately resolve this market to 'Yes', regardless of when the announced resignation/removal goes into effect."*
- `trecho não está na regra` — Se nenhum PM for empossado até o prazo, o mercado resolve para 'Other', não para um simples NÃO; na prática binária, equivale a NÃO, mas a resolução formal é 'Other'.  
  trecho citado: *"If no such Prime Minister is sworn in by December 31, 2027, 11:59 PM ET, this market will resolve to 'Other'."*

</details>

| severidade | n | % |
| --- | ---: | ---: |
| `muda_resultado` | 29 | 85.3% |
| `muda_timing` | 5 | 14.7% |
| `detalhe` | 0 | 0.0% |

**Ambiguidades:** 23 — taxa de `outro`: **30.4%** ⚠️ **no limiar de 20% ou acima: a lista fechada está incompleta e precisa crescer.**

| tipo | n | % |
| --- | ---: | ---: |
| `fonte_vaga` | 6 | 26.1% |
| `fuso_ausente` | 6 | 26.1% |
| `momento_ambiguo` | 0 | 0.0% |
| `data_ambigua` | 3 | 13.0% |
| `janela_inclusiva` | 0 | 0.0% |
| `escopo_de_entidade` | 1 | 4.3% |
| `limiar_de_borda` | 0 | 0.0% |
| `formato_do_mercado` | 0 | 0.0% |
| `outro` | 7 | 30.4% |

A comparação de QUALIDADE não está aqui de propósito: as medidas acima são as
objetivas, e o texto de cada modelo sai inteiro abaixo. Quem julga é quem lê.

## As digestões
### 1. Trump out as President by August 31?

<sub>`trump-out-as-president-by-august-31-20260730185655928` · eleicoes-e-politica · hash `3cb4c0c0f4f1` · 1018 caracteres de regra</sub>

<details><summary>a regra, íntegra</summary>

```
This market will resolve to “Yes” if Donald Trump resigns or is removed as President or otherwise ceases to be the President of the United States for any period of time by August 31, 2026, 11:59 PM ET. Otherwise, this market will resolve to “No”.

An announcement of Donald Trump's resignation/removal before this market's end date will immediately resolve this market to "Yes", regardless of when the announced resignation/removal goes into effect.

Only permanent removal from office will qualify. Temporary removal (e.g. temporary invocation of the 25th Amendment under Section 3 or a Section 4 invocation not sustained by both Houses of Congress) or impeachment without removal will not count.

A sustained invocation of the Twenty-Fifth Amendment, Section 4 (i.e., if both Houses of Congress, by two-thirds vote, uphold the Vice President and Cabinet’s determination of presidential inability) will qualify for a "Yes" resolution. 

The resolution source for this market will be a consensus of credible reporting.
```

</details>

**Resolve SIM:**

- Donald Trump renunciar ou ser removido do cargo de Presidente, ou deixar de ser Presidente dos Estados Unidos de forma permanente, até 31 de agosto de 2026, 23:59 ET.
- Um anúncio de renúncia ou remoção de Donald Trump antes de 31 de agosto de 2026, 23:59 ET resolverá imediatamente para 'Sim', independentemente de quando a renúncia/remoção entre em vigor.
- Invocação sustentada da Vigésima Quinta Emenda, Seção 4 (ou seja, se ambas as Casas do Congresso, por voto de dois terços, confirmarem a determinação do Vice-Presidente e do Gabinete de incapacidade presidencial) até 31 de agosto de 2026, 23:59 ET.

**Resolve NÃO:**

- Se nenhuma das condições de 'Sim' ocorrer até 31 de agosto de 2026, 23:59 ET, o mercado resolve 'Não'.
- Remoção temporária (por exemplo, invocação temporária da Seção 3 da 25ª Emenda ou invocação da Seção 4 não sustentada por ambas as Casas do Congresso) ou impeachment sem remoção não contam para 'Sim' e, portanto, resultam em 'Não'.

**Fonte:** Consenso de reportagens confiáveis

**Prazo:** August 31, 2026, 11:59 PM ET

**Anula se:** —

**Pegadinhas (1):**

- `muda_resultado` — A regra exige remoção permanente: afastamento temporário (como invocação da Seção 3 da 25ª Emenda) não conta, mesmo que o título sugira que qualquer saída valha.
  - trecho: *"Only permanent removal from office will qualify."*
  - cenário: Se Trump for temporariamente afastado pela Seção 3 da 25ª Emenda por um dia, quem leu só o título espera 'Sim', mas a regra dá 'Não'.

**Ambiguidades (3):**

- `fuso_ausente` — trecho: *"11:59 PM ET"*
  - **leitura A:** 11:59 PM Horário de Verão do Leste (EDT, UTC-4)
  - **leitura B:** 11:59 PM Horário Padrão do Leste (EST, UTC-5)
- `fonte_vaga` — trecho: *"a consensus of credible reporting"*
  - **leitura A:** Uma única reportagem crível já estabelece o fato.
  - **leitura B:** É necessário um acordo (consenso) entre múltiplas reportagens críveis.
- `outro` — trecho: *"for any period of time"*
  - **leitura A:** Qualquer afastamento, mesmo temporário, conta como 'fora do cargo'.
  - **leitura B:** Apenas afastamento permanente conta, conforme esclarece a regra em 'Only permanent removal from office will qualify'.

<sub>deepseek-v4-flash · 51+10440 tok · US$ 0.00298 · 84690 ms</sub>

---

### 2. Will the U.S. invade Cuba in 2026?

<sub>`will-the-us-invade-cuba-in-2026` · geopolitica-e-conflitos · hash `65ffd83ee00a` · 484 caracteres de regra</sub>

<details><summary>a regra, íntegra</summary>

```
This market will resolve to "Yes" if the United States commences a military offensive intended to establish control over any portion of Cuban land territory by December 31, 2026, 11:59 PM ET. Otherwise, this market will resolve to "No".

For the purposes of this market, land de facto controlled by Cuba or the United States as market creation, will be considered the sovereign territory of that country.

The resolution source for this market will be a consensus of credible sources.
```

</details>

**Resolve SIM:**

- Os EUA iniciarem uma ofensiva militar com a intenção de estabelecer controle sobre qualquer porção do território terrestre cubano até 31 de dezembro de 2026, 23:59 ET.

**Resolve NÃO:**

- Se a condição de resolução SIM não for satisfeita até o prazo, o mercado resolve NÃO (complemento).

**Fonte:** Consenso de fontes confiáveis

**Prazo:** December 31, 2026, 11:59 PM ET

**Anula se:** —

**Pegadinhas (3):**

- `muda_resultado` — A regra exige que a ofensiva tenha a intenção de estabelecer controle sobre território cubano. Ataques aéreos ou navais sem intenção de ocupar terra não resolvem SIM.
  - trecho: *"intended to establish control over any portion of Cuban land territory"*
  - cenário: Se os EUA realizarem apenas bombardeios aéreos, sem planos de ocupação terrestre, quem leu só o título espera SIM, mas a regra dá NÃO.
- `muda_resultado` — A regra resolve SIM com o início da ofensiva, mesmo que o controle nunca seja estabelecido.
  - trecho: *"commences a military offensive"*
  - cenário: Se os EUA iniciarem uma invasão que seja repelida sem qualquer controle, quem leu só o título pode esperar NÃO pela falta de sucesso, mas a regra dá SIM no início da ofensiva.
- `muda_resultado` — Terra sob controle de facto dos EUA na criação do mercado é considerada território soberano dos EUA, não cubano. Ações em Guantánamo, por exemplo, não contam.
  - trecho: *"land de facto controlled by Cuba or the United States as market creation, will be considered the sovereign territory of that country"*
  - cenário: Se os EUA reforçarem sua base em Guantánamo, quem leu só o título espera SIM, mas a regra dá NÃO porque essa terra é considerada território dos EUA.

**Ambiguidades (3):**

- `fuso_ausente` — trecho: *"11:59 PM ET"*
  - **leitura A:** 11:59 PM no horário padrão do leste (EST, UTC-5)
  - **leitura B:** 11:59 PM no horário de verão do leste (EDT, UTC-4)
- `fonte_vaga` — trecho: *"consensus of credible sources"*
  - **leitura A:** Um consenso entre grandes veículos de imprensa relatando o mesmo fato
  - **leitura B:** Uma única fonte oficial (como o governo dos EUA) é suficiente, se for considerada confiável
- `escopo_de_entidade` — trecho: *"land de facto controlled by Cuba or the United States"*
  - **leitura A:** Apenas territórios onde há presença militar ou ocupação física efetiva no momento da criação do mercado
  - **leitura B:** Inclui também territórios sob influência administrativa ou econômica dominante, mesmo sem presença militar

<sub>deepseek-v4-flash · 65+9618 tok · US$ 0.00275 · 81048 ms</sub>

---

### 3. Will Strait of Hormuz traffic return to normal in December?

<sub>`will-strait-of-hormuz-traffic-return-to-normal-in-december-20260702155718120` · geopolitica-e-conflitos · hash `2d9294ce6d47` · 2067 caracteres de regra</sub>

<details><summary>a regra, íntegra</summary>

```
This market will resolve according to the next month for which IMF Portwatch publishes a daily 7-day moving average of transit calls (“Arrivals of Ships”) for the Strait of Hormuz equal to or above 60. 

Daily transit calls include container, dry bulk, roll-on/roll-off, general cargo, and tanker ships. Ships not reported by IMF Portwatch will not be considered.

The qualifying month will be the calendar month containing the date associated with the first qualifying data point published by IMF PortWatch. 

This market will resolve as soon as IMF Portwatch publishes a 7-day moving average of transit calls equal to or above the specified level, or once data has been published for the final date of the specified month, and no such value has been published. 

If data is published for December 31, 2026 and a qualifying data point has not been published for any month, this market will resolve to “No Return to Normal Traffic in 2026.” If no data has been published for December 31, 2026 by January 31, 2027, 11:59 PM ET, this market will resolve based on data published up to that point.

Revisions to previously published data points made within this market’s timeframe will be considered. However, they will not disqualify a previously published data point from qualifying. Revisions to previously published data points after data is published for the final date in the specified month, however, will not be considered.

In case of obvious data integrity issues (i.e., erroneous data), the market may remain open until the end of the third calendar day (ET) after the date on which such data is first released to allow for corrections. Data integrity issues refer only to clerical or other similar errors in the underlying data, and do not include cases where IMF Portwatch differs from alternative sources.

The resolution source for this market will be IMF Portwatch, specifically the transit calls data published for the Strait of Hormuz at https://portwatch.imf.org/pages/cb5856222a5b4105adc6ee7e880a1730, both in the chart and through downloadable files.
```

</details>

**Resolve SIM:**

- A IMF Portwatch publica uma média móvel diária de 7 dias de chamadas de trânsito ('Arrivals of Ships') para o Estreito de Ormuz igual ou acima de 60, e o primeiro dado qualificante publicado ocorre no mês de dezembro de 2026.
- Contam apenas navios de contêineres, granel seco, roll-on/roll-off, carga geral e petroleiros; navios não reportados pela IMF Portwatch não são considerados.

**Resolve NÃO:**

- O primeiro dado qualificante (média móvel de 7 dias ≥ 60) ocorre em um mês anterior a dezembro de 2026, fazendo o mercado resolver NÃO imediatamente.
- Nenhum dado qualificante é publicado até que os dados de 31/12/2026 sejam publicados (ou, se não publicados, até 31/01/2027), resolvendo para 'No Return to Normal Traffic in 2026'.

**Fonte:** IMF Portwatch, especificamente os dados de transit calls publicados para o Estreito de Ormuz em https://portwatch.imf.org/pages/cb5856222a5b4105adc6ee7e880a1730, tanto no gráfico quanto em arquivos para download.

**Prazo:** 31 de janeiro de 2027, 11:59 PM ET

**Anula se:** —

**Pegadinhas (4):**

- `muda_resultado` — O mercado não pergunta se o tráfego está normal em dezembro, mas qual é o PRIMEIRO mês com média móvel de 7 dias ≥ 60. Se esse mês for anterior a dezembro, o mercado resolve NÃO imediatamente, mesmo que dezembro continue acima de 60.
  - trecho: *"The qualifying month will be the calendar month containing the date associated with the first qualifying data point published by IMF PortWatch."*
  - cenário: Se a média móvel de 7 dias atingir 60 em outubro de 2026 e continuar acima disso em dezembro, quem leu só o título espera SIM, mas a regra resolve NÃO porque o primeiro mês qualificante é outubro.
- `muda_resultado` — O limiar de 60 é sobre a média móvel de 7 dias, não sobre a contagem diária. Um único dia com muitos navios não basta.
  - trecho: *"publishes a daily 7-day moving average of transit calls"*
  - cenário: Se em 5 de dezembro houver 100 chamadas de trânsito, mas a média móvel dos 7 dias até essa data for 50, quem acha que o retorno ao normal é medido por dia esperaria SIM, mas a regra exige a média de 7 dias.
- `muda_resultado` — Nem todo navio conta: apenas contêineres, granel seco, roll-on/roll-off, carga geral e petroleiros. Navios de outros tipos ou não reportados pela IMF Portwatch são ignorados.
  - trecho: *"Daily transit calls include container, dry bulk, roll-on/roll-off, general cargo, and tanker ships."*
  - cenário: Se houver grande aumento de navios de passageiros, mas os tipos listados ficarem abaixo de 60, quem considera todo o tráfego esperaria SIM, mas a regra exclui passageiros.
- `muda_timing` — O mercado pode não resolver em 31/12/2026: se a IMF Portwatch não publicar dados para essa data até 31/01/2027, a resolução é adiada e usa os dados disponíveis até então.
  - trecho: *"If no data has been published for December 31, 2026 by January 31, 2027, 11:59 PM ET, this market will resolve based on data published up to that point."*
  - cenário: Se os dados de 31/12/2026 não forem publicados até 31/01/2027, quem esperava saber o resultado em dezembro verá o mercado resolver só em janeiro.

**Ambiguidades (2):**

- `data_ambigua` — trecho: *"the specified month"*
  - **leitura A:** Refere-se a dezembro de 2026, o mês mencionado no título e na cláusula de 31/12/2026.
  - **leitura B:** Refere-se a qualquer mês que venha a ser o 'próximo mês' qualificante, que pode não ser dezembro.
- `outro` — trecho: *"the market may remain open until the end of the third calendar day (ET)"*
  - **leitura A:** O mercado pode, discricionariamente, permanecer aberto até o fim do terceiro dia corrido (ET) para correções; não é obrigatório.
  - **leitura B:** O mercado obrigatoriamente permanecerá aberto até o fim do terceiro dia corrido (ET) para permitir correções.

<sub>deepseek-v4-flash · 33+20483 tok · US$ 0.00579 · 168881 ms</sub>

---

### 4. Will Lionel Messi be the #1 searched person on Google this year?

<sub>`will-lionel-messi-be-the-1-searched-person-on-google-this-year-20260717214426260` · ia-e-tecnologia · hash `0fba60e03908` · 909 caracteres de regra</sub>

<details><summary>a regra, íntegra</summary>

```
This market will resolve according to the individual ranked #1 in Google’s official Year in Search Global "People" list for 2026.

The specified list is expected to be displayed on the Google Trends Year in Search hub, with location selected to Global. The navigation procedure as of market creation involves going to trends.withgoogle.com/year-in-search/ and clicking through Global → Trending → People. The 2026 page is expected to appear using the same navigation once released (as the 2025 page currently shows the specified ranking). This market will resolve based on the specified list regardless of navigation procedure.

This market may resolve as soon as the specified list for 2026 is released. If Google does not release the specified list by March 31, 2027, 11:59 PM ET, this market will resolve to “Other.”

The resolution source for this market will be the specified list as published by Google.
```

</details>

**Resolve SIM:**

- O 1º lugar da lista oficial Google Year in Search Global 'People' de 2026 for Lionel Messi.

**Resolve NÃO:**

- Se a lista for publicada e o 1º lugar for outra pessoa que não Lionel Messi, o mercado resolve NÃO.

**Fonte:** A 'specified list' publicada por Google (a lista oficial Year in Search Global 'People' de 2026).

**Prazo:** March 31, 2027, 11:59 PM ET

**Anula se:**

- Se Google não publicar a lista especificada até March 31, 2027, 11:59 PM ET, o mercado resolve para 'Other'.

**Pegadinhas (4):**

- `muda_resultado` — O título sugere qualquer ranking de 'pessoa mais buscada'; a regra restringe à lista oficial Year in Search Global 'People' — outras métricas de busca não valem.
  - trecho: *"Google’s official Year in Search Global "People" list for 2026"*
  - cenário: Se uma medição de buscas do Google (não a lista Year in Search) mostrar Messi em 1º, mas a lista oficial apontar outro, quem leu só o título espera SIM, a regra dá NÃO.
- `muda_resultado` — A posição só vale no recorte Global; rankings por país ou região não contam.
  - trecho: *"with location selected to Global"*
  - cenário: Se a lista global não tiver Messi em 1º, mas a lista de um país (ex.: Argentina) tiver, quem leu só o título espera SIM, a regra dá NÃO.
- `muda_timing` — O mercado pode resolver assim que a lista for divulgada, antes do fim de 2026 — não precisa esperar 31/12.
  - trecho: *"This market may resolve as soon as the specified list for 2026 is released."*
  - cenário: Se a lista sair em dezembro de 2026, o mercado resolve na data de publicação, não no último dia do ano.
- `muda_resultado` — Se a lista não for publicada, o desfecho é 'Other' — não é SIM nem NÃO.
  - trecho: *"If Google does not release the specified list by March 31, 2027, 11:59 PM ET, this market will resolve to “Other.”"*
  - cenário: Se a lista não for lançada até o prazo, quem leu o título espera que o mercado resolva NÃO (já que Messi não foi confirmado #1), mas a regra manda resolver 'Other'.

**Ambiguidades (1):**

- `fuso_ausente` — trecho: *"11:59 PM ET"*
  - **leitura A:** 23:59 EDT (horário de verão da costa leste dos EUA)
  - **leitura B:** 23:59 EST (horário padrão da costa leste dos EUA)

<sub>deepseek-v4-flash · 41+10464 tok · US$ 0.00299 · 90946 ms</sub>

---

### 5. Will Gideon Sa’ar be the next Prime Minister of Israel?

<sub>`will-gideon-saar-be-the-next-prime-minister-of-israel` · eleicoes-e-politica · hash `45d0e3782c44` · 827 caracteres de regra</sub>

<details><summary>a regra, íntegra</summary>

```
Legislative elections are schedule to be held in Israel on October 27, 2026. 

This market will resolve to the next individual who is officially appointed and sworn in as Prime Minister of Israel following the 2026 parliamentary election. If an election is called early, this market will immediately resolve to the individual who is officially appointed and sworn in after that election.

To count for resolution, the individual must be formally sworn in. Any interim or caretaker Prime Minister will not count toward the resolution of this market.

If no such Prime Minister is sworn in by December 31, 2027, 11:59 PM ET, this market will resolve to “Other”.

The primary resolution source for this market will be official information from the Government of Israel; however, a consensus of credible reporting may also be used.
```

</details>

**Resolve SIM:**

- Gideon Sa’ar ser oficialmente nomeado e empossado como Primeiro-Ministro de Israel após a eleição parlamentar de 27 de outubro de 2026.
- Se uma eleição antecipada for convocada, Gideon Sa’ar ser oficialmente nomeado e empossado como Primeiro-Ministro após essa eleição antecipada.

**Resolve NÃO:**

- NÃO é o complemento: qualquer resultado em que Gideon Sa’ar não seja o próximo indivíduo oficialmente nomeado e empossado como Primeiro-Ministro, incluindo a posse de outro indivíduo ou a resolução para 'Other' por não haver PM empossado até o prazo.

**Fonte:** Informações oficiais do Governo de Israel; consenso de veículos de imprensa confiáveis.

**Prazo:** December 31, 2027, 11:59 PM ET

**Anula se:** —

**Pegadinhas (3):**

- `muda_resultado` — A resolução exige nomeação oficial e posse formal; não basta vencer a eleição ou ser designado.
  - trecho: *"officially appointed and sworn in"*
  - cenário: Se Gideon Sa’ar vencer a eleição e for indicado, mas não for oficialmente nomeado e empossado até o prazo, quem leu só o título espera SIM, mas a regra não resolve SIM.
- `muda_resultado` — Primeiros-ministros interinos ou de transição não contam para a resolução, mesmo que estejam no cargo.
  - trecho: *"Any interim or caretaker Prime Minister will not count toward the resolution of this market."*
  - cenário: Se Gideon Sa’ar se tornar primeiro-ministro interino após uma eleição, sem ser formalmente empossado para um mandato pleno, o título sugere que ele é o próximo PM, mas a regra não conta.
- `muda_timing` — Eleições antecipadas podem resolver o mercado imediatamente, sem esperar a eleição programada.
  - trecho: *"If an election is called early, this market will immediately resolve to the individual who is officially appointed and sworn in after that election."*
  - cenário: Se uma eleição antecipada ocorrer antes de outubro de 2026 e um PM for empossado, o mercado resolve imediatamente; quem leu só o título pode esperar a resolução apenas após a eleição programada.

**Ambiguidades (2):**

- `fuso_ausente` — trecho: *"11:59 PM ET"*
  - **leitura A:** 11:59 PM Eastern Daylight Time (UTC-4)
  - **leitura B:** 11:59 PM Eastern Standard Time (UTC-5)
- `fonte_vaga` — trecho: *"a consensus of credible reporting may also be used"*
  - **leitura A:** Um consenso de veículos confiáveis é alcançado quando a maioria deles reporta o mesmo fato.
  - **leitura B:** Um consenso exige que todos os veículos confiáveis concordem, sem exceção.

<sub>deepseek-v4-flash · 8+15316 tok · US$ 0.00434 · 126451 ms</sub>

---

### 6. Will Marco Rubio be the leader of Venezuela end of 2026?

<sub>`will-marco-rubio-be-the-leader-of-venezuela-end-of-2026` · eleicoes-e-politica · hash `c1f6413449fd` · 1987 caracteres de regra</sub>

<details><summary>a regra, íntegra</summary>

```
This market will resolve to the individual who officially holds the position of the head of state of Venezuela on Dec 31, 2026 at 12 PM ET.

For the purposes of this market, "officially holds" refers to the individual that was formally appointed, confirmed (if confirmation is required), and sworn in as the head of state of Venezuela or otherwise confirmed by official government information as being the head of state of Venezuela. 

If the Venezuelan government does not clearly state who is the head of state, the market will resolve to the individual who is listed as the Head of State by the UN (see: https://www.un.org/dgacm/en/content/protocol/hshgnfa).  

In the event that more than one official head of state is listed by the Venezuelan  government, this market will resolve to the individual who is listed as having primary status. If no distinction is made, the market will resolve to the individual who first assumed the position. 

If no individual holds the position this market will resolve to “No Head of State”. 

The following do NOT constitute "officially holding" the role: nominated, announced, or designated as the head of state of Venezuela but appointment not yet effective; appointed with an effective date after Dec 31, 2026; previously served as the head of state of Venezuela but term has expired, resigned, or been terminated before Dec 31, 2026; serving as the head of state of Venezuela in a consultant, contractor, or unofficial capacity; named as successor or heir apparent to the head of state of Venezuela but not yet appointed; or holding a different role with oversight of the head of state of Venezuela but not the specified position itself.

The primary resolution source will be official information from the UN recognized government of Venezuela. If the Government of Venezuela does not clearly state who is the head of state, information from the UN and a consensus of credible reporting may be used. 

Note: this market is mutually exclusive.
```

</details>

**Resolve SIM:**

- Resolve SIM se Marco Rubio for o indivíduo que oficialmente ocupa o cargo de chefe de Estado da Venezuela em 31/12/2026 às 12 PM ET, conforme a definição de 'officially holds' da regra.

**Resolve NÃO:**

- Resolve NÃO se outro indivíduo (que não Marco Rubio) for o chefe de Estado oficial em 31/12/2026 às 12 PM ET.
- Resolve NÃO se nenhum indivíduo ocupar o cargo — o mercado resolve para 'No Head of State', o que equivale a NÃO para a pergunta sobre Rubio.
- Resolve NÃO se Marco Rubio se enquadrar em alguma das exclusões da regra (nomeação sem efeito até a data, posse após 31/12/2026, mandato expirado, capacidade não oficial, sucessor não nomeado, etc.).

**Fonte:** Informação oficial do governo da Venezuela reconhecido pela ONU; se o governo não declarar claramente, a lista da ONU e, em última instância, consenso de reportagens confiáveis.

**Prazo:** Dec 31, 2026 at 12 PM ET

**Anula se:** —

**Pegadinhas (4):**

- `muda_resultado` — O título fala em 'leader' (líder), mas a regra exige o cargo oficial de chefe de Estado. Quem tiver o poder de fato sem nomeação formal não conta.
  - trecho: *"officially holds the position of the head of state of Venezuela"*
  - cenário: Se Marco Rubio controlar o país em 31/12/2026 mas não tiver sido formalmente nomeado/empossado, quem leu só o título espera SIM, e a regra dá NÃO.
- `muda_resultado` — O mercado resolve a um instante exato: meio-dia (12 PM) ET de 31/12/2026. Assumir o cargo depois desse horário, ainda que no mesmo dia, não conta.
  - trecho: *"on Dec 31, 2026 at 12 PM ET"*
  - cenário: Se Rubio for empossado às 14h de 31/12/2026, quem leu o título 'end of 2026' espera SIM (ele é o líder no fim do dia), mas a regra dá NÃO porque às 12 PM ET ele ainda não estava no cargo.
- `muda_resultado` — Ser anunciado, nomeado ou designado sem que a nomeação tenha efeito até 31/12/2026 não constitui ocupar oficialmente o cargo.
  - trecho: *"nominated, announced, or designated as the head of state of Venezuela but appointment not yet effective"*
  - cenário: Se Rubio for anunciado em 30/12/2026 como futuro chefe de Estado, com posse em 02/01/2027, quem leu o título espera SIM, mas a regra dá NÃO.
- `muda_resultado` — Se houver mais de um chefe de Estado listado, o mercado resolve para quem tiver status primário, e não para qualquer um dos listados.
  - trecho: *"this market will resolve to the individual who is listed as having primary status."*
  - cenário: Se o governo venezuelano listar Rubio e outro como chefes e o outro tiver status primário, quem leu o título espera SIM (Rubio é listado), mas a regra dá NÃO.

**Ambiguidades (3):**

- `fonte_vaga` — trecho: *"a consensus of credible reporting"*
  - **leitura A:** Exige concordância de múltiplas fontes independentes e confiáveis.
  - **leitura B:** Permite uma avaliação geral sem critério numérico definido de fontes.
- `outro` — trecho: *"In the event that more than one official head of state is listed by the Venezuelan  government, this market will resolve to the individual who is listed as having primary status."*
  - **leitura A:** O status primário é aquele marcado explicitamente na lista do governo.
  - **leitura B:** O status primário pode ser inferido do cargo/título (ex.: 'Presidente' vs. 'interino'), mesmo sem marcação explícita.
- `outro` — trecho: *"or otherwise confirmed by official government information as being the head of state of Venezuela"*
  - **leitura A:** A confirmação oficial do governo é uma via alternativa à nomeação/posse; uma declaração oficial bastaria.
  - **leitura B:** A confirmação oficial apenas corrobora que a nomeação e a posse já ocorreram; sozinha não basta.

<sub>deepseek-v4-flash · 128+13979 tok · US$ 0.00399 · 120787 ms</sub>

---

### 7. Will 7 Fed rate cuts happen in 2026?

<sub>`will-7-fed-rate-cuts-happen-in-2026` · macro-e-mercados · hash `d5fd02af7e03` · 1114 caracteres de regra</sub>

<details><summary>a regra, íntegra</summary>

```
This market will resolve according to the exact amount of cuts of 25 basis points in 2026 by the Fed (including any cuts made during the December meeting).

Emergency rate cuts outside of scheduled FOMC meetings will also count toward the total number of cuts in 2026. This market will remain open until December 31, 2026, 11:59 PM ET, to account for any such emergency actions.

For example, if the Fed cuts rates by 50 bps after a meeting, it would be considered 2 cuts (of 25 bps each).

This market will resolve early to "No" if the specified number of cuts becomes impossible — i.e., if more cuts have already occurred than the strike in question.

Note that cuts between 1–24 bps (inclusive) will also be considered 1 rate cut.

The resolution source for this market will be FOMC statements after meetings scheduled in 2026 according to the official calendar: https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm. The level and change of the target federal funds rate is also published at the official website of the Federal Reserve at https://www.federalreserve.gov/monetarypolicy/openmarket.htm.
```

</details>

**Resolve SIM:**

- O total de cortes (na unidade de 25 bps, incluindo cortes de emergência, com 50 bps contando como 2 e cortes de 1–24 bps contando como 1) realizados pelo Fed em 2026 for exatamente 7.

**Resolve NÃO:**

- Resolve NÃO se o total de cortes em 2026 for diferente de 7. A regra prevê resolução antecipada para NÃO se o número de cortes já ultrapassar 7 antes do prazo.

**Fonte:** Comunicados do FOMC após reuniões programadas em 2026 e o site oficial do Federal Reserve.

**Prazo:** December 31, 2026, 11:59 PM ET

**Anula se:** —

**Pegadinhas (4):**

- `muda_resultado` — Cortes de emergência fora das reuniões programadas do FOMC contam para o total, mesmo que o título só mencione 'Fed rate cuts'.
  - trecho: *"Emergency rate cuts outside of scheduled FOMC meetings will also count toward the total number of cuts in 2026."*
  - cenário: Se o Fed fizer 6 cortes em reuniões programadas e 1 corte de emergência, quem lê só o título e considera apenas reuniões programadas espera 6 cortes (NÃO), mas a regra conta 7 (SIM).
- `muda_resultado` — Um corte de 50 bps conta como 2 cortes de 25 bps, então o número de cortes não é igual ao número de reuniões com corte.
  - trecho: *"For example, if the Fed cuts rates by 50 bps after a meeting, it would be considered 2 cuts (of 25 bps each)."*
  - cenário: Se o Fed cortar 50 bps em três reuniões e 25 bps em uma, quem conta reuniões vê 4 cortes (NÃO), mas a regra conta 7 cortes (SIM).
- `muda_resultado` — Cortes de 1 a 24 bps (inclusive) contam como 1 corte, mesmo sendo menores que 25 bps.
  - trecho: *"Note that cuts between 1–24 bps (inclusive) will also be considered 1 rate cut."*
  - cenário: Se o Fed fizer 6 cortes de 25 bps e um corte de 10 bps, quem espera que apenas cortes de 25 bps contem vê 6 cortes (NÃO), mas a regra conta 7 (SIM).
- `muda_timing` — O mercado pode resolver NÃO antes do fim do ano, assim que o número de cortes ultrapassar 7, sem esperar até 31/12.
  - trecho: *"This market will resolve early to "No" if the specified number of cuts becomes impossible — i.e., if more cuts have already occurred than the strike in question."*
  - cenário: Se o Fed fizer 8 cortes até outubro, quem espera resolução em 31/12 prevê capital preso até lá, mas a regra resolve NÃO imediatamente.

**Ambiguidades (1):**

- `outro` — trecho: *"This market will resolve according to the exact amount of cuts of 25 basis points in 2026 by the Fed (including any cuts made during the December meeting)."*
  - **leitura A:** Um corte que não seja múltiplo de 25 bps (por exemplo, 30 bps) conta como 1 corte, pois qualquer redução da taxa é um corte único.
  - **leitura B:** Um corte de 30 bps não é um corte de 25 bps nem se enquadra em 1–24 bps; a regra não especifica como contar, podendo ser interpretado como 1 corte, 2 cortes ou arredondado.

<sub>deepseek-v4-flash · 95+10883 tok · US$ 0.00311 · 94299 ms</sub>

---

### 8. Will Nicolás Maduro be the leader of Venezuela end of 2026?

<sub>`will-nicols-maduro-be-the-leader-of-venezuela-end-of-2026` · geopolitica-e-conflitos · hash `c1f6413449fd` · 1987 caracteres de regra</sub>

<details><summary>a regra, íntegra</summary>

```
This market will resolve to the individual who officially holds the position of the head of state of Venezuela on Dec 31, 2026 at 12 PM ET.

For the purposes of this market, "officially holds" refers to the individual that was formally appointed, confirmed (if confirmation is required), and sworn in as the head of state of Venezuela or otherwise confirmed by official government information as being the head of state of Venezuela. 

If the Venezuelan government does not clearly state who is the head of state, the market will resolve to the individual who is listed as the Head of State by the UN (see: https://www.un.org/dgacm/en/content/protocol/hshgnfa).  

In the event that more than one official head of state is listed by the Venezuelan  government, this market will resolve to the individual who is listed as having primary status. If no distinction is made, the market will resolve to the individual who first assumed the position. 

If no individual holds the position this market will resolve to “No Head of State”. 

The following do NOT constitute "officially holding" the role: nominated, announced, or designated as the head of state of Venezuela but appointment not yet effective; appointed with an effective date after Dec 31, 2026; previously served as the head of state of Venezuela but term has expired, resigned, or been terminated before Dec 31, 2026; serving as the head of state of Venezuela in a consultant, contractor, or unofficial capacity; named as successor or heir apparent to the head of state of Venezuela but not yet appointed; or holding a different role with oversight of the head of state of Venezuela but not the specified position itself.

The primary resolution source will be official information from the UN recognized government of Venezuela. If the Government of Venezuela does not clearly state who is the head of state, information from the UN and a consensus of credible reporting may be used. 

Note: this market is mutually exclusive.
```

</details>

**Resolve SIM:**

- O indivíduo que oficialmente ocupa o cargo de chefe de Estado da Venezuela em 31/12/2026 às 12 PM ET, conforme a definição da regra, é Nicolás Maduro.

**Resolve NÃO:**

- Qualquer resultado em que o chefe de Estado determinado pela regra não seja Nicolás Maduro, incluindo a ausência de chefe de Estado ('No Head of State').

**Fonte:** Governo da Venezuela reconhecido pela ONU (fonte primária); se o governo não declarar claramente quem é o chefe de Estado, a lista da ONU e um consenso de reportagens confiáveis.

**Prazo:** Dec 31, 2026 at 12 PM ET

**Anula se:** —

**Pegadinhas (5):**

- `muda_resultado` — O mercado resolve com base em quem ocupa oficialmente o cargo, não em quem detém o poder de fato. Uma pessoa com controle real do país, mas sem nomeação formal, não conta.
  - trecho: *"officially holds the position of the head of state of Venezuela"*
  - cenário: Se Nicolás Maduro tiver o controle de facto do país em 31/12/2026, mas não tiver sido formalmente nomeado, confirmado e empossado até essa data, quem leu só o título espera SIM, mas a regra resolve NÃO.
- `muda_resultado` — Ser apenas nomeado, anunciado ou designado como chefe de Estado, sem que a nomeação esteja efetiva, não constitui ocupação oficial do cargo.
  - trecho: *"nominated, announced, or designated as the head of state of Venezuela but appointment not yet effective"*
  - cenário: Se Maduro for designado como o próximo chefe de Estado antes de 31/12/2026, mas a nomeação só se tornar efetiva em 2027, quem leu só o título pode esperar SIM, mas a regra resolve NÃO.
- `muda_resultado` — Se o governo venezuelano não declarar claramente quem é o chefe de Estado, a resolução usa a lista da ONU, que pode indicar alguém diferente de quem controla o país.
  - trecho: *"If the Venezuelan government does not clearly state who is the head of state, the market will resolve to the individual who is listed as the Head of State by the UN"*
  - cenário: Se o governo da Venezuela não emitir uma declaração clara sobre quem é o chefe de Estado, e a ONU listar outra pessoa que não Maduro, quem leu só o título pode esperar SIM (se Maduro estiver no controle), mas a regra resolve para a pessoa listada pela ONU.
- `muda_resultado` — Se mais de um chefe de Estado for listado oficialmente, o mercado resolve para o que tiver status primário; se não houver distinção, para o que primeiro assumiu o cargo.
  - trecho: *"In the event that more than one official head of state is listed by the Venezuelan government, this market will resolve to the individual who is listed as having primary status. If no distinction is made, the market will resolve to the individual who first assumed the position."*
  - cenário: Se o governo da Venezuela listar Maduro e outra pessoa como chefes de Estado, e a outra pessoa tiver status primário, o mercado resolve para a outra pessoa, não para Maduro.
- `muda_timing` — O mercado resolve no instante exato de 12 PM ET em 31/12/2026, não no fim do dia ou do ano. Quem ocupar o cargo nesse momento é o chefe de Estado, independentemente do que acontecer depois.
  - trecho: *"at 12 PM ET"*
  - cenário: Se Maduro for chefe de Estado na manhã de 31/12/2026, mas renunciar às 13h ET, ele ainda era chefe de Estado às 12 PM ET, então o mercado resolve SIM; quem leu só o título 'end of 2026' pode esperar que a renúncia antes do fim do dia mude a resposta, mas a regra fixa o meio-dia.

**Ambiguidades (3):**

- `fuso_ausente` — trecho: *"12 PM ET"*
  - **leitura A:** 12:00 PM Eastern Standard Time (UTC-5)
  - **leitura B:** 12:00 PM Eastern Daylight Time (UTC-4)
- `fonte_vaga` — trecho: *"a consensus of credible reporting"*
  - **leitura A:** Um consenso entre as principais organizações de notícias respeitáveis.
  - **leitura B:** Qualquer conjunto de reportagens considerado confiável, sem critério explícito.
- `outro` — trecho: *"does not clearly state"*
  - **leitura A:** O governo não emitiu nenhuma declaração oficial indicando quem é o chefe de Estado.
  - **leitura B:** O governo emitiu declarações, mas elas são contraditórias ou ambíguas sobre quem exatamente ocupa o cargo.

<sub>deepseek-v4-flash · 1+15671 tok · US$ 0.00444 · 127877 ms</sub>

---

### 9. Will Jay Collins be the Republican nominee for Florida Governor?

<sub>`will-jay-collins-be-the-republican-nominee-for-florida-governor` · eleicoes-e-politica · hash `14b25088963b` · 445 caracteres de regra</sub>

<details><summary>a regra, íntegra</summary>

```
This market will resolve according to the winner of the Republican Primary for Governor of Florida, scheduled to take place on August 18, 2026.

If no 2026 Florida Republican Gubernatorial Primary takes place, this market will resolve to “Other.”

The resolution source for this market will be the first official announcement of the results from the Florida Republican Party; however, an overwhelming consensus of credible reporting may suffice.
```

</details>

**Resolve SIM:**

- A primary republicana para governador da Flórida ocorre e Jay Collins é o vencedor.

**Resolve NÃO:**

- A primary republicana para governador da Flórida ocorre e o vencedor é um candidato diferente de Jay Collins.

**Fonte:** Florida Republican Party, pelo primeiro anúncio oficial dos resultados; consenso esmagador de reportagens confiáveis pode ser suficiente.

**Prazo:** 18 de agosto de 2026, sem fuso horário especificado na regra

**Anula se:** —

**Pegadinhas (3):**

- `muda_resultado` — O mercado resolve pela primary, não pela nomeação final: se Jay Collins vencer a primary mas depois for substituído como candidato do partido, o mercado ainda resolve SIM.
  - trecho: *"will resolve according to the winner of the Republican Primary for Governor of Florida"*
  - cenário: Se Jay Collins vencer a primary republicana e depois o partido o substituir por outro candidato, quem leu só o título espera NÃO (ele não é o nominee final), mas a regra resolve SIM porque ele venceu a primary.
- `muda_resultado` — Se a primary não ocorrer, o mercado resolve “Other”, não NÃO.
  - trecho: *"If no 2026 Florida Republican Gubernatorial Primary takes place, this market will resolve to “Other.”"*
  - cenário: Se a primary for cancelada ou não ocorrer, quem leu só o título espera NÃO (Collins não é o indicado), mas a regra resolve “Other”.
- `muda_resultado` — A fonte é a primeira declaração oficial do partido; uma correção posterior não altera a resolução.
  - trecho: *"the first official announcement of the results from the Florida Republican Party"*
  - cenário: Se o partido anunciar primeiro um vencedor diferente e depois corrigir para Jay Collins, quem leu só o título espera SIM (Collins é o vencedor final), mas a regra resolve pela primeira declaração, dando NÃO.

**Ambiguidades (3):**

- `data_ambigua` — trecho: *"scheduled to take place on August 18, 2026"*
  - **leitura A:** Se a primary for adiada para outra data, ainda é a mesma primary e o vencedor dela decide.
  - **leitura B:** Se a primary não ocorrer em 18 de agosto de 2026, é considerada “no primary” e o mercado resolve “Other”.
- `fonte_vaga` — trecho: *"an overwhelming consensus of credible reporting may suffice"*
  - **leitura A:** “Consenso esmagador” exige que a grande maioria das fontes confiáveis reporte o mesmo vencedor.
  - **leitura B:** Qualquer maioria entre fontes confiáveis é suficiente, mesmo que não seja esmagadora.
- `outro` — trecho: *"The resolution source for this market will be the first official announcement of the results from the Florida Republican Party; however, an overwhelming consensus of credible reporting may suffice."*
  - **leitura A:** O anúncio oficial do partido é a fonte definitiva; o consenso só é usado se não houver anúncio.
  - **leitura B:** O consenso esmagador de reportagens pode ser usado como fonte mesmo quando existe um anúncio oficial do partido.

<sub>deepseek-v4-flash · 57+10520 tok · US$ 0.00300 · 93564 ms</sub>

---

### 10. Will the U.S. weekly flu hospitalization rate per 100,000 in Week 31 be greater than 0.1?

<sub>`will-the-uptspt-weekly-flu-hospitalization-rate-per-100000-in-week-31-be-greater-than-0pt1-1786098036064` · saude-e-pandemias · hash `8227f6aee16c` · 1063 caracteres de regra</sub>

<details><summary>a regra, íntegra</summary>

```
This market will resolve according to the weekly influenza-associated hospitalization rate per 100,000 population for the United States, as reported by CDC FluSurv-NET for the specified week.

The resolution source for this market will be CDC FluView / FluSurv-NET (see: https://www.cdc.gov/fluview/index.html). If the FluSurv-NET hospitalization rate for the specified week is not released by 11:59 PM ET on the tenth calendar day following the date of the prior FluView weekly report release, this market will resolve to the lowest bracket.

CDC FluView reports the weekly FluSurv-NET hospitalization rate per 100,000 population to one decimal point (e.g., 0.1). Thus, this is the level of precision that will be used when resolving the market. 

Note: Only the CDC FluSurv-NET weekly hospitalization rate per 100,000 population for the specified week will qualify, regardless of the cumulative influenza-associated hospitalization rate, estimates, projections, state-level reports, or other influenza surveillance metrics published by the CDC or other sources.
```

</details>

**Resolve SIM:**

- A taxa semanal de hospitalização por influenza por 100.000 habitantes, reportada pelo CDC FluSurv-NET para a semana especificada, é maior que 0,1 conforme reportado (com precisão de uma casa decimal).

**Resolve NÃO:**

- A taxa semanal de hospitalização por influenza por 100.000 habitantes, reportada pelo CDC FluSurv-NET para a semana especificada, é menor ou igual a 0,1 (ou seja, não é maior que 0,1).
- Se a taxa para a semana especificada não for divulgada até o prazo estipulado (11:59 PM ET no décimo dia após a liberação do relatório semanal anterior do FluView), o mercado resolve para o menor bracket (neste mercado binário, NÃO).

**Fonte:** CDC FluView / FluSurv-NET

**Prazo:** 11:59 PM ET on the tenth calendar day following the date of the prior FluView weekly report release

**Anula se:** —

**Pegadinhas (3):**

- `muda_resultado` — A precisão do CDC é de uma casa decimal: se a taxa real for 0,12, o CDC reporta 0,1, e o mercado resolve NÃO, pois 0,1 não é maior que 0,1.
  - trecho: *"CDC FluView reports the weekly FluSurv-NET hospitalization rate per 100,000 population to one decimal point (e.g., 0.1)."*
  - cenário: Se a taxa real for 0,12, o CDC reporta 0,1; quem leu só o título espera SIM (pois 0,12>0,1), mas a regra resolve NÃO porque o valor reportado é 0,1.
- `muda_resultado` — Se o CDC não divulgar a taxa até o prazo (10 dias após o relatório anterior), o mercado resolve para o menor bracket, independentemente do valor real.
  - trecho: *"If the FluSurv-NET hospitalization rate for the specified week is not released by 11:59 PM ET on the tenth calendar day following the date of the prior FluView weekly report release, this market will resolve to the lowest bracket."*
  - cenário: Se o CDC atrasar a divulgação da semana além do prazo de 10 dias, quem leu só o título espera aguardar a divulgação, mas a regra resolve NÃO imediatamente.
- `muda_resultado` — Apenas a taxa semanal do FluSurv-NET conta; taxas cumulativas, estimativas, projeções ou relatórios estaduais não podem ser usados para a resolução.
  - trecho: *"Only the CDC FluSurv-NET weekly hospitalization rate per 100,000 population for the specified week will qualify, regardless of the cumulative influenza-associated hospitalization rate, estimates, projections, state-level reports, or other influenza surveillance metrics published by the CDC or other sources."*
  - cenário: Se a taxa cumulativa da temporada for maior que 0,1 e a taxa semanal for menor, quem leu só o título pode considerar a cumulativa e esperar SIM, mas a regra usa apenas a semanal e resolve NÃO.

**Ambiguidades (2):**

- `fuso_ausente` — trecho: *"11:59 PM ET"*
  - **leitura A:** ET significa Eastern Standard Time (UTC-5).
  - **leitura B:** ET significa Eastern Daylight Time (UTC-4).
- `data_ambigua` — trecho: *"the specified week"*
  - **leitura A:** A semana especificada é a semana 31 de 2026, conforme a data fim da plataforma (14/08/2026).
  - **leitura B:** A semana especificada é a semana 31 de outro ano, pois a regra não explicita o ano.

<sub>deepseek-v4-flash · 100+10631 tok · US$ 0.00304 · 90087 ms</sub>

