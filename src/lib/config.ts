import type { SystemConfig } from '../types/index.js';
import { supabase } from './supabase.js';
import { logEvent } from './logger.js';

const CACHE_TTL_MS = 60 * 1000;

const DEFAULTS: SystemConfig = {
  id: 1,
  cash_usd: 0,
  max_stake_pct: 0.03,
  cross_market_max_stake_pct: 0.10,
  kelly_fraction: 0.25,
  min_confidence_alert: 0.75,
  drawdown_stop_pct: 0.20,
  telegram_chat_id: null,
  daily_report_hour: 9,
  cross_market_log_threshold: 0.03,
  cross_market_high_confidence_threshold: 0.08,
  cross_market_dedup_window_minutes: 60,
  inter_market_min_members: 3,
  inter_market_min_total_volume_24h: 10000,
  snapshot_retention_days: 1,
  // Espelha o default da migration 20260805_esports_snapshots. Vale enquanto a
  // coluna não existir: o job de partição não pode cair no `undefined` e dropar
  // com a retenção errada.
  esports_snapshot_retention_days: 3650,
  system_logs_retention_days: 30,
  min_expected_edge_pct: 1.5,
  notify_min_edge_pct: 2.5,
  log_expected_edge_pct: 0.5,
  excluded_categories: [],
  collector_min_volume_24h: 10000,
  collector_min_liquidity: 20000,
  // Spec 000, item 4. `false` no fallback é deliberado nos dois sentidos: vale
  // enquanto a coluna não existir (o desligamento não fica esperando o apply) e
  // vale quando a leitura da config falha — numa queda do banco o sistema volta
  // ao estado pretendido, não ao anterior.
  volume_scan_enabled: false,
  early_markets_enabled: false,
  // Fallback dos prefixos da descoberta: a coluna só existe depois da migration
  // 20260804163956_discovery_config. Sem isso o coletor não sobe antes dela.
  discovery_slug_prefixes: ['cs2-', 'lol-', 'dota2-'],
  discovery_lookback_minutes: 20,
  signal_ttl_minutes: 30,
  signal_cooldown_minutes: 60,
  stale_cleanup_threshold_hours: 1,
  dismiss_stale_cutoff_minutes: 15,
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

  cachedConfig = { ...DEFAULTS, ...data } as SystemConfig;
  cacheExpiresAt = now + CACHE_TTL_MS;
  return cachedConfig;
}

export function invalidateConfigCache(): void {
  cachedConfig = null;
  cacheExpiresAt = 0;
}
