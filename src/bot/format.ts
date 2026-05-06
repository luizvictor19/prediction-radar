import type { CrossMarketInterSignalMetadata, CrossMarketInterMember, CalendarDrivenSignalMetadata } from '../types/index.js';
import { confidenceStars, describeVolatility, truncate, calcCalendarDrivenStake, calcMinBankroll, formatSignalAge, formatTimeUntilResolution, formatEndDate } from '../lib/format-helpers.js';

export interface SignalRow {
  id: string;
  event_id: string | null;
  signal_type: string;
  suggested_outcome: string | null;
  confidence_score?: number | null;
  metadata: Record<string, unknown> | null;
  events?: { title: string; polymarket_id: string; outcomes?: any; sports_market_type?: string | null; line?: number | null } | null;
}

export interface PositionRow {
  id: string;
  event_id: string | null;
  outcome: string;
  entry_price: number;
  stake_usd: number;
  shares: number;
  placed_at: string;
  events?: { title: string } | null;
  polymarket_category: string | null;
}

export function getStakeCap(
  config: { max_stake_pct: number; cross_market_max_stake_pct: number },
  signalType: string,
): number {
  if (signalType === 'cross_market_inter' || signalType === 'cross_market_intra') {
    return config.cross_market_max_stake_pct;
  }
  return config.max_stake_pct;
}

export function calcStake(bankroll: number, maxStakePct: number, edgePct: number): number {
  const raw = bankroll * Math.min(maxStakePct, edgePct / 200);
  const rounded = Math.round(raw * 100) / 100;
  return Math.max(0.5, rounded);
}

export function stakeLabel(stake: number, isMinimum: boolean): string {
  return isMinimum ? `$0.50 (mínimo)` : `$${stake.toFixed(2)}`;
}

export function formatPricePct(price: number): string {
  if (price < 0.05) return `${(price * 100).toFixed(2)}%`;
  if (price < 0.10) return `${(price * 100).toFixed(1)}%`;
  return `${(price * 100).toFixed(0)}%`;
}

export function formatVolume(v: number): string {
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `$${(v / 1_000).toFixed(1)}k`;
  return `$${v.toFixed(0)}`;
}

const CATEGORY_EMOJI: Record<string, string> = {
  sports_fees_v2: '🏆',
  politics_fees: '🗳️',
  tech_fees: '🤖',
  culture_fees: '🎵',
  economics_fees: '📈',
  finance_prices_fees: '💹',
  crypto_fees_v2: '🪙',
  general_fees: '📊',
};

const CATEGORY_LABEL: Record<string, string> = {
  sports_fees_v2: 'Esportes',
  politics_fees: 'Política',
  tech_fees: 'Tech',
  culture_fees: 'Cultura',
  economics_fees: 'Economia',
  finance_prices_fees: 'Finanças',
  crypto_fees_v2: 'Cripto',
  general_fees: 'Geral',
};

function categoryLabel(category: string | null): string {
  return CATEGORY_LABEL[category ?? ''] ?? 'Mercados relacionados';
}

export function categoryEmoji(category: string | null): string {
  return CATEGORY_EMOJI[category ?? ''] ?? '🎯';
}

const VERB_PATTERN = /^Will (.+?) (win|have|be|reach|get|cross|hit) /i;

function extractComplement(title: string): string | null {
  const match = VERB_PATTERN.exec(title);
  if (!match) return null;
  const rest = title.slice(match[0].length).replace(/\?$/, '').trim();
  return rest || null;
}

function extractSubject(title: string): string {
  const match = VERB_PATTERN.exec(title);
  if (match?.[1]) return match[1];
  return title.split(' ')[0] ?? title;
}

export function deriveSignalTitle(members: Array<{ title: string }>): string | null {
  if (members.length === 0) return null;

  const firstComplement = extractComplement(members[0]!.title);
  if (!firstComplement) return null;
  if (members.length === 1) return firstComplement;

  const others = members.slice(1);
  const matchCount = others.filter((m) => extractComplement(m.title) === firstComplement).length;

  if (matchCount >= others.length * 0.8) return firstComplement;
  return null;
}

function memberDisplayTitle(title: string, maxLen = 70): string {
  const cleaned = title.replace(/\?$/, '').trim();
  if (cleaned.length <= maxLen) return cleaned;
  return cleaned.slice(0, maxLen - 1) + '…';
}

interface ScenarioResult {
  winnerName: string;
  payoff: number;
  profit: number;
  probability: number;
}

