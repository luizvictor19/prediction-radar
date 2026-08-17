# Digestão de regras — degrau 1, prompt `v4`

10 mercados, um modelo só — a leitura antes de qualquer escala

- **mercados:** 10
- **modelos:** `deepseek-v4-flash`
- **prompt:** `v4`
- **chamadas:** 10
- **amostra:** aleatória, semente fixa `20260815` (reprodutível: mesma semente, mesma lista)
- **custo estimado antes de rodar:** US$ 0.0379
- **custo real:** US$ 0.0363 (-4.2% sobre o estimado)

## ⚠️ Contradições internas — 1

A regra afirma duas coisas incompatíveis. Nenhuma das duas leituras está
errada, porque o texto sustenta as duas — quem resolve vai ter que escolher,
e a escolha não está escrita. É o formato do caso de US$ 60 milhões.

**Trump out as President by August 31?**

> for any period of time

contra

> Only permanent removal from office will qualify.

- **leitura A:** Qualquer afastamento, mesmo temporário, conta como 'deixar de ser Presidente' e resolve SIM.
- **leitura B:** Apenas remoção permanente conta; afastamento temporário não resolve SIM.

## Medidas

| modelo | chamadas | inválidas | taxa | custo total | por mercado | latência mediana | pegadinhas (mediana) | ambiguidades (mediana) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `deepseek-v4-flash` | 10 | 0 | 0.0% | US$ 0.0363 | US$ 0.00363 | 103610 ms | 3.0 | 2.0 |


**Pegadinhas:** 33 em 10 digestões válidas — 0 mercado(s) vieram com ZERO, que é resposta desejada quando a regra é direta.

**Podadas pela conferência:** 1 de 34 (2.9%) — 1 por trecho inexistente, 0 por trecho repetido, 0 por trecho curto demais. 0 severidade(s) rebaixada(s) para `detalhe` por falta de cenário.

<details><summary>o que foi podado</summary>

- `trecho não está na regra` — A ausência da primária resolve para 'Other', não para NÃO.  
  trecho citado: *"If no 2026 Florida Republican Gubernatorial Primary takes place, this market will resolve to 'Other.'"*

</details>

| severidade | n | % |
| --- | ---: | ---: |
| `muda_resultado` | 27 | 81.8% |
| `muda_timing` | 6 | 18.2% |
| `detalhe` | 0 | 0.0% |

**Ambiguidades:** 26 — taxa de `outro`: **7.7%** (abaixo de 20%)

| tipo | n | % |
| --- | ---: | ---: |
| `contradicao_interna` | 1 | 3.8% |
| `precedencia_de_fonte` | 3 | 11.5% |
| `criterio_discricionario` | 4 | 15.4% |
| `fonte_vaga` | 4 | 15.4% |
| `fuso_ausente` | 7 | 26.9% |
| `momento_ambiguo` | 0 | 0.0% |
| `data_ambigua` | 2 | 7.7% |
| `janela_inclusiva` | 0 | 0.0% |
| `escopo_de_entidade` | 1 | 3.8% |
| `limiar_de_borda` | 1 | 3.8% |
| `formato_do_mercado` | 1 | 3.8% |
| `outro` | 2 | 7.7% |

> **n = 10: isto é smoke test, não comparação.** Os percentuais acima
> não sustentam "ficou melhor que a versão anterior" — a v3 rodou três vezes com
> prompt idêntico nos mesmos 10 mercados e deu 20,0%, 6,7% e 30,4% de `outro`. A
> variância entre rodadas iguais engole o efeito. Comparação de qualidade só em
> n ≥ 100. O que este relatório responde é: rodou, validou, o trecho bate, nada truncou.

A comparação de QUALIDADE não está aqui de propósito: as medidas acima são as
objetivas, e o texto de cada modelo sai inteiro abaixo. Quem julga é quem lê.

## As digestões
### 1. Will the U.S. invade Cuba in 2026?

<sub>`will-the-us-invade-cuba-in-2026` · geopolitica-e-conflitos · hash `65ffd83ee00a` · 484 caracteres de regra</sub>

<details><summary>a regra, íntegra</summary>

```
This market will resolve to "Yes" if the United States commences a military offensive intended to establish control over any portion of Cuban land territory by December 31, 2026, 11:59 PM ET. Otherwise, this market will resolve to "No".

For the purposes of this market, land de facto controlled by Cuba or the United States as market creation, will be considered the sovereign territory of that country.

The resolution source for this market will be a consensus of credible sources.
```

</details>

**Resolve SIM:**

- Os EUA iniciarem uma ofensiva militar com a intenção de estabelecer controle sobre qualquer porção do território terrestre cubano até 31 de dezembro de 2026, 11:59 PM ET.

**Resolve NÃO:**

- Se essa ofensiva militar não ocorrer até o prazo — ou ocorrer sem a intenção de estabelecer controle sobre território terrestre cubano — o mercado resolve NÃO.

**Fonte:** Consenso de fontes confiáveis.

**Prazo:** 31 de dezembro de 2026, 11:59 PM ET

**Anula se:** —

**Pegadinhas (3):**

