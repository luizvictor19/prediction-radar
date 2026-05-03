-- Fase 1.6: Coleta ampla + ajuste de fee (idempotente)

-- Adiciona polymarket_category (feeType nativo), polymarket_fee_rate e is_ai_tech em events
alter table events
  add column if not exists polymarket_category text,
  add column if not exists polymarket_fee_rate numeric,
  add column if not exists is_ai_tech boolean default false;

create index if not exists idx_events_polymarket_category
  on events(polymarket_category)
  where polymarket_category is not null;

create index if not exists idx_events_is_ai_tech
  on events(is_ai_tech)
  where is_ai_tech = true;

-- Adiciona thresholds em system_config
alter table system_config
  add column if not exists min_expected_edge_pct numeric default 1.5,
  add column if not exists log_expected_edge_pct numeric default 0.5,
  add column if not exists excluded_categories text[] default '{}',
  add column if not exists collector_min_volume_24h numeric default 10000,
  add column if not exists collector_min_liquidity numeric default 20000;

-- Reduz retention de snapshots de 14 pra 7 dias
update system_config set snapshot_retention_days = 7 where id = 1;

-- Adiciona polymarket_category e domain_confidence em my_bets
alter table my_bets
  add column if not exists polymarket_category text,
  add column if not exists domain_confidence integer
    check (domain_confidence is null or (domain_confidence >= 1 and domain_confidence <= 10));
