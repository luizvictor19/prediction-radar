import { supabase } from '../lib/supabase.js';
import { logEvent } from '../lib/logger.js';
import { batchInsert } from '../lib/batch-write.js';
import { getSystemConfig } from '../lib/config.js';
import { CycleLock } from '../lib/cycle-lock.js';
import { fetchMarketsByIds, MAX_IDS_PER_REQUEST } from '../lib/polymarket-api.js';
import { safeSlugPrefixes, slugPrefixFilter } from '../lib/slug-prefixes.js';
import type { GammaMarket } from '../types/index.js';

/**
 * Refresh da watchlist de esports (spec 000, item 2b).
 *
 * A lacuna que este coletor fecha: quem grava preço hoje é a varredura por
 * volume (teto de 2000 posições, desligada no item 4), o early-markets e o
 * open-legs. Nenhum dos três alcança o mercado de esports que a descoberta
 * (item 2a) traz — ele nasce com volume 0 e liquidez ~US$ 17, fica no fundo do
 * ranking de volume e não tem aposta aberta. Ou seja: hoje o market é
 * descoberto no minuto em que nasce e depois disso ninguém acompanha o preço.
 *
 * Aqui a pergunta é direta, por `id=`, sobre exatamente os markets da
 * watchlist. Sem offset, sem teto, 1 requisição por 100 markets.
 *
 * Escopo deliberadamente fora daqui:
 * - Cadência por estado da partida é o item 7. Aqui é intervalo fixo.
 * - `esports_snapshots` é o item 6. Aqui grava em `polymarket_snapshots`.
 * - Resolução é do `resolved-detector` (item 2c). Market fechado aqui só é
 *   contado e ignorado — este coletor não escreve em `events`.
 */

const COMPONENT = 'watchlist_collector';

/**
 * Teto de markets por ciclo. 10 requisições à Gamma, e o que passar disso é
 * logado — teto silencioso lê como "cobri tudo" quando não cobriu.
 */
const MAX_WATCHLIST = 1000;

/**
 * Até quanto tempo depois do `end_date` o market continua na watchlist.
 *
 * Sem esse piso, todo market que ficou `active` sem resolver (partida adiada,
 * resolução travada na UMA) fica na watchlist para sempre e come a cota do teto
 * acima, empurrando para fora justamente os markets de partida próxima.
 */
const ENDED_GRACE_MS = 24 * 60 * 60 * 1000;

const CYCLE_TIMEOUT_MS = 120_000;

const cycleLock = new CycleLock();

interface WatchlistEvent {
  id: string;
  polymarket_id: string;
}

export interface BatchLookup {
  byId: Map<string, GammaMarket>;
  /** Ids em chunks que falharam: não se sabe nada sobre eles neste ciclo. */
  failedIds: Set<string>;
  /** Uma entrada por chunk em que o total enviado != total recebido. */
  divergences: string[];
}

/**
 * Consulta a Gamma sobre ids específicos, em lotes de 100.
 *
 * Duas exigências do spec vivem aqui. A primeira é o `limit` explícito, que
 * `fetchMarketsByIds` já manda igual ao tamanho do lote — sem ele o default de
 * 20 truncaria o lote em silêncio. A segunda é comparar quantos ids foram
 * enviados com quantos voltaram: a divergência é registrada por chunk, porque
 * ausência aqui é ambígua (resolveu, saiu de listagem, ou lote truncado) e o
 * número bruto é o que separa "mercado fechando" de bug.
 *
 * Um chunk que falha não derruba os outros: seus ids vão para `failedIds` e
 * ficam de fora das conclusões do ciclo. Tratar falha de rede como ausência
 * seria inventar resolução onde só houve socket derrubado.
 */
