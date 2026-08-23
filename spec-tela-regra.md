# Spec — reorganização da tela de Regra

Documento interno. Escrito em português por convenção. Nomes de branch, commit, PR e comentário de código continuam em inglês.

---

## 1. O que esta tela existe para responder

A tese do projeto é uma frase:

> O mercado precifica a MANCHETE. O mercado resolve pela REGRA. A diferença é a oportunidade.

A tela de Regra hoje não responde a isso em lugar nenhum. Ela começa por contradições, mostra a leitura estruturada, empilha uma tabela comparando três leituras, lista dezenas de achados e termina no regulamento cru. Um humano que abre essa tela não consegue dizer, em dez segundos, **onde o título mente**.

Toda decisão abaixo serve a essa pergunta. O que não serve a ela desce ou recolhe.

---

## 2. Princípios

Numerados para poder citar em revisão.

**P1 — Citação nunca é traduzida.** O `trecho` e o regulamento cru são o texto que resolve o mercado. Traduzir destrói a garantia verbatim que o projeto inteiro sustenta. A tela precisa dizer isso visualmente: citação tem tratamento próprio (fundo, marca de aspas, fonte diferente) e nunca se confunde com interpretação.

**P2 — Defeito universal não discrimina.** Um achado que aparece em quase todo regulamento é ruído com cara de sinal. Ele não some da tela — desce para um grupo recolhido, com a frequência medida ao lado.

**P2 vale no grão `(tipo, trecho)`, e NUNCA no grão `tipo`.** A medição fechou essa porta: `pegadinha:muda_resultado` aparece em 99,6% dos textos e `fuso_ausente` em 85,8%, mas o trecho que causa cada um é diferente em cada regulamento. Aplicado por tipo, P2 recolheria a seção 2 da hierarquia — o produto da tela — por ela ser frequente. O que se repete é a CATEGORIA do defeito; boilerplate é a passagem literal repetida, e é ela que desce.

**P3 — Explicação de mecanismo se escreve uma vez.** O parágrafo que explica o que é um achado herdado pertence à seção, não a cada item. Hoje ele aparece dez vezes na mesma tela.

**P4 — Diagnóstico não é operação.** A comparação lado a lado das três leituras serve para auditar o modelo, não para julgar o mercado. Recolhe.

**P5 — Continência é repetição.** Dois achados do mesmo tipo, um dos quais cita um recorte contido no do outro, são o mesmo defeito citado duas vezes. Sobreposição sem continência NÃO é: `A B C` e `B C D` se cruzam e nenhum dos dois pode representar o outro. A medição mostrou que a diferença entre os dois critérios vale 1,1 ponto de corte e o invariante inteiro — ver seção 4.

---

## 3. Medir antes de decidir

Nada abaixo entra sem número. Estas medições vêm primeiro e o resultado delas alimenta as regras das seções 4 e 5. São todas `SELECT`.

**Medido em 22/08/2026 por `npm run medir:tela-regra`** (`scripts/medicoes/tela-regra.ts`); relatório íntegro em `probes/digest/medicoes-tela-regra.md`. O script refaz em TypeScript o que a view `digest_achados_por_mercado` faz em SQL e falha se divergir em uma linha que seja — na medição desta spec, 1033 de 1033 bateram.

**O corpus envelhece rápido.** Entre a redação desta spec e a medição, os textos foram de 191 para 267 e os mercados digeridos de 728 para 1033, em três dias. Todo número aqui vem com a data, e rodar de novo é um comando.

| | na redação | medido em 22/08/2026 |
| --- | ---: | ---: |
| textos distintos | 191 | **267** |
| mercados digeridos | 728 | **1033** |
| achados na tela | 12.702 | **20.357** (6.407 acusados / 13.950 herdados) |

**M1 — Frequência de cada tipo de achado sobre textos distintos de regra.**

O denominador é o texto de regra (`description_sha256`), não o mercado. Contar por mercado inflaria os tipos que caem em textos muito propagados.

Saída esperada: para cada `tipo` de ambiguidade e de pegadinha, em que fração dos textos distintos ele aparece pelo menos uma vez.

