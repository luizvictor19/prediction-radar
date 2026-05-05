import { InlineKeyboard } from 'grammy';
import type { BotContext, BotConversation } from '../index.js';
import { supabase } from '../../lib/supabase.js';
import { logEvent } from '../../lib/logger.js';
import { relativeTime } from '../format.js';
import { positionKeyboard, basketKeyboard } from '../keyboards.js';

type LegRow = {
  id: string;
  bet_id: string;
  outcome: string;
  entry_price: number;
  stake_usd: number;
  shares: number | null;
  created_at: string;
  my_bets: { placed_at: string; polymarket_category: string | null; thesis: string | null } | null;
  events: { title: string } | null;
};

type BetGroup = {
  bet_id: string;
  placed_at: string;
  polymarket_category: string | null;
  thesis: string | null;
  legs: LegRow[];
};

type OpenLeg = {
  id: string;
  event_id: string | null;
  outcome: string;
  entry_price: number;
  stake_usd: number;
  shares: number | null;
  events: { title: string } | null;
};

function legLabel(leg: OpenLeg): string {
  return (leg.events as { title: string } | null)?.title ?? leg.outcome;
}

function legShares(leg: OpenLeg): number {
  return leg.shares ?? (leg.stake_usd / leg.entry_price);
}

export async function positionsHandler(ctx: BotContext): Promise<void> {
  try {
    const { data, error } = await supabase
      .from('my_bet_legs')
      .select(`
        id, bet_id, outcome, entry_price, stake_usd, shares, created_at,
        my_bets!inner ( placed_at, polymarket_category, thesis ),
        events ( title )
      `)
      .is('closed_at', null)
      .order('created_at', { ascending: true });

    if (error) {
      await logEvent({ component: 'telegram_bot', status: 'error', message: `positions query failed: ${error.message}` });
      await ctx.reply('Erro interno. Tenta de novo em alguns segundos.');
      return;
    }

    const legs = (data ?? []) as unknown as LegRow[];

    if (legs.length === 0) {
      await ctx.reply('Nenhuma posição aberta.');
      return;
    }

    // Group by bet_id preserving creation order within each group
    const groupMap = new Map<string, BetGroup>();
    for (const leg of legs) {
      if (!groupMap.has(leg.bet_id)) {
        const betMeta = leg.my_bets as { placed_at: string; polymarket_category: string | null; thesis: string | null } | null;
        groupMap.set(leg.bet_id, {
          bet_id: leg.bet_id,
          placed_at: betMeta?.placed_at ?? leg.created_at,
          polymarket_category: betMeta?.polymarket_category ?? null,
          thesis: betMeta?.thesis ?? null,
          legs: [],
        });
      }
      groupMap.get(leg.bet_id)!.legs.push(leg);
    }

    // Sort groups newest first
    const groups = [...groupMap.values()].sort(
      (a, b) => new Date(b.placed_at).getTime() - new Date(a.placed_at).getTime(),
    );

    for (const group of groups) {
      const { legs: groupLegs, bet_id, placed_at, polymarket_category, thesis } = group;

      if (groupLegs.length === 1) {
        const leg = groupLegs[0]!;
        const eventTitle =
          (leg.events as { title: string } | null)?.title ?? thesis ?? polymarket_category ?? 'Bet manual';
        const sharesDisplay = (leg.shares ?? 0).toFixed(2);
        const text =
          `📅 ${eventTitle}\n` +
          `   ${leg.outcome} — $${leg.stake_usd.toFixed(2)} @ ${leg.entry_price} — ${sharesDisplay} shares\n` +
          `   Aberta há ${relativeTime(placed_at)}`;
        await ctx.reply(text, { reply_markup: positionKeyboard(bet_id) });
      } else {
        const firstTitle =
          (groupLegs[0]!.events as { title: string } | null)?.title ?? thesis ?? polymarket_category ?? 'Basket';
        const totalStake = groupLegs.reduce((s, l) => s + l.stake_usd, 0);
        let text = `🎯 ${firstTitle} (basket, ${groupLegs.length} legs)\n`;
        for (const leg of groupLegs) {
          const evtTitle = (leg.events as { title: string } | null)?.title ?? 'Sem título';
          const sharesDisplay = (leg.shares ?? 0).toFixed(2);
          text += `   • ${evtTitle}: $${leg.stake_usd.toFixed(2)} @ ${leg.entry_price} — ${sharesDisplay} shares\n`;
        }
        text += `   Stake total: $${totalStake.toFixed(2)} | Aberta há ${relativeTime(placed_at)}`;
        await ctx.reply(text, { reply_markup: basketKeyboard(bet_id) });
      }
    }

    // Summary by outcome
    const totalLegs = legs.length;
    const counts = new Map<string, number>();
    for (const leg of legs) {
      counts.set(leg.outcome, (counts.get(leg.outcome) ?? 0) + 1);
    }
    const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
    const lines = sorted.map(([outcome, n]) => `• ${outcome}: ${n}`).join('\n');
    await ctx.reply(`📊 Total: ${totalLegs} legs abertas\n${lines}`);
  } catch (err) {
    await logEvent({ component: 'telegram_bot', status: 'error', message: `positionsHandler error: ${String(err)}` });
    await ctx.reply('Erro interno. Tenta de novo em alguns segundos.');
  }
}

