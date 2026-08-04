import type { GammaMarket, ClobOrderbook } from '../types/index.js';

const GAMMA_URL = process.env['POLYMARKET_GAMMA_URL'] ?? 'https://gamma-api.polymarket.com';
const CLOB_URL = process.env['POLYMARKET_CLOB_URL'] ?? 'https://clob.polymarket.com';

// Sem timeout, um socket pendurado deixa a promise do coletor sem resolver
// para sempre — e com ela o lock de ciclo, que só é solto no finally.
const FETCH_TIMEOUT_MS = 20_000;

async function get<T>(url: string): Promise<T> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
    return (await res.json()) as T;
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error(`Timeout after ${FETCH_TIMEOUT_MS}ms fetching ${url}`);
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
}

export async function fetchActiveMarkets(params: {
  limit?: number;
  offset?: number;
  order?: string;
  ascending?: boolean;
}): Promise<GammaMarket[]> {
  const { limit = 500, offset = 0, order, ascending } = params;
  let url = `${GAMMA_URL}/markets?active=true&closed=false&limit=${limit}&offset=${offset}`;
  if (order) {
    url += `&order=${encodeURIComponent(order)}`;
    if (ascending !== undefined) {
      url += `&ascending=${ascending}`;
    }
  }
  return get<GammaMarket[]>(url);
}

/**
 * @deprecated Gamma API ignores negRiskMarketID as a server-side filter — returns the full
 * paginated universe instead. Use DB aggregation (events table) for group size checks.
 */
export async function fetchMarketsByNegRiskId(negRiskMarketId: string): Promise<GammaMarket[]> {
  const all: GammaMarket[] = [];
  const limit = 500;
  let offset = 0;

  while (true) {
    const url = `${GAMMA_URL}/markets?negRiskMarketID=${encodeURIComponent(negRiskMarketId)}&limit=${limit}&offset=${offset}`;
    const page = await get<GammaMarket[]>(url);
    all.push(...page);
    if (page.length < limit) break;
    offset += limit;
  }

  return all;
}

// Reserved for detectors that need deep orderbook data (not used in normal collection)
export async function fetchOrderbook(tokenId: string): Promise<ClobOrderbook> {
  return get<ClobOrderbook>(`${CLOB_URL}/book?token_id=${tokenId}`);
}