function computeScenarios(
  members: CrossMarketInterMember[],
  direction: 'over' | 'under',
  stakePerLeg: number,
  priceSum: number,
  groupSize: number,
): ScenarioResult[] {
  const stakeTotal = stakePerLeg * groupSize;
  return members.map((member) => {
    const winnerName = memberDisplayTitle(member.title);
    let payoff: number;
    if (direction === 'under') {
      // Buy Yes in all: only X's Yes pays when X wins
      payoff = member.yes_price > 0 ? stakePerLeg / member.yes_price : 0;
    } else {
      // Buy No in all: all No's except X pay when X wins
      payoff = members
        .filter((m) => m.event_id !== member.event_id)
        .reduce((sum, m) => {
          const noPrice = 1 - m.yes_price;
          return sum + (noPrice > 0 ? stakePerLeg / noPrice : 0);
        }, 0);
    }
    return {
      winnerName,
      payoff,
      profit: payoff - stakeTotal,
      probability: priceSum > 0 ? member.yes_price / priceSum : 0,
    };
  });
}

interface OutcomesShape {
  values?: string[];
  prices?: string[];
}

function buildMemberLabels(members: CrossMarketInterMember[]): Map<string, string> {
  const subjectCounts = new Map<string, number>();
  for (const m of members) {
    const subject = extractSubject(m.title);
    subjectCounts.set(subject, (subjectCounts.get(subject) ?? 0) + 1);
  }
  const labels = new Map<string, string>();
  for (const m of members) {
    const subject = extractSubject(m.title);
    const count = subjectCounts.get(subject) ?? 1;
    const label = count >= 2 ? (m.title.length > 70 ? m.title.slice(0, 70) + '…' : m.title) : subject;
    labels.set(m.event_id, label);
  }
  return labels;
}

