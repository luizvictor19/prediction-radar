-- Spec 001, item 1 — camada de entidades de esports (Partes A1-A4).
--
-- Cria seis tabelas e nada mais: `verticals`, `esports_teams`, `esports_leagues`,
-- `esports_tournaments`, `esports_matches`, `market_match_links`. Nenhuma tabela
-- existente é alterada, nenhum dado é migrado, nenhum job muda de comportamento.
-- Aplicar isto não muda nada em produção até o resolver (item 3) existir.
--
-- `context_fragments` (A5) e o `user_id`/RLS multi-tenant (A6) NÃO estão aqui:
-- são os itens 4 e 7 da ordem de implementação, com pré-requisitos humanos
-- próprios (H5 e H4). Misturá-los faria uma migration que não dá para aplicar em
-- pedaços verificáveis, que é justamente o que o H4 pede.
--
-- ---------------------------------------------------------------------------
-- Permissões: por que toda tabela aqui repete o mesmo par de linhas
-- ---------------------------------------------------------------------------
--
-- As default privileges deste banco dão DML a `anon` e `authenticated` em toda
-- tabela nova do schema public — o mesmo achado que a 20260805142957 registrou
-- para as partições de snapshot. `enable row level security` sozinho não basta
-- para quem chega pelo PostgREST com a chave pública; o `revoke` é o que fecha.
-- Nenhuma policy é criada: o servidor usa service_role, que passa por cima de
-- RLS, e não existe cliente autenticado neste projeto.

-- ---------------------------------------------------------------------------
-- A1 — Verticais
-- ---------------------------------------------------------------------------
--
-- `id` é text e não uuid de propósito: 'cs2' aparece em log, em config e no
-- slug do mercado. Uma FK legível é o que permite ler `esports_teams` sem join.
--
-- `provider_league` existe porque NÃO é derivável do prefixo do slug: medido,
-- cs2 -> 'csgo', val -> 'valorant'. É a chave de junção com `teams[].league` do
-- payload da Gamma, e assumir que era o prefixo quebraria já no primeiro
-- registro de CS2.
--
-- `enabled` nasce false para lol e dota2 porque habilitar vertical é decisão do
-- dono (H7), não consequência de aplicar migration.

create table if not exists public.verticals (
  id              text primary key,
  name            text not null,
  slug_prefix     text not null,
  provider_league text not null,
  enabled         boolean not null default false,
  config          jsonb not null default '{}',
  created_at      timestamptz not null default now()
);

comment on table public.verticals is
  'Verticais de esports. id text (cs2|lol|dota2) para ser legivel em log e config. Spec 001, A1.';

comment on column public.verticals.slug_prefix is
  'Prefixo do slug do mercado no Polymarket, com hifen: cs2-, lol-, dota2-. Usado pelo parser de slug.';

comment on column public.verticals.provider_league is
  'Vocabulario da Gamma em teams[].league. NAO e igual ao slug_prefix: cs2 -> csgo, val -> valorant.';

comment on column public.verticals.enabled is
  'Vertical ativa para coleta e resolucao. Habilitar e decisao humana (spec 001, H7), nunca do resolver.';

alter table public.verticals enable row level security;

revoke all on public.verticals from anon, authenticated;

insert into public.verticals (id, name, slug_prefix, provider_league, enabled) values
  ('cs2',   'Counter-Strike 2',  'cs2-',   'csgo',  true),
  ('lol',   'League of Legends', 'lol-',   'lol',   false),
  ('dota2', 'Dota 2',            'dota2-', 'dota2', false)
on conflict (id) do nothing;

-- `do nothing` e não `do update`: se alguém já ajustou `enabled` ou `config` à
-- mão, reaplicar esta migration não reverte a escolha.

-- ---------------------------------------------------------------------------
-- A2 — Times
-- ---------------------------------------------------------------------------
--
-- `unique (vertical_id, polymarket_code)` é o ponto crítico do desenho, e está
-- confirmado pela API antes de virar constraint: 972 chaves (league,
-- abbreviation) medidas, 0 colisões.
--
-- A consequência de não haver chave de organização na API (`team.id` e
-- `providerId` distintos por jogo, 73 abbreviations em ligas diferentes com
-- identidades distintas) é que `aur1` em cs2 e `aur1` em dota2 são DUAS LINHAS e
-- duas entidades independentes. Não é limitação temporária a ser costurada
-- depois por heurística — é a decisão registrada na Parte G da spec. Reunir as
-- duas linhas só ganha sentido com fonte externa de org (Liquipedia), em spec
-- própria.
--
-- `needs_review` distingue a origem, não a qualidade do nome: false para o que
-- veio de `teams[]` (dado da API), true para o que veio só do slug (caminho 2 do
-- resolver, onde `display_name` fica null e só existe o código).