> **Resultado.** `pegadinha:muda_resultado` 99,6%, `fuso_ausente` 85,8%, `fonte_vaga` 64,4%, `criterio_discricionario` 59,6%, `precedencia_de_fonte` 43,4%, `muda_timing` 38,2%, e daí para baixo até `limiar_de_borda` 10,5%.
>
> **Isto NÃO é a entrada do gate da seção 5**, e ler como se fosse é o erro que P2 agora proíbe explicitamente. O gate opera em `(tipo, trecho)` — ver M1b.

**M1b — Frequência de cada `(tipo, trecho)`, que é o grão que a seção 5 usa.**

Duas chaves de agrupamento, porque o boilerplate da plataforma é o mesmo texto com a data trocada.

> **Resultado, chave literal:** 2.197 pares distintos, e o mais frequente é `fuso_ausente` sobre `11:59 PM ET` em 44,9%. Nenhum par chega a 50%.
>
> **Resultado, chave com data e número mascarados:** 2.085 pares. `11:59 PM ET` 47,2%, `a consensus of credible reporting` 42,3%, a data com fuso `ET` 31,8%, e o quarto colocado despenca para 9,7%.
>
> A chave é a de `chaveDoGate` em `web/src/lib/boilerplate.ts` — a mesma que a tela usa, com a severidade FORA da categoria da pegadinha, como na dedup. O relatório e a tela não podem divergir porque não há duas implementações.

**M2 — Quantos achados são eliminados pela regra de dedup da seção 4.**

Rodar a regra sobre o conjunto atual e reportar: total antes, total depois, e a distribuição de quantos itens foram fundidos em um.

Se o corte for menor que ~15%, a regra não está pagando a complexidade e a gente reavalia.

> **Resultado.** 20.357 → 11.129, corte de **45,3%**. Três vezes os 15%: a regra paga. Fusões: 2.635 pares, 1.138 trios, 432 quartetos, 305 quintetos, e uma cauda até 17. A união sobe a contagem de leituras em 4.625 das 4.703 fusões.
>
> A medição derrubou a formulação original da regra duas vezes: primeiro a sobreposição (ver seção 4), depois a comparação por token. Continência é de **caracteres**, como a spec dizia desde o início — comparar sequências de token separa `...11:59 PM ET` de `...11:59 PM ET, the market...` por causa da vírgula colada, e sozinha essa diferença valia 11 pontos de corte.

**M3 — Distribuição de achados por mercado, separando acusado de herdado.**

Mediana, p90 e máximo. Serve para dimensionar quantos itens a seção principal aguenta antes de recolher.

> **Resultado**, sobre 1033 mercados:
>
> | corte | mediana | p90 | máximo |
> | --- | ---: | ---: | ---: |
> | total | 16 | 39 | 43 |
> | acusados | 5 | 10 | 23 |
> | herdados | 11 | 33 | 37 |
> | total após a dedup da seção 4 | 10 | 16 | 25 |
> | armadilhas acusadas (`muda_resultado`/`muda_timing`) | 3 | 6 | 13 |
>
> A última linha é a que dimensiona a seção 2 da hierarquia: o teto de 5 esconde algo em 109 mercados (10,6%), e 14 mercados (1,4%) não têm nenhuma.

**M4 — Quantos mercados têm alguma pegadinha `muda_resultado` com concordância ≥ 2/3.**

Este é o número que diz se a seção "Manchete vs regra" tem conteúdo na maioria dos mercados ou se é exceção. Se for exceção, a seção precisa de um estado vazio honesto em vez de sumir.

> **Resultado.** 880 mercados (85,2%) têm alguma; 817 (79,1%) têm alguma acusada; **807 (78,1%) têm alguma acusada com `descricao` e `cenario`** — que é a linha que decide, porque no herdado os dois são nulos por construção.
>
> Sessenta textos foram lidos uma vez só, e ali `1/1` passa em "≥ 2/3" sem ninguém ter concordado com ninguém. Restringindo a textos lidos ao menos três vezes: 734 de 950 elegíveis, 77,3%. A conclusão não muda em nenhum dos cortes.
>
> **A seção 8 é a regra, não a exceção.** Ainda assim precisa do estado vazio para os ~22% restantes.

**Reportar os quatro antes de escrever código.** Se algum deles contradisser o que está escrito aqui, a spec muda — não o número. Dois contradisseram, e as seções 4 e 5 abaixo já estão reescritas por causa disso.

---

## 4. Dedup por absorção de trecho