async function lookupByIds(
  ids: readonly string[],
  closed: boolean,
  onChunk?: (markets: GammaMarket[]) => void,
): Promise<BatchLookup> {
  const byId = new Map<string, GammaMarket>();
  const failedIds = new Set<string>();
  const divergences: string[] = [];

  for (let i = 0; i < ids.length; i += MAX_IDS_PER_REQUEST) {
    const chunk = ids.slice(i, i + MAX_IDS_PER_REQUEST);
    try {
      const markets = await fetchMarketsByIds(chunk, { closed });
      for (const market of markets) byId.set(market.id, market);
      if (markets.length !== chunk.length) {
        divergences.push(`closed=${closed} chunk ${i}: enviados ${chunk.length}, recebidos ${markets.length}`);
      }
      onChunk?.(markets);
    } catch (err) {
      for (const id of chunk) failedIds.add(id);
      console.error(`[watchlist] lote closed=${closed} falhou (${chunk.length} ids): ${String(err)}`);
    }
  }

  return { byId, failedIds, divergences };
}

export interface Reconciled {
  /**
   * Respondeu no lote `closed=false`. Quase sempre é o mercado vivo, mas quem
   * decide se vira snapshot é o campo `closed` do market, não o parâmetro da
   * chamada — a diferença entre os dois vai para `closed_in_open_batch`.
   */
  openIds: string[];
  /** Ausente lá e confirmado no lote `closed=true`: resolveu ou fechou. */
  closedIds: string[];
  /** Ausente nos dois lotes: resolveu e saiu de listagem, ou lote truncado. */
  unknownIds: string[];
  /** Ids em chunk que falhou: nada se conclui sobre eles neste ciclo. */
  failedIds: string[];
  /** Diferente de 0 é bug de contagem, não mercado fechando. */
  unaccounted: number;
}

/**
 * Fecha a conta do ciclo: todo id enviado tem que cair em exatamente um balde.
 *
 * O `unaccounted` existe porque a ambiguidade central do item 2b não some — ela
 * só fica mensurável. "Sumiu do lote" pode ser resolução (esperado) ou
 * truncamento (bug), e a única defesa é a aritmética bater no fim.
 */
export function reconcile(
  sentIds: readonly string[],
  open: Pick<BatchLookup, 'byId' | 'failedIds'>,
  closed: Pick<BatchLookup, 'byId' | 'failedIds'>,
): Reconciled {
  const openIds: string[] = [];
  const closedIds: string[] = [];
  const unknownIds: string[] = [];
  const failedIds: string[] = [];

  for (const id of sentIds) {
    if (open.byId.has(id)) openIds.push(id);
    else if (closed.byId.has(id)) closedIds.push(id);
    else if (open.failedIds.has(id) || closed.failedIds.has(id)) failedIds.push(id);
    else unknownIds.push(id);
  }

  const unaccounted =
    sentIds.length - (openIds.length + closedIds.length + unknownIds.length + failedIds.length);

  return { openIds, closedIds, unknownIds, failedIds, unaccounted };
}

/**
 * O par de linhas de snapshot para um market binário.
 *
 * Grava com um lado só do book quando é o que existe: perto da resolução um dos
 * lados costuma perder liquidez, e exigir os dois apagaria a série justamente
 * no trecho mais informativo. Sem nenhum dos dois não há o que registrar.
 */
export function buildSnapshotRows(
  eventId: string,
  market: GammaMarket,
  capturedAt: string,
): Record<string, unknown>[] {
  let outcomes: string[];
  try {
    outcomes = JSON.parse(market.outcomes) as string[];
  } catch {
    // JSON malformado: uma linha inválida derrubaria o chunk inteiro no insert.
    return [];
  }

  const [primary, secondary] = outcomes;
  if (primary == null || secondary == null) return [];

  const bid = market.bestBid ?? null;
  const ask = market.bestAsk ?? null;
  if (bid == null && ask == null) return [];

  const mid = bid != null && ask != null ? (bid + ask) / 2 : null;
  const spread = market.spread ?? null;
  const volume24h = market.volume24hr ?? market.volume24hrClob ?? null;

  return [
    {
      event_id: eventId,
      outcome: primary,
      best_bid: bid,
      best_ask: ask,
      mid_price: mid,
      spread,
      volume_24h: volume24h,
      captured_at: capturedAt,
    },
    {
      event_id: eventId,
      outcome: secondary,
      best_bid: ask != null ? 1 - ask : null,
      best_ask: bid != null ? 1 - bid : null,
      mid_price: mid != null ? 1 - mid : null,
      spread,
      volume_24h: volume24h,
      captured_at: capturedAt,
    },
  ];
}

