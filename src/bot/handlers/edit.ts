import { InlineKeyboard } from 'grammy';
import type { BotContext, BotConversation } from '../index.js';
import { supabase } from '../../lib/supabase.js';
import { logEvent } from '../../lib/logger.js';
import { adjustCash } from '../../lib/bankroll.js';
import { normalizeOutcome } from '../../lib/outcome-normalizer.js';

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
        const sharesVal = leg.shares ?? 0;
        const text =
          `📅 ${title} (single-leg)\n` +
          `   • ${leg.outcome} — $${leg.stake_usd.toFixed(2)} @ ${leg.entry_price} — ${sharesVal.toFixed(1)} shares · paga $${sharesVal.toFixed(2)} se ganhar`;
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
          const sharesVal = leg.shares ?? 0;
          text += `   • ${evtTitle}: ${leg.outcome} — $${leg.stake_usd.toFixed(2)} @ ${leg.entry_price} — ${sharesVal.toFixed(1)} shares · paga $${sharesVal.toFixed(2)} se ganhar\n`;
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
      .select('id, entry_price, stake_usd, outcome, event_id, bet_id')
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
      const oldStake = (leg as { stake_usd: number }).stake_usd;
      const stakeDelta = newStake - oldStake;
      const newShares = newStake / (leg as { entry_price: number }).entry_price;
      await supabase.from('my_bet_legs').update({ stake_usd: newStake, shares: newShares }).eq('id', id);
      await adjustCash(-stakeDelta);
      const cashMsg = stakeDelta !== 0
        ? `\nCash ajustado: ${stakeDelta > 0 ? '-' : '+'}$${Math.abs(stakeDelta).toFixed(2)}`
        : '';
      await ctx.reply(`✅ Leg atualizada. Novo stake: $${newStake.toFixed(2)}, novas shares: ${newShares.toFixed(4)} (recalculado).${cashMsg}`);

    } else if (field === 'edit:outcome') {
      const currentOutcome = (leg as { outcome: string }).outcome;
      await ctx.reply(`Outcome atual: \`${currentOutcome}\`\nDigite o novo outcome (texto livre):`, { parse_mode: 'Markdown' });
      const inputCtx = await conversation.waitFor('message:text');
      const rawOutcome = inputCtx.message.text.trim();
      if (!rawOutcome) { await ctx.reply('Sem alterações.'); return; }

      const eventId = (leg as { event_id: string | null }).event_id;
      let newOutcome: string;
      if (eventId) {
        const norm = await normalizeOutcome(eventId, rawOutcome);
        if (!norm.ok) {
          await ctx.reply(
            `Outcome não encontrado.\nDisponíveis: ${norm.available.join(', ')}`,
          );
          return;
        }
        newOutcome = norm.outcome;
      } else {
        newOutcome = rawOutcome;
      }

      await supabase.from('my_bet_legs').update({ outcome: newOutcome }).eq('id', id);

      // The bet's `prob_self_outcome` was copied from this leg's outcome at
      // registration, so correcting the leg and leaving the bet alone would
      // leave the probability labelled with the side that was just declared
      // wrong. That row would still satisfy `my_bets_prob_self_tem_lado`, which
      // only asks that the label exist, and would score as a bet never made.
      //
      // Single-leg bets only, and that is a decision rather than a gap left
      // open. A basket carries ONE probability across N legs, so no leg's
      // outcome is the probability's side: registration deliberately writes no
      // label there, and there is nothing to keep in step. Moving a label onto
      // a basket from whichever leg happened to be edited would invent the
      // side the basket flow refused to invent.
      //
      // The count cannot mistake a basket for a single bet, and the invariant
      // is about the DATABASE rather than about this handler, so it was swept
      // that way: `src/`, `web/` and `scripts/`, plus the SQL in
      // `supabase/migrations/` and every `rpc` any of them calls.
      //
      // Nothing deletes an individual leg. `register.ts` rejects a basket with
      // fewer than 2 legs before any insert; the only delete that reaches
      // `my_bet_legs` is the `on delete cascade` from `my_bets`, which removes
      // ALL legs of a bet at once and so cannot shrink a basket into a single
      // bet; and `my_bet_legs.event_id` references `events` with no
      // `on delete` at all, so that side cannot remove a leg either. No `rpc`
      // touches the table. So a bet with one leg was registered with one leg.
      //
      // `prob_self is not null` on the update carries the rest: a `track.ts` or
      // `track-custom.ts` bet also has one leg, and neither stores a
      // probability, so the write matches nothing there.
      const betId = (leg as { bet_id: string }).bet_id;
      const { count: legsDoBet } = await supabase
        .from('my_bet_legs')
        .select('id', { count: 'exact', head: true })
        .eq('bet_id', betId);

      if (legsDoBet === 1) {
        const { error: betErr } = await supabase
          .from('my_bets')
          .update({ prob_self_outcome: newOutcome })
          .eq('id', betId)
          .not('prob_self', 'is', null);
        if (betErr) {
          await logEvent({ component: 'telegram_bot', status: 'error', message: `edit prob_self_outcome update failed: ${betErr.message}` });
          await ctx.reply(
            '⚠️ Outcome da leg atualizado, mas o lado da probabilidade NÃO acompanhou. ' +
              'A linha ficou com a probabilidade rotulada do lado antigo. Avisa antes de pontuar.',
          );
          return;
        }
      }

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
