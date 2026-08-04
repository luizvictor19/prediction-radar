import { supabase } from '../lib/supabase.js';
import { logEvent } from '../lib/logger.js';
import { adjustCash } from '../lib/bankroll.js';
import { fetchMarketsByIds, MAX_IDS_PER_REQUEST } from '../lib/polymarket-api.js';
import { getSystemConfig } from '../lib/config.js';
import { CycleLock } from '../lib/cycle-lock.js';
import type { GammaMarket } from '../types/index.js';

const CANDIDATE_FIELDS = 'id, polymarket_id, title, end_date, status';

interface CandidateEvent {
  id: string;
  polymarket_id: string;
  title: string;
  end_date: string | null;
  status: string;
}

/**
 * O filtro `or=(slug.like.X*)` do PostgREST é uma string em que vírgula, ponto e
 * parênteses são estrutura, não conteúdo. Um prefixo com qualquer um deles não
 * seria escapado — mudaria o sentido do filtro em silêncio, e um filtro de
 * resolução errado é o tipo de bug que só aparece no extrato.
 *
 * Prefixo de slug é `[a-z0-9_-]`. O que fugir disso é descartado com aviso.
 */
const SAFE_PREFIX_RE = /^[a-z0-9_-]+$/i;

export function safeSlugPrefixes(prefixes: readonly string[]): string[] {
  const safe: string[] = [];

  for (const prefix of prefixes) {
    if (prefix.length === 0) continue;
    if (!SAFE_PREFIX_RE.test(prefix)) {
      console.warn(
        `[resolved_detector] prefixo ignorado por caractere inseguro no filtro: ${JSON.stringify(prefix)}`,
      );
      continue;
    }
    safe.push(prefix);
  }

  return safe;
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

  const openLegEventIds = [
    ...new Set(
      (legRows ?? [])
        .filter(l => l.closed_at === null)
        .map(l => l.event_id as string | null)
        .filter(Boolean) as string[],
    ),
  ];

  const anyLegEventIds = [
    ...new Set((legRows ?? []).map(l => l.event_id as string | null).filter(Boolean) as string[]),
  ];

  // Etapa 1: events com leg aberta (prioritários — sempre incluir, sem filtro de end_date)
  // Justificativa: se temos posição aberta, sempre vale checar resolução.
  // Polymarket pode retornar end_date errado (visto em market groups com
  // múltiplas sub-resoluções) e filtrar por isso esconde events que precisam
  // ser checados.
  const { data: priorityCandidates, error: prioErr } = openLegEventIds.length > 0
    ? await supabase
        .from('events')
        .select(CANDIDATE_FIELDS)
        .in('id', openLegEventIds)
        .in('status', ['active', 'closed_manual'])
    : { data: [] as CandidateEvent[], error: null };

  if (prioErr) candidateErrors.push(`priority: ${prioErr.message}`);

  const priorityIds = new Set((priorityCandidates ?? []).map(p => p.id));

  // Etapa 2: trilha normal.
  //
  // Antes era "todo event ativo com end_date na janela", limit 500 — que na
  // prática varria 430k mercados de crypto/weather antigos que nunca tiveram
  // aposta e nunca vão interessar. Agora são dois recortes com dono:
  // mercado da vertical ativa, ou mercado em que houve dinheiro.
  const prefixes = safeSlugPrefixes((await getSystemConfig()).discovery_slug_prefixes ?? []);

  const { data: esportsCandidates, error: esportsErr } = prefixes.length > 0
    ? await supabase
        .from('events')
        .select(CANDIDATE_FIELDS)
        .in('status', ['active', 'closed_manual'])
        .gte('end_date', cutoff90d)
        .lte('end_date', cutoffFuture30d)
        .or(prefixes.map(p => `slug.like.${p}*`).join(','))
        .order('end_date', { ascending: true })
        .limit(500)
    : { data: [] as CandidateEvent[], error: null };

  if (esportsErr) candidateErrors.push(`esports: ${esportsErr.message}`);

  // Sem janela de end_date, mesma justificativa da trilha prioritária: onde
  // houve aposta, o end_date da Polymarket não é confiável o bastante para
  // decidir que não vale mais checar.
  const { data: betCandidates, error: betErr } = anyLegEventIds.length > 0
    ? await supabase
        .from('events')
        .select(CANDIDATE_FIELDS)
        .in('id', anyLegEventIds)
        .in('status', ['active', 'closed_manual'])
    : { data: [] as CandidateEvent[], error: null };

  if (betErr) candidateErrors.push(`bet: ${betErr.message}`);

  // Merge sem duplicar; o prioritário manda, porque é ele que habilita o
  // fallback por preço extremo.
  const byId = new Map<string, CandidateEvent>();
  for (const group of [esportsCandidates ?? [], betCandidates ?? [], priorityCandidates ?? []]) {
    for (const event of group) byId.set(event.id, event);
  }

  const candidates = [...byId.values()];
  const priorityEventIds = priorityIds;
  const esportsCount = (esportsCandidates ?? []).length;
  const betCount = (betCandidates ?? []).length;

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
      `(${priorityEventIds.size} priority, ${esportsCount} esports, ${betCount} com aposta): ` +
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
}
