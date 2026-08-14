# Prompt — O coletor do radar

Frente nova. O sistema para de tentar prever e passa a **vigiar preço para eu
julgar**. A tese: o mercado precifica a manchete e resolve pela regra, e a
diferença entre as duas é onde eu opero.

Esta rodada entrega **um job que mantém uma lista viva e grava preço dela**.
Nada de view, nada de tela, nada de detector.

---

## A lista é uma REGRA, não uma lista fixa

29 mercados congelados acabam quando eles resolvem. O roster se recalcula sozinho
a cada ciclo: mercado novo que passa entra, mercado que resolve sai.

### Filtro de assunto — o que eu acompanho

Só entra mercado cujas tags/categoria caiam em: **IA e tecnologia**, **Brasil
(política e economia)**, **macro e mercados** (Fed, juros, inflação, cripto,
bolsa), **geopolítica e conflitos**.

Motivo, e ele não é gosto: eu preciso **perceber que a notícia saiu** sem ir
procurar. Mercado sobre eleição no Marrocos se move e eu fico olhando sem saber o
quê. Se a categoria da Gamma não separar isso direito, diga como você mapeou e
mostre exemplos do que entrou e do que ficou de fora.

**Esporte fica de fora deste coletor** — ver a Parte 3.

### Filtro quantitativo

| filtro | valor | por quê |
| --- | --- | --- |
| resolve em | **7 a 120 dias** | o 28–56 anterior era arbitrário meu e cortou 3/4 do universo |
| preço YES | 0,15–0,85 | fora disso não cabe reação de 2–4¢ |
| volume 24h | **≥ 500 USD** | é o que faz a tese existir — sem negociação não há exagero |
| liquidez | **≥ 1,5k USD** | opero pequeno; o 5k vinha de `analyst_min_liquidity_usd`, que servia a outra decisão |
| book | dois lados, spread ≤ 0,10 | livro vazio tem mid 0,50 por aritmética, e 0,50 cai no meio da faixa |

Espelhos (mesmo evento, YES somando 0,97–1,03) → fica um, o de maior volume.
Teto de **3 por assunto**, reaproveitando o agrupamento do `market-pairing`.

**Teto duro de roster: 150 mercados.** Se passar disso, corte pelo volume e diga
quantos ficaram de fora — coleta que cresce sozinha sem ninguém ver é como a
fatura aparece.

---

## PARTE 1 — O job

Um componente novo, no padrão dos que já existem: lock de ciclo, heartbeat,
kill switch em config, timeout, e contadores de descarte por motivo.

Dois passos por ciclo:

1. **Renovar o roster** — achar quem passa na regra, gravar em `events`, marcar
   `radar_tracked = true`. Quem deixou de passar sai da marcação.
2. **Fotografar** — preço de cada um do roster para `polymarket_snapshots`
   (`best_bid`, `best_ask`, `mid_price`, `spread`, `bid_depth`, `ask_depth`,
   `volume_24h`). As colunas já existem, não invente tabela.

O passo 1 não precisa rodar todo ciclo — proponha a frequência e justifique.

**Cadência da foto:** minha tese é reação a notícia que se desfaz em horas ou
dias, e eu julgo em lote no fim de semana. Proponha o intervalo e justifique
contra esse uso, não contra o que a watchlist de esports faz (ela é ancorada em
hora de partida, que aqui não existe).

Escrita no banco **pelo job em produção é normal** — o que eu não quero é você
rodando `INSERT`/`UPDATE`/DDL na mão, nem aplicando migration.

---

## PARTE 2 — A retenção precisa reconhecer o roster

`radar_tracked` já existe e a função de retenção já a protege — foi a migration
`20260813210119`, aplicada. **Confirme** que o caminho está fechado: mercado
marcado pelo job novo sobrevive ao ramo `old` e ao `finalized`.

Se sobrar buraco, escreva a correção e **não aplique**.

Isto é bloqueante: a retenção antiga já destruiu 1.755 séries e o README chama o
dano de permanente.

---

## PARTE 3 — Esporte, e o que NÃO fazer

- **CS2 e LoL já são coletados** pelo watchlist de esports, em `esports_snapshots`.
  **Não duplique, não migre, não encoste.**
- **Futebol das ligas principais** eu quero coletar. Verifique se basta acrescentar
  prefixo de slug em `collect_only_prefixes` e reusar o pipeline de esports. Se
  bastar, **escreva a migration e não aplique**, dizendo quais prefixos e como
  você confirmou que casam. Se não bastar, diga o que faltaria — não construa.

O radar vai ler das duas tabelas; unir é problema da camada de view, na próxima
rodada. Não resolva isso agora.

---

## Limites

- Zero LLM neste componente.
- Migration escrita, nunca aplicada.
- Não encoste em `src/verticals/`, `src/jobs/esports-*`, nem no watchlist.
- Testes sem rede para a regra de seleção, o espelho e os tetos.
- Espace as chamadas à Gamma/CLOB e reporte quantas o ciclo gasta.
- `--dry-run` que imprime o roster e o custo de um ciclo sem gravar nada.
- Não commite.

---

## Ao terminar, em quatro linhas

1. quantos mercados o roster tem hoje, por assunto, e quantos ficaram no teto
2. a cadência que você escolheu e a justificativa, e quantas chamadas custa um
   ciclo
3. a retenção protege o roster novo? sim ou não, e a correção se for não
4. futebol: basta prefixo? quais, e como você confirmou
