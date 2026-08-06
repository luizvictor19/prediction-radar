import { supabase } from '../lib/supabase.js';
import { logEvent, logDisabled } from '../lib/logger.js';
import { beat } from '../lib/heartbeat.js';
import { getSystemConfig } from '../lib/config.js';
import { CycleLock } from '../lib/cycle-lock.js';
import { fetchMarketsByIds, MAX_IDS_PER_REQUEST } from '../lib/polymarket-api.js';
import { safeSlugPrefixes, slugPrefixFilter } from '../lib/slug-prefixes.js';
import { ColumnProbe } from '../lib/column-probe.js';
import {
  gammaLiquidity,
  gammaVolume24h,
  writeEsportsSnapshots,
  type EsportsSnapshotRow,
} from '../lib/esports-snapshots.js';
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
 * A série vai para `esports_snapshots` (item 3): tabela estreita e particionada
 * por dia, para que a limpeza seja DROP PARTITION. É o volume deste coletor que
 * torna DELETE em ciclo insustentável.
 *
 * A cadência é por faixa (itens 3b e 7): o tick roda a cada 5s e cada faixa é
 * refrescada no seu próprio intervalo. Um round de CS2 dura ~2 min — a
 * granularidade de 3 min de antes não permitia leitura ao vivo de nada.
 *
 * A faixa sai da distância até `events.game_start_time`, o horário real da
 * partida — não até `end_date`, que é o fim da janela de resolução e cai ~6h
 * depois do jogo (medido; ver `classifyBand`).
 *
 * Escopo deliberadamente fora daqui:
 * - Resolução é do `resolved-detector` (item 2c). Market fechado aqui só é
 *   contado e ignorado — este coletor não escreve em `events`.
 */

const COMPONENT = 'watchlist_collector';

/**
 * Teto de markets na watchlist. O que passar disso é logado — teto silencioso
 * lê como "cobri tudo" quando não cobriu.
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

const CYCLE_TIMEOUT_MS = 45_000;

/**
 * Este coletor tica a cada 5s. O default de 20 min de ciclo travado seria 240
 * ticks perdidos antes de alguém assumir — mesmo raciocínio do open-legs.
 */
const STALE_AFTER_MS = 2 * 60 * 1000;

/**
 * A lista de quem está na watchlist muda devagar (a descoberta roda a cada 3
 * min); o que muda a cada segundo é em que faixa cada um está, e isso se calcula
 * em memória. Sem esse cache, o tick de 5s viraria 17k queries/dia em `events`.
 */
const ROSTER_TTL_MS = 60_000;

/**
 * Uma linha de log a cada 5 min, agregando os ~60 ciclos do período.
 *
 * Logar por ciclo aqui seriam 17k linhas/dia — o padrão que inflou `system_logs`
 * para 2,7M linhas e quebrou o `retention_job`. O que interessa (quantos
 * refreshes por faixa, quantos snapshots, o que falhou) é justamente o que
 * agrega bem.
 */
const LOG_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Folga na checagem de vencimento, para o tick de 5s não virar aliasing: sem
 * ela, um intervalo de 12s só seria atendido a cada 15s (o tick dos 10s ainda
 * não venceu, o dos 15s sim).
 */
const TICK_TOLERANCE_MS = 2_500;

const cycleLock = new CycleLock(STALE_AFTER_MS);

