import type { BotContext } from '../index.js';
import { supabase } from '../../lib/supabase.js';
import { getSystemConfig, invalidateConfigCache } from '../../lib/config.js';
import { logEvent } from '../../lib/logger.js';

export async function bankrollHandler(ctx: BotContext): Promise<void> {
  try {
    const config = await getSystemConfig();
    const text = ctx.message?.text ?? '';
    const parts = text.trim().split(/\s+/);

    if (parts.length === 1) {
      await ctx.reply(`Bankroll atual: \`$${config.bankroll_usd.toFixed(2)}\``, { parse_mode: 'Markdown' });
      return;
    }

    const newValue = parseFloat(parts[1] ?? '');
    if (isNaN(newValue) || newValue < 1 || newValue > 100000) {
      await ctx.reply('Uso: /bankroll <valor> (entre $1 e $100000)');
      return;
    }

    const oldValue = config.bankroll_usd;

    const { error } = await supabase
      .from('system_config')
      .update({ bankroll_usd: newValue, updated_at: new Date().toISOString() })
      .eq('id', 1);

    if (error) {
      await logEvent({ component: 'telegram_bot', status: 'error', message: `bankroll update failed: ${error.message}` });
      await ctx.reply('Erro interno. Tenta de novo em alguns segundos.');
      return;
    }

    invalidateConfigCache();

    await logEvent({
      component: 'telegram_bot',
      status: 'success',
      message: 'Bankroll updated via /bankroll',
      metadata: { old: oldValue, new: newValue, source: 'telegram' },
    });

    await ctx.reply(
      `✅ Bankroll atualizado: \`$${oldValue.toFixed(2)}\` → \`$${newValue.toFixed(2)}\``,
      { parse_mode: 'Markdown' },
    );
  } catch (err) {
    await logEvent({ component: 'telegram_bot', status: 'error', message: `bankrollHandler error: ${String(err)}` });
    await ctx.reply('Erro interno. Tenta de novo em alguns segundos.');
  }
}
