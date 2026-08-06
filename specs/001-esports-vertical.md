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

### Achados da investigação da API (2026-08-06) — o que mudou nesta spec

A Gamma expõe, **só no endpoint `/events`**, um bloco de metadado que resolve boa parte
do que esta spec desenhava via parser. Medições sobre 464 markets e 2.888 eventos:

| campo | onde vive | cobertura | o que resolve |
|---|---|---|---|
| `teams[]` | `/events` | 100% desde jul/2026 | identidade de time, exata |
| `eventMetadata.league` | ambos | 100% desde mar/2026 | competição |
| `eventMetadata.serie` | ambos | ~46% | edição/split |
| `eventMetadata.tournament` | ambos | 100% desde mar/2026 | fase (stage) |
| `eventMetadata.leagueTier` | ambos | 100% desde mai/2026 | tier, string `"1"`..`"5"` |
| `eventMetadata.pandascoreMatchId` | ambos | 100% desde jun/2026 | id externo da partida |
| `eventMetadata.context_description` | ambos | 98% | candidato a enricher |
| `score` (`"0-0|1-2|Bo3"`) | ambos | 92% | best-of e placar da série |

Os quatro fatos que reorganizam o desenho:

1. **`teams[].abbreviation` é o código do slug.** Medido sobre 2.307 eventos no formato de
   partida: 2.307 casaram, **na ordem do slug**, 0 invertidos, 0 falhas. E `(league,
   abbreviation)` produz 972 chaves com **0 colisões** — a constraint `unique (vertical_id,
   polymarket_code)` está validada pela própria API. Cada time vem com `id` (Polymarket),
   `providerId` (PandaScore), `name` canônico e `ordering` (home/away).

2. **Não existe chave de organização.** `team.id` e `providerId` são distintos por jogo, e
   73 abbreviations aparecem em mais de uma liga (`fal` em codmw/csgo/ow/mlbb; `fur`, `og`,
   `100t`, `1win`) com identidades diferentes. Não há como derivar org da API.

3. **O corte temporal decide o backfill.** Cobertura por janela de uma semana:

   | janela | teams | pandascoreMatchId | league | score |
   |---|---|---|---|---|
   | 2025-11 | 4% | 0% | 0% | 15% |
   | 2026-01 | 14% | 0% | 0% | 93% |
   | 2026-03 | 10% | 0% | 100% | 91% |
   | 2026-05 | 35% | 5% | 99% | 95% |
   | 2026-06 | 57% | 94% | 94% | 93% |
   | 2026-07 | 100% | 100% | 100% | 100% |

   Re-fetch de evento antigo devolve HTTP 200 com `teams: []`. **O histórico não será
   enriquecido por re-busca** — para ele o slug continua sendo o único caminho.

4. **A ordem dos outcomes não é confiável nem dentro do mesmo evento.** Medido: 19 de 79
   eventos têm markets irmãos com `outcomes.values` em ordens diferentes
   (`"Team WE|Anyone's Legend"` num, invertido noutro).

### O que já está capturado

A partir de 2026-08-06 a descoberta coleta por `/events` e grava em
`events.event_metadata` (coluna da migration 003, que estava NULL para todo mundo por
causa de um bug de leitura já corrigido):

```json
{
  "league": "NODWIN Clutch Series", "leagueTier": "5", "tournament": "Playoffs",
  "serie": null, "pandascoreMatchId": 1582194, "gridSeriesId": null,
  "context_description": "...", "context_updated_at": "2026-08-06T15:01:18.892Z",
  "polymarket_event_id": "806202",
  "polymarket_sport": { "sport": "cs2", "resolution": "https://hltv.org" },
  "polymarket_teams": [
    { "id": 3270870, "name": "Nuclear TigeRES", "abbreviation": "ntr",
      "providerId": 135673, "league": "csgo", "ordering": "home" },
    { "id": 138975, "name": "Butterfly", "abbreviation": "btf",
      "providerId": 138975, "league": "csgo", "ordering": "away" }
  ]
}
```

