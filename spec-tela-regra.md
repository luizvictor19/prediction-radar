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

**P3 — Explicação de mecanismo se escreve uma vez.** O parágrafo que explica o que é um achado herdado pertence à seção, não a cada item. Hoje ele aparece dez vezes na mesma tela.

**P4 — Diagnóstico não é operação.** A comparação lado a lado das três leituras serve para auditar o modelo, não para julgar o mercado. Recolhe.

**P5 — Sobreposição é repetição.** Dois achados do mesmo tipo cujos trechos se sobrepõem são o mesmo defeito citado com recorte diferente.

---

## 3. Medir antes de decidir

Nada abaixo entra sem número. Estas medições vêm primeiro e o resultado delas alimenta as regras das seções 4 e 5. São todas `SELECT`.

**M1 — Frequência de cada tipo de achado sobre textos distintos de regra.**

O denominador é o texto de regra (`description_sha256`), não o mercado. Contar por mercado inflaria os tipos que caem em textos muito propagados.

Saída esperada: para cada `tipo` de ambiguidade e de pegadinha, em que fração dos textos distintos ele aparece pelo menos uma vez.

**M2 — Quantos achados são eliminados pela regra de dedup da seção 4.**

Rodar a regra sobre o conjunto atual e reportar: total antes, total depois, e a distribuição de quantos itens foram fundidos em um.

Se o corte for menor que ~15%, a regra não está pagando a complexidade e a gente reavalia.

**M3 — Distribuição de achados por mercado, separando acusado de herdado.**

Mediana, p90 e máximo. Serve para dimensionar quantos itens a seção principal aguenta antes de recolher.

**M4 — Quantos mercados têm alguma pegadinha `muda_resultado` com concordância ≥ 2/3.**

Este é o número que diz se a seção "Manchete vs regra" tem conteúdo na maioria dos mercados ou se é exceção. Se for exceção, a seção precisa de um estado vazio honesto em vez de sumir.

**Reportar os quatro antes de escrever código.** Se algum deles contradisser o que está escrito aqui, a spec muda — não o número.

---

## 4. Dedup por sobreposição de trecho

**Problema observado.** No mercado do Flávio Bolsonaro:

- `This market will resolve according to the margin of victory between the top two candidates`
- `This market will resolve according to the margin of victory between the top two candidates in the first round of the next Brazil Presidential Election.`

Mesmo tipo, mesmo defeito, recorte diferente. E em `fuso_ausente`, `June 30, 2027, 11:59 PM ET` (4/5) contra `11:59 PM ET` (1/5).

**Regra.** Dentro do mesmo `(mercado, texto de regra, tipo)`, dois achados cujos trechos se sobrepõem em caracteres são um achado só.

- Sobrevive o **trecho mais longo** — ele contém o outro e dá mais contexto ao humano.
- A contagem de leituras vira a **união** das leituras que apontaram qualquer um dos trechos fundidos. Um achado que a leitura 1 citou curto e a leitura 2 citou longo foi encontrado por duas leituras, não por uma cada.
- `origem` do fundido é `acusado` se **qualquer** um dos fundidos for acusado.
- Descrição e cenário: fica o do achado com maior concordância; empate resolve pelo trecho mais longo.

**Onde mora.** Função pura em `web/src/lib/`, testável sem banco, com fixture construído a partir de um caso real observado (o do Bolsonaro serve). Não é view, não é migration.

**Cuidado que o teste precisa cobrir.** Sobreposição não é continência. `A B C` e `B C D` se sobrepõem sem que um contenha o outro — nesse caso sobrevive o mais longo, e se tiverem o mesmo tamanho, o primeiro em ordem de aparição no regulamento. A regra tem que ser determinística: mesma entrada, mesma saída, sempre.

**Verificar por mutação.** Trocar sobreposição por igualdade exata tem que derrubar teste. Trocar união por máximo na contagem de leituras tem que derrubar teste.

---

## 5. Gate de boilerplate

**Problema observado.** `fonte_vaga` sobre "consensus of credible reporting" e `fuso_ausente` sobre "11:59 PM ET" aparecem em praticamente todo regulamento da Polymarket. São texto padrão da plataforma, não característica deste mercado.

**Regra.** Um `(tipo, trecho normalizado)` cuja frequência em M1 passar do limiar entra no grupo recolhido **"comum a quase todos os regulamentos"**, com a frequência exibida.

**O limiar sai de M1, não daqui.** A intuição é algo em torno de 80%, mas se a distribuição for bimodal — um punhado de tipos acima de 90% e o resto abaixo de 30% — o corte vai no vale, e o número escolhido fica escrito no código com o motivo.

