import type { SupabaseClient } from '@supabase/supabase-js';
import type { SignalRow } from '../format.js';

export interface FetchActiveSignalsOptions {
  /**
   * Edge mínimo (em %) para signal_types que NÃO são isentos.
   * Tipos isentos passam sem checar edge (ex: calendar_driven).
   */
  minEdgePct: number;

  /**
   * Se true, exclui sinais com alerted=true (comportamento do notify loop).
   * Se false, inclui todos (comportamento do /signals).
   */
  excludeAlerted: boolean;

  /**
   * Lista de event_ids onde o usuário tem leg aberta.
   * Sinais cujo event_id está nessa lista são ocultados.
   * Sinais com event_id=null mas com metadata.members[] que contém algum
   * desses event_ids também são ocultados (caso cross_market_inter 'over').
   */
  openLegEventIds: string[];

  /**
   * Janela de freshness em minutos. Sinais cujo metadata.last_seen_at
   * é mais antigo que isso são filtrados.
   * Default: 15.
   */
  freshWindowMinutes?: number;

  /**
   * Tipos isentos do filtro de edge.
   * Default: ['calendar_driven', 'hype_reality_gap', 'early_market']
   */
  edgeExemptTypes?: string[];
}

const DEFAULT_FRESH_WINDOW_MINUTES = 15;
const DEFAULT_EDGE_EXEMPT_TYPES = [
  'calendar_driven',
  'hype_reality_gap',
  'early_market',
];

/**
 * Select padronizado de events para sinais.
 * IMPORTANTE: end_date é obrigatório aqui — múltiplos formatters
 * (formatHypeRealityGapSignal, formatEarlyMarketSignal) usam essa
 * coluna para mostrar "Resolve em ...". Não remover.
 */
const SIGNAL_EVENTS_SELECT =
  '*, events(title, polymarket_id, outcomes, sports_market_type, line, end_date)';

/**
 * Busca sinais ativos do banco aplicando filtros consistentes.
 *
 * Filtros aplicados (em ordem):
 * 1. Query no banco: dismissed=false, acted_on=false, [opcional alerted=false]
 * 2. Em memória: edge mínimo (com isenção por tipo)
 * 3. Em memória: freshness (last_seen_at >= now - freshWindowMinutes)
 * 4. Em memória: ocultar events com leg aberta (com tratamento de null + members)
 *
 * Retorna sinais já filtrados, prontos pra renderização. Ordenação NÃO é
 * garantida — caller deve ordenar conforme sua necessidade.
 */
export async function fetchActiveSignals(
  supabase: SupabaseClient,
  options: FetchActiveSignalsOptions,
): Promise<SignalRow[]> {
  const freshWindowMinutes = options.freshWindowMinutes ?? DEFAULT_FRESH_WINDOW_MINUTES;
  const edgeExemptTypes = options.edgeExemptTypes ?? DEFAULT_EDGE_EXEMPT_TYPES;
  const openLegEventIdSet = new Set(options.openLegEventIds);

  // 1. Query base no banco
  let query = supabase
    .from('detected_signals')
    .select(SIGNAL_EVENTS_SELECT)
    .eq('dismissed', false)
    .eq('acted_on', false)
    .order('created_at', { ascending: false });

  if (options.excludeAlerted) {
    query = query.eq('alerted', false);
  }

  const { data, error } = await query;

  if (error) {
    throw new Error(`fetchActiveSignals query failed: ${error.message}`);
  }

  const rawSignals = (data ?? []) as SignalRow[];

  // 2. Filtro de edge: tipo isento OU edge >= threshold
  const edgeFiltered = rawSignals.filter((s) => {
    if (edgeExemptTypes.includes(s.signal_type)) return true;
    const raw = (s.metadata as Record<string, unknown> | null)?.['expected_edge_pct'];
    const edge = typeof raw === 'number' ? raw : parseFloat(String(raw ?? ''));
    return !isNaN(edge) && edge >= options.minEdgePct;
  });

  // 3. Filtro de freshness
  const FRESH_WINDOW_MS = freshWindowMinutes * 60 * 1000;
  const now = Date.now();
  const freshFiltered = edgeFiltered.filter((s) => {
    const lastSeen = (s.metadata as Record<string, unknown> | null)?.['last_seen_at'];
    if (typeof lastSeen !== 'string') return false;
    return now - new Date(lastSeen).getTime() <= FRESH_WINDOW_MS;
  });

  // 4. Filtro de leg aberta (com tratamento de null + members)
  const notInOpenLeg = freshFiltered.filter((s) => {
    if (s.event_id !== null) {
      return !openLegEventIdSet.has(s.event_id);
    }
    const members = (s.metadata as Record<string, unknown> | null)?.['members'] as
      | Array<{ event_id?: string }>
      | undefined;
    if (Array.isArray(members) && members.length > 0) {
      return !members.some((m) => m.event_id && openLegEventIdSet.has(m.event_id));
    }
    return true;
  });

  return notInOpenLeg;
}

/**
 * Busca os event_ids onde o usuário tem leg aberta.
 * Helper conveniente para preencher openLegEventIds em FetchActiveSignalsOptions.
 */
export async function fetchOpenLegEventIds(
  supabase: SupabaseClient,
): Promise<string[]> {
  const { data, error } = await supabase
    .from('my_bet_legs')
    .select('event_id')
    .is('closed_at', null);

  if (error) {
    throw new Error(`fetchOpenLegEventIds query failed: ${error.message}`);
  }

  return (data ?? [])
    .map((l) => l.event_id as string | null)
    .filter((id): id is string => Boolean(id));
}