export function formatCalendarDrivenSignal(
  signal: SignalRow,
  bankroll: number,
  stakeCap: number,
): string {
  const meta = (signal.metadata ?? {}) as Partial<CalendarDrivenSignalMetadata>;
  const lastSeenAt = meta.last_seen_at as string | undefined;
  const ageLine = lastSeenAt ? `\n\n${formatSignalAge(lastSeenAt)}` : '';
  const yesPrice = meta.current_yes_price ?? 0;
  const volatility = meta.volatility_24h ?? 0;
  const vol24h = meta.volume_24h ?? 0;
  const title = signal.events?.title ?? 'Market';
  const category = meta.polymarket_category ?? null;
  const emoji = categoryEmoji(category);
  const confidence = signal.confidence_score ?? 0;

  const outcomes = (signal.events?.outcomes ?? null) as OutcomesShape | null;
  const sportsMarketType = signal.events?.sports_market_type ?? null;
  const line = signal.events?.line ?? null;

  function formatLine(n: number | null, invert = false): string {
    if (n === null || n === undefined) return '';
    const v = invert ? -n : n;
    if (v > 0) return `+${v}`;
    if (v < 0) return `${v}`;
    return '';
  }

  let label0 = outcomes?.values?.[0] ?? 'Yes';
  let label1 = outcomes?.values?.[1] ?? 'No';

  const isSpreadType = sportsMarketType === 'spreads' || sportsMarketType === 'map_handicap';

  if (isSpreadType && line !== null) {
    label0 = `${label0} (${formatLine(line)})`;
    label1 = `${label1} (${formatLine(line, true)})`;
  } else if (sportsMarketType === 'totals' && line !== null) {
    label0 = `${label0} ${line}`;
    label1 = `${label1} ${line}`;
  }
  const price0 = outcomes?.prices?.[0] != null ? parseFloat(outcomes.prices[0]) : yesPrice;
  const price1 = outcomes?.prices?.[1] != null ? parseFloat(outcomes.prices[1]) : 1 - yesPrice;
  const p0 = Math.round(price0 * 100);
  const p1 = 100 - p0;
  const isLiteralYesNo = label0 === 'Yes' && label1 === 'No';

  const cap = stakeCap;
  const stake = calcCalendarDrivenStake(bankroll, cap, confidence);
  const shares0 = price0 > 0 ? stake / price0 : 0;
  const shares1 = price1 > 0 ? stake / price1 : 0;
  const payoff0 = shares0;
  const payoff1 = shares1;
  const profit0 = payoff0 - stake;
  const profit1 = payoff1 - stake;

  const isEvenMatch = Math.abs(price0 - 0.5) < 0.01;
  let prefixSide0 = '';
  let prefixSide1 = '';
  if (isEvenMatch) {
    prefixSide0 = '🪙 equilibrado —';
    prefixSide1 = '🎲 equilibrado —';
  } else {
    prefixSide0 = price0 >= 0.5 ? '👑 favorito —' : '🐺 azarão —';
    prefixSide1 = price1 >= 0.5 ? '👑 favorito —' : '🐺 azarão —';
  }

  const truncLimit = (isSpreadType && line !== null) || (sportsMarketType === 'totals' && line !== null) ? 24 : 16;
  const l0 = truncate(label0, truncLimit);
  const l1 = truncate(label1, truncLimit);
  let sideRepr0: string;
  let sideRepr1: string;
  if (isLiteralYesNo) {
    sideRepr0 = `(a ${price0.toFixed(3)})`;
    sideRepr1 = `(a ${price1.toFixed(3)})`;
  } else {
    sideRepr0 = `a ${price0.toFixed(3)} (lado oposto: ${l1} a ${price1.toFixed(3)})`;
    sideRepr1 = `a ${price1.toFixed(3)} (lado oposto: ${l0} a ${price0.toFixed(3)})`;
  }

  let scenario0Win: string, scenario0Lose: string;
  let scenario1Win: string, scenario1Lose: string;
  if (isLiteralYesNo) {
    scenario0Win = 'Acontece';
    scenario0Lose = 'Não acontece';
    scenario1Win = 'Não acontece';
    scenario1Lose = 'Acontece';
  } else {
    scenario0Win = `${l0} ganha`;
    scenario0Lose = `${l0} perde`;
    scenario1Win = `${l1} ganha`;
    scenario1Lose = `${l1} perde`;
  }

  let viabilityLine: string;
  if (stake < 1.0) {
    const minBankroll = calcMinBankroll(1, cap, confidence);
    viabilityLine =
      `❌ Inviável: pra operar precisa de bankroll de ~$${minBankroll} ` +
      `(com cap ${(cap * 100).toFixed(0)}% e confiança ${confidence.toFixed(2)}).\n` +
      `   \n` +
      `   Recomendado: ignorar.`;
  } else {
    viabilityLine = `✅ Viável`;
  }

  const pfx0 = prefixSide0 ? `${prefixSide0} ` : '';
  const pfx1 = prefixSide1 ? `${prefixSide1} ` : '';

  return (
    `${emoji} ${title}\n` +
    `Calendar-Driven · Encerra ${formatEndDate(meta.end_date ?? '')} · ${formatTimeUntilResolution(meta.end_date ?? '')}\n` +
    `\n` +
    `⚡ Confiança: ${confidenceStars(confidence)}\n` +
    `📊 Variação 24h: ${(volatility * 100).toFixed(2)}pp (${describeVolatility(volatility)})\n` +
    `\n` +
    `💰 ${label0}: ${p0}% | ${label1}: ${p1}%\n` +
    `📊 Volume 24h: ${formatVolume(vol24h)}\n` +
    `\n` +
    `🔍 O que o sinal detectou\n` +
    `   Mercado convergiu nos últimos dias. Preço ${label0} estável\n` +
    `   em ~${p0}% há 24h, com volume de ${formatVolume(vol24h)}.\n` +
    `   ${formatTimeUntilResolution(meta.end_date ?? '')}.\n` +
    `   \n` +
    `   Possíveis leituras:\n` +
    `   1. Consenso firme: mercado tá certo, sem edge\n` +
    `   2. Consenso preguiçoso: ninguém tá olhando, info nova move\n` +
    `   3. Espera por evento: todos aguardando o resultado real\n` +
    `   \n` +
    `   Operar só faz sentido se você acredita que probabilidade\n` +
    `   real diverge dos ${p0}% / ${p1}% precificados.\n` +
    `\n` +
    `🎲 Trade-off completo (com stake $${stake.toFixed(2)})\n` +
    `   \n` +
    `   ${pfx0}Lado ${label0} ${sideRepr0}\n` +
    `   • ${scenario0Win} → recebe $${payoff0.toFixed(2)} (lucro $${profit0.toFixed(2)})\n` +
    `   • ${scenario0Lose} → recebe $0 (prejuízo $${stake.toFixed(2)})\n` +
    `   Mercado precifica ${p0}%. Operar só se você acha que > ${p0}%.\n` +
    `   \n` +
    `   ${pfx1}Lado ${label1} ${sideRepr1}\n` +
    `   • ${scenario1Win} → recebe $${payoff1.toFixed(2)} (lucro $${profit1.toFixed(2)})\n` +
    `   • ${scenario1Lose} → recebe $0 (prejuízo $${stake.toFixed(2)})\n` +
    `   Mercado precifica ${p1}%. Operar só se você acha que > ${p1}%.\n` +
    `\n` +
    `⚙️ Como operar\n` +
    `   Stake sugerido: $${stake.toFixed(2)} (${(cap * 100).toFixed(0)}% × confiança ${confidence.toFixed(2)} × bankroll $${bankroll})\n` +
    `   ${viabilityLine}` +
    ageLine
  );
}

