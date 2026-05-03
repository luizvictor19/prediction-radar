import type { BotContext } from '../index.js';
import { supabase } from '../../lib/supabase.js';
import { getSystemConfig } from '../../lib/config.js';
import { logEvent } from '../../lib/logger.js';
import { formatSignal, getStakeCap } from '../format.js';
import { signalKeyboard, calendarDrivenKeyboard } from '../keyboards.js';
import type { SignalRow } from '../format.js';
import type { CrossMarketInterSignalMetadata } from '../../types/index.js';

async function resolveSlugMap(signals: SignalRow[]): Promise<Map<string, string>> {
  const polymarketIds = signals
    .filter((s) => s.signal_type !== 'calendar_driven')
    .map((s) => {
      const members = ((s.metadata ?? {}) as Partial<CrossMarketInterSignalMetadata>).members ?? [];
      return members[0]?.polymarket_id ?? null;
    })
    .filter((id): id is string => id !== null);

  if (polymarketIds.length === 0) return new Map();

  const { data } = await supabase
    .from('events')
    .select('polymarket_id, event_group_slug')
    .in('polymarket_id', polymarketIds);

  const map = new Map<string, string>();
  for (const row of data ?? []) {
    if (row.event_group_slug) map.set(row.polymarket_id as string, row.event_group_slug as string);
  }
  return map;
}

async function resolveCalendarDrivenUrl(eventId: string): Promise<string> {
  const { data } = await supabase
    .from('events')
    .select('event_group_slug, polymarket_id')
    .eq('id', eventId)
    .limit(1)
    .maybeSingle();

  if (data?.event_group_slug) return `https://polymarket.com/event/${data.event_group_slug as string}`;
  if (data?.polymarket_id) return `https://polymarket.com/market/${data.polymarket_id as string}`;
  return 'https://polymarket.com';
}

function buildPolymarketUrl(signal: SignalRow, slugMap: Map<string, string>): string {
  const members = ((signal.metadata ?? {}) as Partial<CrossMarketInterSignalMetadata>).members ?? [];
  const firstId = members[0]?.polymarket_id;
  if (firstId) {
    const eventGroupSlug = slugMap.get(firstId);
    if (eventGroupSlug) return `https://polymarket.com/event/${eventGroupSlug}`;
  }
  return 'https://polymarket.com';
}

export async function signalsHandler(ctx: BotContext): Promise<void> {
  try {
    const config = await getSystemConfig();

    const { data, error } = await supabase
      .from('detected_signals')
      .select('*, events(title, polymarket_id)')
      .eq('dismissed', false)
      .eq('acted_on', false)
      .or('expires_at.is.null,expires_at.gt.' + new Date().toISOString())
      .or(`signal_type.eq.calendar_driven,metadata->>expected_edge_pct.gte.${config.min_expected_edge_pct}`)
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

    const slugMap = await resolveSlugMap(signals);

    for (const signal of signals) {
      const polymarketUrl = signal.signal_type === 'calendar_driven' && signal.event_id
        ? await resolveCalendarDrivenUrl(signal.event_id)
        : buildPolymarketUrl(signal, slugMap);
      const stakeCap = getStakeCap(config, signal.signal_type);
      const text = formatSignal(signal, config.bankroll_usd, stakeCap);
      const keyboard = signal.signal_type === 'calendar_driven'
        ? calendarDrivenKeyboard(signal.id, polymarketUrl)
        : signalKeyboard(signal.id, polymarketUrl);
      await ctx.reply(text, {
        parse_mode: 'Markdown',
        reply_markup: keyboard,
      });
    }
  } catch (err) {
    await logEvent({ component: 'telegram_bot', status: 'error', message: `signalsHandler error: ${String(err)}` });
    await ctx.reply('Erro interno. Tenta de novo em alguns segundos.');
  }
}
