import { InlineKeyboard } from 'grammy';
import type { BotContext, BotConversation } from '../index.js';
import { supabase } from '../../lib/supabase.js';
import { logEvent } from '../../lib/logger.js';

type OpenLegRow = {
  id: string;
  bet_id: string;
  outcome: string;
  entry_price: number;
  stake_usd: number;
  shares: number | null;
  my_bets: { thesis: string | null; polymarket_category: string | null } | null;
  events: { title: string } | null;
};

export async function editHandler(ctx: BotContext): Promise<void> {
  try {
    const { data, error } = await supabase
      .from('my_bet_legs')
      .select(`
        id, bet_id, outcome, entry_price, stake_usd, shares,
        my_bets!inner ( thesis, polymarket_category ),
        events ( title )
      `)
      .is('closed_at', null)
      .order('created_at', { ascending: true });

    if (error) {
      await logEvent({ component: 'telegram_bot', status: 'error', message: `edit query failed: ${error.message}` });
      await ctx.reply('Erro interno. Tenta de novo em alguns segundos.');
      return;
    }

    const legs = (data ?? []) as unknown as OpenLegRow[];

    if (legs.length === 0) {
      await ctx.reply('Nenhuma leg aberta pra editar.');
      return;
    }

    const groupMap = new Map<string, OpenLegRow[]>();
    for (const leg of legs) {
      if (!groupMap.has(leg.bet_id)) groupMap.set(leg.bet_id, []);
      groupMap.get(leg.bet_id)!.push(leg);
    }

    for (const [, groupLegs] of groupMap) {
      if (groupLegs.length === 1) {
        const leg = groupLegs[0]!;
        const title =
          (leg.events as { title: string } | null)?.title ??
          (leg.my_bets as { thesis: string | null } | null)?.thesis ??
          'Bet manual';
        const shares = (leg.shares ?? 0).toFixed(4);
        const text =
          `📅 ${title} (single-leg)\n` +
          `   • ${leg.outcome} — $${leg.stake_usd.toFixed(2)} @ ${leg.entry_price} — ${shares} shares`;
        const kbd = new InlineKeyboard().text('Editar leg', `edit_leg:${leg.id}`);
        await ctx.reply(text, { reply_markup: kbd });
      } else {
        const firstLeg = groupLegs[0]!;
        const firstTitle =
          (firstLeg.events as { title: string } | null)?.title ??
          (firstLeg.my_bets as { thesis: string | null } | null)?.thesis ??
          'Basket';
        let text = `🎯 ${firstTitle} (basket, ${groupLegs.length} legs)\n`;
        for (const leg of groupLegs) {
          const evtTitle = (leg.events as { title: string } | null)?.title ?? 'Sem título';
          const shares = (leg.shares ?? 0).toFixed(4);
          text += `   • ${evtTitle}: ${leg.outcome} — $${leg.stake_usd.toFixed(2)} @ ${leg.entry_price} — ${shares} shares\n`;
        }
        const kbd = new InlineKeyboard();
        for (let i = 0; i < groupLegs.length; i++) {
          kbd.text(`Editar leg ${i + 1}`, `edit_leg:${groupLegs[i]!.id}`).row();
        }
        await ctx.reply(text, { reply_markup: kbd });
      }
    }
  } catch (err) {
    await logEvent({ component: 'telegram_bot', status: 'error', message: `editHandler error: ${String(err)}` });
    await ctx.reply('Erro interno. Tenta de novo em alguns segundos.');
  }
}

