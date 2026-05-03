import type { Context, MiddlewareFn } from 'grammy';
import { getSystemConfig } from '../lib/config.js';

export function authMiddleware<C extends Context>(): MiddlewareFn<C> {
  return async (ctx, next) => {
    const config = await getSystemConfig();
    const allowedId = config.telegram_chat_id;

    if (!allowedId || ctx.chat?.id.toString() !== allowedId) {
      await ctx.reply('Acesso negado.');
      return;
    }

    await next();
  };
}
