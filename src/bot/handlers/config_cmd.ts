import type { BotContext } from '../index.js';
import { getSystemConfig } from '../../lib/config.js';
import { logEvent } from '../../lib/logger.js';

export async function configHandler(ctx: BotContext): Promise<void> {
  try {
    const config = await getSystemConfig();
    const text =
      `*Configuração atual*\n` +
      `Bankroll: \`$${config.bankroll_usd.toFixed(2)}\`\n` +
      `Stake máximo (default): \`${(config.max_stake_pct * 100).toFixed(1)}%\`\n` +
      `Stake máximo (cross-market): \`${(config.cross_market_max_stake_pct * 100).toFixed(1)}%\`\n` +
      `Edge mínimo (listagem): \`${config.min_expected_edge_pct.toFixed(1)}%\`\n` +
      `Edge mínimo (notificação): \`${config.notify_min_edge_pct.toFixed(1)}%\`\n\n` +
      `Use /bankroll <valor> para atualizar saldo.`;

    await ctx.reply(text, { parse_mode: 'Markdown' });
  } catch (err) {
    await logEvent({ component: 'telegram_bot', status: 'error', message: `configHandler error: ${String(err)}` });
    await ctx.reply('Erro interno. Tenta de novo em alguns segundos.');
  }
}