create table if not exists public.esports_teams (
  id                 uuid primary key default gen_random_uuid(),
  vertical_id        text not null references public.verticals (id),
  polymarket_code    text not null,
  display_name       text,
  polymarket_team_id bigint,
  pandascore_team_id bigint,
  logo_url           text,
  external_ids       jsonb not null default '{}',
  needs_review       boolean not null default false,
  created_at         timestamptz not null default now(),
  unique (vertical_id, polymarket_code),
  -- Alvo da FK composta de `esports_matches`. Ver a nota em A3.
  unique (id, vertical_id)
);

comment on table public.esports_teams is
  'Times por vertical. Chave (vertical_id, polymarket_code) validada contra a API: 972 chaves medidas, 0 colisoes. Sem tabela de organizacoes: a API nao expoe chave de org, entao aur1 em cs2 e aur1 em dota2 sao entidades independentes. Spec 001, A2 e Parte G.';

comment on column public.esports_teams.polymarket_code is
  'teams[].abbreviation da Gamma, que e tambem o codigo do slug. Medido: casa em 2307/2307 eventos, na ordem do slug.';

comment on column public.esports_teams.external_ids is
  'Ids de fontes que ainda nao temos (GRID, Liquipedia). Vazio ate a spec seguinte. Ids da Gamma e do PandaScore tem coluna propria.';

comment on column public.esports_teams.needs_review is
  'true = identidade veio so do slug (caminho 2 do resolver), sem nome canonico. Dado vindo de teams[] entra com false.';

alter table public.esports_teams enable row level security;

revoke all on public.esports_teams from anon, authenticated;

-- ---------------------------------------------------------------------------
-- A3 — Competições: três níveis, porque a API entrega três
-- ---------------------------------------------------------------------------
--
-- liga (eventMetadata.league) -> edição (eventMetadata.serie) -> partida.
-- Colapsar os dois primeiros foi o erro da versão anterior da spec: o tier não é
-- propriedade do nome da liga (VCT aparece em tier 2, 3 e 5), então uma tabela
-- só de liga não tem onde guardar tier sem mentir.

create table if not exists public.esports_leagues (
  id          uuid primary key default gen_random_uuid(),
  vertical_id text not null references public.verticals (id),
  name        text not null,
  created_at  timestamptz not null default now(),
  unique (vertical_id, name),
  -- Alvo da FK composta de `esports_tournaments`. Ver a nota abaixo.
  unique (id, vertical_id)
);

comment on table public.esports_leagues is
  'Competicao, de eventMetadata.league. 37 valores distintos medidos. Sem aliases nem normalizacao de nome: o vocabulario vem controlado da API, nao extraido de titulo. Spec 001, A3 e Parte G.';

alter table public.esports_leagues enable row level security;

revoke all on public.esports_leagues from anon, authenticated;

-- `serie text not null default ''` — o desenho, e o que o confirma
-- ......................................................................
--
-- `serie` faz parte da chave única, e em Postgres null não é igual a null num
-- índice único. Com coluna nullable, duas edições sem série na mesma liga
-- criariam duas linhas em vez de colidir, e o resolver fabricaria uma edição
-- nova a cada partida. `''` colide com `''` e resolve isso sem coalesce no
-- índice nem índice funcional.
--
-- `''` significa "edição sem série nomeada", NÃO "desconhecido". Não é motivo
-- para `needs_review`, e uma edição com `serie = ''` é tão final quanto uma com
-- 'China Stage 2'.
--
-- A leitura foi verificada antes desta migration, não depois: a query de
-- contraprova da spec (liga com série nomeada E vazia convivendo) voltou com 0
-- linhas em 2026-08-06. Zero linhas é o resultado que sustenta o desenho.
--
-- O limite dessa verificação, que fica registrado aqui porque é onde vai doer:
-- `events.event_metadata` só passou a ser gravado em 2026-08-06, então a amostra
-- é de HORAS, não de meses. Nenhuma liga teve tempo de mudar de formato dentro
-- dela. Repetir a query com semanas acumuladas é obrigatório — uma liga pode
-- passar a ter split, e o sintoma seria exatamente uma linha nessa query.
--
-- Se um dia ela voltar com linha, o conserto NÃO é relaxar a constraint: é
-- passar a tratar o vazio como desconhecido, com `needs_review` e fila. Isso
-- muda o resolver e pede migration própria.