export async function collectWatchlist(): Promise<void> {
  const lockToken = cycleLock.tryAcquire();

  if (!lockToken) {
    await logEvent({
      component: COMPONENT,
      status: 'partial',
      message: 'previous cycle still running, skipping this tick',
      metadata: { previous_cycle_running_for_ms: cycleLock.heldForMs() ?? 0 },
    });
    return;
  }

  if (lockToken.staleTakeoverMs !== null) {
    const stuckMinutes = Math.round(lockToken.staleTakeoverMs / 60000);
    console.warn(`[watchlist] Previous cycle stuck for ${stuckMinutes}min — assuming dead, starting a new one`);
    await logEvent({
      component: COMPONENT,
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
      component: COMPONENT,
      status: 'error',
      message: `Watchlist cycle failed: ${err instanceof Error ? err.message : String(err)}`,
      metadata: { error: String(err) },
    });
  }
}

async function _collect(): Promise<void> {
  const startedAt = Date.now();

  const config = await getSystemConfig();
  const prefixes = safeSlugPrefixes(config.discovery_slug_prefixes ?? [], 'watchlist');

  if (prefixes.length === 0) {
    // Lista vazia é o desligamento pela config, não um bug — mesmo contrato da
    // descoberta, e é o que permite religar a vertical sem deploy.
    await logEvent({
      component: COMPONENT,
      status: 'success',
      message: 'Watchlist disabled: discovery_slug_prefixes is empty',
    });
    return;
  }

  const endedCutoff = new Date(startedAt - ENDED_GRACE_MS).toISOString();

  // Ordenado por `end_date` ascendente: se o teto cortar, o que fica de fora é
  // a partida mais distante, não a que está prestes a acontecer.
  //
  // O filtro por `end_date` exclui também as linhas com `end_date` nulo (NULL
  // não satisfaz a comparação). Market vindo da descoberta sempre tem a coluna;
  // o contador `null_end_date` abaixo mede se essa premissa se mantém.
  const { data, error } = await supabase
    .from('events')
    .select('id, polymarket_id')
    .eq('status', 'active')
    .gte('end_date', endedCutoff)
    .or(slugPrefixFilter(prefixes))
    .order('end_date', { ascending: true })
    .limit(MAX_WATCHLIST + 1);

  if (error) {
    await logEvent({
      component: COMPONENT,
      status: 'error',
      message: `watchlist query failed: ${error.message}`,
    });
    return;
  }

  const rows = (data ?? []) as WatchlistEvent[];

  // O +1 no limit é só para enxergar o corte: com ele a truncagem vira número no
  // log em vez de silêncio.
  const truncated = rows.length > MAX_WATCHLIST;
  const watchlist = truncated ? rows.slice(0, MAX_WATCHLIST) : rows;

  // Mede a premissa do comentário acima em vez de confiar nela: se um dia
  // aparecer esports ativo sem `end_date`, ele está fora da watchlist e este é
  // o número que denuncia.
  const { count: nullEndDateCount } = await supabase
    .from('events')
    .select('id', { count: 'exact', head: true })
    .eq('status', 'active')
    .is('end_date', null)
    .or(slugPrefixFilter(prefixes));

  if (watchlist.length === 0) {
    await logEvent({
      component: COMPONENT,
      status: 'success',
      message: 'watchlist vazia: nenhum event de esports ativo na janela',
      metadata: { prefixes, null_end_date: nullEndDateCount ?? 0 },
    });
    return;
  }

  const eventIdByPolymarketId = new Map(watchlist.map(e => [e.polymarket_id, e.id]));
  const idsToCheck = [...eventIdByPolymarketId.keys()];

  const snapshotRows: Record<string, unknown>[] = [];
  let malformed = 0;
  let closedInOpenBatch = 0;

  // O `captured_at` é carimbado por chunk, no instante da resposta — um
  // timestamp único no fim do ciclo empilharia até 10 requisições no mesmo
  // ponto da série e mentiria sobre quando cada preço foi lido.
  const collectFromChunk = (markets: GammaMarket[]): void => {
    const capturedAt = new Date().toISOString();
    for (const market of markets) {
      const eventId = eventIdByPolymarketId.get(market.id);
      if (!eventId) continue;

      // O filtro `closed=false` deveria bastar, mas quem decide é o campo, não
      // o parâmetro: preço de market fechado é 0/1 e sujaria a série.
      if (market.closed) {
        closedInOpenBatch++;
        continue;
      }

      const pair = buildSnapshotRows(eventId, market, capturedAt);
      if (pair.length === 0) malformed++;
      snapshotRows.push(...pair);
    }
  };

  const open = await lookupByIds(idsToCheck, false, collectFromChunk);

  // Sem esta segunda chamada a ausência ficaria ambígua para sempre: o filtro
  // `id=` aplica `closed=false` por padrão, então o market que resolveu some do
  // primeiro lote sem erro nenhum. Só sobre os ausentes — os vivos já voltaram.
  const absentIds = idsToCheck.filter(id => !open.byId.has(id) && !open.failedIds.has(id));
  const closed = await lookupByIds(absentIds, true);

  const reconciled = reconcile(idsToCheck, open, closed);
  const divergences = [...open.divergences, ...closed.divergences];

  const snapResult = await batchInsert('polymarket_snapshots', snapshotRows, { label: 'watchlist' });

  const durationMs = Date.now() - startedAt;
  const requests =
    Math.ceil(idsToCheck.length / MAX_IDS_PER_REQUEST) + Math.ceil(absentIds.length / MAX_IDS_PER_REQUEST);

  const status =
    snapResult.errors.length > 0 ||
    reconciled.failedIds.length > 0 ||
    reconciled.unaccounted !== 0 ||
    divergences.length > 0 ||
    truncated
      ? 'partial'
      : 'success';

  await logEvent({
    component: COMPONENT,
    status,
    message:
      `Watchlist: ${idsToCheck.length} markets em ${requests} requisições — ` +
      `${reconciled.openIds.length} vivos, ${reconciled.closedIds.length} fechados, ` +
      `${reconciled.unknownIds.length} sem resposta dos dois lotes, ` +
      `${reconciled.failedIds.length} em lote que falhou. ` +
      `${snapResult.written} snapshots` +
      `${truncated ? ` (TRUNCADA no teto de ${MAX_WATCHLIST})` : ''} em ${durationMs}ms`,
    metadata: {
      prefixes,
      watchlist_size: idsToCheck.length,
      // true = há mais esports ativo do que o teto por ciclo; o excedente é a
      // partida mais distante, e não foi coletado neste ciclo.
      truncated,
      max_watchlist: MAX_WATCHLIST,
      // > 0 = esports ativo sem `end_date`, invisível para o recorte acima.
      null_end_date: nullEndDateCount ?? 0,
      requests,
      ids_sent_open: idsToCheck.length,
      ids_returned_open: open.byId.size,
      ids_sent_closed: absentIds.length,
      ids_returned_closed: closed.byId.size,
      // Divergência entre enviados e recebidos por chunk. Com `limit` explícito
      // isto deve ficar vazio no lote aberto; entrada aqui é sinal de truncamento.
      batch_divergences: divergences.length > 0 ? divergences : null,
      open_markets: reconciled.openIds.length,
      closed_markets: reconciled.closedIds.length,
      // Ausente dos dois lotes: resolveu e saiu de listagem, ou lote truncado.
      // Amostra para dar o que consultar à mão quando o número surpreender.
      unknown_ids: reconciled.unknownIds.length,
      unknown_sample: reconciled.unknownIds.slice(0, 10),
      lookup_failed_ids: reconciled.failedIds.length,
      // != 0 é bug de contagem no reconcile, não mercado resolvendo.
      unaccounted: reconciled.unaccounted,
      closed_in_open_batch: closedInOpenBatch,
      malformed_outcomes: malformed,
      snapshots: snapResult.written,
      failed_snapshot_rows: snapResult.failedRows,
      duration_ms: durationMs,
      write_errors: snapResult.errors.length > 0 ? snapResult.errors.slice(0, 10) : null,
    },
  });

  console.log(
    `[watchlist] ${idsToCheck.length} markets / ${reconciled.openIds.length} vivos / ` +
      `${snapResult.written} snapshots (${requests} req, ${durationMs}ms)`,
  );
}
