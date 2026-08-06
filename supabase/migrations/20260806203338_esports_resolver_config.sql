-- Spec 001, item 3 — config do resolver agendado.
--
-- Duas colunas em `system_config`. Nenhuma tabela nova, nenhum dado migrado.
--
-- ---------------------------------------------------------------------------
-- Por que o default é `true`, ao contrário das flags de coletor
-- ---------------------------------------------------------------------------
--
-- `volume_scan_enabled`, `early_markets_enabled` e `generic_detectors_enabled`
-- nasceram `false` porque eram desligamentos: o código já rodava e a migration
-- existia para PARAR. Aqui é o oposto — o componente é novo e o pedido é que ele
-- comece a rodar.
--
-- E ligado por default não surpreende, porque o resolver já tem uma trava
-- própria e melhor: ele sonda `market_match_links` antes de qualquer escrita e
-- não faz nada enquanto a migration 20260806183705 não estiver aplicada. Quem
-- decide quando ele começa a escrever continua sendo quem aplica aquela
-- migration, não esta.
--
-- O fallback embutido em `src/lib/config.ts` também é `true`, pelo mesmo motivo
-- de `health_alerts_enabled`: o código sobe antes do apply, e um componente que
-- nasce desligado por falta de coluna fica esperando um apply que ninguém sabe
-- que está faltando.

alter table public.system_config
  add column if not exists esports_resolver_enabled boolean not null default true;

comment on column public.system_config.esports_resolver_enabled is
  'Liga o resolver de esports: o ciclo incremental de 10 min e o recompute semanal. Desligar aqui para o componente sem deploy. Spec 001, item 3.';

-- ---------------------------------------------------------------------------
-- O tamanho do lote conta evento PLANEJADO, não evento lido
-- ---------------------------------------------------------------------------
--
-- A distinção é o que mantém o ciclo útil depois de um deploy. O cursor do
-- varredor vive em memória; um processo novo recomeça do offset 0 e reencontra
-- os ~21,6k eventos que já têm link. Ler um desses é barato — nenhuma escrita,
-- nenhum planejamento, nenhuma consulta ao registro de times, ~3 requisições por
-- 200 eventos. Se o teto contasse leitura, o orçamento inteiro de um ciclo seria
-- gasto pulando histórico e o mercado NOVO só seria alcançado dezenas de ciclos
-- depois.
--
-- 1000 é folgado para o regime normal (a descoberta traz dezenas de markets por
-- ciclo de 3 min) e serve de freio se a taxa de erro do Postgres (H2) pedir
-- menos pressão de escrita.

alter table public.system_config
  add column if not exists esports_resolver_batch_size integer not null default 1000;

comment on column public.system_config.esports_resolver_batch_size is
  'Eventos PLANEJADOS por ciclo incremental do resolver — nao eventos lidos. Evento que ja tem link e pulado sem consumir o teto. Spec 001, item 3.';

alter table public.system_config
  add constraint system_config_esports_resolver_batch_positive
  check (esports_resolver_batch_size > 0);
