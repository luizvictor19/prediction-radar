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
  ops_telegram_chat_id: null,
  daily_report_hour: 9,
  cross_market_log_threshold: 0.03,
  cross_market_high_confidence_threshold: 0.08,
  cross_market_dedup_window_minutes: 60,
  inter_market_min_members: 3,
  inter_market_min_total_volume_24h: 10000,
  snapshot_retention_days: 1,
  // Espelha o default da migration 20260806032316 (item 8): um calendário
  // completo de esports. Vale enquanto a coluna não existir — o job de partição
  // não pode cair no `undefined` e dropar com a retenção errada.
  esports_snapshot_retention_days: 365,
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
  generic_detectors_enabled: false,
  // Fallback dos prefixos da descoberta: a coluna só existe depois da migration
  // 20260804163956_discovery_config. Sem isso o coletor não sobe antes dela.
  discovery_slug_prefixes: ['cs2-', 'lol-', 'dota2-'],
  discovery_lookback_minutes: 20,
  // Espelham os defaults da migration 20260806015533. Valem enquanto as colunas
  // não existirem — sem eles o coletor cairia em NaN e não refrescaria nada.
  watchlist_interval_live_seconds: 12,
  watchlist_interval_soon_seconds: 60,
  watchlist_interval_far_seconds: 300,
  watchlist_derived_interval_multiplier: 5,
  watchlist_soon_window_minutes: 360,
  watchlist_live_max_minutes: 360,
  watchlist_primary_market_types: ['moneyline'],
  // Espelham os defaults da migration do alerta de saúde. Valem enquanto as
  // colunas não existirem — e o fallback aqui LIGA a vigilância, ao contrário
  // das flags de coletor. Um monitor que nasce desligado por falta de coluna
  // reproduziria exatamente o problema que ele existe para resolver: silêncio
  // que parece saúde. Os limiares são folgados o bastante para não gerar falso
  // positivo enquanto isso.
  health_alerts_enabled: true,
  health_stale_discovery_minutes: 15,
  health_stale_watchlist_minutes: 10,
  health_stale_resolved_detector_minutes: 20,
  health_stale_open_legs_minutes: 10,
  health_alert_cooldown_minutes: 60,
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