interface WatchlistEvent {
  id: string;
  polymarket_id: string;
  /** Lifecycle: é ele que decide quem sai da watchlist (ver ENDED_GRACE_MS). */
  end_date: string | null;
  /** A âncora da cadência (item 7). Null enquanto a coluna não existe ou não foi backfilled. */
  game_start_time: string | null;
  sports_market_type: string | null;
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
): EsportsSnapshotRow[] {
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
  const volume24h = gammaVolume24h(market);
  // A curva de liquidez do market recém-nascido (~US$ 17 na medição do item 2a)
  // é parte do que a série de esports existe para registrar.
  const liquidity = gammaLiquidity(market);

  return [
    {
      event_id: eventId,
      outcome: primary,
      best_bid: bid,
      best_ask: ask,
      mid_price: mid,
      volume_24h: volume24h,
      liquidity,
      captured_at: capturedAt,
    },
    {
      event_id: eventId,
      outcome: secondary,
      best_bid: ask != null ? 1 - ask : null,
      best_ask: bid != null ? 1 - bid : null,
      mid_price: mid != null ? 1 - mid : null,
      volume_24h: volume24h,
      liquidity,
      captured_at: capturedAt,
    },
  ];
}

export type Band = 'live' | 'soon' | 'far';

/** Uma faixa é (banda × classe). Seis buckets, cada um com seu intervalo. */
export type BucketKey = `${Band}:${'primary' | 'derived'}`;

export interface Cadence {
  liveSeconds: number;
  soonSeconds: number;
  farSeconds: number;
  derivedMultiplier: number;
  soonWindowMinutes: number;
  liveMaxMinutes: number;
  primaryTypes: string[];
}

export function readCadence(config: {
  watchlist_interval_live_seconds?: number;
  watchlist_interval_soon_seconds?: number;
  watchlist_interval_far_seconds?: number;
  watchlist_derived_interval_multiplier?: number;
  watchlist_soon_window_minutes?: number;
  watchlist_live_max_minutes?: number;
  watchlist_primary_market_types?: string[] | null;
}): Cadence {
  // Pisos de 1: um intervalo 0 ou negativo em config viraria refresh a cada
  // tick, para todas as faixas ao mesmo tempo — o oposto do que este item existe
  // para fazer.
  const positive = (value: number | undefined, fallback: number): number =>
    typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;

  return {
    liveSeconds: positive(config.watchlist_interval_live_seconds, 12),
    soonSeconds: positive(config.watchlist_interval_soon_seconds, 60),
    farSeconds: positive(config.watchlist_interval_far_seconds, 300),
    derivedMultiplier: positive(config.watchlist_derived_interval_multiplier, 5),
    soonWindowMinutes: positive(config.watchlist_soon_window_minutes, 360),
    liveMaxMinutes: positive(config.watchlist_live_max_minutes, 360),
    // `?? ['moneyline']` e não `?? []`: enquanto a migration não for aplicada a
    // coluna não existe, e cair em lista vazia trataria TODO mercado como
    // derivado — a faixa ao vivo nunca rodaria e o item inteiro seria um no-op
    // silencioso. Lista vazia explícita na config continua significando
    // "trate todos como derivados", que é a chave de desligamento.
    primaryTypes: config.watchlist_primary_market_types ?? ['moneyline'],
  };
}

/**
 * Em que banda o market está, pela distância até o começo da partida.
 *
 * A âncora é `game_start_time` — nem `start_date` nem `end_date` servem, e por
 * motivos diferentes:
 *
 *   `start_date` é a abertura do mercado (item 2a: `start_date` do dia anterior
 *   ao jogo, que é justamente o que faz a descoberta por `order=startDate`
 *   funcionar). Classificar por ele poria toda a watchlist na faixa ao vivo
 *   desde o nascimento.
 *
 *   `end_date` é o fim da janela de resolução, não o fim do jogo. Medido na
 *   Gamma em 2026-08-06 sobre 171 markets de esports: `end_date` cai ~6h depois
 *   de `gameStartTime` (p50; p10 4h). Uma janela ao vivo de 180 min antes do
 *   `end_date` só abriria em `game_start_time + 3h`, com a partida encerrada —
 *   a faixa de 10-15s inteira depois do jogo.
 *
 * Sem âncora a banda é `far`. É degradação segura (o market continua sendo
 * coletado, só devagar) e o contador `null_game_start_time` no log é o que
 * denuncia — antes do apply da migration ou do backfill, é o roster inteiro.
 *
 * Passado o teto do ao vivo sem resolver, volta para `far`: é partida adiada com
 * âncora velha ou resolução travada na UMA. O preço ainda se move, mas não a
 * 12s. Quem tira da lista é o `ENDED_GRACE_MS` na query do roster.
 */
