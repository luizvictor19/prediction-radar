# Prompt — Um lado de livro basta, e a tag que falta

Rodada pequena. Dois consertos e uma conferência.

---

## PARTE 1 — Conferir a partição, que acabei de aplicar

Antes de qualquer coisa, confirme que ficou como planejado:

1. `polymarket_snapshots` é particionada, e por mês
2. as 96k linhas estão na partição `_historico`, e nenhuma se perdeu
3. `polymarket_snapshots_legado` ainda existe (o drop é meu, depois da conferência)
4. `run_snapshot_retention_batch` e `radar_tracked` continuam funcionando
5. quais migrations ficaram aplicadas — inclusive se o teto de 600 entrou junto

Se algo não bateu, **pare e reporte** antes de mexer no coletor.

---

## PARTE 2 — Exigir UM lado de livro, não os dois

Erro meu, e você mediu o custo: o critério "livro dos dois lados" descarta **274
mercados**, entre eles os candidatos mais líquidos da eleição brasileira —
Eduardo Leite (1,8M), Aldo Rebelo (1,6M), Massa Jr. (1,6M). Azarões com venda e
sem compra.

Eu escrevi esse critério pensando em **livro vazio**, porque livro vazio dá mid
0,50 por aritmética e isso já fabricou resultado falso aqui. Mas azarão com um
lado só **não é livro vazio** — ele tem preço real, e é exatamente onde uma
notícia move forte. É a tese em estado puro, e eu estava jogando fora.

### O que muda

- coleta exige **pelo menos um lado** (bid **ou** ask)
- descarta só quando **os dois** estão ausentes — aí sim não há preço
- grava `best_bid` e `best_ask` como vierem; as colunas aceitam nulo

### A regra que não pode ser quebrada

**`mid_price` fica NULO quando falta um lado.** Nunca 0,50, nunca o lado único
repetido, nunca um chute.

Meio-preço passa a ser conta da view, onde nulo é resposta legítima. Escreva um
teste que falhe se `mid_price` sair não-nulo com um dos lados ausente — é a
armadilha que já produziu um resultado falso neste projeto e ela volta calada.

`spread` segue a mesma regra: nulo sem os dois lados.

Reporte quantos mercados voltam, a distribuição de liquidez deles, e quantos
ficam de fora por terem os dois lados vazios.

---

## PARTE 3 — A tag que falta

`pandemics` fica fora de todas as categorias, e leva junto Hantavírus (365k) e
Ebola (106k).

Mercado de pandemia é movido por notícia e tem regra cheia de condição ("a OMS
declarar...", "casos confirmados em N países"). É a tese em estado puro.

Adicione. Você decide se vira categoria própria ou entra numa existente — diga
qual escolheu e por quê, e quantos mercados isso traz.

As outras 18 exclusões que você achou (filmes de 2026, "Will Jesus Christ return
before 2027?", "Is Earth flat?") **deixe fora** — não é notícia que eu acompanho
e a regra não tem o que ler.

---

## Limites

- Zero LLM. Migration escrita, nunca aplicada. Não commite.
- Não construa view, tela nem alerta.
- Não ligue a coleta — só deixe pronta.
- `--dry-run` mostrando o roster novo.
- O DNS desta máquina não resolve `polymarket.com`; se o contorno for necessário
  de novo, **não o commite**.

---

## Ao terminar, em três linhas

1. a partição ficou certa? o que confere e o que não
2. quantos mercados o um-lado devolveu, e o roster novo por categoria
3. onde a tag de pandemia entrou, e quantos mercados trouxe
