import type { SystemConfig } from '../types/index.js';
import { supabase } from './supabase.js';
import { logEvent } from './logger.js';

const CACHE_TTL_MS = 60 * 1000;

const DEFAULTS: SystemConfig = {
  id: 1,
  cash_usd: 0,
  max_stake_pct: 0.03,
  cross_market_max_stake_pct: 0.1,
  kelly_fraction: 0.25,
  min_confidence_alert: 0.75,
  drawdown_stop_pct: 0.2,
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
  // Espelha o default da migration 20260808002747, e é o único fallback deste
  // arquivo que existe para SILENCIAR e não para ligar: sem a coluna, os dois
  // prefixos que hoje são coletados de propósito já contam como declarados. O
  // contrário faria o aviso de prefixo sem vertical disparar a cada resweep
  // entre o deploy e o apply, por um estado que é decisão.
  collect_only_prefixes: ['lol-', 'dota2-'],
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
  // 20 min contra uma foto de 15: uma falta é atraso, duas são incidente. Vale
  // com o coletor desligado também — o caminho do desligamento bate.
  health_stale_radar_minutes: 20,
  health_alert_cooldown_minutes: 60,
  // Espelham os defaults da migration do resolver. O fallback LIGA — ao
  // contrário das flags de coletor, e pelo mesmo motivo do health_alerts: o
  // resolver não escreve nada enquanto as tabelas de entidade não existirem (ele
  // sonda antes), então nascer ligado não tem como surpreender. O que ele não
  // pode é ficar esperando o apply de uma migration de config para começar.
  esports_resolver_enabled: true,
  esports_resolver_batch_size: 1000,
  // Espelham os defaults da migration 20260806225235. Ligado no fallback pelo
  // mesmo motivo do resolver: `runEnrichers` sonda `context_fragments` antes de
  // chamar enricher nenhum, então o componente não escreve nada enquanto a
  // migration 20260806211531 não estiver aplicada — e não pode ficar esperando o
  // apply de uma migration de CONFIG para começar a existir.
  esports_enricher_enabled: true,
  esports_enricher_lookahead_minutes: 1440,
  esports_enricher_lookbehind_minutes: 360,
  esports_enricher_min_interval_minutes: 30,
  esports_enricher_batch_size: 50,
  // Espelha o default da migration do enricher da Liquipedia. DESLIGA no
  // fallback, ao contrário dos outros dois enrichers e pelo mesmo motivo do
  // analista: aqui a coluna faltando não pode significar "pode começar". A
  // fonte é externa, os termos exigem chave aprovada, User-Agent identificável
  // e no máximo 60 requisições/hora — e o acesso é negado a projeto de aposta,
  // o que é decisão a tomar antes de a primeira requisição sair, não depois.
  esports_enricher_liquipedia_enabled: false,
  // Espelham os defaults da migration do enricher da OddsPapi. DESLIGA no
  // fallback pelo mesmo motivo da Liquipedia e do analista: fonte externa, e o
  // tier gratuito é cortesia — 250 requisições/mês sem contador observável, com
  // acesso que pode ser cortado sem aviso. Um componente que se liga sozinho
  // porque a coluna ainda não existe queimaria orçamento de terceiro.
  esports_enricher_oddspapi_enabled: false,
  // bet365 fica DE FORA por medição, não por preferência: devolveu zero
  // movimento apesar de entitulada. São três vagas por chamada (teto da API), e
  // gastar uma delas com uma casa que mede zero é perder um terço da amostra.
  oddspapi_bookmakers: ['pinnacle', 'stake', 'ggbet'],
  // Moneyline na taxonomia deles. Medido: 7 mercados na Pinnacle, 4 na Stake, e
  // o 171 é o mais denso (688+689 entradas) — misturar todos compararia handicap
  // de mapa com o moneyline do Polymarket, sem sintoma.
  oddspapi_market_id: '171',
  // Espelham os defaults da migration 20260807033753. O fallback aqui DESLIGA,
  // ao contrário do resolver e do enricher, e pelo mesmo motivo que a migration
  // nasce com `false`: este é o único componente que gasta dinheiro por ciclo.
  // Um componente que se liga sozinho porque a coluna ainda não existe é
  // aceitável quando o custo do engano é CPU; aqui o custo é fatura.
  esports_analyst_enabled: false,
  analyst_model: 'claude-opus-5',
  analyst_prompt_version: 'v1',
  analyst_effort: 'medium',
  analyst_daily_budget_usd: 5.0,
  analyst_checkpoints_minutes: [360, 60],
  analyst_min_liquidity_usd: 5000,
  analyst_max_spread: 0.15,
  analyst_min_fragments: 3,
  analyst_timeout_ms: 90_000,
  // Espelham os defaults da migration do coletor do radar. O fallback DESLIGA,
  // como o do analista e pelo mesmo tipo de razão: aqui o custo do engano não é
  // CPU. A série do radar é isenta dos dois ramos da retenção (migration
  // 20260813210119) — cada mercado marcado vira armazenamento permanente, e um
  // componente que se liga sozinho porque a coluna ainda não existe começaria a
  // acumular linha que ninguém mais apaga.
  radar_collector_enabled: false,
  // O recorte de CATEGORIA — propriedade estável, e por isso é dos poucos
  // filtros que sobraram na coleta. Nomes de categoria em português porque é
  // como o relatório os imprime e como a coluna `radar_tema` os grava; as tags
  // são o vocabulário da Gamma, e é ele que a API entende.
  radar_temas: {
    'ia-e-tecnologia': ['ai', 'tech'],
    'brasil': ['brazil'],
    'macro-e-mercados': ['economy', 'finance', 'business', 'crypto'],
    'geopolitica-e-conflitos': ['geopolitics', 'world'],
    // As duas que entraram na revisão. `elections`+`politics` porque eleição que
    // o dono não acompanha ainda é série que não se recupera depois; `sports`
    // pelo esporte de TEMPORADA (título, artilheiro, rebaixamento).
    'eleicoes-e-politica': ['elections', 'politics'],
    'esporte-de-temporada': ['sports'],
  },
  radar_horizon_max_days: 180,
  radar_min_liquidity: 500,
  radar_max_por_categoria: 100,
  radar_roster_max: 800,
  radar_snapshot_interval_minutes: 15,
  radar_roster_interval_minutes: 360,
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

  const { data, error } = await supabase.from('system_config').select('*').eq('id', 1).single();

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
