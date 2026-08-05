import { supabase } from '../lib/supabase.js';
import { fetchActiveMarkets, GammaHttpError } from '../lib/polymarket-api.js';
import { gammaToEvent } from '../lib/normalize.js';
import { getSystemConfig } from '../lib/config.js';
import { logEvent } from '../lib/logger.js';
import { batchUpsert, dedupeByKey, EVENTS_CHUNK_SIZE } from '../lib/batch-write.js';
import { CycleLock } from '../lib/cycle-lock.js';
import {
  gammaLiquidity,
  gammaVolume24h,
  writeEsportsSnapshots,
  type EsportsSnapshotRow,
} from '../lib/esports-snapshots.js';
import type { GammaMarket } from '../types/index.js';

/**
 * Descoberta por startDate (spec 000, item 2a).
 *
 * A varredura por volume ordena por `volume24hr` e só alcança as ~2000 primeiras
 * posições. Mercado de esports nasce com volume 0 e liquidez 0 — fica no fundo
 * dessa ordenação, fora de alcance permanente. Aqui a ordenação é por `startDate`
 * decrescente: o market recém-criado está na primeira página, sempre.
 *
 * Este coletor NÃO substitui a varredura por volume nesta etapa — os dois rodam
 * juntos de propósito, para comparar o que cada um enxerga. A troca é o item 4.
 *
 * Sem filtro de volume ou liquidez: filtrar por isso é exatamente o que cega os
 * outros coletores para o mercado no minuto em que ele nasce.
 */

const PAGE_SIZE = 100;

/**
 * Teto de offset da Gamma é 2000 (spec 000, item 2). 20 páginas encostam nele —
 * mais que isso é requisição garantida em 422.
 */
const MAX_PAGES = 20;

/**
 * A ordenação por startDate não é estritamente monótona entre páginas (medido:
 * uma página cobria 16:30→16:16 enquanto a seguinte começava em 16:02). A margem
 * evita que um degrau desses corte a paginação cedo demais.
 */
const WATERMARK_OVERLAP_MS = 2 * 60_000;

/**
 * Parada do spec: N markets consecutivos já presentes em `events`. Na prática
 * dispara em período calmo — em rajada de criação a parada que vale é a de tempo.
 */
const KNOWN_STREAK_STOP = 500;

const CYCLE_TIMEOUT_MS = 120_000;

type StopReason =
  | 'watermark'
  | 'known_streak'
  | 'empty_page'
  | 'offset_ceiling'
  | 'page_cap'
  | 'fetch_error';

/**
 * Onde a descoberta anterior parou. Em memória de propósito: um deploy zera e o
 * ciclo cai no lookback frio, que é o comportamento correto para um processo novo.
 */
let watermarkStartDate: string | null = null;

const cycleLock = new CycleLock();

/**
 * Formato de partida: `{prefixo}{codA}-{codB}[-{data}][-{variante}]`.
 * Confirmado na API: `cs2-mana1-bw-2026-08-04`, `cs2-mana1-bw-2026-08-04-game1`.
 *
 * Sem dois times não há partida. Mercado de qualificação
 * (`will-furia-qualify-for-the-cblol-...`) nem chega aqui: não bate prefixo.
 */
export function hasMatchShape(slug: string, prefix: string): boolean {
  const rest = slug.slice(prefix.length);
  return rest.split('-').filter(Boolean).length >= 2;
}

export function matchedPrefix(slug: string, prefixes: readonly string[]): string | null {
  return prefixes.find(p => slug.startsWith(p)) ?? null;
}

/**
 * Até onde o ciclo pagina para trás.
 *
 * A marca d'água do ciclo anterior é o normal; o lookback é o piso do ciclo frio.
 * O `max` entre os dois é o que impede a descoberta de tentar alcançar um
 * horizonte que está atrás do teto de offset — ela pagina até 2000 e não chega lá.
 */