function formatHypeRealityGapSignal(signal: SignalRow, bankroll: number, maxStakePct: number): string {
  const meta = (signal.metadata ?? {}) as Record<string, unknown>;
  const triggers = (meta['trigger_types'] ?? []) as string[];
  const momentum = meta['momentum'] as { triggered: boolean; price_change_pct: number; from: number; to: number } | undefined;
  const liquidity = meta['liquidity'] as { triggered: boolean; current_volume_1h: number; baseline_hourly: number; volume_ratio: number } | undefined;
  const currentPrice = (meta['current_price'] as number | undefined) ?? 0;
  const lastSeenAt = meta['last_seen_at'] as string | undefined;
  const ageLine = lastSeenAt ? `\n\n${formatSignalAge(lastSeenAt)}` : '';

  const stake = calcStake(bankroll, maxStakePct, 5);

  let text = `🌪 *Hype/Reality Gap* — ${signal.events?.title ?? 'Mercado'}\n`;
  text += `Disparou: ${triggers.join(' + ')}\n\n`;

  if (momentum?.triggered) {
    const direction = momentum.to > momentum.from ? '↑' : '↓';
    text += `*Momentum:* preço ${direction} ${momentum.price_change_pct.toFixed(1)}% em 1h (${formatPricePct(momentum.from)} → ${formatPricePct(momentum.to)})\n`;
  }
  if (liquidity?.triggered) {
    text += `*Liquidity:* volume 1h $${(liquidity.current_volume_1h / 1000).toFixed(1)}k vs baseline $${(liquidity.baseline_hourly / 1000).toFixed(1)}k/h (${liquidity.volume_ratio.toFixed(1)}x normal, preço estável)\n`;
  }

  text += `\nAtual: ${formatPricePct(currentPrice)} | ${formatPricePct(1 - currentPrice)}\n\n`;
  text += `Possíveis leituras:\n`;
  text += `1. Notícia real legítima → preço novo é correto\n`;
  text += `2. Hype puro → vai voltar pro patamar anterior\n`;
  text += `3. Manipulação coordenada → vai voltar mais devagar\n\n`;
  text += `Stake sugerido: $${stake.toFixed(2)}`;

  return text + ageLine;
}

