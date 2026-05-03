import type { SystemConfig } from '../types/index.js';
import { supabase } from './supabase.js';
import { logEvent } from './logger.js';

const CACHE_TTL_MS = 60 * 1000;

const DEFAULTS: SystemConfig = {
  id: 1,
  bankroll_usd: 500,
  max_stake_pct: 0.03,
  kelly_fraction: 0.25,
  min_confidence_alert: 0.70,
  drawdown_stop_pct: 0.20,
  telegram_chat_id: null,
  daily_report_hour: 9,
  cross_market_log_threshold: 0.03,
  cross_market_high_confidence_threshold: 0.08,
  cross_market_dedup_window_minutes: 30,
  inter_market_min_members: 3,
  inter_market_min_total_volume_24h: 10000,
  snapshot_retention_days: 7,
  system_logs_retention_days: 30,
  min_expected_edge_pct: 1.5,
  log_expected_edge_pct: 0.5,
  excluded_categories: [],
  collector_min_volume_24h: 10000,
  collector_min_liquidity: 20000,
  updated_at: new Date().toISOString(),
};

let cachedConfig: SystemConfig | null = null;
let cacheExpiresAt = 0;

export async function getSystemConfig(): Promise<SystemConfig> {
  const now = Date.now();
  if (cachedConfig !== null && now < cacheExpiresAt) {
    return cachedConfig;
  }

  const { data, error } = await supabase
    .from('system_config')
    .select('*')
    .eq('id', 1)
    .single();

  if (error || !data) {
    await logEvent({
      component: 'config',
      status: 'error',
      message: `Failed to load system_config, using defaults: ${error?.message ?? 'no data'}`,
      metadata: { error: error?.message },
    });
    return DEFAULTS;
  }

  cachedConfig = data as SystemConfig;
  cacheExpiresAt = now + CACHE_TTL_MS;
  return cachedConfig;
}

export function invalidateConfigCache(): void {
  cachedConfig = null;
  cacheExpiresAt = 0;
}
