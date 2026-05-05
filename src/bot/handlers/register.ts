import { InlineKeyboard } from 'grammy';
import type { BotContext, BotConversation } from '../index.js';
import { supabase } from '../../lib/supabase.js';
import { logEvent } from '../../lib/logger.js';
import { normalizeOutcome } from '../../lib/outcome-normalizer.js';

const SIM_NAO_KBD = new InlineKeyboard().text('Sim', 'sim').text('Não', 'nao');

const LEGS_KBD = new InlineKeyboard().text('1', 'legs:1').text('2+', 'legs:multi');

const CATEGORY_KBD = new InlineKeyboard()
  .text('Esportes', 'cat:Esportes')
  .text('Política', 'cat:Política')
  .text('Cripto', 'cat:Cripto')
  .text('Tech', 'cat:Tech')
  .row()
  .text('Cultura', 'cat:Cultura')
  .text('Economia', 'cat:Economia')
  .text('Finanças', 'cat:Finanças')
  .text('Outro', 'cat:Outro');

const CATEGORY_MAP: Record<string, string | null> = {
  Esportes: 'sports_fees_v2',
  Política: 'politics_fees',
  Cripto: 'crypto_fees_v2',
  Tech: 'tech_fees',
  Cultura: 'culture_fees',
  Economia: 'economics_fees',
  Finanças: 'finance_prices_fees',
  Outro: null,
};

const CATEGORY_LABEL: Record<string, string> = {
  sports_fees_v2: 'Esportes',
  politics_fees: 'Política',
  crypto_fees_v2: 'Cripto',
  tech_fees: 'Tech',
  culture_fees: 'Cultura',
  economics_fees: 'Economia',
  finance_prices_fees: 'Finanças',
};

interface EventMatch {
  id: string;
  title: string;
  polymarket_category: string | null;
  end_date: string | null;
}

function buildMatchButtonLabel(match: EventMatch): string {
  const titleStr = match.title.length > 55 ? match.title.slice(0, 55) + '…' : match.title;
  if (!match.end_date) return titleStr;
  const d = new Date(match.end_date);
  const dateStr = `${String(d.getUTCMonth() + 1).padStart(2, '0')}/${String(d.getUTCDate()).padStart(2, '0')}`;
  return `${titleStr} · ${dateStr}`;
}

async function findMatchingEvents(searchText: string): Promise<EventMatch[]> {
  if (searchText.trim().length < 3) return [];

  const { data, error } = await supabase.rpc('search_events_by_title', {
    query_text: searchText.trim(),
    similarity_threshold: 0.15,
  });

  if (error) {
    await logEvent({
      component: 'bot_command',
      status: 'error',
      message: `Event match (trigram) query failed: ${error.message}`,
      metadata: { search_text: searchText, error: error.message },
    });
    return [];
  }

  return (data ?? []) as EventMatch[];
}

async function findActiveSignalForEvent(eventId: string): Promise<string | null> {
  const { data } = await supabase
    .from('detected_signals')
    .select('id')
    .eq('event_id', eventId)
    .eq('dismissed', false)
    .eq('acted_on', false)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  return data?.id ?? null;
}

async function waitConfirm(conversation: BotConversation, ctx: BotContext, text: string): Promise<boolean> {
  await ctx.reply(text, { parse_mode: 'Markdown', reply_markup: SIM_NAO_KBD });
  const btnCtx = await conversation.waitFor('callback_query:data');
  await btnCtx.answerCallbackQuery();
  return btnCtx.callbackQuery.data === 'sim';
}

async function askCategory(conversation: BotConversation, ctx: BotContext): Promise<string | null> {
  await ctx.reply('Categoria:', { reply_markup: CATEGORY_KBD });
  const btnCtx = await conversation.waitFor('callback_query:data');
  await btnCtx.answerCallbackQuery();
  const label = btnCtx.callbackQuery.data.replace('cat:', '');
  return CATEGORY_MAP[label] ?? null;
}

function catLabel(category: string | null): string {
  if (!category) return 'Outro';
  return CATEGORY_LABEL[category] ?? category;
}

