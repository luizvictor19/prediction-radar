import type { Bot } from 'grammy';
import type { BotContext } from './index.js';
import { supabase } from '../lib/supabase.js';
import { getSystemConfig } from '../lib/config.js';
import { logEvent } from '../lib/logger.js';
import { formatSignal } from './format.js';
import { signalKeyboard } from './keyboards.js';
import type { SignalRow } from './format.js';

export function startNotifyLoop(bot: Bot<BotContext>): void {
  setInterval(() => {
    void runNotifyCheck(bot);
  }, 60 * 1000);
}

async function runNotifyCheck(bot: Bot<BotContext>): Promise<void> {
  try {
    const config = await getSystemConfig();
    const chatId = config.telegram_chat_id;
    if (!chatId) return;

    const { data, error } = await supabase
      .from('detected_signals')
      .select('*, events(title, polymarket_id)')
      .eq('alerted', false)
      .eq('dismissed', false)
      .eq('acted_on', false)
      .or('expires_at.is.null,expires_at.gt.' + new Date().toISOString())
      .gte('metadata->>expected_edge_pct', config.notify_min_edge_pct)
      .order('created_at', { ascending: false });

    if (error) {
      await logEvent({ component: 'telegram_bot', status: 'error', message: `notify query failed: ${error.message}` });
      return;
    }

    const signals = (data ?? []) as SignalRow[];

    for (const signal of signals) {
      try {
        const text = '🔔 *Novo sinal:* \n' + formatSignal(1, signal, config.bankroll_usd, config.max_stake_pct);
        await bot.api.sendMessage(chatId, text, {
          parse_mode: 'Markdown',
          reply_markup: signalKeyboard(signal),
        });
        await supabase.from('detected_signals').update({ alerted: true }).eq('id', signal.id);
      } catch (sendErr) {
        await logEvent({ component: 'telegram_bot', status: 'error', message: `notify send failed for signal ${signal.id}: ${String(sendErr)}` });
      }
    }
  } catch (err) {
    await logEvent({ component: 'telegram_bot', status: 'error', message: `runNotifyCheck error: ${String(err)}` });
  }
}
