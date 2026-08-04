# Spec 001 — Camada de Verticals + Entity Resolution (Esports)

## Contexto

O sistema hoje é agnóstico a categoria: `categorizeMarket()` usa regex e os 6 detectores
tratam qualquer mercado igual. Para a camada de agente analista precisamos do oposto:
verticais de primeira classe, com enrichers específicos por domínio.

Primeira vertical: **CS2**. Estrutura desenhada para acomodar LoL e Dota 2 sem reescrita.

### Achados da auditoria de dados (já validados)

- Mercados de esports **já existem** em `events` com `polymarket_category = 'sports_fees_v2'`,
  volume_24h de US$ 2-9M e liquidez de US$ 300k-5.6M. Passam folgado nos filtros do collector.
- **Não existe categoria nativa de esports.** Discriminação é pelo prefixo do slug.
- O slug é estruturado e determinístico:
  - Série: `{jogo}-{codA}-{codB}-{YYYY-MM-DD}` — ex. `cs2-ts7-g2-2026-06-19`
  - Game individual: `...-game{N}` — ex. `lol-g2-t1-2026-07-08-game4`
- `sports_market_type` distingue `moneyline` (série) de `child_moneyline` (game N).
- Códigos de time são **por organização, não por roster**: `aur1` aparece em CS2 e Dota 2;
  `g2` aparece em CS2 e LoL. A chave única é `(vertical, código)`.
- Títulos são inconsistentes entre jogos ("G2" vs "G2 Esports", "Aurora" vs "Aurora Gaming").
  **Slug é canônico. Título é fallback.**

---

## Objetivo

1. Introduzir `vertical` como conceito de primeira classe.
2. Resolver mercado do Polymarket → partida/times/torneio com entidades estáveis.
3. Criar o registry de enrichers com **point-in-time correctness obrigatória**.
4. Preparar multi-tenancy sem construir auth.

**Não incluído nesta spec:** o agente LLM, o eval harness, otimização de custo.

---

## Parte A — Schema

### A1. Verticais

```sql
create table verticals (
  id            text primary key,          -- 'cs2' | 'lol' | 'dota2'
  name          text not null,
  slug_prefix   text not null,             -- 'cs2-' | 'lol-' | 'dota2-'
  enabled       boolean not null default false,
  config        jsonb not null default '{}',
  created_at    timestamptz default now()
);

insert into verticals (id, name, slug_prefix, enabled) values
  ('cs2',   'Counter-Strike 2',  'cs2-',   true),
  ('lol',   'League of Legends', 'lol-',   false),
  ('dota2', 'Dota 2',            'dota2-', false);
```

### A2. Organizações e times

Separados de propósito: a org atravessa jogos, o time é o roster dentro de um jogo.

```sql
create table esports_orgs (
  id             uuid primary key default gen_random_uuid(),
  canonical_name text not null,             -- 'G2 Esports'
  aliases        text[] not null default '{}',
  created_at     timestamptz default now()
);

create table esports_teams (
  id               uuid primary key default gen_random_uuid(),
  vertical_id      text not null references verticals(id),
  org_id           uuid references esports_orgs(id),
  polymarket_code  text not null,           -- 'ts7' | 'fal2' | '9z' | 'ast10'
  display_name     text,                    -- extraído do título do Polymarket
  external_ids     jsonb not null default '{}',
                   -- { "grid": "...", "liquipedia": "...", "oddspapi": 123 }
  needs_review     boolean not null default false,
  created_at       timestamptz default now(),
  unique (vertical_id, polymarket_code)
);
```

> A constraint `unique (vertical_id, polymarket_code)` é o ponto crítico.
> `aur1` em cs2 e `aur1` em dota2 são duas linhas apontando pro mesmo `org_id`.

### A3. Torneios e partidas

