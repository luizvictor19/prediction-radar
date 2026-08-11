# Spec 002 — Edge: do sinal ao P&L

> **Pré-requisito:** specs 000 e 001 concluídas. O eval existe e mediu.
> **Estado que motiva esta spec:** o agente não bate o preço (skill −0,045, n=131).
> A melhor faixa empata (+0,002) contra o *mid*, e opera-se contra o *ask*.
>
> Esta spec não é sobre melhorar o agente. É sobre descobrir **se existe algum
> recorte operável**, com ou sem ele.

---

## Parte A — O princípio

**O objetivo é consistência com edge baixo, não uma tese grande.**

Isso muda o método. Uma tese grande justifica meses de construção antes da
primeira medição. Consistência com edge baixo favorece o inverso: **muitos
testes baratos, dos quais a maioria vai falhar**, cada um com critério de morte
declarado antes de rodar.

Três consequências que valem como regra:

1. **Ordem por custo, não por promessa.** O candidato mais barato vai primeiro,
   mesmo que outro pareça mais empolgante. Barato aqui é medido em horas e em
   requisições, não em elegância.

2. **Critério de morte antes do resultado.** Cada experimento declara, por
   escrito e antes de rodar, o número que o mata. Sem isso, todo resultado vira
   "promissor, precisa de mais dados" — que é como se financia um projeto morto
   por um ano.

3. **Edge que não depende do agente é preferível.** Não porque o agente seja
   ruim, mas porque um edge mecânico é mais barato de manter, mais fácil de
   auditar, e não regride quando um modelo é depreciado. O agente pode virar o
   que ele já é bom em ser: a tese em texto ao lado do número, não a fonte dele.

---

## Parte B — O artefato que falta: backtest de estratégia

O eval mede **qualidade de previsão**. Um backtest mede **P&L**. São artefatos
diferentes e hoje só existe o primeiro.

A distinção não é acadêmica. Skill positivo contra o *mid* pode ser P&L negativo
contra o *ask*; e uma regra que dispara três vezes por mês não é estratégia,
é anedota — mesmo com skill excelente nas três.

### `scripts/backtest-strategy.ts`

Lê o mesmo dataset do eval (`src/eval/dataset.ts`). Nenhuma API, nenhuma escrita.

**A regra é um objeto, não uma constante.** É isso que torna o script útil:
ele varre o espaço de regras em vez de avaliar uma.

```
Regra = {
  minDisagreement: number   // |p_agente − preço| mínimo para apostar
  minLiquidity:    number
  maxSpread:       number
  side:            'both' | 'agent-higher' | 'agent-lower'
  checkpoints:     number[]  // 360, 60, ou ambos
}
```

**A simulação, e os três detalhes que decidem se ela mente:**

1. **Compra no `ask`, nunca no `mid`.** Se o `ask` não estiver gravado no
   instante, a análise sai da amostra — não se estima o preço de execução.
2. **Taxas descontadas** via `fees.ts`. Se houver taxa de saque ou de resolução,
   entra também.
3. **Dimensionamento em duas passadas:** Kelly fracionário (1/4) e stake fixo.
   A diferença entre as duas separa *edge* de *dimensionamento* — um resultado
   que só existe com Kelly é um resultado sobre variância, não sobre vantagem.

**O relatório:**

| campo | por que |
| --- | --- |
| apostas disparadas | regra que dispara 5 vezes não é estratégia |
| EV por aposta | o número central |
| EV total e curva | o final esconde o caminho |
| drawdown máximo | é o que decide se dá para aguentar operando |
| taxa de acerto | **informativa, nunca alvo** — ver Parte F |
| n de partidas distintas | não de apostas |

**Critério de aceitação do script:** varrer pelo menos 50 combinações de regra e
imprimir o mapa completo, não só a melhor. **A melhor regra de um varredor é
sempre boa por construção** — o que interessa é se existe uma *região* de regras
com EV positivo, ou se só existe um pico solitário, que é overfit com outro nome.

### Critério de morte

Se **nenhuma** região de regras tiver EV positivo acima de spread e taxas sobre
n ≥ 30 partidas distintas, a hipótese "o agente gera edge operável" morre nesta
versão. Não itera o prompt: passa aos candidatos da Parte C, que não dependem
dele.

---

## Parte C — Candidatos a edge

Ordenados por custo. Cada um traz o critério de morte.