**Problema observado.** No mercado do Flávio Bolsonaro:

- `This market will resolve according to the margin of victory between the top two candidates`
- `This market will resolve according to the margin of victory between the top two candidates in the first round of the next Brazil Presidential Election.`

Mesmo tipo, mesmo defeito, recorte diferente. E em `fuso_ausente`, `June 30, 2027, 11:59 PM ET` (4/5) contra `11:59 PM ET` (1/5).

**Regra.** Dentro do mesmo `(mercado, texto de regra, tipo)`, um achado cujo trecho está **contido** no trecho de outro é absorvido por ele.

- Absorve o **trecho mais longo que o contém**. Sem transitividade: quem não tem container sobrevive sozinho, e um absorvido cujo container também foi absorvido sobe para o container final — que o contém, porque contém o intermediário.
- Continência é de **caracteres**, alinhada a borda de palavra, sobre o trecho normalizado como o `achado_id` da view o normaliza (espaço colapsado, caixa baixa, pontuação preservada). A borda é o que impede `et` de ser encontrado dentro de `market`.
- A contagem de leituras vira a **união** das leituras que apontaram qualquer um dos trechos fundidos. Um achado que a leitura 1 citou curto e a leitura 2 citou longo foi encontrado por duas leituras, não por uma cada.
- `origem` do fundido é `acusado` se **qualquer** um dos fundidos for acusado.
- A prosa fica a do achado com maior concordância **entre os que têm prosa**, e vai em **bloco**.

**Continência, e não sobreposição — a medição mudou esta regra.** A formulação original era "trechos que se sobrepõem", implementada como componentes conexas. Ela corta 46,4% contra 45,3% da absorção, e os 1,1 ponto a mais sai de fundir achados que ninguém consegue justificar olhando o item que sobrou.

O invariante que a regra usa como argumento — *o sobrevivente contém tudo que absorveu* — é o que dá o direito de esconder os absorvidos. Fecho transitivo não o preserva, e **trocar sobreposição por continência não conserta**: `A ⊃ B` e `C ⊃ B` com `A ⊅ C` põe os três no mesmo componente e o sobrevivente `A` não contém o `C`. Medido, isso acontece em 178 fusões com encavalamento e ainda em 129 só com continência. Com absorção, **zero, por construção**.

**A entrada é o CONJUNTO de leituras, não a contagem.** `vezes_encontrado` da view é um número, e união não se calcula com números. A aproximação `min(soma, leituras_do_texto)` acerta em 94,7% das fusões e infla a concordância nas outras, em até +3 leituras — o máximo acertaria em 1,7%. Inflar concordância por conveniência de apresentação é o que a seção 11 proíbe, então quem chama a função tem que trazer os `digest_id`. Consequência para o item 5: a tela de detalhe passa a precisar das tabelas-filhas, e não só da view.

**Prosa em bloco, e do maior entre os que têm.** São QUATRO campos e não dois — `descricao` e `cenario` são a prosa da pegadinha, `leitura_a` e `leitura_b` são a da ambiguidade e da contradição, e a view marca os quatro como "não viaja". Duas ressalvas que a medição obrigou:

- *Entre os que têm.* Em 9,6% das fusões o de maior concordância é herdado e não tem prosa nenhuma. "Fica o do maior", sem a ressalva, jogaria fora a única prosa existente e deixaria um item marcado `acusado` sem descrição.
- *Em bloco.* Descrição de uma leitura com cenário de outra é um par que ninguém escreveu, e a tela o apresentaria como se fosse. Prosa fabricada é pior que prosa ausente.

**Onde mora.** ✅ `web/src/lib/dedup.ts`, função pura e genérica sobre o tipo de quem chama, testada sem banco em `web/src/lib/dedup.test.ts`. Não é view, não é migration.

**O que o teste cobre.**

