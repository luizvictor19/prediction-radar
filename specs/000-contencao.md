# Spec 000 — Contenção e Coleta Dedicada de Esports

**Precede a Spec 001.** Nenhum item da 001 deve começar antes desta terminar.

## Diagnóstico (medido, não suposto)

### Já resolvido nesta sessão

| Item | Antes | Depois |
|---|---|---|
| `system_logs` | 755 MB / 2,7M linhas | 11 MB / 68k linhas |
| `polymarket_snapshots` | 2087 MB | 102 MB |
| Banco total | ~3,8 GB | ~1,1 GB |

O ganho em `polymarket_snapshots` foi index bloat: a tabela em si tinha só 80 MB;
`idx_snapshots_event_time` sozinho ocupava 1492 MB. Índice B-tree não recupera espaço
sozinho após DELETE — o autovacuum limpa a heap, não as páginas de índice.

**Isso volta.** A retenção continua deletando linhas em ciclo. Ou reindex agendado
(paliativo), ou particionamento com DROP PARTITION (definitivo). Ver item 3.

### Causa raiz dos timeouts

Os três detectores (`calendar_driven`, `cross_market_inter`, `hype_reality_gap`) falham
~2x/hora com `canceling statement due to statement timeout`.

Não é o Postgres: `statement_timeout` global é 120s e `service_role` não tem override.
As queries têm prefixo `pgrst_source`, ou seja passam por **PostgREST**, que aplica
timeout próprio de 8s.

E não são queries quebradas. `pg_stat_statements` mostra a origem real:

```
calls          total_seg   query
25.438.219      9.507      INSERT INTO events (upsert)
16.801.896      5.925      INSERT INTO polymarket_snapshots
16.486.299     10.732      INSERT INTO events (variante)
15.662.697     10.240      SELECT polymarket_snapshots por event_id
 1.976.576     10.301      SELECT polymarket_snapshots
```

Cada chamada custa 0-1ms — individualmente ótimas. Somadas são **dezenas de milhões de
round-trips HTTP** e horas de CPU acumulada. As queries de leitura dos detectores
(média 800-2400ms) competem com essa carga e, na cauda, ultrapassam os 8s do PostgREST.

**Timeout é sintoma. A causa é insert linha-a-linha.**

### `events`: 711 MB de dado real

Diferente de `polymarket_snapshots`: 711 MB de tabela contra 232 MB de índices,
`n_dead_tup` baixo. Não é bloat, é volume. 551k linhas a ~1,3 KB cada.

Composição por categoria:

| Categoria | Linhas | Volume médio |
|---|---|---|
| `crypto_fees_v2` | 283.772 | US$ 1.504 |
| `sports_fees_v2` | 194.651 | US$ 41.050 |
| `weather_fees` | 52.441 | US$ 1.549 |
| resto | ~20.000 | variado |

Crypto e weather = 61% das linhas e volume desprezível. É o alvo do item 2.

---

## Item 1 — Batch nos inserts

**Maior impacto, menor esforço. Fazer primeiro.**

O collector chama `.insert()` / `.upsert()` por linha dentro de loop. Trocar por chamada
única com array.

```typescript
// ANTES
for (const ev of events) {
  await supabase.from('events').upsert(ev, { onConflict: 'polymarket_id' });
}

// DEPOIS
const CHUNK = 500;
for (let i = 0; i < events.length; i += CHUNK) {
  const { error } = await supabase
    .from('events')
    .upsert(events.slice(i, i + CHUNK), { onConflict: 'polymarket_id' });
  if (error) { /* log e continua — não aborta o ciclo inteiro */ }
}
```

Aplicar em todos os call sites de escrita:
- upsert de `events` (as duas variantes que aparecem no `pg_stat_statements`)
- insert de `polymarket_snapshots` (as duas variantes)
- insert de `detected_signals`

Chunk de 500 é ponto de partida. Payload muito grande estoura limite do PostgREST;
muito pequeno não resolve. Ajustar se der erro de tamanho.

**Cuidado com semântica:** upsert em lote é uma transação só. Uma linha inválida
derruba o chunk inteiro. Logar `error` com o range do chunk para diagnóstico, e não
deixar o ciclo abortar por causa de um chunk.

**Verificação:** após o deploy, comparar `calls` em `pg_stat_statements` antes/depois
(zerar com `select pg_stat_statements_reset()`). Esperado: queda de 2 ordens de grandeza.

## Item 2 — Substituir a varredura por descoberta + watchlist

### Limites reais da Gamma API (medidos em 2026-08-04)

| Teste | Resultado |
|---|---|
| `offset=2000` | HTTP 200, 100 itens |
| `offset=2050` e acima | **HTTP 422** |
| Sem `order` | 422 no mesmo ponto |
| `limit=1&offset=2100` | 422 |
| `order=startDate` em offset alto | 422 no mesmo ponto |
| `tag=esports` | **ignorado** — devolve a lista default |
| `slug=X` (valor real) | funciona |
| `id=X` (valor real) | funciona, filtra corretamente |
| `id=A&id=B&...` repetido | funciona, **exige `limit` explícito** |
| 100 ids + `limit=100` | HTTP 200, 100 itens |

