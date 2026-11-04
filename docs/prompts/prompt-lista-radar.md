# Prompt — Parar o gasto, conferir a retenção, montar a lista

Três coisas, nesta ordem. **Nenhuma escrita no banco.** Alvo: uma rodada.

Frente nova: o sistema deixa de tentar prever e passa a vigiar preço para eu
julgar. A tese é que **o mercado precifica a manchete e resolve pela regra**, e a
diferença entre as duas é onde eu opero. Esta rodada só prepara o terreno.

---

## PARTE 1 — Parar o gasto

O analista está medido em skill −0,029 sobre n=167. Ele paga para perder.

- Desligar o **analista** e o **enricher da OddsPapi** pelo kill switch do config.
- **Não apagar código.** Só desligar.
- Não encostar em heartbeat, alerta de saúde nem bot.
- Confirmar no relatório qual flag foi usada e o que exatamente parou de rodar.

---

## PARTE 2 — Conferir a retenção antes de qualquer coleta

**Isto é bloqueante.** A retenção antiga apagava snapshot de evento resolvido sem
condição de idade e destruiu o histórico — está no README como dano permanente,
zero de 1.755 partidas recuperáveis.

Leia `src/jobs/retention.ts` e responda:

1. Qual a regra hoje, em uma frase.
2. Ela apagaria linhas novas de `polymarket_snapshots`? Em que condição?
3. Se sim, **escreva a correção mas não aplique** — e diga qual é.

Se a retenção ainda comer o dado, o resto do plano é areia. Reporte isso em
destaque.

---

## PARTE 3 — A lista de mercados a vigiar

`scripts/montar-lista-radar.ts`. Reaproveite `scripts/lib/probe-net.ts`.

### Antes de filtrar por prazo, descubra o que `endDate` significa

Puxei mercados abertos da Gamma e **todos voltaram com `endDate` de 2026-07-31**,
data já passada. Ou estão pendentes de resolução, ou o campo quer dizer outra
coisa.

Este projeto já se queimou duas vezes com significado de campo: `event.startDate`
era data de criação, e um `endDate` de outra API era exclusivo. **Confira contra
alguns mercados conhecidos antes de usar prazo como filtro** e diga o que
concluiu. Se `endDate` não servir, ache o campo que serve.

### Os critérios

Sobre mercados **abertos**, nesta ordem:

1. resolvem nas próximas **4 a 8 semanas** (pelo campo que você validou acima)
2. preço entre **0,15 e 0,85** — fora disso não cabe reação exagerada
3. liquidez acima de um piso que dê para operar — **escolha o piso e justifique**
4. ordenar por **tamanho da `description`** — é a proxy de "regra complicada", que
   é onde se lê errado
5. **teto por categoria**, para a lista não virar monocultura do tema que tiver
   mais mercado aberto. Escolha o teto e diga qual foi.
6. entregar **40**

Reporte a **distribuição do tamanho da descrição** nos escolhidos contra o
universo. Se os 40 não forem visivelmente mais compridos que a média, a proxy não
discrimina e vale dizer isso em vez de fingir que funcionou.

### A saída

Um markdown em `probes/radar/lista-candidata.md`, uma linha por mercado:
pergunta, categoria, preço, liquidez, volume 24h, prazo, tamanho da descrição, e
o link.

**Eu aprovo a lista antes de qualquer coleta.** Marcar `tracked` é escrita no
banco e é decisão minha (H4).

---

## Limites

- Zero LLM. Zero custo de API paga.
- **Zero escrita no banco.** Só `SELECT` e a Gamma, que é pública.
- Nenhuma migration aplicada. Escrever, se precisar, e parar.
- Não construa o coletor, nem view, nem tela. Só a lista.
- Espace as chamadas e reporte quantas gastou.
- `--dry-run` que dimensiona antes de paginar.
- Não commite.

---

## Ao terminar, em quatro linhas

1. o que foi desligado, e como confirmar que parou
2. **a retenção comeria o dado novo? sim ou não, e a correção se for sim**
3. o que `endDate` significa de verdade, e qual campo você usou para prazo
4. os 40, e se a proxy de descrição discriminou ou não

A 2 libera ou trava tudo que vem depois.