async function registerSingleLeg(conversation: BotConversation, ctx: BotContext): Promise<void> {
  // a. Título
  await ctx.reply('Título do evento (ex: "Chelsea vs Forest O/U 2.5"):');
  const titleCtx = await conversation.waitFor('message:text');
  const eventTitle = titleCtx.message.text.trim();

  // a.1. Event match
  let eventIdMatch: string | null = null;
  let signalIdMatch: string | null = null;
  let matchedCategory: string | null = null;
  let matchedTitle: string | null = null;

  const matches = await findMatchingEvents(eventTitle);

  if (matches.length === 1) {
    const match = matches[0]!;
    eventIdMatch = match.id;
    matchedCategory = match.polymarket_category;
    matchedTitle = match.title;
    signalIdMatch = await findActiveSignalForEvent(match.id);
    const catDisplay = match.polymarket_category ? catLabel(match.polymarket_category) : 'sem categoria';
    await ctx.reply(`✅ Evento encontrado: ${match.title}\nCategoria: ${catDisplay}`);
  } else if (matches.length >= 2) {
    const kbd = new InlineKeyboard();
    for (const m of matches) {
      kbd.text(buildMatchButtonLabel(m), `match_event:${m.id}`).row();
    }
    kbd.text('Nenhum, registrar manualmente', 'match_event:none');

    await ctx.reply(`Encontrei ${matches.length} eventos parecidos. Qual?`, { reply_markup: kbd });
    const choiceCtx = await conversation.waitFor('callback_query:data');
    await choiceCtx.answerCallbackQuery();
    const chosen = choiceCtx.callbackQuery.data;

    if (chosen !== 'match_event:none') {
      const chosenId = chosen.replace('match_event:', '');
      const chosenMatch = matches.find(m => m.id === chosenId) ?? null;
      if (chosenMatch) {
        eventIdMatch = chosenMatch.id;
        matchedCategory = chosenMatch.polymarket_category;
        matchedTitle = chosenMatch.title;
        signalIdMatch = await findActiveSignalForEvent(chosenMatch.id);
        const catDisplay = chosenMatch.polymarket_category ? catLabel(chosenMatch.polymarket_category) : 'sem categoria';
        await ctx.reply(`✅ Evento encontrado: ${chosenMatch.title}\nCategoria: ${catDisplay}`);
      }
    }
  }

  // b. Categoria (pula se match já forneceu)
  let category: string | null;
  if (eventIdMatch !== null) {
    category = matchedCategory;
  } else {
    category = await askCategory(conversation, ctx);
  }

  // c. Outcome
  await ctx.reply('Outcome (ex: Yes, No, Over 2.5):');
  const outcomeCtx = await conversation.waitFor('message:text');
  const rawOutcome = outcomeCtx.message.text.trim();
  if (!rawOutcome) {
    await ctx.reply('Outcome inválido. Operação cancelada.');
    return;
  }

  let outcome: string;
  if (eventIdMatch) {
    const norm = await normalizeOutcome(eventIdMatch, rawOutcome);
    if (!norm.ok) {
      await ctx.reply(
        `Outcome não encontrado.\nDisponíveis: ${norm.available.join(', ')}`,
      );
      return;
    }
    outcome = norm.outcome;
  } else {
    outcome = rawOutcome;
  }

  // d. Stake
  await ctx.reply('Stake em USD:');
  const stakeCtx = await conversation.waitFor('message:text');
  const stakeUsd = parseFloat(stakeCtx.message.text.trim());
  if (isNaN(stakeUsd) || stakeUsd <= 0) {
    await ctx.reply('Valor inválido. Operação cancelada.');
    return;
  }

  // e. To win
  await ctx.reply('Valor a receber se ganhar (em USD):\nEx: 6.88 (vem do Polymarket no campo "to win")');
  const priceCtx = await conversation.waitFor('message:text');
  const toWin = parseFloat(priceCtx.message.text.trim());
  if (isNaN(toWin) || toWin <= 0) {
    await ctx.reply('Valor inválido. Operação cancelada.');
    return;
  }
  const entryPrice = stakeUsd / toWin;
  if (entryPrice <= 0 || entryPrice > 1) {
    await ctx.reply(`Preço calculado inválido (${entryPrice.toFixed(4)}). Verifique stake e to win. Operação cancelada.`);
    return;
  }

  // f. Confiança
  await ctx.reply('Confiança 1-10 (ou skip):');
  const confCtx = await conversation.waitFor('message:text');
  const confRaw = confCtx.message.text.trim();
  let confidenceSelf: number | null = null;
  if (confRaw !== 'skip') {
    const parsed = parseInt(confRaw, 10);
    if (!isNaN(parsed) && parsed >= 1 && parsed <= 10) confidenceSelf = parsed;
  }

  // g. Tese
  await ctx.reply('Tese curta (ou skip):');
  const thesisCtx = await conversation.waitFor('message:text');
  const thesisRaw = thesisCtx.message.text.trim();
  const thesis = thesisRaw === 'skip' ? eventTitle : thesisRaw;

  // h. Resumo + confirmação
  const shares = toWin;
  const titleDisplay = matchedTitle ? `${matchedTitle} _(vinculado)_` : eventTitle;
  const summary =
    `*Confirmar?*\n` +
    `📋 ${titleDisplay}\n` +
    `Outcome: \`${outcome}\`\n` +
    `Stake: \`$${stakeUsd.toFixed(2)}\`\n` +
    `To win: \`$${toWin.toFixed(2)}\`\n` +
    `Shares: \`${shares.toFixed(1)}\`\n` +
    `Preço entrada (calc): \`${entryPrice.toFixed(4)}\`\n` +
    `Categoria: \`${catLabel(category)}\`\n` +
    (confidenceSelf !== null ? `Confiança: \`${confidenceSelf}/10\`\n` : '') +
    (thesisRaw !== 'skip' ? `Tese: ${thesis}\n` : '');

  const confirmed = await waitConfirm(conversation, ctx, summary);
  if (!confirmed) {
    await ctx.reply('Operação cancelada.');
    return;
  }

  // i. Inserir
  const { data: bet, error: betErr } = await supabase
    .from('my_bets')
    .insert({
      signal_id: signalIdMatch,
      event_id: eventIdMatch,
      thesis,
      thesis_type: 'manual',
      confidence_self: confidenceSelf,
      domain_confidence: null,
      polymarket_category: category,
      notes: null,
      placed_at: new Date().toISOString(),
    })
    .select('id')
    .single();

  if (betErr || !bet) {
    await logEvent({ component: 'telegram_bot', status: 'error', message: `register my_bets insert failed: ${betErr?.message ?? 'no data'}` });
    await ctx.reply('Erro ao registrar. Tenta de novo.');
    return;
  }

  const { error: legErr } = await supabase.from('my_bet_legs').insert({
    bet_id: bet.id,
    event_id: eventIdMatch,
    outcome,
    entry_price: entryPrice,
    stake_usd: stakeUsd,
    shares,
  });

  if (legErr) {
    await supabase.from('my_bets').delete().eq('id', bet.id);
    await logEvent({ component: 'telegram_bot', status: 'error', message: `register my_bet_legs insert failed: ${legErr.message}` });
    await ctx.reply('Erro ao registrar. Tenta de novo.');
    return;
  }

  // Marcar sinal como acted_on se houve match
  if (signalIdMatch) {
    await supabase
      .from('detected_signals')
      .update({ acted_on: true })
      .eq('id', signalIdMatch);

    await logEvent({
      component: 'bot_command',
      status: 'success',
      message: `/register: linked manual bet to signal ${signalIdMatch}`,
      metadata: { bet_id: bet.id, signal_id: signalIdMatch, event_id: eventIdMatch },
    });
  }

  // j. Resposta
  if (signalIdMatch) {
    await ctx.reply('✅ Bet registrada e vinculada ao sinal.');
  } else if (eventIdMatch) {
    await ctx.reply('✅ Bet registrada e vinculada ao evento.');
  } else {
    await ctx.reply('✅ Bet registrada manualmente.');
  }
}

