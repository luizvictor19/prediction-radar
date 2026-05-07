import { InlineKeyboard } from 'grammy';
import type { BotContext, BotConversation } from '../index.js';
import { supabase } from '../../lib/supabase.js';
import { logEvent } from '../../lib/logger.js';
import { adjustCash } from '../../lib/bankroll.js';
import type { CrossMarketInterSignalMetadata, CrossMarketInterMember } from '../../types/index.js';

const OUTCOME_KBD = new InlineKeyboard()
  .text('Yes', 'custom_outcome:yes')
  .text('No', 'custom_outcome:no')
  .text('Pular', 'custom_outcome:skip');

const SIM_NAO_KBD = new InlineKeyboard().text('Sim', 'sim').text('Não', 'nao');

interface CustomLeg {
  event_id: string;
  title: string;
  outcome: 'Yes' | 'No';
  entry_price: number;
  stake_usd: number;
  shares: number;
}

function shortTitle(title: string, maxLen = 40): string {
  return title.length <= maxLen ? title : title.slice(0, maxLen - 1) + '…';
}

export async function customTrackConversation(
  conversation: BotConversation,
  ctx: BotContext,
  signalId: string,
): Promise<void> {
  try {
    const { data: signal, error: sigErr } = await supabase
      .from('detected_signals')
      .select('*')
      .eq('id', signalId)
      .single();

    if (sigErr || !signal) {
      await ctx.reply('Sinal não encontrado.');
      return;
    }

    const meta = (signal.metadata ?? {}) as Partial<CrossMarketInterSignalMetadata>;
    const members = (meta.members ?? []) as CrossMarketInterMember[];

    if (members.length === 0) {
      await ctx.reply('Sinal sem membros válidos. Operação cancelada.');
      return;
    }

    await ctx.reply(
      `*Tese própria — ${members.length} legs disponíveis*\n` +
      `Pra cada leg, escolha Yes, No ou Pular. Depois informe o stake.\n` +
      `Preço de entrada vem do metadata do sinal.`,
      { parse_mode: 'Markdown' },
    );

    const customLegs: CustomLeg[] = [];

    for (let i = 0; i < members.length; i++) {
      const member = members[i]!;
      const yesPrice = member.yes_price;
      const noPrice = 1 - yesPrice;

      await ctx.reply(
        `Leg ${i + 1}/${members.length}: *${shortTitle(member.title, 50)}*\n` +
        `Yes: \`${yesPrice.toFixed(3)}\` | No: \`${noPrice.toFixed(3)}\`\n` +
        `Operar nesta?`,
        { parse_mode: 'Markdown', reply_markup: OUTCOME_KBD },
      );

      const outcomeCtx = await conversation.waitFor('callback_query:data');
      await outcomeCtx.answerCallbackQuery();
      const choice = outcomeCtx.callbackQuery.data;

      if (choice === 'custom_outcome:skip') continue;

      const outcome: 'Yes' | 'No' = choice === 'custom_outcome:yes' ? 'Yes' : 'No';
      const entryPrice = outcome === 'Yes' ? yesPrice : noPrice;

      await ctx.reply(`Leg ${i + 1}/${members.length}: Stake em USD?`);
      const stakeCtx = await conversation.waitFor('message:text');
      const stakeUsd = parseFloat(stakeCtx.message.text.trim());
      if (isNaN(stakeUsd) || stakeUsd <= 0) {
        await ctx.reply(`Stake inválido. Pulando leg ${i + 1}.`);
        continue;
      }

      const shares = stakeUsd / entryPrice;

      customLegs.push({
        event_id: member.event_id,
        title: member.title,
        outcome,
        entry_price: entryPrice,
        stake_usd: stakeUsd,
        shares,
      });
    }

    if (customLegs.length === 0) {
      await ctx.reply('Nenhuma leg selecionada. Operação cancelada.');
      return;
    }

    await ctx.reply('Tese curta (ou skip):');
    const thesisCtx = await conversation.waitFor('message:text');
    const thesisRaw = thesisCtx.message.text.trim();
    const thesis = thesisRaw === 'skip' ? null : thesisRaw;

    const totalStake = customLegs.reduce((s, l) => s + l.stake_usd, 0);
    let summary = `*Confirmar tese própria (${customLegs.length} legs)?*\n`;
    for (const leg of customLegs) {
      summary += `  • ${shortTitle(leg.title)} — \`${leg.outcome}\` — \`$${leg.stake_usd.toFixed(2)}\` @ \`${leg.entry_price.toFixed(3)}\`\n`;
    }
    summary += `Stake total: \`$${totalStake.toFixed(2)}\`\n`;
    if (thesis) summary += `Tese: ${thesis}\n`;

    await ctx.reply(summary, { parse_mode: 'Markdown', reply_markup: SIM_NAO_KBD });
    const confirmCtx = await conversation.waitFor('callback_query:data');
    await confirmCtx.answerCallbackQuery();
    if (confirmCtx.callbackQuery.data !== 'sim') {
      await ctx.reply('Operação cancelada.');
      return;
    }

    const polymarketCategory = meta.polymarket_category ?? null;

    const { data: bet, error: betErr } = await supabase
      .from('my_bets')
      .insert({
        signal_id: signalId,
        event_id: null,
        thesis: thesis ?? null,
        thesis_type: 'cross_market_inter_custom',
        confidence_self: null,
        domain_confidence: null,
        polymarket_category: polymarketCategory,
        notes: null,
        placed_at: new Date().toISOString(),
      })
      .select('id')
      .single();

    if (betErr || !bet) {
      await logEvent({ component: 'telegram_bot', status: 'error', message: `track_custom my_bets insert failed: ${betErr?.message ?? 'no data'}` });
      await ctx.reply('Erro ao registrar. Tenta de novo.');
      return;
    }

    try {
      for (const leg of customLegs) {
        const { error: legErr } = await supabase.from('my_bet_legs').insert({
          bet_id: bet.id,
          event_id: leg.event_id,
          outcome: leg.outcome,
          entry_price: leg.entry_price,
          stake_usd: leg.stake_usd,
          shares: leg.shares,
        });
        if (legErr) throw legErr;
      }
    } catch (err) {
      await supabase.from('my_bets').delete().eq('id', bet.id);
      await logEvent({ component: 'telegram_bot', status: 'error', message: `track_custom my_bet_legs insert failed: ${String(err)}` });
      await ctx.reply('Erro ao registrar. Tenta de novo.');
      return;
    }

    await supabase
      .from('detected_signals')
      .update({
        acted_on: true,
        user_acted_at: new Date().toISOString(),
        user_action_type: 'tracked_custom',
      })
      .eq('id', signalId);

    await adjustCash(-totalStake);

    await ctx.reply(
      `✅ Bet com tese própria registrada (${customLegs.length} legs, stake total \`$${totalStake.toFixed(2)}\`).`,
      { parse_mode: 'Markdown' },
    );
  } catch (err) {
    await logEvent({ component: 'telegram_bot', status: 'error', message: `customTrackConversation error: ${String(err)}` });
    await ctx.reply('Erro interno. Tenta de novo em alguns segundos.');
  }
}
