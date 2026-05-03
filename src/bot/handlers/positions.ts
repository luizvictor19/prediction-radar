import type { BotContext, BotConversation } from '../index.js';
import { supabase } from '../../lib/supabase.js';
import { logEvent } from '../../lib/logger.js';
import { relativeTime } from '../format.js';
import type { PositionRow } from '../format.js';
import { positionKeyboard } from '../keyboards.js';

export async function positionsHandler(ctx: BotContext): Promise<void> {
  try {
    const { data, error } = await supabase
      .from('my_bets')
      .select('*, events(title)')
      .is('closed_at', null)
      .order('placed_at', { ascending: false });

    if (error) {
      await logEvent({ component: 'telegram_bot', status: 'error', message: `positions query failed: ${error.message}` });
      await ctx.reply('Erro interno. Tenta de novo em alguns segundos.');
      return;
    }

    const positions = (data ?? []) as PositionRow[];

    if (positions.length === 0) {
      await ctx.reply('Nenhuma posição aberta.');
      return;
    }

    for (let i = 0; i < positions.length; i++) {
      const pos = positions[i]!;
      const label = (pos.events as { title: string } | null)?.title ?? pos.polymarket_category ?? 'Sem título';
      const text =
        `*Posição #${i + 1}* — ${label}\n` +
        `\`${pos.outcome}\` a \`${pos.entry_price}\` | Stake \`$${pos.stake_usd.toFixed(2)}\` | Shares \`${pos.shares.toFixed(4)}\`\n` +
        `Aberta há ${relativeTime(pos.placed_at)}`;

      await ctx.reply(text, {
        parse_mode: 'Markdown',
        reply_markup: positionKeyboard(pos.id),
      });
    }
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
    const stakeUsd: number = pos.stake_usd;
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
