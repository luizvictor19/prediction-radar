# Medições M1–M4 — tela de Regra

Gerado por `npm run medir:tela-regra` (`scripts/medicoes/tela-regra.ts`).
Só leitura: nenhuma linha deste relatório escreve no banco.

## 0. O universo

| | |
| --- | ---: |
| linhas em `market_rule_digests` | 1264 |
| textos distintos (`description_sha256`) | 267 |
| mercados digeridos | 1033 |
| linhas em `digest_pegadinhas` | 3980 |
| linhas em `digest_ambiguidades` | 3252 |
| achados na tela (view) | 20357 |
| — acusados | 6407 |
| — herdados | 13950 |

Cobertura do roster — o denominador da lista, não o da digestão:

| | |
| --- | ---: |
| mercados em `v_radar` | 941 |
| — sem digestão nenhuma | 19 (2.0%) |
| digeridos que já saíram do roster | 111 |

**Conferência da réplica contra `digest_achados_por_mercado`:** 1033 linhas, zero divergência. Se divergisse, este script teria falhado antes de escrever o arquivo.

Leituras por texto — o denominador da concordância:

| leituras do texto | textos |
| ---: | ---: |
| 1 | 60 |
| 2 | 13 |
| 3 | 114 |
| 4 | 12 |
| 5 | 11 |
| 6 | 12 |
| 7 | 8 |
| 8 | 8 |
| 9 | 3 |
| 10 | 2 |
| 11 | 2 |
| 12 | 1 |
| 13 | 3 |
| 14 | 1 |
| 15 | 1 |
| 16 | 2 |
| 17 | 3 |
| 18 | 4 |
| 21 | 2 |
| 28 | 1 |
| 30 | 2 |
| 45 | 1 |
| 62 | 1 |

## M1 — frequência de cada tipo sobre os textos distintos

Denominador: 267 textos distintos de regra.

| tipo | textos | fração |
| --- | ---: | ---: |
| `pegadinha:muda_resultado` | 266 | 99.6% |
| `ambiguidade:fuso_ausente` | 229 | 85.8% |
| `ambiguidade:fonte_vaga` | 172 | 64.4% |
| `ambiguidade:criterio_discricionario` | 159 | 59.6% |
| `ambiguidade:precedencia_de_fonte` | 116 | 43.4% |
| `pegadinha:muda_timing` | 102 | 38.2% |
| `ambiguidade:outro` | 68 | 25.5% |
| `ambiguidade:momento_ambiguo` | 66 | 24.7% |
| `ambiguidade:escopo_de_entidade` | 62 | 23.2% |
| `ambiguidade:formato_do_mercado` | 48 | 18.0% |
| `ambiguidade:data_ambigua` | 47 | 17.6% |
| `ambiguidade:janela_inclusiva` | 37 | 13.9% |
| `contradicao:contradicao_interna` | 35 | 13.1% |
| `pegadinha:detalhe` | 32 | 12.0% |
| `ambiguidade:limiar_de_borda` | 28 | 10.5% |

> **P2 se aplica no grão `(tipo, trecho)`, nunca no grão `tipo`.** Esta tabela
> NÃO é entrada do gate de boilerplate. Lida como se fosse, ela mandaria
> recolher `pegadinha:muda_resultado` — o produto da tela — por aparecer em
> quase todo texto. O que se repete é o TIPO; o trecho que o causa é
> diferente em cada regulamento. Quem decide o gate é M1b.

## M1b — `(tipo, trecho)`: o grão do gate de boilerplate

Duas chaves de agrupamento, porque o boilerplate da Polymarket é o mesmo
texto com a data trocada — `December 31, 2026, 11:59 PM ET` e
`June 30, 2027, 11:59 PM ET` são a mesma omissão de fuso. A máscara vale só
para AGRUPAR: o trecho exibido é sempre o literal, e a dedup da seção 4
também opera sobre o literal.

### chave literal (trecho normalizado)

Pares distintos: 2197. Denominador: 267 textos.

