// Fees observadas em trades reais (maio 2026) são ~0 em todas
// as categorias na Polymarket Internacional, mesmo quando a
// API retorna rate > 0. Se notar fees ativadas em trades
// futuros, ajustar tabela.

export const POLYMARKET_FEE_RATES: Record<string, number> = {
  'politics_fees': 0,
  'sports_fees_v2': 0,
  'sports_fees': 0,
  'crypto_fees_v2': 0,
  'crypto_fees': 0,
  'culture_fees': 0,
  'general_fees': 0,
  'tech_fees': 0,
  'finance_fees': 0,
  'economics_fees': 0,
  'geopolitics_fees': 0,
  'politics': 0,
  'sports': 0,
  'crypto': 0,
  'culture': 0,
  'general': 0,
  'tech': 0,
  'finance': 0,
  'economics': 0,
  'geopolitics': 0,
};

import type { ArbDirection } from '../types/index.js';

export function getFeeRate(
  _polymarketCategory?: string | null,
  _directRate?: number | null,
): number {
  return 0;
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