create table if not exists public.esports_tournaments (
  id           uuid primary key default gen_random_uuid(),
  vertical_id  text not null references public.verticals (id),
  -- Sem FK de coluna só: a composta lá embaixo já garante a existência da liga,
  -- e ainda garante que ela é da mesma vertical. Declarar as duas seria pagar
  -- dois triggers para checar a mais fraca duas vezes.
  league_id    uuid not null,
  serie        text not null default '',
  tier         text,
  is_lan       boolean,
  external_ids jsonb not null default '{}',
  needs_review boolean not null default false,
  created_at   timestamptz not null default now(),
  unique (vertical_id, league_id, serie),
  unique (id, vertical_id),
  -- A liga tem que ser da mesma vertical do torneio. `vertical_id` aqui é
  -- redundante com o da liga, e sem esta FK composta a redundância pode
  -- divergir em silêncio — um torneio 'cs2' pendurado numa liga 'lol' passaria
  -- despercebido e envenenaria toda consulta por vertical.
  foreign key (league_id, vertical_id)
    references public.esports_leagues (id, vertical_id)
);

comment on table public.esports_tournaments is
  'Edicao/split de uma competicao, de eventMetadata.serie (cobertura ~46%). Spec 001, A3.';

comment on column public.esports_tournaments.serie is
  'Edicao. NUNCA null: faz parte da chave unica, e null nao colide com null em indice unico. String vazia significa "edicao sem serie nomeada", que e fato completo e nao gera needs_review. Verificado em 2026-08-06 com amostra de horas; repetir a contraprova da spec com semanas acumuladas.';

comment on column public.esports_tournaments.tier is
  'Tier CONSOLIDADO, escala "1".."5". Preenchido por revisao humana (spec 001, H6). O resolver NUNCA escreve aqui: o tier observado por partida vive em esports_matches.league_tier, porque medido ele varia dentro da mesma liga (VCT em 2, 3 e 5).';

comment on column public.esports_tournaments.needs_review is
  'Pendencia real de identidade. serie = "" NAO e pendencia e nao deve entrar na fila do /review.';

alter table public.esports_tournaments enable row level security;

revoke all on public.esports_tournaments from anon, authenticated;

-- Fila do /review (item 6). Índice parcial: só as pendências entram, então ele
-- é do tamanho da fila e não da tabela — e some quando a fila zera.
create index if not exists idx_tournaments_review
  on public.esports_tournaments (needs_review) where needs_review;

create index if not exists idx_teams_review
  on public.esports_teams (needs_review) where needs_review;

-- ---------------------------------------------------------------------------
-- A3 — Partidas
-- ---------------------------------------------------------------------------
--
-- `match_slug` é a chave, e não `pandascoreMatchId`. A bijeção entre os dois é
-- perfeita onde ambos existem (151 grupos, 0 violações nos dois sentidos), mas
-- pandascore só existe desde junho/2026 e `match_slug` funciona no histórico
-- inteiro. Trocar a chave por um campo que falta em metade do backfill seria
-- trocar cobertura por elegância. Pandascore e GRID vão para `external_ids`.
--
-- É o slug da SÉRIE, sem sufixo -gameN: os markets de game individual apontam
-- para a mesma partida, e é `market_match_links.market_role` que os distingue.
--
-- `league_tier` e `best_of` ficam sem CHECK de vocabulário de propósito. A
-- escala medida é "1".."5" e os Bo observados são 1/2/3/5, mas um valor novo
-- vindo da API deve virar linha gravada e revisável, não exceção que derruba o
-- resolver no meio de um lote. Restringir aqui transformaria "a Gamma mudou o
-- vocabulário" em incidente de coleta.

create table if not exists public.esports_matches (
  id             uuid primary key default gen_random_uuid(),
  vertical_id    text not null references public.verticals (id),
  match_slug     text not null unique,
  -- Sem FK de coluna só nestas quatro: as compostas no fim da tabela já as
  -- cobrem, e de forma mais forte. Ver a nota junto delas.
  team_a_id      uuid,
  team_b_id      uuid,
  tournament_id  uuid,
  stage          text,
  league_tier    text,
  best_of        int,
  scheduled_at   timestamptz,
  external_ids   jsonb not null default '{}',
  winner_team_id uuid,
  resolved_at    timestamptz,
  needs_review   boolean not null default false,
  created_at     timestamptz not null default now(),

  constraint esports_matches_best_of_positive
    check (best_of is null or best_of > 0),

  -- Vencedor tem que ser um dos dois lados. Permissivo quando o lado ainda é
  -- null (caminho 2 do resolver, histórico sem identidade): comparação com null
  -- dá null, e CHECK só rejeita em false.
  constraint esports_matches_winner_is_a_side
    check (
      winner_team_id is null
      or winner_team_id = team_a_id
      or winner_team_id = team_b_id
    ),

  -- Mesma razão da FK composta em `esports_tournaments`: time e torneio têm que
  -- ser da vertical da partida. Com `team_a_id` null a FK não é checada
  -- (MATCH SIMPLE), que é o comportamento desejado no fallback histórico.
  foreign key (team_a_id, vertical_id)
    references public.esports_teams (id, vertical_id),
  foreign key (team_b_id, vertical_id)
    references public.esports_teams (id, vertical_id),
  foreign key (winner_team_id, vertical_id)
    references public.esports_teams (id, vertical_id),
  foreign key (tournament_id, vertical_id)
    references public.esports_tournaments (id, vertical_id)
);

