import 'dotenv/config';
import { Bot, Context } from 'grammy';
import { conversations, createConversation, type ConversationFlavor, type Conversation } from '@grammyjs/conversations';
import { authMiddleware } from './auth.js';
import { signalsHandler } from './handlers/signals.js';
import { trackConversation } from './handlers/track.js';
import { positionsHandler, closePositionConversation } from './handlers/positions.js';
import { statusHandler } from './handlers/status.js';
import { topupHandler } from './handlers/topup.js';
import { withdrawHandler } from './handlers/withdraw.js';
import { configHandler } from './handlers/config_cmd.js';
import { helpHandler } from './handlers/help.js';
import { registerHandler, registerConversation } from './handlers/register.js';
import { editHandler, editConversation } from './handlers/edit.js';
import { startNotifyLoop } from './notify.js';
import { supabase } from '../lib/supabase.js';
import { logEvent } from '../lib/logger.js';

// BotContext = full context including conversation flavor, used by bot middleware and handlers.
// BotConversation = unparameterized Conversation (Context defaults), used inside conversation handlers.
export type BotContext = ConversationFlavor<Context>;
export type BotConversation = Conversation;

const token = process.env['TELEGRAM_BOT_TOKEN'];
if (!token) {
  console.error('[bot] TELEGRAM_BOT_TOKEN is not set');
  process.exit(1);
}

const bot = new Bot<BotContext>(token);

bot.use(conversations());

bot.use(createConversation(
  async (conversation, ctx, signalId: unknown) => {
    await trackConversation(conversation as BotConversation, ctx as BotContext, signalId as string);
  },
  'track',
));

bot.use(createConversation(
  async (conversation, ctx, positionId: unknown) => {
    await closePositionConversation(conversation as BotConversation, ctx as BotContext, positionId as string);
  },
  'close_position',
));

bot.use(createConversation(
  async (conversation, ctx) => {
    await registerConversation(conversation as BotConversation, ctx as BotContext);
  },
  'register',
));

bot.use(createConversation(
  async (conversation, ctx, legId: unknown) => {
    await editConversation(conversation as BotConversation, ctx as BotContext, legId);
  },
  'edit',
));

bot.use(authMiddleware());

bot.use(async (ctx, next) => {
  const cmd = ctx.message?.text?.match(/^\/(\w+)/)?.[1];
  if (cmd) {
    await logEvent({ component: 'bot_command', status: 'success', message: `/${cmd} received` });
  }
  return next();
});

bot.command('signals', signalsHandler);
bot.command('positions', positionsHandler);
bot.command('status', statusHandler);
bot.command('topup', topupHandler);
bot.command('withdraw', withdrawHandler);
bot.command('config', configHandler);
bot.command('help', helpHandler);
bot.command('register', registerHandler);
bot.command('edit', editHandler);

bot.callbackQuery(/^edit_leg:(.+)$/, async (ctx) => {
  const legId = ctx.match[1];
  await ctx.answerCallbackQuery();
  await ctx.conversation.enter('edit', legId);
});

bot.callbackQuery(/^dismiss:(.+)$/, async (ctx) => {
  const signalId = ctx.match[1];
  try {
    await supabase.from('detected_signals').update({ dismissed: true }).eq('id', signalId);
    const original = ctx.callbackQuery.message?.text ?? '';
    await ctx.editMessageText('❌ DISMISSED\n\n' + original, { parse_mode: 'Markdown' });
    await ctx.answerCallbackQuery('Sinal dispensado.');
  } catch (err) {
    await logEvent({ component: 'telegram_bot', status: 'error', message: `dismiss callback error: ${String(err)}` });
    await ctx.answerCallbackQuery('Erro ao dispensar sinal.');
  }
});

bot.callbackQuery(/^track:(.+)$/, async (ctx) => {
  const signalId = ctx.match[1];
  await ctx.answerCallbackQuery();
  await ctx.conversation.enter('track', signalId);
});

bot.callbackQuery(/^track_yes:(.+)$/, async (ctx) => {
  const signalId = ctx.match[1];
  await ctx.answerCallbackQuery();
  const { data: sig } = await supabase
    .from('detected_signals')
    .select('events(outcomes)')
    .eq('id', signalId)
    .single();
  const outcomes = (sig as any)?.events?.outcomes;
  const outcomeName: string = outcomes?.values?.[0] ?? 'Yes';
  await ctx.conversation.enter('track', `${signalId}:${outcomeName}`);
});

bot.callbackQuery(/^track_no:(.+)$/, async (ctx) => {
  const signalId = ctx.match[1];
  await ctx.answerCallbackQuery();
  const { data: sig } = await supabase
    .from('detected_signals')
    .select('events(outcomes)')
    .eq('id', signalId)
    .single();
  const outcomes = (sig as any)?.events?.outcomes;
  const outcomeName: string = outcomes?.values?.[1] ?? 'No';
  await ctx.conversation.enter('track', `${signalId}:${outcomeName}`);
});

bot.callbackQuery(/^close:(.+)$/, async (ctx) => {
  const positionId = ctx.match[1];
  await ctx.answerCallbackQuery();
  await ctx.conversation.enter('close_position', positionId);
});

startNotifyLoop(bot);

try {
  await bot.api.setMyCommands([
    { command: 'signals',   description: 'Listar sinais ativos' },
    { command: 'positions', description: 'Posições abertas' },
    { command: 'status',    description: 'Resumo do sistema' },
    { command: 'topup',     description: 'Adicionar cash ao bankroll' },
    { command: 'withdraw',  description: 'Retirar cash do bankroll' },
    { command: 'config',    description: 'Configuração atual' },
    { command: 'help',      description: 'Listar comandos disponíveis' },
    { command: 'register',  description: 'Registrar bet feita fora do bot' },
    { command: 'edit',      description: 'Editar legs abertas' },
  ]);
  console.log('[bot] Commands registered');
} catch (err) {
  console.error('[bot] Failed to register commands:', err);
}

console.log('[bot] Waiting 60s before starting long-polling to avoid 409 conflicts...');
await new Promise((resolve) => setTimeout(resolve, 60_000));
console.log('[bot] Starting long-polling now');
await logEvent({ component: 'telegram_bot', status: 'success', message: 'Bot started (long-polling)' });
bot.start({ drop_pending_updates: true });
