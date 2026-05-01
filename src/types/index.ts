export type MarketCategory = 'ai_llm' | 'big_tech' | 'ai_infra' | 'ai_policy' | 'other';

export type MarketSubCategory =
  | 'model_release'
  | 'benchmark'
  | 'earnings'
  | 'regulation'
  | 'product_launch'
  | 'other';

export type SignalType = 'hype_reality_gap' | 'calendar_driven' | 'cross_market' | 'cross_market_intra' | 'cross_market_inter';

export interface Event {
  id: string;
  polymarket_id: string;
  slug: string | null;
  title: string;
  category: MarketCategory | null;
  sub_category: MarketSubCategory | null;
  description: string | null;
  outcomes: Record<string, unknown> | null;
  volume_total: number | null;
  volume_24h: number | null;
  liquidity: number | null;
  end_date: string | null;
  status: string;
  resolved_outcome: string | null;
  tracked: boolean;
  neg_risk_market_id: string | null;
  series_id: string | null;
  series_slug: string | null;
  series_recurrence: string | null;
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
  bankroll_usd: number;
  max_stake_pct: number;
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
  updated_at: string;
}

export interface CrossMarketSignalMetadata {
  price_sum: number;
  deviation: number;
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
  group_size: number;
  price_sum: number;
  deviation: number;
  direction: 'over' | 'under';
  total_volume_24h: number;
  members: CrossMarketInterMember[];
  detection_count: number;
  last_seen_at: string;
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
  active: boolean;
  closed: boolean;
  bestBid: number;
  bestAsk: number;
  spread: number;
  lastTradePrice: number;
  negRisk?: boolean;
  negRiskMarketID?: string | null;
  series?: Array<{ id: string; slug: string; seriesType?: string; recurrence?: string }> | null;
  eventMetadata?: Record<string, unknown> | null;
}

export interface ClobOrderbook {
  market: string;
  asset_id: string;
  bids: Array<{ price: string; size: string }>;
  asks: Array<{ price: string; size: string }>;
  hash: string;
}
