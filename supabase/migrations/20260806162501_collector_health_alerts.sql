-- Alerta de coletor parado.
--
-- Motivação concreta: o collector geral ficou 48h travado sem ninguém notar.
-- Falha silenciosa não produz erro, e sem erro não há nada para alertar — o
-- sintoma é a AUSÊNCIA de trabalho, que só vira sinal se alguém a registrar.
--
-- ---------------------------------------------------------------------------
-- Por que tabela nova, e não uma consulta a `system_logs`
-- ---------------------------------------------------------------------------
--
-- Porque a cadência de log não é a cadência de ciclo, e a diferença é grande
-- justamente em dois dos quatro componentes vigiados:
--
--   `open_legs_collector` retorna cedo, SEM LOGAR NADA, quando não há aposta
--   aberta (`legs.length === 0`). Esse é o estado normal na maior parte do
--   tempo. Um monitor lendo `system_logs` alertaria para sempre — e alerta que
--   mente é alerta que se aprende a silenciar, o que deixaria o sistema pior do
--   que sem monitor nenhum.
--
--   `watchlist_collector` tica a cada 5s e agrega o log em UMA linha a cada
--   5 min. O silêncio entre elas é saúde, não sintoma.
--
-- E há o custo: `system_logs` já chegou a 755 MB / 2,7M linhas neste projeto.
-- Pendurar batimento lá seria inserir linha nova a cada ciclo de um coletor que
-- roda a cada 5 segundos. Aqui é UPSERT numa tabela de 4 linhas — não cresce.
--
-- ---------------------------------------------------------------------------
-- Duas tabelas, dois donos
-- ---------------------------------------------------------------------------
--
-- `collector_heartbeats` é escrita pelo processo dos COLETORES.
-- `collector_health_alerts` é escrita pelo processo do BOT.
--
-- Não é separação decorativa. O upsert do PostgREST só toca as colunas que
-- recebe, então em tese caberia tudo numa tabela — mas apostar nesse detalhe de
-- implementação para duas escritas concorrentes de processos diferentes é como
-- se perde estado de alerta em silêncio. Donos distintos, tabelas distintas.
--
-- O monitor roda no processo do BOT de propósito: o modo de falha a detectar é o
-- processo dos coletores travar, e um vigia dentro dele trava junto. Isso
-- pressupõe que bot e coletores são serviços separados no Railway — se um dia
-- forem unificados, este desenho para de cumprir a função e o substituto tem que
-- ser externo.

-- ---------------------------------------------------------------------------
-- Batimento
-- ---------------------------------------------------------------------------

create table if not exists public.collector_heartbeats (
  component     text primary key,
  last_cycle_at timestamptz not null default now(),
  -- Status do CICLO, não do batimento: um ciclo que terminou com erro bateu —
  -- está vivo, só não está bem, e as duas coisas são alertas diferentes.
  last_status   text not null default 'success',
  last_detail   text,
  updated_at    timestamptz not null default now()
);

comment on table public.collector_heartbeats is
  'Ultimo ciclo COMPLETADO por coletor. Escrita pelo processo dos coletores (src/lib/heartbeat.ts), lida pelo monitor no processo do bot. Nao usa system_logs porque open_legs nao loga quando nao ha aposta aberta e watchlist agrega log a cada 5min.';

comment on column public.collector_heartbeats.last_cycle_at is
  'Instante do fim do ciclo. Pode estar ate 60s atrasado: a escrita e throttled em memoria porque a watchlist tica a cada 5s. Irrelevante contra limiares de 10-20 min.';

-- ---------------------------------------------------------------------------
-- Estado do alerta
-- ---------------------------------------------------------------------------
--
-- Persistido, e não em memória do bot, por dois motivos: o cooldown tem que
-- sobreviver a restart (a política do Railway é `on_failure` com 3 tentativas —
-- um loop de restart com estado em memória viraria uma rajada de mensagens), e
-- a recuperação precisa saber desde quando estava parado para reportar o tempo.

create table if not exists public.collector_health_alerts (
  component        text primary key,
  -- 'ok' | 'alerting'
  state            text not null default 'ok',
  -- Instante em que o coletor PAROU (last_cycle_at + limiar), não o da detecção.
  -- É o que faz a mensagem de recuperação reportar o tempo real de parada.
  since            timestamptz,
  last_notified_at timestamptz,
  updated_at       timestamptz not null default now(),
  constraint collector_health_alerts_state_check check (state in ('ok', 'alerting'))
);

comment on table public.collector_health_alerts is
  'Estado do alerta de saude por coletor. Escrita pelo processo do bot. Persistido para o cooldown sobreviver a restart do bot.';

-- ---------------------------------------------------------------------------
-- Configuração
-- ---------------------------------------------------------------------------
--
-- Limiar por componente porque as cadências não se parecem: a descoberta roda a
-- cada 3 min, o auto-resolver a cada 5, a watchlist tica a cada 5s e o open_legs
-- a cada 10s. Um número só serviria mal a todos.
--
-- Os defaults são múltiplos folgados da cadência de cada um — 4 a 5 ciclos
-- perdidos antes de avisar. Apertá-los troca detecção mais rápida por risco de
-- falso positivo em rajada de lentidão da Gamma; afrouxá-los é o inverso.