### C1. A casa afiada contra o venue mole

**A ideia.** O eval tem três previsores: agente, mercado, moeda. Falta o quarto —
a linha da Pinnacle, **sem vig**, como previsor independente.

Se ela bate o *mid* do Polymarket na mesma amostra, o edge não precisa de LLM:
é discordância entre um book afiado (dinheiro em risco, limites altos) e um venue
de fluxo retail. É a estrutura de edge mais confiável que existe em aposta, e o
projeto construiu toda a infraestrutura para ela sem nunca testá-la.

**Dado disponível:** cobertura de Pinnacle em 60,6% dos fragmentos, e é a única
casa que preenche `limit` — o stake máximo, que é o peso de confiança dela.

**Custo:** um previsor em `src/eval/metrics.ts` e o join com `context_fragments`.

**Cuidado:** de-vig antes de comparar. As duas probabilidades implícitas de uma
casa somam mais de 1; a sobra é a margem. Comparar odd crua com `mid` compara
maçã com laranja, e o erro tem o sinal da margem — favorece o Polymarket sempre.

**Critério de morte:** se a Pinnacle não bater o `mid` com n ≥ 50, não há
discordância explorável e o candidato morre.

### C2. Viés favorito-azarão do próprio mercado

**A ideia.** O eval já tem `reliabilityBuckets`. Rodar com `MARKET` no lugar de
`AGENT` responde se o Polymarket erra **sistematicamente** em alguma faixa de
preço.

Viés favorito-azarão é o achado mais replicado da literatura de mercados de
aposta: azarão precificado caro demais, favorito barato demais. Se existir neste
venue, é edge mecânico, declarável e sem modelo nenhum.

**Custo:** trocar uma constante. É o teste mais barato da spec inteira.

**Critério de morte:** se nenhum balde de preço tiver desvio consistente maior
que meio spread típico, com n ≥ 20 partidas por balde, morre.

### C3. Inconsistência série × mapas

**A ideia.** O fragmento `series_consistency` já compara o preço da série com o
implícito pelos `child_moneyline`. Hoje ele só vira texto para o LLM ler.

Se a série diz 0,60 e os mapas implicam 0,68, o **mesmo venue** está precificando
o mesmo evento de dois jeitos. Isso não é previsão — é inconsistência interna, e
não exige saber nada que o mercado não saiba.

**Precedente no repo:** `src/detectors/cross-market*.ts`, desligados na spec 000,
já tinham o conceito.

**Cuidado sério:** implicar o preço da série a partir dos mapas exige um modelo
de correlação entre mapas. Assumir independência está **errado** — times não são
moedas, e a correlação entre ganhar o mapa 1 e o mapa 2 é positiva e grande. Um
"edge" derivado de independência é artefato da suposição, não do mercado. Isso
precisa ser explicitado antes de qualquer número.

**Critério de morte:** se a inconsistência não sobreviver a um modelo de
correlação razoável, ou se a perna barata for sempre a ilíquida, morre.

### C4. Defasagem entre resolução do mapa e preço da série

**A ideia.** Quando o mapa 1 resolve, o preço da série deveria saltar. Com
snapshots de 12s dá para medir se existe atraso sistemático, e de quanto.

Edge de timing é **estrutural**, não informacional — é o único tipo que não
depende de saber mais que ninguém.

**Custo:** análise sobre `esports_snapshots`, que já existe. Mesmo padrão do
`probe-live-reversion.ts`: uma consulta por evento, com `event_id` e os dois
lados de `captured_at`.

**Critério de morte:** se o atraso mediano for menor que o tempo de execução
realista mais o spread, morre. Um edge de 8 segundos que exige 3 para executar e
paga 2% de spread não é edge.

### C5. LoL e Dota são menos eficientes que CS2?

**A ideia.** Já coletados como órfãos. Resolver essas partidas e rodar **só o
baseline de mercado** responde se existe mercado mais fraco onde o *mesmo* agente
teria skill positivo.

Isso testa outro **mercado**, não um agente melhor — e é a hipótese mais barata
de todas, porque a série já está no banco há semanas.

**Critério de morte:** se o Brier do mercado em LoL/Dota for igual ou melhor que
em CS2, não há mercado mais fraco e o candidato morre. Não confundir com o
gatilho de habilitar vertical, que é sobre o agente e continua exigindo n ≥ 50
em CS2.

### C6. Calibração por time

