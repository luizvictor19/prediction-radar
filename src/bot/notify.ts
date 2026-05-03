import type { Bot } from 'grammy';
import type { BotContext } from './index.js';
import { supabase } from '../lib/supabase.js';
import { getSystemConfig } from '../lib/config.js';
import { logEvent } from '../lib/logger.js';
import { formatSignal, getStakeCap } from './format.js';
import { signalKeyboard, calendarDrivenKeyboard } from './keyboards.js';
import type { SignalRow } from './format.js';
import type { CrossMarketInterSignalMetadata } from '../types/index.js';

async function resolvePolymarketUrl(signal: SignalRow): Promise<string> {
  if (signal.signal_type === 'calendar_driven' && signal.event_id) {
    const { data } = await supabase
      .from('events')
      .select('event_group_slug, polymarket_id')
      .eq('id', signal.event_id)
      .limit(1)
      .maybeSingle();

    if (data?.event_group_slug) return `https://polymarket.com/event/${data.event_group_slug as string}`;
    if (data?.polymarket_id) return `https://polymarket.com/market/${data.polymarket_id as string}`;
    return 'https://polymarket.com';
  }

  const members = ((signal.metadata ?? {}) as Partial<CrossMarketInterSignalMetadata>).members ?? [];
  const firstId = members[0]?.polymarket_id;
  if (!firstId) return 'https://polymarket.com';

  const { data } = await supabase
    .from('events')
    .select('event_group_slug')
    .eq('polymarket_id', firstId)
    .limit(1)
    .maybeSingle();

  if (data?.event_group_slug) return `https://polymarket.com/event/${data.event_group_slug as string}`;
  return 'https://polymarket.com';
}

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
      .select('*, events(title, polymarket_id, outcomes)')
      .eq('alerted', false)
      .eq('dismissed', false)
      .eq('acted_on', false)
      .or('expires_at.is.null,expires_at.gt.' + new Date().toISOString())
      .or(`signal_type.eq.calendar_driven,metadata->>expected_edge_pct.gte.${config.notify_min_edge_pct}`)
      .order('created_at', { ascending: false });

    if (error) {
      await logEvent({ component: 'telegram_bot', status: 'error', message: `notify query failed: ${error.message}` });
      return;
    }

    const signals = (data ?? []) as SignalRow[];

    for (const signal of signals) {
      try {
        const polymarketUrl = await resolvePolymarketUrl(signal);
        const stakeCap = getStakeCap(config, signal.signal_type);
        const text = '🔔 *Novo sinal:*\n\n' + formatSignal(signal, config.bankroll_usd, stakeCap);
        const keyboard = signal.signal_type === 'calendar_driven'
          ? calendarDrivenKeyboard(signal.id, polymarketUrl, signal.events?.outcomes ?? null)
          : signalKeyboard(signal.id, polymarketUrl);
        await bot.api.sendMessage(chatId, text, {
          parse_mode: 'Markdown',
          reply_markup: keyboard,
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
