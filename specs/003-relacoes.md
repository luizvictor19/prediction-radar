# Spec 003 — Extrator de relações lógicas

> **Pré-requisito:** specs 000, 001 e 002. O eval existe e mediu três vezes.
> **Estado que motiva:** o agente não bate o preço (skill −0,040), e o motivo é
> estrutural — ele não tem informação que o mercado não tenha. As três hipóteses
> de erro sistemático de preço morreram (favorito-azarão, correção de viés,
> rajada de tweets).
>
> Esta spec troca a tarefa do agente. Ele para de **prever** e passa a **ler**.

---

## Parte A — O princípio

### Por que a tarefa muda

Vantagem em mercado vem de quatro lugares, do mais fácil ao mais difícil:

| tipo | o que exige | garantia |
| --- | --- | --- |
| **arbitragem lógica** | ler duas perguntas | **matemática** |
| arbitragem estatística | amostra grande | probabilística |
| informação | fonte que os outros não têm | depende da fonte |
| modelo | processar melhor o público | nenhuma |

O agente atual opera no **último** — o mais difícil — e foi medido: não funciona.

Arbitragem lógica é o primeiro, e ela tem uma propriedade que nenhuma das outras
tem: **não existe p-valor.** Ou a soma passa de 1 ou não passa. Escanear mil
mercados procurando violação aritmética não gera falso positivo por comparação
múltipla, porque não é inferência — é conta.

### Onde o LLM entra, e por que aqui ele é forte

A conta é trivial: comparar dois números.

**O difícil é saber QUAIS mercados têm relação lógica.** São milhares de
perguntas em texto livre, e reconhecer que *"X vence a Pensilvânia"* restringe
*"X vence a eleição"* exige compreender linguagem.

Isso é leitura, não previsão. E a diferença no custo do erro é o argumento
central desta spec:

- **agente previsor errado** → perde dinheiro em silêncio, só aparece no Brier
  semanas depois;
- **agente leitor errado** → a conta não fecha, nada acontece; ou, no pior caso,
  a conferência humana pega antes de virar posição.

### O que NÃO muda

Nada de risco vira automático. Esta spec produz **candidatos com justificativa**,
não ordens. A Parte G mantém a operação inteiramente humana.

---

## Parte B — A taxonomia, e ela é FECHADA

O agente não escreve relação em texto livre. Ele escolhe de uma lista, e cada
tipo carrega a desigualdade que ele impõe aos preços.

| tipo | significado | restrição de preço |
| --- | --- | --- |
| `implica` | A só acontece se B acontecer | `P(A) ≤ P(B)` |
| `exclui` | não podem acontecer juntos | `P(A) + P(B) ≤ 1` |
| `particiona` | exatamente um do conjunto acontece | `Σ P = 1` |
| `equivale` | mesmo evento, roupas diferentes | `P(A) = P(B)` |
| `conjuncao` | C é "A e B" | `P(C) ≤ min(P(A),P(B))` e `P(C) ≥ P(A)+P(B)−1` |
| `nenhuma` | sem relação lógica | — |

`conjuncao` traz os limites de Fréchet. O de baixo é o menos óbvio e o mais
esquecido: se A vale 0,80 e B vale 0,70, **"A e B" não pode valer menos que
0,50**, por mais improvável que a combinação pareça.

### O campo que não pode faltar: ressalva de resolução

Duas perguntas podem ser logicamente ligadas e **resolverem por fontes
diferentes, em datas diferentes, com regras de void diferentes.** Aí a
"arbitragem" tem furo, e o furo só aparece depois do dinheiro entrar.

Toda relação proposta carrega obrigatoriamente:

```
ressalvaDeResolucao: string | null
```

O agente lê as regras de resolução das duas pontas e declara qualquer diferença
que possa quebrar a relação: fonte distinta, data distinta, condição de void
assimétrica. `null` significa "li as duas e não vi diferença", **não** "não
olhei" — e a distinção tem que estar no prompt.

---

## Parte C — O problema quadrático, e ele decide o custo

> **Reescrita em 12/08/2026, depois da fase 1.** A versão original supunha 2.000
> mercados abertos. O número medido é **133.543** — 67× a suposição. Os parágrafos
> abaixo são os medidos, não os estimados.

Com 133.543 mercados abertos, os pares são **8,9 bilhões**. Não existe orçamento
que mande isso para um modelo, e não existe gerador que corte isso sozinho.

Então há um **gerador de candidatos** antes do agente, e ele é a peça que decide
se a spec é viável. Mesma função do portão do analista: recusar antes de gastar.

Camadas, da mais barata para a mais cara:

1. **Mesmo evento / mesma série** — `neg_risk_market_id`, `series_id`. Relação
   quase garantida, custo zero. É de onde vem a `particiona`. Medido: **829 dos
   3.551 grupos vêm prontos**, porque `negRisk: true` no evento é a própria API
   declarando a partição.
2. **Entidades compartilhadas** — extrair nomes próprios, tickers e datas do
   texto da pergunta e agrupar por interseção. Ainda sem LLM.
3. **Proximidade textual** — sobreposição de tokens ou embedding. Barato, e é o
   que pega relação entre perguntas escritas de formas diferentes.
4. **Só então o agente**, e sobre **GRUPOS, não pares**.

O passo 4 é onde mora a economia real: dar ao modelo 10 perguntas relacionadas e
pedir **todas as relações entre elas** custa uma chamada, não 45.

**Critério de aceitação do gerador:** reduzir o universo de pares para uma ordem
que caiba no teto diário de gasto, e reportar quantos pares foram descartados em
cada camada. Descarte silencioso aqui é cobertura perdida sem ninguém saber.

### O que a fase 1 mediu

Amostra estratificada de 17.811 mercados — 10,7% do universo.

| medida | valor |
| --- | --- |
| mercados abertos | ≥ 133.543 |
| grupos gerados na amostra | 3.551 |
| tamanho do grupo | mediana 7, p75 12, p95 33, máx 128 |
| grupos que precisam do modelo | 2.722 |
| grupos de graça (`negRisk`) | 829 |
| `description` preenchida | 100,0% dos 17.811, mediana 1.262 caracteres |
| `resolutionSource` preenchida | 62% |

A `description` vir cheia em 100% dos mercados é o que **salva a
`ressalvaDeResolucao`** da Parte B. O texto das regras está no payload; o agente
tem o que ler. O `resolutionSource` vazio em 38% não derruba o campo, mas é
motivo de o agente declarar ressalva em vez de `null` quando a fonte não aparece
em uma das pontas.

### A aritmética que reprova a cobertura total

| cenário | chamadas | custo |
| --- | --- | --- |
| extrapolação da amostra | ~25.400 | **~US$ 733** |
| teto pessimista | — | US$ 2.746 |
| teto independente de amostra | — | US$ 1.502 |
| só a camada 1 (89% dos pares) | — | US$ 458 |

**Não passa no portão de "umas poucas centenas de dólares".** Pela regra que a
própria spec escreveu, a fase 2 não começa cobrindo o universo aberto.

Duas correções ao modelo de custo, e as duas empurram para baixo:

- **Relação lógica não tem data** (Parte F). Os US$ 733 são **carga inicial de
  uma vez**, não gasto por varredura. Depois disso só entra mercado novo. Isso
  muda a natureza do número, não o fato de ele reprovar hoje.
- **A cobertura total nunca foi o objetivo.** A Parte E manda otimizar precisão e
  aceitar cobertura baixa. Varrer 133 mil mercados sem saber se o extrator acerta
  é gastar na ordem errada.

### Portanto, a fase 2 começa pelo subconjunto resolvido

**762 dos 3.551 grupos (21,5%) são inteiramente de mercados já resolvidos**, 754
precisam do modelo, e rodá-los custa **US$ 15,26**. É onde a precisão se mede —
ver a Parte E. O filtro econômico do universo aberto (liquidez, prazo, ter irmão
lógico) só é decidido **depois** que a precisão existir, e é decisão humana (H6).

### Uma dívida do gerador, antes da fase 2

A camada 3 descartou 156 milhões de pares nunca pontuados e perdeu mais 35,6
milhões no teto de tamanho de grupo. Vazamento medido: **11 de 3.000 descartes
amostrados (0,4%) passariam do limiar**. É baixo, mas o teto
`invertedIndexDfCeiling` está frouxo e deve ser baixado antes de a camada 3
valer como cobertura.

---

## Parte D — O extrator

Segue o desenho do analista, porque ele já resolveu os problemas certos.

**Entrada:** um grupo de mercados — id, pergunta, regras de resolução, data de
fechamento, preços atuais.

**Saída estruturada**, tipo fechado, validada antes de gravar. O prompt entrega
rótulos curtos (`M1`, `M2`, ...) e **relação que cite rótulo não entregue
invalida a resposta inteira** — mesma regra que já existe em `parseAnalysis` e
que manteve a fidelidade em 584/584.

Cada relação carrega:

- o tipo, da lista fechada
- os mercados envolvidos, por rótulo
- `confianca` em [0,1]
- `justificativa` — uma frase citando o trecho das perguntas que sustenta
- `ressalvaDeResolucao`

**Abster-se é barato e incentivado.** Ao contrário do analista, onde a abstenção
do modelo nunca aconteceu, aqui ela é o comportamento desejado na dúvida — ver a
assimetria na Parte E.