- **`A B C` e `B C D`.** Sobrepõem-se sem continência, e a regra **não os funde**. É o caso que documenta a escolha: são dois recortes que se cruzam, e nenhum dos dois contém o outro para poder representá-lo.
- **`A ⊃ B`, `C ⊃ B`, `A ⊅ C`.** Fixture do mercado `will-hassan-khomeini-be-head-of-state-in-iran-end-of-2026`, texto lido 30 vezes: `on December 31, 2026 at 12:00 PM ET` (11 leituras, acusado), `at 12:00 PM ET` (1) e `December 31, 2026 at 12:00 PM ET.` (2). Um não tem o `on`, o outro não tem o ponto final, e nenhum contém o outro. Dois sobreviventes, não um. A forma aparece **2.035 vezes em 217 mercados** — não é caso de laboratório.
- **O invariante, verificado e não assumido.** Para todo absorvido, algum sobrevivente contém o trecho dele literalmente.
- **Determinismo.** Seis permutações da mesma entrada dão a mesma saída. Empate de comprimento resolve pelo trecho normalizado, que não depende da ordem em que o banco devolveu as linhas.

**Verificado por mutação, nos três eixos** (`22 testes`; cada mutação foi aplicada ao arquivo real e os testes rodados):

| eixo | testes derrubados | os que morderam |
| --- | ---: | --- |
| igualdade exata em vez de continência | 10 | `funde trechos que se contêm sem serem iguais` |
| máximo em vez de união | 3 | `a contagem de leituras do fundido é a UNIÃO` |
| componentes conexos em vez de absorção | 5 | `dois containers do mesmo trecho continuam dois achados`, `o sobrevivente contém literalmente todo trecho que absorveu` |

Igualdade exata corta **0%** — o `achado_id` da view já colapsou os trechos idênticos normalizados —, então esse eixo mede exatamente o que a regra acrescenta.

O terceiro eixo é o que impede alguém trocar isto por union-find daqui a seis meses. A primeira mutação que escrevi para ele não derrubou teste nenhum, e o defeito era a mutação e não o teste: no array ordenado do mais longo para o mais curto, o ramo que ela acrescentava nunca disparava. A mutação que vale é union-find de verdade sobre a continência tratada como aresta não direcionada.

---

## 5. Gate de boilerplate

**Problema observado.** `fonte_vaga` sobre "consensus of credible reporting" e `fuso_ausente` sobre "11:59 PM ET" aparecem em praticamente todo regulamento da Polymarket. São texto padrão da plataforma, não característica deste mercado.

**Regra.** Um `(tipo, trecho)` cuja frequência em M1b passar do limiar entra no grupo recolhido **"comum a quase todos os regulamentos"**, com a frequência exibida.

**A chave de agrupamento mascara data e número; o trecho exibido nunca.** `December 31, 2026, 11:59 PM ET` e `June 30, 2027, 11:59 PM ET` são a mesma omissão de fuso e apareceriam como dois achados raros se a chave fosse o trecho literal. A máscara existe só para juntá-los na contagem.

Ela **não** vale para o trecho na tela, que é sempre o literal (P1), nem para a dedup da seção 4, que também opera sobre o literal — mascarar ali fundiria dois prazos DIFERENTES do mesmo regulamento num achado só, que é falsificar a regra em vez de limpá-la.

**O limiar é 20%, e o número saiu do vale medido.** ✅ `LIMIAR_BOILERPLATE` em `web/src/lib/boilerplate.ts`, com o motivo, a data e o comando que refaz a conta. A intuição de 80% escrita aqui antes estava errada por uma ordem de grandeza: **nenhum par chega a 50%**, e um limiar de 80% recolheria zero itens — o gate não faria nada.

O que a distribuição da chave mascarada mostra, em 267 textos:

| fração | pares |
| --- | ---: |
| 47,2% | 1 — `fuso_ausente` sobre `11:59 PM ET` |
| 42,3% | 1 — `fonte_vaga` sobre `a consensus of credible reporting` |
| 31,8% | 1 — `fuso_ausente` sobre a data com fuso `ET` |
| — | **nada entre 9,7% e 31,8%** |
| ≤ 9,7% | os outros 2.124 |

O vale tem 22,1 pontos de largura e é o maior salto da cauda alta. **20% cai praticamente no meio dele** — 10,3 pontos de folga para baixo, 11,8 para cima —, e é isso que o código tem que dizer ao lado da constante, junto com a data da medição e o comando que a refaz.

Efeito medido a 20%: 3 pares recolhidos, 1.505 dos 20.357 achados em tela (7,4%), atingindo 777 dos 1033 mercados (75,2%).

**A frequência é consultada, nunca congelada.** Uma agregação sobre as tabelas de digestão, uma vez no carregamento da tela, cacheada em memória pela sessão. Congelar o número em código seria mentir dentro de três dias: o corpus foi de 191 para 267 textos nesse prazo, e um limiar aplicado sobre frequência velha recolhe a coisa errada em silêncio.

