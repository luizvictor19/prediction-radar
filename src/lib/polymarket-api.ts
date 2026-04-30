import type { GammaMarket, ClobOrderbook } from '../types/index.js';

const GAMMA_URL = process.env['POLYMARKET_GAMMA_URL'] ?? 'https://gamma-api.polymarket.com';
const CLOB_URL = process.env['POLYMARKET_CLOB_URL'] ?? 'https://clob.polymarket.com';

async function get<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
  return res.json() as Promise<T>;
}

export async function fetchActiveMarkets(params: {
  limit?: number;
  offset?: number;
}): Promise<GammaMarket[]> {
  const { limit = 500, offset = 0 } = params;
  const url = `${GAMMA_URL}/markets?active=true&closed=false&limit=${limit}&offset=${offset}`;
  return get<GammaMarket[]>(url);
}

// Reserved for detectors that need deep orderbook data (not used in normal collection)
export async function fetchOrderbook(tokenId: string): Promise<ClobOrderbook> {
  return get<ClobOrderbook>(`${CLOB_URL}/book?token_id=${tokenId}`);
}
