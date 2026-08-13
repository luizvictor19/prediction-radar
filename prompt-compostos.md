# Prompt — Contagem de mercados compostos

Sondagem pequena. **Alvo: menos de 20 minutos.** Um script, uma resposta, nada
mais. Se você se pegar desenhando camada, parou de fazer o que foi pedido.

**Zero LLM. Zero custo. Zero escrita no banco.**

---

## A pergunta

Mercado composto é o que depende de dois fatos ao mesmo tempo: "A e B", "A antes
de B", "X ganha e Y perde", "A sem B".

Eles interessam porque têm piso e teto aritméticos (limites de Fréchet):

```
P(A e B) <= min(P(A), P(B))
P(A e B) >= P(A) + P(B) - 1
```

Preço fora desse intervalo é **impossível**, não é opinião. Mas isso só serve se
os mercados de A e de B existirem separados — sem as pernas, não há conta.

**A fase 2 do extrator propôs ZERO conjunções em 927 relações.** Ou a amostra
(tênis de mesa) não tinha nenhuma, ou composto é raro no Polymarket. Esta
contagem decide qual.

---

## O que fazer

`scripts/probe-mercados-compostos.ts`. Reaproveite `scripts/lib/probe-net.ts` e
o que já existe em `scripts/probe-polymarket-universe.ts` — inclusive o cache de
estratos, se ajudar.

Sobre mercados **abertos**, casando texto da pergunta e da `description`:

1. **Conte quantos batem em padrão de composto.** Sugestões de padrão — ajuste
   se achar melhor, e **diga quais usou**: ` and `, `both `, ` before `,
   ` after `, ` without `, ` while `, `same day`, `sweep`.

2. **Meça a precisão do seu casador.** Sorteie **50** dos que bateram, imprima a
   pergunta inteira de cada um, e classifique à mão quantos são compostos DE
   VERDADE.

   > `and` é traiçoeiro. "between $90 and $100" é faixa, não composto.
   > "Trump and Musk meet" é um evento só. Se a precisão for baixa, o número
   > grosso não vale nada — reporte a precisão junto, sempre.

3. **O número que realmente decide:** dos compostos de verdade, em quantos as
   duas pernas (A e B) **também existem como mercado separado aberto**? Case por
   evento, série, ou sobreposição forte de texto — o que funcionar.

4. **Liquidez.** Pros que têm as duas pernas, reporte volume 24h e profundidade
   no topo do livro. Já sabemos que profundidade mata: mediana de US$ 15 na
   sondagem passada.

---

## Limites

- Nenhuma chamada a modelo. Nenhuma escrita no banco. Nenhuma migration.
- Não toque em `src/`. Script em `scripts/`, corpo cru em `probes/compostos/`.
- Espace as chamadas e reporte quantas gastou.
- `--dry-run` que dimensiona antes de paginar.
- Não commite.
- Livro vazio = descarte contado, **nunca** mid 0,50.

---

## Ao terminar, em quatro linhas

1. quantos mercados abertos varridos, e quantos bateram em padrão de composto
2. **precisão do casador** na amostra de 50 conferida à mão
3. **quantos compostos de verdade têm as DUAS pernas abertas** — este é o número
4. a liquidez desses: volume 24h e profundidade medianos

Não conclua se há edge. Esta sondagem não mede preço errado. Ela responde se
existe população suficiente pra valer olhar preço depois.

Se a linha 3 vier abaixo de umas poucas dezenas, a ideia morre aqui e custou
vinte minutos.
