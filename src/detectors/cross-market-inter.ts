import type { CrossMarketInterSignalMetadata, CrossMarketInterMember, ArbDirection } from '../types/index.js';
import { supabase } from '../lib/supabase.js';
import { getSystemConfig } from '../lib/config.js';
import { logEvent } from '../lib/logger.js';
import {
  getFeeRate,
  calculateExpectedEdgePct,
  estimateBuyNoBasketFeeCost,
  estimateBuyYesBasketFeeCost,
} from '../lib/fees.js';
import { batchInsert } from '../lib/batch-write.js';

interface EventRow {
  id: string;
  polymarket_id: string;
  title: string;
  outcomes: { values: string[]; prices: string[] } | null;
  neg_risk_market_id: string;
  volume_24h: number | null;
  polymarket_category: string | null;
  polymarket_fee_rate: number | null;
  end_date: string | null;
  sports_market_type?: string | null;
  line?: number | null;
}

interface ExistingSignal {
  id: string;
  metadata: CrossMarketInterSignalMetadata;
}

function extractYesPrice(outcomes: EventRow['outcomes']): number | null {
  if (!outcomes?.values || !outcomes?.prices) return null;

  const yesIndex = outcomes.values.indexOf('Yes');
  if (yesIndex === -1) return null;

  const raw = outcomes.prices[yesIndex];
  if (raw === undefined) return null;

  const price = parseFloat(raw);
  return isNaN(price) ? null : price;
}

