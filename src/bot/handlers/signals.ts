import type { BotContext } from '../index.js';
import { supabase } from '../../lib/supabase.js';
import { getSystemConfig } from '../../lib/config.js';
import { logEvent } from '../../lib/logger.js';
import { formatSignal } from '../format.js';
import { signalKeyboard } from '../keyboards.js';
import type { SignalRow } from '../format.js';

export async function signalsHandler(ctx: BotContext): Promise<void> {
  try {
    const config = await getSystemConfig();

    const { data, error } = await supabase
      .from('detected_signals')
      .select('*, events(title, polymarket_id)')
      .eq('dismissed', false)
      .eq('acted_on', false)
      .or('expires_at.is.null,expires_at.gt.' + new Date().toISOString())
      .gte('metadata->>expected_edge_pct', config.min_expected_edge_pct)
      .order('metadata->>expected_edge_pct', { ascending: false })
      .limit(10);

    if (error) {
      await logEvent({ component: 'telegram_bot', status: 'error', message: `signals query failed: ${error.message}` });
      await ctx.reply('Erro interno. Tenta de novo em alguns segundos.');
      return;
    }

    const signals = (data ?? []) as SignalRow[];

    if (signals.length === 0) {
      await ctx.reply('Nenhum sinal ativo agora.');
      return;
    }

    for (let i = 0; i < signals.length; i++) {
      const signal = signals[i]!;
      const text = formatSignal(i + 1, signal, config.bankroll_usd, config.max_stake_pct);
      await ctx.reply(text, {
        parse_mode: 'Markdown',
        reply_markup: signalKeyboard(signal),
      });
    }
  } catch (err) {
    await logEvent({ component: 'telegram_bot', status: 'error', message: `signalsHandler error: ${String(err)}` });
    await ctx.reply('Erro interno. Tenta de novo em alguns segundos.');
  }
}