- `muda_resultado` — O título sugere que qualquer ação militar dos EUA em Cuba resolve SIM, mas a regra exclui do 'território cubano' as áreas sob controle de facto dos EUA na criação do mercado.
  - trecho: *"land de facto controlled by Cuba or the United States as market creation"*
  - cenário: Se os EUA realizarem uma ofensiva militar sobre uma área que já estava sob controle de facto dos EUA (como a Baía de Guantánamo), quem leu só o título espera SIM (é uma ação militar em Cuba), mas a regra considera esse território como dos EUA e resolve NÃO.
- `muda_timing` — A regra resolve SIM no início da ofensiva, não quando o controle é estabelecido — quem achava que o mercado só resolve no fim de 2026 pode se surpreender com a resolução antecipada.
  - trecho: *"commences a military offensive"*
  - cenário: Se os EUA iniciarem a invasão em junho de 2026, o mercado resolve SIM imediatamente, mas quem leu só o título pode esperar a resolução apenas em dezembro de 2026 (prazo final).
- `muda_resultado` — Uma ofensiva militar sem intenção de estabelecer controle (ex.: bombardeio isolado) não resolve SIM — o título 'invadir' pode sugerir que qualquer ataque conta.
  - trecho: *"intended to establish control"*
  - cenário: Se os EUA realizarem apenas ataques aéreos contra alvos cubanos sem planos de ocupar território, quem leu o título espera SIM (é uma ação militar), mas a regra exige intenção de estabelecer controle, então resolve NÃO.

**Ambiguidades (2):**

- `fuso_ausente` — trecho: *"11:59 PM ET"*
  - **leitura A:** ET refere-se a Eastern Standard Time (UTC-5).
  - **leitura B:** ET refere-se a Eastern Daylight Time (UTC-4).
- `fonte_vaga` — trecho: *"a consensus of credible sources"*
  - **leitura A:** 'Consenso' exige concordância ampla entre múltiplas fontes confiáveis, mas o número e a definição de 'confiável' não estão especificados.
  - **leitura B:** 'Consenso' pode ser interpretado como a maioria das fontes importantes, sem critério objetivo.

<sub>deepseek-v4-flash · 195+8254 tok · US$ 0.00240 · 73276 ms</sub>

---

### 2. Trump out as President by August 31?

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

- Donald Trump renunciar, ser removido ou de qualquer forma deixar de ser Presidente dos Estados Unidos até 31 de agosto de 2026, 23h59 ET.
- Anúncio de renúncia ou remoção de Trump antes da data final do mercado, que resolve SIM imediatamente, independentemente de quando a renúncia/remoção entra em vigor.
- Invocação sustentada da 25ª Emenda, Seção 4, com confirmação da determinação de incapacidade por 2/3 dos votos de ambas as Casas do Congresso.

**Resolve NÃO:**

- Se nenhuma condição de SIM ocorrer até 31 de agosto de 2026, 23h59 ET, o mercado resolve NÃO.
- A regra exclui explicitamente remoção temporária (como invocação temporária da 25ª Emenda, Seção 3, ou Seção 4 não sustentada) e impeachment sem remoção — esses casos não resolvem SIM.

**Fonte:** a consensus of credible reporting

**Prazo:** August 31, 2026, 11:59 PM ET

**Anula se:** —

**Pegadinhas (3):**

- `muda_resultado` — O anúncio de renúncia ou remoção antes do fim do mercado resolve SIM imediatamente, mesmo se a renúncia/remoção só entrar em vigor após 31 de agosto.
  - trecho: *"An announcement of Donald Trump's resignation/removal before this market's end date will immediately resolve this market to "Yes", regardless of when the announced resignation/removal goes into effect."*
  - cenário: Se Trump anunciar a renúncia em 30 de agosto com efeito em 1º de setembro, quem lê só o título espera NÃO, mas a regra dá SIM.
- `muda_resultado` — Apesar de o primeiro parágrafo dizer 'for any period of time', a regra exige remoção permanente — afastamento temporário não resolve SIM.
  - trecho: *"Only permanent removal from office will qualify."*
  - cenário: Se Trump ficar temporariamente afastado pela Seção 3 da 25ª Emenda e voltar antes de 31 de agosto, quem lê só o título espera SIM, mas a regra dá NÃO.
- `muda_resultado` — Impeachment sem remoção não resolve SIM; é preciso que haja remoção do cargo.
  - trecho: *"impeachment without removal will not count."*
  - cenário: Se a Câmara aprovar o impeachment de Trump e o Senado não o condenar, quem lê só o título espera SIM, mas a regra dá NÃO.

**Ambiguidades (4):**

- `contradicao_interna` — trecho: *"for any period of time"*
  - **em conflito com:** *"Only permanent removal from office will qualify."*
  - **leitura A:** Qualquer afastamento, mesmo temporário, conta como 'deixar de ser Presidente' e resolve SIM.
  - **leitura B:** Apenas remoção permanente conta; afastamento temporário não resolve SIM.
- `fuso_ausente` — trecho: *"August 31, 2026, 11:59 PM ET"*
  - **leitura A:** O prazo é 31/08/2026 às 23h59 no horário EDT (UTC-4).
  - **leitura B:** O prazo é 31/08/2026 às 23h59 no horário EST (UTC-5).
