import type { BotContext, BotConversation } from '../index.js';
import { supabase } from '../../lib/supabase.js';
import { getSystemConfig } from '../../lib/config.js';
import { logEvent } from '../../lib/logger.js';

export async function cashConversation(
  conversation: BotConversation,
  ctx: BotContext,
): Promise<void> {
  try {
    const config = await getSystemConfig();
    const currentCash = config.cash_usd;

    await ctx.reply(
      `*Cash atual:* \`$${currentCash.toFixed(2)}\`\n\n` +
      `Digite o novo valor (em USD) para atualizar:\n` +
      `Ex: \`117.42\`\n\n` +
      `Ou digite \`cancel\` para cancelar.`,
      { parse_mode: 'Markdown' },
    );

    const valueCtx = await conversation.waitFor('message:text');
    const valueRaw = valueCtx.message.text.trim().toLowerCase();

    if (valueRaw === 'cancel') {
      await ctx.reply('Operação cancelada.');
      return;
    }

    const newValue = parseFloat(valueRaw);
    if (isNaN(newValue) || newValue < 0) {
      await ctx.reply('Valor inválido. Operação cancelada.');
      return;
    }

    const delta = newValue - currentCash;
    const deltaStr = delta >= 0 ? `+$${delta.toFixed(2)}` : `-$${Math.abs(delta).toFixed(2)}`;

    const { error: updErr } = await supabase
      .from('system_config')
      .update({ cash_usd: newValue })
      .eq('id', 1);

    if (updErr) {
      await logEvent({
        component: 'telegram_bot',
        status: 'error',
        message: `cash update failed: ${updErr.message}`,
      });
      await ctx.reply('Erro ao atualizar cash. Tenta de novo.');
      return;
    }

    await logEvent({
      component: 'cash_adjustment',
      status: 'success',
      message: `User adjusted cash: $${currentCash.toFixed(2)} → $${newValue.toFixed(2)} (${deltaStr})`,
      metadata: {
        previous_cash: currentCash,
        new_cash: newValue,
        delta,
        triggered_by: 'cash_command',
      },
    });

    await ctx.reply(
      `✅ Cash atualizado: \`$${currentCash.toFixed(2)}\` → \`$${newValue.toFixed(2)}\` (${deltaStr})`,
      { parse_mode: 'Markdown' },
    );
  } catch (err) {
    await logEvent({
      component: 'telegram_bot',
      status: 'error',
      message: `cashConversation error: ${String(err)}`,
    });
    await ctx.reply('Erro interno. Tenta de novo em alguns segundos.');
  }
}