**Versionado**, com registro no código e escolha por config, exatamente como
`analyst_prompt_version`. Rollback é `UPDATE`, não redeploy.

---

## Parte E — A medição, e ela é melhor que a do analista

### A assimetria que desenha tudo

- **Relação falsa** → você monta uma operação achando que travou o lucro e
  tomou posição direcional. **Custa dinheiro.**
- **Relação perdida** → você não vê uma oportunidade. **Custa zero.**

Logo: **otimizar precisão, aceitar cobertura baixa.** Uma ferramenta que acha
metade das relações e acerta 95% vale muito mais que uma que acha todas e acerta
70%.

### E a verdade é conferível NA HORA

Esta é a diferença que faz a spec 003 andar rápido. O analista precisava esperar
a partida acabar. Aqui, um humano lê duas perguntas e responde em segundos se a
relação existe.

### Melhor ainda: em mercado resolvido, a conferência é automática

Relação lógica pode ser verificada **contra o desfecho**. Se `A implica B`, então
em toda resolução onde A deu SIM, B tem que ter dado SIM. Uma violação **refuta a
relação objetivamente**, sem opinião de ninguém.

| tipo | o que o desfecho tem que respeitar |
| --- | --- |
| `implica` | A=SIM ⇒ B=SIM |
| `exclui` | não pode A=SIM e B=SIM |
| `particiona` | exatamente um do conjunto deu SIM |
| `equivale` | A e B deram o mesmo |
| `conjuncao` | C=SIM ⇔ A=SIM e B=SIM |

Não vale quando **o antecedente nunca disparou** — se A deu NÃO, `A implica B`
não é testável por aquele desfecho, e a relação segue precisando de humano.
Reportar essa taxa junto com a precisão: é quanto do gabarito ficou em branco.

**A fase 2 roda primeiro aqui**, nos 762 grupos inteiramente resolvidos (754
precisam do modelo, US$ 15,26). 96,7% dos mercados resolvidos trazem desfecho
legível em `outcomePrices`.

**O viés dessa amostra, declarado antes do resultado:** mercado resolvido é mais
antigo e de tema já encerrado. Pode ser mais fácil de ler que o aberto. A
precisão que sair dali é **teto otimista**, não garantia — e o critério de morte
se aplica mesmo assim: se nem no gabarito passa de 90%, no aberto não passa.

### A fatia tem que ser retomável, e isso não é conveniência

Rodar 100 grupos hoje e mais 300 semana que vem só é honesto se a segunda rodada
não repetir nem re-sortear. Três exigências:

1. **Fila embaralhada com semente fixa.** Os grupos entram numa ordem sorteada
   uma vez, reprodutível. "Rodar 100" significa **os 100 primeiros da fila**, não
   100 sorteados na hora.
2. **Resultado gravado com o id do grupo.** Existe registro de quem já foi.
3. **Retomada:** a rodada seguinte tira da fila quem já tem resultado e continua.
   Queda no meio não perde nem duplica.

A semente fixa não é detalhe de engenharia — é o que faz a fatia ser **amostra
aleatória** e não "os grupos que calharam de vir primeiro". Ordenar por tamanho,
por data ou por confiança quebra a medição do mesmo jeito que medir só as
relações mais confiantes quebra (ver Parte H).

**A medição é:**

1. amostra aleatória de N relações propostas (não as mais confiantes — isso
   mediria o topo, não a ferramenta);
2. rótulo: **automático pelo desfecho** onde o grupo já resolveu e o antecedente
   disparou; **humano** — certa, errada ou ambígua — no resto;
3. **precisão** = certas ÷ (certas + erradas), com intervalo de confiança;
4. precisão **por tipo de relação** — errar `implica` e errar `conjuncao` são
   defeitos diferentes;
5. precisão **por faixa de `confianca`** — se a confiança não separa certo de
   errado, ela é decoração e o campo sai.

**Cobertura**, separadamente: em um conjunto pequeno de mercados rotulado à mão
por inteiro, quantas das relações verdadeiras ele achou. Estimativa, não
garantia — e não é o número que decide.

### Critério de morte

Precisão abaixo de **90%** na amostra rotulada, ou confiança que não separa
certo de errado. Abaixo disso é gerador de ruído, e conferir tudo à mão sai mais
caro que o valor de achar.

---

## Parte F — O que se reaproveita, e o que não

### Reaproveita direto

- **saída estruturada + validação de rótulo** (`analyst.ts`) — o mecanismo que
  descarta a resposta inteira quando uma citação não confere
- **rastreabilidade** (`analysis_claims`) — vira relação → as duas perguntas
- **telemetria por chamada** — modelo, versão de prompt, esforço, tokens, custo,
  latência, tudo já modelado em `esports_analyses`
