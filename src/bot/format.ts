import type { CrossMarketInterSignalMetadata } from '../types/index.js';

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

export function calcStake(
  bankroll: number,
  maxStakePct: number,
  edgePct: number,
): number {
  const raw = bankroll * Math.min(maxStakePct, edgePct / 200);
  const rounded = Math.round(raw * 100) / 100;
  return Math.max(0.5, rounded);
}

export function stakeLabel(stake: number, isMinimum: boolean): string {
  return isMinimum ? `$0.50 (mínimo)` : `$${stake.toFixed(2)}`;
}

export function formatSignal(
  index: number,
  signal: SignalRow,
  bankroll: number,
  maxStakePct: number,
): string {
  const meta = (signal.metadata ?? {}) as Partial<CrossMarketInterSignalMetadata>;
  const edgePct = meta.expected_edge_pct ?? 0;
  const direction = meta.direction ?? '?';
  const priceSum = meta.price_sum ?? 0;
  const groupSize = meta.group_size ?? 0;
  const totalVol = meta.total_volume_24h ?? 0;
  const members = meta.members ?? [];

  const top3 = members
    .slice(0, 3)
    .map((m) => {
      const label = m.title.split(' ')[1] ?? m.title;
      return `${label} ${(m.yes_price * 100).toFixed(1)}%`;
    })
    .join(' | ');

  const category = meta.polymarket_category ?? signal.signal_type;

  const rawStake = bankroll * Math.min(maxStakePct, edgePct / 200);
  const isMinimum = rawStake < 0.5;
  const stake = isMinimum ? 0.5 : Math.round(rawStake * 100) / 100;
  const stakeStr = isMinimum ? '$0.50 (mínimo)' : `$${stake.toFixed(2)}`;

  const volStr =
    totalVol >= 1000 ? `$${(totalVol / 1000).toFixed(1)}k` : `$${totalVol.toFixed(0)}`;

  return (
    `*[${index}]* \`${category}\` — edge \`${edgePct.toFixed(2)}%\` (\`${direction}\`)\n` +
    `Soma: \`${priceSum.toFixed(3)}\` | Membros: \`${groupSize}\` | Volume 24h: ${volStr}\n` +
    (top3 ? `Top 3: ${top3}\n` : '') +
    `Stake sugerido: \`${stakeStr}\``
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

export function polymarketSlug(signal: SignalRow): string {
  const meta = (signal.metadata ?? {}) as Partial<CrossMarketInterSignalMetadata>;
  const members = meta.members ?? [];
  if (members.length > 0) {
    return `https://polymarket.com/event/${members[0]!.polymarket_id}`;
  }
  if (signal.events?.polymarket_id) {
    return `https://polymarket.com/event/${signal.events.polymarket_id}`;
  }
  return 'https://polymarket.com';
}
