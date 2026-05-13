import type { BotContext } from '../index.js';
import { supabase } from '../../lib/supabase.js';
import { getSystemConfig } from '../../lib/config.js';
import { getBankrollState } from '../../lib/bankroll.js';
import { logEvent } from '../../lib/logger.js';

export async function statusHandler(ctx: BotContext): Promise<void> {
  try {
    const config = await getSystemConfig();
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

    const freshCutoff = new Date(
      Date.now() - config.dismiss_stale_cutoff_minutes * 60 * 1000,
    ).toISOString();

    const activeCountQuery = supabase
      .from('detected_signals')
      .select('signal_type', { count: 'exact', head: true })
      .eq('dismissed', false)
      .eq('acted_on', false)
      .gt('expires_at', new Date().toISOString())
      .gte('metadata->>last_seen_at', freshCutoff)
      .or(
        `signal_type.eq.calendar_driven,` +
        `signal_type.eq.hype_reality_gap,` +
        `signal_type.eq.early_market,` +
        `metadata->>expected_edge_pct.gte.${config.min_expected_edge_pct}`,
      );

    const [
      state,
      legs24h,
      legs7d,
      legs30dRows,
      legsAllTime,
      closedBets24hMeta,
      closedBetsMeta,
      closedBets30dMeta,
      closedBetsAllTimeMeta,
      lastDetector,
      activeRaw,
      recentAlerts,
    ] = await Promise.all([
      getBankrollState(),
      supabase
        .from('my_bet_legs')
        .select('result, pnl_usd')
        .not('closed_at', 'is', null)
        .gte('closed_at', oneDayAgo),
      supabase
        .from('my_bet_legs')
        .select('result, pnl_usd')
        .not('closed_at', 'is', null)
        .gte('closed_at', sevenDaysAgo),
      supabase
        .from('my_bet_legs')
        .select('result, pnl_usd')
        .not('closed_at', 'is', null)
        .gte('closed_at', thirtyDaysAgo),
      supabase
        .from('my_bet_legs')
        .select('result, pnl_usd')
        .not('closed_at', 'is', null),
      supabase
        .from('my_bets')
        .select('id', { count: 'exact', head: true })
        .not('closed_at', 'is', null)
        .gte('closed_at', oneDayAgo),
      supabase
        .from('my_bets')
        .select('id', { count: 'exact', head: true })
        .not('closed_at', 'is', null)
        .gte('closed_at', sevenDaysAgo),
      supabase
        .from('my_bets')
        .select('id', { count: 'exact', head: true })
        .not('closed_at', 'is', null)
        .gte('closed_at', thirtyDaysAgo),
      supabase
        .from('my_bets')
        .select('id', { count: 'exact', head: true })
        .not('closed_at', 'is', null),
      supabase
        .from('system_logs')
        .select('created_at')
        .eq('component', 'cross_market_inter_detector')
        .eq('status', 'success')
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle(),
      activeCountQuery,
      supabase
        .from('detected_signals')
        .select('id', { count: 'exact', head: true })
        .eq('alerted', true)
        .gte('created_at', oneDayAgo),
    ]);

    const activeSignals = activeRaw.count ?? 0;

    function calcMetrics(rows: Array<{ result: string | null; pnl_usd: number | null }>) {
      const wins = rows.filter(r => r.result === 'win').length;
      const decisive = rows.filter(r => r.result === 'win' || r.result === 'loss').length;
      const winRate = decisive > 0 ? ((wins / decisive) * 100).toFixed(0) : '-';
      const pnl = rows.reduce((s, r) => s + (Number(r.pnl_usd) || 0), 0);
      return { pnl, winRate };
    }

    const m24h = calcMetrics(legs24h.data ?? []);
    const m7d = calcMetrics(legs7d.data ?? []);
    const m30d = calcMetrics(legs30dRows.data ?? []);
    const mAll = calcMetrics(legsAllTime.data ?? []);

    const closedBets24h = closedBets24hMeta.count ?? 0;
    const closedBets7d = closedBetsMeta.count ?? 0;
    const closedBets30d = closedBets30dMeta.count ?? 0;
    const closedBetsAll = closedBetsAllTimeMeta.count ?? 0;

    function sign(n: number): string {
      return n >= 0 ? '+' : '';
    }

    const naoRealizado = state.portfolio_value - state.stake_committed;
    const totalCombinado = mAll.pnl + naoRealizado;

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
      `Bankroll: \`$${state.bankroll.toFixed(2)}\`\n` +
      `  Cash: \`$${state.cash.toFixed(2)}\`\n` +
      `  Posições abertas: \`$${state.portfolio_value.toFixed(2)}\` (stake \`$${state.stake_committed.toFixed(2)}\`)\n` +
      `\n` +
      `*Performance realizada*\n` +
      `  24h:      \`${sign(m24h.pnl)}$${m24h.pnl.toFixed(2)}\` | \`${closedBets24h}\` fechadas | \`${m24h.winRate}%\` wr\n` +
      `  7 dias:   \`${sign(m7d.pnl)}$${m7d.pnl.toFixed(2)}\` | \`${closedBets7d}\` fechadas | \`${m7d.winRate}%\` wr\n` +
      `  30 dias:  \`${sign(m30d.pnl)}$${m30d.pnl.toFixed(2)}\` | \`${closedBets30d}\` fechadas | \`${m30d.winRate}%\` wr\n` +
      `  All-time: \`${sign(mAll.pnl)}$${mAll.pnl.toFixed(2)}\` | \`${closedBetsAll}\` fechadas | \`${mAll.winRate}%\` wr\n` +
      `\n` +
      `Não-realizado atual: \`${sign(naoRealizado)}$${naoRealizado.toFixed(2)}\`\n` +
      `*Total (realizado + não-realizado): ${sign(totalCombinado)}$${totalCombinado.toFixed(2)}*\n` +
      `\n` +
      `Bets abertas: \`${state.legs_count}\` | Bets fechadas: \`${closedBetsAll}\`\n` +
      `Último detector: \`${lastRun}\`\n` +
      `Sinais ativos: \`${activeSignals}\`\n` +
      `Alertas 24h: \`${recentAlerts.count ?? 0}\``;

    await ctx.reply(text, { parse_mode: 'Markdown' });
  } catch (err) {
    await logEvent({ component: 'telegram_bot', status: 'error', message: `statusHandler error: ${String(err)}` });
    await ctx.reply('Erro interno. Tenta de novo em alguns segundos.');
  }
}