export async function editConversation(
  conversation: BotConversation,
  ctx: BotContext,
  legId: unknown,
): Promise<void> {
  try {
    const id = legId as string;

    const { data: leg, error: legErr } = await supabase
      .from('my_bet_legs')
      .select('id, entry_price, stake_usd, outcome')
      .eq('id', id)
      .single();

    if (legErr || !leg) {
      await ctx.reply('Leg não encontrada.');
      return;
    }

    const EDIT_KBD = new InlineKeyboard()
      .text('To win', 'edit:price')
      .text('Stake', 'edit:stake')
      .text('Outcome', 'edit:outcome')
      .text('Notes', 'edit:notes')
      .text('Cancelar', 'edit:cancel');

    await ctx.reply('O que editar?', { reply_markup: EDIT_KBD });
    const choiceCtx = await conversation.waitFor('callback_query:data');
    await choiceCtx.answerCallbackQuery();
    const field = choiceCtx.callbackQuery.data;

    if (field === 'edit:cancel') {
      await ctx.reply('Operação cancelada.');
      return;
    }

    if (field === 'edit:price') {
      await ctx.reply('Novo valor a receber se ganhar (USD) ou skip:');
      const inputCtx = await conversation.waitFor('message:text');
      const raw = inputCtx.message.text.trim();
      if (raw === 'skip') { await ctx.reply('Sem alterações.'); return; }
      const newToWin = parseFloat(raw);
      if (isNaN(newToWin) || newToWin <= 0) {
        await ctx.reply('Valor inválido. Operação cancelada.');
        return;
      }
      const stakeUsd = (leg as { stake_usd: number }).stake_usd;
      const newPrice = stakeUsd / newToWin;
      if (newPrice <= 0 || newPrice > 1) {
        await ctx.reply(`Preço calculado inválido (${newPrice.toFixed(4)}). Verifique stake e to win. Operação cancelada.`);
        return;
      }
      const newShares = newToWin;
      await supabase.from('my_bet_legs').update({ entry_price: newPrice, shares: newShares }).eq('id', id);
      await ctx.reply(`✅ Leg atualizada. Preço (calc): ${newPrice.toFixed(4)}, shares: ${newShares.toFixed(1)}.`);

    } else if (field === 'edit:stake') {
      await ctx.reply('Novo stake em USD (ou skip):');
      const inputCtx = await conversation.waitFor('message:text');
      const raw = inputCtx.message.text.trim();
      if (raw === 'skip') { await ctx.reply('Sem alterações.'); return; }
      const newStake = parseFloat(raw);
      if (isNaN(newStake) || newStake <= 0) {
        await ctx.reply('Stake inválido. Operação cancelada.');
        return;
      }
      const newShares = newStake / (leg as { entry_price: number }).entry_price;
      await supabase.from('my_bet_legs').update({ stake_usd: newStake, shares: newShares }).eq('id', id);
      await ctx.reply(`✅ Leg atualizada. Novo stake: $${newStake.toFixed(2)}, novas shares: ${newShares.toFixed(4)} (recalculado).`);

    } else if (field === 'edit:outcome') {
      const currentOutcome = (leg as { outcome: string }).outcome;
      await ctx.reply(`Outcome atual: \`${currentOutcome}\`\nDigite o novo outcome (texto livre):`, { parse_mode: 'Markdown' });
      const inputCtx = await conversation.waitFor('message:text');
      const newOutcome = inputCtx.message.text.trim();
      if (!newOutcome) { await ctx.reply('Sem alterações.'); return; }
      await supabase.from('my_bet_legs').update({ outcome: newOutcome }).eq('id', id);
      await ctx.reply(`✅ Outcome atualizado: \`${currentOutcome}\` → \`${newOutcome}\``, { parse_mode: 'Markdown' });

    } else if (field === 'edit:notes') {
      await ctx.reply('Notas (texto livre, ou skip pra apagar):');
      const inputCtx = await conversation.waitFor('message:text');
      const raw = inputCtx.message.text.trim();
      const notes = raw === 'skip' ? null : raw;
      await supabase.from('my_bet_legs').update({ notes }).eq('id', id);
      await ctx.reply('✅ Notas atualizadas.');
    }
  } catch (err) {
    await logEvent({ component: 'telegram_bot', status: 'error', message: `editConversation error: ${String(err)}` });
    await ctx.reply('Erro interno. Tenta de novo em alguns segundos.');
  }
}
