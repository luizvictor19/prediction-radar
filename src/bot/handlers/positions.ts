import { InlineKeyboard } from 'grammy';
import type { BotContext, BotConversation } from '../index.js';
import { supabase } from '../../lib/supabase.js';
import { logEvent } from '../../lib/logger.js';
import { adjustCash } from '../../lib/bankroll.js';
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
  event_id: string | null;
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

function currentValueLine(shares: number, stake: number, midPrice: number, indent: string): string {
  const curr = shares * midPrice;
  const diff = curr - stake;
  const pct = (diff / stake) * 100;
  const sign = diff >= 0 ? '+' : '-';
  return `${indent}📊 Atual: $${curr.toFixed(2)} (${sign}$${Math.abs(diff).toFixed(2)}, ${sign}${Math.abs(pct).toFixed(1)}%)\n`;
}

export async function positionsHandler(ctx: BotContext): Promise<void> {
  try {
    const { data, error } = await supabase
      .from('my_bet_legs')
      .select(`
        id, bet_id, outcome, entry_price, stake_usd, shares, created_at, event_id,
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

    // N+1: fetch latest mid_price per leg
    const midPrices = new Map<string, number | null>();
    for (const leg of legs) {
      if (!leg.event_id) {
        midPrices.set(leg.id, null);
        continue;
      }
      const { data: snap } = await supabase
        .from('polymarket_snapshots')
        .select('mid_price')
        .eq('event_id', leg.event_id)
        .eq('outcome', leg.outcome)
        .order('captured_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      midPrices.set(leg.id, snap?.mid_price ?? null);
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
        const shares = leg.shares ?? (leg.stake_usd / leg.entry_price);
        const midPrice = midPrices.get(leg.id) ?? null;
        const currLine = midPrice !== null ? currentValueLine(shares, leg.stake_usd, midPrice, '   ') : '';
        const text =
          `📅 ${eventTitle}\n` +
          `   ${leg.outcome} — $${leg.stake_usd.toFixed(2)} @ ${leg.entry_price} — ${shares.toFixed(1)} shares · paga $${shares.toFixed(2)} se ganhar\n` +
          currLine +
          `   Aberta há ${relativeTime(placed_at)}`;
        await ctx.reply(text, { reply_markup: positionKeyboard(bet_id) });
      } else {
        const firstTitle =
          (groupLegs[0]!.events as { title: string } | null)?.title ?? thesis ?? polymarket_category ?? 'Basket';
        const totalStake = groupLegs.reduce((s, l) => s + l.stake_usd, 0);
        let text = `🎯 ${firstTitle} (basket, ${groupLegs.length} legs)\n`;
        let basketCurrTotal = 0;
        let basketStakeWithSnap = 0;
        for (const leg of groupLegs) {
          const evtTitle = (leg.events as { title: string } | null)?.title ?? 'Sem título';
          const shares = leg.shares ?? (leg.stake_usd / leg.entry_price);
          const midPrice = midPrices.get(leg.id) ?? null;
          text += `   • ${evtTitle}: $${leg.stake_usd.toFixed(2)} @ ${leg.entry_price} — ${shares.toFixed(1)} shares · paga $${shares.toFixed(2)}\n`;
          if (midPrice !== null) {
            text += currentValueLine(shares, leg.stake_usd, midPrice, '     ');
            basketCurrTotal += shares * midPrice;
            basketStakeWithSnap += leg.stake_usd;
          }
        }
        if (basketStakeWithSnap > 0) {
          const basketDiff = basketCurrTotal - basketStakeWithSnap;
          const basketPct = (basketDiff / basketStakeWithSnap) * 100;
          const s = basketDiff >= 0 ? '+' : '-';
          text += `   Stake total: $${totalStake.toFixed(2)} → Atual: $${basketCurrTotal.toFixed(2)} (${s}$${Math.abs(basketDiff).toFixed(2)}, ${s}${Math.abs(basketPct).toFixed(1)}%) | Aberta há ${relativeTime(placed_at)}`;
        } else {
          text += `   Stake total: $${totalStake.toFixed(2)} | Aberta há ${relativeTime(placed_at)}`;
        }
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
    const outcomLines = sorted.map(([outcome, n]) => `• ${outcome}: ${n}`).join('\n');

    // Aggregate PnL footer
    const totalStakeAll = legs.reduce((s, l) => s + l.stake_usd, 0);
    let totalCurrAll = 0;
    let stakeWithSnap = 0;
    for (const leg of legs) {
      const midPrice = midPrices.get(leg.id) ?? null;
      if (midPrice !== null) {
        const shares = leg.shares ?? (leg.stake_usd / leg.entry_price);
        totalCurrAll += shares * midPrice;
        stakeWithSnap += leg.stake_usd;
      }
    }

    let footerText = `📊 Total: ${totalLegs} legs abertas\n${outcomLines}`;
    if (stakeWithSnap > 0) {
      const totalDiff = totalCurrAll - stakeWithSnap;
      const totalPct = (totalDiff / stakeWithSnap) * 100;
      const s = totalDiff >= 0 ? '+' : '-';
      footerText += `\n\n💰 Stake total: $${totalStakeAll.toFixed(2)} → Atual: $${totalCurrAll.toFixed(2)} (${s}$${Math.abs(totalDiff).toFixed(2)}, ${s}${Math.abs(totalPct).toFixed(1)}%)`;
    } else {
      footerText += `\n\n💰 Stake total: $${totalStakeAll.toFixed(2)}`;
    }
    await ctx.reply(footerText);
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
        'Valor total recebido em USD (ex: 4.32) ou "resolved" se resolveu:'
      );
      const inputCtx = await conversation.waitFor('message:text');
      const inputRaw = inputCtx.message.text.trim();

      const shares = legShares(leg);
      let saleValue: number | null = null;
      let closingPrice: number | null = null;
      let resolutionPrice: number | null = null;

      if (inputRaw.toLowerCase() !== 'resolved') {
        saleValue = parseFloat(inputRaw);
        const maxSale = shares * 1.001;
        if (isNaN(saleValue) || saleValue <= 0 || saleValue > maxSale) {
          await ctx.reply(`Valor inválido. Deve ser positivo em USD (máx. $${maxSale.toFixed(2)}). Operação cancelada.`);
          return;
        }
        closingPrice = saleValue / shares;
      }

      await ctx.reply('Resultado?', { reply_markup: RESULT_KBD });
      const resCtx = await conversation.waitFor('callback_query:data');
      await resCtx.answerCallbackQuery();
      const result = resCtx.callbackQuery.data.replace('res:', '');

      if (result === 'win') resolutionPrice = saleValue === null ? 1.0 : null;
      if (result === 'loss') resolutionPrice = saleValue === null ? 0.0 : null;

      let pnlUsd: number;
      if (saleValue !== null) {
        pnlUsd = saleValue - leg.stake_usd;
      } else if (result === 'win') {
        pnlUsd = (1.0 - leg.entry_price) * shares;
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

      if (saleValue !== null) {
        await adjustCash(saleValue);
      } else if (result !== 'void') {
        await adjustCash(shares * (resolutionPrice ?? 0));
      }

      const sign = pnlUsd >= 0 ? '+' : '';
      if (saleValue !== null) {
        await ctx.reply(
          `✅ Posição fechada.\nRecebido: $${saleValue.toFixed(2)}\nPnL: ${sign}$${pnlUsd.toFixed(2)} (stake $${leg.stake_usd.toFixed(2)})`,
        );
      } else {
        await ctx.reply(`✅ Posição fechada. PnL: \`${sign}$${pnlUsd.toFixed(2)}\``, { parse_mode: 'Markdown' });
      }

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

          await adjustCash(resPrice * shares);
        }

        await supabase.from('my_bets').update({ closed_at: nowIso }).eq('id', betId);

        const sign = totalPnl >= 0 ? '+' : '';
        await ctx.reply(
          `✅ Basket fechada. PnL total: \`${sign}$${totalPnl.toFixed(2)}\`\n` +
          `Leg vencedora: ${legLabel(winnerLeg)}, lucro \`+$${winnerPnl.toFixed(2)}\`\n` +
          `Outras ${legs.length - 1} legs: prejuízo total \`$${losersPnl.toFixed(2)}\``,
          { parse_mode: 'Markdown' },
        );

      } else if (choice === 'basket:manual') {
        const legResults: { label: string; pnl: number; result: string; saleVal: number | null }[] = [];

        for (let i = 0; i < legs.length; i++) {
          const leg = legs[i]!;
          const label = legLabel(leg);
          const shares = legShares(leg);

          await ctx.reply(
            `Leg ${i + 1}/${legs.length}: ${label}\n` +
            `Stake: $${leg.stake_usd.toFixed(2)} @ ${leg.entry_price}, ${shares.toFixed(1)} shares\n` +
            `Valor recebido em USD (ex: 4.32) ou 'win' / 'loss' / 'anulado':`
          );
          const inputCtx = await conversation.waitFor('message:text');
          const raw = inputCtx.message.text.trim().toLowerCase();

          let result: string;
          let closingPrice: number | null = null;
          let resolutionPrice: number | null = null;
          let pnlUsd: number;
          let legSaleVal: number | null = null;

          if (raw === 'win') {
            result = 'win'; resolutionPrice = 1.0;
            pnlUsd = (1.0 - leg.entry_price) * shares;
          } else if (raw === 'loss') {
            result = 'loss'; resolutionPrice = 0.0;
            pnlUsd = -leg.stake_usd;
          } else if (raw === 'anulado') {
            result = 'void'; pnlUsd = 0;
          } else {
            const saleVal = parseFloat(raw);
            const maxSale = shares * 1.001;
            if (isNaN(saleVal) || saleVal <= 0 || saleVal > maxSale) {
              await ctx.reply(`Valor inválido na leg ${i + 1}. Deve ser positivo (máx. $${maxSale.toFixed(2)}). Encerrando fluxo.`);
              break;
            }
            closingPrice = saleVal / shares;
            pnlUsd = saleVal - leg.stake_usd;
            result = pnlUsd > 0 ? 'win' : pnlUsd < 0 ? 'loss' : 'void';
            legSaleVal = saleVal;
          }

          await supabase.from('my_bet_legs').update({
            closing_price: closingPrice,
            resolution_price: resolutionPrice,
            result,
            pnl_usd: pnlUsd,
            closed_at: nowIso,
          }).eq('id', leg.id);

          if (legSaleVal !== null) {
            await adjustCash(legSaleVal);
          } else if (result !== 'void') {
            await adjustCash(shares * (resolutionPrice ?? 0));
          }

          legResults.push({ label, pnl: pnlUsd, result, saleVal: legSaleVal });
        }

        await supabase.from('my_bets').update({ closed_at: nowIso }).eq('id', betId);

        const totalPnl = legResults.reduce((s, r) => s + r.pnl, 0);
        const sign = totalPnl >= 0 ? '+' : '';
        let reply = `✅ Basket fechada. PnL total: \`${sign}$${totalPnl.toFixed(2)}\`\n`;
        for (const r of legResults) {
          const s = r.pnl >= 0 ? '+' : '';
          if (r.saleVal !== null) {
            reply += `• ${r.label}: Recebido $${r.saleVal.toFixed(2)} · PnL ${s}$${r.pnl.toFixed(2)}\n`;
          } else {
            reply += `• ${r.label}: \`${s}$${r.pnl.toFixed(2)}\` (${r.result})\n`;
          }
        }
        await ctx.reply(reply, { parse_mode: 'Markdown' });
      }
    }
  } catch (err) {
    await logEvent({ component: 'telegram_bot', status: 'error', message: `closePositionConversation error: ${String(err)}` });
    await ctx.reply('Erro interno. Tenta de novo em alguns segundos.');
  }
}
