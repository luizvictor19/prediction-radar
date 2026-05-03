import type { CrossMarketInterSignalMetadata, CalendarDrivenSignalMetadata } from '../types/index.js';

export interface SignalRow {
  id: string;
  event_id: string | null;
  signal_type: string;
  suggested_outcome: string | null;
  metadata: Record<string, unknown> | null;
  events?: { title: string; polymarket_id: string } | null;
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

export function formatCalendarDrivenSignal(
  signal: SignalRow,
  _bankroll: number,
  _stakeCap: number,
): string {
  const meta = (signal.metadata ?? {}) as Partial<CalendarDrivenSignalMetadata>;
  const daysUntil = meta.days_until_resolution ?? 0;
  const currentPrice = meta.current_yes_price ?? 0;
  const volatility = meta.volatility_24h ?? 0;
  const vol24h = meta.volume_24h ?? 0;
  const title = signal.events?.title ?? 'Market';

  return (
    `🗓️ *${title}*\n` +
    `Resolve em \`${Math.round(daysUntil)}\` dias | Volatilidade 24h: \`${(volatility * 100).toFixed(2)}pp\`\n` +
    `\n` +
    `💰 Yes: \`${currentPrice.toFixed(2)}\` (estável há 24h)\n` +
    `📊 Volume 24h: ${formatVolume(vol24h)}\n` +
    `\n` +
    `⚠️ Sistema sinalizou *setup*, não direção.\n` +
    `   Avalie sua tese fundamental antes de operar:\n` +
    `   • P(yes) > \`${currentPrice.toFixed(2)}\` → comprar Yes\n` +
    `   • P(yes) < \`${currentPrice.toFixed(2)}\` → comprar No\n` +
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

  // Title
  const derivedTitle = deriveSignalTitle(members);
  const categoryDisplay = (category ?? signal.signal_type).replace(/_/g, ' ');
  const title = derivedTitle ?? `${categoryDisplay} (${groupSize} membros)`;
  const emoji = categoryEmoji(category);

  // Stake & viability
  const stake = calcStake(bankroll, maxStakePct, edgePct);
  const stakePerLeg = groupSize > 0 ? stake / groupSize : 0;
  let viability: string;
  if (groupSize === 0 || stakePerLeg < 1.0) {
    viability = `   ⚠️ Stake \`$${stake.toFixed(2)}\` é inviável pra basket de ${groupSize} (mín. $1/ordem na Polymarket). Recomendado: ignorar até bankroll crescer.`;
  } else if (stakePerLeg < 5.0) {
    viability = `   ⚠️ Stake pequeno por leg (\`$${stakePerLeg.toFixed(2)}\` cada). Slippage pode comer parte do edge.`;
  } else {
    viability = `   ✅ Stake viável: \`$${stakePerLeg.toFixed(2)}\` por leg em ${groupSize} legs.`;
  }

  // Instruction
  const deviation = direction === 'over' ? priceSum - 1 : 1 - priceSum;
  const deviationStr = (deviation * 100).toFixed(2);
  let instruction: string;
  if (direction === 'over') {
    instruction = `Comprar *No* em todos os ${groupSize} membros, em proporções iguais ao stake total. O mercado está sobreprecificado em ${deviationStr}%.`;
  } else {
    instruction = `Comprar *Yes* em todos os ${groupSize} membros, em proporções iguais. O mercado está subprecificado em ${deviationStr}%.`;
  }

  // Top 3 (members already sorted by yes_price desc from detector)
  const top3 = members
    .slice(0, 3)
    .map((m) => {
      const name = extractSubject(m.title);
      return `${name} ${(m.yes_price * 100).toFixed(1)}%`;
    })
    .join(' · ');

  return (
    `${emoji} *${title}*\n` +
    `Edge: \`${edgePct.toFixed(2)}%\` líquido | direction: \`${direction}\`\n` +
    `\n` +
    `📊 ${groupSize} membros compondo o grupo. Soma dos preços = \`${priceSum.toFixed(3)}\`\n` +
    `   (deveria ser 1.000).\n` +
    `\n` +
    `⚙️ Operação: ${instruction}\n` +
    `${viability}\n` +
    (top3 ? `\n🏆 Top 3: ${top3}\n` : '') +
    `💰 Volume 24h: ${formatVolume(totalVol)}`
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
