export type MarketCategory = 'ai_llm' | 'big_tech' | 'ai_infra' | 'ai_policy' | 'other';

export type ArbDirection = 'over' | 'under';

export type MarketSubCategory =
  | 'model_release'
  | 'benchmark'
  | 'earnings'
  | 'regulation'
  | 'product_launch'
  | 'other';

export type SignalType = 'hype_reality_gap' | 'calendar_driven' | 'cross_market' | 'cross_market_intra' | 'cross_market_inter' | 'early_market';

export interface Event {
  id: string;
  polymarket_id: string;
  slug: string | null;
  title: string;
  category: MarketCategory | null;
  sub_category: MarketSubCategory | null;
  polymarket_category: string | null;
  polymarket_fee_rate: number | null;
  is_ai_tech: boolean;
  description: string | null;
  outcomes: Record<string, unknown> | null;
  volume_total: number | null;
  volume_24h: number | null;
  liquidity: number | null;
  end_date: string | null;
  sports_market_type: string | null;
  line: number | null;
  status: string;
  resolved_outcome: string | null;
  tracked: boolean;
  neg_risk_market_id: string | null;
  series_id: string | null;
  series_slug: string | null;
  series_recurrence: string | null;
  event_group_slug: string | null;
  event_metadata: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
}

export interface PolymarketSnapshot {
  id: number;
  event_id: string;
  outcome: string;
  best_bid: number | null;
  best_ask: number | null;
  mid_price: number | null;
  spread: number | null;
  bid_depth: number | null;
  ask_depth: number | null;
  volume_24h: number | null;
  captured_at: string;
}

export interface DetectedSignal {
  id: string;
  event_id: string;
  signal_type: SignalType;
  confidence_score: number;
  reasoning: string | null;
  metadata: Record<string, unknown> | null;
  suggested_outcome: string | null;
  suggested_stake_pct: number | null;
  expires_at: string | null;
  alerted: boolean;
  acted_on: boolean;
  dismissed: boolean;
  created_at: string;
}

export interface SystemConfig {
  id: number;
  cash_usd: number;
  max_stake_pct: number;
  cross_market_max_stake_pct: number;
  kelly_fraction: number;
  min_confidence_alert: number;
  drawdown_stop_pct: number;
  telegram_chat_id: string | null;
  daily_report_hour: number;
  cross_market_log_threshold: number;
  cross_market_high_confidence_threshold: number;
  cross_market_dedup_window_minutes: number;
  inter_market_min_members: number;
  inter_market_min_total_volume_24h: number;
  snapshot_retention_days: number;
  system_logs_retention_days: number;
  min_expected_edge_pct: number;
  notify_min_edge_pct: number;
  log_expected_edge_pct: number;
  excluded_categories: string[];
  collector_min_volume_24h: number;
  collector_min_liquidity: number;
  /** Prefixos de slug que a descoberta (spec 000, item 2a) persiste. */
  discovery_slug_prefixes: string[];
  discovery_lookback_minutes: number;
  signal_ttl_minutes: number;
  signal_cooldown_minutes: number;
  stale_cleanup_threshold_hours: number;
  dismiss_stale_cutoff_minutes: number;
  updated_at: string;
}

export interface CrossMarketSignalMetadata {
  price_sum: number;
  deviation: number;
  polymarket_category: string | null;
  fee_rate: number;
  expected_edge_pct: number;
  direction: 'over' | 'under';
  outcomes: Array<{ name: string; price: number }>;
  detection_count: number;
  last_seen_at: string;
}

export interface CrossMarketInterMember {
  event_id: string;
  polymarket_id: string;
  title: string;
  yes_price: number;
  volume_24h: number;
}

export interface CrossMarketInterSignalMetadata {
  neg_risk_market_id: string;
  polymarket_category: string | null;
  fee_rate: number;
  group_size: number;
  price_sum: number;
  deviation_gross: number;
  estimated_fee_cost: number;
  deviation_net: number;
  expected_edge_pct: number;
  direction: ArbDirection;
  coverage_ratio: number;
  total_volume_24h: number;
  members: CrossMarketInterMember[];
  detection_count: number;
  last_seen_at: string;
}

export interface CalendarDrivenSignalMetadata {
  end_date: string;
  days_until_resolution: number;
  current_yes_price: number;
  volatility_24h: number;
  snapshot_count: number;
  volume_24h: number;
  polymarket_category: string | null;
  is_ai_tech: boolean;
  detection_count: number;
  last_seen_at: string;
}

export interface MyBet {
  id: string;
  signal_id: string | null;
  event_id: string | null;
  thesis: string | null;
  thesis_type: string | null;
  confidence_self: number | null;
  domain_confidence: number | null;
  polymarket_category: string | null;
  notes: string | null;
  placed_at: string;
  closed_at: string | null;
}

export interface MyBetLeg {
  id: string;
  bet_id: string;
  event_id: string | null;
  outcome: string;
  entry_price: number;
  stake_usd: number;
  shares: number | null;
  closing_price: number | null;
  resolution_price: number | null;
  result: 'win' | 'loss' | 'void' | null;
  pnl_usd: number | null;
  clv: number | null;
  notes: string | null;
  closed_at: string | null;
  created_at: string;
}

export interface DetectedSignalInsert {
  event_id: string | null;
  signal_type: SignalType;
  confidence_score: number;
  reasoning: string;
  metadata: Record<string, unknown>;
  suggested_outcome: string | null;
  suggested_stake_pct: number | null;
  expires_at: string;
}

// Polymarket API response shapes
export interface GammaMarket {
  id: string;
  slug: string;
  question: string;         // maps to our `title`
  description: string;
  outcomes: string;         // JSON string: '["Yes", "No"]'
  outcomePrices: string;    // JSON string: '["0.57", "0.43"]'
  volume?: string;
  volumeNum?: number;
  volume24hr?: number;
  volume24hrClob?: number;
  liquidity?: string;
  liquidityNum?: number;
  endDate: string;
  /** Quando o market abriu. Ausente em alguns markets antigos. */
  startDate?: string;
  active: boolean;
  closed: boolean;
  bestBid: number;
  bestAsk: number;
  spread: number;
  lastTradePrice: number;
  negRisk?: boolean;
  negRiskMarketID?: string | null;
  feeType?: string | null;
  feeSchedule?: { rate: number; exponent: number; takerOnly: boolean; rebateRate: number } | null;
  series?: Array<{ id: string; slug: string; seriesType?: string; recurrence?: string }> | null;
  events?: Array<{ id: string; slug: string; title?: string; category?: string | null; eventMetadata?: Record<string, unknown> | null }> | null;
  eventMetadata?: Record<string, unknown> | null;
  sportsMarketType?: string | null;
  line?: number | null;
  /** 'resolved' quando o oráculo UMA já fechou o mercado. */
  umaResolutionStatus?: string;
  umaEndDate?: string;
}

export interface ClobOrderbook {
  market: string;
  asset_id: string;
  bids: Array<{ price: string; size: string }>;
  asks: Array<{ price: string; size: string }>;
  hash: string;
}
