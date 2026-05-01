-- Fase 1.5: Inter-market detector fields (idempotente)

-- Adiciona colunas em events
alter table events
  add column if not exists neg_risk_market_id text,
  add column if not exists series_id text,
  add column if not exists series_slug text,
  add column if not exists series_recurrence text,
  add column if not exists event_metadata jsonb;

-- Indexes
create index if not exists idx_events_neg_risk
  on events(neg_risk_market_id)
  where neg_risk_market_id is not null;

create index if not exists idx_events_series
  on events(series_id)
  where series_id is not null;

-- Adiciona thresholds em system_config
alter table system_config
  add column if not exists inter_market_min_members integer default 3,
  add column if not exists inter_market_min_total_volume_24h numeric default 10000;