**A ideia.** `market_calibration` já mede com que frequência o mercado acertou
sobre **estes** times. Time sistematicamente mal precificado é edge por entidade.

**Cuidado:** é a hipótese com maior risco de mineração de dados. Com centenas de
times, alguns vão parecer mal precificados por acaso. Exige correção para
comparações múltiplas, ou — mais honesto — separar a amostra em duas metades por
data e só aceitar o que aparecer nas duas.

**Critério de morte:** o efeito não sobreviver à divisão temporal da amostra.

### C7. A janela declarável de 11/08

**Medido:** com mais de 60 min pela frente, o mercado marca Brier 0,105 quando
quieto e **0,192** logo depois de movimento grande. Quase o dobro de erro, num
momento identificável **antes** da decisão — `|d|` e tempo restante são
conhecidos no instante.

É o primeiro recorte declarável do projeto, e 0,192 é pior que o mercado
pré-jogo (0,1618), que o agente já quase alcança.

**Critério de morte:** o agente não bater 0,192 nessa janela com n ≥ 30 partidas.

---

## Parte D — Segurança

Não estava em nenhuma spec anterior e passou a importar por dois motivos: uma
fonte externa **editável por qualquer pessoa** está prestes a entrar no prompt, e
o projeto caminha para uma posição onde erro custa dinheiro e não CPU.

### D1. Injeção de prompt pela Liquipedia — o risco mais concreto

**A Liquipedia é uma wiki. Qualquer pessoa edita.**

Se `liquipedia` for ligada, o conteúdo de páginas editáveis por terceiros entra
no prompt de um agente que gasta dinheiro por chamada e que, se esta spec der
certo, vai dimensionar aposta. Texto de terceiro dentro de um prompt é vetor de
injeção — não é hipótese exótica, é a superfície mais óbvia do sistema.

`polymarket-context` é a mesma classe com risco menor: também é texto gerado por
LLM de terceiro, mas o venue controla a geração e não há edição pública.

**A validação de citação NÃO cobre isso.** Ela pega rótulo inexistente; não pega
o modelo citando um fragmento real enquanto segue instrução plantada dentro dele.

**Mitigações, em ordem de força:**

1. **O prompt declara que fragmento é DADO, nunca instrução**, e que texto dentro
   de `summary` ou `payload` que se pareça com comando deve ser reportado como
   anomalia em vez de obedecido. Barato, e é a única que escala para toda fonte.
2. **Teto de tamanho por fragmento**, com truncamento declarado. Injeção precisa
   de espaço.
3. **`confidence` baixa já é regra** para texto de terceiro (≤ 0,4). A hierarquia
   da v2 já rebaixa nível 4 — isso ajuda, mas não é defesa.
4. **Detecção de padrão** em campos de wiki antes de virar fragmento (marcadores
   de instrução, mudança de idioma no meio, blocos longos fora de formato).

**Critério de pronto:** nenhuma fonte editável por terceiro entra em produção sem
(1) e (2) aplicadas.

### D2. Autorização do bot do Telegram

O bot expõe `/review` e comandos de configuração. `system_config` controla teto
de gasto, coleta e habilitação de vertical.

**A confirmar antes de qualquer coisa:** o bot valida **quem** manda o comando,
ou aceita de qualquer chat que o encontre? Se for o segundo, quem descobrir o bot
muda `analyst_daily_budget_usd`.

`ops_telegram_chat_id` já existe separado de `telegram_chat_id`, então o desenho
já distingue operador de usuário — falta confirmar se a autorização usa isso.

### D3. Segredos

- `SUPABASE_SERVICE_KEY` ignora RLS por definição. É a chave mais perigosa do
  repo e vive no Railway.
- **`probes/` é commitado.** O snapshot da OddsPapi já exclui a chave de propósito
  — isso vira **regra**, não gentileza: nenhum artefato de sonda pode conter
  credencial, e vale um teste que falhe se contiver.
- `system_logs` já chegou a 2,7M linhas. Confirmar que nenhum caminho loga
  payload de requisição com header.
- Rotação: hoje não há procedimento. Vazou, o que se faz?

### D4. Quando entrar dinheiro, muda a categoria

Chave de API vazada custa cota. **Chave privada de carteira vazada custa o saldo,
e é irreversível.**

