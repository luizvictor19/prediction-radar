import { InlineKeyboard } from 'grammy';
import type { BotContext, BotConversation } from '../index.js';
import { supabase } from '../../lib/supabase.js';
import { getSystemConfig } from '../../lib/config.js';
import { logEvent } from '../../lib/logger.js';
import { calcStake, getStakeCap } from '../format.js';
import { calcCalendarDrivenStake } from '../../lib/format-helpers.js';
import type { CrossMarketInterSignalMetadata, CrossMarketInterMember } from '../../types/index.js';

const SIM_NAO_KBD = new InlineKeyboard().text('Sim', 'sim').text('Não', 'nao');

function domainConfidence(category: string | null): number {
  if (!category) return 6;
  if (category.toLowerCase().includes('tech') || category.toLowerCase().includes('ai')) return 9;
  if (category.toLowerCase().includes('sport')) return 5;
  return 6;
}

function shortTitle(title: string, maxLen = 35): string {
  const clean = title.replace(/\?$/, '').trim();
  return clean.length <= maxLen ? clean : clean.slice(0, maxLen - 1) + '…';
}

async function waitConfirm(conversation: BotConversation, ctx: BotContext, text: string): Promise<boolean> {
  await ctx.reply(text, { parse_mode: 'Markdown', reply_markup: SIM_NAO_KBD });
  const btnCtx = await conversation.waitFor('callback_query:data');
  await btnCtx.answerCallbackQuery();
  return btnCtx.callbackQuery.data === 'sim';
}

type SystemConfig = Awaited<ReturnType<typeof getSystemConfig>>;

async function singleLegTrack(
  conversation: BotConversation,
  ctx: BotContext,
  signal: Record<string, unknown>,
  signalId: string,
  forcedOutcome: string | undefined,
  config: SystemConfig,
): Promise<void> {
  const stakeCap = getStakeCap(config, signal['signal_type'] as string);

  let suggestedStake: number;
  if (signal['signal_type'] === 'calendar_driven') {
    const confidence = (signal['confidence_score'] as number) ?? 0.5;
    suggestedStake = calcCalendarDrivenStake(config.bankroll_usd, stakeCap, confidence);
  } else {
    const meta = ((signal['metadata'] as Record<string, unknown>) ?? {}) as Partial<CrossMarketInterSignalMetadata>;
    const edgePct = meta.expected_edge_pct ?? 0;
    suggestedStake = calcStake(config.bankroll_usd, stakeCap, edgePct);
  }

  const stakeLabel =
    suggestedStake < 1.0
      ? `$${suggestedStake.toFixed(2)} (abaixo do mín. Polymarket $1)`
      : `$${suggestedStake.toFixed(2)}`;

  // Step 1: stake
  await ctx.reply(`Stake em USD? (sugerido: ${stakeLabel})\nDigite um valor ou "ok" para usar o sugerido.`);
  const stakeCtx = await conversation.waitFor('message:text');
  const stakeRaw = stakeCtx.message.text.trim().toLowerCase();
  const stakeUsd = stakeRaw === 'ok' ? suggestedStake : parseFloat(stakeRaw);
  if (isNaN(stakeUsd) || stakeUsd <= 0) {
    await ctx.reply('Valor inválido. Operação cancelada.');
    return;
  }

  // Step 2: entry price
  await ctx.reply('Preço de entrada (Yes price, ex.: 0.045)?');
  const priceCtx = await conversation.waitFor('message:text');
  const entryPrice = parseFloat(priceCtx.message.text.trim());
  if (isNaN(entryPrice) || entryPrice <= 0 || entryPrice >= 1) {
    await ctx.reply('Preço inválido (deve ser entre 0 e 1). Operação cancelada.');
    return;
  }

  // Step 3: confidence (optional)
  await ctx.reply('Confiança própria 1-10? (opcional, skip para pular)');
  const confCtx = await conversation.waitFor('message:text');
  const confRaw = confCtx.message.text.trim();
  let confidenceSelf: number | null = null;
  if (confRaw !== 'skip') {
    const parsed = parseInt(confRaw, 10);
    if (!isNaN(parsed) && parsed >= 1 && parsed <= 10) confidenceSelf = parsed;
  }

  // Step 4: thesis (optional)
  await ctx.reply('Tese curta? (1-3 frases, ou skip)');
  const thesisCtx = await conversation.waitFor('message:text');
  const thesisRaw = thesisCtx.message.text.trim();
  const thesis = thesisRaw === 'skip' ? null : thesisRaw;

  // Step 5: confirmation
  const resolvedOutcome = forcedOutcome ?? (signal['suggested_outcome'] as string | null);
  const shares = stakeUsd / entryPrice;
  const summary =
    `*Confirmar operação:*\n` +
    `Outcome: \`${resolvedOutcome ?? '?'}\`\n` +
    `Stake: \`$${stakeUsd.toFixed(2)}\`\n` +
    `Preço entrada: \`${entryPrice}\`\n` +
    `Shares: \`${shares.toFixed(4)}\`\n` +
    (confidenceSelf !== null ? `Confiança: \`${confidenceSelf}/10\`\n` : '') +
    (thesis ? `Tese: ${thesis}\n` : '');

  const confirmed = await waitConfirm(conversation, ctx, summary);
  if (!confirmed) {
    await ctx.reply('Operação cancelada.');
    return;
  }

  const category =
    ((signal['metadata'] as Record<string, unknown>) ?? {})['polymarket_category'] as string | null ?? null;

  const { data: bet, error: betErr } = await supabase
    .from('my_bets')
    .insert({
      signal_id: signalId,
      event_id: signal['event_id'] ?? null,
      thesis: thesis ?? null,
      thesis_type: signal['signal_type'],
      confidence_self: confidenceSelf,
      domain_confidence: domainConfidence(category),
      polymarket_category: category,
      placed_at: new Date().toISOString(),
    })
    .select('id')
    .single();

  if (betErr || !bet) {
    await logEvent({ component: 'telegram_bot', status: 'error', message: `my_bets insert failed: ${betErr?.message ?? 'no data'}` });
    await ctx.reply('Erro ao registrar operação. Tenta de novo.');
    return;
  }

  const { error: legErr } = await supabase.from('my_bet_legs').insert({
    bet_id: bet.id,
    event_id: signal['event_id'] ?? null,
    outcome: resolvedOutcome,
    entry_price: entryPrice,
    stake_usd: stakeUsd,
    shares,
  });

  if (legErr) {
    await supabase.from('my_bets').delete().eq('id', bet.id);
    await logEvent({ component: 'telegram_bot', status: 'error', message: `my_bet_legs insert failed: ${legErr.message}` });
    await ctx.reply('Erro ao registrar operação. Tenta de novo.');
    return;
  }

  await supabase.from('detected_signals').update({ acted_on: true }).eq('id', signalId);

  await ctx.reply(
    `✅ Operação registrada. ID: \`${bet.id}\`. Stake \`$${stakeUsd.toFixed(2)}\` em \`${resolvedOutcome ?? '?'}\` a \`${entryPrice}\`.`,
    { parse_mode: 'Markdown' },
  );
}

