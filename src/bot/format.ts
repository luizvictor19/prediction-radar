import type { CrossMarketInterSignalMetadata, CrossMarketInterMember, CalendarDrivenSignalMetadata } from '../types/index.js';
import { confidenceStars, describeVolatility } from '../lib/format-helpers.js';

export interface SignalRow {
  id: string;
  event_id: string | null;
  signal_type: string;
  suggested_outcome: string | null;
  confidence_score?: number | null;
  metadata: Record<string, unknown> | null;
  events?: { title: string; polymarket_id: string; outcomes?: any } | null;
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
    const winnerName = extractSubject(member.title);
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

export function formatCalendarDrivenSignal(
  signal: SignalRow,
  _bankroll: number,
  _stakeCap: number,
): string {
  const meta = (signal.metadata ?? {}) as Partial<CalendarDrivenSignalMetadata>;
  const daysUntil = meta.days_until_resolution ?? 0;
  const yesPrice = meta.current_yes_price ?? 0;
  const volatility = meta.volatility_24h ?? 0;
  const vol24h = meta.volume_24h ?? 0;
  const title = signal.events?.title ?? 'Market';
  const category = meta.polymarket_category ?? null;
  const emoji = categoryEmoji(category);
  const confidence = signal.confidence_score ?? 0;

  const outcomes = signal.events?.outcomes ?? null;
  const label0 = outcomes?.values?.[0] ?? 'Yes';
  const label1 = outcomes?.values?.[1] ?? 'No';
  const p0 = Math.round(yesPrice * 100);
  const p1 = 100 - p0;
  const isLiteralYesNo = label0 === 'Yes' && label1 === 'No';

  return (
    `${emoji} ${title}\n` +
    `Calendar-Driven · Resolve em ${Math.round(daysUntil)} dias\n` +
    `\n` +
    `⚡ Confiança: ${confidenceStars(confidence)}\n` +
    `📊 Variação 24h: ${(volatility * 100).toFixed(2)}pp (${describeVolatility(volatility)})\n` +
    `\n` +
    `💰 ${label0}: ${p0}% | ${label1}: ${p1}%\n` +
    `📊 Volume 24h: ${formatVolume(vol24h)}\n` +
    `\n` +
    `⚠️ Sistema sinalizou setup, não direção.\n` +
    `   • Acha que ${label0} ${isLiteralYesNo ? 'acontece' : 'ganha'}? → comprar ${label0} a ${yesPrice.toFixed(2)}\n` +
    `   • Acha que ${label1} ${isLiteralYesNo ? 'acontece' : 'ganha'}? → comprar ${label1} a ${(1 - yesPrice).toFixed(2)}\n` +
    `   • Sem opinião forte → ignorar`
  );
}

export function formatSignal(
  signal: SignalRow,
  bankroll: number,
  maxStakePct: number,
): string {
  if (signal.signal_type === 'calendar_driven') {
    return formatCalendarDrivenSignal(signal, bankroll, maxStakePct);
  }

  const meta = (signal.metadata ?? {}) as Partial<CrossMarketInterSignalMetadata>;
  const edgePct = meta.expected_edge_pct ?? 0;
  const direction = meta.direction ?? 'over';
  const priceSum = meta.price_sum ?? 0;
  const groupSize = meta.group_size ?? 0;
  const totalVol = meta.total_volume_24h ?? 0;
  const members = meta.members ?? [];
  const category = meta.polymarket_category ?? null;
  const confidence = signal.confidence_score ?? 0;

  const derivedTitle = deriveSignalTitle(members);
  const categoryDisplay = (category ?? signal.signal_type).replace(/_/g, ' ');
  const title = derivedTitle ?? `${categoryDisplay} (${groupSize} membros)`;
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
      `❌ Inviável: Polymarket exige mín. $1/leg.\n` +
      `      Pra essa basket precisaria de bankroll de ~$${bankrollMin}.\n` +
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
    const name = extractSubject(m.title);
    const priceForBuy = direction === 'over' ? 1 - m.yes_price : m.yes_price;
    const shares = stakePerLeg > 0 && priceForBuy > 0 ? stakePerLeg / priceForBuy : 0;
    execSec += `   • ${name} → ${side} → $${stakePerLeg.toFixed(2)} a ${priceForBuy.toFixed(3)} (${shares.toFixed(1)} shares)\n`;
  }

  return (
    `${emoji} ${title}\n` +
    `Cross-Market Inter · ${groupSize} membros\n` +
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
    `📊 Volume 24h: ${formatVolume(totalVol)}`
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