alter table public.system_config
  add column if not exists health_alerts_enabled boolean not null default true,
  -- cron */3min  -> ~5 ciclos
  add column if not exists health_stale_discovery_minutes integer not null default 15,
  -- tick 5s, mas o batimento é throttled a 60s -> folga enorme
  add column if not exists health_stale_watchlist_minutes integer not null default 10,
  -- cron */5min  -> 4 ciclos
  add column if not exists health_stale_resolved_detector_minutes integer not null default 20,
  -- tick 10s
  add column if not exists health_stale_open_legs_minutes integer not null default 10,
  add column if not exists health_alert_cooldown_minutes integer not null default 60;

comment on column public.system_config.health_alerts_enabled is
  'Liga/desliga TODO o alerta de saude. Ver as colunas health_stale_* para desligar um componente so.';

comment on column public.system_config.health_stale_discovery_minutes is
  'Minutos sem completar ciclo antes de avisar. 0 DESLIGA a vigilancia deste componente — e o que se usa quando o coletor foi desligado de proposito e o silencio dele e esperado.';

comment on column public.system_config.health_stale_watchlist_minutes is
  'Minutos sem completar ciclo antes de avisar. 0 desliga a vigilancia deste componente.';

comment on column public.system_config.health_stale_resolved_detector_minutes is
  'Minutos sem completar ciclo antes de avisar. 0 desliga a vigilancia deste componente.';

comment on column public.system_config.health_stale_open_legs_minutes is
  'Minutos sem completar ciclo antes de avisar. 0 desliga a vigilancia deste componente.';

comment on column public.system_config.health_alert_cooldown_minutes is
  'Intervalo minimo entre dois avisos do MESMO componente ainda parado. Nao afeta a mensagem de normalizacao, que sai assim que o coletor volta.';

-- ---------------------------------------------------------------------------
-- Destino do alerta operacional
-- ---------------------------------------------------------------------------
--
-- Separado de `telegram_chat_id` mesmo sendo o mesmo número hoje, porque os dois
-- têm donos diferentes: `telegram_chat_id` é "para quem vão os sinais" e vira
-- POR USUÁRIO quando a A6 da spec 001 criar `users`. Alerta de coletor parado
-- não é notícia de usuário — é do operador, e continua sendo de um só depois do
-- multi-tenant.
--
-- Uma coluna agora contra caçar todo call site num sistema já multi-usuário
-- depois, sob o risco de o alerta operacional vazar para a caixa de quem não
-- pode agir sobre ele.
--
-- Null cai em `telegram_chat_id`: a coluna nova não exige configuração no dia do
-- apply, o alerta segue indo para onde já ia.

alter table public.system_config
  add column if not exists ops_telegram_chat_id text;

comment on column public.system_config.ops_telegram_chat_id is
  'Destino dos alertas operacionais (coletor parado). Separado de telegram_chat_id porque este vira por usuario na A6 da spec 001 e o alerta de saude continua sendo do operador. Null cai em telegram_chat_id.';

-- ---------------------------------------------------------------------------
-- Permissões
-- ---------------------------------------------------------------------------
--
-- O servidor usa service_role. `anon` não tem o que fazer aqui, e o baseline
-- deste projeto já concedeu demais uma vez (ver 20260806032316).

alter table public.collector_heartbeats     enable row level security;
alter table public.collector_health_alerts  enable row level security;

revoke all on table public.collector_heartbeats    from public, anon, authenticated;
revoke all on table public.collector_health_alerts from public, anon, authenticated;

grant select, insert, update on table public.collector_heartbeats    to service_role;
grant select, insert, update on table public.collector_health_alerts to service_role;

-- ---------------------------------------------------------------------------
-- Sem seed de linhas
-- ---------------------------------------------------------------------------
--
-- `collector_heartbeats` nasce vazia de propósito. O monitor NÃO alerta para
-- componente sem linha: entre este apply e o deploy do código que bate, os
-- quatro estariam nesse estado, e quatro alertas falsos de estreia ensinariam a
-- ignorar o canal no primeiro dia.
--
-- O preço é conhecido: um coletor que nunca rodou uma vez sequer é invisível
-- para o monitor. Aceitável porque `index.ts` dispara todos na subida do
-- processo, e o caso que motivou isto é o coletor que rodava e parou. O monitor
-- registra o estado "nunca bateu" em `system_logs` uma vez por processo, para
-- que ele seja descobrível sem ser barulhento.
--
-- Para conferir depois do apply, quando o código já tiver subido:
--
--   select component, last_cycle_at, last_status,
--          round(extract(epoch from (now() - last_cycle_at))/60) as min_atras
--     from collector_heartbeats
--    order by last_cycle_at;
--
-- Os quatro componentes devem aparecer: discovery_collector, watchlist_collector,
-- resolved_detector, open_legs_collector.
