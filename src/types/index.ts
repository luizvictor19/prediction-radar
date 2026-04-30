export type MarketCategory = 'ai_llm' | 'big_tech' | 'ai_infra' | 'ai_policy' | 'other';

export type MarketSubCategory =
  | 'model_release'
  | 'benchmark'
  | 'earnings'
  | 'regulation'
  | 'product_launch'
  | 'other';

export type SignalType = 'hype_reality_gap' | 'calendar_driven' | 'cross_market';

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
  updated_at: string;
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
}

export interface ClobOrderbook {
  market: string;
  asset_id: string;
  bids: Array<{ price: string; size: string }>;
  asks: Array<{ price: string; size: string }>;
  hash: string;
}
