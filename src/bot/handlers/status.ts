import type { BotContext } from '../index.js';
import { supabase } from '../../lib/supabase.js';
import { getSystemConfig } from '../../lib/config.js';
import { logEvent } from '../../lib/logger.js';

export async function statusHandler(ctx: BotContext): Promise<void> {
  try {
    const config = await getSystemConfig();

    const [openBets, closedBets, lastDetector, activeRaw, recentAlerts] = await Promise.all([
      supabase.from('my_bets').select('stake_usd').is('closed_at', null),
      supabase
        .from('my_bets')
        .select('pnl_usd, result')
        .not('closed_at', 'is', null)
        .gte('closed_at', new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()),
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
        .select('signal_type, metadata')
        .eq('dismissed', false)
        .eq('acted_on', false)
        .or(`signal_type.eq.calendar_driven,metadata->>expected_edge_pct.gte.${config.min_expected_edge_pct}`),
      supabase
        .from('detected_signals')
        .select('id', { count: 'exact', head: true })
        .eq('alerted', true)
        .eq('dismissed', false)
        .gte('created_at', new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()),
    ]);

    // = detector freshness window
    const FRESH_WINDOW_MS = 15 * 60 * 1000;
    const now = Date.now();
    const activeSignals = (activeRaw.data ?? []).filter(s => {
      if (s.signal_type === 'calendar_driven') return true;
      const lastSeen = (s.metadata as any)?.last_seen_at;
      if (!lastSeen) return false;
      return now - new Date(lastSeen).getTime() <= FRESH_WINDOW_MS;
    }).length;

    const openRows = openBets.data ?? [];
    const openCount = openRows.length;
    const openStake = openRows.reduce((s: number, r: { stake_usd: number }) => s + r.stake_usd, 0);

    const closedRows = closedBets.data ?? [];
    const wins = closedRows.filter((r: { result: string | null }) => r.result === 'win').length;
    const winRate = closedRows.length > 0 ? ((wins / closedRows.length) * 100).toFixed(0) : '-';
    const pnlTotal = closedRows.reduce((s: number, r: { pnl_usd: number | null }) => s + (r.pnl_usd ?? 0), 0);
    const pnlSign = pnlTotal >= 0 ? '+' : '';

    const lastRun = lastDetector.data?.created_at
      ? new Date(lastDetector.data.created_at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' }) + ' UTC'
      : 'nunca';

    const text =
      `*Status*\n` +
      `Bankroll: \`$${config.bankroll_usd.toFixed(2)}\`\n` +
      `Bets abertas: \`${openCount}\` (stake total \`$${openStake.toFixed(2)}\`)\n` +
      `Bets fechadas (7d): \`${closedRows.length}\` | Win rate \`${winRate}%\` | PnL \`${pnlSign}$${pnlTotal.toFixed(2)}\`\n` +
      `Último detector: \`${lastRun}\`\n` +
      `Sinais ativos: \`${activeSignals}\`\n` +
      `Alertas 24h: \`${recentAlerts.count ?? 0}\``;

    await ctx.reply(text, { parse_mode: 'Markdown' });
  } catch (err) {
    await logEvent({ component: 'telegram_bot', status: 'error', message: `statusHandler error: ${String(err)}` });
    await ctx.reply('Erro interno. Tenta de novo em alguns segundos.');
  }
}
