import { supabase } from '../lib/supabase.js';
import { logEvent, logDisabled } from '../lib/logger.js';
import { getSystemConfig } from '../lib/config.js';
import { batchInsert, batchUpsert, dedupeByKey, EVENTS_CHUNK_SIZE } from '../lib/batch-write.js';
import { CycleLock } from '../lib/cycle-lock.js';
import type { GammaMarket } from '../types/index.js';

const GAMMA_URL = process.env['POLYMARKET_GAMMA_URL'] ?? 'https://gamma-api.polymarket.com';
const FETCH_TIMEOUT_MS = 25_000;
const CYCLE_TIMEOUT_MS = 300_000;
const NEW_MARKET_WINDOW_HOURS = 24;

const cycleLock = new CycleLock();

export async function collectEarlyMarkets(): Promise<void> {
  // Spec 000, item 4. Este coletor nunca alcançou a própria janela: pagina
  // `order=startDate` atrás de 24h de markets novos, e o teto de offset 2000 da
  // Gamma cobre ~36 min — todo ciclo terminava em `pagination_failed`. Os ~36 min
  // que ele de fato cobria são os mesmos da descoberta (item 2a), que roda a cada
  // 3 min e sem o piso de liquidez de US$ 500 que aqui exclui, por construção, o
  // mercado de esports recém-nascido (~US$ 17).
  //
  // Código mantido: a janela de 24h volta a fazer sentido se a Gamma um dia
  // afrouxar o teto de offset.
  if (!(await getSystemConfig()).early_markets_enabled) {
    await logDisabled(
      'early_markets_collector',
      'Early-markets desligado (system_config.early_markets_enabled = false, spec 000 item 4)',
    );
    return;
  }

  const lockToken = cycleLock.tryAcquire();

  if (!lockToken) {
    await logEvent({
      component: 'early_markets_collector',
      status: 'partial',
      message: 'previous cycle still running, skipping this tick',
      metadata: { previous_cycle_running_for_ms: cycleLock.heldForMs() ?? 0 },
    });
    return;
  }

  if (lockToken.staleTakeoverMs !== null) {
    const stuckMinutes = Math.round(lockToken.staleTakeoverMs / 60000);
    console.warn(`[early-markets] Previous cycle stuck for ${stuckMinutes}min — assuming dead, starting a new one`);
    await logEvent({
      component: 'early_markets_collector',
      status: 'partial',
      message: `WARNING: previous cycle stuck for ${stuckMinutes}min — assumed dead, starting a new one`,
      metadata: { stuck_for_ms: lockToken.staleTakeoverMs },
    });
  }

  // O lock é solto quando o trabalho real termina, não quando a race termina:
  // no timeout o _collect() continua vivo, e soltar ali deixaria o próximo tick
  // rodar em cima do ciclo zumbi. Se ele nunca terminar, o takeover destrava.
  const cyclePromise = _collect().finally(() => cycleLock.release(lockToken));

  const timeoutPromise = new Promise<void>((_, reject) =>
    setTimeout(() => reject(new Error('cycle timeout 300s')), CYCLE_TIMEOUT_MS),
  );

  try {
    await Promise.race([cyclePromise, timeoutPromise]);
  } catch (err) {
    await logEvent({ component: 'early_markets_collector', status: 'error', message: String(err) });
  }
}

interface PreparedMarket {
  polymarketId: string;
  event: Record<string, unknown>;
  /** Ausente quando o market ainda não tem os dois lados do book. */
  quote: {
    outcomes: [string, string];
    bestBid: number;
    bestAsk: number;
    spread: number | null;
    volume24h: number;
  } | null;
}

/** Monta as linhas de um market sem tocar no banco — a escrita acontece em lote. */
function prepareMarket(market: GammaMarket): PreparedMarket | null {
  try {
    const startDate = (market as any).startDate as string | undefined;
    if (!startDate) return null;

    const volume24h = Number(market.volume24hr ?? market.volume24hrClob ?? 0);
    const liquidity = Number(market.liquidityNum ?? market.liquidity ?? 0);

    // Markets recém-criados ainda sem volume; apenas filtra liquidez mínima.
    if (liquidity < 500) return null;

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

    const bestBid = market.bestBid;
    const bestAsk = market.bestAsk;
    const [primary, secondary] = outcomes;

    // Sem os dois lados do book, ou com outcomes malformados, grava só o event.
    // Uma linha inválida derrubaria o chunk inteiro de snapshots.
    const quote =
      bestBid != null && bestAsk != null && primary != null && secondary != null
        ? {
            outcomes: [primary, secondary] as [string, string],
            bestBid,
            bestAsk,
            spread: market.spread ?? null,
            volume24h,
          }
        : null;

    return { polymarketId: market.id, event, quote };
  } catch {
    return null;
  }
}

