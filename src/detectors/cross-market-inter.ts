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

interface EventRow {
  id: string;
  polymarket_id: string;
  title: string;
  outcomes: { values: string[]; prices: string[] } | null;
  neg_risk_market_id: string;
  volume_24h: number | null;
  polymarket_category: string | null;
  polymarket_fee_rate: number | null;
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
    cross_market_dedup_window_minutes: dedupWindowMinutes,
    inter_market_min_members: minMembers,
    inter_market_min_total_volume_24h: minTotalVolume,
    min_expected_edge_pct: minEdgePct,
    log_expected_edge_pct: logEdgePct,
  } = config;

  const { data: events, error: fetchError } = await supabase
    .from('events')
    .select('id, polymarket_id, title, outcomes, neg_risk_market_id, volume_24h, polymarket_category, polymarket_fee_rate')
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

  // Staleness filter: build set of event IDs with a snapshot in the last 30 min
  const stalenessThreshold = new Date(Date.now() - 30 * 60 * 1000).toISOString();
  const allEventIds = rows.map((r) => r.id);
  let liveEventIds = new Set<string>(allEventIds); // fail-open: all live if query fails
  if (allEventIds.length > 0) {
    const { data: recentSnaps, error: staleErr } = await supabase
      .from('polymarket_snapshots')
      .select('event_id')
      .in('event_id', allEventIds)
      .gte('captured_at', stalenessThreshold);

    if (staleErr) {
      await logEvent({
        component: 'cross_market_inter_detector',
        status: 'error',
        message: `Staleness check query failed: ${staleErr.message}`,
        metadata: { error: staleErr.message },
      });
    } else {
      liveEventIds = new Set((recentSnaps ?? []).map((s) => s.event_id as string));
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
  const byCategoryCount: Record<string, number> = {};

  // Build DB-based group size map (no end_date or volume filter — all active members)
  const groupTotalMap = new Map<string, number>();
  const candidateNRIDs = [...groups.keys()];
  if (candidateNRIDs.length > 0) {
    const { data: allNegRiskRows, error: sizeErr } = await supabase
      .from('events')
      .select('neg_risk_market_id')
      .eq('status', 'active')
      .in('neg_risk_market_id', candidateNRIDs);

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
        await logEvent({
          component: 'cross_market_inter_detector',
          status: 'error',
          message: `Member ${event.id} has no valid Yes price — skipping member`,
          metadata: { event_id: event.id, title: event.title, neg_risk_market_id: negRiskMarketId },
        });
        continue;
      }
      validMembers.push({ event, yesPrice });
    }

    if (validMembers.length < minMembers) {
      groupsSkippedTooSmall++;
      continue;
    }

    const totalVolume = validMembers.reduce((sum, m) => sum + (m.event.volume_24h ?? 0), 0);
    if (totalVolume < minTotalVolume) {
      groupsSkippedLowVolume++;
      continue;
    }

    groupsEvaluated++;

    // Category + fee rate = taken from member with highest volume_24h
    // (all members in a negRisk group share the same feeType and feeSchedule)
    const leadByVolume = validMembers
      .sort((a, b) => (b.event.volume_24h ?? 0) - (a.event.volume_24h ?? 0))[0]!;
    const groupCategory = leadByVolume.event.polymarket_category ?? null;
    const directFeeRate = leadByVolume.event.polymarket_fee_rate ?? null;

    // Coverage guard: discard group if we don't hold all DB-tracked members.
    // Incomplete coverage makes priceSum artificially low, producing phantom edge.
    const totalGroupSize = groupTotalMap.get(negRiskMarketId) ?? 0;
    const coverageRatio = totalGroupSize > 0 ? validMembers.length / totalGroupSize : 0;
    if (coverageRatio < 0.95) {
      await logEvent({
        component: 'cross_market_inter_detector',
        status: 'partial',
        message: `Group ${negRiskMarketId} skipped: incomplete coverage ${validMembers.length}/${totalGroupSize} (${(coverageRatio * 100).toFixed(1)}%)`,
        metadata: {
          neg_risk_market_id: negRiskMarketId,
          coverage_ratio: coverageRatio,
          category: groupCategory ?? 'unknown',
        },
      });
      groupsSkippedLowCoverage++;
      continue;
    }

    await logEvent({
      component: 'cross_market_inter_detector',
      status: 'partial',
      message: `Group ${negRiskMarketId} passed coverage: ${validMembers.length}/${totalGroupSize} (${(coverageRatio * 100).toFixed(1)}%)`,
      metadata: {
        neg_risk_market_id: negRiskMarketId,
        coverage_ratio: coverageRatio,
        category: groupCategory ?? 'unknown',
      },
    });

    const feeRate = getFeeRate(groupCategory, directFeeRate);
    const yesPrices = validMembers.map((m) => m.yesPrice);
    const priceSum = yesPrices.reduce((sum, p) => sum + p, 0);
    const grossDeviation = Math.abs(priceSum - 1.0);
    const { edgePct: expectedEdgePct, direction } = calculateExpectedEdgePct(priceSum, feeRate, yesPrices);
    const estimatedFeeCost = direction === 'over'
      ? estimateBuyNoBasketFeeCost(feeRate, yesPrices)
      : estimateBuyYesBasketFeeCost(feeRate, yesPrices);

    if (direction === 'under' && priceSum < 0.7) {
      await logEvent({
        component: 'cross_market_inter_detector',
        status: 'partial',
        message: `Group ${negRiskMarketId} skipped: 'under' with price_sum ${priceSum.toFixed(3)} < 0.7 (likely incomplete group / closed members)`,
        metadata: {
          neg_risk_market_id: negRiskMarketId,
          price_sum: priceSum,
          direction,
          group_size: validMembers.length,
          category: groupCategory ?? 'unknown',
        },
      });
      groupsSkippedLowSum++;
      continue;
    }

    // Track category breakdown
    const catKey = groupCategory ?? 'unknown';
    byCategoryCount[catKey] = (byCategoryCount[catKey] ?? 0) + 1;

    // Temporary: warn on suspiciously high edge so early runs can be inspected manually
    if (expectedEdgePct > 5) {
      await logEvent({
        component: 'cross_market_inter_detector',
        status: 'partial',
        message: `High-edge signal ${negRiskMarketId}: ${expectedEdgePct.toFixed(2)}% — manual inspection recommended`,
        metadata: {
          neg_risk_market_id: negRiskMarketId,
          edge_pct: expectedEdgePct,
          direction,
          price_sum: priceSum,
          coverage_ratio: coverageRatio,
          category: groupCategory ?? 'unknown',
        },
      });
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
    const sortedMembers = [...validMembers].sort((a, b) => b.yesPrice - a.yesPrice);

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
      `Grupo de ${validMembers.length} markets em ${categoryLabel} ` +
      `(fee ${(feeRate * 100).toFixed(1)}%). ` +
      `Soma ${(priceSum * 100).toFixed(2)}% (desvio bruto ${(grossDeviation * 100).toFixed(2)}%). ` +
      `Edge líquido estimado após fees: ${expectedEdgePct.toFixed(2)}%. ` +
      `Top 3: ${top3}. ` +
      `Volume 24h total: $${totalVolume.toFixed(0)}.`;

    const suggestedOutcome = direction === 'under' ? 'yes' : 'no';
    const eventIdForSignal = direction === 'under' ? leader.event.id : null;

    const now = new Date().toISOString();
    const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();
    const dedupCutoff = new Date(Date.now() - dedupWindowMinutes * 60 * 1000).toISOString();

    // Dedup check — find existing active signal for this group
    const { data: existing, error: dedupError } = await supabase
      .from('detected_signals')
      .select('id, metadata')
      .eq('signal_type', 'cross_market_inter')
      .eq('dismissed', false)
      .eq('acted_on', false)
      .gte('created_at', dedupCutoff)
      .filter('metadata->>neg_risk_market_id', 'eq', negRiskMarketId)
      .limit(1)
      .maybeSingle();

    if (dedupError) {
      await logEvent({
        component: 'cross_market_inter_detector',
        status: 'error',
        message: `Dedup query failed for group ${negRiskMarketId}: ${dedupError.message}`,
        metadata: { neg_risk_market_id: negRiskMarketId, error: dedupError.message },
      });
      continue;
    }

    if (existing) {
      dedupedCount++;
      const prevMeta = (existing.metadata ?? {}) as Partial<CrossMarketInterSignalMetadata>;
      const updatedMeta: CrossMarketInterSignalMetadata = {
        neg_risk_market_id: negRiskMarketId,
        polymarket_category: groupCategory,
        fee_rate: feeRate,
        group_size: validMembers.length,
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
        .update({ confidence_score: confidenceScore, metadata: updatedMeta })
        .eq('id', existing.id);
    } else {
      const metadata: CrossMarketInterSignalMetadata = {
        neg_risk_market_id: negRiskMarketId,
        polymarket_category: groupCategory,
        fee_rate: feeRate,
        group_size: validMembers.length,
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

      await supabase.from('detected_signals').insert({
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

  await logEvent({
    component: 'cross_market_inter_detector',
    status: 'success',
    message: `Evaluated ${groupsEvaluated} groups, ${flaggedCount} flagged, ${highConfidenceCount} high-confidence (edge >= ${minEdgePct}%), ${dedupedCount} deduped, ${groupsSkippedLowEdge} skipped low edge, ${groupsSkippedLowCoverage} skipped low coverage, ${groupsSkippedLowSum} skipped low sum, ${groupsSkippedStale} skipped stale`,
    metadata: {
      groups_evaluated: groupsEvaluated,
      groups_skipped_too_small: groupsSkippedTooSmall,
      groups_skipped_low_volume: groupsSkippedLowVolume,
      groups_skipped_low_coverage: groupsSkippedLowCoverage,
      groups_skipped_low_edge: groupsSkippedLowEdge,
      groups_skipped_low_sum: groupsSkippedLowSum,
      groups_skipped_stale: groupsSkippedStale,
      flagged: flaggedCount,
      high_confidence: highConfidenceCount,
      deduped: dedupedCount,
      duration_ms: Date.now() - start,
      by_category: byCategoryCount,
    },
  });
}
