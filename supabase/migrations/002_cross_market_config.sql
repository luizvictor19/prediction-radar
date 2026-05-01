-- Adiciona colunas pros detectores e retenção (idempotente)
alter table system_config
  add column if not exists cross_market_log_threshold numeric default 0.03,
  add column if not exists cross_market_high_confidence_threshold numeric default 0.08,
  add column if not exists cross_market_dedup_window_minutes integer default 30,
  add column if not exists snapshot_retention_days integer default 14,
  add column if not exists system_logs_retention_days integer default 30;

-- Trigger pra atualizar updated_at automaticamente
create or replace function update_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists system_config_updated_at on system_config;
create trigger system_config_updated_at
  before update on system_config
  for each row execute function update_updated_at();

-- Seed inicial (executa só se a tabela estiver vazia)
insert into system_config (
  id,
  bankroll_usd,
  max_stake_pct,
  kelly_fraction,
  min_confidence_alert,
  drawdown_stop_pct,
  daily_report_hour
)
select 1, 500.00, 0.03, 0.25, 0.70, 0.20, 9
where not exists (select 1 from system_config);