async function basketTrack(
  conversation: BotConversation,
  ctx: BotContext,
  signal: Record<string, unknown>,
  signalId: string,
  config: SystemConfig,
): Promise<void> {
  const meta = ((signal['metadata'] as Record<string, unknown>) ?? {}) as Partial<CrossMarketInterSignalMetadata>;
  const stakeCap = getStakeCap(config, signal['signal_type'] as string);
  const edgePct = meta.expected_edge_pct ?? 0;
  const suggestedStake = calcStake(config.bankroll_usd, stakeCap, edgePct);
  const stakeLabel =
    suggestedStake < 1.0
      ? `$${suggestedStake.toFixed(2)} (abaixo do mín. Polymarket $1)`
      : `$${suggestedStake.toFixed(2)}`;

  // Step 1: stake total
  await ctx.reply(`Stake total da basket em USD? (sugerido: ${stakeLabel})\nDigite um valor ou "ok" para usar o sugerido.`);
  const stakeCtx = await conversation.waitFor('message:text');
  const stakeRaw = stakeCtx.message.text.trim().toLowerCase();
  const stakeTotal = stakeRaw === 'ok' ? suggestedStake : parseFloat(stakeRaw);
  if (isNaN(stakeTotal) || stakeTotal <= 0) {
    await ctx.reply('Valor inválido. Operação cancelada.');
    return;
  }

  // Compute legs
  const direction = meta.direction ?? 'under';
  const members = (meta.members ?? []) as CrossMarketInterMember[];
  const priceSum = meta.price_sum ?? 0;
  const groupSize = meta.group_size ?? members.length;

  type ComputedLeg = {
    event_id: string;
    title: string;
    outcome: 'Yes' | 'No';
    entry_price: number;
    stake_usd: number;
    shares: number;
  };

  let sharesPerLeg: number;
  let computedLegs: ComputedLeg[];

  if (direction === 'under') {
    // Buy Yes in all: shares_per_leg = stake_total / price_sum_yes
    sharesPerLeg = priceSum > 0 ? stakeTotal / priceSum : 0;
    computedLegs = members.map(m => ({
      event_id: m.event_id,
      title: m.title,
      outcome: 'Yes' as const,
      entry_price: m.yes_price,
      stake_usd: sharesPerLeg * m.yes_price,
      shares: sharesPerLeg,
    }));
  } else {
    // Buy No in all: shares_per_leg = stake_total / price_sum_no
    const priceSumNo = groupSize - priceSum;
    sharesPerLeg = priceSumNo > 0 ? stakeTotal / priceSumNo : 0;
    computedLegs = members.map(m => {
      const noPrice = 1 - m.yes_price;
      return {
        event_id: m.event_id,
        title: m.title,
        outcome: 'No' as const,
        entry_price: noPrice,
        stake_usd: sharesPerLeg * noPrice,
        shares: sharesPerLeg,
      };
    });
  }

  const actualTotal = computedLegs.reduce((s, l) => s + l.stake_usd, 0);

  // Build execution list message
  let execMsg = '';
  if (direction === 'under') {
    execMsg +=
      '⚠️ Atenção: basket under pode conter cenário \'cancelamento/nenhum vence\' não precificado. ' +
      'Verifica no Polymarket se a soma cobre todos os outcomes possíveis.\n\n';
  }
  execMsg += 'Pra executar:\n';
  for (const leg of computedLegs) {
    execMsg +=
      `• ${shortTitle(leg.title)}: $${leg.stake_usd.toFixed(2)} → ${leg.shares.toFixed(2)} shares @ ${leg.entry_price.toFixed(2)}\n`;
  }
  execMsg += `Total: $${actualTotal.toFixed(2)} | Shares por leg: ${sharesPerLeg.toFixed(2)}`;

  await ctx.reply(execMsg);

  // Step 2: thesis (optional)
  await ctx.reply('Tese curta? (1-3 frases, ou skip)');
  const thesisCtx = await conversation.waitFor('message:text');
  const thesisRaw = thesisCtx.message.text.trim();
  const thesis = thesisRaw === 'skip' ? null : thesisRaw;

  // Step 3: confirmation
  const summary =
    `*Confirmar basket (${computedLegs.length} legs):*\n` +
    `Stake total: \`$${actualTotal.toFixed(2)}\` | Direction: \`${direction}\`\n` +
    (thesis ? `Tese: ${thesis}\n` : '');

  const confirmed = await waitConfirm(conversation, ctx, summary);
  if (!confirmed) {
    await ctx.reply('Operação cancelada.');
    return;
  }

  const category = meta.polymarket_category ?? null;

  const { data: bet, error: betErr } = await supabase
    .from('my_bets')
    .insert({
      signal_id: signalId,
      event_id: null,
      thesis: thesis ?? null,
      thesis_type: signal['signal_type'],
      confidence_self: null,
      domain_confidence: domainConfidence(category),
      polymarket_category: category,
      placed_at: new Date().toISOString(),
    })
    .select('id')
    .single();

  if (betErr || !bet) {
    await logEvent({ component: 'telegram_bot', status: 'error', message: `my_bets insert failed: ${betErr?.message ?? 'no data'}` });
    await ctx.reply('Erro ao registrar operação. Tenta de novo.');
    return;
  }

  try {
    for (const leg of computedLegs) {
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
    await logEvent({ component: 'telegram_bot', status: 'error', message: `my_bet_legs insert failed: ${String(err)}` });
    await ctx.reply('Erro ao registrar operação. Tenta de novo.');
    return;
  }

  await supabase.from('detected_signals').update({ acted_on: true }).eq('id', signalId);

  await ctx.reply(
    `✅ Basket registrada. ID: \`${bet.id}\`. ${computedLegs.length} legs, stake total \`$${actualTotal.toFixed(2)}\`.`,
    { parse_mode: 'Markdown' },
  );
}

export async function trackConversation(
  conversation: BotConversation,
  ctx: BotContext,
  signalIdWithOutcome: string,
): Promise<void> {
  try {
    const colonIndex = signalIdWithOutcome.indexOf(':');
    const signalId = colonIndex === -1 ? signalIdWithOutcome : signalIdWithOutcome.slice(0, colonIndex);
    const forcedOutcome: string | undefined = colonIndex === -1 ? undefined : (signalIdWithOutcome.slice(colonIndex + 1) || undefined);
    const config = await getSystemConfig();

    const { data: signal, error: sigErr } = await supabase
      .from('detected_signals')
      .select('*')
      .eq('id', signalId)
      .single();

    if (sigErr || !signal) {
      await ctx.reply('Sinal não encontrado.');
      return;
    }

    if (signal.signal_type === 'cross_market_inter') {
      await basketTrack(conversation, ctx, signal as Record<string, unknown>, signalId, config);
    } else {
      await singleLegTrack(conversation, ctx, signal as Record<string, unknown>, signalId, forcedOutcome, config);
    }
  } catch (err) {
    await logEvent({ component: 'telegram_bot', status: 'error', message: `trackConversation error: ${String(err)}` });
    await ctx.reply('Erro interno. Tenta de novo em alguns segundos.');
  }
}