export async function closePositionConversation(
  conversation: BotConversation,
  ctx: BotContext,
  betId: string,
): Promise<void> {
  try {
    const { data: legsData, error: legsErr } = await supabase
      .from('my_bet_legs')
      .select('id, event_id, outcome, entry_price, stake_usd, shares, events(title)')
      .eq('bet_id', betId)
      .is('closed_at', null)
      .order('created_at', { ascending: true });

    if (legsErr || !legsData) {
      await logEvent({ component: 'telegram_bot', status: 'error', message: `close legs query failed: ${legsErr?.message}` });
      await ctx.reply('Erro ao buscar legs. Tenta de novo.');
      return;
    }

    const legs = legsData as unknown as OpenLeg[];

    if (legs.length === 0) {
      await ctx.reply('Nenhuma leg aberta nessa bet.');
      return;
    }

    const nowIso = new Date().toISOString();

    const RESULT_KBD = new InlineKeyboard()
      .text('Win', 'res:win')
      .text('Loss', 'res:loss')
      .text('Anulado', 'res:void');

    if (legs.length === 1) {
      // === SINGLE LEG ===
      const leg = legs[0]!;

      await ctx.reply(
        'Preço de fechamento (decimal, ex: 0.65) ou resolved se resolveu (sem fechar antecipado):'
      );
      const inputCtx = await conversation.waitFor('message:text');
      const inputRaw = inputCtx.message.text.trim();

      let closingPrice: number | null = null;
      let resolutionPrice: number | null = null;

      if (inputRaw !== 'resolved') {
        closingPrice = parseFloat(inputRaw);
        if (isNaN(closingPrice) || closingPrice < 0 || closingPrice > 1) {
          await ctx.reply('Preço inválido (deve ser entre 0 e 1). Operação cancelada.');
          return;
        }
      }

      await ctx.reply('Resultado?', { reply_markup: RESULT_KBD });
      const resCtx = await conversation.waitFor('callback_query:data');
      await resCtx.answerCallbackQuery();
      const result = resCtx.callbackQuery.data.replace('res:', '');

      if (result === 'win') resolutionPrice = inputRaw === 'resolved' ? 1.0 : null;
      if (result === 'loss') resolutionPrice = inputRaw === 'resolved' ? 0.0 : null;

      const shares = legShares(leg);
      let pnlUsd: number;
      if (result === 'win') {
        const cp = resolutionPrice ?? closingPrice ?? 1.0;
        pnlUsd = (cp - leg.entry_price) * shares;
      } else if (result === 'loss') {
        pnlUsd = -leg.stake_usd;
      } else {
        pnlUsd = 0;
      }

      await supabase.from('my_bet_legs').update({
        closing_price: closingPrice,
        resolution_price: resolutionPrice,
        result,
        pnl_usd: pnlUsd,
        closed_at: nowIso,
      }).eq('id', leg.id);

      await supabase.from('my_bets').update({ closed_at: nowIso }).eq('id', betId);

      const sign = pnlUsd >= 0 ? '+' : '';
      await ctx.reply(`✅ Posição fechada. PnL: \`${sign}$${pnlUsd.toFixed(2)}\`\n\n💡 Atualize o bankroll com /bankroll <novo_valor>`, { parse_mode: 'Markdown' });

    } else {
      // === BASKET ===
      const BASKET_KBD = new InlineKeyboard()
        .text('Resolveu (1 leg ganhou)', 'basket:resolved').row()
        .text('Fechar cada leg manualmente', 'basket:manual').row()
        .text('Cancelar', 'basket:cancel');

      await ctx.reply(`Como fechar a basket de ${legs.length} legs?`, { reply_markup: BASKET_KBD });
      const choiceCtx = await conversation.waitFor('callback_query:data');
      await choiceCtx.answerCallbackQuery();
      const choice = choiceCtx.callbackQuery.data;

      if (choice === 'basket:cancel') {
        await ctx.reply('Operação cancelada.');
        return;
      }

      if (choice === 'basket:resolved') {
        const winKbd = new InlineKeyboard();
        for (let i = 0; i < legs.length; i++) {
          const leg = legs[i]!;
          const label = `${i + 1}. ${legLabel(leg).slice(0, 55)}`;
          winKbd.text(label, `resolved_leg:${leg.id}`).row();
        }
        winKbd.text('Nenhuma (anulado)', 'resolved_leg:none');

        await ctx.reply('Qual leg ganhou?', { reply_markup: winKbd });
        const winCtx = await conversation.waitFor('callback_query:data');
        await winCtx.answerCallbackQuery();
        const winChoice = winCtx.callbackQuery.data;

        if (winChoice === 'resolved_leg:none') {
          for (const leg of legs) {
            await supabase.from('my_bet_legs').update({
              result: 'void', pnl_usd: 0, resolution_price: null, closing_price: null, closed_at: nowIso,
            }).eq('id', leg.id);
          }
          await supabase.from('my_bets').update({ closed_at: nowIso }).eq('id', betId);
          await ctx.reply('✅ Basket anulada. PnL: $0.00');
          return;
        }

        const winnerLegId = winChoice.replace('resolved_leg:', '');
        const winnerLeg = legs.find(l => l.id === winnerLegId)!;
        let totalPnl = 0;
        let winnerPnl = 0;
        let losersPnl = 0;

        for (const leg of legs) {
          const isWinner = leg.id === winnerLegId;
          const result = isWinner ? 'win' : 'loss';
          const resPrice = isWinner ? 1.0 : 0.0;
          const shares = legShares(leg);
          const pnlUsd = isWinner ? (1.0 - leg.entry_price) * shares : -leg.stake_usd;

          totalPnl += pnlUsd;
          if (isWinner) winnerPnl = pnlUsd;
          else losersPnl += pnlUsd;

          await supabase.from('my_bet_legs').update({
            result,
            resolution_price: resPrice,
            closing_price: null,
            pnl_usd: pnlUsd,
            closed_at: nowIso,
          }).eq('id', leg.id);
        }

        await supabase.from('my_bets').update({ closed_at: nowIso }).eq('id', betId);

        const sign = totalPnl >= 0 ? '+' : '';
        await ctx.reply(
          `✅ Basket fechada. PnL total: \`${sign}$${totalPnl.toFixed(2)}\`\n` +
          `Leg vencedora: ${legLabel(winnerLeg)}, lucro \`+$${winnerPnl.toFixed(2)}\`\n` +
          `Outras ${legs.length - 1} legs: prejuízo total \`$${losersPnl.toFixed(2)}\`\n\n` +
          `💡 Atualize o bankroll com /bankroll <novo_valor>`,
          { parse_mode: 'Markdown' },
        );

      } else if (choice === 'basket:manual') {
        const legResults: { label: string; pnl: number; result: string }[] = [];

        for (let i = 0; i < legs.length; i++) {
          const leg = legs[i]!;
          const label = legLabel(leg);
          const shares = legShares(leg);

          await ctx.reply(
            `Leg ${i + 1}/${legs.length}: ${label}\n` +
            `Stake: $${leg.stake_usd.toFixed(2)} @ ${leg.entry_price}, ${shares.toFixed(4)} shares\n` +
            `Preço de fechamento (decimal) ou 'win' / 'loss' / 'anulado':`
          );
          const inputCtx = await conversation.waitFor('message:text');
          const raw = inputCtx.message.text.trim().toLowerCase();

          let result: string;
          let closingPrice: number | null = null;
          let resolutionPrice: number | null = null;
          let pnlUsd: number;

          if (raw === 'win') {
            result = 'win'; resolutionPrice = 1.0;
            pnlUsd = (1.0 - leg.entry_price) * shares;
          } else if (raw === 'loss') {
            result = 'loss'; resolutionPrice = 0.0;
            pnlUsd = -leg.stake_usd;
          } else if (raw === 'anulado') {
            result = 'void'; pnlUsd = 0;
          } else {
            closingPrice = parseFloat(raw);
            if (isNaN(closingPrice) || closingPrice < 0 || closingPrice > 1) {
              await ctx.reply(`Valor inválido na leg ${i + 1}. Encerrando fluxo.`);
              break;
            }
            const diff = (closingPrice - leg.entry_price) * shares;
            result = diff > 0 ? 'win' : diff < 0 ? 'loss' : 'void';
            pnlUsd = diff;
          }

          await supabase.from('my_bet_legs').update({
            closing_price: closingPrice,
            resolution_price: resolutionPrice,
            result,
            pnl_usd: pnlUsd,
            closed_at: nowIso,
          }).eq('id', leg.id);

          legResults.push({ label, pnl: pnlUsd, result });
        }

        await supabase.from('my_bets').update({ closed_at: nowIso }).eq('id', betId);

        const totalPnl = legResults.reduce((s, r) => s + r.pnl, 0);
        const sign = totalPnl >= 0 ? '+' : '';
        let reply = `✅ Basket fechada. PnL total: \`${sign}$${totalPnl.toFixed(2)}\`\n`;
        for (const r of legResults) {
          const s = r.pnl >= 0 ? '+' : '';
          reply += `• ${r.label}: \`${s}$${r.pnl.toFixed(2)}\` (${r.result})\n`;
        }
        reply += `\n💡 Atualize o bankroll com /bankroll <novo_valor>`;
        await ctx.reply(reply, { parse_mode: 'Markdown' });
      }
    }
  } catch (err) {
    await logEvent({ component: 'telegram_bot', status: 'error', message: `closePositionConversation error: ${String(err)}` });
    await ctx.reply('Erro interno. Tenta de novo em alguns segundos.');
  }
}
