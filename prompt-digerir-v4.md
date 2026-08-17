# Prompt — Digestão de regras, v4

Contexto: a v3 rodou em 10 mercados e a qualidade subiu de verdade — a exigência
de `trecho` verbatim ancorou cada item numa cláusula da regra, e o enchimento
caiu porque enchimento é sobre o que a regra NÃO diz, e o que a regra não diz não
tem trecho pra citar. A contagem por mercado passou a responder ao mercado
(1, 3, 4, 4, 4, 4, 3, 3, 3, 5) em vez de responder a uma cota.

O que sobrou de errado na v3 é a **lista fechada de tipos de ambiguidade**:
`outro` bateu 30.4% (7 de 23). Li os 7 um por um. Três são categorias que faltam,
dois são erro de classificação por definição frouxa, e dois são o mesmo caso
repetido. Esta versão fecha isso.

Não mexer em mais nada. `trecho`, `cenario`, os CHECKs de severidade, o teste que
falha se sair probabilidade ou recomendação — tudo permanece exatamente como está.

---

## 1. Três tipos novos na lista fechada

### `contradicao_interna`

A regra afirma duas coisas incompatíveis. **Não é ambiguidade de leitura — é
defeito do texto.** Nenhuma das duas leituras é errada, porque a regra sustenta
as duas.

Caso da v3 (mercado 1, Trump out as President):

> "...ceases to be the President of the United States **for any period of time**
> by August 31, 2026"

e, três parágrafos abaixo:

> "**Only permanent removal from office will qualify.**"