Se o sistema passar a executar ordens, isso deixa de ser um projeto com
credenciais e passa a ser um projeto com custódia. As perguntas mudam: onde a
chave vive, quem pode assinar, existe teto por ordem no código *e* no
dispositivo, e o que acontece se o processo do Railway for comprometido.

**Regra desta spec:** nenhuma execução automática de ordem sem uma spec própria
de custódia. Sinal no Telegram para execução manual não tem esse problema, e é o
caminho certo para a primeira versão operacional.

### D5. Opsec do próprio edge

O plano de audiência prevê publicar métrica em público, inclusive ruim. Está
certo — e tem um limite.

**Achado de engenharia se publica. Edge não.** Um edge publicado é um edge morto,
e a distinção precisa estar clara antes de existir um, não depois. O material dos
"Findings" (coletor parado, bloat de índice, retenção apagando o ativo) é
publicável para sempre. O conteúdo de "onde exatamente o mercado erra" não é.

---

## Parte E — Divisão de responsabilidades

**O agente não faz o que está na coluna do humano.**

| # | Item | Momento |
| --- | --- | --- |
| H1 | Decidir se o projeto opera com capital, e com qual teto | antes de C1–C7 virarem estratégia |
| H2 | Confirmar a autorização do bot do Telegram (D2) | antes de qualquer coisa |
| H3 | Aplicar migrations, se alguma surgir | quando surgir |
| H4 | Decidir sobre a Liquipedia à luz de D1 | antes de ligar a flag |
| H5 | Definir o procedimento de rotação de segredo (D3) | antes de operar |
| H6 | Julgar cada critério de morte — o agente reporta, não decide | a cada experimento |

### Escopo do agente

- `scripts/backtest-strategy.ts` e a varredura de regras
- O previsor de casa em `src/eval/metrics.ts` (C1)
- A calibração do mercado (C2)
- As análises de C3–C7, como sondas que não escrevem
- As mitigações (1) e (2) de D1
- Escrever migrations, **não aplicar**

### Protocolo quando bloqueado

1. Não inventar dado nem inferir schema não confirmado.
2. Não rodar SQL de escrita, em nenhuma hipótese.
3. Nenhuma consulta a `esports_snapshots` sem `event_id` **e** faixa de
   `captured_at` — o planner erra a estimativa por 300–600x nessa tabela.
4. Parar, dizer qual item humano está pendente, seguir com o que não depende.

---

## Parte F — Armadilhas declaradas

Escritas antes de qualquer resultado, porque depois é tarde.

**Taxa de acerto não é alvo.** Apostar sempre a 0,90 acerta 85% das vezes e perde
dinheiro. O alvo é EV por aposta.

**Sistema de aposta não cria edge.** Martingale e Soros não mudam o valor
esperado, só a forma da distribuição. Com EV negativo, martingale é uma máquina
de chegar a zero: a milhares de apostas por ano, uma sequência de 8 derrotas
deixa de ser cauda e vira certeza com data indefinida. Kelly fracionário é a
resposta correta para "quanto", e só depois de haver edge.

**A melhor regra de um varredor é sempre boa.** Interessa a região, não o pico.

**n de partidas, não de apostas.** Duas apostas na mesma partida não são duas
observações.

**Escolher pelo resultado.** O piso de liquidez subiu para US$ 20.000 em 11/08
*porque* a faixa 5k–20k foi mal numa amostra. Isso é hipótese, não conserto — e
tem que ser testada para frente, não confirmada no mesmo dado que a originou.

**Ausência de garantia não é defeito conhecido.** Vale para
`supportsPointInTime` e vale aqui: "não medimos" e "medimos e não tem" são
conclusões diferentes, e só a segunda encerra um candidato.

---

## Parte G — Critério de pronto da spec

Esta spec termina quando **uma** das duas for verdade:

1. Existe uma regra declarável, com EV positivo acima de spread e taxas, sobre
   n ≥ 30 partidas distintas, que sobreviveu a divisão temporal da amostra. Aí
   começa a spec 003, sobre operação e custódia.

2. Todos os candidatos de C1 a C7 morreram pelos critérios declarados. Aí a
   conclusão honesta é que este mercado não é explorável com as fontes atuais, e
   a decisão passa a ser sobre o que o projeto vira — dado, conteúdo, portfólio.

**As duas são resultados.** A segunda em quatro semanas vale mais que a primeira
em um ano, e infinitamente mais que nenhuma das duas em seis meses.
