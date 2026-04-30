-- Mercados Polymarket monitorados
create table events (
  id uuid primary key default gen_random_uuid(),
  polymarket_id text not null unique,
  slug text,
  title text not null,
  category text,             -- 'ai_llm' | 'big_tech' | 'ai_infra' | 'ai_policy' | 'other'
  sub_category text,         -- 'model_release' | 'benchmark' | 'earnings' | 'regulation' | etc
  description text,
  outcomes jsonb,
  volume_total numeric,
  volume_24h numeric,
  liquidity numeric,
  end_date timestamptz,
  status text default 'active',
  resolved_outcome text,
  tracked boolean default true,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index idx_events_status_volume on events(status, volume_24h desc);
create index idx_events_category on events(category) where tracked = true;

-- Snapshots de orderbook
create table polymarket_snapshots (
  id bigserial primary key,
  event_id uuid references events(id) on delete cascade,
  outcome text not null,
  best_bid numeric(5,4),
  best_ask numeric(5,4),
  mid_price numeric(5,4),
  spread numeric(5,4),
  bid_depth numeric(14,2),
  ask_depth numeric(14,2),
  volume_24h numeric(14,2),
  captured_at timestamptz default now()
);

create index idx_snapshots_event_time on polymarket_snapshots(event_id, captured_at desc);

-- Sinais detectados
create table detected_signals (
  id uuid primary key default gen_random_uuid(),
  event_id uuid references events(id) on delete cascade,
  signal_type text not null,          -- 'hype_reality_gap' | 'calendar_driven' | 'cross_market'
  confidence_score numeric(3,2),
  reasoning text,
  metadata jsonb,
  suggested_outcome text,
  suggested_stake_pct numeric(4,3),
  expires_at timestamptz,
  alerted boolean default false,
  acted_on boolean default false,
  dismissed boolean default false,
  created_at timestamptz default now()
);

create index idx_signals_active on detected_signals(created_at desc)
  where dismissed = false and acted_on = false;

-- Operações manuais (sincronizadas com planilha externa)
create table my_bets (
  id uuid primary key default gen_random_uuid(),
  external_id text,
  event_id uuid references events(id),
  signal_id uuid references detected_signals(id),
  outcome text not null,
  entry_price numeric(5,4) not null,
  closing_price numeric(5,4),
  resolution_price numeric(5,4),
  stake_usd numeric(10,2) not null,
  shares numeric(10,4),
  thesis text,
  thesis_type text,               -- 'fundamental' | 'technical' | 'mixed' | 'gut'
  confidence_self numeric(3,1),
  result text,
  pnl_usd numeric(10,2),
  clv numeric(5,4),
  notes text,
  placed_at timestamptz default now(),
  closed_at timestamptz
);

-- Configuração
create table system_config (
  id int primary key default 1,
  bankroll_usd numeric(10,2) not null default 500,
  max_stake_pct numeric(4,3) default 0.03,
  kelly_fraction numeric(3,2) default 0.25,
  min_confidence_alert numeric(3,2) default 0.75,
  drawdown_stop_pct numeric(4,3) default 0.20,
  telegram_chat_id text,
  daily_report_hour int default 9,
  updated_at timestamptz default now()
);

insert into system_config (id) values (1);

-- Logs
create table system_logs (
  id bigserial primary key,
  component text not null,
  status text not null,
  message text,
  metadata jsonb,
  created_at timestamptz default now()
);