- `fonte_vaga` — trecho: *"The resolution source for this market will be a consensus of credible reporting."*
  - **leitura A:** É necessário que haja concordância unânime (ou praticamente unânime) entre veículos de imprensa confiáveis.
  - **leitura B:** Basta que a maioria das reportagens confiáveis, no conjunto, indique o fato.
- `data_ambigua` — trecho: *"before this market's end date"*
  - **leitura A:** Refere-se à data/hora de encerramento do mercado definida pela plataforma (ex.: 2026-08-31T23:59:00+00:00).
  - **leitura B:** Refere-se ao prazo de resolução do mercado (31/08/2026 23:59 ET).

<sub>deepseek-v4-flash · 309+13076 tok · US$ 0.00377 · 107899 ms</sub>

---

### 3. Will Lionel Messi be the #1 searched person on Google this year?

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

- Se Lionel Messi for o indivíduo ranqueado #1 na lista oficial 'People' do Google Year in Search Global de 2026.

**Resolve NÃO:**

- Se a lista for divulgada e Lionel Messi não for o #1 na referida lista, o mercado resolve NÃO.
- Se o Google não divulgar a lista até 31 de março de 2027, 23:59 ET, o mercado resolve 'Other' (não-SIM).

**Fonte:** A lista especificada publicada pelo Google (a lista oficial 'People' do Year in Search Global de 2026).

**Prazo:** 31 de março de 2027, 23:59 ET

**Anula se:** —

**Pegadinhas (3):**

- `muda_resultado` — A lista que define o resultado é a 'People' do Google Year in Search Global, com localização Global — não qualquer ranking do Google ou lista de um país específico.
  - trecho: *"with location selected to Global"*
  - cenário: Se Lionel Messi for #1 no ranking geral de buscas do Google, mas não na lista 'People' com localização Global, quem leu só o título espera SIM, mas a regra dá NÃO.
- `muda_timing` — O mercado pode resolver antes do final de 2026, assim que o Google publicar a lista do Year in Search 2026.
  - trecho: *"This market may resolve as soon as the specified list for 2026 is released."*
  - cenário: Se o Google publicar a lista em dezembro de 2026 (antes de 31/12), o mercado resolve nessa data, e não no fim do ano.
- `muda_resultado` — Se o Google não divulgar a lista até o prazo, o mercado resolve para 'Other', que é um desfecho distinto de um simples NÃO.
  - trecho: *"If Google does not release the specified list by March 31, 2027, 11:59 PM ET, this market will resolve to “Other.”"*
  - cenário: Se o Google não publicar a lista até 31/03/2027, quem leu só o título espera NÃO (ou anulação), mas a regra resolve 'Other', o que pode ter implicações diferentes no pagamento.

**Ambiguidades (2):**

- `fuso_ausente` — trecho: *"March 31, 2027, 11:59 PM ET"*
  - **leitura A:** O prazo é 31 de março de 2027, 23:59 no horário EDT (UTC-4).
  - **leitura B:** O prazo é 31 de março de 2027, 23:59 no horário EST (UTC-5).
- `criterio_discricionario` — trecho: *"This market may resolve as soon as the specified list for 2026 is released."*
  - **leitura A:** O mercado deve resolver imediatamente quando a lista for publicada.
  - **leitura B:** O mercado pode resolver a qualquer momento após a publicação, a critério de quem resolve.

<sub>deepseek-v4-flash · 299+9833 tok · US$ 0.00286 · 79660 ms</sub>

---

### 4. Will Strait of Hormuz traffic return to normal in December?

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

- Publicação pelo IMF Portwatch de uma média móvel de 7 dias das chamadas de trânsito ('Arrivals of Ships') para o Estreito de Ormuz igual ou superior a 60. O mês qualificador é o mês-calendário que contém a data do primeiro ponto de dados qualificador publicado.

**Resolve NÃO:**

- Se os dados de 31 de dezembro de 2026 forem publicados e nenhum ponto de dados qualificador (média móvel de 7 dias ≥60) tiver sido publicado para qualquer mês, o mercado resolve 'No Return to Normal Traffic in 2026'.
- Se os dados de 31 de dezembro de 2026 não forem publicados até 31 de janeiro de 2027, 23:59 ET, o mercado resolve com base nos dados publicados até esse ponto; se não houver ponto qualificador, resolve NÃO.

**Fonte:** IMF Portwatch, especificamente os dados de chamadas de trânsito publicados para o Estreito de Ormuz em https://portwatch.imf.org/pages/cb5856222a5b4105adc6ee7e880a1730, tanto no gráfico quanto em arquivos para download.

**Prazo:** 31 de janeiro de 2027, 23:59 ET

**Anula se:** —

**Pegadinhas (4):**

- `muda_resultado` — O mercado pode resolver SIM antes de dezembro: a regra fala no 'próximo mês' com média ≥60, não no mês de dezembro especificamente.
  - trecho: *"This market will resolve according to the next month for which IMF Portwatch publishes a daily 7-day moving average of transit calls (“Arrivals of Ships”) for the Strait of Hormuz equal to or above 60."*
  - cenário: Se a média móvel de 7 dias atingir 60 em novembro, quem leu apenas o título 'Will Strait of Hormuz traffic return to normal in December?' espera que o mercado só resolva em dezembro, mas a regra resolve SIM imediatamente em novembro.
