# Prompt — Sondagem de atraso: o spread do lado lento

**Isto é reconhecimento, não construção.** Alvo: menos de 30 minutos, nenhuma
abstração nova, nenhum arquivo em `src/`. Um script de sondagem e uma resposta.

Se você se pegar desenhando camadas, parou de fazer o que foi pedido.

---

## A ideia que está sendo testada

Mercados ligados por lógica não compartilham livro de ordens. Sai uma notícia,
o mercado óbvio reage em segundos, o mercado ligado por raciocínio de segundo
grau demora — porque ninguém está olhando para ele.

A operação seria comprar no lento antes de ele acordar.

**A objeção que mata:** o atraso existe porque ninguém olha; ninguém olha porque
é ilíquido; ilíquido tem spread largo; spread largo come a vantagem. São o mesmo
problema visto de três ângulos.

**Esta sondagem mede o terceiro ângulo, que é o mais barato de medir.**

---

## PARTE 1 — O spread do lado lento

`scripts/probe-lead-lag-spread.ts`. Reaproveite `scripts/lib/probe-net.ts`.

### Escolher os pares — sem modelo nenhum

Zero LLM nesta sondagem. Os pares saem de estrutura, não de leitura:

- **escadas de data** — mesmo assunto, prazos diferentes ("... by September" /
  "... by December"). `A por setembro` implica `A por dezembro`.
- **escadas de valor** — mesmo assunto, limiares diferentes.
- **partições** — eventos com `negRisk: true`, onde a API já declara o conjunto.

**Fora: esporte.** Tênis de mesa, futebol, LoL, beisebol, e-sports. A frente
anterior já se afogou neles e eles não são o alvo. Priorize política, macro,
geopolítica, tecnologia, cripto de prazo longo (não vela de 15 minutos).

**~60 pares bastam.** Não pagine o universo inteiro; isso já custou 1h36 uma vez.

### Quem é o rápido e quem é o lento

Mecânico, sem julgamento: dentro do par, o **lado observado** é o de maior volume
24h; o **lado lento** é o outro. Reporte a razão entre os dois volumes — se for
perto de 1, o par não serve para a hipótese e sai da conta.

### O que medir, por mercado

Do livro de ordens da CLOB (`https://clob.polymarket.com`, público):

| medida | por quê |
| --- | --- |
| melhor bid, melhor ask, **spread em centavos** | é o custo de entrar e sair |
| **profundidade no topo do livro, em dólares** | vantagem × tamanho minúsculo = nada |
| volume 24h | define rápido vs lento |
| livro vazio? | mid = 0,50 por aritmética — **descarte, não conte como 50%** |

O último já fabricou edge falso na frente do XTracker. Conte os descartes e
reporte com sinal.

### O critério de morte, declarado ANTES do resultado

O ganho plausível de uma notícia é 2 a 4 centavos, e você captura parte dele. O
custo de ida e volta é **um spread inteiro**, não meio.

> **Se menos de 20% dos mercados do lado lento tiverem spread ≤ 2¢, a ideia não
> paga como operação manual, e a frente morre aqui.**

Reporte a distribuição inteira — mediana, p25, p75 —, não só se passou. E reporte
a profundidade mediana em dólares junto: spread bom com US$ 40 de profundidade
também é não.

---

## PARTE 2 — Que histórico de preço nós temos

Isso decide se a próxima etapa é de dias ou de semanas. Se a granularidade for
grossa demais, o atraso é invisível no que temos e precisa de coletor novo.

Sobre `polymarket_snapshots`, responda:

1. quantos mercados distintos têm série
2. desde quando, até quando
3. **intervalo mediano entre capturas do mesmo mercado** — este é o número que
   importa
4. quantos desses mercados são de fora de esporte

**`polymarket_snapshots` é tabela grande e o timeout do PostgREST é 8s.**
Conforme `CLAUDE.md`: **mostre a query antes de rodar**, use índice, e ponha
`LIMIT`. Amostra estratificada serve — não precisa varrer tudo. Se o plano não
estiver óbvio, mostre e espere.

Só `SELECT`. Nada de escrita, nada de migration.

---

## Limites

- Zero chamada a modelo. Zero custo de API paga.
- Não toque em `src/`. Um script em `scripts/`, e o corpo cru de uma resposta em
  `probes/lead-lag/`.
- Espace as chamadas à CLOB e reporte quantas gastou.
- `--dry-run` que diz quantos pares e quantas chamadas antes de rodar.
- Não commite.
- **Não conserte o bug de duplicação nem mexa no extrator agora.** Outra frente.

---

## Ao terminar, em quatro linhas

1. quantos pares ligados você achou fora de esporte, e de que tipo
2. **a distribuição de spread do lado lento** — mediana, p25, p75, e o % com ≤ 2¢
3. a profundidade mediana em dólares no topo do livro do lado lento
4. **o intervalo mediano entre capturas** no histórico que temos, e quantos
   mercados de fora de esporte têm série

A 2 e a 3 juntas matam ou liberam a frente. A 4 diz se a medição seguinte custa
dias ou semanas.

Não conclua se há atraso — esta sondagem não mede atraso. Ela mede se valeria a
pena medir.
