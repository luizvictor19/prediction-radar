import { supabase } from '../lib/supabase.js';
import {
  fetchEsportsEvents,
  fetchEventsBySlugs,
  GammaHttpError,
  MAX_EVENTS_PER_REQUEST,
} from '../lib/polymarket-api.js';
import { gammaToEvent } from '../lib/normalize.js';
import { ColumnProbe } from '../lib/column-probe.js';
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
import type { GammaMarket, GammaEvent } from '../types/index.js';

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
 *
 * ## Por que `/events` e não `/markets`
 *
 * A paginação é por evento, não por market. Três razões, medidas em 2026-08-06:
 *
 * 1. `teams[]` e `sport` só existem em `/events`. São a resolução de entidade
 *    exata — `abbreviation` bate com o código do slug em 2307/2307 — e o embed
 *    de `/markets` não traz nenhum dos dois.
 * 2. O teto de offset deixa de ser recurso compartilhado. Paginando `/markets`
 *    as 20 páginas atravessam política e cripto para achar esports; com
 *    `tag_slug=esports` o universo paginado já é só esports — 790 eventos
 *    abertos cabem em 8 chamadas.
 * 3. Sai mais barato por market: 4,2 KB contra 6,3 KB, porque `/markets` repete
 *    o embed `events[]` em cada linha.
 *
 * A tag delimita o universo; quem decide o que é coletado continua sendo
 * `discovery_slug_prefixes`, aplicado market a market. Trocar o filtro pela tag
 * transferiria a decisão para um vocabulário da Polymarket que não controlamos.
 */

const PAGE_SIZE = 100;

/**
 * Teto de offset da Gamma é 2000 (spec 000, item 2). 20 páginas encostam nele —
 * mais que isso é requisição garantida em 422. Em `/events` a borda é um pouco
 * diferente: offset 2000 devolve lista vazia e 2500 responde 422. Os dois casos
 * são fim de paginação.
 */
const MAX_PAGES = 20;

/**
 * Tamanho do lote na consulta de ids já conhecidos.
 *
 * Uma página de 100 eventos carrega ~1000 markets (mediana de 11 por evento,
 * máximo observado 64). Um `in` com mil valores vira URL de ~10 KB e é rejeitada
 * antes de chegar ao Postgres.
 */
const KNOWN_IDS_CHUNK = 200;

/**
 * Parada por sequência de eventos já conhecidos, em eventos e não em markets.
 *
 * O limiar era 500 markets consecutivos, quando a página tinha 100 markets.
 * Página de evento traz ~1000, e manter a contagem em markets faria a parada
 * disparar no meio da primeira página — dez vezes mais cedo, em cobertura.
 * 50 eventos são da mesma ordem de grandeza que os 500 markets de antes.
 */
const KNOWN_EVENT_STREAK_STOP = 50;

/**
 * Intervalo mínimo entre varreduras de eventos pendentes.
 *
 * A janela sai da distribuição medida do atraso de criação: 8 de 288 markets
 * nascem mais de 10 min depois do evento pai. Rodar a cada ciclo (3 min) não
 * acharia praticamente nada de novo entre uma e outra.
 */
const PENDING_SWEEP_INTERVAL_MS = 10 * 60_000;

/**
 * Teto de linhas lidas de `events` para montar a lista de pendentes.
 *
 * São ~10 markets por evento, então mil linhas cobrem com folga os ~214 eventos
 * com jogo no futuro medidos em 2026-08-06. A ordenação por `game_start_time`
 * ascendente faz o corte, quando houver, cair sempre no jogo mais distante —
 * que é o que menos urge e reaparece nos ciclos seguintes.
 */
const PENDING_ROW_LIMIT = 1000;

/**
 * A ordenação por startDate não é estritamente monótona entre páginas (medido:
 * uma página cobria 16:30→16:16 enquanto a seguinte começava em 16:02). A margem
 * evita que um degrau desses corte a paginação cedo demais.
 */
const WATERMARK_OVERLAP_MS = 2 * 60_000;

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

