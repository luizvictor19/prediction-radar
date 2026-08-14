# Prompt — Ajuste da lista do radar

Pequeno. Reaproveita `probes/radar/janela.json` com `--reuse` — **não revarrer**.
Nenhuma escrita no banco, nenhum LLM, não commitar.

A lista v1 tem 40 nomes e uns 15 casos de verdade. Três defeitos, e os três são
meus — o prompt anterior não pediu o que precisava.

---

## Defeito 1 — filtrei liquidez e esqueci volume

Liquidez é ordem parada no livro. **Volume é gente negociando.** A tese é "sai
notícia → o preço exagera → volta", e mercado que ninguém negocia não exagera.

O caso que escancara: *"Government shutdown by October 1"* tem US$ 13 mil de
liquidez e **US$ 1 de volume em 24h**. 18 dos 40 estão nesse estado.

**Adicione piso de volume 24h.** Não invente o número: reporte a distribuição de
`volume24hr` na faixa negociável (p10/mediana/p90), escolha o piso que ainda
deixa candidatos suficientes, e **justifique** — como você fez com o piso de
liquidez reaproveitando `analyst_min_liquidity_usd`.

---

## Defeito 2 — sete mercados são a mesma notícia

Irã aparece em 7 dos 40 (acordo nuclear, bloqueio, reunião diplomática ×2,
cessar-fogo, Ormuz ×2). O teto de 2 por evento passou porque são **eventos**
diferentes — mas é **um assunto**. Se o Irã fecha acordo, os sete andam juntos.

São uma observação contada sete vezes, e isso infla a amostra sem informar nada.
Mesmo defeito de contar dois checkpoints da mesma partida como duas evidências.

**Agrupe por assunto e ponha teto por grupo.** `scripts/lib/market-pairing.ts` já
extrai entidades e mede proximidade textual — reaproveite em vez de escrever
outro. Teto sugerido: **3 por assunto**, mantendo os de maior volume. Diga qual
teto usou e quantos grupos saíram.

---

## Defeito 3 — três pares são espelho

- BoJ "sem mudança" 0,27 / "+25 bps" 0,72
- Fed "pausa 3×" 0,71 / "decide diferente" 0,28
- Banco da Rússia "corta" 0,38 / "não muda" 0,62

Somam ~1,00. Julgar os dois é julgar um.

**Dentro do mesmo evento, se dois mercados têm preço YES somando entre 0,97 e
1,03, mantenha só um** — o de maior volume. Reporte quantos caíram por isso.

---

## E marque tese vs controle

A lista sai com uma coluna `papel`:

- **`tese`** — regra longa, é onde a leitura cuidadosa deveria dar vantagem
- **`controle`** — regra curta e mecânica (spread de NFL, over/under), onde ler
  com atenção **não** deveria ajudar

O controle não é enchimento: se no fim eu bater o mercado igual nos dois, o que
achei foi sorte, não leitura. Mire em **~8 de controle**, e eles precisam passar
no mesmo piso de volume — controle que não negocia não serve de comparação.

Corte pela mediana da descrição do universo (975) para separar os dois papéis, ou
proponha corte melhor e diga qual.

---

## Saída

Mesmo formato, em `probes/radar/lista-candidata-v2.md`, com a coluna `papel` e
**volume 24h em destaque**. Mantenha o funil impresso: quantos caíram em cada
filtro novo.

Se depois de tudo sobrarem menos de 30, **não afrouxe para completar** — reporte
quantos deu e por quê. Lista curta e honesta vale mais que 40 com enchimento; foi
o enchimento que criou o problema desta vez.

---

## Ao terminar, em três linhas

1. o piso de volume que você escolheu e por quê, e quantos caíram nele
2. quantos assuntos distintos sobraram, e quantos caíram por teto de assunto e
   por espelho
3. quantos de tese e quantos de controle, e o volume mediano de cada grupo
