import type { BotContext } from '../index.js';
import { supabase } from '../../lib/supabase.js';
import { getSystemConfig } from '../../lib/config.js';
import { getBankrollState } from '../../lib/bankroll.js';
import { logEvent } from '../../lib/logger.js';

export async function statusHandler(ctx: BotContext): Promise<void> {
  try {
    const config = await getSystemConfig();
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

    const [state, closedLegs, closedBetsMeta, lastDetector, activeRaw, recentAlerts] = await Promise.all([
      getBankrollState(),
      supabase
        .from('my_bet_legs')
        .select('result, pnl_usd')
        .not('closed_at', 'is', null)
        .gte('closed_at', sevenDaysAgo),
      supabase
        .from('my_bets')
        .select('id', { count: 'exact', head: true })
        .not('closed_at', 'is', null)
        .gte('closed_at', sevenDaysAgo),
      supabase
        .from('system_logs')
        .select('created_at')
        .eq('component', 'cross_market_inter_detector')
        .eq('status', 'success')
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle(),
      supabase
        .from('detected_signals')
        .select('signal_type', { count: 'exact', head: true })
        .eq('dismissed', false)
        .eq('acted_on', false)
        .gt('expires_at', new Date().toISOString())
        .or(`signal_type.eq.calendar_driven,metadata->>expected_edge_pct.gte.${config.min_expected_edge_pct}`),
      supabase
        .from('detected_signals')
        .select('id', { count: 'exact', head: true })
        .eq('alerted', true)
        .gte('created_at', new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()),
    ]);

    const activeSignals = activeRaw.count ?? 0;

    const closedLegRows = closedLegs.data ?? [];
    const wins = closedLegRows.filter((r: { result: string | null }) => r.result === 'win').length;
    const decisive = closedLegRows.filter(
      (r: { result: string | null }) => r.result === 'win' || r.result === 'loss',
    ).length;
    const winRate = decisive > 0 ? ((wins / decisive) * 100).toFixed(0) : '-';
    const pnlTotal = closedLegRows.reduce(
      (s: number, r: { pnl_usd: number | null }) => s + (r.pnl_usd ?? 0),
      0,
    );
    const pnlSign = pnlTotal >= 0 ? '+' : '';
    const closedBetCount = closedBetsMeta.count ?? 0;

    const lastRun = (() => {
      if (!lastDetector.data?.created_at) return 'nunca';
      const d = new Date(lastDetector.data.created_at);
      const hhU = String(d.getUTCHours()).padStart(2, '0');
      const minU = String(d.getUTCMinutes()).padStart(2, '0');
      const brt = new Date(d.getTime() - 3 * 60 * 60 * 1000);
      const hhB = String(brt.getUTCHours()).padStart(2, '0');
      const minB = String(brt.getUTCMinutes()).padStart(2, '0');
      return `${hhU}:${minU} UTC (${hhB}:${minB} BRT)`;
    })();

    const text =
      `*Status*\n` +
      `Bankroll: \`$${state.bankroll.toFixed(2)}\` (cash \`$${state.cash.toFixed(2)}\` + portfolio \`$${state.portfolio_value.toFixed(2)}\`)\n` +
      `Bets abertas: \`${state.legs_count}\` (stake \`$${state.stake_committed.toFixed(2)}\`, valor atual \`$${state.portfolio_value.toFixed(2)}\`)\n` +
      `Bets fechadas (7d): \`${closedBetCount}\` | Win rate \`${winRate}%\` | PnL \`${pnlSign}$${pnlTotal.toFixed(2)}\`\n` +
      `Último detector: \`${lastRun}\`\n` +
      `Sinais ativos: \`${activeSignals}\`\n` +
      `Alertas 24h: \`${recentAlerts.count ?? 0}\``;

    await ctx.reply(text, { parse_mode: 'Markdown' });
  } catch (err) {
    await logEvent({ component: 'telegram_bot', status: 'error', message: `statusHandler error: ${String(err)}` });
    await ctx.reply('Erro interno. Tenta de novo em alguns segundos.');
  }
}