**O número aparece sempre com o denominador:** `aparece em 47% dos 267 regulamentos lidos`. Sem o denominador, uma fração é opinião.

**O que o grupo recolhido mostra quando aberto:** o achado, o trecho literal, e a frequência. Essa frequência é informação real e transforma ruído em contexto: quem opera passa a saber que aquilo é padrão da casa, não peculiaridade do mercado.

**Limite conhecido, documentado e não corrigido: a máscara normaliza o miolo, não o recorte.** Ela troca número e mês, e nada mais. Duas leituras que citam a MESMA omissão com recortes diferentes ficam em pares diferentes, porque a palavra a mais entra na chave.

Medido: `by December 31, 2026, 11:59 PM ET` parou em **9,7%** e ficou de fora do gate, enquanto as outras variantes de data colapsaram em 31,8% e entraram. A diferença é o `by`.

Está escrito no comentário de `mascararParaGate` e travado por teste. O motivo de travar em vez de consertar: sem isso, alguém olha aquele 9,7% no relatório daqui a seis meses e acha que descobriu um tipo novo de defeito. Consertar exigiria ancorar o trecho por posição no regulamento — outra decisão, outro custo.

**O que este gate NÃO faz.** Não apaga nada, não altera contagem, não muda o banco. É apresentação.

**Verificado por mutação em cinco eixos** (17 testes):

| eixo | testes derrubados |
| --- | ---: |
| denominador = só os textos com achado | 5 |
| contar linhas em vez de textos distintos | 1 |
| máscara desligada na chave | 3 |
| máscara vazando para o trecho exibido | 2 |
| limiar de volta aos 80% chutados | 2 |

---

## 6. Achados herdados

**Problema observado.** O parágrafo "Herdado de um mercado com o mesmo texto de regra. A descrição e o cenário são nulos aqui porque não houve leitura deste mercado." aparece uma vez por item — dez vezes na mesma tela no caso do Bolsonaro.

**Regra.**

- A explicação do mecanismo aparece **uma vez**, no cabeçalho da seção (P3).
- Cada item herdado leva apenas um selo curto.
- Herdados entram **recolhidos por padrão**, num bloco: *"N achados herdados de outros mercados com o mesmo texto de regra"*.
- Herdado nunca aparece acima de acusado na ordenação. Um achado sem descrição e sem cenário é o menos acionável da tela.

**A chave é `origem`, e NUNCA "ausência de prosa".** A frase acima — *um achado sem descrição e sem cenário é o menos acionável da tela* — é a JUSTIFICATIVA do recolhimento, e é justamente por isso que ela faz "não tem prosa" parecer a chave certa. Não é. Prosa ausente é proxy; `origem` é fato: é o que a view registra, e é o que o cabeçalho do bloco afirma ao dizer *"herdados de outros mercados com o mesmo texto de regra"*. Um acusado sucinto foi lido NESTE mercado, e recolhê-lo por ser sucinto tornaria o cabeçalho falso sobre ele.

Pelo mesmo motivo só `herdado` recolhe, e qualquer outro valor de `origem` fica visível. `tipos.ts` é escrito à mão, então um valor novo no banco chega até aqui sem quebrar a compilação — recolhê-lo afirmaria uma procedência que ninguém verificou. É o caminho que `separarBoilerplate` já toma quando não tem frequência: na dúvida, o achado aparece.

**O N do cabeçalho é o do bloco, nunca `ContagemDigest.achados_herdados`.** Aquele contador é de linhas da view, anterior à dedup da seção 4: quatro linhas herdadas que a absorção funde em duas anunciariam 4 e abririam em 2. É a mesma divergência que o `caa73b9` foi consertar.

**O que continua valendo e não muda:** `leitura_a` e `leitura_b` seguem nulos no herdado. Copiar a leitura do vizinho faria propagação parecer detecção — isso é decisão de projeto e não está em discussão.

**Onde mora.** ✅ `web/src/lib/herdados.ts`, função pura e genérica sobre o tipo de quem chama, testada sem banco em `web/src/lib/herdados.test.ts`. Ela lê UM campo — `origem` — e devolve os dois grupos. A ordem dentro de cada um é a da entrada, porque quem ordena é a seção 7: ordenar aqui reporia a ordenação que o item existe para tirar.