export function resolveCutoffMs(
  nowMs: number,
  watermark: string | null,
  lookbackMinutes: number,
): { cutoffMs: number; coldStart: boolean } {
  const lookbackFloorMs = nowMs - lookbackMinutes * 60_000;
  const watermarkMs = watermark ? Date.parse(watermark) : NaN;

  if (Number.isNaN(watermarkMs)) return { cutoffMs: lookbackFloorMs, coldStart: true };

  return {
    cutoffMs: Math.max(lookbackFloorMs, watermarkMs - WATERMARK_OVERLAP_MS),
    coldStart: false,
  };
}

interface PreparedMarket {
  polymarketId: string;
  event: Record<string, unknown>;
  /** Ausente enquanto o market não tem os dois lados do book — o normal ao nascer. */
  quote: {
    outcomes: [string, string];
    bestBid: number;
    bestAsk: number;
    volume24h: number | null;
    liquidity: number | null;
  } | null;
}

function prepareMarket(market: GammaMarket): PreparedMarket | null {
  try {
    const event: Record<string, unknown> = {
      ...gammaToEvent(market),
      start_date: market.startDate ?? null,
    };

    // Removidos de propósito: a descoberta não tem o que dizer sobre nenhum dos
    // dois, e mandá-los como null apagaria no upsert o que o categorizador e o
    // auto-resolver escreveram.
    delete event['sub_category'];
    delete event['resolved_outcome'];

    const outcomes = JSON.parse(market.outcomes) as string[];
    const [primary, secondary] = outcomes;
    const bestBid = market.bestBid;
    const bestAsk = market.bestAsk;

    const quote =
      bestBid != null && bestAsk != null && primary != null && secondary != null
        ? {
            outcomes: [primary, secondary] as [string, string],
            bestBid,
            bestAsk,
            volume24h: gammaVolume24h(market),
            // O primeiro ponto da curva de liquidez: é aqui que o market nasce,
            // com os ~US$ 17 que a varredura por volume nunca chegou a ver.
            liquidity: gammaLiquidity(market),
          }
        : null;

    return { polymarketId: market.id, event, quote };
  } catch {
    // outcomes/outcomePrices malformados: uma linha inválida derrubaria o chunk.
    return null;
  }
}

/**
 * `capturedAt` explícito em vez do default do banco: em tabela particionada é o
 * valor da linha que escolhe a partição, e deixá-lo a cargo do servidor é abrir
 * mão de saber em qual dia a linha caiu.
 */
function buildSnapshotPair(
  eventId: string,
  quote: NonNullable<PreparedMarket['quote']>,
  capturedAt: string,
): EsportsSnapshotRow[] {
  const { outcomes, bestBid, bestAsk, volume24h, liquidity } = quote;
  const mid = (bestBid + bestAsk) / 2;

  return [
    {
      event_id: eventId,
      outcome: outcomes[0],
      best_bid: bestBid,
      best_ask: bestAsk,
      mid_price: mid,
      volume_24h: volume24h,
      liquidity,
      captured_at: capturedAt,
    },
    {
      event_id: eventId,
      outcome: outcomes[1],
      best_bid: 1 - bestAsk,
      best_ask: 1 - bestBid,
      mid_price: 1 - mid,
      volume_24h: volume24h,
      liquidity,
      captured_at: capturedAt,
    },
  ];
}

/**
 * `events.discovered_via` só existe depois da migration 20260804165019.
 *
 * A descoberta não pode depender dela para gravar: entre o deploy e o apply,
 * mandar a coluna no payload derrubaria todo chunk de `events`. Daí a sondagem.
 *
 * O resultado negativo tem validade curta de propósito — a migration é aplicada
 * à mão, sem redeploy, e um cache negativo eterno faria o carimbo nunca começar.
 */
const PROBE_RETRY_MS = 10 * 60_000;

let discoveredViaSupported: boolean | null = null;
let discoveredViaProbedAt = 0;

async function supportsDiscoveredVia(): Promise<boolean> {
  const now = Date.now();
  if (discoveredViaSupported === true) return true;
  if (discoveredViaSupported === false && now - discoveredViaProbedAt < PROBE_RETRY_MS) return false;

  const { error } = await supabase.from('events').select('discovered_via').limit(1);
  discoveredViaProbedAt = now;
  discoveredViaSupported = !error;

  if (error) {
    console.warn(`[discovery] events.discovered_via indisponível (${error.message}) — gravando sem o carimbo`);
  } else {
    console.log('[discovery] events.discovered_via disponível — carimbando markets novos');
  }

  return discoveredViaSupported;
}