- `muda_resultado` — Um ponto de dados já publicado como qualificador continua valendo mesmo se for revisado para baixo; a revisão não desqualifica.
  - trecho: *"However, they will not disqualify a previously published data point from qualifying."*
  - cenário: Se o IMF Portwatch publicar uma média móvel de 7 dias de 62 e depois revisar para 55, quem ler a regra de revisões pode achar que o mercado reverte para NÃO, mas a regra mantém o SIM porque a revisão não desqualifica o ponto anterior.
- `muda_resultado` — O limiar se aplica à média móvel de 7 dias, não a um único dia de chamadas; um pico diário acima de 60 não resolve SIM.
  - trecho: *"a daily 7-day moving average of transit calls (“Arrivals of Ships”)"*
  - cenário: Se em um dia houver 70 chamadas de navios, mas a média móvel de 7 dias ainda estiver abaixo de 60, quem leu o título pode achar que o tráfego voltou ao normal, mas a regra exige a média de 7 dias.
- `muda_resultado` — Apenas navios reportados pelo IMF Portwatch são considerados; navios de outros tipos ou fontes não contam para a média.
  - trecho: *"Ships not reported by IMF Portwatch will not be considered."*
  - cenário: Se o tráfego aumentar em categorias que o IMF Portwatch não reporta, a média móvel pode não subir; quem espera que todo tráfego conte pode achar que o normal foi atingido, mas a regra ignora esses navios.

**Ambiguidades (4):**

- `data_ambigua` — trecho: *"the next month for which IMF Portwatch publishes a daily 7-day moving average of transit calls (“Arrivals of Ships”) for the Strait of Hormuz equal to or above 60."*
  - **leitura A:** O 'próximo mês' é o primeiro mês após a criação do mercado; dados anteriores à criação não contam.
  - **leitura B:** Pode ser qualquer mês de 2026, inclusive meses anteriores à criação do mercado, já que a regra fala em 'qualquer mês' no final.
- `outro` — trecho: *"once data has been published for the final date of the specified month"*
  - **leitura A:** O 'mês especificado' é dezembro de 2026 (o mês do título), servindo apenas como prazo final para o NÃO.
  - **leitura B:** O 'mês especificado' é o mês qualificador (o próximo mês com média ≥60); o mercado resolve NÃO no fim desse mês se não houver valor.
- `criterio_discricionario` — trecho: *"the market may remain open until the end of the third calendar day (ET) after the date on which such data is first released to allow for corrections"*
  - **leitura A:** Em caso de problema de integridade, o mercado permanece aberto por até 3 dias para correções.
  - **leitura B:** A permanência aberta é opcional (o verbo 'may' indica permissão, não obrigação), ficando ao critério do resolvedor.
- `escopo_de_entidade` — trecho: *"Daily transit calls include container, dry bulk, roll-on/roll-off, general cargo, and tanker ships."*
  - **leitura A:** A lista é exaustiva: apenas essas cinco categorias de navio contam.
  - **leitura B:** A lista é exemplificativa: outras categorias reportadas pelo IMF Portwatch também contam.

<sub>deepseek-v4-flash · 547+19798 tok · US$ 0.00568 · 162669 ms</sub>

---

### 5. Will 7 Fed rate cuts happen in 2026?

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

- O total de cortes de 25 pontos-base feitos pelo Fed em 2026 for exatamente 7, contando cortes de 1–24 bps como 1 corte e cortes maiores como múltiplos (ex.: 50 bps = 2 cortes), incluindo cortes de emergência fora das reuniões agendadas e cortes na reunião de dezembro.

**Resolve NÃO:**

- O total de cortes de 25 pontos-base em 2026 não for exatamente 7.
- O mercado resolve NÃO antecipadamente se mais de 7 cortes já tiverem ocorrido (impossível totalizar exatamente 7).

**Fonte:** Comunicados do FOMC após reuniões agendadas em 2026, conforme calendário oficial, e o site oficial do Federal Reserve (nível e mudança da taxa de fundos federais).

**Prazo:** December 31, 2026, 11:59 PM ET

**Anula se:** —

**Pegadinhas (4):**

- `muda_resultado` — Um corte de 50 bps conta como 2 cortes de 25 bps, então o número de eventos de corte não é o que define o mercado.
  - trecho: *"if the Fed cuts rates by 50 bps after a meeting, it would be considered 2 cuts (of 25 bps each)."*
  - cenário: Se o Fed cortar 50 bps em uma reunião e mais 50 bps em outra, quem leu só o título '7 cortes' espera 2 cortes até aqui; a regra já conta 4, mudando a distância para o SIM.
- `muda_resultado` — Cortes de 1 a 24 bps (inclusive) contam como 1 corte cada, mesmo não sendo de 25 bps.
  - trecho: *"cuts between 1–24 bps (inclusive) will also be considered 1 rate cut."*
  - cenário: Se o Fed fizer um corte de 10 bps e mais seis cortes de 25 bps, quem ignora a regra vê 6 cortes; a regra vê 7, resolvendo SIM.