**O que o teste cobre.**

- **O herdado forte abaixo do acusado fraco.** 11/30 herdado contra 2/30 acusado — a forma que a ordenação por concordância inverte, e que é o que a tela faz hoje em `Regra.tsx:113`.
- **Soma.** Os dois grupos somam a entrada, sempre. Recolher não é apagar (seção 11).
- **Um acusado sem prosa continua no grupo principal**, e uma `origem` que o tipo não previu fica visível.
- **Composição com a seção 4, e não mock dela.** Quatro linhas herdadas que a absorção funde em duas dão N = 2; e nada que chega ao bloco carrega prosa, que é a justificativa inteira de recolhê-lo.

**Verificado por mutação, nos três eixos** (11 testes; cada mutação foi aplicada ao arquivo real e os testes rodados):

| eixo | testes derrubados | os que morderam |
| --- | ---: | --- |
| não separar — o estado de hoje | 6 | `o herdado mais confirmado fica abaixo do acusado menos confirmado` |
| descartar em vez de recolher | 7 | `nada é apagado: os dois grupos somam a entrada` |
| separar por prosa ausente em vez de por origem | 4 | `um acusado sem prosa continua no grupo principal`, `origem que o tipo não previu fica VISÍVEL` |

O terceiro eixo é o que importa aqui, e é o único cuja mutação alguém escreveria de boa-fé — lendo a justificativa do recolhimento como se fosse a regra dele.

**O componente não entrou.** O bloco recolhido, o selo curto por item e o parágrafo único no cabeçalho são componente, e caem no item 5 junto com a hierarquia, porque é ali que o desenho se decide. O critério 4 da seção 12 segue aberto: `Regra.tsx` ainda repete o parágrafo uma vez por item.

**Pendência aberta, para o item 5: contradições herdadas.** Elas carregam uma SEGUNDA cópia do parágrafo de mecanismo, em `Contradicao_`, e hoje vivem na seção de Contradições — não na lista que esta separação alimenta. Dois desfechos, e os dois custam:

- elas descem para o bloco recolhido, e aí o estado vazio de Contradições precisa parar de dizer *"nenhuma contradição apontada neste texto"* enquanto algumas estão recolhidas logo abaixo; ou
- aquela seção ganha cabeçalho próprio, e a explicação passa a aparecer duas vezes na tela — que é o que o critério 4 proíbe em letra.

É decisão de desenho, e fica para o item 5.

---

## 7. Hierarquia das seções

Ordem nova, de cima para baixo:

**1. Manchete vs regra.** Ver seção 8.

**2. Armadilhas que mudam o resultado.** Só `muda_resultado` e `muda_timing`, só acusados, ordenadas por concordância decrescente. Teto de 5 itens visíveis; o resto recolhe em "ver mais N". Cada item mostra: trecho citado (P1), descrição, cenário, selo de concordância.

O teto de 5 está calibrado: M3 mediu mediana 3 e p90 6, e o "ver mais N" aparece em 109 dos 1033 mercados (10,6%).

**3. Contradições internas.** Sobem para cá se existirem — hoje estão no topo, e o motivo de descer é que uma contradição sem contexto de manchete não diz ao operador o que fazer. Mantêm as duas passagens e as duas leituras.

**4. A regra, lida.** A leitura estruturada como está hoje. Sem mudança de conteúdo.

**5. Recolhidos, nesta ordem:**
   - ambiguidades comuns a quase todos os regulamentos (seção 5)
   - achados herdados (seção 6)
   - as leituras lado a lado (P4)
   - o regulamento cru

**Estado vazio importa.** Um mercado com regra lida e nenhuma armadilha encontrada precisa dizer isso — *"3 leituras, nenhuma armadilha que mude o resultado"* — e não simplesmente não mostrar a seção. "Lido e limpo" é informação diferente de "não lido", e essa distinção já existe no `somaDigest` retornando `null` em vez de `0`. A tela tem que honrar isso.

São 14 mercados em 1033 (1,4%). Raro não é motivo para não escrever: é justamente no caso raro que a tela ausente vira "o sistema não leu isto" na cabeça de quem opera.

---

## 8. Manchete vs regra