/**
 * Separa as linhas que levam `discovered_via` das que não levam.
 *
 * `discovered_via` marca quem viu primeiro: na linha que já existia a chave é
 * omitida, porque mandá-la sobrescreveria o carimbo original a cada ciclo. E um
 * upsert do PostgREST exige o mesmo conjunto de chaves em todas as linhas do
 * lote — "com carimbo" e "sem carimbo" não cabem na mesma chamada.
 *
 * Com `stamp = false` (coluna ainda não aplicada) ninguém leva a chave, e a
 * escrita é exatamente a de antes da coluna existir.
 */
export function splitForUpsert(
  prepared: readonly { polymarketId: string; event: Record<string, unknown> }[],
  newPolymarketIds: ReadonlySet<string>,
  stamp: boolean,
): { firstSeen: Record<string, unknown>[]; alreadyKnown: Record<string, unknown>[] } {
  const firstSeen: Record<string, unknown>[] = [];
  const alreadyKnown: Record<string, unknown>[] = [];

  for (const p of prepared) {
    if (stamp && newPolymarketIds.has(p.polymarketId)) {
      firstSeen.push({ ...p.event, discovered_via: 'discovery' });
    } else {
      alreadyKnown.push(p.event);
    }
  }

  return { firstSeen, alreadyKnown };
}

/** Quais destes polymarket_ids já estão em `events`. Uma query por página. */
async function fetchKnownIds(polymarketIds: string[]): Promise<Set<string>> {
  if (polymarketIds.length === 0) return new Set();

  const { data, error } = await supabase
    .from('events')
    .select('polymarket_id')
    .in('polymarket_id', polymarketIds);

  if (error) {
    // Sem a resposta não dá para afirmar que algo é conhecido. Tratar tudo como
    // novo mantém a paginação andando (a parada de tempo continua valendo) em
    // vez de encerrar o ciclo por uma falha de leitura.
    console.error(`[discovery] known-ids lookup failed: ${error.message}`);
    return new Set();
  }

  return new Set((data ?? []).map(row => row.polymarket_id as string));
}

export async function collectDiscovery(): Promise<void> {
  const lockToken = cycleLock.tryAcquire();

  if (!lockToken) {
    await logEvent({
      component: 'discovery_collector',
      status: 'partial',
      message: 'previous cycle still running, skipping this tick',
      metadata: { previous_cycle_running_for_ms: cycleLock.heldForMs() ?? 0 },
    });
    return;
  }

  if (lockToken.staleTakeoverMs !== null) {
    const stuckMinutes = Math.round(lockToken.staleTakeoverMs / 60000);
    console.warn(`[discovery] Previous cycle stuck for ${stuckMinutes}min — assuming dead, starting a new one`);
    await logEvent({
      component: 'discovery_collector',
      status: 'partial',
      message: `WARNING: previous cycle stuck for ${stuckMinutes}min — assumed dead, starting a new one`,
      metadata: { stuck_for_ms: lockToken.staleTakeoverMs },
    });
  }

  // O lock é solto quando o trabalho real termina, não quando a race termina:
  // soltar no timeout deixaria o próximo tick rodar em cima do ciclo zumbi.
  const cyclePromise = _collect().finally(() => cycleLock.release(lockToken));

  const timeoutPromise = new Promise<void>((_, reject) =>
    setTimeout(() => reject(new Error('cycle timeout 120s')), CYCLE_TIMEOUT_MS),
  );

  try {
    await Promise.race([cyclePromise, timeoutPromise]);
  } catch (err) {
    await logEvent({
      component: 'discovery_collector',
      status: 'error',
      message: `Discovery cycle failed: ${err instanceof Error ? err.message : String(err)}`,
      metadata: { error: String(err) },
    });
  }
}