**Consequência prática:** a população de `esports_teams` lê desta coluna. Não precisa
re-buscar nada na API.

---

## Objetivo

1. Introduzir `vertical` como conceito de primeira classe.
2. Resolver mercado do Polymarket → partida/times/competição com entidades estáveis.
3. Criar o registry de enrichers com **point-in-time correctness obrigatória**.
4. Preparar multi-tenancy sem construir auth.

**Não incluído nesta spec:** o agente LLM, o eval harness, otimização de custo.

**Removido em relação à versão anterior:** `esports_orgs` e o parser de título. Ver a
Parte G para o registro do porquê.

---

## Parte A — Schema

### A1. Verticais

```sql
create table verticals (
  id              text primary key,        -- 'cs2' | 'lol' | 'dota2'
  name            text not null,
  slug_prefix     text not null,           -- 'cs2-' | 'lol-' | 'dota2-'
  -- Vocabulário do provedor em `teams[].league`. NÃO é igual ao prefixo:
  -- medido, cs2->csgo, lol->lol, dota2->dota2, val->valorant.
  provider_league text not null,
  enabled         boolean not null default false,
  config          jsonb not null default '{}',
  created_at      timestamptz default now()
);

insert into verticals (id, name, slug_prefix, provider_league, enabled) values
  ('cs2',   'Counter-Strike 2',  'cs2-',   'csgo',  true),
  ('lol',   'League of Legends', 'lol-',   'lol',   false),
  ('dota2', 'Dota 2',            'dota2-', 'dota2', false);
```

`provider_league` existe porque é a chave de junção com `teams[].league`, e assumir que
ela é o prefixo do slug quebraria em CS2 já no primeiro registro.

### A2. Times

```sql
create table esports_teams (
  id                 uuid primary key default gen_random_uuid(),
  vertical_id        text not null references verticals(id),
  polymarket_code    text not null,        -- teams[].abbreviation
  display_name       text,                 -- teams[].name
  polymarket_team_id bigint,               -- teams[].id
  pandascore_team_id bigint,               -- teams[].providerId
  logo_url           text,
  -- Fontes que ainda não temos (GRID, Liquipedia). Vazio até a spec seguinte.
  external_ids       jsonb not null default '{}',
  needs_review       boolean not null default false,
  created_at         timestamptz default now(),
  unique (vertical_id, polymarket_code)
);
```

> A constraint `unique (vertical_id, polymarket_code)` é o ponto crítico, e está
> confirmada pela API: 972 chaves `(league, abbreviation)`, 0 colisões. `aur1` em cs2 e
> `aur1` em dota2 são duas linhas — e, sem chave de org, **duas entidades independentes**.

**Não existe tabela de organizações.** A API não expõe chave de org: `team.id` e
`providerId` são distintos por jogo, e 73 abbreviations aparecem em ligas diferentes com
identidades distintas. Construir `esports_orgs` significaria mapear tudo à mão, para
resolver um problema que não existe num escopo CS2-only. Fica registrado na Parte G como
decisão, não como pendência.

### A3. Competições e partidas

Três níveis, porque é o que a API entrega separado — e porque colapsá-los foi o erro da
versão anterior desta spec:

```sql
-- Nível 1: a competição. 37 valores distintos medidos.
create table esports_leagues (
  id           uuid primary key default gen_random_uuid(),
  vertical_id  text not null references verticals(id),
  name         text not null,              -- eventMetadata.league: 'LPL', 'CCT Europe'
  created_at   timestamptz default now(),
  unique (vertical_id, name)
);

-- Nível 2: a edição/split. eventMetadata.serie, cobertura ~46%.
create table esports_tournaments (
  id           uuid primary key default gen_random_uuid(),
  vertical_id  text not null references verticals(id),
  league_id    uuid not null references esports_leagues(id),
  -- 'China Stage 2', 'Series #6', ou '' — nunca null. Ver a nota abaixo.
  serie        text not null default '',
  -- Tier CONSOLIDADO, preenchido por revisão humana. Nunca escrito pelo resolver.
  tier         text,                        -- '1'..'5'
  is_lan       boolean,
  external_ids jsonb not null default '{}',
  needs_review boolean not null default false,
  created_at   timestamptz default now(),
  unique (vertical_id, league_id, serie)
);
```