Conclusões:

1. **Teto rígido de offset em 2000.** Nenhuma ordenação escapa. Paginação profunda
   está descartada.
2. **A varredura nunca viu 46k markets.** Sempre foram os ~2000 primeiros do ranking
   de volume. O "46k → 1300 persistidos" do PROJECT.md nunca foi verdade.
3. **`limit` default é 20 e se aplica também ao filtro por `id`.** Sem `limit` explícito,
   um lote de 50 ids retorna 20 — silenciosamente. Falha calada, sem erro.

### O redesenho

A varredura por ranking de volume **deixa de existir**. Ela é estruturalmente cega ao
que interessa agora: mercados de esports nascem com `volume_24h = 0` e ficam no fundo
da ordenação, muito além da posição 2000. Confirmado nos dados — `cs2-yaw-guara`,
`cs2-justpl-enjoy` e os CBLoL criados durante esta sessão, todos com volume zero.

Três coletores, com papéis separados:

#### 2a. Descoberta

```
GET /markets?active=true&closed=false&limit=100&order=startDate&ascending=false
```

Pagina do mais recente para trás, **parando ao encontrar markets já conhecidos**
(N consecutivos já presentes em `events`). Em regime normal são 1-3 páginas por ciclo,
longe do teto de 2000.

Captura o market no minuto em que nasce — que é onde a série temporal pré-partida
começa, e é exatamente o que a varredura por volume nunca alcançou.

Filtro de vertical aplicado **na descoberta**, por prefixo de slug, lido de
`system_config` (não hardcoded, para religar sem deploy):

```typescript
const PREFIXOS_ATIVOS = ['cs2-', 'lol-', 'dota2-'];
```

Nota: nem todo market de esports segue `{jogo}-{codA}-{codB}-{data}`. Mercados de
qualificação aparecem como `will-furia-qualify-for-the-cblol-split-2-playoffs-...`.
Sem dois times não há partida — descartar na descoberta, mas registrar a contagem
para saber o volume desse formato.

#### 2b. Refresh da watchlist

```
GET /markets?limit=100&id=A&id=B&...   (até 100 por chamada)
```

Somente markets de esports já descobertos. Sem offset, sem teto.

**`limit` é obrigatório em toda chamada.** Omitir devolve 20 resultados sem erro —
o refresh perderia a maior parte da watchlist silenciosamente.

Verificação obrigatória: comparar a contagem de ids enviados com a de retornados,
e logar divergência. Ausência pode significar market resolvido (esperado) ou lote
truncado (bug).

#### 2c. Auto-resolver

Permanece como está.

### Poda do histórico

### 2b. Poda do histórico

Não deletar `events` cegamente: há FK de `polymarket_snapshots`, `detected_signals`
e possivelmente `my_bet_legs`. Ordem segura, sempre em lote:

```sql
-- 1. snapshots de eventos não-esports (deve sobrar pouco, retenção já roda)
-- 2. detected_signals de eventos não-esports
-- 3. eventos não-esports resolvidos/inativos, PRESERVANDO os que têm aposta
delete from events
where id in (
  select e.id from events e
  where e.polymarket_category in ('crypto_fees_v2','weather_fees','mentions_fees')
    and e.status in ('resolved','closed_manual','inactive')
    and not exists (select 1 from my_bet_legs l where l.event_id = e.id)
  limit 10000
);
```

Repetir até retornar 0. **Nunca sem `limit`** — foi o que travou o `retention_job`.

Depois: `vacuum full events` (fora do horário de coleta) ou o padrão de troca de tabela.

### 2c. Índice desnecessário

`events_title_trgm_idx` (GIN trigram no título) ocupa 122 MB — o maior da tabela —
e serve à função `search_events_by_title`. Se essa busca é usada raramente, o custo de
escrita a cada insert não se paga. Confirmar uso antes; se confirmado ocioso, dropar.

### 2d. Retenção esports-only

Já existem `run_snapshot_retention` e `run_snapshot_retention_batch` no banco.
A função em batch está corretamente escrita (usa `LIMIT batch_size`), mas o ramo
`finalized` faz join com `events` — verificar plano de execução.

Mudança necessária: retenção **nunca** deve apagar snapshot de mercado esports.
Adicionar cláusula de exclusão por prefixo de slug.

## Item 3 — `esports_snapshots`

Tabela dedicada, estreita e particionada. Resolve custo e bloat de uma vez.

```sql
create table esports_snapshots (
  event_id     uuid not null,
  captured_at  timestamptz not null,
  outcome      text not null,
  best_bid     numeric(6,4),
  best_ask     numeric(6,4),
  mid_price    numeric(6,4),
  volume_24h   numeric(14,2),
  liquidity    numeric(14,2)
) partition by range (captured_at);

create index on esports_snapshots (event_id, captured_at desc);
```

