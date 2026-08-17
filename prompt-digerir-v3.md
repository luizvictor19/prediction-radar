# Prompt — Digestão de regras, v3

A v2 provou uma coisa e falhou em duas, e o padrão está claro:

> **Instrução não restringe. Estrutura restringe.**

A lista fechada de ambiguidades funcionou — 91,7% classificado, `outro` em 8,3%.
Os dois pedidos feitos em texto falharam: a contagem de pegadinhas não se moveu
(23 na v1, 23 na v2) e a severidade inflou (75% viraram `muda_resultado`).

Esta rodada troca as duas instruções por mecanismo.

---

## Mudança 1 — pegadinha obrigada a citar a regra

Cada pegadinha ganha campo `trecho`: **substring literal da `description`**.

Valide em código: se o `trecho` não aparece na `description`, a pegadinha é
descartada. Não é confiança no modelo — é conferência.

**Por que isso resolve o enchimento:** não existe trecho da regra que sustente
"market cap não é receita". A regra só diz market cap. Sem trecho, o item não
entra. O enchimento morre por falta de fonte, não por instrução.

### E o trecho tem que ser ÚNICO

Duas pegadinhas não podem citar o mesmo trecho. Se citam, é a mesma observação
dita de dois jeitos — mantenha a mais específica e descarte a outra.

Isso limita a contagem sozinho: **o número de pegadinhas passa a ser o número de
passagens distintas que criam armadilha**, e não um número que o modelo escolhe.

Reporte quantas foram descartadas por trecho inexistente e quantas por trecho
repetido. Os dois números medem o enchimento diretamente.

---

## Mudança 2 — `muda_resultado` exige cenário

75% marcados como "muda o resultado" é alto demais para ser verdade. Quando o
nível mais forte não custa nada, o modelo escolhe o mais forte — é o mesmo
defeito de um campo de confiança que não separa nada.

**Para marcar `muda_resultado`, é obrigatório preencher `cenario`:** uma situação
concreta em que a leitura ingênua e a regra dão respostas diferentes.

Formato: *"se acontecer X, quem leu só o título espera SIM, mas a regra dá NÃO."*

Sem `cenario` preenchido, a severidade cai para `detalhe` automaticamente. Em
código, não por pedido.

**Por que resolve:** "a posição durante o dia não conta, só o fechamento" não
produz cenário — não existe situação em que alguém perca dinheiro por isso, já
que qualquer um que leia a regra vê "as of market close". Já "fechamento
exatamente em US$ 76.000 resolve NÃO" produz cenário na hora.

`muda_timing` também pede cenário, mas de outro tipo: *quando* o mercado resolve
contra quando o leitor espera.

---

## Mudança 3 — uma categoria nova de ambiguidade

Os dois casos que caíram em `outro` são o mesmo: **"as of market close"** sem
dizer qual fechamento — qual bolsa, qual fuso, qual referência.

É distinto de `fuso_ausente` (que é só o fuso) e de `fonte_vaga` (que é quem
decide). Aqui o que falta é **qual instante conta**.

Proponho `momento_ambiguo` e a definição é sua para ajustar: *a regra nomeia um
instante de medição que admite mais de um ponto no tempo*.

Se discordar do nome ou do recorte, proponha outro e justifique — mas não deixe
isso em `outro`, porque apareceu em 2 de 10 e vai repetir.

---

## Como rodar

**10 mercados NOVOS**, fora dos 10 da v1/v2. A amostra anterior está contaminada:
os exemplos de PASSA e NÃO PASSA que eu pus no prompt saíram de 7 daqueles 10,
então o modelo leu as respostas antes de responder.

Nesta rodada os exemplos continuam no prompt — e agora são legítimos, porque vêm
de mercados que não estão na amostra. **Garanta a não-sobreposição em código**,
não no olho.

Ancore a amostra por `event_id` e grave a lista, como você fez com
`--amostra-de`. Semente sozinha não reproduz: o roster foi de 744 para 752 entre
ontem e hoje.

`max_tokens` em 16.000 — a v2 truncou 40% em 8.000 e a v3 pede mais campos ainda.

**Grave falha no artefato**, como você corrigiu. Digestão recusada que some do
arquivo é falha que some da análise.

---

## Limites

- Migration escrita, nunca aplicada. Não commite. Não leia `.env`.
- `deepseek-v4-flash`.
- Não avance para o degrau 2.
- Não julgue se melhorou — a comparação é minha.

---

## Ao terminar, em quatro linhas

1. quantas pegadinhas por mercado agora, e quantos mercados vieram com zero
2. **quantas foram descartadas por trecho inexistente e quantas por trecho
   repetido** — é a medida direta do enchimento
3. a distribuição de severidade depois da exigência de cenário
4. onde está o arquivo, e a taxa de `outro` com a categoria nova
