import { supabase } from '../lib/supabase.js';
import { logEvent } from '../lib/logger.js';
import type { GammaMarket } from '../types/index.js';

const GAMMA_URL = process.env['POLYMARKET_GAMMA_URL'] ?? 'https://gamma-api.polymarket.com';
const FETCH_TIMEOUT_MS = 10_000;
const CYCLE_TIMEOUT_MS = 120_000;
const CHUNK_SIZE = 20;
const NEW_MARKET_WINDOW_HOURS = 24;
let isRunning = false;

export async function collectEarlyMarkets(): Promise<void> {
  if (isRunning) {
    await logEvent({
      component: 'early_markets_collector',
      status: 'partial',
      message: 'previous cycle still running, skipping this tick',
    });
    return;
  }
  isRunning = true;

  const cyclePromise = _collect();
  const timeoutPromise = new Promise<void>((_, reject) =>
    setTimeout(() => reject(new Error('cycle timeout 120s')), CYCLE_TIMEOUT_MS),
  );

  try {
    await Promise.race([cyclePromise, timeoutPromise]);
  } catch (err) {
    await logEvent({ component: 'early_markets_collector', status: 'error', message: String(err) });
  } finally {
    isRunning = false;
  }
}

async function processMarket(market: GammaMarket): Promise<{ upserted: boolean; snapshots: number }> {
  try {
    const startDate = (market as any).startDate as string | undefined;
    if (!startDate) return { upserted: false, snapshots: 0 };

    const volume24h = Number(market.volume24hr ?? market.volume24hrClob ?? 0);
    const liquidity = Number(market.liquidityNum ?? market.liquidity ?? 0);

    if (volume24h < 1000 && liquidity < 2000) return { upserted: false, snapshots: 0 };
    if (market.bestBid === 0 && market.bestAsk === 1) return { upserted: false, snapshots: 0 };

    const outcomes = JSON.parse(market.outcomes) as string[];
    const outcomePrices = JSON.parse(market.outcomePrices) as string[];

    const event = {
      polymarket_id: market.id,
      slug: market.slug,
      title: market.question,
      category: 'other',
      polymarket_category: market.feeType ?? null,
      polymarket_fee_rate: market.feeSchedule?.rate ?? null,
      is_ai_tech: false,
      description: market.description,
      outcomes: { values: outcomes, prices: outcomePrices },
      volume_total: Number(market.volumeNum ?? market.volume ?? 0),
      volume_24h: Number(market.volume24hr ?? market.volume24hrClob ?? 0),
      liquidity: Number(market.liquidityNum ?? market.liquidity ?? 0),
      end_date: market.endDate,
      start_date: startDate,
      is_new_market: true,
      status: 'active' as const,
      resolved_outcome: null,
      tracked: true,
      neg_risk_market_id: market.negRiskMarketID ?? null,
    };

    const { data: eventRow, error: upsertErr } = await supabase
      .from('events')
      .upsert(event, { onConflict: 'polymarket_id', ignoreDuplicates: false })
      .select('id')
      .single();

    if (upsertErr || !eventRow) return { upserted: false, snapshots: 0 };

    const bestBid = market.bestBid;
    const bestAsk = market.bestAsk;
    if (bestBid == null || bestAsk == null) return { upserted: true, snapshots: 0 };

    const midPrimary = (bestBid + bestAsk) / 2;
    const midSecondary = 1 - midPrimary;
    const spread = market.spread ?? null;

    const rows = [
      {
        event_id: eventRow.id,
        outcome: outcomes[0],
        best_bid: bestBid,
        best_ask: bestAsk,
        mid_price: midPrimary,
        spread,
        volume_24h: volume24h,
      },
      {
        event_id: eventRow.id,
        outcome: outcomes[1],
        best_bid: 1 - bestAsk,
        best_ask: 1 - bestBid,
        mid_price: midSecondary,
        spread,
        volume_24h: volume24h,
      },
    ];

    const { error: snapErr } = await supabase.from('polymarket_snapshots').insert(rows);
    return { upserted: true, snapshots: snapErr ? 0 : 2 };
  } catch {
    return { upserted: false, snapshots: 0 };
  }
}

async function _collect(): Promise<void> {
  const startedAt = Date.now();
  const cutoffIso = new Date(Date.now() - NEW_MARKET_WINDOW_HOURS * 60 * 60 * 1000).toISOString();

  let allMarkets: GammaMarket[] = [];
  let offset = 0;

  while (true) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    try {
      const url = `${GAMMA_URL}/markets?ascending=false&order=startDate&limit=500&offset=${offset}`;
      const res = await fetch(url, { signal: controller.signal });
      if (!res.ok) break;

      const batch = (await res.json()) as GammaMarket[];
      if (batch.length === 0) break;

      const inWindow = batch.filter(m => {
        const startDate = (m as any).startDate as string | undefined;
        if (!startDate || startDate < cutoffIso) return false;
        if (!m.active || m.closed) return false;

        const volume24h = Number(m.volume24hr ?? m.volume24hrClob ?? 0);
        const liquidity = Number(m.liquidityNum ?? m.liquidity ?? 0);
        if (volume24h < 1000 && liquidity < 2000) return false;
        if (m.bestBid === 0 && m.bestAsk === 1) return false;

        return true;
      });

      allMarkets = allMarkets.concat(inWindow);

      const lastMarket = batch[batch.length - 1];
      const lastStartDate = (lastMarket as any)?.startDate as string | undefined;
      if (!lastStartDate || lastStartDate < cutoffIso) break;

      offset += batch.length;
      if (batch.length < 500) break;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  let upserted = 0;
  let snapshotsInserted = 0;

  console.log(`[early-markets] Processing ${allMarkets.length} markets in chunks of ${CHUNK_SIZE}...`);

  for (let i = 0; i < allMarkets.length; i += CHUNK_SIZE) {
    const chunk = allMarkets.slice(i, i + CHUNK_SIZE);
    const results = await Promise.all(chunk.map(processMarket));
    for (const r of results) {
      if (r.upserted) upserted++;
      snapshotsInserted += r.snapshots;
    }
  }

  await supabase
    .from('events')
    .update({ is_new_market: false })
    .eq('is_new_market', true)
    .lt('start_date', cutoffIso);

  const durationMs = Date.now() - startedAt;
  await logEvent({
    component: 'early_markets_collector',
    status: 'success',
    message: `Found ${allMarkets.length} new markets (<24h), upserted ${upserted}, ${snapshotsInserted} snapshots in ${durationMs}ms`,
    metadata: {
      total_found: allMarkets.length,
      upserted,
      snapshots: snapshotsInserted,
      duration_ms: durationMs,
    },
  });
}