```sql
create table esports_tournaments (
  id             uuid primary key default gen_random_uuid(),
  vertical_id    text not null references verticals(id),
  canonical_name text not null,             -- 'IEM Cologne Major'
  aliases        text[] not null default '{}',
  tier           text,                      -- 's' | 'a' | 'b' | 'unknown'
  is_lan         boolean,
  external_ids   jsonb not null default '{}',
  created_at     timestamptz default now()
);

create table esports_matches (
  id             uuid primary key default gen_random_uuid(),
  vertical_id    text not null references verticals(id),
  match_slug     text not null unique,      -- slug da SÉRIE, sem sufixo -gameN
  team_a_id      uuid references esports_teams(id),
  team_b_id      uuid references esports_teams(id),
  tournament_id  uuid references esports_tournaments(id),
  stage          text,                      -- 'Playoffs' | 'Stage 3' | 'Group C'
  best_of        int,                       -- 1 | 3 | 5
  scheduled_at   timestamptz,
  external_ids   jsonb not null default '{}',
  winner_team_id uuid references esports_teams(id),
  resolved_at    timestamptz,
  needs_review   boolean not null default false,
  created_at     timestamptz default now()
);

create index idx_matches_scheduled on esports_matches(vertical_id, scheduled_at desc);
```

### A4. Ligação mercado ↔ partida

```sql
create table market_match_links (
  event_id          uuid primary key references events(id) on delete cascade,
  match_id          uuid not null references esports_matches(id) on delete cascade,
  market_role       text not null,          -- espelha events.sports_market_type
  slug_suffix       text,                   -- cru, sem interpretação
  outcome_a_index   int not null,           -- índice em events.outcomes.values do team_a
  confidence        numeric(3,2) not null,
  resolution_method text not null,          -- 'slug_parse' | 'suffix_fallback' | 'manual'
  needs_review      boolean not null default false,
  created_at        timestamptz default now()
);

create index idx_link_match on market_match_links(match_id);
create index idx_link_review on market_match_links(needs_review) where needs_review;
```

> `outcome_a_index` existe porque a ordem em `outcomes.values` não é garantida
> igual à ordem do slug. Precisa ser resolvida no parse e persistida.

### A5. Fragmentos de contexto (append-only)

**Construa isso mesmo antes de ter enricher algum.** Só é possível montar dataset de eval
a partir do momento em que se começou a gravar; cada dia sem isso é dado perdido pra sempre.

```sql
create table context_fragments (
  id           bigserial primary key,
  match_id     uuid not null references esports_matches(id) on delete cascade,
  enricher_id  text not null,
  kind         text not null,               -- 'roster' | 'map_pool' | 'h2h' | 'odds' | 'news'
  as_of        timestamptz not null,        -- momento a que a informação se refere
  observed_at  timestamptz not null default now(),  -- momento em que NÓS coletamos
  payload      jsonb not null,
  summary      text not null,               -- texto curto, consumido pelo LLM
  confidence   numeric(3,2) not null default 1.0
);

create index idx_fragments_replay
  on context_fragments(match_id, observed_at);
```

**Nunca faça UPDATE nesta tabela.** Informação nova = linha nova.

`as_of` e `observed_at` são diferentes e ambos necessários:
- `as_of` = quando o fato era verdade (ex.: roster anunciado às 14h).
- `observed_at` = quando nós buscamos (ex.: nosso fetch às 18h).

Para replay de eval, **filtre por `observed_at <= T`**, nunca por `as_of`. Fontes fazem
backfill; usar `as_of` vaza informação futura e o eval mente.

### A6. Multi-tenancy preventiva

Não construir auth. Apenas evitar migração cara depois:

```sql
create table users (
  id               uuid primary key default gen_random_uuid(),
  telegram_chat_id text unique,
  created_at       timestamptz default now()
);

-- criar o usuário-dono e usar o id como default nas tabelas abaixo
alter table system_config     add column user_id uuid references users(id);
alter table my_bets           add column user_id uuid references users(id);
alter table my_bet_legs       add column user_id uuid references users(id);
alter table detected_signals  add column user_id uuid references users(id);

-- backfill com o usuário-dono, depois:
-- alter table ... alter column user_id set not null;

alter table system_config    enable row level security;
alter table my_bets          enable row level security;
alter table my_bet_legs      enable row level security;
alter table detected_signals enable row level security;
```