**Sobre `tier`, que é onde a versão anterior errava em dois eixos.** A escala real é string
`"1"` a `"5"`, não `'s'|'a'|'b'`. E o tier **não é propriedade do nome da liga**: medido,
VCT aparece em tier 2, 3 e 5; Esports World Cup em 1 e 3; Games of the Future em 3 e 4.
Provavelmente varia por edição (VCT regional × VCT Game Changers), mas `serie` só cobre
46% dos casos — não dá para afirmar. Por isso:

- o valor **observado** é gravado por partida, em `esports_matches.league_tier`, onde a
  API garante consistência;
- o valor **consolidado** em `esports_tournaments.tier` é decisão humana (item H6), e o
  resolver nunca escreve nele.

Rolar o tier para cima automaticamente seria inventar um fato que a medição contradiz.

**Sobre `serie` ser `not null default ''` e nunca `null`.** Ela faz parte da chave única, e
em Postgres `null` não é igual a `null` num índice único — com coluna nullable, duas
edições sem série na mesma liga criariam duas linhas em vez de colidir, e o resolver
passaria a fabricar uma edição nova a cada partida. `''` colide com `''` e resolve isso
sem `coalesce` no índice nem índice funcional.

`''` significa **"edição sem série nomeada"**, não "desconhecido". A distinção não é
cosmética:

- *sem série nomeada* é um fato sobre a competição — ela não se divide em splits, ou a
  Polymarket não a divide. `LPL` + `''` é uma edição legítima e completa.
- *desconhecido* seria a afirmação de que existe uma série que não sabemos qual é, e isso
  pediria `needs_review` e uma fila. Não é o caso aqui.

Consequência prática: `''` **não** é motivo para `needs_review`, não deve ser exibido como
"—" ou "desconhecido" no `/review`, e uma edição com `serie = ''` é tão final quanto uma
com `serie = 'China Stage 2'`. O resolver grava `serie ?? ''` e nunca `null`.

Onde isso pode estar errado: os ~54% sem `serie` são o campo ausente no payload da Gamma, e
a coluna não distingue "a competição não tem split" de "a Gamma não preencheu". Estamos
escolhendo a primeira leitura. Se aparecer uma liga que às vezes traz `serie` e às vezes
não, para o mesmo split, a leitura estava errada — e o sintoma será uma edição `''`
convivendo com edições nomeadas sob a mesma liga. A terceira query de verificação
(final desta spec) é o que detecta isso.

**Verificado em 2026-08-06: 0 linhas.** Nenhuma liga tem série nomeada e vazia
convivendo, e o desenho `serie text not null default ''` entra na migration como está.

**Ressalva sobre essa verificação, e ela não é formalidade.** `events.event_metadata` só
passou a ser gravado em 2026-08-06 — a amostra é de **horas, não de meses**. Nenhuma liga
teve tempo de mudar de formato dentro dela, então o que a query mediu foi "nenhuma liga
mudou hoje", que é bem mais fraco que "nenhuma liga muda". **Repetir a query quando houver
semanas acumuladas.** Uma liga pode passar a ter split — um campeonato que ganha edição
regional, um circuito que se divide em stages — e o sintoma seria exatamente uma linha ali.

Se ela voltar com linha, o conserto **não** é relaxar a constraint. É passar a tratar o
vazio como desconhecido: `needs_review` nessas edições, fila no `/review`, e outra
estratégia de chave única (o vazio deixa de poder colidir com o vazio de outra edição
real). Isso muda o resolver, e pede migration própria.