export async function runCrossMarketInterDetector(): Promise<void> {
  const start = Date.now();
  const config = await getSystemConfig();

  const {
    inter_market_min_members: minMembers,
    inter_market_min_total_volume_24h: minTotalVolume,
    min_expected_edge_pct: minEdgePct,
    log_expected_edge_pct: logEdgePct,
  } = config;

  const { data: events, error: fetchError } = await supabase
    .from('events')
    .select('id, polymarket_id, title, outcomes, neg_risk_market_id, volume_24h, polymarket_category, polymarket_fee_rate, end_date, sports_market_type, line')
    .eq('status', 'active')
    .eq('tracked', true)
    .not('neg_risk_market_id', 'is', null)
    .gt('end_date', new Date().toISOString());

  if (fetchError) {
    await logEvent({
      component: 'cross_market_inter_detector',
      status: 'error',
      message: `Failed to fetch events: ${fetchError.message}`,
      metadata: { error: fetchError.message },
    });
    return;
  }

  const rows = (events ?? []) as EventRow[];

  // Group by neg_risk_market_id
  const groups = new Map<string, EventRow[]>();
  for (const row of rows) {
    const nrid = row.neg_risk_market_id;
    const group = groups.get(nrid) ?? [];
    group.push(row);
    groups.set(nrid, group);
  }

  // Staleness filter: build set of event IDs with a snapshot in the last 30 min.
  // Batched in chunks of 100 to avoid URL length limits with large .in() lists.
  const stalenessThreshold = new Date(Date.now() - 30 * 60 * 1000).toISOString();
  const allEventIds = rows.map((r) => r.id);
  let liveEventIds = new Set<string>(allEventIds); // fail-open: all live if query fails
  if (allEventIds.length > 0) {
    const CHUNK_SIZE = 100;
    const liveFromSnaps = new Set<string>();
    let staleBatchFailed = false;

    for (let i = 0; i < allEventIds.length; i += CHUNK_SIZE) {
      const chunk = allEventIds.slice(i, i + CHUNK_SIZE);
      const { data: recentSnaps, error: staleErr } = await supabase
        .from('polymarket_snapshots')
        .select('event_id')
        .in('event_id', chunk)
        .gte('captured_at', stalenessThreshold);

      if (staleErr) {
        await logEvent({
          component: 'cross_market_inter_detector',
          status: 'error',
          message: `Staleness check query failed (chunk ${i}–${i + chunk.length}): ${staleErr.message}`,
          metadata: { error: staleErr.message },
        });
        staleBatchFailed = true;
        break;
      }

      for (const s of recentSnaps ?? []) {
        liveFromSnaps.add(s.event_id as string);
      }
    }

    if (!staleBatchFailed) {
      liveEventIds = liveFromSnaps;
    }
  }

  let groupsEvaluated = 0;
  let groupsSkippedTooSmall = 0;
  let groupsSkippedLowVolume = 0;
  let groupsSkippedLowCoverage = 0;
  let groupsSkippedLowEdge = 0;
  let groupsSkippedLowSum = 0;
  let groupsSkippedStale = 0;
  let flaggedCount = 0;
  let highConfidenceCount = 0;
  let dedupedCount = 0;
  let membersWithoutYesPrice = 0;
  let groupsWithDroppedMembers = 0;
  let membersDroppedLowPrice = 0;
  let highEdgeGroups = 0;
  const byCategoryCount: Record<string, number> = {};

  /**
   * Contagem e amostra por ciclo, nunca uma linha por grupo.
   *
   * O pior caso aqui não era nem o erro: era o log `partial` de "Group X passed
   * coverage", emitido para todo grupo avaliado em todo ciclo. Log de sucesso
   * dentro de loop é o mesmo padrão que levou `system_logs` a 2,7M linhas — o
   * número de grupos que passou já está em `groups_evaluated`.
   */
  const SAMPLE_LIMIT = 5;
  const noYesPriceSample: string[] = [];
  const lowCoverageSample: string[] = [];
  const lowSumSample: string[] = [];
  const highEdgeSample: string[] = [];
  const dedupQueryErrors: string[] = [];

  const sample = (into: string[], value: string): void => {
    if (into.length < SAMPLE_LIMIT) into.push(value);
  };

  // Sinais novos vão para um buffer e são gravados em um insert só no fim do ciclo.
  const pendingSignals: Record<string, unknown>[] = [];

  // Build DB-based group size map (no end_date or volume filter — all active members)
  // Batched in chunks of 100 to avoid URL length limits with large .in() lists.
  const groupTotalMap = new Map<string, number>();
  const candidateNRIDs = [...groups.keys()];
  if (candidateNRIDs.length > 0) {
    const CHUNK_SIZE = 100;
    for (let i = 0; i < candidateNRIDs.length; i += CHUNK_SIZE) {
      const chunk = candidateNRIDs.slice(i, i + CHUNK_SIZE);
      const { data: allNegRiskRows, error: sizeErr } = await supabase
        .from('events')
        .select('neg_risk_market_id')
        .eq('status', 'active')
        .in('neg_risk_market_id', chunk);

      if (sizeErr) {
        await logEvent({
          component: 'cross_market_inter_detector',
          status: 'error',
          message: `Failed to build group size map from DB: ${sizeErr.message}`,
          metadata: { error: sizeErr.message },
        });
        return;
      }

      for (const row of allNegRiskRows ?? []) {
        const nrid = row.neg_risk_market_id as string;
        groupTotalMap.set(nrid, (groupTotalMap.get(nrid) ?? 0) + 1);
      }
    }
  }

  for (const [negRiskMarketId, members] of groups) {
    if (members.length < minMembers) {
      groupsSkippedTooSmall++;
      continue;
    }

    // Stale basket guard: all members must have a snapshot in the last 30 min
    if (!members.every((m) => liveEventIds.has(m.id))) {
      groupsSkippedStale++;
      continue;
    }

    // Extract valid members with yes prices
    const validMembers: Array<{ event: EventRow; yesPrice: number }> = [];
    for (const event of members) {
      const yesPrice = extractYesPrice(event.outcomes);
      if (yesPrice === null) {
        membersWithoutYesPrice++;
        sample(noYesPriceSample, `${event.id} (grupo ${negRiskMarketId})`);
        continue;
      }
      validMembers.push({ event, yesPrice });
    }

    const MIN_YES_PRICE_PER_MEMBER = 0.05;
    const eligibleMembers = validMembers.filter(m => m.yesPrice >= MIN_YES_PRICE_PER_MEMBER);

    if (validMembers.length > eligibleMembers.length) {
      groupsWithDroppedMembers++;
      membersDroppedLowPrice += validMembers.length - eligibleMembers.length;
    }

    if (eligibleMembers.length < minMembers) {
      groupsSkippedTooSmall++;
      continue;
    }

    const totalVolume = eligibleMembers.reduce((sum, m) => sum + (m.event.volume_24h ?? 0), 0);
    if (totalVolume < minTotalVolume) {
      groupsSkippedLowVolume++;
      continue;
    }

    groupsEvaluated++;

    // Category + fee rate = taken from member with highest volume_24h
    // (all members in a negRisk group share the same feeType and feeSchedule)
    const leadByVolume = eligibleMembers
      .sort((a, b) => (b.event.volume_24h ?? 0) - (a.event.volume_24h ?? 0))[0]!;
    const groupCategory = leadByVolume.event.polymarket_category ?? null;
    const directFeeRate = leadByVolume.event.polymarket_fee_rate ?? null;

    // Coverage guard: discard group if we don't hold all DB-tracked members.
    // Incomplete coverage makes priceSum artificially low, producing phantom edge.
    const totalGroupSize = groupTotalMap.get(negRiskMarketId) ?? 0;
    const coverageRatio = totalGroupSize > 0 ? eligibleMembers.length / totalGroupSize : 0;
    if (coverageRatio < 0.95) {
      groupsSkippedLowCoverage++;
      sample(
        lowCoverageSample,
        `${negRiskMarketId}: ${eligibleMembers.length}/${totalGroupSize} (${(coverageRatio * 100).toFixed(1)}%)`,
      );
      continue;
    }

    // O "passed coverage" que existia aqui saiu: era uma linha `partial` por
    // grupo aprovado, em todo ciclo, dizendo que nada de errado aconteceu.
    // Quantos passaram é `groups_evaluated`, logo abaixo.

    const feeRate = getFeeRate(groupCategory, directFeeRate);
    const yesPrices = eligibleMembers.map((m) => m.yesPrice);
    const priceSum = yesPrices.reduce((sum, p) => sum + p, 0);
    const grossDeviation = Math.abs(priceSum - 1.0);
    const { edgePct: expectedEdgePct, direction } = calculateExpectedEdgePct(priceSum, feeRate, yesPrices);
    const estimatedFeeCost = direction === 'over'
      ? estimateBuyNoBasketFeeCost(feeRate, yesPrices)
      : estimateBuyYesBasketFeeCost(feeRate, yesPrices);

    if (direction === 'under' && priceSum < 0.7) {
      groupsSkippedLowSum++;
      sample(lowSumSample, `${negRiskMarketId}: sum ${priceSum.toFixed(3)}, ${eligibleMembers.length} membros`);
      continue;
    }

    // Track category breakdown
    const catKey = groupCategory ?? 'unknown';
    byCategoryCount[catKey] = (byCategoryCount[catKey] ?? 0) + 1;

    // Edge alto continua merecendo olho — mas como amostra no log do ciclo, não
    // como linha por grupo. Acima de 5% costuma ser grupo incompleto, não dinheiro.
    if (expectedEdgePct > 5) {
      highEdgeGroups++;
      sample(
        highEdgeSample,
        `${negRiskMarketId}: ${expectedEdgePct.toFixed(2)}% ${direction}, sum ${priceSum.toFixed(3)}, cobertura ${(coverageRatio * 100).toFixed(0)}%`,
      );
    }

    // Skip entirely if edge too low to even log
    if (expectedEdgePct < logEdgePct) {
      groupsSkippedLowEdge++;
      continue;
    }

    flaggedCount++;

    // Confidence: 0 if below min threshold, otherwise scale to 10% = 1.0
    const confidenceScore =
      expectedEdgePct < minEdgePct ? 0 : Math.min(1.0, expectedEdgePct / 10.0);

    if (confidenceScore > 0) highConfidenceCount++;

    // Sort members by yes_price desc
    const sortedMembers = [...eligibleMembers].sort((a, b) => b.yesPrice - a.yesPrice);

    const memberList: CrossMarketInterMember[] = sortedMembers.map((m) => ({
      event_id: m.event.id,
      polymarket_id: m.event.polymarket_id,
      title: m.event.title,
      yes_price: m.yesPrice,
      volume_24h: m.event.volume_24h ?? 0,
    }));

    const leader = sortedMembers[0]!;
    const top3 = sortedMembers
      .slice(0, 3)
      .map((m) => `${m.event.title.split(' ')[1] ?? m.event.title} ${(m.yesPrice * 100).toFixed(1)}%`)
      .join(', ');

    const categoryLabel = groupCategory ?? 'categoria desconhecida';
    const reasoning =
      `Grupo de ${eligibleMembers.length} markets em ${categoryLabel} ` +
      `(fee ${(feeRate * 100).toFixed(1)}%). ` +
      `Soma ${(priceSum * 100).toFixed(2)}% (desvio bruto ${(grossDeviation * 100).toFixed(2)}%). ` +
      `Edge líquido estimado após fees: ${expectedEdgePct.toFixed(2)}%. ` +
      `Top 3: ${top3}. ` +
      `Volume 24h total: $${totalVolume.toFixed(0)}.`;

    const suggestedOutcome = direction === 'under' ? 'yes' : 'no';
    const eventIdForSignal = direction === 'under' ? leader.event.id : null;

    const now = new Date().toISOString();
    const memberEndDates = members
      .map((m) => m.end_date)
      .filter((d): d is string => Boolean(d))
      .sort();
    const expiresAt = memberEndDates[0] ?? null;

    // Dedup check — find existing active signal for this group
    const { data: existing, error: dedupError } = await supabase
      .from('detected_signals')
      .select('id, metadata')
      .eq('signal_type', 'cross_market_inter')
      .eq('dismissed', false)
      .eq('acted_on', false)
      .filter('metadata->>neg_risk_market_id', 'eq', negRiskMarketId)
      .limit(1)
      .maybeSingle();

    if (dedupError) {
      dedupQueryErrors.push(`${negRiskMarketId}: ${dedupError.message}`);
      continue;
    }

    if (existing) {
      dedupedCount++;
      const prevMeta = (existing.metadata ?? {}) as Partial<CrossMarketInterSignalMetadata>;
      const updatedMeta: CrossMarketInterSignalMetadata = {
        neg_risk_market_id: negRiskMarketId,
        polymarket_category: groupCategory,
        fee_rate: feeRate,
        group_size: eligibleMembers.length,
        price_sum: priceSum,
        deviation_gross: grossDeviation,
        estimated_fee_cost: estimatedFeeCost,
        deviation_net: grossDeviation - estimatedFeeCost,
        expected_edge_pct: expectedEdgePct,
        direction,
        coverage_ratio: 1.0,
        total_volume_24h: totalVolume,
        members: prevMeta.members ?? memberList,
        detection_count: (prevMeta.detection_count ?? 1) + 1,
        last_seen_at: now,
      };

      await supabase
        .from('detected_signals')
        .update({ confidence_score: confidenceScore, metadata: updatedMeta, expires_at: expiresAt })
        .eq('id', existing.id);
    } else {
      const metadata: CrossMarketInterSignalMetadata = {
        neg_risk_market_id: negRiskMarketId,
        polymarket_category: groupCategory,
        fee_rate: feeRate,
        group_size: eligibleMembers.length,
        price_sum: priceSum,
        deviation_gross: grossDeviation,
        estimated_fee_cost: estimatedFeeCost,
        deviation_net: grossDeviation - estimatedFeeCost,
        expected_edge_pct: expectedEdgePct,
        direction,
        coverage_ratio: 1.0,
        total_volume_24h: totalVolume,
        members: memberList,
        detection_count: 1,
        last_seen_at: now,
      };

      pendingSignals.push({
        event_id: eventIdForSignal,
        signal_type: 'cross_market_inter',
        confidence_score: confidenceScore,
        reasoning,
        metadata,
        suggested_outcome: suggestedOutcome,
        suggested_stake_pct: null,
        expires_at: expiresAt,
        alerted: false,
      });
    }
  }

  const signalsResult = await batchInsert('detected_signals', pendingSignals, {
    label: 'cross_market_inter_detector',
  });

  await logEvent({
    component: 'cross_market_inter_detector',
    status: signalsResult.errors.length > 0 || dedupQueryErrors.length > 0 ? 'partial' : 'success',
    message:
      `Evaluated ${groupsEvaluated} groups, ${flaggedCount} flagged, ${highConfidenceCount} high-confidence ` +
      `(edge >= ${minEdgePct}%), ${dedupedCount} deduped, ${groupsSkippedLowEdge} skipped low edge, ` +
      `${groupsSkippedLowCoverage} skipped low coverage, ${groupsSkippedLowSum} skipped low sum, ` +
      `${groupsSkippedStale} skipped stale` +
      `${highEdgeGroups > 0 ? `, ${highEdgeGroups} edge > 5% (conferir)` : ''}` +
      `${dedupQueryErrors.length > 0 ? `, ${dedupQueryErrors.length} query_errors` : ''}`,
    metadata: {
      groups_evaluated: groupsEvaluated,
      groups_skipped_too_small: groupsSkippedTooSmall,
      groups_skipped_low_volume: groupsSkippedLowVolume,
      groups_skipped_low_coverage: groupsSkippedLowCoverage,
      groups_skipped_low_edge: groupsSkippedLowEdge,
      groups_skipped_low_sum: groupsSkippedLowSum,
      groups_skipped_stale: groupsSkippedStale,
      groups_with_dropped_members: groupsWithDroppedMembers,
      members_dropped_low_price: membersDroppedLowPrice,
      members_without_yes_price: membersWithoutYesPrice,
      // Edge acima de 5% quase sempre é grupo incompleto. Fica visível sem custar
      // uma linha de log por grupo.
      high_edge_groups: highEdgeGroups,
      high_edge_sample: highEdgeSample.length > 0 ? highEdgeSample : null,
      // Amostras dos descartes: o contador dá o tamanho, estas dão o que abrir.
      low_coverage_sample: lowCoverageSample.length > 0 ? lowCoverageSample : null,
      low_sum_sample: lowSumSample.length > 0 ? lowSumSample : null,
      no_yes_price_sample: noYesPriceSample.length > 0 ? noYesPriceSample : null,
      dedup_query_errors: dedupQueryErrors.length,
      query_error_sample: dedupQueryErrors.length > 0 ? dedupQueryErrors.slice(0, SAMPLE_LIMIT) : null,
      flagged: flaggedCount,
      high_confidence: highConfidenceCount,
      deduped: dedupedCount,
      signals_inserted: signalsResult.written,
      duration_ms: Date.now() - start,
      by_category: byCategoryCount,
      write_errors: signalsResult.errors.length > 0 ? signalsResult.errors : null,
    },
  });
}