`system_config` perde o `id = 1` como chave lógica: passa a ser uma linha por usuário.
Auditar todos os call sites de `getSystemConfig()`.

---

## Parte B — Parser de slug

`src/verticals/slug-parser.ts`

```typescript
export interface ParsedMarketSlug {
  verticalId: string;
  teamCodeA: string;
  teamCodeB: string;
  matchDate: string;       // 'YYYY-MM-DD'
  matchSlug: string;       // '{jogo}-{codA}-{codB}-{data}' — a identidade da partida
  suffix: string | null;   // tudo depois da data, OPACO — nunca interpretado aqui
}

export function parseMarketSlug(slug: string): ParsedMarketSlug | null;
```

> **O parser NÃO determina o papel do mercado.** Esse é o campo `events.sports_market_type`,
> que é autoritativo. O slug serve apenas para identidade: qual jogo, quais times, qual data.

Motivo: o vocabulário de sufixo é aberto e cresce sem aviso. Exemplos reais no banco —
`-game1`, `-total-games-2pt5`, `-map-handicap-away-1pt5`. Tentar enumerar isso é briga
perdida. `sports_market_type` já tem 30+ valores documentados pelo próprio Polymarket
(`moneyline`, `child_moneyline`, `map_handicap`, `totals`, `round_handicap_game_1`,
`round_over_under_game_2`, `kill_over_under_game`, `first_blood_game`,
`esports_match_result`, `lol_penta_kill`, `dota2_rampage`, …).

Algoritmo — **decompor pela esquerda, e parar na data**:

1. Match do prefixo contra `verticals.slug_prefix`. Sem match → `null` (não é esports).
2. Da esquerda, após o prefixo: os dois próximos segmentos separados por `-` são
   `teamCodeA` e `teamCodeB`.
3. O segmento seguinte deve casar `^\d{4}-\d{2}-\d{2}$` (3 tokens). Não casou → `null`
   e marca para revisão: é slug fora do padrão, não adivinhe.
4. `matchSlug` = tudo até a data, inclusive. É a chave de `esports_matches`.
5. `suffix` = o que sobrar, guardado cru sem interpretação.

Códigos de time podem começar com dígito (`9z`, `1win`) e conter dígitos no meio ou fim
(`ts7`, `fal2`, `ast10`, `big5`, `aur1`, `hle1`, `mouzn`, `g1`, `imp11`). Nenhum contém `-`.

Testes obrigatórios (casos reais do banco):

| slug | matchSlug | suffix |
|---|---|---|
| `cs2-ts7-g2-2026-06-19` | igual ao slug | `null` |
| `lol-g2-t1-2026-07-08-game4` | `lol-g2-t1-2026-07-08` | `game4` |
| `cs2-yaw-guara-2026-08-04-total-games-2pt5` | `cs2-yaw-guara-2026-08-04` | `total-games-2pt5` |
| `cs2-fnc-lilmix-2026-08-03-map-handicap-away-1pt5` | `cs2-fnc-lilmix-2026-08-03` | `map-handicap-away-1pt5` |
| `cs2-1win-ruby1-2026-08-03` | igual ao slug | `null` (código com dígito inicial) |
| `cs2-mouzn-mis-2026-08-03` | igual ao slug | `null` (`mouzn` ≠ `mouz`: time academy) |
| `dota2-aur1-lgd-2026-06-06` | igual ao slug | `null` |
| `bitcoin-up-or-down-july-8` | — | `null` (não-esports) |

### Fallback para registros históricos

Há ~14k eventos `cs2-` com `sports_market_type` nulo, provavelmente anteriores à coleta
desse campo. Para esses, derive o papel do mercado a partir do `suffix` com um mapa
best-effort e grave `confidence <= 0.7` + `needs_review = true`. Nunca trate papel
derivado de sufixo como equivalente ao vindo da coluna.

### Parser de título (complementar, nunca autoritativo)

Série: `^(Counter-Strike|LoL|Dota 2): (.+) vs (.+) \(BO(\d)\) - (.+)$`
→ `display_name` de cada time, `best_of`, `stage`/torneio.