**O que o grupo recolhido mostra quando aberto:** o achado, o trecho, e a frequência (`aparece em 94% dos 191 regulamentos lidos`). Essa frequência é informação real e transforma ruído em contexto: quem opera passa a saber que aquilo é padrão da casa, não peculiaridade do mercado.

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

**3. Contradições internas.** Sobem para cá se existirem — hoje estão no topo, e o motivo de descer é que uma contradição sem contexto de manchete não diz ao operador o que fazer. Mantêm as duas passagens e as duas leituras.

**4. A regra, lida.** A leitura estruturada como está hoje. Sem mudança de conteúdo.

**5. Recolhidos, nesta ordem:**
   - ambiguidades comuns a quase todos os regulamentos (seção 5)
   - achados herdados (seção 6)
   - as leituras lado a lado (P4)
   - o regulamento cru

**Estado vazio importa.** Um mercado com regra lida e nenhuma armadilha encontrada precisa dizer isso — *"3 leituras, nenhuma armadilha que mude o resultado"* — e não simplesmente não mostrar a seção. "Lido e limpo" é informação diferente de "não lido", e essa distinção já existe no `somaDigest` retornando `null` em vez de `0`. A tela tem que honrar isso.

---

## 8. Manchete vs regra

**O que é.** Uma ou duas frases no topo, dizendo o que o título faz um leitor acreditar e o que a regra de fato exige.

Exemplo construído a partir de dado real, do mercado do urânio iraniano:

> O título diz "entregar o estoque até 31/08/2026". A regra exige apenas o **acordo público** até essa data — a entrega física pode ocorrer em 2027, e **qualquer fração** do estoque conta.

**De onde sai.** Não precisa de geração nova. `descricao` e `cenario` da pegadinha `muda_resultado` de maior concordância já contêm isso. É seleção e apresentação.

**Se M4 mostrar que a maioria dos mercados não tem pegadinha `muda_resultado` ≥ 2/3**, esta seção vira condicional e o estado vazio é o da seção 7.

**Se a apresentação a partir de `descricao` ficar ruim na maioria dos casos**, a alternativa é um campo novo no prompt v5 — mas isso é decisão de digestão, não de tela, e não entra nesta branch. Medir primeiro: pegar 20 mercados e olhar se a descrição de maior concordância se sustenta sozinha como manchete-vs-regra.

---

## 9. Idioma

**São três camadas com regras diferentes.** A tela hoje mistura as três sem sinalizar, e é isso que parece bagunça.

| Camada | Exemplo | Regra |
| --- | --- | --- |
| Evidência | `trecho`, regulamento cru | **Nunca traduz** (P1) |
| Leitura gerada | "Resolve SIM se...", descrição, cenário | Traduzível, com custo |
| Cromo | rótulos, `pegadinha`, `fonte_vaga` | Dicionário, custo zero |

**O botão de idioma faz duas coisas de custo muito diferente.** O cromo troca na hora. A leitura precisa existir no outro idioma.

**A forma barata: traduzir por hash, não por mercado.** 191 textos distintos cobrem 728 mercados. Cache indexado por `(description_sha256, idioma)` — mesma ideia da propagação que já existe: o trabalho pertence ao texto, não ao mercado.

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

1. Os quatro números de M1–M4 estão reportados **antes** do primeiro commit de implementação.
2. A regra de dedup é função pura, com teste que morde, verificado por mutação em pelo menos dois eixos (igualdade em vez de sobreposição; máximo em vez de união).
3. O limiar de boilerplate está escrito no código com o número medido e o motivo do corte.
4. O parágrafo explicativo do herdado aparece exatamente uma vez na tela.
5. A tela distingue visualmente citação de interpretação, e um leitor consegue dizer qual é qual sem legenda.
6. O dicionário de idioma cobre 100% do cromo. Nenhum rótulo fixo em português sobrou no JSX.
7. Um mercado lido sem armadilhas mostra "lido e limpo", não uma seção ausente.
8. `npm ci && npm test` passa em clone limpo sob `/tmp`.

---

## 13. Ordem de execução

Um commit por item, árvore limpa entre eles, mensagem de commit escrita para o dono executar.

1. Medições M1–M4, reportadas. Sem commit — é leitura.
2. Dedup por sobreposição (seção 4).
3. Gate de boilerplate (seção 5).
4. Herdados recolhidos + explicação única (seção 6).
5. Reordenação das seções + estados vazios (seção 7).
6. Manchete vs regra (seção 8).
7. Dicionário de idioma, só cromo (seção 9).

Os itens 2 a 4 reduzem ruído e podem ser avaliados isoladamente na tela. Os itens 5 e 6 mudam a leitura da página e valem screenshot antes/depois. O 7 é mecânico.

**Antes do item 5, parar.** É ali que layout começa a importar, e é ali que faz sentido comparar alternativas de desenho em vez de escrever a primeira que vier à cabeça.