async function _collect(): Promise<void> {
  const startedAt = Date.now();
  const config = await getSystemConfig();

  const prefixes = (config.discovery_slug_prefixes ?? []).filter(p => p.length > 0);
  if (prefixes.length === 0) {
    // Lista vazia é o desligamento pela config, não um bug.
    await logEvent({
      component: 'discovery_collector',
      status: 'success',
      message: 'Discovery disabled: discovery_slug_prefixes is empty',
    });
    return;
  }

  const lookbackMinutes = config.discovery_lookback_minutes ?? 20;
  const { cutoffMs, coldStart } = resolveCutoffMs(startedAt, watermarkStartDate, lookbackMinutes);

  let offset = 0;
  let pageCount = 0;
  let scanned = 0;
  let knownStreak = 0;
  let candidatesNew = 0;
  let candidatesKnown = 0;
  let rejectedShape = 0;
  let missingStartDate = 0;
  let stopReason: StopReason = 'page_cap';
  let newestStartDate: string | null = null;
  let paginationError: string | null = null;

  const seenIds = new Set<string>();
  const newPolymarketIds = new Set<string>();
  const candidates: GammaMarket[] = [];
  // O instante da resposta da página em que o market apareceu. Um timestamp
  // único no fim do ciclo empilharia até 20 páginas no mesmo ponto da série.
  const capturedAtById = new Map<string, string>();

  while (pageCount < MAX_PAGES) {
    let page: GammaMarket[];
    try {
      page = await fetchActiveMarkets({
        limit: PAGE_SIZE,
        offset,
        order: 'startDate',
        ascending: false,
      });
    } catch (err) {
      // 422 em offset alto é o teto da API, não falha do ciclo (item 0).
      if (err instanceof GammaHttpError && err.status === 422 && offset > 0) {
        stopReason = 'offset_ceiling';
        break;
      }
      // Qualquer outra falha encerra a paginação, mas não o ciclo: os markets
      // já coletados são gravados abaixo em vez de sumirem com a exceção.
      paginationError = `${err instanceof Error ? err.message : String(err)} at offset ${offset}`;
      stopReason = 'fetch_error';
      break;
    }

    pageCount++;
    const pageCapturedAt = new Date().toISOString();
    if (page.length === 0) {
      stopReason = 'empty_page';
      break;
    }

    scanned += page.length;

    const known = await fetchKnownIds(page.map(m => m.id));
    let oldestOnPage: number | null = null;

    for (const market of page) {
      if (known.has(market.id)) knownStreak++;
      else knownStreak = 0;

      const startMs = market.startDate ? Date.parse(market.startDate) : NaN;
      if (Number.isNaN(startMs)) {
        missingStartDate++;
      } else {
        if (oldestOnPage === null || startMs < oldestOnPage) oldestOnPage = startMs;
        if (newestStartDate === null || startMs > Date.parse(newestStartDate)) {
          newestStartDate = market.startDate ?? null;
        }
      }

      const prefix = matchedPrefix(market.slug, prefixes);
      if (prefix === null) continue;

      if (!hasMatchShape(market.slug, prefix)) {
        rejectedShape++;
        continue;
      }

      // A mesma página pode reaparecer no offset seguinte: a lista se desloca a
      // cada market criado. Sem isso, o upsert recebe a mesma linha duas vezes.
      if (seenIds.has(market.id)) continue;
      seenIds.add(market.id);
      capturedAtById.set(market.id, pageCapturedAt);

      if (known.has(market.id)) {
        candidatesKnown++;
      } else {
        candidatesNew++;
        newPolymarketIds.add(market.id);
      }

      candidates.push(market);
    }

    if (knownStreak >= KNOWN_STREAK_STOP) {
      stopReason = 'known_streak';
      break;
    }

    if (oldestOnPage !== null && oldestOnPage < cutoffMs) {
      stopReason = 'watermark';
      break;
    }

    offset += page.length;
  }

  const prepared = dedupeByKey(candidates, m => m.id)
    .map(prepareMarket)
    .filter((p): p is PreparedMarket => p !== null);

  const writeErrors: string[] = [];
  const stampDiscoveredVia = await supportsDiscoveredVia();

  const { firstSeen: firstSeenRows, alreadyKnown: alreadyKnownRows } = splitForUpsert(
    prepared,
    newPolymarketIds,
    stampDiscoveredVia,
  );

  const upsertEvents = (rows: Record<string, unknown>[]) =>
    batchUpsert<{ id: string; polymarket_id: string }>('events', rows, {
      onConflict: 'polymarket_id',
      select: 'id, polymarket_id',
      chunkSize: EVENTS_CHUNK_SIZE,
      label: 'discovery',
    });

  const [firstSeenResult, knownResult] = await Promise.all([
    upsertEvents(firstSeenRows),
    upsertEvents(alreadyKnownRows),
  ]);

  const eventsResult = {
    rows: [...firstSeenResult.rows, ...knownResult.rows],
    failedRows: firstSeenResult.failedRows + knownResult.failedRows,
    errors: [...firstSeenResult.errors, ...knownResult.errors],
  };
  writeErrors.push(...eventsResult.errors);

  const eventIdByPolymarketId = new Map(eventsResult.rows.map(row => [row.polymarket_id, row.id]));

  const snapshotRows: EsportsSnapshotRow[] = [];
  for (const p of prepared) {
    const eventId = eventIdByPolymarketId.get(p.polymarketId);
    // Ausente significa que o chunk do event falhou — sem id para pendurar o snapshot.
    if (!eventId || !p.quote) continue;
    const capturedAt = capturedAtById.get(p.polymarketId) ?? new Date().toISOString();
    snapshotRows.push(...buildSnapshotPair(eventId, p.quote, capturedAt));
  }

  // Item 3: a série de esports vive em `esports_snapshots`, particionada por dia.
  // O primeiro ponto dela é este — o market no minuto em que nasceu.
  const snapResult = await writeEsportsSnapshots(snapshotRows, 'discovery');
  writeErrors.push(...snapResult.errors);

  // A marca não avança quando a paginação morreu no meio: o trecho que ficou
  // para trás é alcançável na próxima tentativa, e avançar abriria um buraco.
  // Teto de offset e limite de páginas avançam mesmo assim — ali o horizonte é
  // inalcançável por construção, e insistir gastaria 20 páginas por ciclo, sempre.
  if (newestStartDate !== null && stopReason !== 'fetch_error') {
    watermarkStartDate = newestStartDate;
  }

  const durationMs = Date.now() - startedAt;
  const truncated =
    stopReason === 'offset_ceiling' || stopReason === 'page_cap' || stopReason === 'fetch_error';
  const status = writeErrors.length > 0 || truncated ? 'partial' : 'success';

  await logEvent({
    component: 'discovery_collector',
    status,
    message:
      `Discovery: ${scanned} markets em ${pageCount} páginas, ${candidatesNew} novos + ` +
      `${candidatesKnown} já conhecidos, ${eventsResult.rows.length} upserted, ` +
      `${snapResult.written} snapshots (stop: ${stopReason})`,
    metadata: {
      scanned,
      pages: pageCount,
      stop_reason: stopReason,
      pagination_error: paginationError,
      cold_start: coldStart,
      cutoff_at: new Date(cutoffMs).toISOString(),
      watermark_at: watermarkStartDate,
      prefixes,
      // A comparação com a varredura por volume: quantos destes o ranking
      // de volume nunca tinha visto.
      candidates_new: candidatesNew,
      candidates_known: candidatesKnown,
      // false = migration 20260804165019 ainda não aplicada; a descoberta grava
      // igual, só não carimba.
      stamped_discovered_via: stampDiscoveredVia,
      first_seen_upserted: firstSeenResult.rows.length,
      rejected_no_match_shape: rejectedShape,
      missing_start_date: missingStartDate,
      upserted_events: eventsResult.rows.length,
      failed_event_rows: eventsResult.failedRows,
      snapshots: snapResult.written,
      // 'polymarket_snapshots' = migration 20260805142957 ainda não aplicada.
      snapshot_table: snapResult.table,
      duration_ms: durationMs,
      write_errors: writeErrors.length > 0 ? writeErrors.slice(0, 10) : null,
    },
  });

  console.log(
    `[discovery] ${scanned} scanned / ${candidatesNew} new esports markets / ` +
      `${eventsResult.rows.length} upserted (stop: ${stopReason}, ${durationMs}ms)`,
  );
}