Game: `^(Counter-Strike|LoL|Dota 2): (.+) vs (.+) - Game (\d) Winner$`
→ child markets **não trazem torneio nem BO**. Herdar do pai via `matchSlug`.

O título só serve para popular `display_name`, `best_of` e o torneio. A identidade
vem sempre do slug.

---

## Parte C — Resolver

`src/verticals/resolver.ts`

```typescript
export async function resolveEventToMatch(eventId: string): Promise<void>;
export async function resolveUnlinkedEvents(limit?: number): Promise<ResolveStats>;
```

Fluxo por evento:

1. `parseMarketSlug(event.slug)`. Null → ignora (não é esports).
2. Upsert `esports_teams` por `(vertical_id, polymarket_code)`. Time novo →
   cria com `needs_review = true` e `display_name` do título; `org_id` fica null.
3. Upsert `esports_matches` por `match_slug` (o da série, não o do game).
4. Upsert `esports_tournaments` por nome normalizado extraído do stage do título.
   Sem match de alias conhecido → cria com `needs_review = true`.
5. Determina `outcome_a_index` casando `events.outcomes.values` com os `display_name`
   dos times. Falhou o casamento → `confidence = 0.5`, `needs_review = true`.
6. Insere em `market_match_links`.

**Regra:** nunca inventar. Ambiguidade vira `needs_review`, não palpite.
Meta realista: ~90-95% automático + fila de revisão. Não persiga 100%.

### Fila de revisão no Telegram

- `/review` — lista pendências de `esports_teams`, `esports_tournaments` e
  `market_match_links` com `needs_review = true`.
- Botões inline: confirmar / vincular a entidade existente / editar nome.
- Confirmar limpa a flag e, para times, permite atribuir `org_id`.

Baratíssimo de construir, e é o que torna 90% automático suficiente.

---

## Parte D — Registry de enrichers

`src/verticals/enricher.ts`

```typescript
export interface EnricherContext {
  verticalId: string;
  matchId: string;
  asOf: Date;               // OBRIGATÓRIO — nenhum enricher assume "agora"
}

export interface ContextFragment {
  enricherId: string;
  kind: string;
  asOf: Date;
  payload: unknown;
  summary: string;          // 1-3 frases, é o que o LLM lê
  confidence: number;
}

export interface Enricher {
  id: string;
  verticals: string[];
  ttlSeconds: number;

  /**
   * false = a fonte só devolve estado atual, sem histórico.
   * Enricher com false NÃO pode participar de replay de eval.
   * O runner deve recusar executá-lo quando asOf < now - tolerância.
   */
  supportsPointInTime: boolean;

  fetch(ctx: EnricherContext): Promise<ContextFragment[]>;
}

export function registerEnricher(e: Enricher): void;
export function getEnrichers(verticalId: string): Enricher[];
export async function runEnrichers(
  ctx: EnricherContext,
  opts?: { requirePointInTime?: boolean }
): Promise<ContextFragment[]>;
```

`runEnrichers` persiste tudo em `context_fragments` e devolve os fragmentos.
Com `requirePointInTime: true`, pula todo enricher com `supportsPointInTime = false`.
Essa flag é a única coisa que impede o eval de mentir depois — trate como invariante.

### Enricher inicial (validação do contrato)

`market-history` — não usa fonte externa nenhuma, lê `polymarket_snapshots`:
- movimento de preço nas últimas 24h / 6h / 1h antes de `asOf`
- evolução de liquidez e spread
- para BO3/BO5: preços dos `child_moneyline` irmãos e a consistência
  entre o preço da série e o implícito pelos games

É point-in-time por construção (a tabela é time series) e valida o contrato inteiro
sem depender de nenhuma integração externa. Fontes externas (GRID, Liquipedia,
OddsPapi) entram numa spec seguinte.

---

## Parte E — Divisão de responsabilidades

**Esta spec é executada por duas partes. O agente não faz o que está na coluna do humano.**

### Fora do escopo do agente (o dono do projeto executa manualmente)

