import type { BotContext } from '../index.js';
import { supabase } from '../../lib/supabase.js';
import { getSystemConfig } from '../../lib/config.js';
import { getBankrollState } from '../../lib/bankroll.js';
import { logEvent } from '../../lib/logger.js';
import { formatSignal, getStakeCap } from '../format.js';
import { signalKeyboard, calendarDrivenKeyboard, hypeRealityGapKeyboard, crossMarketInterKeyboard } from '../keyboards.js';
import { replyLongMessage } from '../message-utils.js';
import type { SignalRow } from '../format.js';
import type { CrossMarketInterSignalMetadata } from '../../types/index.js';

interface SlugEntry { event_group_slug?: string; slug?: string }

async function resolveSlugMap(signals: SignalRow[]): Promise<Map<string, SlugEntry>> {
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
    .select('polymarket_id, event_group_slug, slug')
    .in('polymarket_id', polymarketIds);

  const map = new Map<string, SlugEntry>();
  for (const row of data ?? []) {
    map.set(row.polymarket_id as string, {
      event_group_slug: row.event_group_slug as string | undefined,
      slug: row.slug as string | undefined,
    });
  }
  return map;
}

async function resolveEarliestEndMap(signals: SignalRow[]): Promise<Map<string, string | null>> {
  const interSignals = signals.filter(s => s.signal_type === 'cross_market_inter');
  if (interSignals.length === 0) return new Map();

  const allIds = interSignals.flatMap(s => {
    const members = ((s.metadata ?? {}) as Partial<CrossMarketInterSignalMetadata>).members ?? [];
    return members.map(m => m.polymarket_id).filter((id): id is string => Boolean(id));
  });
  if (allIds.length === 0) return new Map();

  const { data } = await supabase
    .from('events')
    .select('polymarket_id, end_date')
    .in('polymarket_id', allIds);

  const endDateById = new Map<string, string>();
  for (const row of data ?? []) {
    if (row.end_date) endDateById.set(row.polymarket_id as string, row.end_date as string);
  }

  const result = new Map<string, string | null>();
  for (const s of interSignals) {
    const members = ((s.metadata ?? {}) as Partial<CrossMarketInterSignalMetadata>).members ?? [];
    const sorted = members
      .map(m => endDateById.get(m.polymarket_id))
      .filter((d): d is string => Boolean(d))
      .sort();
    result.set(s.id, sorted[0] ?? null);
  }
  return result;
}

async function resolveCalendarDrivenUrl(eventId: string): Promise<string> {
  const { data } = await supabase
    .from('events')
    .select('event_group_slug, slug')
    .eq('id', eventId)
    .limit(1)
    .maybeSingle();

  if (data?.event_group_slug) return `https://polymarket.com/event/${data.event_group_slug as string}`;
  if (data?.slug) return `https://polymarket.com/market/${data.slug as string}`;
  return 'https://polymarket.com';
}

function buildPolymarketUrl(signal: SignalRow, slugMap: Map<string, SlugEntry>): string {
  const members = ((signal.metadata ?? {}) as Partial<CrossMarketInterSignalMetadata>).members ?? [];
  const firstId = members[0]?.polymarket_id;
  if (firstId) {
    const entry = slugMap.get(firstId);
    if (entry?.event_group_slug) return `https://polymarket.com/event/${entry.event_group_slug}`;
    if (entry?.slug) return `https://polymarket.com/market/${entry.slug}`;
  }
  return 'https://polymarket.com';
}

