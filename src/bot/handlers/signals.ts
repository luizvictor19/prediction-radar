import type { BotContext } from '../index.js';
import { supabase } from '../../lib/supabase.js';
import { getSystemConfig } from '../../lib/config.js';
import { logEvent } from '../../lib/logger.js';
import { formatSignal } from '../format.js';
import { signalKeyboard } from '../keyboards.js';
import type { SignalRow } from '../format.js';
import type { CrossMarketInterSignalMetadata } from '../../types/index.js';

async function resolveSlugMap(signals: SignalRow[]): Promise<Map<string, string>> {
  const polymarketIds = signals
    .map((s) => {
      const members = ((s.metadata ?? {}) as Partial<CrossMarketInterSignalMetadata>).members ?? [];
      return members[0]?.polymarket_id ?? null;
    })
    .filter((id): id is string => id !== null);

  if (polymarketIds.length === 0) return new Map();

  const { data } = await supabase
    .from('events')
    .select('polymarket_id, slug')
    .in('polymarket_id', polymarketIds);

  const map = new Map<string, string>();
  for (const row of data ?? []) {
    if (row.slug) map.set(row.polymarket_id as string, row.slug as string);
  }
  return map;
}

function buildPolymarketUrl(signal: SignalRow, slugMap: Map<string, string>): string {
  const members = ((signal.metadata ?? {}) as Partial<CrossMarketInterSignalMetadata>).members ?? [];
  const firstId = members[0]?.polymarket_id;
  if (firstId) {
    const slug = slugMap.get(firstId);
    if (slug) return `https://polymarket.com/event/${slug}`;
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

    const slugMap = await resolveSlugMap(signals);

    for (const signal of signals) {
      const polymarketUrl = buildPolymarketUrl(signal, slugMap);
      const text = formatSignal(signal, config.bankroll_usd, config.max_stake_pct);
      await ctx.reply(text, {
        parse_mode: 'Markdown',
        reply_markup: signalKeyboard(signal.id, polymarketUrl),
      });
    }
  } catch (err) {
    await logEvent({ component: 'telegram_bot', status: 'error', message: `signalsHandler error: ${String(err)}` });
    await ctx.reply('Erro interno. Tenta de novo em alguns segundos.');
  }
}