- `muda_timing` — O mercado resolve NÃO antecipadamente se o 8º corte já tiver ocorrido, antes do fim do ano.
  - trecho: *"This market will resolve early to "No" if the specified number of cuts becomes impossible — i.e., if more cuts have already occurred than the strike in question."*
  - cenário: Se o Fed fizer o 8º corte em outubro, quem leu só o título espera o mercado aberto até 31/12; a regra resolve NÃO naquele momento.
- `muda_resultado` — Cortes de emergência fora das reuniões agendadas contam para o total, então o mercado pode resolver com base em ações não previstas no calendário.
  - trecho: *"Emergency rate cuts outside of scheduled FOMC meetings will also count toward the total number of cuts in 2026."*
  - cenário: Se o Fed fizer um corte de emergência de 25 bps entre reuniões e nenhum outro corte, o título sugere 0 cortes agendados, mas a regra conta 1, aproximando do SIM.

**Ambiguidades (2):**

- `fuso_ausente` — trecho: *"December 31, 2026, 11:59 PM ET"*
  - **leitura A:** ET é a hora oficial do leste dos EUA em horário padrão (EST, UTC-5), pois 31 de dezembro está fora do horário de verão.
  - **leitura B:** ET é ambíguo e pode ser lido como EDT (UTC-4), adiantando o prazo em 1 hora.
- `limiar_de_borda` — trecho: *"the exact amount of cuts of 25 basis points in 2026 by the Fed"*
  - **leitura A:** Um corte de 30 bps conta como 1 corte, pois apenas cortes de 50 bps ou mais são desmembrados em múltiplos de 25; 30 bps é um corte único.
  - **leitura B:** Um corte de 30 bps conta como 2 cortes, pois 30 bps contém mais de um bloco de 25 bps (arredondando para cima).

<sub>deepseek-v4-flash · 353+16076 tok · US$ 0.00461 · 135270 ms</sub>

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

- Se Marco Rubio for formalmente nomeado, confirmado (se exigido) e empossado como chefe de estado da Venezuela em 31/12/2026 às 12 PM ET, ou for confirmado por informação oficial do governo venezuelano como chefe de estado nesse momento.

**Resolve NÃO:**

- Se qualquer outra pessoa ocupar oficialmente o cargo de chefe de estado da Venezuela em 31/12/2026 às 12 PM ET, o mercado resolve NÃO.
- Se nenhum indivíduo ocupar o cargo, o mercado resolve para 'No Head of State', o que corresponde a NÃO para a pergunta.
- Se Marco Rubio estiver em alguma das situações excluídas, como nomeação sem efeito, nomeação com data posterior a 31/12/2026, mandato expirado, renunciado ou encerrado antes, capacidade não oficial, sucessor sem nomeação, ou cargo diferente com supervisão.

**Fonte:** Informação oficial do governo da Venezuela reconhecido pela ONU (fonte primária). Em caso de falta de clareza, a listagem da ONU e um consenso de reportagens confiáveis.

**Prazo:** 31 de dezembro de 2026 às 12 PM ET

**Anula se:** —

**Pegadinhas (4):**

- `muda_resultado` — O título pergunta sobre 'líder', mas a regra resolve para 'chefe de estado' — um cargo formal. Uma liderança de facto sem nomeação formal não conta.
  - trecho: *"who officially holds the position of the head of state"*
  - cenário: Se um líder militar tomar o poder de facto sem ser formalmente empossado como chefe de estado, quem leu só o título espera SIM, mas a regra dá NÃO.
- `muda_resultado` — Uma nomeação com efeito posterior a 31/12/2026 não conta; a pessoa ainda não ocupa o cargo na data.
  - trecho: *"appointed with an effective date after Dec 31, 2026"*
  - cenário: Se Marco Rubio for nomeado para assumir somente em janeiro de 2027, quem leu 'end of 2026' pode considerá-lo líder no fim de 2026, mas a regra exclui explicitamente esse caso.
- `muda_resultado` — Se houver mais de um chefe de estado listado, vale o de status primário, não qualquer um dos listados.
  - trecho: *"this market will resolve to the individual who is listed as having primary status"*
  - cenário: Se o governo listar Rubio e outra pessoa como chefes de estado e a outra tiver status primário, quem leu só o título espera SIM (por Rubio constar na lista), mas a regra resolve para a outra.
- `muda_resultado` — O mercado avalia o cargo em 12 PM ET de 31/12/2026, não em qualquer momento do dia; mudanças após o meio-dia não alteram a resolução.
  - trecho: *"on Dec 31, 2026 at 12 PM ET"*
  - cenário: Se Marco Rubio for empossado às 18h de 31/12, quem leu 'end of 2026' espera SIM, mas a regra dá NÃO porque o cargo não estava ocupado às 12 PM ET.

**Ambiguidades (4):**

- `fuso_ausente` — trecho: *"12 PM ET"*
  - **leitura A:** 12 PM Eastern Standard Time (UTC-5)
  - **leitura B:** 12 PM Eastern Daylight Time (UTC-4)
- `criterio_discricionario` — trecho: *"does not clearly state who is the head of state"*
  - **leitura A:** Só quando o governo não manifesta nenhuma posição explícita sobre quem é chefe de estado; a ausência de informação é necessária para acionar a fonte subsidiária.
  - **leitura B:** Basta que a informação oficial seja ambígua ou contraditória, mesmo que o governo tenha se manifestado, para acionar a fonte subsidiária.
