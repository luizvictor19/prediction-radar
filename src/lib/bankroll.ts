import { supabase } from './supabase.js';
import { getSystemConfig, invalidateConfigCache } from './config.js';

export interface BankrollState {
  cash: number;
  portfolio_value: number;
  bankroll: number;
  legs_count: number;
  stake_committed: number;
}

export async function getBankrollState(): Promise<BankrollState> {
  const config = await getSystemConfig();
  const cash = config.cash_usd ?? 0;

  const { data: openLegs } = await supabase
    .from('my_bet_legs')
    .select('event_id, outcome, shares, stake_usd')
    .is('closed_at', null);

  if (!openLegs || openLegs.length === 0) {
    return { cash, portfolio_value: 0, bankroll: cash, legs_count: 0, stake_committed: 0 };
  }

  let portfolio_value = 0;
  let stake_committed = 0;

  for (const leg of openLegs) {
    stake_committed += Number(leg.stake_usd) || 0;

    if (!leg.event_id) continue;

    const { data: snap } = await supabase
      .from('polymarket_snapshots')
      .select('mid_price')
      .eq('event_id', leg.event_id)
      .eq('outcome', leg.outcome)
      .order('captured_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    const midPrice = snap?.mid_price ? Number(snap.mid_price) : null;
    if (midPrice !== null) {
      portfolio_value += Number(leg.shares) * midPrice;
    } else {
      portfolio_value += Number(leg.stake_usd) || 0;
    }
  }

  return {
    cash,
    portfolio_value,
    bankroll: cash + portfolio_value,
    legs_count: openLegs.length,
    stake_committed,
  };
}

export async function adjustCash(delta: number): Promise<void> {
  if (delta === 0) return;
  const { data: cfg } = await supabase
    .from('system_config')
    .select('cash_usd')
    .eq('id', 1)
    .single();
  const current = Number(cfg?.cash_usd ?? 0);
  await supabase
    .from('system_config')
    .update({ cash_usd: current + delta, updated_at: new Date().toISOString() })
    .eq('id', 1);
  invalidateConfigCache();
}
