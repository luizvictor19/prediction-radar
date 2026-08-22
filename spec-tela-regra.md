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

**P5 — Sobreposição é repetição.** Dois achados do mesmo tipo cujos trechos se sobrepõem são o mesmo defeito citado com recorte diferente.

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
> **Resultado, chave com data e número mascarados:** 2.127 pares. `11:59 PM ET` 47,2%, `a consensus of credible reporting` 42,3%, `<mes> #, #, ##:## PM ET` 31,8%, e o quarto colocado despenca para 9,7%.

**M2 — Quantos achados são eliminados pela regra de dedup da seção 4.**

Rodar a regra sobre o conjunto atual e reportar: total antes, total depois, e a distribuição de quantos itens foram fundidos em um.

Se o corte for menor que ~15%, a regra não está pagando a complexidade e a gente reavalia.

> **Resultado.** 20.357 → 13.475, corte de **33,8%**. Bem acima dos 15%: a regra paga. Fusões: 2.634 pares, 761 trios, 358 quartetos, 218 quintetos, 6 de sete e 62 de treze. A união sobe a contagem de leituras em 4.026 das 4.039 fusões.
>
> A medição também derrubou a formulação original da regra. Ver seção 4.

**M3 — Distribuição de achados por mercado, separando acusado de herdado.**

Mediana, p90 e máximo. Serve para dimensionar quantos itens a seção principal aguenta antes de recolher.

> **Resultado**, sobre 1033 mercados:
>
> | corte | mediana | p90 | máximo |
> | --- | ---: | ---: | ---: |
> | total | 16 | 39 | 43 |
> | acusados | 5 | 10 | 23 |
> | herdados | 11 | 33 | 37 |
> | total após a dedup da seção 4 | 12 | 21 | 28 |
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

## 4. Dedup por sobreposição de trecho

**Problema observado.** No mercado do Flávio Bolsonaro:

- `This market will resolve according to the margin of victory between the top two candidates`
- `This market will resolve according to the margin of victory between the top two candidates in the first round of the next Brazil Presidential Election.`

Mesmo tipo, mesmo defeito, recorte diferente. E em `fuso_ausente`, `June 30, 2027, 11:59 PM ET` (4/5) contra `11:59 PM ET` (1/5).

**Regra.** Dentro do mesmo `(mercado, texto de regra, tipo)`, um achado cujo trecho está **contido** no trecho de outro é absorvido por ele.

- Absorve o **trecho mais longo que o contém**. Sem transitividade: quem não tem container sobrevive sozinho, e um absorvido cujo container também foi absorvido sobe para o container final — que o contém, porque contém o intermediário.
- A contagem de leituras vira a **união** das leituras que apontaram qualquer um dos trechos fundidos. Um achado que a leitura 1 citou curto e a leitura 2 citou longo foi encontrado por duas leituras, não por uma cada.
- `origem` do fundido é `acusado` se **qualquer** um dos fundidos for acusado.
- Descrição e cenário: fica o do achado com maior concordância; empate resolve pelo trecho mais longo.

**Continência, e não sobreposição — a medição mudou esta regra.** A formulação original era "trechos que se sobrepõem", implementada como componentes conexas. Ela corta 36,0% contra 33,8% da continência, e os 2,2 pontos a mais saem de fundir achados que ninguém consegue justificar olhando o item que sobrou.

O invariante que a regra usa como argumento — *o sobrevivente contém tudo que absorveu* — é o que dá o direito de esconder os absorvidos. Fecho transitivo não o preserva, e **trocar sobreposição por continência não conserta**: `A ⊃ B` e `C ⊃ B` com `A ⊅ C` põe os três no mesmo componente e o sobrevivente `A` não contém o `C`. Medido, isso acontece em 410 fusões com sobreposição e ainda em 340 só com continência. Com absorção, **zero, por construção**.

**Onde mora.** Função pura em `web/src/lib/`, testável sem banco, com fixture construído a partir de um caso real observado (o do Bolsonaro serve). Não é view, não é migration.

**O que o teste precisa cobrir.**

- **`A B C` e `B C D`.** Sobrepõem-se sem continência, e a regra **não os funde**. É o caso que documenta a escolha: são dois recortes que se cruzam, e nenhum dos dois contém o outro para poder representá-lo.
- **`A ⊃ B`, `C ⊃ B`, `A ⊅ C`.** Três achados, dois sobreviventes: `B` vai para o mais longo entre `A` e `C`, e o outro fica em pé. O teste tem que provar que o resultado não é um grupo só. Medido, 2.667 absorvidos tinham mais de um container possível — não é caso de laboratório.
- **Determinismo.** Mesma entrada, mesma saída, sempre. Empate de comprimento resolve pelo trecho normalizado, que não depende da ordem em que o banco devolveu as linhas.