comment on table public.esports_matches is
  'Partida (serie), chaveada por match_slug — o slug sem sufixo -gameN. match_slug e nao pandascoreMatchId porque este so existe desde jun/2026 e aquele cobre o historico inteiro. Spec 001, A3.';

comment on column public.esports_matches.match_slug is
  'Slug da SERIE: {jogo}-{codA}-{codB}-{YYYY-MM-DD}. Markets de game individual apontam para esta mesma linha; quem os distingue e market_match_links.market_role.';

comment on column public.esports_matches.stage is
  'Fase, de eventMetadata.tournament: Playoffs, Group D. 20 valores distintos medidos.';

comment on column public.esports_matches.league_tier is
  'Tier OBSERVADO nesta partida, de eventMetadata.leagueTier, escala "1".."5". Sem CHECK: vocabulario novo da API deve virar dado revisavel, nao erro de coleta. O tier consolidado por competicao vive em esports_tournaments.tier.';

comment on column public.esports_matches.best_of is
  'Do sufixo Bo{N} de events.event_metadata/score. Medido: bate 133/133 com o (BOn) do titulo.';

comment on column public.esports_matches.external_ids is
  'pandascore_match_id, grid_series_id, polymarket_event_id.';

alter table public.esports_matches enable row level security;

revoke all on public.esports_matches from anon, authenticated;

create index if not exists idx_matches_scheduled
  on public.esports_matches (vertical_id, scheduled_at desc);

-- Sem índice em `tournament_id` e `team_a_id`/`team_b_id` por ora: são milhares
-- de linhas e nenhum consumidor ainda. Quando o /review e o backtest existirem,
-- o índice se justifica pelo plano de query real, não por antecipação.

-- ---------------------------------------------------------------------------
-- A4 — Ligação mercado <-> partida
-- ---------------------------------------------------------------------------
--
-- `event_id` como PK: uma linha de `events` é um MARKET, e cada market pertence
-- a no máximo uma partida. A cardinalidade fica declarada em vez de convencionada.
--
-- `on delete cascade` nos dois lados: link é derivado, não é fato. Sumindo o
-- market ou a partida, o link não tem o que significar. Nada de série temporal
-- se perde nisso — `esports_snapshots` não tem FK para `events` justamente para
-- não participar de cascade.

create table if not exists public.market_match_links (
  event_id          uuid primary key references public.events (id) on delete cascade,
  match_id          uuid not null references public.esports_matches (id) on delete cascade,
  market_role       text not null,
  slug_suffix       text,
  outcome_a_index   int,
  confidence        numeric(3,2) not null,
  resolution_method text not null,
  needs_review      boolean not null default false,
  created_at        timestamptz not null default now(),

  constraint market_match_links_confidence_range
    check (confidence >= 0 and confidence <= 1),

  constraint market_match_links_resolution_method
    check (resolution_method in ('event_teams', 'slug_parse', 'manual')),

  constraint market_match_links_outcome_index
    check (outcome_a_index is null or outcome_a_index >= 0)
);

comment on table public.market_match_links is
  'Liga um market de events a uma partida. PK em event_id: um market pertence a no maximo uma partida. Spec 001, A4.';

comment on column public.market_match_links.market_role is
  'Espelha events.sports_market_type (moneyline, child_moneyline, totals, ...). Sem CHECK: o Polymarket ja documenta 30+ valores e a lista cresce sem aviso.';

comment on column public.market_match_links.slug_suffix is
  'O que sobra do slug depois da data, CRU e sem interpretacao. Quem determina o papel do market e market_role, nunca o sufixo.';

comment on column public.market_match_links.outcome_a_index is
  'Indice do team_a em events.outcomes.values, resolvido POR MARKET: medido, 19 de 79 eventos tem markets irmaos com outcomes em ordens diferentes. NULL e correto e esperado em market derivado sem lado de time (Over/Under) — nao e pendencia de revisao.';

comment on column public.market_match_links.resolution_method is
  'event_teams = casou por teams[] da API (confidence 1.0). slug_parse = heuristica sobre o slug, historico sem metadado (confidence <= 0.7). manual = revisao humana.';

alter table public.market_match_links enable row level security;

revoke all on public.market_match_links from anon, authenticated;

create index if not exists idx_link_match
  on public.market_match_links (match_id);

create index if not exists idx_link_review
  on public.market_match_links (needs_review) where needs_review;
