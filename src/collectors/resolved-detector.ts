import { supabase } from '../lib/supabase.js';
import { logEvent } from '../lib/logger.js';
import { beat } from '../lib/heartbeat.js';
import { adjustCash } from '../lib/bankroll.js';
import { fetchMarketsByIds, MAX_IDS_PER_REQUEST } from '../lib/polymarket-api.js';
import { getSystemConfig } from '../lib/config.js';
import { CycleLock } from '../lib/cycle-lock.js';
import { safeSlugPrefixes, slugPrefixFilter } from '../lib/slug-prefixes.js';
import type { GammaMarket } from '../types/index.js';

const CANDIDATE_FIELDS = 'id, polymarket_id, title, end_date, status';

interface CandidateEvent {
  id: string;
  polymarket_id: string;
  title: string;
  end_date: string | null;
  status: string;
}

// O guard do filtro `or=` mora na lib desde que o watchlist-collector passou a
// montar o mesmo recorte por prefixo. Reexportado porque é a superfície que os
// testes deste componente já usavam.
export { safeSlugPrefixes };

// ---------------------------------------------------------------------------
// Which slices of `events` get checked for resolution
// ---------------------------------------------------------------------------

/**
 * One track of resolution candidates: the slice of `events` it asks for.
 *
 * Kept as data, and planned by a pure function, for the same reason
 * `radar-selection.ts` is separate from the collector that fetches: which
 * markets get checked at all is a rule, and a rule that only exists inside an
 * `await` chain cannot be tested without a database.
 *
 * A track that would select nothing is not planned. That is why the id-based
 * tracks carry their ids: an empty `in()` is a query that reads the table for
 * no rows.
 */
export type Track =
  | { name: 'open_leg'; priority: true; eventIds: string[] }
  | { name: 'any_leg'; priority: false; eventIds: string[] }
  | {
      name: 'vertical';
      priority: false;
      prefixes: string[];
      from: string;
      to: string;
      limit: number;
    }
  | { name: 'roster'; priority: false; pageSize: number };

export interface TrackInput {
  /** Every row of `my_bet_legs`, read once and split here. */
  legs: { event_id: string | null; closed_at: string | null }[];
  /** Already through `safeSlugPrefixes`. */
  prefixes: string[];
  /** `end_date` window for the vertical track, as ISO strings. */
  from: string;
  to: string;
}

/** The vertical track is capped on purpose: it is a window, not a whole set. */
const VERTICAL_LIMIT = 500;

/**
 * The roster track is PAGED, not capped.
 *
 * `rosterMax` (800) bounds how many markets one renewal marks, not how many
 * stay marked: `radar_tracked` accumulates, and measured on 2026-08-22 the set
 * is already 1054. A cap here would drop the overflow silently, and PostgREST
 * truncates at 1000 rows per response either way, so any single-request ceiling
 * is a cut waiting to happen. Same pagination reason as `web/src/lib/dados.ts`.
 */
const ROSTER_PAGE = 500;

function distinctEventIds(legs: TrackInput['legs'], openOnly: boolean): string[] {
  return [
    ...new Set(
      legs
        .filter(l => (openOnly ? l.closed_at === null : true))
        .map(l => l.event_id)
        .filter((id): id is string => Boolean(id)),
    ),
  ];
}

/**
 * Which tracks to run this cycle.
 *
 * Pure: no network, no database, no clock. The caller supplies the leg rows,
 * the prefixes and the window, and gets back the list of slices to fetch.
 */
