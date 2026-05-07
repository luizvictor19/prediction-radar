import 'dotenv/config';
import { Bot, Context, InlineKeyboard } from 'grammy';
import { conversations, createConversation, type ConversationFlavor, type Conversation } from '@grammyjs/conversations';
import { authMiddleware } from './auth.js';
import { signalsHandler } from './handlers/signals.js';
import { trackConversation } from './handlers/track.js';
import { positionsHandler, closePositionConversation, closeSingleLegConversation } from './handlers/positions.js';
import { statusHandler } from './handlers/status.js';
import { cashConversation } from './handlers/cash.js';
import { configHandler } from './handlers/config_cmd.js';
import { helpHandler } from './handlers/help.js';
import { registerHandler, registerConversation } from './handlers/register.js';
import { editHandler, editConversation } from './handlers/edit.js';
import { customTrackConversation } from './handlers/track-custom.js';
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

bot.use(createConversation(
  async (conversation, ctx) => {
    await cashConversation(conversation as BotConversation, ctx as BotContext);
  },
  'cashConversation',
));

bot.use(createConversation(
  async (conversation, ctx, signalId: unknown) => {
    await customTrackConversation(conversation as BotConversation, ctx as BotContext, signalId as string);
  },
  'customTrackConversation',
));

bot.use(createConversation(
  async (conversation, ctx, legId: unknown) => {
    await closeSingleLegConversation(conversation as BotConversation, ctx as BotContext, legId as string);
  },
  'close_single_leg',
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
bot.command('cash', async (ctx) => { await ctx.conversation.enter('cashConversation'); });
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
    await supabase
      .from('detected_signals')
      .update({
        dismissed: true,
        user_dismissed_at: new Date().toISOString(),
        user_action_type: 'dismissed',
      })
      .eq('id', signalId);
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

bot.callbackQuery(/^close_leg_select:(.+)$/, async (ctx) => {
  const betId = ctx.match[1];
  await ctx.answerCallbackQuery();

  const { data: legs, error } = await supabase
    .from('my_bet_legs')
    .select('id, outcome, stake_usd, events(title)')
    .eq('bet_id', betId)
    .is('closed_at', null)
    .order('created_at', { ascending: true });

  if (error || !legs || legs.length === 0) {
    await ctx.reply('Nenhuma leg aberta nesta bet.');
    return;
  }

  const kbd = new InlineKeyboard();
  for (let i = 0; i < legs.length; i++) {
    const leg = legs[i]!;
    const title = (leg.events as unknown as { title: string } | null)?.title ?? leg.outcome;
    const label = `${i + 1}. ${title.slice(0, 50)} ($${(leg.stake_usd as number).toFixed(2)})`;
    kbd.text(label, `close_single_leg:${leg.id}`).row();
  }
  kbd.text('Cancelar', 'close_leg_cancel');

  await ctx.reply('Qual leg fechar?', { reply_markup: kbd });
});

bot.callbackQuery(/^close_single_leg:(.+)$/, async (ctx) => {
  const legId = ctx.match[1];
  await ctx.answerCallbackQuery();
  await ctx.conversation.enter('close_single_leg', legId);
});

bot.callbackQuery(/^close_leg_cancel$/, async (ctx) => {
  await ctx.answerCallbackQuery('Cancelado.');
  await ctx.editMessageText('Operação cancelada.');
});

bot.callbackQuery(/^track_custom:(.+)$/, async (ctx) => {
  const signalId = ctx.match[1];
  await ctx.answerCallbackQuery();
  await ctx.conversation.enter('customTrackConversation', signalId);
});

bot.callbackQuery(/^analyze_ai:(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.reply(
    '🧠 *Análise da IA ainda não está implementada.*\n\nEm breve essa funcionalidade vai estar disponível.\nPor enquanto, use as informações acima para decidir.',
    { parse_mode: 'Markdown' },
  );
});

startNotifyLoop(bot);

try {
  await bot.api.setMyCommands([
    { command: 'signals',   description: 'Listar sinais ativos' },
    { command: 'positions', description: 'Posições abertas' },
    { command: 'status',    description: 'Resumo do sistema' },
    { command: 'cash',      description: 'Atualizar saldo de cash' },
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