| fração | textos | tipo | trecho |
| ---: | ---: | --- | --- |
| 44.9% | 120 | `fuso_ausente` | 11:59 PM ET |
| 42.3% | 113 | `fonte_vaga` | a consensus of credible reporting |
| 11.6% | 31 | `fuso_ausente` | December 31, 2026, 11:59 PM ET |
| 9.4% | 25 | `criterio_discricionario` | If there is ambiguity |
| 8.2% | 22 | `fuso_ausente` | June 30, 2027, 11:59 PM ET |
| 6.4% | 17 | `muda_resultado` | Prices from other exchanges, different trading pairs, or spot markets will not … |
| 6.4% | 17 | `fonte_vaga` | as indicated by a consensus of credible reporting |
| 6.4% | 17 | `fonte_vaga` | The resolution source for this market will be a consensus of credible reporting. |
| 4.9% | 13 | `muda_resultado` | If the result of this election isn't known by June 30, 2027, 11:59 PM ET, the m… |
| 4.9% | 13 | `fonte_vaga` | The resolution source will be a consensus of credible reporting. |
| 4.9% | 13 | `fuso_ausente` | by December 31, 2026, 11:59 PM ET |
| 4.5% | 12 | `fonte_vaga` | consensus of credible reporting |
| 4.1% | 11 | `precedencia_de_fonte` | both in the chart and through downloadable files |
| 4.1% | 11 | `criterio_discricionario` | If there is ambiguity, this market will resolve based solely on the official re… |
| 3.7% | 10 | `criterio_discricionario` | the market may remain open until the end of the third calendar day (ET) after t… |

Histograma — resolução de 1 ponto acima de 5%, que é onde o corte mora:

| faixa | pares |
| --- | ---: |
| 0% – 1% | 2024 |
| >1% – 3% | 156 |
| >3% – 5% | 9 |
| >6% – 7% | 3 |
| >8% – 9% | 1 |
| >9% – 10% | 1 |
| >11% – 12% | 1 |
| >42% – 43% | 1 |
| >44% – 45% | 1 |
| >50% | 0 |

**Vale:** o maior salto acima de 5% vai de **11.6%** a **42.3%** — 30.7 pontos sem nenhum par. Acima dele: 2 pares.

### chave mascarada (data e número mascarados)

Pares distintos: 2127. Denominador: 267 textos.

| fração | textos | tipo | trecho |
| ---: | ---: | --- | --- |
| 47.2% | 126 | `fuso_ausente` | 11:59 PM ET |
| 42.3% | 113 | `fonte_vaga` | a consensus of credible reporting |
| 31.8% | 85 | `fuso_ausente` | June 30, 2027, 11:59 PM ET |
| 9.7% | 26 | `fuso_ausente` | by December 31, 2026, 11:59 PM ET |
| 9.4% | 25 | `criterio_discricionario` | If there is ambiguity |
| 6.4% | 17 | `muda_resultado` | Prices from other exchanges, different trading pairs, or spot markets will not … |
| 6.4% | 17 | `fonte_vaga` | as indicated by a consensus of credible reporting |
| 6.4% | 17 | `fonte_vaga` | The resolution source for this market will be a consensus of credible reporting. |
| 5.2% | 14 | `muda_resultado` | If the result of this election isn't known by June 30, 2027, 11:59 PM ET, the m… |
| 4.9% | 13 | `fonte_vaga` | The resolution source will be a consensus of credible reporting. |
| 4.5% | 12 | `fonte_vaga` | consensus of credible reporting |
| 4.1% | 11 | `precedencia_de_fonte` | both in the chart and through downloadable files |
| 4.1% | 11 | `criterio_discricionario` | If there is ambiguity, this market will resolve based solely on the official re… |
| 3.7% | 10 | `muda_resultado` | between market creation and August 31, 2026, 11:59 PM ET |
| 3.7% | 10 | `criterio_discricionario` | the market may remain open until the end of the third calendar day (ET) after t… |