function buildSnapshotPair(eventId: string, quote: NonNullable<PreparedMarket['quote']>): Record<string, unknown>[] {
  const { outcomes, bestBid, bestAsk, spread, volume24h } = quote;
  const midPrimary = (bestBid + bestAsk) / 2;

  return [
    {
      event_id: eventId,
      outcome: outcomes[0],
      best_bid: bestBid,
      best_ask: bestAsk,
      mid_price: midPrimary,
      spread,
      volume_24h: volume24h,
    },
    {
      event_id: eventId,
      outcome: outcomes[1],
      best_bid: 1 - bestAsk,
      best_ask: 1 - bestBid,
      mid_price: 1 - midPrimary,
      spread,
      volume_24h: volume24h,
    },
  ];
}

async function _collect(): Promise<void> {
  const startedAt = Date.now();
  const cutoffIso = new Date(Date.now() - NEW_MARKET_WINDOW_HOURS * 60 * 60 * 1000).toISOString();

  let allMarkets: GammaMarket[] = [];
  let offset = 0;
  let paginationFailed = false;
  let paginationError: string | null = null;

  const MAX_PAGES = 150;
  let pageCount = 0;

  while (true) {
    pageCount++;
    if (pageCount > MAX_PAGES) {
      paginationFailed = true;
      paginationError = `Hit max pages cap (${MAX_PAGES})`;
      break;
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    try {
      const url = `${GAMMA_URL}/markets?ascending=false&order=startDate&limit=500&offset=${offset}`;
      const res = await fetch(url, { signal: controller.signal });
      if (!res.ok) {
        paginationFailed = true;
        paginationError = `HTTP ${res.status} at offset ${offset}`;
        break;
      }

      const batch = (await res.json()) as GammaMarket[];
      if (batch.length === 0) break;

      const inWindow = batch.filter(m => {
        const startDate = (m as any).startDate as string | undefined;
        if (!startDate || startDate < cutoffIso) return false;
        if (!m.active || m.closed) return false;

        const liquidity = Number(m.liquidityNum ?? m.liquidity ?? 0);
        // Markets recém-criados não têm volume24hr ainda (precisa acumular).
        // Apenas filtra por liquidity mínima (precisa ter orderbook funcional).
        if (liquidity < 500) return false;

        return true;
      });

      allMarkets = allMarkets.concat(inWindow);

      const lastMarket = batch[batch.length - 1];
      const lastStartDate = (lastMarket as any)?.startDate as string | undefined;
      if (!lastStartDate || lastStartDate < cutoffIso) break;

      offset += batch.length;
      if (batch.length < 100) break;
    } catch (err) {
      paginationFailed = true;
      paginationError = `${String(err)} at offset ${offset}`;
      break;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  // Duplicatas entre páginas quebrariam o upsert em lote: ON CONFLICT DO UPDATE
  // não pode afetar a mesma linha duas vezes na mesma instrução.
  const uniqueMarkets = dedupeByKey(allMarkets, m => m.id);
  const prepared = uniqueMarkets
    .map(prepareMarket)
    .filter((p): p is PreparedMarket => p !== null);

  console.log(`[early-markets] Writing ${prepared.length} markets in batch...`);

  const writeErrors: string[] = [];

  const eventsResult = await batchUpsert<{ id: string; polymarket_id: string }>(
    'events',
    prepared.map(p => p.event),
    {
      onConflict: 'polymarket_id',
      select: 'id, polymarket_id',
      chunkSize: EVENTS_CHUNK_SIZE,
      label: 'early_markets',
    },
  );
  writeErrors.push(...eventsResult.errors);

  const upserted = eventsResult.rows.length;
  const eventIdByPolymarketId = new Map(eventsResult.rows.map(row => [row.polymarket_id, row.id]));

  const snapshotRows: Record<string, unknown>[] = [];
  for (const p of prepared) {
    const eventId = eventIdByPolymarketId.get(p.polymarketId);
    // Ausente significa que o chunk do event falhou — sem id para o snapshot.
    if (!eventId || !p.quote) continue;
    snapshotRows.push(...buildSnapshotPair(eventId, p.quote));
  }

  const snapResult = await batchInsert('polymarket_snapshots', snapshotRows, { label: 'early_markets' });
  writeErrors.push(...snapResult.errors);
  const snapshotsInserted = snapResult.written;

  await supabase
    .from('events')
    .update({ is_new_market: false })
    .eq('is_new_market', true)
    .lt('start_date', cutoffIso);

  const durationMs = Date.now() - startedAt;
  const status = paginationFailed || writeErrors.length > 0 ? 'partial' : 'success';
  const messagePrefix = paginationFailed
    ? `Pagination aborted (${paginationError}), processed what was collected: `
    : '';
  await logEvent({
    component: 'early_markets_collector',
    status,
    message: `${messagePrefix}Found ${allMarkets.length} new markets (<24h), upserted ${upserted}, ${snapshotsInserted} snapshots in ${durationMs}ms`,
    metadata: {
      total_found: allMarkets.length,
      unique_markets: uniqueMarkets.length,
      prepared: prepared.length,
      upserted,
      snapshots: snapshotsInserted,
      duration_ms: durationMs,
      pagination_failed: paginationFailed,
      pagination_error: paginationError,
      write_errors: writeErrors.length > 0 ? writeErrors.slice(0, 10) : null,
    },
  });
}
