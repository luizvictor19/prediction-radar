import type { CrossMarketInterSignalMetadata, CrossMarketInterMember } from '../types/index.js';
import { supabase } from '../lib/supabase.js';
import { getSystemConfig } from '../lib/config.js';
import { logEvent } from '../lib/logger.js';

interface EventRow {
  id: string;
  polymarket_id: string;
  title: string;
  outcomes: { values: string[]; prices: string[] } | null;
  neg_risk_market_id: string;
  volume_24h: number | null;
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
    cross_market_log_threshold: logThreshold,
    cross_market_high_confidence_threshold: highConfidenceThreshold,
    cross_market_dedup_window_minutes: dedupWindowMinutes,
    inter_market_min_members: minMembers,
    inter_market_min_total_volume_24h: minTotalVolume,
  } = config;

  const { data: events, error: fetchError } = await supabase
    .from('events')
    .select('id, polymarket_id, title, outcomes, neg_risk_market_id, volume_24h')
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

  let groupsEvaluated = 0;
  let groupsSkippedTooSmall = 0;
  let groupsSkippedLowVolume = 0;
  let flaggedCount = 0;
  let highConfidenceCount = 0;
  let dedupedCount = 0;

  for (const [negRiskMarketId, members] of groups) {
    if (members.length < minMembers) {
      groupsSkippedTooSmall++;
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

    const priceSum = validMembers.reduce((sum, m) => sum + m.yesPrice, 0);
    const deviation = Math.abs(priceSum - 1.0);

    if (deviation < logThreshold) continue;

    flaggedCount++;
    const confidenceScore = Math.min(1.0, deviation / 0.15);
    if (deviation >= highConfidenceThreshold) highConfidenceCount++;

    const direction: 'over' | 'under' = priceSum > 1.0 ? 'over' : 'under';

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
    const top3 = sortedMembers.slice(0, 3)
      .map((m) => `${m.event.title.replace(/^Will /, '').replace(/ have the best.*$/, '')} ${(m.yesPrice * 100).toFixed(2)}%`)
      .join(', ');

    const directionLabel = direction === 'over' ? 'Sobreprecificação' : 'Subprecificação';
    const reasoning = `Grupo de ${validMembers.length} markets relacionados (negRiskMarketID ${negRiskMarketId.slice(0, 10)}...) soma ${(priceSum * 100).toFixed(2)}% (desvio ${(deviation * 100).toFixed(2)}%). ${directionLabel} coletiva. Top 3: ${top3}. Volume 24h total: $${Math.round(totalVolume).toLocaleString()}.`;

    const suggestedOutcome = direction === 'under' ? 'long_leader' : 'short_basket';

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
        group_size: validMembers.length,
        price_sum: priceSum,
        deviation,
        direction,
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
        group_size: validMembers.length,
        price_sum: priceSum,
        deviation,
        direction,
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
      });
    }
  }

  await logEvent({
    component: 'cross_market_inter_detector',
    status: 'success',
    message: `Evaluated ${groupsEvaluated} groups, ${flaggedCount} flagged, ${highConfidenceCount} high-confidence, ${dedupedCount} deduped`,
    metadata: {
      groups_evaluated: groupsEvaluated,
      groups_skipped_too_small: groupsSkippedTooSmall,
      groups_skipped_low_volume: groupsSkippedLowVolume,
      flagged: flaggedCount,
      high_confidence: highConfidenceCount,
      deduped: dedupedCount,
      duration_ms: Date.now() - start,
    },
  });
}