export function classifyBand(gameStartTime: string | null, nowMs: number, cadence: Cadence): Band {
  if (gameStartTime === null) return 'far';

  const startMs = Date.parse(gameStartTime);
  if (Number.isNaN(startMs)) return 'far';

  const msToStart = startMs - nowMs;
  if (msToStart > cadence.soonWindowMinutes * 60_000) return 'far';
  if (msToStart > 0) return 'soon';

  return -msToStart <= cadence.liveMaxMinutes * 60_000 ? 'live' : 'far';
}

/**
 * O mercado da série, não o derivado.
 *
 * Uma partida gera vários markets e só um deles é a série (medido em 2026-08-06:
 * 171 markets para 25 partidas — média 6,8, p50 6, máximo 39 num LoL). Os outros
 * (por game, handicap, total, round handicap, first blood) se movem junto e
 * valem menos por ponto de série.
 *
 * A comparação é por igualdade exata, e isso importa: `child_moneyline` é o
 * moneyline POR GAME, derivado, e um `startsWith` o promoveria a série.
 *
 * Lista vazia em config trata todos como derivados — e isso aparece no log como
 * `live:primary = 0`, que é o sintoma de o valor de `sports_market_type` estar
 * diferente do esperado.
 */
export function isPrimaryMarket(sportsMarketType: string | null, cadence: Cadence): boolean {
  if (sportsMarketType === null) return false;
  return cadence.primaryTypes.includes(sportsMarketType);
}

export function bucketOf(entry: WatchlistEvent, nowMs: number, cadence: Cadence): BucketKey {
  const band = classifyBand(entry.game_start_time, nowMs, cadence);
  return `${band}:${isPrimaryMarket(entry.sports_market_type, cadence) ? 'primary' : 'derived'}`;
}

export function intervalMsFor(bucket: BucketKey, cadence: Cadence): number {
  const [band, klass] = bucket.split(':') as [Band, 'primary' | 'derived'];
  const base =
    band === 'live' ? cadence.liveSeconds : band === 'soon' ? cadence.soonSeconds : cadence.farSeconds;

  return base * 1000 * (klass === 'primary' ? 1 : cadence.derivedMultiplier);
}

/**
 * Ordem de atendimento dentro de um ciclo: o que tem prazo mais curto primeiro.
 *
 * O lock é um só, então um refresh da faixa lenta (até 6 requisições) atrasa o
 * ao vivo se vier antes. Com a ordem invertida o atraso cai para o que a faixa
 * ao vivo leva sozinha — 1-2 requisições.
 */
const BUCKET_ORDER: BucketKey[] = [
  'live:primary',
  'live:derived',
  'soon:primary',
  'soon:derived',
  'far:primary',
  'far:derived',
];

/** Última vez que cada bucket foi refrescado. Em memória: um deploy zera. */
const lastRefreshAt = new Map<BucketKey, number>();

export function isBucketDue(
  bucket: BucketKey,
  nowMs: number,
  cadence: Cadence,
  lastRun: number | undefined,
): boolean {
  if (lastRun === undefined) return true;
  return nowMs - lastRun >= intervalMsFor(bucket, cadence) - TICK_TOLERANCE_MS;
}

/**
 * `events.game_start_time` só existe depois da migration 20260806015533, que é
 * aplicada à mão. Pedi-la no `select` antes disso derrubaria a query inteira e
 * deixaria o coletor sem roster — pior que ficar sem a âncora.
 */
const gameStartTimeProbe = new ColumnProbe('events', 'game_start_time', 'watchlist');