Histograma — resolução de 1 ponto acima de 5%, que é onde o corte mora:

| faixa | pares |
| --- | ---: |
| 0% – 1% | 1948 |
| >1% – 3% | 163 |
| >3% – 5% | 7 |
| >5% – 6% | 1 |
| >6% – 7% | 3 |
| >9% – 10% | 2 |
| >31% – 32% | 1 |
| >42% – 43% | 1 |
| >47% – 48% | 1 |
| >50% | 0 |

**Vale:** o maior salto acima de 5% vai de **9.7%** a **31.8%** — 22.1 pontos sem nenhum par. Acima dele: 3 pares.

### Quanto o gate recolhe, por limiar

Cada achado do texto vale por todos os mercados daquele texto — é assim que
ele aparece na tela.

| chave | limiar | pares | achados recolhidos | de | fração | mercados atingidos |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| chave literal | 80% | 0 | 0 | 20357 | 0.0% | 0 (0.0%) |
| chave literal | 50% | 0 | 0 | 20357 | 0.0% | 0 (0.0%) |
| chave literal | 45% | 0 | 0 | 20357 | 0.0% | 0 (0.0%) |
| chave literal | 40% | 2 | 960 | 20357 | 4.7% | 687 (66.5%) |
| chave literal | 35% | 2 | 960 | 20357 | 4.7% | 687 (66.5%) |
| chave literal | 30% | 2 | 960 | 20357 | 4.7% | 687 (66.5%) |
| chave literal | 20% | 2 | 960 | 20357 | 4.7% | 687 (66.5%) |
| chave literal | 12% | 2 | 960 | 20357 | 4.7% | 687 (66.5%) |
| chave literal | 10% | 3 | 1037 | 20357 | 5.1% | 698 (67.6%) |
| chave mascarada | 80% | 0 | 0 | 20357 | 0.0% | 0 (0.0%) |
| chave mascarada | 50% | 0 | 0 | 20357 | 0.0% | 0 (0.0%) |
| chave mascarada | 45% | 1 | 565 | 20357 | 2.8% | 565 (54.7%) |
| chave mascarada | 40% | 2 | 1027 | 20357 | 5.0% | 724 (70.1%) |
| chave mascarada | 35% | 2 | 1027 | 20357 | 5.0% | 724 (70.1%) |
| chave mascarada | 30% | 3 | 1505 | 20357 | 7.4% | 777 (75.2%) |
| chave mascarada | 20% | 3 | 1505 | 20357 | 7.4% | 777 (75.2%) |
| chave mascarada | 12% | 3 | 1505 | 20357 | 7.4% | 777 (75.2%) |
| chave mascarada | 10% | 3 | 1505 | 20357 | 7.4% | 777 (75.2%) |

## M2 — quanto a dedup por sobreposição corta

| variante | antes | depois | corte | invariante quebrado |
| --- | ---: | ---: | ---: | ---: |
| igualdade exata | 20357 | 20357 | 0,0% | 0 |
| **absorção pelo mais longo** (escolhida) | 20357 | 11129 | **45.3%** | **0** |
| componentes conexas por continência | 20357 | 10985 | 46.0% | 129 |
| componentes conexas com encavalamento ≥ 3 | 20357 | 10920 | 46.4% | 178 |

Igualdade exata corta 0% porque o `achado_id` da view já colapsa trechos
idênticos normalizados. É o que faz o eixo de mutação "igualdade em vez de
sobreposição" morder de verdade.

`invariante quebrado` conta as fusões em que o sobrevivente — o trecho mais
longo — NÃO contém todo mundo que absorveu.

**Continência não basta: o que quebra o invariante é o fecho transitivo.**
`A ⊃ B` e `C ⊃ B` com `A ⊅ C` põe os três no mesmo componente, e o
sobrevivente `A` não contém o `C`.

Trocar encavalamento por continência derruba o número de 178 para 129, não para zero. Zero só sai de abandonar a transitividade — e custa 0.7 ponto de corte, contra o direito de esconder um achado sem esconder a citação dele.

