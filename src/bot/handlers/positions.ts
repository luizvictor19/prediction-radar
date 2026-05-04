import type { BotContext, BotConversation } from '../index.js';
import { supabase } from '../../lib/supabase.js';
import { logEvent } from '../../lib/logger.js';
import { relativeTime } from '../format.js';
import { positionKeyboard, basketKeyboard } from '../keyboards.js';

type LegRow = {
  id: string;
  bet_id: string;
  outcome: string;
  entry_price: number;
  stake_usd: number;
  shares: number | null;
  created_at: string;
  my_bets: { placed_at: string; polymarket_category: string | null } | null;
  events: { title: string } | null;
};

type BetGroup = {
  bet_id: string;
  placed_at: string;
  polymarket_category: string | null;
  legs: LegRow[];
};

export async function positionsHandler(ctx: BotContext): Promise<void> {
  try {
    const { data, error } = await supabase
      .from('my_bet_legs')
      .select(`
        id, bet_id, outcome, entry_price, stake_usd, shares, created_at,
        my_bets!inner ( placed_at, polymarket_category ),
        events ( title )
      `)
      .is('closed_at', null)
      .order('created_at', { ascending: true });

    if (error) {
      await logEvent({ component: 'telegram_bot', status: 'error', message: `positions query failed: ${error.message}` });
      await ctx.reply('Erro interno. Tenta de novo em alguns segundos.');
      return;
    }

    const legs = (data ?? []) as unknown as LegRow[];

    if (legs.length === 0) {
      await ctx.reply('Nenhuma posição aberta.');
      return;
    }

    // Group by bet_id preserving creation order within each group
    const groupMap = new Map<string, BetGroup>();
    for (const leg of legs) {
      if (!groupMap.has(leg.bet_id)) {
        const betMeta = leg.my_bets as { placed_at: string; polymarket_category: string | null } | null;
        groupMap.set(leg.bet_id, {
          bet_id: leg.bet_id,
          placed_at: betMeta?.placed_at ?? leg.created_at,
          polymarket_category: betMeta?.polymarket_category ?? null,
          legs: [],
        });
      }
      groupMap.get(leg.bet_id)!.legs.push(leg);
    }

    // Sort groups newest first
    const groups = [...groupMap.values()].sort(
      (a, b) => new Date(b.placed_at).getTime() - new Date(a.placed_at).getTime(),
    );

    for (const group of groups) {
      const { legs: groupLegs, bet_id, placed_at, polymarket_category } = group;

      if (groupLegs.length === 1) {
        const leg = groupLegs[0]!;
        const eventTitle =
          (leg.events as { title: string } | null)?.title ?? polymarket_category ?? 'Sem título';
        const sharesDisplay = (leg.shares ?? 0).toFixed(2);
        const text =
          `📅 ${eventTitle}\n` +
          `   ${leg.outcome} — $${leg.stake_usd.toFixed(2)} @ ${leg.entry_price} — ${sharesDisplay} shares\n` +
          `   Aberta há ${relativeTime(placed_at)}`;
        await ctx.reply(text, { reply_markup: positionKeyboard(bet_id) });
      } else {
        const firstTitle =
          (groupLegs[0]!.events as { title: string } | null)?.title ?? polymarket_category ?? 'Basket';
        const totalStake = groupLegs.reduce((s, l) => s + l.stake_usd, 0);
        let text = `🎯 ${firstTitle} (basket, ${groupLegs.length} legs)\n`;
        for (const leg of groupLegs) {
          const evtTitle = (leg.events as { title: string } | null)?.title ?? 'Sem título';
          const sharesDisplay = (leg.shares ?? 0).toFixed(2);
          text += `   • ${evtTitle}: $${leg.stake_usd.toFixed(2)} @ ${leg.entry_price} — ${sharesDisplay} shares\n`;
        }
        text += `   Stake total: $${totalStake.toFixed(2)} | Aberta há ${relativeTime(placed_at)}`;
        await ctx.reply(text, { reply_markup: basketKeyboard(bet_id) });
      }
    }

    // Summary by outcome
    const totalLegs = legs.length;
    const counts = new Map<string, number>();
    for (const leg of legs) {
      counts.set(leg.outcome, (counts.get(leg.outcome) ?? 0) + 1);
    }
    const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
    const lines = sorted.map(([outcome, n]) => `• ${outcome}: ${n}`).join('\n');
    await ctx.reply(`📊 Total: ${totalLegs} legs abertas\n${lines}`);
  } catch (err) {
    await logEvent({ component: 'telegram_bot', status: 'error', message: `positionsHandler error: ${String(err)}` });
    await ctx.reply('Erro interno. Tenta de novo em alguns segundos.');
  }
}

export async function closePositionConversation(
  conversation: BotConversation,
  ctx: BotContext,
  positionId: string,
): Promise<void> {
  try {
    const { data: pos, error: posErr } = await supabase
      .from('my_bets')
      .select('*')
      .eq('id', positionId)
      .single();

    if (posErr || !pos) {
      await ctx.reply('Posição não encontrada.');
      return;
    }

    // Step 1: closing price
    await ctx.reply('Preço de saída (closing_price)?');
    const priceCtx = await conversation.waitFor('message:text');
    const closingPrice = parseFloat(priceCtx.message.text.trim());
    if (isNaN(closingPrice) || closingPrice < 0 || closingPrice > 1) {
      await ctx.reply('Preço inválido. Operação cancelada.');
      return;
    }

    // Step 2: result
    await ctx.reply('Resultado: win / loss / void?');
    const resultCtx = await conversation.waitFor('message:text');
    const result = resultCtx.message.text.trim().toLowerCase();
    if (!['win', 'loss', 'void'].includes(result)) {
      await ctx.reply('Resultado inválido. Use win, loss ou void.');
      return;
    }

    const shares: number = pos.shares;
    const pnlUsd = (closingPrice - pos.entry_price) * shares;

    await supabase.from('my_bets').update({
      closing_price: closingPrice,
      result,
      pnl_usd: pnlUsd,
      closed_at: new Date().toISOString(),
    }).eq('id', positionId);

    const sign = pnlUsd >= 0 ? '+' : '';
    await ctx.reply(
      `✅ Posição fechada.\nResultado: \`${result}\` | PnL: \`${sign}$${pnlUsd.toFixed(2)}\``,
      { parse_mode: 'Markdown' },
    );
  } catch (err) {
    await logEvent({ component: 'telegram_bot', status: 'error', message: `closePositionConversation error: ${String(err)}` });
    await ctx.reply('Erro interno. Tenta de novo em alguns segundos.');
  }
}