**O que é.** Uma ou duas frases no topo, dizendo o que o título faz um leitor acreditar e o que a regra de fato exige.

Exemplo construído a partir de dado real, do mercado do urânio iraniano:

> O título diz "entregar o estoque até 31/08/2026". A regra exige apenas o **acordo público** até essa data — a entrega física pode ocorrer em 2027, e **qualquer fração** do estoque conta.

**De onde sai.** Não precisa de geração nova. `descricao` e `cenario` da pegadinha `muda_resultado` de maior concordância já contêm isso. É seleção e apresentação.

**M4 respondeu: a seção tem conteúdo em 78,1% dos mercados** (807 de 1033, com pegadinha `muda_resultado` acusada em ≥ 2/3 das leituras e com `descricao` e `cenario` preenchidos). Não é exceção — mas os ~22% restantes precisam do estado vazio da seção 7 do mesmo jeito.

**A amostra de 20 sustenta a apresentação a partir de `descricao`.** A prosa já vem quase toda no formato exato da seção — *"quem leu só o título espera SIM, mas a regra dá NÃO"*. Exemplo real, do mercado do Ballon d'Or:

> Se a cerimônia do Ballon d'Or 2026 for adiada ou o vencedor não for anunciado até 31/12/2026, quem leu só o título espera que o mercado resolva SIM ou NÃO depois, mas a regra resolve 'Other'.

**Campo novo no prompt v5 fica fora.** Era a alternativa caso a prosa não se sustentasse; ela se sustenta, e a decisão seria de digestão e não de tela de qualquer forma. A amostra íntegra está em `probes/digest/medicoes-tela-regra.md`.

---

## 9. Idioma

**São três camadas com regras diferentes.** A tela hoje mistura as três sem sinalizar, e é isso que parece bagunça.

| Camada | Exemplo | Regra |
| --- | --- | --- |
| Evidência | `trecho`, regulamento cru | **Nunca traduz** (P1) |
| Leitura gerada | "Resolve SIM se...", descrição, cenário | Traduzível, com custo |
| Cromo | rótulos, `pegadinha`, `fonte_vaga` | Dicionário, custo zero |

**O botão de idioma faz duas coisas de custo muito diferente.** O cromo troca na hora. A leitura precisa existir no outro idioma.

**A forma barata: traduzir por hash, não por mercado.** 267 textos distintos cobrem 1033 mercados (22/08/2026, `npm run medir:tela-regra`) — quase quatro mercados por texto. Cache indexado por `(description_sha256, idioma)` — mesma ideia da propagação que já existe: o trabalho pertence ao texto, não ao mercado.

**Nesta branch, só o cromo.** Um dicionário `pt`/`en` para rótulos e nomes de tipo, com o idioma em estado da tela. Zero custo, zero chamada de modelo, e já resolve a maior parte da sensação de mistura — porque a evidência **deve** ficar em inglês e a tela vai passar a dizer isso em vez de parecer descuido.

**A tradução das leituras é branch própria**, com a tabela de cache, e só depois de decidido se vale o gasto.

---

## 10. Fora do escopo, registrado

**Campos estruturados no prompt (v5).** A v4 é inconsistente no campo `prazo`: num mercado escreveu `31 de agosto de 2026, 23:59 ET`, no outro `June 30, 2027, 11:59 PM ET`. Isso não é problema de tela — é campo de texto livre onde devia ser valor estruturado. Data em ISO, fonte em enum, e a tela formata em qualquer idioma sem traduzir nada. **Vira issue.**

**As 21 chamadas com digest nulo** (6,6% da rodada de 320) estão classificadas. **A rodada é a do degrau 3, prompt `v4`, `deepseek-v4-flash`, em 22/08/2026 ~05:39 UTC** — o número tinha sido registrado aqui sem data, e datá-lo depois custou o mtime de `probes/digest/degrau-3-v4.{md,json}` mais o intervalo entre os commits `1fe47dd` (05:09) e `40b2b65` (06:04). A corrida agora carimba a própria data no cabeçalho do relatório, para a próxima não precisar disso.

Refazível por **`npm run medir:digest-nulo`**; relatório em `probes/digest/digest-nulo.md`.