Distribuição das fusões (variante escolhida):

| itens fundidos em um | ocorrências |
| ---: | ---: |
| 2 | 2635 |
| 3 | 1138 |
| 4 | 432 |
| 5 | 305 |
| 6 | 45 |
| 7 | 18 |
| 8 | 68 |
| 17 | 62 |

Achados cuja contagem de leituras SOBE pela união: **4625** de 4703 fusões. O eixo de mutação "máximo em vez de união" morde em quase toda fusão.

## M3 — achados por mercado

Mercados: 1033.

| corte | mediana | p90 | máximo | média |
| --- | ---: | ---: | ---: | ---: |
| total | 16 | 39 | 43 | 19.7 |
| acusados | 5 | 10 | 23 | 6.2 |
| herdados | 11 | 33 | 37 | 13.5 |
| total após dedup (absorção pelo mais longo) | 10 | 16 | 25 | 10.8 |
| armadilhas acusadas (`muda_resultado`/`muda_timing`) | 3 | 6 | 13 | 3.3 |

Mercados com **zero** armadilha acusada: 14 (1.4%) — o estado vazio da seção 7 é raro, e existe.
Mercados acima do teto de 5 itens visíveis: 109 (10.6%).

## M4 — mercados com pegadinha `muda_resultado` e concordância ≥ 2/3

| mínimo de leituras do texto | mercados elegíveis | tem alguma | acusada | acusada com descrição e cenário |
| ---: | ---: | ---: | ---: | ---: |
| 1 | 1033 | 880 (85.2%) | 817 (79.1%) | 807 (78.1%) |
| 2 | 973 | 821 (84.4%) | 758 (77.9%) | 748 (76.9%) |
| 3 | 950 | 806 (84.8%) | 743 (78.2%) | 734 (77.3%) |

A coluna que decide a seção 8 é a última: manchete-vs-regra sai de
`descricao` + `cenario`, e no herdado os dois são nulos por construção.

A linha de mínimo 1 conta textos lidos uma vez só, onde `1/1` passa em "≥ 2/3" sem ninguém ter concordado com ninguém. As linhas de 2 e 3 são a mesma pergunta com a palavra concordância valendo o que ela diz.

### A amostra de 20 que a seção 8 pede

A pergunta é se `descricao` + `cenario` se sustentam sozinhos como
manchete-vs-regra, sem campo novo no prompt.

1. **45684462-a093-439c-bc41-75876079bb86** (concordância 5/5)
   - descrição: A ação de preço anterior à criação do mercado não conta; se o Bitcoin já estava acima de US$ 75.000 antes da criação e nunca mais atingir esse nível, o mercado resolve NÃO.
   - cenário: Se o Bitcoin já tiver ultrapassado US$ 75.000 antes da criação do mercado e, depois, nunca mais registrar uma vela de 1 minuto com High >= US$ 75.000, o mercado resolve NÃO.
2. **f773aef2-e87a-453a-8b9c-106ec94071d1** (concordância 3/3)
   - descrição: Um anúncio de renúncia ou remoção, ou uma saída programada por causa de eleição, não é suficiente para considerar o líder 'fora'; é preciso a saída efetiva e permanente.
   - cenário: Se um líder listado anunciar renúncia antes do prazo, mas permanecer no cargo até depois de 2027, quem leu só o título espera NÃO (pois ele 'saiu'), mas a regra dá SIM, pois o anúncio sozinho não qualifica.
3. **6daf4c4b-d16c-4e61-b263-40b905762a65** (concordância 2/3)
   - descrição: O país para o qual o caso conta é definido pela fonte qualificada, não pelo local de exposição ou de coleta.
   - cenário: Se um paciente diagnosticado em Portugal for atribuído à RDC pela fonte, o título 'novo país' sugere SIM, mas a regra dá NÃO porque o caso não é designado a Portugal.