```sql
create table esports_matches (
  id             uuid primary key default gen_random_uuid(),
  vertical_id    text not null references verticals(id),
  match_slug     text not null unique,      -- slug da SÉRIE, sem sufixo -gameN
  team_a_id      uuid references esports_teams(id),
  team_b_id      uuid references esports_teams(id),
  tournament_id  uuid references esports_tournaments(id),
  stage          text,                      -- eventMetadata.tournament: 'Playoffs', 'Group D'
  league_tier    text,                      -- eventMetadata.leagueTier, como observado
  best_of        int,                       -- do sufixo 'BoN' de `score`
  scheduled_at   timestamptz,               -- events.game_start_time
  -- pandascore_match_id, grid_series_id, polymarket_event_id
  external_ids   jsonb not null default '{}',
  winner_team_id uuid references esports_teams(id),
  resolved_at    timestamptz,
  needs_review   boolean not null default false,
  created_at     timestamptz default now()
);

create index idx_matches_scheduled on esports_matches(vertical_id, scheduled_at desc);
```

**`match_slug` continua sendo a chave**, e não `pandascoreMatchId`. A bijeção entre os dois
é perfeita onde ambos existem (151 grupos, 151 match_slugs, 0 violações nos dois sentidos),
mas pandascore só existe desde junho/2026 e `match_slug` funciona no histórico inteiro.
Trocar a chave por um campo que falta em metade do backfill seria trocar cobertura por
elegância. Pandascore e GRID vão para `external_ids`.

`best_of` sai do sufixo `Bo{N}` de `events.event_metadata`/`score` — medido, bate com o
`(BOn)` do título em 133/133. `stage` sai de `eventMetadata.tournament`. Nenhum dos dois
precisa de parser de título.

### A4. Ligação mercado ↔ partida

```sql
create table market_match_links (
  event_id          uuid primary key references events(id) on delete cascade,
  match_id          uuid not null references esports_matches(id) on delete cascade,
  market_role       text not null,          -- espelha events.sports_market_type
  slug_suffix       text,                   -- cru, sem interpretação
  outcome_a_index   int,                    -- índice em events.outcomes.values do team_a
  confidence        numeric(3,2) not null,
  resolution_method text not null,          -- 'event_teams' | 'slug_parse' | 'manual'
  needs_review      boolean not null default false,
  created_at        timestamptz default now()
);

create index idx_link_match on market_match_links(match_id);
create index idx_link_review on market_match_links(needs_review) where needs_review;
```

> **`outcome_a_index` continua necessário, e continua sendo resolvido por market.**
> Medido: 19 de 79 eventos têm markets irmãos com `outcomes.values` em ordens diferentes.
> A intuição da versão anterior estava certa; o que muda é a qualidade da resolução —
> `teams[].name` bate exatamente com o texto de `outcomes.values`, então deixa de ser
> fuzzy match de título e passa a ser comparação de string.

**`outcome_a_index` é nullable**, ao contrário da versão anterior. Mercado derivado não
tem lado de time: `totals` traz `["Over","Under"]`, `kill_over_under_game` idem. Declarar
`not null` obrigaria a inventar um índice para esses, ou a deixá-los fora da tabela — e
eles precisam estar nela, porque são parte da série que o backtest vai ler.

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

O parser **deixa de ser a fonte primária de identidade** e passa a ter dois papéis:

1. **Fallback** para eventos anteriores a ~junho/2026, onde `event_metadata` é NULL e não
   há como enriquecer por re-busca. É o único caminho de identidade nesse histórico.
2. **Validador** do caminho novo: `events[0].slug` da Gamma é igual ao `matchSlug` derivado
   em 464/464 medidos. Divergência entre os dois é sinal de que uma das duas premissas
   quebrou, e deve virar `needs_review` em vez de escolha silenciosa.

Não sai da spec. Sem ele, metade do backfill fica sem identidade.

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

Sobre a robustez do formato: dos 464 markets medidos, **0 ficaram fora do padrão**, e todos
tinham exatamente 2 segmentos entre prefixo e data. A tabela de casos abaixo é suficiente;
não precisa crescer especulativamente.

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

### O parser de título foi removido

Servia para `display_name`, `best_of` e stage/torneio. Os três agora têm fonte estruturada:

| era | passa a ser |
|---|---|
| `display_name` do regex do título | `polymarket_teams[].name` |
| `best_of` de `\(BO(\d)\)` | sufixo `Bo{N}` de `score` — bate 133/133 com o título |
| stage/torneio do título | `eventMetadata.tournament` + `.league` + `.serie` |

Não sobra uso. Manter o regex seria manter um caminho paralelo, menos confiável, que
divergiria em silêncio do estruturado.

---

## Parte C — Resolver

`src/verticals/resolver.ts`

```typescript
export async function resolveEventToMatch(eventId: string): Promise<void>;
export async function resolveUnlinkedEvents(limit?: number): Promise<ResolveStats>;
```

Dois caminhos, escolhidos pela presença de `events.event_metadata->'polymarket_teams'`.
Nenhum dos dois faz chamada à API: o metadado já está na coluna.

### Caminho 1 — evento com `polymarket_teams` (resolução exata)

Aplica-se a tudo coletado a partir de 2026-08-06 e é o caso dominante daqui pra frente.

1. Lê `event_metadata` do evento. Vertical sai de `polymarket_sport.sport`, com o prefixo
   do slug como conferência — divergência é `needs_review`, não escolha.
2. Upsert `esports_teams` por `(vertical_id, polymarket_code)` a partir de
   `polymarket_teams[]`: `abbreviation` → `polymarket_code`, `name` → `display_name`,
   `id` → `polymarket_team_id`, `providerId` → `pandascore_team_id`.
   `needs_review = false`: o dado é da API, não inferido.
3. `team_a` é o de `ordering = 'home'`, `team_b` o de `'away'`. Confere contra os códigos
   do slug (medido: casam em 2307/2307). Divergência → `needs_review`.
4. Upsert `esports_leagues` por `(vertical_id, league)` e `esports_tournaments` por
   `(vertical_id, league_id, serie ?? '')`. Sem alias, sem normalização de nome: o
   vocabulário vem controlado da API. `serie` ausente vira `''`, que é edição válida e
   **não** gera `needs_review` (ver A3).
5. Upsert `esports_matches` por `match_slug`. `stage` ← `tournament`, `league_tier` ←
   `leagueTier`, `best_of` ← `Bo{N}` de `score`, `scheduled_at` ← `events.game_start_time`,
   `external_ids` ← `{pandascore, grid, polymarket_event}`.
6. `outcome_a_index`: casa `teams[].name` contra `events.outcomes.values`, **por market**.
   Casou exato → `confidence = 1.0`, `resolution_method = 'event_teams'`.
   Mercado derivado sem lado de time (`["Over","Under"]`) → `outcome_a_index = null`,
   e isso **não** é `needs_review`: é a forma correta desse mercado.
   Não casou onde deveria casar → `confidence = 0.5`, `needs_review = true`.

### Caminho 2 — evento sem metadado (histórico, fallback)

1. `parseMarketSlug(event.slug)`. Null → ignora (não é esports).
2. Upsert `esports_teams` por `(vertical_id, polymarket_code)` só com o código.
   `display_name` fica null, `needs_review = true`.
3. Upsert `esports_matches` por `match_slug`. Sem liga, sem stage, sem tier, sem best_of.
4. `outcome_a_index` por comparação dos códigos com `outcomes.values` — heurística.
   `confidence <= 0.7`, `resolution_method = 'slug_parse'`, `needs_review = true`.

**Regra:** nunca inventar. Ambiguidade vira `needs_review`, não palpite.

Meta realista, agora com duas taxas distintas: **~100% automático** no caminho 1 (o dado é
da API), e o caminho 2 continua sendo o que alimenta a fila. Não perseguir 100% no
histórico — grande parte dele nunca terá nome de time.

### Fila de revisão no Telegram

- `/review` — lista pendências de `esports_teams`, `esports_tournaments` e
  `market_match_links` com `needs_review = true`.
- Botões inline: confirmar / vincular a entidade existente / editar nome.
- Confirmar limpa a flag; para `esports_tournaments`, é onde o `tier` consolidado é
  definido (o resolver nunca o escreve).

Continua valendo, com volume muito menor: o caminho 1 não gera fila. O que sobra é
histórico, divergência entre slug e `teams[]`, e consolidação de tier.

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