export function formatSignal(
  signal: SignalRow,
  bankroll: number,
  maxStakePct: number,
  earliestEnd?: string | null,
): string {
  if (signal.signal_type === 'calendar_driven') {
    return formatCalendarDrivenSignal(signal, bankroll, maxStakePct);
  }

  if (signal.signal_type === 'hype_reality_gap') {
    return formatHypeRealityGapSignal(signal, bankroll, maxStakePct);
  }

  const meta = (signal.metadata ?? {}) as Partial<CrossMarketInterSignalMetadata>;
  const lastSeenAt = meta.last_seen_at as string | undefined;
  const ageLine = lastSeenAt ? `\n\n${formatSignalAge(lastSeenAt)}` : '';
  const edgePct = meta.expected_edge_pct ?? 0;
  const direction = meta.direction ?? 'over';
  const priceSum = meta.price_sum ?? 0;
  const groupSize = meta.group_size ?? 0;
  const totalVol = meta.total_volume_24h ?? 0;
  const members = meta.members ?? [];
  const category = meta.polymarket_category ?? null;
  const confidence = signal.confidence_score ?? 0;

  const derivedTitle = deriveSignalTitle(members);
  const friendlyLabel = categoryLabel(category);
  const title = derivedTitle ?? `${friendlyLabel} · ${groupSize} mercados relacionados`;
  const emoji = categoryEmoji(category);
  const side = direction === 'over' ? 'No' : 'Yes';

  const stakeTotal = calcStake(bankroll, maxStakePct, edgePct);
  const stakePerLeg = groupSize > 0 ? stakeTotal / groupSize : 0;

  // Viability cases A / B / C
  let viabilityLine: string;
  let viable: 'A' | 'B' | 'C';
  if (groupSize === 0 || stakePerLeg < 1.0) {
    viable = 'A';
    const fracaoEfetiva = Math.min(maxStakePct, edgePct / 200);
    const bankrollMin = fracaoEfetiva > 0 ? Math.ceil(groupSize / fracaoEfetiva) : 999999;
    viabilityLine =
      `❌ Inviável: pra essa basket precisaria de bankroll de ~$${bankrollMin}.\n` +
      `   \n` +
      `   Recomendado: ignorar.`;
  } else if (stakePerLeg < 5.0) {
    viable = 'B';
    viabilityLine = `⚠️ Stake pequeno por leg. Slippage pode comer parte do edge.`;
  } else {
    viable = 'C';
    viabilityLine = `✅ Operacional. Edge líquido esperado: ${edgePct.toFixed(2)}%.`;
  }

  // Scenarios
  const scenarios = computeScenarios(members, direction, stakePerLeg, priceSum, groupSize);
  const probLucroTotal = scenarios.reduce((acc, s) => acc + (s.profit > 0 ? s.probability : 0), 0);
  const scenariosSorted = [...scenarios].sort((a, b) => b.probability - a.probability);

  // Nature section
  let natureSec =
    `🎲 Natureza da bet\n` +
    `   Bet com EV positivo, não arbitragem garantida.\n` +
    `   \n` +
    `   Cenários (com stake $${stakePerLeg.toFixed(2)}/leg, total $${stakeTotal.toFixed(2)}):\n`;
  for (const s of scenariosSorted) {
    const profitEmoji = s.profit > 0 ? '✅' : '❌';
    const profitLabel = s.profit > 0 ? 'lucro' : 'prejuízo';
    const probPct = (s.probability * 100).toFixed(1);
    natureSec +=
      `   ${profitEmoji} ${s.winnerName} ganha (${probPct}%) → recebe $${s.payoff.toFixed(2)} → ${profitLabel} $${Math.abs(s.profit).toFixed(2)}\n`;
  }
  natureSec +=
    `   \n` +
    `   Probabilidade de lucro nesta operação: ${(probLucroTotal * 100).toFixed(1)}%\n` +
    `   Edge se materializa em ~50+ trades similares.`;

  // How to operate section
  const howToSec =
    `⚙️ Como operar\n` +
    `   Stake total $${stakeTotal.toFixed(2)} ÷ ${groupSize} legs = $${stakePerLeg.toFixed(2)}/leg\n` +
    `   ${viabilityLine}`;

  // Execution / Composition section
  const execTitle = viable === 'A' ? `📋 Composição (referência)` : `📋 Pra executar`;
  let execSec = `${execTitle}:\n`;
  for (const m of members) {
    const name = memberDisplayTitle(m.title);
    const priceForBuy = direction === 'over' ? 1 - m.yes_price : m.yes_price;
    const shares = stakePerLeg > 0 && priceForBuy > 0 ? stakePerLeg / priceForBuy : 0;
    execSec += `   • ${name} → ${side} → $${stakePerLeg.toFixed(2)} a ${priceForBuy.toFixed(3)} (${shares.toFixed(1)} shares)\n`;
  }

  return (
    `${emoji} ${title}\n` +
    `Cross-Market Inter · ${groupSize} membros\n` +
    (earliestEnd ? `Encerra ${formatEndDate(earliestEnd)} · ${formatTimeUntilResolution(earliestEnd)}\n` : '') +
    `\n` +
    `⚡ Confiança: ${confidenceStars(confidence)}\n` +
    `Edge: ${edgePct.toFixed(2)}% líquido | direction: ${direction}\n` +
    `\n` +
    `📌 Operação: comprar **${side}** em todos os ${groupSize} membros\n` +
    `\n` +
    `📊 Soma dos preços: ${priceSum.toFixed(3)} (deveria ser 1.000)\n` +
    `\n` +
    `${natureSec}\n` +
    `\n` +
    `${howToSec}\n` +
    `\n` +
    `${execSec}\n` +
    `📊 Volume 24h: ${formatVolume(totalVol)}` +
    ageLine
  );
}

export function relativeTime(isoDate: string): string {
  const diffMs = Date.now() - new Date(isoDate).getTime();
  const mins = Math.floor(diffMs / 60000);
  const hours = Math.floor(mins / 60);
  const days = Math.floor(hours / 24);
  if (days > 0) return `${days}d`;
  if (hours > 0) return `${hours}h`;
  return `${mins}m`;
}