4. **558c0449-1092-4c2d-830e-767974a69612** (concordância 5/5)
   - descrição: Preço atingido antes da criação deste mercado não conta; o período de análise começa na criação, não no início do ano.
   - cenário: Se o Bitcoin tiver atingido US$ 85.000 antes da criação deste mercado e nunca mais atingir depois, quem leu o título espera SIM, mas a regra dá NÃO.
5. **cc488715-229a-45bb-8537-7e42fc98d413** (concordância 27/30)
   - descrição: O mercado pode resolver 'Other' em vez de SIM ou NÃO se o vencedor não for declarado até a data limite. Quem leu só o título pode esperar que o mercado sempre resolva SIM/NÃO, mas a regra prevê um terceiro desfecho.
   - cenário: Se a cerimônia do Ballon d'Or 2026 for adiada ou o vencedor não for anunciado até 31/12/2026, quem leu só o título espera que o mercado resolva SIM ou NÃO depois, mas a regra resolve 'Other'.
6. **d31d0c18-82b6-4815-9004-6b5779c9fff0** (concordância 39/45)
   - descrição: Se a lista não for publicada até 31/03/2027 23:59 ET, o mercado resolve 'Other', e não simplesmente NÃO. O título é uma pergunta sim/não, então o resultado 'Other' é uma terceira via.
   - cenário: Se o Google não lançar a lista até o prazo, quem leu só o título espera resolução NÃO, mas a regra determina 'Other'.
7. **5e0b6ef1-c63e-497e-8d35-385b92154304** (concordância 10/15)
   - descrição: Assentos obtidos por coligações ou alianças das quais o PODE faça parte não são contados para o PODE; apenas os assentos do próprio partido/federação nomeado entram na conta.
   - cenário: Se o PODE integrar uma coligação cuja soma de assentos seja a maior, quem ler só o título pode achar que o PODE venceu; a regra exclui coligações, então o PODE pode não ter a maior bancada sozinho.
8. **e4b688f8-f714-46aa-8547-d2dcee41efb0** (concordância 1/1)
   - descrição: O mercado pode resolver 'Other' se o resultado não for conhecido até 30/06/2027 23:59 ET, mesmo que Gabriel Souza tenha vencido. O título sugere apenas SIM/NÃO, mas há um terceiro desfecho.
   - cenário: Se a divulgação do resultado atrasar e não for conhecida até 30/06/2027 23:59 ET, e Gabriel Souza tiver vencido, quem leu só o título espera SIM, mas a regra manda resolver 'Other'.
9. **3a917851-ac3d-4765-9215-441cb58d3543** (concordância 4/4)
   - descrição: Suspensões por companhias aéreas ou outros países não contam; apenas um fechamento iniciado por Israel resolve SIM.
   - cenário: Se companhias aéreas estrangeiras ou outros países suspenderem voos para/de Israel sem que Israel inicie o fechamento, quem leu só o título espera SIM, mas a regra dá NÃO.
10. **5cdd2320-02e4-4d8d-9d7c-cf49ed19547e** (concordância 5/7)
   - descrição: O título sugere uma aposta binária Sim/Não, mas a regra prevê um terceiro desfecho: se o Google não publicar a lista até o prazo, o mercado resolve "Other", não SIM nem NÃO.
   - cenário: Se o Google não divulgar a lista até a data-limite, quem leu só o título espera SIM ou NÃO, mas a regra resolve "Other".
11. **487e6c0b-f0bd-4aaf-ba5c-9a8ea5e573df** (concordância 8/8)
   - descrição: O mercado pode resolver como 'Other' (nem SIM nem NÃO) se o jogo for cancelado ou adiado além do prazo, contrariando a leitura binária do título.
   - cenário: Se o jogo do campeonato for cancelado, quem leu só o título espera uma resolução SIM ou NÃO, mas a regra resolve como 'Other'.
12. **160d7809-6e7a-4aab-823f-d061494a61d2** (concordância 13/18)
   - descrição: O mercado pode resolver 'Other' (nem SIM, nem NÃO) se a fonte ficar permanentemente indisponível, contrariando a pergunta binária do título.
   - cenário: Se o arena.ai encerrar as atividades antes da checagem, o mercado resolve 'Other', em vez de SIM ou NÃO como o título sugere.
