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

## Item 2 — Parar de coletar não-esports

### 2a. Whitelist no collector

O collector passa a filtrar por prefixo de slug antes de gravar:

```typescript
const PREFIXOS_ATIVOS = ['cs2-', 'lol-', 'dota2-'];
// futebol entra depois, quando o vocabulário de prefixos for confirmado
```

Configurável via `system_config`, não hardcoded — para religar sem deploy.

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

Generalizar o `open-legs-collector` (que já roda a 10s) para uma watchlist alimentada
por `start_date` / `end_date`:

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
| 1 | Batch nos inserts | — | `calls` cai 2 ordens de grandeza |
| 2 | Whitelist no collector | 1 | só slugs esports entram |
| 3 | Poda do histórico (H2) | 2 | `events` abaixo de 100 MB |
| 4 | `esports_snapshots` + partições | — | partição do dia criada automaticamente |
| 5 | Cadência por estado | 4 | mercado ao vivo com gap < 20s |
| 6 | Retenção esports-only | 4 | nenhum snapshot esports apagado |

Itens 1-3 são contenção. Itens 4-6 são o que começa a gerar o histórico do backtest.

Só depois disso: Spec 001.

**Dependência a anotar:** o enricher `market-history` da Spec 001 lê `esports_snapshots`,
não `polymarket_snapshots`. Ajustar a Spec 001 quando chegar lá.