export async function signalsHandler(ctx: BotContext): Promise<void> {
  try {
    const filterRaw = (ctx.match as string | undefined ?? '').trim();
    const filter = filterRaw.length > 0 ? filterRaw.toLowerCase() : null;

    const config = await getSystemConfig();

    const { data: openLegEvents } = await supabase
      .from('my_bet_legs')
      .select('event_id')
      .is('closed_at', null);

    const eventIdsWithOpenLegs = (openLegEvents ?? [])
      .map(l => l.event_id as string | null)
      .filter(Boolean) as string[];

    const signalsQuery = supabase
      .from('detected_signals')
      .select('*, events(title, polymarket_id, outcomes, sports_market_type, line, end_date)')
      .eq('dismissed', false)
      .eq('acted_on', false);

    const { data, error } = await signalsQuery;

    if (error) {
      await logEvent({ component: 'telegram_bot', status: 'error', message: `signals query failed: ${error.message}` });
      await ctx.reply('Erro interno. Tenta de novo em alguns segundos.');
      return;
    }

    // Filtro: ocultar sinais cujo event_id está em legs abertas.
    // IMPORTANTE: sinais com event_id=null (ex: cross_market_inter) SEMPRE
    // passam — eles não pertencem a nenhum event específico.
    const openLegEventIdSet = new Set(eventIdsWithOpenLegs);
    const notInOpenLeg = (data ?? []).filter((s: SignalRow) => {
      if (s.event_id === null) return true;
      return !openLegEventIdSet.has(s.event_id);
    });

    const edgeFiltered = notInOpenLeg.filter((s: SignalRow) => {
      if (s.signal_type === 'calendar_driven') return true;
      if (s.signal_type === 'hype_reality_gap') return true;
      if (s.signal_type === 'early_market') return true;
      const raw = (s.metadata as any)?.expected_edge_pct;
      const edge = typeof raw === 'number' ? raw : parseFloat(raw ?? '');
      return !isNaN(edge) && edge >= config.min_expected_edge_pct;
    });

    // = detector freshness window
    const FRESH_WINDOW_MS = 15 * 60 * 1000;
    const now = Date.now();
    const signals = edgeFiltered.filter((s: SignalRow) => {
      const lastSeen = (s.metadata as any)?.last_seen_at;
      if (!lastSeen) return false;
      return now - new Date(lastSeen).getTime() <= FRESH_WINDOW_MS;
    });

    const filtered = filter
      ? signals.filter((s: SignalRow) => (s.events?.title ?? '').toLowerCase().includes(filter))
      : signals;

    if (filtered.length === 0) {
      if (filter) {
        await ctx.reply(`Nenhum sinal ativo com "${filterRaw}".\nTotal ativos: ${signals.length}. Tenta /signals sem filtro.`);
      } else {
        await ctx.reply('Nenhum sinal ativo agora.');
      }
      return;
    }

    function getEdge(s: SignalRow): number {
      const raw = (s.metadata as any)?.expected_edge_pct;
      const edge = typeof raw === 'number' ? raw : parseFloat(raw ?? '');
      return isNaN(edge) ? 0 : edge;
    }

    function getEndDate(s: SignalRow): number {
      const raw = (s.metadata as any)?.end_date ?? (s as any).expires_at;
      if (!raw) return Number.POSITIVE_INFINITY;
      const t = new Date(raw).getTime();
      return isNaN(t) ? Number.POSITIVE_INFINITY : t;
    }

    const sorted = [...filtered].sort((a, b) => {
      const aIsCalendar = a.signal_type === 'calendar_driven';
      const bIsCalendar = b.signal_type === 'calendar_driven';

      if (aIsCalendar !== bIsCalendar) return aIsCalendar ? -1 : 1;

      if (!aIsCalendar) return getEdge(a) - getEdge(b);

      const dateDiff = getEndDate(b) - getEndDate(a);
      if (dateDiff !== 0) return dateDiff;
      return getEdge(a) - getEdge(b);
    });

    const [slugMap, earliestEndMap, bankrollState] = await Promise.all([
      resolveSlugMap(sorted),
      resolveEarliestEndMap(sorted),
      getBankrollState(),
    ]);
    const bankroll = bankrollState.bankroll;

    const displayedSignals: SignalRow[] = [];
    for (const signal of sorted) {
      try {
        const usesEventId = (signal.signal_type === 'calendar_driven' || signal.signal_type === 'hype_reality_gap' || signal.signal_type === 'early_market') && signal.event_id;
        const polymarketUrl = usesEventId
          ? await resolveCalendarDrivenUrl(signal.event_id!)
          : buildPolymarketUrl(signal, slugMap);
        const stakeCap = getStakeCap(config, signal.signal_type);
        const earliestEnd = signal.signal_type === 'cross_market_inter'
          ? earliestEndMap.get(signal.id) ?? null
          : null;
        const text = formatSignal(signal, bankroll, stakeCap, earliestEnd);
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
        await replyLongMessage(ctx, text, {
          parseMode: 'Markdown',
          replyMarkup: keyboard,
        });
        displayedSignals.push(signal);
        await logEvent({
          component: 'bot_notify',
          status: 'success',
          message: `Sent signal ${signal.signal_type} ${signal.id}`,
          metadata: { signal_id: signal.id, signal_type: signal.signal_type },
        });
      } catch (err) {
        await logEvent({
          component: 'bot_error',
          status: 'error',
          message: `Failed to send signal ${signal.id}: ${String(err)}`,
          metadata: { signal_id: signal.id, error: String(err) },
        });
      }
    }

    if (displayedSignals.length > 0) {
      const counts = new Map<string, number>();
      for (const signal of displayedSignals) {
        counts.set(signal.signal_type, (counts.get(signal.signal_type) ?? 0) + 1);
      }
      const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
      const total = displayedSignals.length;
      const lines = sorted.map(([type, n]) => `• ${type}: ${n}`).join('\n');
      await ctx.reply(`📊 Total: ${total} sinais\n${lines}`);
    }
  } catch (err) {
    await logEvent({ component: 'telegram_bot', status: 'error', message: `signalsHandler error: ${String(err)}` });
    await ctx.reply('Erro interno. Tenta de novo em alguns segundos.');
  }
}