A v3 jogou isso em `outro` e escreveu a leitura B já resolvendo o conflito ("apenas
afastamento permanente conta, conforme esclarece a regra em..."). Isso é o modelo
sendo prestativo onde não devia: ele reconciliou um texto que não reconcilia.
A regra diz as duas coisas. Quem resolve vai ter que escolher, e a escolha não
está escrita.

Por que essa é a categoria de maior valor: **regra que se contradiz é a forma
exata da disputa.** É o formato do caso MicroStrategy (US$ 60M). Não é um mercado
difícil de prever — é um mercado onde o oráculo vai ter que legislar. Isso é
observável hoje, no texto, sem esperar o evento.

Definição pro modelo: use quando duas passagens da regra, aplicadas ao mesmo
cenário, produzem resoluções opostas. Exige **dois `trecho`s**, um de cada
passagem. Se você conseguir escrever uma leitura que concilia as duas sem forçar,
não é `contradicao_interna` — é ambiguidade normal, classifique no tipo certo.

### `precedencia_de_fonte`

A regra nomeia mais de uma fonte ou mais de um caminho de resolução e **não diz
qual manda** quando elas discordam.

Dois casos na v3:

- Venezuela/Rubio — a regra aponta a listagem oficial do governo venezuelano
  *"or otherwise confirmed by official government information as being the head
  of state"*. Duas rotas. Se divergirem, a regra é muda.
- Flórida — *"the first official announcement of the results from the Florida
  Republican Party; **however**, an overwhelming consensus of credible reporting
  may suffice."* O anúncio oficial é a fonte, exceto quando não é. Quando o
  consenso substitui o anúncio, e quando ele não substitui, a regra não diz.

Isso não é `fonte_vaga`. `fonte_vaga` é uma fonte só, mal definida ("consensus of
credible reporting" — quantas reportagens?). `precedencia_de_fonte` é duas fontes
bem definidas sem ordem entre elas. São problemas diferentes e disputam de jeitos
diferentes.

### `criterio_discricionario`

A regra entrega a decisão a quem resolve, sem critério. Marcador linguístico:
verbo modal de permissão (`may`, `at the discretion of`) ou um juízo de qualidade
sem régua (`clearly`, `overwhelming`, `substantially`).

Dois casos na v3:

- *"the market **may** remain open until the end of the third calendar day (ET)"*
  — pode, ou não. Quem decide, e com base em quê?
- *"does **not clearly** state"* — clareza segundo quem?

Isso é diferente de `fonte_vaga` de novo: a fonte pode estar perfeitamente
definida, e ainda assim a *decisão* ficar discricionária.

---

## 2. Dois erros de classificação, corrigidos por definição mais apertada

Dois dos 7 `outro` não eram categoria faltando — eram categoria existente com a
definição frouxa demais pro modelo reconhecer.

**`escopo_de_entidade`** recebeu *"In the event that more than one official head
of state is listed by the Venezuelan government, this market will resolve to the
individual who is listed as having primary status."* Isso é escopo de entidade
puro: quem é a entidade que conta. A definição atual deve estar falando de
"qual entidade" e não de "quantas entidades". Reescrever pra cobrir os dois:
**qual pessoa/organização conta, quantas contam, e o que acontece quando há mais
de uma candidata.**

**`formato_do_mercado`** recebeu *"This market will resolve according to the exact
amount of cuts of 25 basis points in 2026 by the Fed."* Isso é formato: o mercado
conta *cortes de 25 bps*, não *pontos-base*. Um corte de 50 bps é **dois**. A
definição atual não está deixando claro que a unidade de contagem é formato.
Reescrever: **a unidade em que o resultado é medido ou contado, quando ela difere
da unidade que o título sugere.**

Depois dessas duas correções, os 7 `outro` da v3 viram: 1 `contradicao_interna`,
2 `precedencia_de_fonte`, 2 `criterio_discricionario`, 1 `escopo_de_entidade`,
1 `formato_do_mercado`. **Zero `outro`.**

---

## 3. `momento_ambiguo` e `janela_inclusiva` e `limiar_de_borda` ficam

Deram 0 uso na v3. **Não remover.** Os três nasceram de mercados de market-cap e
de limiar numérico, e a amostra de 10 desta rodada não tem nenhum desses. Zero uso
numa amostra que não contém o caso é *não testado*, não é *refutado*. Remover
categoria por zero uso em n=10 é exatamente o erro que a seção 4 fala.

---

## 4. Parar de comparar versões de prompt em n=10

Rodei a v3 três vezes, prompt idêntico, mesmos 10 mercados. Taxa de `outro`:
**20.0%, 6.7%, 30.4%.**

A variância entre rodadas iguais é maior que qualquer efeito que estou tentando
medir entre v2 e v3. Todo número de comparação que produzi até aqui em n=10 é
ruído com cara de medida — inclusive os que usei pra justificar mudanças que
acabaram certas por outro motivo (li a saída e vi a qualidade; o número não
ajudou).

Mudança de regra, daqui pra frente:

- **n=10 é smoke test.** Serve pra responder "roda sem quebrar, o JSON valida, o
  `trecho` bate no texto, nada truncou". Não serve pra responder "ficou melhor".
- **Comparação de qualidade só em n ≥ 100**, ou não se faz. A US$ 0.0003/mercado
  isso custa ~US$ 0.03 por versão. O caro nunca foi o token — foi eu tratar
  flutuação como sinal.
- O gate atual de `outro >= 20%` continua no relatório como **alarme**, não como
  veredito: ele diz "vá ler os `outro`", que foi exatamente o que funcionou aqui.

---

## 5. O que mudar no código

A migration `20260815213832_digestao_de_regras.sql` **ainda não foi aplicada**.
Então o CHECK da lista fechada se edita no lugar, sem migration nova.

1. `supabase/migrations/20260815213832_digestao_de_regras.sql` — acrescentar
   `'contradicao_interna'`, `'precedencia_de_fonte'`, `'criterio_discricionario'`
   ao CHECK de `digest_ambiguidades.tipo`. Não criar migration nova.
2. Prompt de digestão — as três definições novas com os trechos-exemplo acima, e
   as duas definições reescritas (`escopo_de_entidade`, `formato_do_mercado`).
3. `contradicao_interna` exige **dois trechos**. Se o schema de `trecho` for um
   campo único, permitir array nesse tipo (e só nesse), ou um segundo campo
   `trecho_conflito` obrigatório quando `tipo = 'contradicao_interna'` — via CHECK,
   não via instrução. Estrutura restringe, instrução não.
4. Validação de `trecho` verbatim continua valendo pros dois.
5. Relatório: `contradicao_interna` sai destacado no topo, separado dos outros
   tipos. É o achado que vale dinheiro; não pode ficar no meio de uma tabela.

Não mexer em `max_tokens` (32000) nem em `digest_timeout_ms` (300000).

---

## 6. Ordem de execução

1. Aplicar as mudanças acima.
2. **Smoke test em n=10**, mesma amostra ancorada (`--amostra-de=v1`). Critério de
   passagem: roda, valida, nada trunca, os 7 casos citados nesta página caem nos
   tipos que eu disse que caem. Não olhar percentual pra decidir nada.
3. Se passar: **rodar os 752**. ~US$ 2.70, ~7h no timeout atual. Escrever o
   artefato completo em `probes/digest/`.
4. Não comparar v3 vs v4 por número. A v4 existe porque `outro` a 30% apontava
   buraco na lista e eu li os 7. O critério de sucesso é `outro` cair perto de
   zero **nos 752** — aí sim n dá conta.

---

## Como ficou implementado

- **Lista fechada** — `TIPOS_AMBIGUIDADE_V4` em `src/digest/prompts.ts`, com
  `contradicao_interna` em PRIMEIRO lugar: a ordem da lista é a ordem das tabelas
  do relatório. As listas da v2 e da v3 não foram editadas — a taxa de `outro`
  daquelas rodadas é sobre os valores que aqueles schemas ofereceram.
- **Os dois trechos** — coluna `trecho_conflito` em `digest_ambiguidades`, com
  CHECK dos dois lados: obrigatória em `contradicao_interna`, NULL em todo o
  resto. Sem o segundo lado, `where trecho_conflito is not null` deixaria de ser
  a lista das contradições.
- **A conferência verbatim** — as DUAS passagens são procuradas na regra, com o
  mesmo piso de 10 caracteres e a mesma normalização das pegadinhas. Contradição
  que não se sustenta é DESCARTADA (o item, não a digestão) e CONTADA em
  `Descartes.contradicaoSemSegundoTrecho` e `contradicaoNaoAncorada`.

  Nota sobre o item 4 desta página: a validação verbatim **não existia** para as
  ambiguidades antes da v4 — só para as pegadinhas. Ela entra aqui apenas em
  `contradicao_interna`, que é a única categoria que afirma algo sobre duas
  passagens ao mesmo tempo. Estendê-la às outras onze mexeria na contagem por
  tipo, que é o que a v4 se propôs a medir. Fica como pendência declarada.
- **O relatório** — seção `## ⚠️ Contradições internas` no topo, antes das
  medidas, com as duas passagens em bloco de citação. Some inteira quando não há
  contradição: um "nenhuma" fixo no topo de toda rodada treina quem lê a pular.
- **O gate de `outro`** — reescrito como alarme ("vá LER os `outro`"), e um aviso
  novo abaixo de n=100 diz que os percentuais daquele relatório não sustentam
  "ficou melhor", com os três números da v3 (20,0% / 6,7% / 30,4%) na cara.