**Verificar por mutação.** Trocar continência por igualdade exata tem que derrubar teste — e note que igualdade exata corta **0%**, porque o `achado_id` da view já colapsou os trechos idênticos normalizados. Trocar união por máximo na contagem de leituras tem que derrubar teste. Trocar absorção por componentes conexas tem que derrubar teste.

---

## 5. Gate de boilerplate

**Problema observado.** `fonte_vaga` sobre "consensus of credible reporting" e `fuso_ausente` sobre "11:59 PM ET" aparecem em praticamente todo regulamento da Polymarket. São texto padrão da plataforma, não característica deste mercado.

**Regra.** Um `(tipo, trecho)` cuja frequência em M1b passar do limiar entra no grupo recolhido **"comum a quase todos os regulamentos"**, com a frequência exibida.

**A chave de agrupamento mascara data e número; o trecho exibido nunca.** `December 31, 2026, 11:59 PM ET` e `June 30, 2027, 11:59 PM ET` são a mesma omissão de fuso e apareceriam como dois achados raros se a chave fosse o trecho literal. A máscara existe só para juntá-los na contagem.

Ela **não** vale para o trecho na tela, que é sempre o literal (P1), nem para a dedup da seção 4, que também opera sobre o literal — mascarar ali fundiria dois prazos DIFERENTES do mesmo regulamento num achado só, que é falsificar a regra em vez de limpá-la.

**O limiar é 20%, e o número saiu do vale medido.** A intuição de 80% escrita aqui antes estava errada por uma ordem de grandeza: **nenhum par chega a 50%**, e um limiar de 80% recolheria zero itens — o gate não faria nada.

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

**O que este gate NÃO faz.** Não apaga nada, não altera contagem, não muda o banco. É apresentação.

---

## 6. Achados herdados

**Problema observado.** O parágrafo "Herdado de um mercado com o mesmo texto de regra. A descrição e o cenário são nulos aqui porque não houve leitura deste mercado." aparece uma vez por item — dez vezes na mesma tela no caso do Bolsonaro.

**Regra.**

- A explicação do mecanismo aparece **uma vez**, no cabeçalho da seção (P3).
- Cada item herdado leva apenas um selo curto.
- Herdados entram **recolhidos por padrão**, num bloco: *"N achados herdados de outros mercados com o mesmo texto de regra"*.
- Herdado nunca aparece acima de acusado na ordenação. Um achado sem descrição e sem cenário é o menos acionável da tela.

**O que continua valendo e não muda:** `leitura_a` e `leitura_b` seguem nulos no herdado. Copiar a leitura do vizinho faria propagação parecer detecção — isso é decisão de projeto e não está em discussão.

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

**As 21 chamadas com digest nulo** (6,6% da rodada de 320) não foram explicadas. Abrir o relatório e classificar: recusa do modelo, falha de validação verbatim, ou erro de rede. Cada uma pede resposta diferente. **Vira issue.**

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
2. A regra de dedup é função pura, com teste que morde, verificado por mutação em três eixos: igualdade em vez de continência; máximo em vez de união; componentes conexas em vez de absorção.
3. O limiar de boilerplate está escrito no código com o número medido, a data da medição, o comando que a refaz e o motivo do corte — o vale de 9,7% a 31,8%.
4. O parágrafo explicativo do herdado aparece exatamente uma vez na tela.
5. A tela distingue visualmente citação de interpretação, e um leitor consegue dizer qual é qual sem legenda.
6. O dicionário de idioma cobre 100% do cromo. Nenhum rótulo fixo em português sobrou no JSX.
7. Um mercado lido sem armadilhas mostra "lido e limpo", não uma seção ausente.
8. `npm ci && npm test` passa em clone limpo sob `/tmp`.

---

## 13. Ordem de execução

Um commit por item, árvore limpa entre eles, mensagem de commit escrita para o dono executar.

1. ✅ Medições M1–M4, reportadas em 22/08/2026. O script virou `scripts/medicoes/tela-regra.ts` e o relatório `probes/digest/medicoes-tela-regra.md`: medição que não se repete vale metade.
2. Dedup por sobreposição (seção 4).
3. Gate de boilerplate (seção 5).
4. Herdados recolhidos + explicação única (seção 6).
5. Reordenação das seções + estados vazios (seção 7).
6. Manchete vs regra (seção 8).
7. Dicionário de idioma, só cromo (seção 9).

Os itens 2 a 4 reduzem ruído e podem ser avaliados isoladamente na tela. Os itens 5 e 6 mudam a leitura da página e valem screenshot antes/depois. O 7 é mecânico.

**Antes do item 5, parar.** É ali que layout começa a importar, e é ali que faz sentido comparar alternativas de desenho em vez de escrever a primeira que vier à cabeça.
