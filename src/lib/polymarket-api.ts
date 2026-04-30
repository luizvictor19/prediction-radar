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
  minVolume24h?: number;
}): Promise<GammaMarket[]> {
  const { limit = 100, offset = 0, minVolume24h = 5000 } = params;
  const url = `${GAMMA_URL}/markets?active=true&closed=false&limit=${limit}&offset=${offset}&volume_num_min=${minVolume24h}`;
  return get<GammaMarket[]>(url);
}

export async function fetchOrderbook(tokenId: string): Promise<ClobOrderbook> {
  return get<ClobOrderbook>(`${CLOB_URL}/book?token_id=${tokenId}`);
}