Sem `id` bigserial: a pkey sozinha custava 514 MB em `polymarket_snapshots` sem servir
a nenhuma query. `(event_id, captured_at, outcome)` já identifica a linha.

`numeric(6,4)` em vez de `numeric` livre: preço de prediction market vive em [0,1].

**Particionamento por dia.** Job diário cria a partição do dia seguinte e dropa as
antigas fora da janela de retenção. `DROP PARTITION` é instantâneo e **não gera bloat** —
é isso que impede o problema de índice de voltar.

Para esports a retenção é longa ou permanente: é a matéria-prima do backtest.
Estimativa com o item 3b abaixo: ~25 MB/dia, ~9 GB/ano. Reavaliar em 3 meses.

### 3b. Cadência por estado da partida

A watchlist do item 2b é dividida em faixas por proximidade da partida, cada faixa com
sua própria frequência de refresh:

| Estado | Intervalo |
|---|---|
| Falta > 6h | 5 min |
| Falta < 6h | 1 min |
| Ao vivo | 10-15 s |
| Encerrada | para |

Sem isso, 500 mercados a 10s constantes gerariam ~4,3M linhas/dia — pior que hoje.
Com isso, a maioria fica na faixa barata quase todo o tempo.

Um round de CS2 dura ~2 min; a granularidade atual de 3 min não permite leitura ao vivo.
A faixa de 10-15s é o que viabiliza o produto em tempo real.

Com lotes de até 100 ids por chamada, uma faixa com 200 mercados custa 2 requisições
por ciclo. A faixa "ao vivo" raramente passa de algumas dezenas de mercados simultâneos.

O `open-legs-collector` já roda a 10s e serve de molde, mas agora o refresh é por
`id=` em lote, não uma chamada por market.

### 3c. Migração

`polymarket_snapshots` permanece para o histórico não-esports até a poda. Novos
snapshots de esports vão só para `esports_snapshots`. Não migrar o histórico antigo:
a retenção já apagou a maior parte da série temporal pré-partida, que é justamente
o que teria valor. **O histórico útil começa no deploy deste item.**

---

## Parte E — Divisão de responsabilidades

### Fora do escopo do agente (execução manual)

| # | Item | Momento |
|---|---|---|
| H1 | Aplicar as migrations dos itens 2 e 3 | após revisão |
| H2 | Rodar a poda do histórico (2b), em lote, monitorando | após o item 1 em produção |
| H3 | `vacuum full events` fora do horário de pico | após H2 |
| H4 | Confirmar se `search_events_by_title` é usada, decidir sobre 2c | antes do item 2 |
| H5 | `select pg_stat_statements_reset()` antes/depois do item 1 | verificação |
| H6 | Varredura de segredos no histórico do git (gitleaks) | independente, urgente |

### Escopo do agente

- Item 1 completo: batch em todos os call sites de escrita
- Arquivos `.sql` das migrations dos itens 2 e 3 (**escrever, não aplicar**)
- Whitelist de prefixos no collector, lida de `system_config`
- Correção do `retention_job` para excluir esports
- Generalização do `open-legs-collector` para watchlist com cadência por estado
- Job diário de criação/drop de partição

### Protocolo quando bloqueado

1. Não rodar SQL contra o banco em nenhuma hipótese.
2. Não aplicar migration.
3. Parar, nomear o item humano pendente, seguir com o que não depende dele.

---

## Ordem

| # | Item | Depende de | Critério de pronto |
|---|---|---|---|
| 0 | Teto de offset não mata o ciclo | — | log `partial`, não `error` |
| 1 | Batch nos inserts | — | ✅ feito (552 events / 1104 snaps em 6,6s) |
| 2 | Descoberta por `startDate` | 0 | markets novos aparecem com volume 0 |
| 3 | Watchlist com refresh por `id=` | 2 | contagem enviada == contagem retornada |
| 4 | Desligar a varredura por volume | 3 | nenhuma chamada com `offset` > 0 |
| 5 | Poda do histórico (H2) | 4 | `events` abaixo de 100 MB |
| 6 | `esports_snapshots` + partições | — | partição do dia criada automaticamente |
| 7 | Cadência por estado | 3, 6 | mercado ao vivo com gap < 20s |
| 8 | Retenção esports-only | 6 | nenhum snapshot esports apagado |

**Item 0 é imediato e barato.** Hoje o ciclo bate no teto de 2000, lança, e loga
`status: 'error'` — apesar de ter gravado 552 markets com sucesso. A paginação deve
encerrar graciosamente ao receber 422 em offset alto, logando `partial`.

Itens 1-3 são contenção. Itens 4-6 são o que começa a gerar o histórico do backtest.

Só depois disso: Spec 001.

**Dependência a anotar:** o enricher `market-history` da Spec 001 lê `esports_snapshots`,
não `polymarket_snapshots`. Ajustar a Spec 001 quando chegar lá.