/** O roster, em cache. Ver ROSTER_TTL_MS. */
let roster: WatchlistEvent[] = [];
let rosterLoadedAt = 0;
let rosterTruncated = false;
let rosterNullEndDate = 0;
let rosterNullGameStart = 0;
let rosterHasAnchor = false;

/** Acumulado da janela de log. Ver LOG_INTERVAL_MS. */
interface WindowStats {
  startedAt: number;
  cycles: number;
  ticksSkippedLocked: number;
  refreshes: Record<string, number>;
  requests: number;
  snapshots: number;
  failedRows: number;
  closedInOpenBatch: number;
  malformed: number;
  unknownIds: number;
  lookupFailedIds: number;
  unaccounted: number;
  divergences: string[];
  writeErrors: string[];
  tables: Set<string>;
}

function emptyStats(startedAt: number): WindowStats {
  return {
    startedAt,
    cycles: 0,
    ticksSkippedLocked: 0,
    refreshes: {},
    requests: 0,
    snapshots: 0,
    failedRows: 0,
    closedInOpenBatch: 0,
    malformed: 0,
    unknownIds: 0,
    lookupFailedIds: 0,
    unaccounted: 0,
    divergences: [],
    writeErrors: [],
    tables: new Set(),
  };
}

let stats = emptyStats(Date.now());