- `fonte_vaga` — trecho: *"a consensus of credible reporting"*
  - **leitura A:** Exige um conjunto grande e coerente de reportagens de veículos confiáveis, sem divergência relevante.
  - **leitura B:** Pode ser uma única reportagem de veículo confiável se não houver informações em contrário; 'consenso' é interpretado como ausência de contestação.
- `precedencia_de_fonte` — trecho: *"the market will resolve to the individual who is listed as the Head of State by the UN"*
  - **leitura A:** Quando o governo venezuelano não for claro, a lista da ONU é determinante e suficiente; a menção a consenso é meramente ilustrativa.
  - **leitura B:** A lista da ONU é apenas um dos elementos; se um consenso de reportagens confiáveis indicar outro indivíduo, este pode prevalecer.

<sub>deepseek-v4-flash · 514+12256 tok · US$ 0.00357 · 99321 ms</sub>

---

### 7. Will Gideon Sa’ar be the next Prime Minister of Israel?

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

- Gideon Sa’ar é o próximo indivíduo oficialmente nomeado e empossado como Primeiro-Ministro de Israel após a eleição parlamentar de 2026 (ou após uma eleição antecipada, se houver).

**Resolve NÃO:**

- O próximo indivíduo oficialmente nomeado e empossado após a eleição for alguém diferente de Gideon Sa’ar.
- Nenhum Primeiro-Ministro pleno for empossado até 31 de dezembro de 2027, 23:59 ET (o mercado resolve para 'Outro').

**Fonte:** Governo de Israel (informações oficiais), com consenso de reportagens confiáveis como alternativa.

**Prazo:** 31 de dezembro de 2027, 23:59 ET

**Anula se:** —

**Pegadinhas (3):**

- `muda_resultado` — Se Gideon Sa’ar for nomeado apenas como primeiro-ministro interino ou caretaker, isso não conta para a resolução — quem leu só o título pode achar que qualquer nomeação resolve.
  - trecho: *"Any interim or caretaker Prime Minister will not count toward the resolution of this market."*
  - cenário: Se Gideon Sa’ar for empossado apenas como primeiro-ministro interino (caretaker) após a eleição, sem uma nomeação plena, quem leu só o título espera SIM, mas a regra diz que interinos não contam, então o mercado não resolve para ele.
- `muda_timing` — A regra permite que uma eleição antecipada antecipe a resolução do mercado; quem ler só o título pode presumir que a resolução só ocorre após a eleição de 27/10/2026.
  - trecho: *"If an election is called early, this market will immediately resolve to the individual who is officially appointed and sworn in after that election."*
  - cenário: Se houver uma eleição antecipada em 2025 e alguém (possivelmente Gideon Sa’ar) for empossado logo depois, o mercado resolve imediatamente, não na data marcada de 2026 — quem esperava resolver só em 2026 seria pego de surpresa.
- `muda_timing` — O mercado não resolve automaticamente em 31/12/2026 (data de fim da plataforma); a regra dá prazo até 31/12/2027 para alguém ser empossado, caso contrário resolve 'Outro'.
  - trecho: *"If no such Prime Minister is sworn in by December 31, 2027, 11:59 PM ET, this market will resolve to “Other”."*
  - cenário: Se ninguém for empossado até o fim de 2026, quem olha a data da plataforma espera resolução em 31/12/2026, mas a regra mantém o mercado em aberto até 31/12/2027.

**Ambiguidades (2):**

- `precedencia_de_fonte` — trecho: *"The primary resolution source for this market will be official information from the Government of Israel; however, a consensus of credible reporting may also be used."*
  - **leitura A:** A informação oficial do Governo de Israel é a fonte que prevalece; o consenso de reportagens confiáveis só pode ser usado se a informação oficial estiver indisponível.
  - **leitura B:** O consenso de reportagens confiáveis pode ser usado como fonte alternativa e independente, inclusive se divergir da informação oficial.
- `fuso_ausente` — trecho: *"by December 31, 2027, 11:59 PM ET"*
  - **leitura A:** ET refere-se a Eastern Standard Time (EST, UTC-5).
  - **leitura B:** ET pode ser Eastern Daylight Time (EDT, UTC-4), já que a regra não especifica qual dos dois.

<sub>deepseek-v4-flash · 266+10050 tok · US$ 0.00291 · 82194 ms</sub>

---

### 8. Will Jay Collins be the Republican nominee for Florida Governor?

<sub>`will-jay-collins-be-the-republican-nominee-for-florida-governor` · eleicoes-e-politica · hash `14b25088963b` · 445 caracteres de regra</sub>

<details><summary>a regra, íntegra</summary>

```
This market will resolve according to the winner of the Republican Primary for Governor of Florida, scheduled to take place on August 18, 2026.

If no 2026 Florida Republican Gubernatorial Primary takes place, this market will resolve to “Other.”

The resolution source for this market will be the first official announcement of the results from the Florida Republican Party; however, an overwhelming consensus of credible reporting may suffice.
```

</details>

**Resolve SIM:**

- Jay Collins vencer a primária republicana para Governador da Flórida em 18 de agosto de 2026.

**Resolve NÃO:**