O agente **não deve** tentar executar nenhum destes itens, nem assumir que já foram feitos.
Quando um item destes for pré-requisito, o agente para e pede o resultado.

| # | Item | Momento |
|---|---|---|
| H1 | Rodar as queries de verificação (final desta spec) e devolver o output | antes de tudo |
| H2 | Investigar a taxa de erro do Postgres (~266 erros / 835 requests em 24h) | antes de tudo |
| H3 | Versionar migrations (`supabase init` + `supabase link`) | antes do item 1 |
| H4 | **Aplicar** cada migration no banco, uma por vez, verificando entre elas | itens 1, 4, 7 |
| H5 | Definir política de retenção antes de habilitar `context_fragments` | antes do item 4 |
| H6 | Revisar a fila `needs_review` e mapear `org_id` dos times | depois do item 6 |
| H7 | Decidir se e quando habilitar as verticais `lol` e `dota2` | depois de tudo |

Racional do H4: `system_config` deixa de ter `id = 1` como chave lógica e é lida por
todo o sistema. Migration aplicada por agente, sem verificação humana entre passos,
é o cenário de quebra silenciosa em produção. O agente **escreve** o SQL; o humano aplica.

### Escopo do agente

Escrever, testar e abrir PR de:

- Os arquivos `.sql` de migration (**escrever, não aplicar**)
- `src/verticals/slug-parser.ts` + suíte de testes
- `src/verticals/resolver.ts` + script de backfill histórico
- `src/verticals/enricher.ts` (registry e contrato)
- `src/verticals/enrichers/market-history.ts`
- Comando `/review` no bot do Telegram
- Auditoria e ajuste dos call sites de `getSystemConfig()` após A6

### Protocolo quando o agente ficar bloqueado

1. Não inventar dado nem inferir schema não confirmado.
2. Não rodar SQL contra o banco em nenhuma hipótese.
3. Parar, dizer qual item humano está pendente, e seguir com o que não depende dele.

---

## Parte F — Ordem de implementação

| # | Item | Depende de | Verificação |
|---|---|---|---|
| 1 | Migration A1-A4 | — | tabelas criadas, FKs válidas |
| 2 | `slug-parser.ts` + testes | 1 | tabela de casos passa 100% |
| 3 | `resolver.ts` + backfill histórico | 2 | ≥90% dos eventos `cs2-%` linkados sem revisão |
| 4 | Migration A5 + persistência de fragmentos | 1 | append-only, nenhum UPDATE no código |
| 5 | `enricher.ts` + `market-history` | 4 | fragmento gravado com `as_of` e `observed_at` corretos |
| 6 | `/review` no Telegram | 3 | fila zerável na mão |
| 7 | Migration A6 (user_id + RLS) | — | nenhuma regressão nos comandos existentes |

Itens 1-3 são o caminho crítico. O 4 é o mais urgente em termos de custo de adiamento.
O 7 é independente e pode ir em paralelo.

---

## Queries de verificação pendentes

Rodar antes do item 5 — determina se há série temporal utilizável:

```sql
-- densidade de snapshots por partida
select e.slug,
       count(s.id) as snaps,
       min(s.captured_at) as primeiro,
       max(s.captured_at) as ultimo,
       round(extract(epoch from (max(s.captured_at) - min(s.captured_at)))
             / greatest(count(s.id) - 1, 1)) as gap_medio_seg
from events e
join polymarket_snapshots s on s.event_id = e.id
where e.slug like 'cs2-%'
group by e.slug
order by snaps desc
limit 20;

-- inventário por jogo e tipo de mercado
select split_part(slug, '-', 1) as jogo,
       sports_market_type,
       count(*) as n,
       round(avg(volume_24h)) as vol_medio
from events
where slug ~ '^(cs2|lol|dota2)-'
group by 1, 2
order by 3 desc;
```

Um gap médio próximo de 180s confirma que só o collector geral de 3min está cobrindo.
Para análise pré-partida isso basta. Para leitura ao vivo em CS2 — onde um round dura
cerca de dois minutos — não basta, e será preciso generalizar o `open-legs-collector`
para uma watchlist. Decisão para a spec seguinte.