/**
 * Quando a varredura de pendentes rodou pela última vez. Em memória pelo mesmo
 * motivo da marca d'água: um deploy zera e o próximo ciclo varre, que é o
 * comportamento correto para um processo novo.
 */
let lastPendingSweepMs = 0;

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

function prepareMarket(market: GammaMarket, parent: GammaEvent | null): PreparedMarket | null {
  try {
    const event: Record<string, unknown> = {
      ...gammaToEvent(market, 'other', parent),
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
 * Duas colunas que o código usa antes de a migration ser aplicada à mão:
 * `discovered_via` (20260804165019) e `game_start_time` (20260806015533).
 *
 * A descoberta não pode depender de nenhuma das duas para gravar — mandar coluna
 * inexistente no payload derruba todo chunk de `events`. Daí a sondagem.
 */
const discoveredViaProbe = new ColumnProbe('events', 'discovered_via', 'discovery');
const gameStartTimeProbe = new ColumnProbe('events', 'game_start_time', 'discovery');

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

/** Quais destes polymarket_ids já estão em `events`. */
async function fetchKnownIds(polymarketIds: readonly string[]): Promise<Set<string>> {
  if (polymarketIds.length === 0) return new Set();

  const known = new Set<string>();

  for (let i = 0; i < polymarketIds.length; i += KNOWN_IDS_CHUNK) {
    const chunk = polymarketIds.slice(i, i + KNOWN_IDS_CHUNK);
    const { data, error } = await supabase
      .from('events')
      .select('polymarket_id')
      .in('polymarket_id', chunk);

    if (error) {
      // Sem a resposta não dá para afirmar que algo é conhecido. Tratar tudo como
      // novo mantém a paginação andando (a parada de tempo continua valendo) em
      // vez de encerrar o ciclo por uma falha de leitura. O conjunto sai vazio, e
      // não parcial, para que a sequência de conhecidos não pare a paginação com
      // base num lote que faltou.
      console.error(`[discovery] known-ids lookup failed: ${error.message}`);
      return new Set();
    }

    for (const row of data ?? []) known.add(row.polymarket_id as string);
  }

  return known;
}

/** Um market candidato junto do evento de onde ele veio. */
interface Candidate {
  market: GammaMarket;
  parent: GammaEvent;
}

/**
 * Extrai de uma lista de eventos os markets que a config manda coletar.
 *
 * `seenIds` atravessa as duas varreduras do ciclo de propósito: a de pendentes
 * revisita eventos que a paginação pode ter acabado de ver, e sem isso a mesma
 * linha entraria duas vezes no upsert.
 */
export function harvestEvents(
  events: readonly GammaEvent[],
  prefixes: readonly string[],
  seenIds: Set<string>,
  capturedAtById: Map<string, string>,
  capturedAt: string,
): { candidates: Candidate[]; rejectedShape: number } {
  const candidates: Candidate[] = [];
  let rejectedShape = 0;

  for (const event of events) {
    for (const market of event.markets ?? []) {
      const prefix = matchedPrefix(market.slug, prefixes);
      if (prefix === null) continue;

      if (!hasMatchShape(market.slug, prefix)) {
        rejectedShape++;
        continue;
      }

      if (seenIds.has(market.id)) continue;
      seenIds.add(market.id);
      capturedAtById.set(market.id, capturedAt);

      candidates.push({ market, parent: event });
    }
  }

  return { candidates, rejectedShape };
}

/**
 * Slugs de evento cujo jogo ainda não começou.
 *
 * `null` significa "não dá para montar a lista" — coluna ausente ou leitura que
 * falhou — e é diferente de lista vazia, que é uma resposta legítima.
 */
async function fetchPendingEventSlugs(): Promise<string[] | null> {
  // Sem `game_start_time` não há como saber qual jogo ainda não começou, e
  // revisitar todo evento aberto seria varrer o universo inteiro a cada 10 min.
  if (!(await gameStartTimeProbe.isSupported())) return null;

  const { data, error } = await supabase
    .from('events')
    .select('event_group_slug')
    .eq('status', 'active')
    .not('event_group_slug', 'is', null)
    .gt('game_start_time', new Date().toISOString())
    .order('game_start_time', { ascending: true })
    .limit(PENDING_ROW_LIMIT);

  if (error) {
    console.error(`[discovery] pending-events lookup failed: ${error.message}`);
    return null;
  }

  return [...new Set((data ?? []).map(row => row.event_group_slug as string))];
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
  let eventsScanned = 0;
  let knownEventStreak = 0;
  let candidatesNew = 0;
  let candidatesKnown = 0;
  let rejectedShape = 0;
  let missingStartDate = 0;
  let stopReason: StopReason = 'page_cap';
  let newestStartDate: string | null = null;
  let paginationError: string | null = null;

  const seenIds = new Set<string>();
  const newPolymarketIds = new Set<string>();
  const candidates: Candidate[] = [];
  // O instante da resposta da página em que o market apareceu. Um timestamp
  // único no fim do ciclo empilharia até 20 páginas no mesmo ponto da série.
  const capturedAtById = new Map<string, string>();

  /** Classifica em novo/conhecido e acumula. Comum às duas varreduras. */
  const absorb = (found: Candidate[], known: ReadonlySet<string>): void => {
    for (const candidate of found) {
      if (known.has(candidate.market.id)) candidatesKnown++;
      else {
        candidatesNew++;
        newPolymarketIds.add(candidate.market.id);
      }
      candidates.push(candidate);
    }
  };

  while (pageCount < MAX_PAGES) {
    let page: GammaEvent[];
    try {
      page = await fetchEsportsEvents({
        limit: PAGE_SIZE,
        offset,
        order: 'startDate',
        ascending: false,
        closed: false,
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

    eventsScanned += page.length;
    const pageMarkets = page.flatMap(event => event.markets ?? []);
    scanned += pageMarkets.length;

    const known = await fetchKnownIds(pageMarkets.map(m => m.id));
    let oldestOnPage: number | null = null;

    for (const event of page) {
      // A sequência conta eventos inteiramente conhecidos: o eixo da paginação
      // agora é o evento, e um evento sem market nenhum não diz nada sobre a
      // fronteira — não quebra a sequência nem a alimenta.
      const eventMarkets = event.markets ?? [];
      if (eventMarkets.length > 0 && eventMarkets.every(m => known.has(m.id))) {
        knownEventStreak++;
      } else if (eventMarkets.length > 0) {
        knownEventStreak = 0;
      }

      const startMs = event.startDate ? Date.parse(event.startDate) : NaN;
      if (Number.isNaN(startMs)) {
        missingStartDate++;
      } else {
        if (oldestOnPage === null || startMs < oldestOnPage) oldestOnPage = startMs;
        if (newestStartDate === null || startMs > Date.parse(newestStartDate)) {
          newestStartDate = event.startDate ?? null;
        }
      }
    }

    // A mesma página pode reaparecer no offset seguinte: a lista se desloca a
    // cada evento criado. `seenIds` dentro de `harvestEvents` é o que impede a
    // mesma linha de entrar duas vezes no upsert.
    const harvest = harvestEvents(page, prefixes, seenIds, capturedAtById, pageCapturedAt);
    rejectedShape += harvest.rejectedShape;
    absorb(harvest.candidates, known);

    if (knownEventStreak >= KNOWN_EVENT_STREAK_STOP) {
      stopReason = 'known_streak';
      break;
    }

    if (oldestOnPage !== null && oldestOnPage < cutoffMs) {
      stopReason = 'watermark';
      break;
    }

    offset += page.length;
  }

  // --- Varredura de eventos pendentes -------------------------------------
  //
  // A paginação por `startDate` do evento só o enxerga no minuto em que nasce.
  // Medido em 2026-08-06 sobre 288 markets: a mediana nasce junto do pai (lag
  // zero), mas o p99 é de 411 min e o maior observado, 491. Um mercado derivado
  // aberto 8h depois entra num evento que a marca d'água já ultrapassou — sem
  // esta varredura ele nunca seria descoberto.
  //
  // O conjunto a revisitar é pequeno e bem definido: evento cujo jogo ainda não
  // começou. Medido: 214 de 790 eventos abertos, 3 chamadas de 100 slugs.
  let pendingEvents = 0;
  let pendingRequests = 0;
  let pendingError: string | null = null;
  let pendingSkipped: string | null = null;

  if (startedAt - lastPendingSweepMs < PENDING_SWEEP_INTERVAL_MS) {
    pendingSkipped = 'interval';
  } else {
    const slugs = await fetchPendingEventSlugs();

    if (slugs === null) {
      // Coluna ausente ou leitura falha. Não é erro de ciclo: a paginação já
      // rodou e grava normalmente. Mas a marca não avança, para que a próxima
      // tentativa seja imediata em vez de esperar o intervalo.
      pendingSkipped = 'unavailable';
    } else {
      lastPendingSweepMs = startedAt;

      for (let i = 0; i < slugs.length; i += MAX_EVENTS_PER_REQUEST) {
        const chunk = slugs.slice(i, i + MAX_EVENTS_PER_REQUEST);
        try {
          const events = await fetchEventsBySlugs(chunk, { closed: false });
          pendingRequests++;
          pendingEvents += events.length;

          const capturedAt = new Date().toISOString();
          const harvest = harvestEvents(events, prefixes, seenIds, capturedAtById, capturedAt);
          rejectedShape += harvest.rejectedShape;

          const known = await fetchKnownIds(harvest.candidates.map(c => c.market.id));
          absorb(harvest.candidates, known);
        } catch (err) {
          // Um lote que falha não derruba os outros nem o ciclo — mesma
          // disciplina da watchlist. O que ele traria reaparece na próxima
          // varredura, porque o evento continua pendente.
          pendingError ??= `${err instanceof Error ? err.message : String(err)} no lote ${i}`;
        }
      }
    }
  }

  const prepared = dedupeByKey(candidates, c => c.market.id)
    .map(c => prepareMarket(c.market, c.parent))
    .filter((p): p is PreparedMarket => p !== null);

  const writeErrors: string[] = [];
  const stampDiscoveredVia = await discoveredViaProbe.isSupported();
  const stampGameStartTime = await gameStartTimeProbe.isSupported();

  const split = splitForUpsert(prepared, newPolymarketIds, stampDiscoveredVia);

  // `game_start_time` vem de `gammaToEvent` e sai de novo enquanto a coluna não
  // existir — o carimbo é do item 7, mas a descoberta tem que subir antes dele.
  const [firstSeenRows, alreadyKnownRows] = await Promise.all([
    gameStartTimeProbe.strip(split.firstSeen),
    gameStartTimeProbe.strip(split.alreadyKnown),
  ]);

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
      `Discovery: ${eventsScanned} eventos / ${scanned} markets em ${pageCount} páginas` +
      `${pendingEvents > 0 ? ` + ${pendingEvents} pendentes` : ''}, ${candidatesNew} novos + ` +
      `${candidatesKnown} já conhecidos, ${eventsResult.rows.length} upserted, ` +
      `${snapResult.written} snapshots (stop: ${stopReason})`,
    metadata: {
      scanned,
      events_scanned: eventsScanned,
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
      // Varredura de pendentes. `pending_skipped = 'unavailable'` significa que
      // `game_start_time` ainda não foi aplicada — sem ela o market criado horas
      // depois do evento pai continua invisível.
      pending_events: pendingEvents,
      pending_requests: pendingRequests,
      pending_skipped: pendingSkipped,
      pending_error: pendingError,
      // false = migration 20260804165019 ainda não aplicada; a descoberta grava
      // igual, só não carimba.
      stamped_discovered_via: stampDiscoveredVia,
      // false = migration 20260806015533 ainda não aplicada. Sem o carimbo, todo
      // market novo entra na watchlist sem âncora e fica na faixa lenta.
      stamped_game_start_time: stampGameStartTime,
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
    `[discovery] ${eventsScanned} events / ${scanned} scanned / ${candidatesNew} new esports markets / ` +
      `${eventsResult.rows.length} upserted (stop: ${stopReason}, ${durationMs}ms)`,
  );
}