- Se a primária ocorrer e Jay Collins não vencer, o mercado resolve NÃO.
- Se nenhuma primária republicana para Governador da Flórida de 2026 ocorrer, o mercado resolve para 'Other' (não resolve SIM).

**Fonte:** Partido Republicano da Flórida (primeiro anúncio oficial), com consenso esmagador de reportagens confiáveis como alternativa.

**Prazo:** 18 de agosto de 2026 (data da primária; sem fuso especificado na regra).

**Anula se:** —

**Pegadinhas (2):**

- `muda_resultado` — O mercado resolve pelo primeiro anúncio oficial do partido, não pelo resultado final certificado (um reconto posterior não altera a resolução).
  - trecho: *"the first official announcement of the results from the Florida Republican Party"*
  - cenário: Se o primeiro anúncio oficial declarar Collins vencedor e depois um reconto mudar o resultado, quem leu só o título espera resolução NÃO (pelo resultado final), mas a regra resolve SIM (pelo primeiro anúncio).
- `muda_timing` — O consenso de reportagens confiáveis pode resolver o mercado antes de qualquer anúncio oficial do partido.
  - trecho: *"an overwhelming consensus of credible reporting may suffice"*
  - cenário: Se as reportagens projetarem de forma consensual Collins como vencedor antes do anúncio oficial do partido, quem leu só o título espera aguardar o anúncio oficial, mas a regra permite resolver pelo consenso da imprensa.

**Ambiguidades (1):**

- `precedencia_de_fonte` — trecho: *"the first official announcement of the results from the Florida Republican Party; however, an overwhelming consensus of credible reporting may suffice"*
  - **leitura A:** O anúncio oficial do Partido Republicano é a fonte primária; o consenso da imprensa só é usado se não houver anúncio oficial.
  - **leitura B:** O consenso esmagador de reportagens confiáveis pode ser usado como fonte alternativa, inclusive em divergência com o anúncio oficial, pois a regra não estabelece hierarquia.

<sub>deepseek-v4-flash · 187+6850 tok · US$ 0.00201 · 55370 ms</sub>

---

### 9. Will the U.S. weekly flu hospitalization rate per 100,000 in Week 31 be greater than 0.1?

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

- A taxa semanal de hospitalização por influenza por 100.000 habitantes nos EUA para a Semana 31, conforme reportada pelo CDC FluSurv-NET/CDC FluView, for maior que 0,1.

**Resolve NÃO:**

- A taxa reportada para a Semana 31 for menor ou igual a 0,1.
- A taxa para a Semana 31 não for divulgada pelo CDC FluSurv-NET até 23h59 ET do décimo dia corrido após a data de divulgação do relatório semanal anterior do FluView, caso em que o mercado resolve para o nível mais baixo (interpretado como NÃO).

**Fonte:** CDC FluView / FluSurv-NET

**Prazo:** 11:59 PM ET on the tenth calendar day following the date of the prior FluView weekly report release

**Anula se:** —

**Pegadinhas (3):**

- `muda_resultado` — O mercado usa o valor reportado pelo FluSurv-NET com uma casa decimal; uma taxa real de 0,14 é reportada como 0,1 e, portanto, NÃO é maior que 0,1, mesmo sendo maior na realidade.
  - trecho: *"Thus, this is the level of precision that will be used when resolving the market."*
  - cenário: Se a taxa real da Semana 31 for 0,14 por 100 mil, o CDC reporta 0,1; quem leu só o título espera SIM (0,14 > 0,1), mas a regra dá NÃO porque o valor reportado não é maior que 0,1.
- `muda_resultado` — Se o CDC não divulgar a taxa da Semana 31 até o prazo estipulado, o mercado resolve para o nível mais baixo, independentemente da taxa real.
  - trecho: *"If the FluSurv-NET hospitalization rate for the specified week is not released by 11:59 PM ET on the tenth calendar day following the date of the prior FluView weekly report release, this market will resolve to the lowest bracket."*
  - cenário: Se o CDC atrasar a publicação da taxa da Semana 31 além do décimo dia após o relatório anterior, o mercado resolve NÃO (lowest bracket) mesmo que a taxa real seja superior a 0,1.
- `muda_resultado` — Somente a taxa semanal do FluSurv-NET para a Semana 31 conta; taxas cumulativas, estimativas, projeções e relatórios estaduais não são usados.
  - trecho: *"Only the CDC FluSurv-NET weekly hospitalization rate per 100,000 population for the specified week will qualify, regardless of the cumulative influenza-associated hospitalization rate, estimates, projections, state-level reports, or other influenza surveillance metrics published by the CDC or other sources."*
  - cenário: Se a taxa cumulativa da temporada for 0,5, mas a taxa semanal da Semana 31 for 0,05, quem usar a taxa cumulativa espera SIM, mas a regra exige apenas a taxa semanal do FluSurv-NET e dá NÃO.

**Ambiguidades (2):**

- `outro` — trecho: *"CDC FluView reports the weekly FluSurv-NET hospitalization rate per 100,000 population to one decimal point (e.g., 0.1)."*
  - **leitura A:** A taxa é arredondada para a casa decimal mais próxima (ex.: 0,15 vira 0,2; 0,14 vira 0,1).
  - **leitura B:** A taxa é truncada na primeira casa decimal (ex.: 0,19 vira 0,1; 0,2 vira 0,2).