export async function collectWatchlist(): Promise<void> {
  const lockToken = cycleLock.tryAcquire();

  if (!lockToken) {
    // Contador, não linha de log: com tick de 5s, um ciclo de 15s pula 2 ticks
    // e isso é normal. Logar cada um seriam milhares de linhas/dia dizendo que
    // o coletor está ocupado. O número sai no log agregado da janela.
    stats.ticksSkippedLocked++;
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
    setTimeout(() => reject(new Error(`cycle timeout ${CYCLE_TIMEOUT_MS}ms`)), CYCLE_TIMEOUT_MS),
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

/**
 * Recarrega o roster quando vencido. Devolve o erro em vez de logar: com tick de
 * 5s, um banco fora do ar viraria 17k linhas de erro por dia.
 */
async function ensureRoster(prefixes: string[], nowMs: number): Promise<string | null> {
  if (roster.length > 0 && nowMs - rosterLoadedAt < ROSTER_TTL_MS) return null;

  const endedCutoff = new Date(nowMs - ENDED_GRACE_MS).toISOString();

  rosterHasAnchor = await gameStartTimeProbe.isSupported();

  // Quem decide quem SAI da watchlist continua sendo o `end_date` — ele é o fim
  // da janela de resolução, que é exatamente o critério de lifecycle. O que
  // mudou no item 7 é quem decide a CADÊNCIA de quem fica.
  //
  // O filtro por `end_date` exclui também as linhas com `end_date` nulo (NULL
  // não satisfaz a comparação). Market vindo da descoberta sempre tem a coluna;
  // o contador `null_end_date` abaixo mede se essa premissa se mantém.
  //
  // Ordenado pela âncora ascendente: o teto corta a partida mais distante, e
  // quem já começou (âncora no passado) vem primeiro — é quem menos pode faltar.
  // `nullsFirst: false` põe o market sem âncora no fim da fila: ele já está na
  // faixa lenta, e é o que menos custa perder se o teto morder.
  const filtered = supabase
    .from('events')
    .select(
      rosterHasAnchor
        ? 'id, polymarket_id, end_date, sports_market_type, game_start_time'
        : 'id, polymarket_id, end_date, sports_market_type',
    )
    .eq('status', 'active')
    .gte('end_date', endedCutoff)
    .or(slugPrefixFilter(prefixes));

  const ordered = rosterHasAnchor
    ? filtered.order('game_start_time', { ascending: true, nullsFirst: false })
    : filtered.order('end_date', { ascending: true });

  const { data, error } = await ordered.limit(MAX_WATCHLIST + 1);

  if (error) return `roster query: ${error.message}`;

  // O `select` é montado em runtime, então o parser de tipos do PostgREST não
  // tem o que inferir aqui — a forma da linha é conferida na projeção abaixo.
  const rows = ((data ?? []) as unknown as Record<string, unknown>[]).map(row => ({
    id: row['id'] as string,
    polymarket_id: row['polymarket_id'] as string,
    end_date: (row['end_date'] as string | null) ?? null,
    // Ausente da resposta inteira quando a coluna ainda não existe.
    game_start_time: (row['game_start_time'] as string | null | undefined) ?? null,
    sports_market_type: (row['sports_market_type'] as string | null) ?? null,
  })) as WatchlistEvent[];

  // O +1 no limit é só para enxergar o corte: com ele a truncagem vira número no
  // log em vez de silêncio.
  rosterTruncated = rows.length > MAX_WATCHLIST;
  roster = rosterTruncated ? rows.slice(0, MAX_WATCHLIST) : rows;
  rosterLoadedAt = nowMs;

  // Sem âncora não há faixa rápida. Antes do apply da migration é o roster
  // inteiro; depois do backfill tem que cair para perto de zero, e só voltar a
  // subir se a Gamma parar de mandar `gameStartTime`.
  rosterNullGameStart = roster.filter(entry => entry.game_start_time === null).length;

  // Mede a premissa do comentário acima em vez de confiar nela: se um dia
  // aparecer esports ativo sem `end_date`, ele está fora da watchlist e este é
  // o número que denuncia.
  const { count } = await supabase
    .from('events')
    .select('id', { count: 'exact', head: true })
    .eq('status', 'active')
    .is('end_date', null)
    .or(slugPrefixFilter(prefixes));

  rosterNullEndDate = count ?? 0;
  return null;
}

/**
 * Refresca um bucket: pergunta à Gamma por esses ids e devolve as linhas.
 *
 * As duas chamadas (`closed=false` e depois `closed=true` sobre os ausentes) são
 * a exigência do item 2b e continuam valendo por bucket — ausência no primeiro
 * lote é ambígua entre "resolveu" e "lote truncado", e só a segunda separa.
 */
interface BucketRefresh {
  rows: EsportsSnapshotRow[];
  /** Ids sem leitura NESTE refresh. O acumulado da janela vive em `stats`. */
  lookupFailedIds: number;
}

async function refreshBucket(entries: WatchlistEvent[]): Promise<BucketRefresh> {
  const eventIdByPolymarketId = new Map(entries.map(e => [e.polymarket_id, e.id]));
  const idsToCheck = [...eventIdByPolymarketId.keys()];

  const snapshotRows: EsportsSnapshotRow[] = [];

  // O `captured_at` é carimbado por chunk, no instante da resposta — um
  // timestamp único no fim do ciclo empilharia várias requisições no mesmo
  // ponto da série e mentiria sobre quando cada preço foi lido.
  const collectFromChunk = (markets: GammaMarket[]): void => {
    const capturedAt = new Date().toISOString();
    for (const market of markets) {
      const eventId = eventIdByPolymarketId.get(market.id);
      if (!eventId) continue;

      // O filtro `closed=false` deveria bastar, mas quem decide é o campo, não
      // o parâmetro: preço de market fechado é 0/1 e sujaria a série.
      if (market.closed) {
        stats.closedInOpenBatch++;
        continue;
      }

      const pair = buildSnapshotRows(eventId, market, capturedAt);
      if (pair.length === 0) stats.malformed++;
      snapshotRows.push(...pair);
    }
  };

  const open = await lookupByIds(idsToCheck, false, collectFromChunk);

  const absentIds = idsToCheck.filter(id => !open.byId.has(id) && !open.failedIds.has(id));
  const closed = await lookupByIds(absentIds, true);

  const reconciled = reconcile(idsToCheck, open, closed);

  stats.requests +=
    Math.ceil(idsToCheck.length / MAX_IDS_PER_REQUEST) +
    Math.ceil(absentIds.length / MAX_IDS_PER_REQUEST);
  stats.unknownIds += reconciled.unknownIds.length;
  stats.lookupFailedIds += reconciled.failedIds.length;
  stats.unaccounted += reconciled.unaccounted;
  stats.divergences.push(...open.divergences, ...closed.divergences);

  return { rows: snapshotRows, lookupFailedIds: reconciled.failedIds.length };
}

/**
 * O que ESTE ciclo encontrou de falha — não a janela.
 *
 * A distinção existe porque o batimento é por ciclo e o log é por janela de 5
 * min. Misturar os dois foi o bug: o batimento lia `stats.writeErrors`, que é
 * acumulador de janela, então um único erro de escrita carimbava `partial` em
 * todos os ciclos seguintes até o flush — até 5 min de batimentos mentindo
 * sobre ciclos que correram limpos.
 */
export interface CycleOutcome {
  rosterError: string | null;
  writeErrors: number;
  lookupFailedIds: number;
}

/**
 * Status do batimento: `partial` só quando algo deste ciclo de fato falhou.
 *
 * Os três casos são falha real e nenhum é rotina:
 *   - `rosterError`: a lista de quem acompanhar não recarregou. O ciclo rodou
 *     em cima de roster velho (ou nenhum), o que é trabalho degradado.
 *   - `writeErrors`: linha de série que não foi gravada. É dado perdido.
 *   - `lookupFailedIds`: chunk que não respondeu. Aqueles markets ficaram sem
 *     leitura neste ciclo.
 *
 * O que deliberadamente NÃO entra aqui é ausência de market no lote — ver a
 * nota em `windowStatus`.
 */
export function cycleStatus(outcome: CycleOutcome): 'success' | 'partial' {
  return outcome.rosterError !== null || outcome.writeErrors > 0 || outcome.lookupFailedIds > 0
    ? 'partial'
    : 'success';
}

export interface WindowOutcome extends CycleOutcome {
  unaccounted: number;
  rosterTruncated: boolean;
}

/**
 * Status da linha agregada de 5 min.
 *
 * `divergences` saiu da conta, e é essa a correção. Divergência é chunk em que
 * "enviados != recebidos", e o próprio `fetchMarketsByIds` documenta que o
 * filtro `id=` aplica `closed=false`: o market que resolveu SEMPRE falta no
 * primeiro lote. Ou seja, a divergência é a forma esperada de "esse market
 * acabou" — e como a watchlist segura o market até 24h depois do `end_date`
 * (ENDED_GRACE_MS), praticamente toda janela tem alguma. Com ela no cálculo, o
 * status era `partial` em regime permanente, sem nada ter falhado.
 *
 * O que a divergência poderia esconder de verdade — lote truncado — não some
 * com essa remoção: o id que falta nos DOIS lotes cai em `unknownIds`, e a
 * aritmética que não fecha cai em `unaccounted`, que continua sendo `partial`.
 * As divergências seguem no metadata como diagnóstico; o que elas deixam de
 * fazer é reprovar um ciclo saudável.
 *
 * `rosterTruncated` continua `partial` porque é cobertura incompleta de fato:
 * há market de esports ativo fora da watchlist.
 */
export function windowStatus(outcome: WindowOutcome): 'success' | 'partial' | 'error' {
  if (outcome.rosterError !== null || outcome.writeErrors > 0 || outcome.lookupFailedIds > 0) {
    return 'error';
  }
  return outcome.unaccounted !== 0 || outcome.rosterTruncated ? 'partial' : 'success';
}

/** Uma linha a cada LOG_INTERVAL_MS, agregando os ciclos do período. */
async function flushWindowLog(
  nowMs: number,
  occupancy: Record<string, number>,
  rosterError: string | null,
): Promise<void> {
  if (nowMs - stats.startedAt < LOG_INTERVAL_MS) return;

  const windowMinutes = (nowMs - stats.startedAt) / 60_000;
  const status = windowStatus({
    rosterError,
    writeErrors: stats.writeErrors.length,
    lookupFailedIds: stats.lookupFailedIds,
    unaccounted: stats.unaccounted,
    rosterTruncated,
  });

  const refreshSummary = Object.entries(stats.refreshes)
    .map(([bucket, n]) => `${bucket}=${n}`)
    .join(' ');

  await logEvent({
    component: COMPONENT,
    status,
    message:
      `Watchlist ${windowMinutes.toFixed(1)}min: ${stats.cycles} ciclos, ` +
      `${stats.snapshots} snapshots em ${stats.requests} requisições. ` +
      `Refreshes por faixa: ${refreshSummary || 'nenhum'}. ` +
      `Roster ${roster.length}${rosterTruncated ? ` (TRUNCADO no teto de ${MAX_WATCHLIST})` : ''}` +
      `${rosterError !== null ? ` — ERRO: ${rosterError}` : ''}`,
    metadata: {
      window_minutes: Number(windowMinutes.toFixed(2)),
      cycles: stats.cycles,
      // Ticks em que o ciclo anterior ainda rodava. Alguns por janela é normal;
      // muitos significam que o ciclo não cabe no intervalo da faixa mais rápida.
      ticks_skipped_locked: stats.ticksSkippedLocked,
      // Mercados refrescados por bucket na janela — não é o mesmo que ocupação.
      refreshes_by_bucket: stats.refreshes,
      // Quantos mercados estão em cada bucket agora. `live:primary = 0` com
      // partida rolando é o sintoma de `sports_market_type` não bater com
      // `watchlist_primary_market_types` — ou de `game_start_time` não ter sido
      // carimbado (ver `null_game_start_time`).
      occupancy_by_bucket: occupancy,
      roster_size: roster.length,
      roster_truncated: rosterTruncated,
      roster_error: rosterError,
      // > 0 = esports ativo sem `end_date`, invisível para o recorte do roster.
      null_end_date: rosterNullEndDate,
      // false = migration 20260806015533 ainda não aplicada: o coletor roda sem
      // âncora, tudo na faixa lenta.
      anchor_column: rosterHasAnchor,
      // Mercados no roster sem âncora — presos na faixa lenta. Alto e estável
      // depois do apply significa backfill não rodado (item 7, passo manual).
      null_game_start_time: rosterNullGameStart,
      requests: stats.requests,
      snapshots: stats.snapshots,
      snapshot_tables: [...stats.tables],
      failed_snapshot_rows: stats.failedRows,
      closed_in_open_batch: stats.closedInOpenBatch,
      malformed_outcomes: stats.malformed,
      unknown_ids: stats.unknownIds,
      lookup_failed_ids: stats.lookupFailedIds,
      // != 0 é bug de contagem no reconcile, não mercado resolvendo.
      unaccounted: stats.unaccounted,
      // Diagnóstico, NÃO status: chunk com "enviados != recebidos" é a forma
      // esperada de market resolvido no lote `closed=false` (ver windowStatus).
      batch_divergences: stats.divergences.length > 0 ? stats.divergences.slice(0, 5) : null,
      write_errors: stats.writeErrors.length > 0 ? stats.writeErrors.slice(0, 5) : null,
    },
  });

  stats = emptyStats(nowMs);
}

async function _collect(): Promise<void> {
  const nowMs = Date.now();

  const config = await getSystemConfig();
  const prefixes = safeSlugPrefixes(config.discovery_slug_prefixes ?? [], 'watchlist');

  if (prefixes.length === 0) {
    // Lista vazia é o desligamento pela config, não um bug — mesmo contrato da
    // descoberta, e é o que permite religar a vertical sem deploy.
    await logDisabled(COMPONENT, 'Watchlist disabled: discovery_slug_prefixes is empty');
    // Ver a nota da descoberta: desligado pela config é ciclo completo.
    await beat(COMPONENT, 'success', 'desligado: sem prefixos');
    return;
  }

  const cadence = readCadence(config);
  const rosterError = await ensureRoster(prefixes, nowMs);

  const grouped = new Map<BucketKey, WatchlistEvent[]>();
  for (const entry of roster) {
    const bucket = bucketOf(entry, nowMs, cadence);
    const list = grouped.get(bucket);
    if (list) list.push(entry);
    else grouped.set(bucket, [entry]);
  }

  const occupancy: Record<string, number> = {};
  for (const [bucket, entries] of grouped) occupancy[bucket] = entries.length;

  // Prioridade por prazo: o ao vivo é atendido antes de a faixa lenta gastar
  // requisições, porque o lock é um só e o atraso dela cairia em cima dele.
  const due = BUCKET_ORDER.filter(bucket => {
    const entries = grouped.get(bucket);
    return (
      entries !== undefined &&
      entries.length > 0 &&
      isBucketDue(bucket, nowMs, cadence, lastRefreshAt.get(bucket))
    );
  });

  if (due.length === 0) {
    await flushWindowLog(nowMs, occupancy, rosterError);
    // Nenhuma faixa vencida é o caso comum com tick de 5s — o ciclo rodou,
    // decidiu que não havia o que refrescar, e terminou. Isso é saúde.
    //
    // Passa pelo `cycleStatus` mesmo assim porque roster que não recarrega é
    // falha inclusive quando não havia o que refrescar: carimbar `success` fixo
    // aqui seria o mesmo erro do `partial` permanente, na direção oposta.
    await beat(
      COMPONENT,
      cycleStatus({ rosterError, writeErrors: 0, lookupFailedIds: 0 }),
      rosterError !== null
        ? `roster não recarregou: ${rosterError}`
        : `nada vencido, ${roster.length} no roster`,
    );
    return;
  }

  stats.cycles++;

  const snapshotRows: EsportsSnapshotRow[] = [];
  // Do ciclo, não da janela: é o que o batimento pode olhar sem herdar falha de
  // cinco minutos atrás.
  let cycleLookupFailed = 0;
  for (const bucket of due) {
    const entries = grouped.get(bucket)!;
    lastRefreshAt.set(bucket, nowMs);
    stats.refreshes[bucket] = (stats.refreshes[bucket] ?? 0) + entries.length;
    const refreshed = await refreshBucket(entries);
    snapshotRows.push(...refreshed.rows);
    cycleLookupFailed += refreshed.lookupFailedIds;
  }

  const snapResult = await writeEsportsSnapshots(snapshotRows, 'watchlist');
  stats.snapshots += snapResult.written;
  stats.failedRows += snapResult.failedRows;
  stats.writeErrors.push(...snapResult.errors);
  if (snapResult.table !== null) stats.tables.add(snapResult.table);

  console.log(
    `[watchlist] ${due.join(',')} — ${snapshotRows.length / 2} markets / ` +
      `${snapResult.written} snapshots (${Date.now() - nowMs}ms)`,
  );

  await flushWindowLog(Date.now(), occupancy, rosterError);

  // `snapResult.errors` e não `stats.writeErrors`: o segundo é acumulador da
  // janela de 5 min, e lê-lo aqui carimbava `partial` em todo ciclo posterior a
  // um erro de escrita, inclusive nos que correram limpos.
  const outcome: CycleOutcome = {
    rosterError,
    writeErrors: snapResult.errors.length,
    lookupFailedIds: cycleLookupFailed,
  };

  await beat(
    COMPONENT,
    cycleStatus(outcome),
    `${due.join(',')} — ${snapResult.written} snapshots` +
      (cycleLookupFailed > 0 ? `, ${cycleLookupFailed} ids sem leitura` : '') +
      (snapResult.errors.length > 0 ? `, ${snapResult.errors.length} erros de escrita` : '') +
      (rosterError !== null ? `, roster: ${rosterError}` : ''),
  );
}
