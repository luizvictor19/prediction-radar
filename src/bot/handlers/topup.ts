import type { BotContext } from '../index.js';
import { logEvent } from '../../lib/logger.js';
import { adjustCash, getBankrollState } from '../../lib/bankroll.js';

export async function topupHandler(ctx: BotContext): Promise<void> {
  try {
    const text = ctx.message?.text ?? '';
    const match = text.match(/^\/topup\s+([0-9]+(?:\.[0-9]+)?)/);

    if (!match) {
      await ctx.reply('Uso: `/topup <valor>` — adiciona ao cash.\nEx: `/topup 50`', {
        parse_mode: 'Markdown',
      });
      return;
    }

    const valor = parseFloat(match[1]!);
    if (isNaN(valor) || valor <= 0) {
      await ctx.reply('Valor inválido. Tem que ser número positivo.');
      return;
    }

    await adjustCash(valor);

    const state = await getBankrollState();
    await ctx.reply(
      `✅ Cash atualizado: +\`$${valor.toFixed(2)}\`\n\n` +
      `Cash: \`$${state.cash.toFixed(2)}\`\n` +
      `Portfolio: \`$${state.portfolio_value.toFixed(2)}\`\n` +
      `Bankroll: \`$${state.bankroll.toFixed(2)}\``,
      { parse_mode: 'Markdown' },
    );

    await logEvent({ component: 'bot_command', status: 'success', message: `Topup +$${valor}` });
  } catch (err) {
    await logEvent({ component: 'telegram_bot', status: 'error', message: `topupHandler error: ${String(err)}` });
    await ctx.reply('Erro interno. Tenta de novo em alguns segundos.');
  }
}
