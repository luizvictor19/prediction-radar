import type { BotContext, BotConversation } from '../index.js';
import { supabase } from '../../lib/supabase.js';
import { getSystemConfig } from '../../lib/config.js';
import { logEvent } from '../../lib/logger.js';
import { calcStake, getStakeCap } from '../format.js';
import type { CrossMarketInterSignalMetadata } from '../../types/index.js';

function domainConfidence(category: string | null): number {
  if (!category) return 6;
  if (category.toLowerCase().includes('tech') || category.toLowerCase().includes('ai')) return 9;
  if (category.toLowerCase().includes('sport')) return 5;
  return 6;
}

export async function trackConversation(
  conversation: BotConversation,
  ctx: BotContext,
  signalIdWithOutcome: string,
): Promise<void> {
  try {
    // signalIdWithOutcome may be "uuid" or "uuid:yes"/"uuid:no" for calendar_driven
    const [signalId, forcedOutcome] = signalIdWithOutcome.split(':') as [string, string | undefined];

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

    const meta = (signal.metadata ?? {}) as Partial<CrossMarketInterSignalMetadata>;
    const edgePct = meta.expected_edge_pct ?? 0;
    const stakeCap = getStakeCap(config, signal.signal_type as string);
    const suggestedStake = calcStake(config.bankroll_usd, stakeCap, edgePct);
    const isMinimum = suggestedStake <= 0.5 && config.bankroll_usd * Math.min(stakeCap, edgePct / 200) < 0.5;
    const stakeLabel = isMinimum ? '$0.50 (mínimo)' : `$${suggestedStake.toFixed(2)}`;

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
    await ctx.reply('Confiança própria 1-10? (opcional, /skip para pular)');
    const confCtx = await conversation.waitFor('message:text');
    const confRaw = confCtx.message.text.trim();
    let confidenceSelf: number | null = null;
    if (confRaw !== '/skip') {
      const parsed = parseInt(confRaw, 10);
      if (!isNaN(parsed) && parsed >= 1 && parsed <= 10) confidenceSelf = parsed;
    }

    // Step 4: thesis (optional)
    await ctx.reply('Tese curta? (1-3 frases, ou /skip)');
    const thesisCtx = await conversation.waitFor('message:text');
    const thesisRaw = thesisCtx.message.text.trim();
    const thesis = thesisRaw === '/skip' ? null : thesisRaw;

    // Step 5: confirmation
    const resolvedOutcome = forcedOutcome ?? signal.suggested_outcome;
    const shares = stakeUsd / entryPrice;
    const summary =
      `*Confirmar operação:*\n` +
      `Outcome: \`${resolvedOutcome ?? '?'}\`\n` +
      `Stake: \`$${stakeUsd.toFixed(2)}\`\n` +
      `Preço entrada: \`${entryPrice}\`\n` +
      `Shares: \`${shares.toFixed(4)}\`\n` +
      (confidenceSelf !== null ? `Confiança: \`${confidenceSelf}/10\`\n` : '') +
      (thesis ? `Tese: ${thesis}\n` : '');

    await ctx.reply(summary + '\nResponda "sim" para confirmar ou "não" para cancelar.', {
      parse_mode: 'Markdown',
    });

    const confirmCtx = await conversation.waitFor('message:text');
    const confirmRaw = confirmCtx.message.text.trim().toLowerCase();
    if (confirmRaw !== 'sim' && confirmRaw !== 's') {
      await ctx.reply('Operação cancelada.');
      return;
    }

    const category = meta.polymarket_category ?? null;

    const { data: bet, error: betErr } = await supabase
      .from('my_bets')
      .insert({
        signal_id: signalId,
        event_id: signal.event_id ?? null,
        outcome: resolvedOutcome,
        entry_price: entryPrice,
        stake_usd: stakeUsd,
        shares,
        thesis: thesis ?? null,
        thesis_type: signal.signal_type,
        confidence_self: confidenceSelf,
        domain_confidence: domainConfidence(category),
        polymarket_category: category,
        placed_at: new Date().toISOString(),
        external_id: null,
      })
      .select('id')
      .single();

    if (betErr || !bet) {
      await logEvent({ component: 'telegram_bot', status: 'error', message: `my_bets insert failed: ${betErr?.message ?? 'no data'}` });
      await ctx.reply('Erro ao registrar operação. Tenta de novo.');
      return;
    }

    await supabase.from('detected_signals').update({ acted_on: true }).eq('id', signalId);

    await ctx.reply(
      `✅ Operação registrada. ID: \`${bet.id}\`. Stake \`$${stakeUsd.toFixed(2)}\` em \`${resolvedOutcome}\` a \`${entryPrice}\`.`,
      { parse_mode: 'Markdown' },
    );
  } catch (err) {
    await logEvent({ component: 'telegram_bot', status: 'error', message: `trackConversation error: ${String(err)}` });
    await ctx.reply('Erro interno. Tenta de novo em alguns segundos.');
  }
}
