import type { Bot } from 'grammy';
import type { BotContext } from './index.js';
import { supabase } from '../lib/supabase.js';
import { getSystemConfig } from '../lib/config.js';
import { getBankrollState } from '../lib/bankroll.js';
import { logEvent } from '../lib/logger.js';
import { formatSignal, getStakeCap } from './format.js';
import { signalKeyboard, calendarDrivenKeyboard, hypeRealityGapKeyboard, crossMarketInterKeyboard } from './keyboards.js';
import { sendLongMessage } from './message-utils.js';
import type { SignalRow } from './format.js';
import type { CrossMarketInterSignalMetadata } from '../types/index.js';
import { fetchActiveSignals, fetchOpenLegEventIds } from './lib/signal-queries.js';

async function resolvePolymarketUrl(signal: SignalRow): Promise<string> {
  if ((signal.signal_type === 'calendar_driven' || signal.signal_type === 'hype_reality_gap' || signal.signal_type === 'early_market') && signal.event_id) {
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
    const [config, bankrollState] = await Promise.all([getSystemConfig(), getBankrollState()]);
    const bankroll = bankrollState.bankroll;
    const chatId = config.telegram_chat_id;
    if (!chatId) return;

    let signals: SignalRow[];
    try {
      const eventIdsWithOpenLegs = await fetchOpenLegEventIds(supabase);
      signals = await fetchActiveSignals(supabase, {
        minEdgePct: config.notify_min_edge_pct,
        excludeAlerted: true,
        openLegEventIds: eventIdsWithOpenLegs,
      });
    } catch (err) {
      await logEvent({ component: 'telegram_bot', status: 'error', message: `notify query failed: ${String(err)}` });
      return;
    }

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
        const text = '🔔 *Novo sinal:*\n\n' + formatSignal(signal, bankroll, stakeCap, earliestEnd);
        let keyboard;
        if (signal.signal_type === 'calendar_driven') {
          keyboard = calendarDrivenKeyboard(signal.id, polymarketUrl, signal.events?.outcomes ?? null);
        } else if (signal.signal_type === 'hype_reality_gap') {
          keyboard = hypeRealityGapKeyboard(signal.id, polymarketUrl, signal.events?.outcomes ?? {});
        } else if (signal.signal_type === 'early_market') {
          keyboard = hypeRealityGapKeyboard(signal.id, polymarketUrl, signal.events?.outcomes ?? {});
        } else if (signal.signal_type === 'cross_market_inter') {
          keyboard = crossMarketInterKeyboard(signal.id, polymarketUrl);
        } else {
          keyboard = signalKeyboard(signal.id, polymarketUrl);
        }
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