export function planTracks(input: TrackInput): Track[] {
  const tracks: Track[] = [];

  const openLegIds = distinctEventIds(input.legs, true);
  if (openLegIds.length > 0) {
    tracks.push({ name: 'open_leg', priority: true, eventIds: openLegIds });
  }

  if (input.prefixes.length > 0) {
    tracks.push({
      name: 'vertical',
      priority: false,
      prefixes: input.prefixes,
      from: input.from,
      to: input.to,
      limit: VERTICAL_LIMIT,
    });
  }

  const anyLegIds = distinctEventIds(input.legs, false);
  if (anyLegIds.length > 0) {
    tracks.push({ name: 'any_leg', priority: false, eventIds: anyLegIds });
  }

  // The roster, unconditionally. A radar market leaves the screen only when
  // `events.status` stops being 'active', and nothing else ever writes that:
  // `triar` rejects a closed market before the upsert, so the radar collector
  // never rewrites the row once Polymarket closes it. Without this track a
  // resolved market with no bet on it stays 'active' forever, and `v_radar`
  // keeps serving it.
  //
  // Not priority: priority is what enables the extreme-price fallback, which
  // writes a resolution inferred from snapshots. That is for markets with money
  // in them, not for the whole roster.
  tracks.push({ name: 'roster', priority: false, pageSize: ROSTER_PAGE });

  return tracks;
}

/** Runs one planned track. The only impure half of the pair. */
function fetchTrack(
  track: Track,
): PromiseLike<{ data: CandidateEvent[] | null; error: { message: string } | null }> {
  const base = supabase.from('events').select(CANDIDATE_FIELDS);

  switch (track.name) {
    case 'open_leg':
    case 'any_leg':
      return base.in('id', track.eventIds).in('status', ['active', 'closed_manual']);

    case 'vertical':
      return base
        .in('status', ['active', 'closed_manual'])
        .gte('end_date', track.from)
        .lte('end_date', track.to)
        .or(slugPrefixFilter(track.prefixes))
        .order('end_date', { ascending: true })
        .limit(track.limit);

    case 'roster':
      // `radar_tracked` é o índice PARCIAL da 20260813210119, que indexa só as
      // linhas `true`: a leitura é proporcional ao roster (centenas), não às
      // 551k linhas de `events`.
      return base
        .eq('radar_tracked', true)
        .in('status', ['active', 'closed_manual'])
        .limit(track.limit);
  }
}

type ResolutionResult =
  | { kind: 'win'; winnerOutcome: string }
  | { kind: 'void' }
  | { kind: 'unresolved' };

function parseResolution(market: GammaMarket): ResolutionResult {
  if (!market.closed) return { kind: 'unresolved' };
  if (market.umaResolutionStatus !== 'resolved') return { kind: 'unresolved' };

  const prices = JSON.parse(market.outcomePrices) as string[];
  const outcomes = JSON.parse(market.outcomes) as string[];

  if (prices.length !== 2 || outcomes.length !== 2) return { kind: 'unresolved' };

  if (prices[0] === '0.5' && prices[1] === '0.5') return { kind: 'void' };

  const winnerIdx = prices.findIndex(p => p === '1');
  if (winnerIdx === -1) return { kind: 'unresolved' };

  return { kind: 'win', winnerOutcome: outcomes[winnerIdx]! };
}

/**
 * Detect resolution via sustained extreme price in DB snapshots.
 *
 * Necessary because Polymarket returns closed=false for markets that are part
 * of a group with multiple sub-resolutions. The price already reflects the
 * outcome but the individual market never becomes closed.
 */
