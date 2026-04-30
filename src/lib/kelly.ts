/**
 * Fractional Kelly criterion for bet sizing.
 * Returns stake as a fraction of bankroll (e.g., 0.02 = 2%).
 */
export function kelly(params: {
  probability: number;   // our estimated edge probability (0-1)
  marketPrice: number;   // current market price = implied probability (0-1)
  fraction: number;      // Kelly fraction to apply (e.g., 0.25 = quarter Kelly)
  maxStakePct: number;   // hard cap (e.g., 0.03 = 3%)
}): number {
  const { probability, marketPrice, fraction, maxStakePct } = params;

  // Decimal odds: payout per unit risked if market price is p, odds = (1-p)/p
  const odds = (1 - marketPrice) / marketPrice;
  const edge = probability * (odds + 1) - 1;

  if (edge <= 0) return 0;

  const fullKelly = edge / odds;
  return Math.min(fullKelly * fraction, maxStakePct);
}