13. **f6d261ab-dc8d-4d52-93c8-8b9fbb65815f** (concordância 18/21)
   - descrição: A resolução pode acontecer antes da certificação oficial: basta que as três fontes (AP, Fox e NBC) chamem o mesmo candidato.
   - cenário: Se as três fontes declararem Leo Zacky vencedor logo após a eleição, o mercado resolve SIM imediatamente, sem esperar a certificação oficial.
14. **ceb7288b-ce8e-484e-8863-9072ad612a4b** (concordância 20/21)
   - descrição: Cancelamento permanente ou não conclusão da temporada resolve 'Other', não 'Não' — mesmo que Antonelli não seja campeão.
   - cenário: Se a temporada for permanentemente cancelada, quem leu só o título espera resolução 'Não' (já que nenhum piloto seria campeão), mas a regra resolve 'Other'.
15. **ebf5a39e-2d68-487c-9237-c3f1da504ca4** (concordância 2/3)
   - descrição: Um simples anúncio de renúncia/remoção antes do prazo final resolve SIM imediatamente, mesmo que a renúncia/remoção só ocorra depois de 2026.
   - cenário: Se Trump anunciar em 30/12/2026 que renunciará em 10/01/2027, quem leu só o título espera NÃO (só sai em 2027), mas a regra resolve SIM no anúncio.
16. **4afd5ac9-621d-4e6f-9465-e6404d5d768c** (concordância 1/1)
   - descrição: Uma condição que ocorre e depois se reverte dentro da janela ainda resolve SIM: a regra exige que a condição seja 'met' (atendida), não que continue valendo na data de resolução.
   - cenário: Se um cessar-fogo Rússia-Ucrânia for declarado e depois colapsar antes de 31/8, quem acha que o cessar-fogo precisa estar em vigor na resolução espera 'Nothing', mas a regra resolve 'Something' porque a condição foi atendida.
17. **d2c79857-b539-4ee4-a603-1dedaef08298** (concordância 15/17)
   - descrição: Em empate de votos válidos, a ordem alfabética do sobrenome decide a segunda posição — não o critério de desempate do TSE.
   - cenário: Se Caiado empatar com outro candidato em votos válidos pela segunda vaga e o sobrenome do outro vier antes na ordem alfabética, Caiado fica em terceiro e o mercado resolve NÃO.
18. **5d55cf82-736f-45c4-9e73-fe60c55ee6d4** (concordância 6/6)
   - descrição: A CDC divulga a taxa com uma casa decimal; um valor real acima de 0,1 pode ser divulgado como 0,1 (ou 0,0) e o mercado resolve NÃO, porque a regra usa exatamente o número divulgado, não o valor sem arredondamento.
   - cenário: Se a taxa verdadeira da Semana 32 for 0,11 por 100.000, quem leu só o título espera SIM (0,11 > 0,1), mas a CDC divulga 0,1 e a regra manda resolver NÃO.
19. **8262ade9-2763-44ee-a09d-d0ddad5dcade** (concordância 21/30)
   - descrição: Título cerimonial, reconhecimento estrangeiro sem controle doméstico, nomeação sem autoridade efetiva ou serviço anterior expirado não qualificam; é preciso exercer realmente o poder de fato.
   - cenário: Se Ahmadinejad receber um título de chefe de Estado meramente cerimonial em 2026, sem comando real sobre as forças armadas ou instituições, quem leu só o título espera SIM, mas a regra dá NÃO.
20. **29353630-28d9-41bb-829c-92937c4ccf3d** (concordância 3/3)
   - descrição: Eleições, reformas ou sucessão de liderança não resolvem SIM, mesmo que mudem o governo.
   - cenário: Se um novo Líder Supremo for escolhido em uma sucessão normal, quem leu só o título espera SIM, mas a regra dá NÃO.