Nenhuma das três causas que esta seção supunha é a que domina. **Trava de opinião: 17 de 21** — e dentro dela, 12 são vocabulário que a própria REGRA fornece (a boilerplate "prospective, contingent, probable or conditional statements do not count" derruba 8 mercados sozinha, todos com o mesmo texto byte a byte) e 5 são hedge do modelo sobre a própria leitura. **Transporte: 3 de 21** (`api_error`, `not_json`). **Enum inventado: 1 de 21.** **Recusa do modelo: 0** — o código `refusal` existe e não disparou. **Falha de validação verbatim: 0 por construção** — a conferência do `trecho` poda o item e soma em `descartes`, nunca lança, então não pode produzir digest nulo.

Respostas, uma por causa, no relatório. Duas são "aceitar, e por quê": o hedge (1,6% das chamadas, preço que o comentário de `OPINIAO` já tinha escolhido pagar) e o enum (0,3%). **Sobra uma issue:** estreitar `detectarOpiniao` para não recusar por causa do texto que ela está extraindo.

**`readMarketsToDigest` sem filtro de status** — US$ 0,22 dos US$ 1,08 desta rodada foram gastos lendo regra de mercado já resolvido, 20% do custo, crescendo sem teto. **Já na lista de issues.**

---

## 11. O que NÃO fazer

- Não traduzir `trecho` nem regulamento cru, em nenhuma hipótese, nem com aviso.
- Não apagar achado nenhum. Tudo que sai da vista principal continua acessível.
- Não alterar contagem de leituras por motivo de apresentação. A única mudança de contagem autorizada é a união na fusão da seção 4, e ela é sobre o mesmo defeito.
- Não escrever no banco. Sem migration, sem view nova — tudo isto é leitura e apresentação.
- Não instalar dependência. Se algum item exigir, parar e perguntar.
- Não criar teste que não morde. Se não der para escrever vermelho sem banco, dizer isso e seguir sem — como no `f1ff37c`.

---

## 12. Critérios de aceite

1. Os quatro números de M1–M4 estão reportados **antes** do primeiro commit de implementação. ✅ 22/08/2026, `probes/digest/medicoes-tela-regra.md`.
2. ✅ A regra de dedup é função pura, com teste que morde, verificado por mutação em três eixos: igualdade em vez de continência (10 testes), máximo em vez de união (3), componentes conexas em vez de absorção (5).
3. ✅ O limiar de boilerplate está escrito no código com o número medido, a data da medição, o comando que a refaz e o motivo do corte — o vale de 9,7% a 31,8%.
4. O parágrafo explicativo do herdado aparece exatamente uma vez na tela. **Aberto** — a separação existe (`separarHerdados`), o componente não. Ver a pendência das contradições herdadas na seção 6.
5. A tela distingue visualmente citação de interpretação, e um leitor consegue dizer qual é qual sem legenda.
6. O dicionário de idioma cobre 100% do cromo. Nenhum rótulo fixo em português sobrou no JSX.
7. Um mercado lido sem armadilhas mostra "lido e limpo", não uma seção ausente.
8. `npm ci && npm test` passa em clone limpo sob `/tmp`.

---

## 13. Ordem de execução

Um commit por item, árvore limpa entre eles, mensagem de commit escrita para o dono executar.

1. ✅ Medições M1–M4, reportadas em 22/08/2026. O script virou `scripts/medicoes/tela-regra.ts` e o relatório `probes/digest/medicoes-tela-regra.md`: medição que não se repete vale metade.
2. ✅ Dedup por absorção (seção 4) — `web/src/lib/dedup.ts`.
3. ✅ Gate de boilerplate (seção 5) — `web/src/lib/boilerplate.ts`.
4. ✅ Herdados recolhidos (seção 6) — `web/src/lib/herdados.ts`. A separação é a função, e é ela que garante que herdado não ordena acima de acusado. O bloco recolhido, o selo curto e a explicação única são componente, e vão junto com o item 5.
5. Reordenação das seções + estados vazios (seção 7).
6. Manchete vs regra (seção 8).
7. Dicionário de idioma, só cromo (seção 9).

Os itens 2 a 4 reduzem ruído e podem ser avaliados isoladamente na tela. Os itens 5 e 6 mudam a leitura da página e valem screenshot antes/depois. O 7 é mecânico.

**Antes do item 5, parar.** É ali que layout começa a importar, e é ali que faz sentido comparar alternativas de desenho em vez de escrever a primeira que vier à cabeça.