`market-history` — não usa fonte externa nenhuma, lê `esports_snapshots`:
- movimento de preço nas últimas 24h / 6h / 1h antes de `asOf`
- evolução de liquidez e spread
- para BO3/BO5: preços dos `child_moneyline` irmãos e a consistência
  entre o preço da série e o implícito pelos games

É point-in-time por construção (a tabela é time series) e valida o contrato inteiro
sem depender de nenhuma integração externa.

### Enricher candidato: `polymarket-context`

`eventMetadata.context_description` é um parágrafo por partida que a **própria Polymarket
gera**, com roster, head-to-head, forma recente e contexto de grupo. Cobertura medida: 98%.
Vem acompanhado de `context_updated_at`, o que o torna utilizável para point-in-time:
`as_of = context_updated_at`, `observed_at = agora`, `supportsPointInTime = true`.

Custo de integração: zero. O texto já está em `events.event_metadata`.

**Ressalva, e ela é a parte importante:** é texto gerado por LLM da Polymarket, sem
garantia de fidelidade e sem fonte citada. Regras de uso:

- entra com `confidence` baixa (≤ 0.4);
- **nunca é fonte factual única** — um número que só aparece aqui não vira input de
  decisão sem corroboração;
- serve como sinal de contexto e como baseline para comparar contra os enrichers de fonte
  primária (GRID, Liquipedia) quando existirem.

Há também `context_requires_regen`, que a Polymarket usa para marcar texto desatualizado.
Vale gravar no payload — é o que permite depois medir se texto marcado como stale tem
qualidade pior.

Fontes externas de verdade (GRID, Liquipedia, OddsPapi) entram numa spec seguinte.

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
| H3 | ~~Versionar migrations~~ — **concluído**, `supabase/migrations/` está versionado | — |
| H4 | **Aplicar** cada migration no banco, uma por vez, verificando entre elas | itens 1, 4, 7 |
| H5 | Definir política de retenção antes de habilitar `context_fragments` | antes do item 4 |
| H6 | Revisar a fila `needs_review` e consolidar o `tier` das competições | depois do item 6 |
| H7 | Decidir se e quando habilitar as verticais `lol` e `dota2` | depois de tudo |

Racional do H4: `system_config` deixa de ter `id = 1` como chave lógica e é lida por
todo o sistema. Migration aplicada por agente, sem verificação humana entre passos,
é o cenário de quebra silenciosa em produção. O agente **escreve** o SQL; o humano aplica.

H6 mudou de conteúdo: não há mais `org_id` para mapear (não existe `esports_orgs`). O que
sobra é a fila de histórico e a decisão de `tier` por competição, que o resolver não toma.

### Escopo do agente

Escrever, testar e abrir PR de:

- Os arquivos `.sql` de migration (**escrever, não aplicar**)
- `src/verticals/slug-parser.ts` + suíte de testes
- `src/verticals/resolver.ts` (dois caminhos) + script de backfill histórico
- `src/verticals/enricher.ts` (registry e contrato)
- `src/verticals/enrichers/market-history.ts`
- `src/verticals/enrichers/polymarket-context.ts`
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
| 3 | `resolver.ts` (caminhos 1 e 2) + backfill histórico | 2 | ver abaixo |
| 4 | Migration A5 + persistência de fragmentos | 1 | append-only, nenhum UPDATE no código |
| 5 | `enricher.ts` + `market-history` + `polymarket-context` | 4 | fragmento gravado com `as_of` e `observed_at` corretos |
| 6 | `/review` no Telegram | 3 | fila zerável na mão |
| 7 | Migration A6 (user_id + RLS) | — | nenhuma regressão nos comandos existentes |

Itens 1-3 são o caminho crítico. O 4 é o mais urgente em termos de custo de adiamento.
O 7 é independente e pode ir em paralelo.

**Verificação do item 3**, agora com duas metas separadas, porque misturá-las esconderia
uma regressão no caminho novo atrás do ruído do histórico:

- eventos **com** `event_metadata.polymarket_teams`: ≥99% linkados sem revisão;
- eventos **sem** (histórico): ≥90% linkados, revisão esperada e aceitável.

---

## Parte G — Decisões registradas

O que foi removido nesta revisão e por quê. Registrado para não ser reintroduzido por
esquecimento.

| Removido | Motivo | O que fazer se voltar a fazer falta |
|---|---|---|
| `esports_orgs` | A API não expõe chave de org. `team.id` e `providerId` são distintos por jogo; 73 abbreviations aparecem em ligas diferentes com identidades distintas. Mapear seria trabalho manual, para resolver um problema que não existe em CS2-only. | Só ganha sentido com múltiplas verticais ativas **e** uma fonte externa de org (Liquipedia). Aí é spec própria. |
| Parser de título | `display_name` ← `teams[].name`; `best_of` ← `score`; stage ← `eventMetadata.tournament`. Nenhum uso restante. | Só se a Gamma remover `teams[]`, o que tornaria o problema muito maior que um regex. |
| `aliases` em competições | Existia para normalizar nome extraído de título. O vocabulário agora vem controlado da API (37 ligas, 20 stages). | Se aparecer a mesma liga com dois nomes na API. Medir antes de assumir. |
| `tier` como `'s'|'a'|'b'` na liga | Escala real é `"1"`..`"5"`, e o valor não é estável por nome de liga (VCT em 2, 3 e 5). | — |

---

## Queries de verificação pendentes

Rodar antes do item 3 — dimensiona os dois caminhos do resolver:

```sql
-- quanto do universo cai no caminho exato vs no fallback
select split_part(slug, '-', 1) as jogo,
       count(*) filter (where event_metadata ? 'polymarket_teams') as com_teams,
       count(*) filter (where event_metadata is null)              as sem_metadata,
       count(*)                                                    as total
from events
where slug ~ '^(cs2|lol|dota2)-'
group by 1
order by 4 desc;

-- vocabulário observado de liga/tier, para dimensionar a fila de consolidação (H6)
select event_metadata->>'league'     as league,
       event_metadata->>'leagueTier' as tier,
       count(*) as n
from events
where event_metadata ? 'league'
group by 1, 2
order by 1, 2;

-- a leitura de `serie = ''` está certa? (ver A3)
-- Uma liga que aparece com série nomeada E sem série é o sintoma de que o vazio
-- significa "a Gamma não preencheu", não "não tem split" — e aí o desenho muda.
select event_metadata->>'league' as league,
       count(*) filter (where coalesce(event_metadata->>'serie', '') <> '') as com_serie,
       count(*) filter (where coalesce(event_metadata->>'serie', '') =  '') as sem_serie,
       count(distinct event_metadata->>'serie')                             as series_distintas
from events
where event_metadata ? 'league'
group by 1
having count(*) filter (where coalesce(event_metadata->>'serie', '') <> '') > 0
   and count(*) filter (where coalesce(event_metadata->>'serie', '') =  '') > 0
order by 2 desc;
```

A segunda query é a que confirma ou derruba a premissa do `tier`: se uma mesma `league`
aparecer com mais de um `tier`, a decisão de mantê-lo fora de `esports_leagues` está certa.

A terceira é a contraprova de `serie = ''`. **Resultado vazio é o esperado** e confirma o
desenho. Qualquer linha que aparecer é uma liga em que o vazio e o nomeado convivem — o
que derruba a leitura de "edição sem série nomeada" e obriga a tratar o vazio como
desconhecido, com fila de revisão. Rodar antes do item 3, não depois.

> **Rodada em 2026-08-06: 0 linhas.** Desenho confirmado, migration do item 1 escrita.
> A amostra tinha horas de `event_metadata`, não meses — **esta query fica em aberto** e
> deve ser repetida com semanas acumuladas. Ver a ressalva no A3.

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
join esports_snapshots s on s.event_id = e.id
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
cerca de dois minutos — não basta. A watchlist com cadência por faixa (spec 000, item 3b)
já endereça isso; a query confirma se está funcionando.