async function detectResolutionByPrice(eventId: string): Promise<ResolutionResult> {
  const sixHoursAgo = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();

  const { data: snapshots } = await supabase
    .from('polymarket_snapshots')
    .select('outcome, best_bid, best_ask, captured_at')
    .eq('event_id', eventId)
    .gte('captured_at', sixHoursAgo)
    .order('captured_at', { ascending: false });

  if (!snapshots || snapshots.length < 6) {
    return { kind: 'unresolved' };
  }

  const byOutcome = new Map<string, Array<{ best_bid: number | null; best_ask: number | null }>>();
  for (const s of snapshots) {
    const arr = byOutcome.get(s.outcome) ?? [];
    arr.push({ best_bid: s.best_bid, best_ask: s.best_ask });
    byOutcome.set(s.outcome, arr);
  }

  if (byOutcome.size !== 2) return { kind: 'unresolved' };

  const outcomes = Array.from(byOutcome.keys());

  for (const candidateWinner of outcomes) {
    const winnerSnaps = byOutcome.get(candidateWinner)!;
    const loser = outcomes.find(o => o !== candidateWinner)!;
    const loserSnaps = byOutcome.get(loser)!;

    if (winnerSnaps.length < 3 || loserSnaps.length < 3) continue;

    const winnerExtreme = winnerSnaps.every(s => {
      const bid = s.best_bid;
      return bid != null && bid >= 0.99;
    });

    const loserExtreme = loserSnaps.every(s => {
      const ask = s.best_ask;
      return ask != null && ask <= 0.01;
    });

    if (winnerExtreme && loserExtreme) {
      return { kind: 'win', winnerOutcome: candidateWinner };
    }
  }

  return { kind: 'unresolved' };
}

interface BatchLookup {
  byId: Map<string, GammaMarket>;
  /** Ids em chunks que falharam: não se sabe nada sobre eles neste ciclo. */
  failedIds: Set<string>;
}

/**
 * Consulta a Gamma sobre ids específicos, em lotes de 100.
 *
 * Um chunk que falha não derruba os outros: seus ids vão para `failedIds` e
 * ficam de fora das conclusões do ciclo. Tratá-los como "ausentes" seria ler
 * uma falha de rede como sinal de resolução.
 */
async function lookupByIds(ids: readonly string[], closed: boolean): Promise<BatchLookup> {
  const byId = new Map<string, GammaMarket>();
  const failedIds = new Set<string>();

  for (let i = 0; i < ids.length; i += MAX_IDS_PER_REQUEST) {
    const chunk = ids.slice(i, i + MAX_IDS_PER_REQUEST);
    try {
      const markets = await fetchMarketsByIds(chunk, { closed });
      for (const market of markets) byId.set(market.id, market);
    } catch (err) {
      for (const id of chunk) failedIds.add(id);
      console.error(`[resolved_detector] lote closed=${closed} falhou (${chunk.length} ids): ${String(err)}`);
    }
  }

  return { byId, failedIds };
}