async function registerBasket(conversation: BotConversation, ctx: BotContext): Promise<void> {
  // a. Categoria
  const category = await askCategory(conversation, ctx);

  // b. Título
  await ctx.reply('Título da basket (referência):');
  const titleCtx = await conversation.waitFor('message:text');
  const basketTitle = titleCtx.message.text.trim();

  // c. Número de legs
  await ctx.reply('Quantas legs? (ex: 4):');
  const nCtx = await conversation.waitFor('message:text');
  const n = parseInt(nCtx.message.text.trim(), 10);
  if (isNaN(n) || n < 2) {
    await ctx.reply('Número inválido (mínimo 2). Operação cancelada.');
    return;
  }

  // d. Loop por N legs
  type LegInput = { outcome: string; stake_usd: number; entry_price: number; shares: number };
  const legInputs: LegInput[] = [];

  for (let i = 1; i <= n; i++) {
    await ctx.reply(`Leg ${i}/${n} — Outcome (ex: Yes, No, Over 2.5):`);
    const outCtx = await conversation.waitFor('message:text');
    const outcome = outCtx.message.text.trim();

    await ctx.reply(`Leg ${i}/${n} — Stake em USD:`);
    const stakeCtx = await conversation.waitFor('message:text');
    const stakeUsd = parseFloat(stakeCtx.message.text.trim());
    if (isNaN(stakeUsd) || stakeUsd <= 0) {
      await ctx.reply(`Stake inválido na leg ${i}. Operação cancelada.`);
      return;
    }

    await ctx.reply(`Leg ${i}/${n} — Preço de entrada (decimal, ex: 0.32):`);
    const priceCtx = await conversation.waitFor('message:text');
    const entryPrice = parseFloat(priceCtx.message.text.trim());
    if (isNaN(entryPrice) || entryPrice <= 0 || entryPrice >= 1) {
      await ctx.reply(`Preço inválido na leg ${i}. Operação cancelada.`);
      return;
    }

    legInputs.push({ outcome, stake_usd: stakeUsd, entry_price: entryPrice, shares: stakeUsd / entryPrice });
  }

  // e. Tese
  await ctx.reply('Tese curta (ou skip):');
  const thesisCtx = await conversation.waitFor('message:text');
  const thesisRaw = thesisCtx.message.text.trim();
  const thesis = thesisRaw === 'skip' ? basketTitle : thesisRaw;

  // f. Resumo + confirmação
  const totalStake = legInputs.reduce((s, l) => s + l.stake_usd, 0);
  let summary = `*Confirmar basket (${n} legs)?*\n${basketTitle}\n`;
  for (let i = 0; i < legInputs.length; i++) {
    const l = legInputs[i]!;
    summary += `  • Leg ${i + 1}: \`${l.outcome}\` — \`$${l.stake_usd.toFixed(2)}\` @ \`${l.entry_price}\` (${l.shares.toFixed(4)} shares)\n`;
  }
  summary += `Stake total: \`$${totalStake.toFixed(2)}\`\n`;
  summary += `Categoria: \`${catLabel(category)}\`\n`;
  if (thesisRaw !== 'skip') summary += `Tese: ${thesis}\n`;

  const confirmed = await waitConfirm(conversation, ctx, summary);
  if (!confirmed) {
    await ctx.reply('Operação cancelada.');
    return;
  }

  // g. Inserir
  const { data: bet, error: betErr } = await supabase
    .from('my_bets')
    .insert({
      signal_id: null,
      event_id: null,
      thesis,
      thesis_type: 'manual',
      confidence_self: null,
      domain_confidence: null,
      polymarket_category: category,
      notes: null,
      placed_at: new Date().toISOString(),
    })
    .select('id')
    .single();

  if (betErr || !bet) {
    await logEvent({ component: 'telegram_bot', status: 'error', message: `register basket my_bets insert failed: ${betErr?.message ?? 'no data'}` });
    await ctx.reply('Erro ao registrar. Tenta de novo.');
    return;
  }

  try {
    for (const leg of legInputs) {
      const { error: legErr } = await supabase.from('my_bet_legs').insert({
        bet_id: bet.id,
        event_id: null,
        outcome: leg.outcome,
        entry_price: leg.entry_price,
        stake_usd: leg.stake_usd,
        shares: leg.shares,
      });
      if (legErr) throw legErr;
    }
  } catch (err) {
    await supabase.from('my_bets').delete().eq('id', bet.id);
    await logEvent({ component: 'telegram_bot', status: 'error', message: `register basket my_bet_legs insert failed: ${String(err)}` });
    await ctx.reply('Erro ao registrar. Tenta de novo.');
    return;
  }

  // h. Resposta
  await ctx.reply(`✅ Basket registrada com ${n} legs.`);
}

export async function registerConversation(
  conversation: BotConversation,
  ctx: BotContext,
): Promise<void> {
  try {
    await ctx.reply('Registrar bet feita fora do bot.\nQuantas legs?', { reply_markup: LEGS_KBD });
    const btnCtx = await conversation.waitFor('callback_query:data');
    await btnCtx.answerCallbackQuery();

    if (btnCtx.callbackQuery.data === 'legs:1') {
      await registerSingleLeg(conversation, ctx);
    } else {
      await registerBasket(conversation, ctx);
    }
  } catch (err) {
    await logEvent({ component: 'telegram_bot', status: 'error', message: `registerConversation error: ${String(err)}` });
    await ctx.reply('Erro interno. Tenta de novo em alguns segundos.');
  }
}

export async function registerHandler(ctx: BotContext): Promise<void> {
  await ctx.conversation.enter('register');
}
