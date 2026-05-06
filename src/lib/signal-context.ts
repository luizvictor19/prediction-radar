import { supabase } from './supabase.js';
import { getBankrollState } from './bankroll.js';

export interface SignalContext {
  signal: Record<string, unknown>;
  event: Record<string, unknown> | null;
  recent_snapshots_24h: unknown[];
  recent_snapshots_7d_aggregated: unknown[];
  prior_signals_same_event: unknown[];
  current_bankroll: { cash: number; portfolio: number; total: number };
  open_positions_in_category: unknown[];
}

export async function buildSignalContext(signalId: string): Promise<SignalContext | null> {
  const { data: signal } = await supabase
    .from('detected_signals')
    .select('*, events(*)')
    .eq('id', signalId)
    .single();

  if (!signal) return null;

  const event = (signal as Record<string, unknown>)['events'] as Record<string, unknown> | null;
  const eventId = signal.event_id as string | null;

  const cutoff24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { data: snapshots24h } = eventId
    ? await supabase
        .from('polymarket_snapshots')
        .select('mid_price, best_bid, best_ask, volume_24h, captured_at, outcome')
        .eq('event_id', eventId)
        .gte('captured_at', cutoff24h)
        .order('captured_at', { ascending: true })
    : { data: [] };

  const { data: priorSignals } = eventId
    ? await supabase
        .from('detected_signals')
        .select('id, signal_type, confidence_score, created_at, dismissed, acted_on')
        .eq('event_id', eventId)
        .neq('id', signalId)
        .order('created_at', { ascending: false })
        .limit(20)
    : { data: [] };

  const bankrollState = await getBankrollState();

  const polymarketCategory = ((signal.metadata as Record<string, unknown>)?.['polymarket_category'] as string | null) ?? null;
  const { data: openPositions } = polymarketCategory
    ? await supabase
        .from('my_bets')
        .select('id, polymarket_category, thesis, placed_at, my_bet_legs(outcome, stake_usd, entry_price, shares)')
        .eq('polymarket_category', polymarketCategory)
        .is('closed_at', null)
        .limit(10)
    : { data: [] };

  return {
    signal: signal as Record<string, unknown>,
    event,
    recent_snapshots_24h: snapshots24h ?? [],
    recent_snapshots_7d_aggregated: [],
    prior_signals_same_event: priorSignals ?? [],
    current_bankroll: {
      cash: bankrollState.cash,
      portfolio: bankrollState.portfolio_value,
      total: bankrollState.bankroll,
    },
    open_positions_in_category: openPositions ?? [],
  };
}
