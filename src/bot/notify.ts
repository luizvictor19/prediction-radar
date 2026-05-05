import type { Bot } from 'grammy';
import type { BotContext } from './index.js';
import { supabase } from '../lib/supabase.js';
import { getSystemConfig } from '../lib/config.js';
import { logEvent } from '../lib/logger.js';
import { formatSignal, getStakeCap } from './format.js';
import { signalKeyboard, calendarDrivenKeyboard } from './keyboards.js';
import { sendLongMessage } from './message-utils.js';
import type { SignalRow } from './format.js';
import type { CrossMarketInterSignalMetadata } from '../types/index.js';

async function resolvePolymarketUrl(signal: SignalRow): Promise<string> {
  if (signal.signal_type === 'calendar_driven' && signal.event_id) {
    const { data } = await supabase
      .from('events')
      .select('event_group_slug, slug')
      .eq('id', signal.event_id)
      .limit(1)
      .maybeSingle();

    if (data?.event_group_slug) return `https://polymarket.com/event/${data.event_group_slug as string}`;
    if (data?.slug) return `https://polymarket.com/market/${data.slug as string}`;
    return 'https://polymarket.com';
  }

  const members = ((signal.metadata ?? {}) as Partial<CrossMarketInterSignalMetadata>).members ?? [];
  const firstId = members[0]?.polymarket_id;
  if (!firstId) return 'https://polymarket.com';

  const { data } = await supabase
    .from('events')
    .select('event_group_slug, slug')
    .eq('polymarket_id', firstId)
    .limit(1)
    .maybeSingle();

  if (data?.event_group_slug) return `https://polymarket.com/event/${data.event_group_slug as string}`;
  if (data?.slug) return `https://polymarket.com/market/${data.slug as string}`;
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
      .select('*, events(title, polymarket_id, outcomes, sports_market_type, line)')
      .eq('alerted', false)
      .eq('dismissed', false)
      .eq('acted_on', false)
      .or(`signal_type.eq.calendar_driven,metadata->>expected_edge_pct.gte.${config.notify_min_edge_pct}`)
      .order('created_at', { ascending: false });

    if (error) {
      await logEvent({ component: 'telegram_bot', status: 'error', message: `notify query failed: ${error.message}` });
      return;
    }

    const rawSignals = (data ?? []) as SignalRow[];

    // = detector freshness window
    const FRESH_WINDOW_MS = 15 * 60 * 1000;
    const notifyNow = Date.now();
    const signals = rawSignals.filter(s => {
      const lastSeen = (s.metadata as any)?.last_seen_at;
      if (!lastSeen) return false;
      return notifyNow - new Date(lastSeen).getTime() <= FRESH_WINDOW_MS;
    });

    // = calendar_driven extreme price threshold
    const PRICE_EXTREME_LOW = 0.05;
    const PRICE_EXTREME_HIGH = 0.95;

    const interSignals = signals.filter(s => s.signal_type === 'cross_market_inter');
    const allMemberIds = interSignals.flatMap(s => {
      const members = ((s.metadata ?? {}) as Partial<CrossMarketInterSignalMetadata>).members ?? [];
      return members.map(m => m.polymarket_id).filter((id): id is string => Boolean(id));
    });
    const endDateById = new Map<string, string>();
    if (allMemberIds.length > 0) {
      const { data: memberEvents } = await supabase
        .from('events')
        .select('polymarket_id, end_date')
        .in('polymarket_id', allMemberIds);
      for (const row of memberEvents ?? []) {
        if (row.end_date) endDateById.set(row.polymarket_id as string, row.end_date as string);
      }
    }
    const earliestEndMap = new Map<string, string | null>();
    for (const s of interSignals) {
      const members = ((s.metadata ?? {}) as Partial<CrossMarketInterSignalMetadata>).members ?? [];
      const sorted = members
        .map(m => endDateById.get(m.polymarket_id))
        .filter((d): d is string => Boolean(d))
        .sort();
      earliestEndMap.set(s.id, sorted[0] ?? null);
    }

    for (const signal of signals) {
      try {
        if (signal.signal_type === 'calendar_driven' && signal.event_id) {
          const { data: latest } = await supabase
            .from('polymarket_snapshots')
            .select('mid_price, captured_at')
            .eq('event_id', signal.event_id)
            .order('captured_at', { ascending: false })
            .limit(1)
            .single();

          if (latest && (latest.mid_price <= PRICE_EXTREME_LOW || latest.mid_price >= PRICE_EXTREME_HIGH)) {
            await supabase
              .from('detected_signals')
              .update({ dismissed: true })
              .eq('id', signal.id);

            await logEvent({
              component: 'telegram_bot',
              status: 'success',
              message: `Dismissed signal ${signal.id} pre-alert: yes_price ${latest.mid_price} is extreme`,
            });
            continue;
          }
        }

        const polymarketUrl = await resolvePolymarketUrl(signal);
        const stakeCap = getStakeCap(config, signal.signal_type);
        const earliestEnd = signal.signal_type === 'cross_market_inter'
          ? earliestEndMap.get(signal.id) ?? null
          : null;
        const text = '🔔 *Novo sinal:*\n\n' + formatSignal(signal, config.bankroll_usd, stakeCap, earliestEnd);
        const keyboard = signal.signal_type === 'calendar_driven'
          ? calendarDrivenKeyboard(signal.id, polymarketUrl, signal.events?.outcomes ?? null)
          : signalKeyboard(signal.id, polymarketUrl);
        await sendLongMessage(bot, chatId, text, {
          parseMode: 'Markdown',
          replyMarkup: keyboard,
        });
        const { error: alertErr } = await supabase
          .from('detected_signals')
          .update({ alerted: true })
          .eq('id', signal.id);

        if (alertErr) {
          await logEvent({
            component: 'telegram_bot',
            status: 'error',
            message: `Failed to mark signal ${signal.id} as alerted: ${alertErr.message}`,
          });
        }

        await logEvent({ component: 'bot_notify', status: 'success', message: `Sent signal ${signal.id}` });
      } catch (sendErr) {
        await logEvent({ component: 'telegram_bot', status: 'error', message: `notify send failed for signal ${signal.id}: ${String(sendErr)}` });
      }
    }
  } catch (err) {
    await logEvent({ component: 'telegram_bot', status: 'error', message: `runNotifyCheck error: ${String(err)}` });
  }
}