async function closeLegsForResolvedEvent(
  eventId: string,
  resolution: { kind: 'win'; winnerOutcome: string } | { kind: 'void' },
  resolvedAt: string,
): Promise<{ closed: number; payout_total: number }> {
  const { data: legs, error: legsErr } = await supabase
    .from('my_bet_legs')
    .select('id, bet_id, outcome, entry_price, stake_usd, shares')
    .eq('event_id', eventId)
    .is('closed_at', null);

  if (legsErr || !legs || legs.length === 0) {
    return { closed: 0, payout_total: 0 };
  }

  let closed = 0;
  let payoutTotal = 0;
  const affectedBetIds = new Set<string>();

  for (const leg of legs) {
    let result: 'win' | 'loss' | 'void';
    let resolutionPrice: number | null;
    let pnlUsd: number;
    let payout: number;

    if (resolution.kind === 'void') {
      result = 'void';
      resolutionPrice = null;
      pnlUsd = 0;
      payout = leg.stake_usd;
    } else {
      const won = leg.outcome === resolution.winnerOutcome;
      if (won) {
        result = 'win';
        resolutionPrice = 1.0;
        const shares = leg.shares ?? (leg.stake_usd / leg.entry_price);
        pnlUsd = (1.0 - leg.entry_price) * shares;
        payout = shares * 1.0;
      } else {
        result = 'loss';
        resolutionPrice = 0.0;
        pnlUsd = -leg.stake_usd;
        payout = 0;
      }
    }

    const { data: clvSnap } = await supabase
      .from('polymarket_snapshots')
      .select('mid_price')
      .eq('event_id', eventId)
      .eq('outcome', leg.outcome)
      .lte('captured_at', resolvedAt)
      .order('captured_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    const clv = clvSnap?.mid_price ?? null;

    const { error: updErr } = await supabase
      .from('my_bet_legs')
      .update({
        result,
        resolution_price: resolutionPrice,
        pnl_usd: pnlUsd,
        clv,
        closed_at: resolvedAt,
      })
      .eq('id', leg.id)
      .is('closed_at', null);

    if (updErr) {
      await logEvent({
        component: 'resolved_detector',
        status: 'error',
        message: `failed to close leg ${leg.id}: ${updErr.message}`,
      });
      continue;
    }

    if (payout > 0) {
      await adjustCash(payout);
      payoutTotal += payout;
    }

    affectedBetIds.add(leg.bet_id);
    closed++;
  }

  for (const betId of affectedBetIds) {
    const { count: openLegs } = await supabase
      .from('my_bet_legs')
      .select('id', { count: 'exact', head: true })
      .eq('bet_id', betId)
      .is('closed_at', null);

    if (openLegs === 0) {
      await supabase
        .from('my_bets')
        .update({ closed_at: resolvedAt })
        .eq('id', betId);
    }
  }

  return { closed, payout_total: payoutTotal };
}

/**
 * Antes rodava de dentro do `collectAll` e recebia dele o conjunto "sumiu do
 * feed". Os dois vínculos foram cortados (spec 000, item 2c): o pré-filtro virou
 * consulta direta por `id=`, e o agendamento é próprio — a varredura por volume
 * vai ser desligada no item 4 e levaria o auto-resolver junto.
 */
const RESOLVED_DETECTOR_TIMEOUT_MS = 120_000;

/**
 * Teto de resoluções aplicadas por ciclo. Não é mais sobre custo de fetch (o
 * lote resolve isso), e sim sobre as escritas sequenciais de cada fechamento de
 * leg. O que passar disso fica para o próximo ciclo, e o log diz quanto ficou.
 */
const MAX_RESOLUTIONS_PER_CYCLE = 200;

const cycleLock = new CycleLock();

export async function detectResolvedMarkets(): Promise<void> {
  const lockToken = cycleLock.tryAcquire();

  if (!lockToken) {
    await logEvent({
      component: 'resolved_detector',
      status: 'partial',
      message: 'previous cycle still running, skipping this tick',
      metadata: { previous_cycle_running_for_ms: cycleLock.heldForMs() ?? 0 },
    });
    return;
  }

  if (lockToken.staleTakeoverMs !== null) {
    const stuckMinutes = Math.round(lockToken.staleTakeoverMs / 60000);
    console.warn(`[resolved_detector] Previous cycle stuck for ${stuckMinutes}min — assuming dead, starting a new one`);
    await logEvent({
      component: 'resolved_detector',
      status: 'partial',
      message: `WARNING: previous cycle stuck for ${stuckMinutes}min — assumed dead, starting a new one`,
      metadata: { stuck_for_ms: lockToken.staleTakeoverMs },
    });
  }

  // O lock é solto quando o trabalho real termina, não quando a race termina:
  // soltar no timeout deixaria o próximo tick rodar em cima do ciclo zumbi.
  const cyclePromise = _detectResolvedMarkets().finally(() => cycleLock.release(lockToken));

  const timeoutPromise = new Promise<void>((_, reject) =>
    setTimeout(() => reject(new Error('resolved_detector timeout 120s')), RESOLVED_DETECTOR_TIMEOUT_MS),
  );

  try {
    await Promise.race([cyclePromise, timeoutPromise]);
  } catch (err) {
    await logEvent({
      component: 'resolved_detector',
      status: 'error',
      message: `unexpected error: ${String(err)}`,
    });
  }
}

async function _detectResolvedMarkets(): Promise<void> {
  const startedAt = Date.now();

  const cutoff90d = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
  const cutoffFuture30d = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

  const candidateErrors: string[] = [];

  // Uma leitura só de `my_bet_legs`: a trilha prioritária quer as legs abertas,
  // a normal quer qualquer leg (fechada inclusive — a resolução do event pode
  // chegar depois de a posição ter sido encerrada à mão).
  const { data: legRows, error: legsErr } = await supabase
    .from('my_bet_legs')
    .select('event_id, closed_at');

  if (legsErr) candidateErrors.push(`my_bet_legs: ${legsErr.message}`);

  // Etapa 1: quais recortes de `events` este ciclo pede. A regra é pura e mora
  // em `planTracks`; aqui só se executa o que ela planejou.
  //
  // Antes a trilha normal era "todo event ativo com end_date na janela", limit
  // 500 — que na prática varria 430k mercados de crypto/weather antigos que
  // nunca tiveram aposta e nunca vão interessar. Cada trilha de hoje tem dono:
  // posição aberta, mercado da vertical ativa, mercado em que houve dinheiro.
  const prefixes = safeSlugPrefixes(
    (await getSystemConfig()).discovery_slug_prefixes ?? [],
    'resolved_detector',
  );

  const tracks = planTracks({
    legs: (legRows ?? []) as { event_id: string | null; closed_at: string | null }[],
    prefixes,
    from: cutoff90d,
    to: cutoffFuture30d,
  });

  // Etapa 2: buscar cada trilha.
  //
  // A prioritária não filtra por `end_date`: se há posição aberta, sempre vale
  // checar resolução, e a Polymarket devolve `end_date` errado em market groups
  // com múltiplas sub-resoluções — filtrar por ele esconderia justamente o que
  // precisa ser checado. Pelo mesmo motivo a trilha `any_leg` também não filtra.
  const rowsByTrack = new Map<Track['name'], CandidateEvent[]>();

  for (const track of tracks) {
    const { data, error } = await fetchTrack(track);
    if (error) candidateErrors.push(`${track.name}: ${error.message}`);
    rowsByTrack.set(track.name, data ?? []);
  }

  const priorityIds = new Set(
    tracks
      .filter(t => t.priority)
      .flatMap(t => rowsByTrack.get(t.name) ?? [])
      .map(e => e.id),
  );

  // Merge sem duplicar; o prioritário manda, porque é ele que habilita o
  // fallback por preço extremo — por isso entra por último.
  const byId = new Map<string, CandidateEvent>();
  for (const track of [...tracks.filter(t => !t.priority), ...tracks.filter(t => t.priority)]) {
    for (const event of rowsByTrack.get(track.name) ?? []) byId.set(event.id, event);
  }

  const candidates = [...byId.values()];
  const priorityEventIds = priorityIds;
  const esportsCount = (rowsByTrack.get('vertical') ?? []).length;
  const betCount = (rowsByTrack.get('any_leg') ?? []).length;
  const rosterCount = (rowsByTrack.get('roster') ?? []).length;

  if (candidateErrors.length > 0) {
    await logEvent({
      component: 'resolved_detector',
      status: 'error',
      message: `candidate queries failed: ${candidateErrors.join('; ')}`,
    });
  }

  if (candidates.length === 0) {
    await logEvent({
      component: 'resolved_detector',
      status: 'success',
      message: 'no candidates to check',
    });
    await beat('resolved_detector', 'success', 'sem candidatos');
    return;
  }

  // Etapa 3: perguntar à Gamma sobre exatamente estes candidatos.
  //
  // Antes o pré-filtro era "sumiu do feed da varredura por volume" — sinal que
  // já nascia falso para a maioria, porque a varredura só alcança as ~2000
  // primeiras posições e os candidatos aqui são justamente os mais antigos.
  // Agora a pergunta é direta, por id: 2 requisições por 100 candidatos.
  const idsToCheck = [...new Set(candidates.map(e => e.polymarket_id))];

  const active = await lookupByIds(idsToCheck, false);

  // Ausente do lote `closed=false` = resolveu, foi deslistado, ou o chunk falhou.
  // Os que falharam saem da conta: ler falha de rede como resolução seria grave.
  const absentIds = idsToCheck.filter(id => !active.byId.has(id) && !active.failedIds.has(id));

  // O `closed=false` é default e silencioso no filtro por id — sem esta segunda
  // chamada, o market resolvido simplesmente não volta e nunca seria detectado.
  const resolved = await lookupByIds(absentIds, true);

  const lookupFailedIds = new Set([...active.failedIds, ...resolved.failedIds]);
  const unknownIds = absentIds.filter(
    id => !resolved.byId.has(id) && !resolved.failedIds.has(id),
  );

  let resolvedCount = 0;
  let voidCount = 0;
  let totalLegsClosed = 0;
  let totalPayout = 0;
  let unresolvedCount = 0;
  let stillOpenCount = 0;
  let appliedCount = 0;
  let skippedDueToLimit = 0;

  for (const event of candidates) {
      const market = resolved.byId.get(event.polymarket_id) ?? active.byId.get(event.polymarket_id);

      if (!market) {
        // Sem resposta dos dois lados: nada a concluir neste ciclo. O contador
        // de `unknownIds` já registra; um chunk que falhou nem isso conclui.
        continue;
      }

      // O teto só vale para quem pode gerar escrita: mercado fechado (caminho de
      // resolução) ou prioritário (caminho do preço extremo). Mercado aberto sem
      // posição não escreve nada e não deve contar como adiado.
      const mayWrite = market.closed || priorityEventIds.has(event.id);
      if (mayWrite && appliedCount >= MAX_RESOLUTIONS_PER_CYCLE) {
        skippedDueToLimit++;
        continue;
      }

      if (!market.closed) {
        // For events with open legs, also check if resolved via sustained extreme price.
        // Necessary because market groups with multi-resolutions never have closed=true
        // on individual sub-markets until the entire group resolves.
        const isPriority = priorityEventIds.has(event.id);

        if (isPriority) {
          const priceResolution = await detectResolutionByPrice(event.id);
          if (priceResolution.kind === 'win') {
            const resolvedAt = new Date().toISOString();
            const updateData: Record<string, unknown> = {
              status: 'resolved',
              resolved_at: resolvedAt,
              resolved_outcome: priceResolution.winnerOutcome,
            };

            const { data: updated, error: updErr } = await supabase
              .from('events')
              .update(updateData)
              .eq('id', event.id)
              .in('status', ['active', 'closed_manual'])
              .select('id')
              .maybeSingle();

            if (updErr || !updated) {
              if (updErr) {
                await logEvent({
                  component: 'resolved_detector',
                  status: 'error',
                  message: `event update failed for ${event.id}: ${updErr.message}`,
                });
              }
              continue;
            }

            const { closed, payout_total } = await closeLegsForResolvedEvent(
              event.id,
              priceResolution,
              resolvedAt,
            );

            resolvedCount++;
            appliedCount++;
            totalLegsClosed += closed;
            totalPayout += payout_total;

            await logEvent({
              component: 'resolved_detector',
              status: 'success',
              message: `event ${event.id} (${event.title.slice(0, 60)}) detected as resolved by sustained extreme price: ${priceResolution.winnerOutcome}, closed ${closed} leg(s), payout $${payout_total.toFixed(2)}`,
            });
            continue;
          }
        }

        // Mercado ainda aberto — hoje isso é um fato lido da API, não uma
        // suspeita. O log `partial` de "sumiu do feed mas closed=false" saiu
        // junto com o pré-filtro que o produzia: era artefato do teto de offset,
        // dezenas por ciclo, e não dizia nada sobre o mercado.
        stillOpenCount++;
        continue;
      }

      const resolution = parseResolution(market);
      if (resolution.kind === 'unresolved') {
        unresolvedCount++;
        continue;
      }

      const umaEndDate = market.umaEndDate ?? new Date().toISOString();

      const updateData: Record<string, unknown> = {
        status: 'resolved',
        resolved_at: umaEndDate,
      };
      if (resolution.kind === 'win') {
        updateData['resolved_outcome'] = resolution.winnerOutcome;
      }

      const { data: updated, error: updErr } = await supabase
        .from('events')
        .update(updateData)
        .eq('id', event.id)
        .in('status', ['active', 'closed_manual'])
        .select('id')
        .maybeSingle();

      if (updErr || !updated) {
        if (updErr) {
          await logEvent({
            component: 'resolved_detector',
            status: 'error',
            message: `event update failed for ${event.id}: ${updErr.message}`,
          });
        }
        continue;
      }

      const { closed, payout_total } = await closeLegsForResolvedEvent(
        event.id,
        resolution,
        umaEndDate,
      );

      if (resolution.kind === 'void') voidCount++;
      else resolvedCount++;

      appliedCount++;
      totalLegsClosed += closed;
      totalPayout += payout_total;

      await logEvent({
        component: 'resolved_detector',
        status: 'success',
        message: `event ${event.id} (${event.title.slice(0, 60)}) resolved as ${resolution.kind === 'void' ? 'void' : resolution.winnerOutcome}, closed ${closed} leg(s), payout $${payout_total.toFixed(2)}`,
      });
    }

  const durationMs = Date.now() - startedAt;

  // Exigência do spec (2b/2c): ausência é ambígua entre "resolveu" e "lote
  // truncado". Comparar o que foi mandado com o que voltou é o que separa os
  // dois — divergência sem resolução correspondente é bug, não mercado fechando.
  const accountedFor =
    active.byId.size + resolved.byId.size + unknownIds.length + lookupFailedIds.size;
  const unaccounted = idsToCheck.length - accountedFor;

  const status =
    candidateErrors.length > 0 || lookupFailedIds.size > 0 || unaccounted !== 0 || skippedDueToLimit > 0
      ? 'partial'
      : 'success';

  await logEvent({
    component: 'resolved_detector',
    status,
    message:
      `checked ${idsToCheck.length} candidates ` +
      `(${priorityEventIds.size} priority, ${esportsCount} esports, ${betCount} com aposta, ` +
      `${rosterCount} no radar): ` +
      `${resolvedCount} resolved, ${voidCount} void, ${unresolvedCount} pending UMA, ` +
      `${stillOpenCount} still open, ${unknownIds.length} sem resposta dos dois lotes, ` +
      `${lookupFailedIds.size} em lote que falhou. ` +
      `${skippedDueToLimit > 0 ? `${skippedDueToLimit} adiados (teto ${MAX_RESOLUTIONS_PER_CYCLE}/ciclo). ` : ''}` +
      `Closed ${totalLegsClosed} legs, payout total $${totalPayout.toFixed(2)} in ${durationMs}ms`,
    metadata: {
      candidates: idsToCheck.length,
      priority: priorityEventIds.size,
      candidates_esports: esportsCount,
      candidates_with_bet: betCount,
      candidates_roster: rosterCount,
      slug_prefixes: prefixes,
      candidate_errors: candidateErrors.length > 0 ? candidateErrors : null,
      ids_sent_open: idsToCheck.length,
      ids_returned_open: active.byId.size,
      ids_sent_closed: absentIds.length,
      ids_returned_closed: resolved.byId.size,
      // != 0 é bug de contagem no lote, não mercado resolvendo.
      unaccounted,
      lookup_failed_ids: lookupFailedIds.size,
      unknown_ids: unknownIds.length,
      resolved: resolvedCount,
      void: voidCount,
      pending_uma: unresolvedCount,
      still_open: stillOpenCount,
      skipped_due_to_limit: skippedDueToLimit,
      legs_closed: totalLegsClosed,
      payout_total: totalPayout,
      duration_ms: durationMs,
    },
  });

  await beat(
    'resolved_detector',
    lookupFailedIds.size > 0 ? 'partial' : 'success',
    `${resolvedCount} resolvidos, ${stillOpenCount} abertos`,
  );
}
