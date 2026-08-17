# Prompt — Digestão de regras, v2

O degrau 1 rodou e eu li as 10. **Tem coisa boa lá dentro, mas afogada.** Esta
rodada conserta três defeitos e roda de novo **nos mesmos 10 mercados, mesma
semente**, para eu comparar v1 contra v2 lado a lado.

Custo: outros ~US$ 0,014.

---

## Defeito 1 — contagem forçada

O modelo entregou 2 a 4 pegadinhas por mercado **tenha ou não o que dizer**.
Saíram coisas como:

> "Pode parecer que 'maior empresa' refere-se a receita ou lucro, mas a regra
> define 'by market cap'."

Isso é enchimento, e ele afoga o que presta.

**Zero pegadinhas é resposta válida e desejada** quando a regra é simples. O
prompt tem que dizer isso em voz alta — o modelo preenche tabela por padrão.

## Defeito 2 — tudo com o mesmo peso

Cada pegadinha ganha **severidade**, de uma lista fechada:

| severidade | significa |
| --- | --- |
| `muda_resultado` | decide SIM contra NÃO |
| `muda_timing` | não muda o desfecho, mas muda **quando** resolve |
| `detalhe` | nuance de leitura, não muda decisão |

`muda_timing` existe por um caso real que apareceu: o mercado do White Sox
resolve NÃO **na eliminação matemática**, não no fim da World Series. O desfecho
é o mesmo; o capital destrava meses antes. Quem não sabe, calcula errado quanto
tempo o dinheiro fica preso.

## Defeito 3 — as ambiguidades são texto livre, e deviam ser categoria

**Este é o mais importante, e ele muda o produto.**

Lendo as 10, as ambiguidades **se repetem entre mercados**:

- **"ET" sem dizer se é EST ou EDT** — em 4 dos 9 válidos
- **"consensus of credible reporting" como fonte** — em 5 dos 9, sem definir nada
- **data que admite duas leituras** ("2027 NFC championship" é a temporada de
  2027 ou o jogo disputado em 2027?)
- **texto da regra em formato categórico numa pergunta binária** (o de Apple diz
  "resolve to the largest company", que não é sim/não)

Padrão que repete é coisa que se conta. E contagem vira **score de risco de
disputa**, que é o produto de verdade — mais de 1.150 mercados foram disputados
em 2026, e o caso de US$ 60 milhões foi exatamente ambiguidade de data.

Então `ambiguidades` deixa de ser texto solto e passa a ter **tipo de lista
fechada**:

```
fonte_vaga          quem decide não está nomeado, ou é "consenso" sem definição
fuso_ausente        horário sem fuso, ou "ET" sem EST/EDT
data_ambigua        a data ou o período admite mais de uma leitura
janela_inclusiva    não diz se os extremos do intervalo entram
escopo_de_entidade  quem conta como parte não está fechado
limiar_de_borda     o que acontece exatamente no limiar não está dito
formato_do_mercado  o texto da regra não casa com o formato da pergunta
outro               fora da lista — e o campo livre explica
```

Cada ambiguidade traz `tipo` **e** o trecho da regra que a causa. Sem o trecho,
não dá para auditar.

**Se `outro` passar de 20% das ambiguidades, a lista está incompleta** — reporte
isso em vez de forçar as categorias existentes.

---

## O conserto da trava

Uma das 10 foi recusada porque escreveu *"a leitura restritiva é mais provável"*.
A trava pegou a palavra "provável", e ela estava certa em pegar — mas o modelo
não estava opinando sobre desfecho, e sim sobre qual leitura da regra pesa mais.

**Não afrouxe a trava.** Conserte na origem:

> Ao listar uma ambiguidade, apresente **as duas leituras** e **não diga qual é
> mais provável**. Qual leitura vale é decisão de quem resolve o mercado, não sua.

Isso mata o falso positivo e melhora a saída — as duas leituras lado a lado é
mais útil que o palpite de qual vence.

---

## A régua, com exemplos reais da própria rodada

Coloque no prompt exemplos do que passa e do que não passa. Estes saíram da
rodada de ontem e são a régua:

**PASSA:**

- "Tiros de advertência, artilharia em área desabitada e mísseis que caiam em
  águas territoriais são **explicitamente excluídos**." → `muda_resultado`
- "A Guarda Costeira Japonesa não é força militar; a Guarda Costeira Chinesa
  conta." → `muda_resultado`
- "A regra exclui coligações e conta só os assentos da entidade nomeada." →
  `muda_resultado`
- "Fechamento exatamente em US$ 76.000 resolve NÃO — a regra diz *higher than*."
  → `muda_resultado`
- "Resolve NÃO na eliminação matemática, antes do jogo." → `muda_timing`
- "A janela começa em 24/11/2025, não na criação do mercado." → `muda_resultado`

**NÃO PASSA — é enchimento:**

- "Pode parecer que 'maior empresa' é receita, mas a regra diz market cap."
- "O preço de outras corretoras não conta."
- "A posição durante o dia não conta, só o fechamento."

A diferença: o que passa é **algo que a regra diz e o título esconde**. O que não
passa é apenas repetir o que a regra já diz de forma óbvia.

---

## Como rodar

**Mesmos 10 mercados, mesma semente `20260815`.** Isso é o ponto: a comparação
só existe se a amostra for idêntica.

Saída em `probes/digest/degrau-1-v2.md`, e **um arquivo de comparação** com v1 e
v2 lado a lado por mercado, para eu ler as duas versões da mesma regra.

Reporte também: quantas pegadinhas por severidade, quantas ambiguidades por
tipo, e a taxa de `outro`.

---

## Limites

- Migration escrita, nunca aplicada. Não commite. Não leia `.env`.
- `deepseek-v4-flash` — os nomes antigos foram aposentados.
- Não avance para o degrau 2 sem eu aprovar.
- Não julgue qual versão ficou melhor — a comparação é minha.

---

## Ao terminar, em três linhas

1. distribuição de severidade das pegadinhas, e quantos mercados vieram com zero
2. distribuição de tipo das ambiguidades, e a taxa de `outro`
3. onde está o arquivo de comparação v1 × v2