- `formato_do_mercado` — trecho: *"this market will resolve to the lowest bracket."*
  - **leitura A:** Em um mercado binário, 'lowest bracket' é interpretado como o resultado NÃO (taxa ≤ 0,1).
  - **leitura B:** Como a pergunta é binária, não há definição de 'bracket'; a expressão sugere um mercado de múltiplas opções, então a resolução para 'lowest bracket' pode não se aplicar ou ser inválida.

<sub>deepseek-v4-flash · 358+15379 tok · US$ 0.00442 · 129373 ms</sub>

---

### 10. Will Nicolás Maduro be the leader of Venezuela end of 2026?

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

- O mercado resolve SIM se Nicolás Maduro for o indivíduo que oficialmente ocupa o cargo de chefe de Estado da Venezuela em 31/12/2026 às 12h ET, ou seja, que foi formalmente nomeado, confirmado (se exigida confirmação) e empossado como chefe de Estado, ou confirmado por informação oficial do governo da Venezuela.

**Resolve NÃO:**

- Resolve NÃO se qualquer outro indivíduo ocupar oficialmente o cargo de chefe de Estado da Venezuela em 31/12/2026 às 12h ET, ou se nenhum indivíduo ocupar o cargo (resolvendo para 'No Head of State').

**Fonte:** Informação oficial do governo da Venezuela reconhecido pela ONU; se o governo não declarar claramente, a listagem da ONU e um consenso de reportagens confiáveis podem ser usados.

**Prazo:** 31/12/2026 às 12:00 (meio-dia) ET

**Anula se:** —

**Pegadinhas (4):**

- `muda_resultado` — O título diz 'líder', mas o mercado resolve para quem ocupa oficialmente o cargo de chefe de Estado. Uma liderança de facto sem posse formal não conta.
  - trecho: *"This market will resolve to the individual who officially holds the position of the head of state of Venezuela"*
  - cenário: Se Maduro for o governante de facto em 31/12/2026, mas não tiver sido formalmente nomeado e empossado como chefe de Estado até as 12h ET, quem leu só o título espera SIM; a regra dá NÃO.
- `muda_resultado` — O momento de resolução é o meio-dia (12 PM ET) de 31/12/2026, não o fim do dia. Mudanças de status após esse horário não alteram o resultado.
  - trecho: *"on Dec 31, 2026 at 12 PM ET"*
  - cenário: Se Maduro for empossado como chefe de Estado em 31/12/2026 às 13h ET (depois do meio-dia), quem leu 'end of 2026' espera SIM por ele ser o líder no fim do ano; a regra dá NÃO, pois às 12h ET ele ainda não ocupava o cargo.
- `muda_resultado` — Mera nomeação, anúncio ou designação sem efeito imediato não significa ocupar o cargo; é preciso que a nomeação já esteja em vigor na data/hora.
  - trecho: *"nominated, announced, or designated as the head of state of Venezuela but appointment not yet effective"*
  - cenário: Se Maduro for anunciado como novo chefe de Estado em 30/12/2026, mas a posse só ocorrer em 02/01/2027, quem leu só o título espera SIM (porque foi anunciado como líder); a regra dá NÃO, porque até 31/12 às 12h a nomeação não era efetiva.
- `muda_resultado` — A fonte primária é o governo da Venezuela reconhecido pela ONU. Se houver um governo paralelo não reconhecido que declare Maduro chefe, essa declaração não é a fonte principal.
  - trecho: *"The primary resolution source will be official information from the UN recognized government of Venezuela"*
  - cenário: Se o governo reconhecido pela ONU declarar que Maduro não é o chefe de Estado, mas o governo de facto (não reconhecido pela ONU) afirmar que ele é, quem leu só o título espera SIM; a regra dá NÃO, pois usa a informação do governo reconhecido pela ONU.

**Ambiguidades (3):**

- `fuso_ausente` — trecho: *"Dec 31, 2026 at 12 PM ET"*
  - **leitura A:** ET refere-se ao Eastern Standard Time (EST), em vigor em dezembro, que é UTC-5; o instante é 31/12/2026 às 17:00 UTC.
  - **leitura B:** ET poderia ser Eastern Daylight Time (EDT), que é UTC-4; seria 31/12/2026 às 16:00 UTC. A diferença de uma hora pode alterar o instante de medição.
- `fonte_vaga` — trecho: *"a consensus of credible reporting may be used"*
  - **leitura A:** Basta que a maioria das reportagens de fontes consideradas confiáveis apontem o mesmo nome para haver consenso.
  - **leitura B:** É necessário um consenso amplo ou unânime, sem critério objetivo sobre quantas e quais reportagens contam; o resolvedor decide.
- `criterio_discricionario` — trecho: *"If the Government of Venezuela does not clearly state who is the head of state"*
  - **leitura A:** Considera-se 'claramente' se houver um comunicado oficial expresso, direto e sem ambiguidade.
  - **leitura B:** O julgamento de clareza fica ao critério do resolvedor; declarações vagas, conflitantes ou a ausência de manifestação podem ou não ser consideradas falta de clareza.

<sub>deepseek-v4-flash · 515+14076 tok · US$ 0.00408 · 120685 ms</sub>