- **teto de gasto diário com parada dura** (`analyst_daily_budget_usd`)
- **portão antes da chamada** — aqui vira o gerador de candidatos
- **heartbeat e alerta de saúde** — componente novo entra em
  `MONITORED_COMPONENTS`
- **`scripts/lib/probe-net.ts`** — cliente HTTP com contador e snapshot cru

### NÃO reaproveita

- **Brier, calibração, decomposição de Murphy** — não há probabilidade a
  pontuar. A métrica é precisão.
- **`supportsPointInTime`** — relação lógica não tem data. "X vence a
  Pensilvânia implica X vence a eleição" era verdade ontem e será amanhã.
- **o contexto por partida** do enricher — a unidade aqui é grupo de mercados.

### Fica de fora de propósito

`cross-market-inter` **não é religado nesta spec.** Ele já resolve a
`particiona` e está desligado por decisão. Religá-lo é escolha separada, com
custo e ruído próprios, e misturar as duas tornaria impossível saber o que
produziu o quê.

---

## Parte G — Divisão de responsabilidades

**Nenhuma operação é automática. Esta spec produz candidatos, não ordens.**

| # | item | quando |
| --- | --- | --- |
| H1 | Rotular a amostra de relações. **É trabalho humano e é o produto da spec.** | a cada medição |
| H2 | Conferir a ressalva de resolução antes de qualquer dinheiro | sempre |
| H3 | Decidir o teto de gasto do extrator | antes de ligar |
| H4 | Aplicar migrations | quando surgirem |
| H5 | Julgar o critério de morte — o agente reporta, não decide | ao fim da medição |
| H6 | Decidir o filtro do universo aberto (liquidez, prazo, ter irmão lógico) | **só depois** de a precisão existir |

### Escopo do agente

- o gerador de candidatos e as quatro camadas
- o extrator, o prompt versionado, a validação
- o harness de precisão e os cortes
- migrations **escritas, não aplicadas**

---

## Parte H — Armadilhas declaradas, antes de qualquer resultado

**Relação falsa é pior que relação nenhuma.** É o único erro nesta spec que
custa dinheiro, e é por isso que precisão manda sobre cobertura.

**A `particiona` é a mais fácil e a menos valiosa.** Vem de graça do
`neg_risk_market_id`, e é exatamente onde os arbitradores já estão. O valor está
em `implica` e `conjuncao`, que exigem leitura de verdade.

**Regra de resolução quebra relação lógica sem avisar.** Duas perguntas
equivalentes que resolvem por fontes diferentes não são equivalentes para quem
opera.

**Medir só as relações mais confiantes mede o topo, não a ferramenta.** A
amostra rotulada é aleatória, sempre.

**Inconsistência lógica é rara e some rápido.** Arbitrador limpa. O detector que
já existe achou 5 a 8 em três meses. Esperar volume alto é esperar errado.

**O rótulo humano também erra.** Ambíguo é uma resposta válida na rotulagem, e a
taxa de ambíguos é um número a reportar — se for alta, a taxonomia está mal
desenhada, não o agente.

**O gabarito grátis é uma amostra enviesada.** Mercado resolvido é mais velho e
de tema encerrado. A precisão medida ali é teto, não expectativa — e reportá-la
como se fosse a precisão do universo aberto seria o mesmo erro de extrapolar de
uma sonda para a produção, que já aconteceu três vezes neste projeto.

**Fatia sem semente fixa não é amostra aleatória.** Rodar "os primeiros 100" de
uma lista ordenada por qualquer coisa mede aquele pedaço, não a ferramenta.

---

## Parte I — Critério de pronto

A ordem é: **precisão primeiro, cobertura depois.** A fase 2 gasta US$ 15,26 no
gabarito resolvido antes de qualquer discussão sobre varrer o universo aberto. O
número de US$ 733 da Parte C só volta a ser pauta se a precisão passar.

A spec termina quando:

1. **Precisão ≥ 90%** em amostra aleatória rotulada, com intervalo de confiança
   que sustente, e confiança que separe certo de errado. Aí o extrator vira
   ferramenta, e a próxima pergunta é operacional — quantas violações reais ele
   encontra, e valem quanto.

2. **Ou precisão abaixo disso**, e a conclusão é que ler relação lógica em
   linguagem livre não está no alcance desta montagem. Também é resposta, e
   custa uma amostra rotulada à mão.

**As duas em semanas, não meses.** A verdade aqui é conferível na hora — não
depende de partida acabar, mercado resolver, nem calendário passar. É a primeira
frente do projeto com essa propriedade, e é a razão de ela vir agora.
