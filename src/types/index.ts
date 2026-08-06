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
  /**
   * Horário real da partida (spec 000, item 7). Distinto de `start_date`
   * (abertura do mercado) e de `end_date` (fim da janela de resolução, ~6h
   * depois do jogo). É a âncora da cadência da watchlist.
   */
  game_start_time: string | null;
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
  /**
   * Janela de `esports_snapshots` (spec 000, item 3). Longa de propósito: é a
   * matéria-prima do backtest. O piso de 30 dias é aplicado no banco.
   */
  esports_snapshot_retention_days: number;
  system_logs_retention_days: number;
  min_expected_edge_pct: number;
  notify_min_edge_pct: number;
  log_expected_edge_pct: number;
  excluded_categories: string[];
  collector_min_volume_24h: number;
  collector_min_liquidity: number;
  /**
   * Varredura por volume (`collectAll`). Desligada na spec 000, item 4 —
   * descoberta (2a) e watchlist (2b) cobrem esports, e o que ela ainda trazia
   * era crypto/weather. O código fica; religar é um UPDATE.
   */
  volume_scan_enabled: boolean;
  /** Early-markets. Desligado pelo mesmo item 4: ver a migration para o porquê. */
  early_markets_enabled: boolean;
  /**
   * Os cinco detectores genéricos. Desligados junto com a varredura: leem
   * `polymarket_snapshots`, que parou de receber dado novo fora de esports.
   * Não afeta `cleanup_stale_signals`.
   */
  generic_detectors_enabled: boolean;
  /** Prefixos de slug que a descoberta (spec 000, item 2a) persiste. */
  discovery_slug_prefixes: string[];
  discovery_lookback_minutes: number;
  /** Cadência da watchlist por faixa (spec 000, itens 3b e 7). Ver a migration. */
  watchlist_interval_live_seconds: number;
  watchlist_interval_soon_seconds: number;
  watchlist_interval_far_seconds: number;
  /** Quantas vezes mais lento o derivado é refrescado. 1 desliga a distinção. */
  watchlist_derived_interval_multiplier: number;
  /** Quanto antes de `game_start_time` a faixa de 1 min começa. */
  watchlist_soon_window_minutes: number;
  /** Teto do ao vivo, para a partida que começou e nunca resolveu. */
  watchlist_live_max_minutes: number;
  /** `sports_market_type` que identifica o mercado da série. */
  watchlist_primary_market_types: string[];
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
  /**
   * Horário real da partida. Medido em 2026-08-06: presente em 171/171 markets
   * de esports, e ~6h antes do `endDate` (p50).
   *
   * Vem como `'2026-08-06 18:30:00+00'` — sem `T`, sem `Z`, não é ISO-8601.
   * Normalizar antes de gravar ou comparar (ver `gammaGameStartTime`).
   */
  gameStartTime?: string | null;
  /** Mesmo instante, em ISO. Só ~2/3 dos markets trazem — o da série. */
  eventStartTime?: string | null;
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
  series?: Array<GammaSeries> | null;
  /**
   * Só o embed de `/markets`. Vem sem `teams`, sem `sport` e sem `markets` —
   * ver `GammaEvent`. No market aninhado em `/events` este campo não existe.
   */
  events?: GammaEvent[] | null;
  /**
   * Nunca preenchido. Medido em 2026-08-06: 0 de 464 markets de esports trazem
   * o campo na raiz. O metadado real mora em `GammaEvent.eventMetadata`.
   * Mantido só para documentar a ausência — não ler daqui.
   */
  eventMetadata?: Record<string, unknown> | null;
  sportsMarketType?: string | null;
  line?: number | null;
  /** 'resolved' quando o oráculo UMA já fechou o mercado. */
  umaResolutionStatus?: string;
  umaEndDate?: string;
}

export interface GammaSeries {
  id: string;
  slug: string;
  seriesType?: string;
  recurrence?: string;
}

/**
 * Time de esports do evento.
 *
 * Existe **apenas** em `/events`: o embed `events[0]` de `/markets` não traz
 * `teams` nem `sport`. É o que torna a resolução de entidade exata em vez de
 * inferida do slug.
 */
export interface GammaTeam {
  id: number;
  name: string;
  /**
   * Vocabulário do provedor — 'csgo', 'lol', 'valorant', 'dota2'. NÃO é o
   * prefixo do slug ('cs2-'). A chave estável de um time é
   * `(league, abbreviation)`: medido em 2026-08-06, 972 chaves, 0 colisões.
   */
  league: string;
  /**
   * O mesmo código que aparece no slug do market. Medido sobre 2307 eventos no
   * formato de partida: 2307 casaram, na ordem do slug, 0 invertidos.
   */
  abbreviation: string;
  /** Id do time na PandaScore. */
  providerId?: number;
  logo?: string;
  color?: string;
  /**
   * 'home' | 'away' — a ordem do slug. Não confundir com a ordem de
   * `outcomes.values`, que diverge: medido, 19 de 79 eventos têm markets
   * irmãos com os outcomes em ordens diferentes.
   */
  ordering?: string;
  /** Sempre '0-0' na amostra medida. Sem conteúdo útil hoje. */
  record?: string;
}

/**
 * O evento da Gamma — a série, no vocabulário de esports.
 *
 * Dois formatos com o mesmo nome: o embed de `/markets` (id, slug, title,
 * startTime, eventMetadata) e o objeto completo de `/events`, que acrescenta
 * `teams`, `sport`, `series` e `markets[]`. Um tipo só, com o que é exclusivo
 * de `/events` opcional.
 */
export interface GammaEvent {
  id: string;
  slug: string;
  /** Igual a `slug` em 464/464 medidos. */
  ticker?: string;
  title?: string;
  category?: string | null;
  startDate?: string;
  /** Horário da partida em ISO. Rede final de `gammaGameStartTime`. */
  startTime?: string | null;
  /** Igual a `eventMetadata.pandascoreMatchId` em 464/464 medidos. */
  gameId?: string | number | null;
  /** Placar da série ao vivo: '0-0|1-2|Bo3'. O 'BoN' final é o best-of. */
  score?: string | null;
  /** Mapa atual sobre o total: '3/3'. */
  period?: string | null;
  live?: boolean;
  ended?: boolean;
  closed?: boolean;
  /**
   * league, leagueTier, serie, tournament, pandascoreMatchId, gridSeriesId e o
   * bloco `context_*` gerado pela própria Polymarket. Presente nos dois
   * formatos do evento.
   */
  eventMetadata?: Record<string, unknown> | null;
  /** Só em `/events`. */
  teams?: GammaTeam[] | null;
  /** Só em `/events`. `{ id, sport: 'cs2', resolution, ... }`. */
  sport?: Record<string, unknown> | null;
  /**
   * Só em `/events`. O market de esports vem sem `series` em `/markets` — é
   * daqui que `series_id`/`series_slug`/`series_recurrence` passam a sair.
   */
  series?: GammaSeries[] | null;
  /** Só em `/events`. Todos os markets do evento, idênticos aos de `/markets`. */
  markets?: GammaMarket[];
}

export interface ClobOrderbook {
  market: string;
  asset_id: string;
  bids: Array<{ price: string; size: string }>;
  asks: Array<{ price: string; size: string }>;
  hash: string;
}
