/**
 * Polymarket taker fee rates by feeType (canonical field in Gamma API markets endpoint).
 * Source: https://docs.polymarket.com/quickstart/fees
 *
 * Fee formula: fee_usdc = shares × feeRate × p × (1 - p)
 * For $1 invested at price p: fee = feeRate × (1 - p)
 */
export const POLYMARKET_FEE_RATES: Record<string, number> = {
  // Canonical feeType values from the API
  'politics_fees': 0.04,
  'sports_fees_v2': 0.03,
  'sports_fees': 0.03,
  'crypto_fees_v2': 0.072,
  'crypto_fees': 0.072,
  'culture_fees': 0.05,
  'general_fees': 0.05,
  'tech_fees': 0.04,
  'finance_fees': 0.04,
  'economics_fees': 0.05,
  'geopolitics_fees': 0.0,
  // Human-readable aliases (fallback)
  'politics': 0.04,
  'sports': 0.03,
  'crypto': 0.072,
  'culture': 0.05,
  'general': 0.05,
  'tech': 0.04,
  'finance': 0.04,
  'economics': 0.05,
  'geopolitics': 0.0,
};

import type { ArbDirection } from '../types/index.js';

const DEFAULT_FEE_RATE = 0.04;

/**
 * Returns the effective fee rate, with a three-tier priority:
 *   1. directRate — feeSchedule.rate captured from the Gamma API at collection time (most accurate)
 *   2. Hardcoded table lookup by feeType string (e.g. "politics_fees")
 *   3. Conservative 4% fallback
 */
export function getFeeRate(
  polymarketCategory: string | null | undefined,
  directRate?: number | null,
): number {
  if (directRate != null && isFinite(directRate) && directRate >= 0) return directRate;
  if (!polymarketCategory) return DEFAULT_FEE_RATE;
  const normalized = polymarketCategory.toLowerCase().trim();
  if (normalized in POLYMARKET_FEE_RATES) return POLYMARKET_FEE_RATES[normalized]!;
  const stripped = normalized.replace(/_fees(?:_v\d+)?$/, '');
  return POLYMARKET_FEE_RATES[stripped] ?? DEFAULT_FEE_RATE;
}

/**
 * Estimates total fee cost of buying No on all members of a negRiskGroup (basket arb).
 *
 * For each member: $1 invested at price p_no, shares = 1/p_no, fee = feeRate × p_yes
 * Returns fee as a fraction of $1 invested per member (averaged across basket).
 */
export function estimateBuyNoBasketFeeCost(feeRate: number, yesPrices: number[]): number {
  if (yesPrices.length === 0 || feeRate === 0) return 0;

  let totalFee = 0;
  let totalCost = 0;

  for (const pYes of yesPrices) {
    const pNo = 1 - pYes;
    if (pNo <= 0) continue;
    const shares = 1 / pNo;
    const fee = shares * feeRate * pYes * pNo; // = feeRate * pYes
    totalFee += fee;
    totalCost += 1;
  }

  return totalCost > 0 ? totalFee / totalCost : 0;
}

/**
 * Estimates total fee cost of buying Yes on all members of a negRiskGroup (basket arb).
 *
 * For each member: $1 invested at price p_yes, shares = 1/p_yes, fee = feeRate × (1 - p_yes)
 * Returns fee as a fraction of $1 invested per member (averaged across basket).
 */
export function estimateBuyYesBasketFeeCost(feeRate: number, yesPrices: number[]): number {
  if (yesPrices.length === 0 || feeRate === 0) return 0;

  let totalFee = 0;
  let totalCost = 0;

  for (const pYes of yesPrices) {
    if (pYes <= 0 || pYes >= 1) continue;
    const shares = 1 / pYes;
    const fee = shares * feeRate * pYes * (1 - pYes); // = feeRate * (1 - pYes)
    totalFee += fee;
    totalCost += 1;
  }

  return totalCost > 0 ? totalFee / totalCost : 0;
}

/**
 * Calculates expected net edge for a cross-market arb signal.
 *
 * priceSum > 1 (overpriced): buy No on all members.
 *   Capital = N - priceSum (sum of No prices). Gross ROI = (priceSum - 1) / (N - priceSum).
 *
 * priceSum < 1 (underpriced): buy Yes on all members.
 *   Capital = priceSum. Gross ROI = (1 - priceSum) / priceSum.
 *
 * Returns edgePct in percentage points (e.g. 1.8 = 1.8%, can be negative) and direction.
 */
export function calculateExpectedEdgePct(
  priceSum: number,
  feeRate: number,
  yesPrices: number[],
): { edgePct: number; direction: ArbDirection } {
  if (priceSum > 1) {
    const grossDeviation = priceSum - 1;
    const noSidePool = yesPrices.length - priceSum;
    const grossROI = noSidePool > 0 ? grossDeviation / noSidePool : 0;
    const feeCost = estimateBuyNoBasketFeeCost(feeRate, yesPrices);
    return { edgePct: (grossROI - feeCost) * 100, direction: 'over' as const };
  } else {
    const grossDeviation = 1 - priceSum;
    const yesSidePool = priceSum;
    const grossROI = yesSidePool > 0 ? grossDeviation / yesSidePool : 0;
    const feeCost = estimateBuyYesBasketFeeCost(feeRate, yesPrices);
    return { edgePct: (grossROI - feeCost) * 100, direction: 'under' as const };
  }
}
