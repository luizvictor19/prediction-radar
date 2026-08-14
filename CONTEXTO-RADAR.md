# Contexto — onde o projeto está (14/08/2026)

Leia isto antes de qualquer coisa. Depois leia `CLAUDE.md` para as regras
inegociáveis.

---

## O que mudou: o projeto pivotou

O sistema **parou de tentar prever** e virou um **radar**: ele vigia preço de
mercados do Polymarket e o dono julga; o sistema não decide nada.

**Por quê:** oito hipóteses de edge foram medidas e todas deram negativo. A do
agente analista deu skill −0,029 sobre n=167 — ele não bate o preço. O README
tem a lista das oito com o número que matou cada uma.

**A tese nova:** *o mercado precifica a MANCHETE e resolve pela REGRA.* A
diferença entre as duas é onde o dono opera. Isso é **leitura**, não previsão —
não exige ser mais esperto que o mercado, exige ler o regulamento que quase
ninguém lê (mediana de 1.262 caracteres, preenchido em 100% dos mercados).

**O produto da fase atual:** série de preço acumulando, para o dono olhar no fim
de semana, anotar a probabilidade dele *antes* do desfecho, e em ~2 meses medir
o Brier dele contra o do mercado. A máquina de medição já existe (`src/eval/`) —
ela não liga se a previsão veio de um modelo ou de uma pessoa.

---

## Estado do sistema

**Desligado** (migrations aplicadas): analista, enricher da OddsPapi, descoberta
e watchlist de esports, resolver, enricher. `discovery_slug_prefixes = '{}'`.
Nada gasta e nada coleta hoje, fora heartbeat, alerta de saúde e bot.

**Aplicadas nesta virada:**

```
20260813210118  parar_analista_e_oddspapi
20260813210119  retencao_protege_radar        (coluna events.radar_tracked)
20260813224149  coletor_radar
20260813224150  retencao_manual_protege_radar
20260814000233  desligar_esports
20260814021300  partição de polymarket_snapshots + teto 600
```

**Dado preservado:** nada foi apagado. `esports_snapshots` tem ~14,26M linhas e
fica. `esports_slug_patterns()` devolve `{cs2-%,lol-%,dota2-%}` — o fallback
embutido protege o histórico mesmo com a lista de prefixos vazia.

**Próxima tarefa:** `prompt-livro-um-lado.md`.

---

## Princípios de desenho, decididos e não negociáveis

**1. Filtra na coleta o que NÃO muda; filtra na view o que muda.**
Categoria não muda → cabe na coleta. Preço muda → não cabe, senão o mercado sai
do roster exatamente quando se move, que é o evento a estudar. Mesma coisa para
volume mínimo e tamanho de descrição: viram `where` na view.

**2. `radar_tracked` é marca de proteção e SÓ CRESCE.**
Nunca desmarcar. Mercado sai do roster porque resolveu — e desmarcá-lo entrega a
série ao ramo `finalized` da retenção, que apaga sem condição de idade, no
instante em que o desfecho torna o dado valioso. É o dano dos 1.755 do README.

**3. Assunto é COLUNA, não filtro.**
22 mercados sobre o Irã são 22 oportunidades de operar e **1 observação** na hora
de medir. Agrupar é problema da medição, não da coleta.

**4. `mid_price` é NULO quando falta um lado do livro.**
Nunca 0,50, nunca o lado único repetido. Livro vazio com mid 0,50 já fabricou um
gap falso de +0,13 na frente do XTracker.

**5. Teto sai de medição, não de chute.**
O gargalo não é a API (chamadas são em lote, mil mercados custam ~1,3k/dia numa
API gratuita) — é disco.

**6. Código morto o git lembra; dado morto some pra sempre.**
Apagar código: livre. Apagar dado: nunca.

---

## Armadilhas que este projeto já pagou para aprender

- **Descarte silencioso** — todo filtro conta e reporta o que derrubou, com
  motivo. Já pegou 29% de linhas sumindo numa sonda e 10% de estrato numa outra.
- **Livro vazio = mid 0,50 por aritmética**, não por consenso.
- **Significado de campo** — `event.startDate` é data de criação; um `endDate`
  de outra API era exclusivo; `endDate` da Gamma é a data marcada do evento e
  não o instante da resolução. Conferir antes de filtrar por qualquer campo.
- **Retenção** — o ramo `finalized` apaga série de evento resolvido **sem
  condição de idade**. Foi contornado por exceção, nunca consertado.
- **Extrapolar de amostra pequena** — aconteceu quatro vezes, sempre para pior.
- **Inchaço de índice** — `polymarket_snapshots` já chegou a 2.087 MB sendo
  1.492 MB de um único índice sobre 80 MB de dado.

---

## Operacional

- **Migrations: escrever e parar.** Quem aplica é o dono (`supabase db push`).
- **Banco: leitura pode, escrita não.** `SELECT` para diagnóstico; nada de
  `INSERT`/`UPDATE`/`DELETE`/DDL na mão.
- **Nunca ler `.env`.**
- **Não commitar** sem pedido explícito.
- **DNS local**: esta máquina só resolve `polymarket.com` com VPN ligada. Teste:
  `getent hosts gamma-api.polymarket.com`. No Railway não acontece.
