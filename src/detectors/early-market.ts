import { supabase } from '../lib/supabase.js';
import { logEvent } from '../lib/logger.js';
import { getSystemConfig } from '../lib/config.js';

const FILTERS = {
  min_volume_24h: 3000,
  min_price_distance_from_default: 0.10,
  max_spread: 0.05,
  min_liquidity: 5000,
  // Cauda extrema: mercado já calibrou, sem oportunidade
  min_price_for_signal: 0.05,
  max_price_for_signal: 0.95,
  max_snapshot_age_minutes: 30,
};

export async function detectEarlyMarkets(): Promise<void> {
  const startedAt = Date.now();
  const config = await getSystemConfig();
  const SIGNAL_TTL_MS = config.signal_ttl_minutes * 60 * 1000;
  const COOLDOWN_AFTER_DISMISS_MS = config.signal_cooldown_minutes * 60 * 1000;

  // Pagina manualmente porque Supabase tem cap interno de 1000 por query
  // (PostgREST db-max-rows config). .limit() do client é ignorado se ultrapassar.
  const PAGE_SIZE = 1000;
  const MAX_PAGES = 20;
  const events: any[] = [];
  let pageCount = 0;
  const nowIso = new Date().toISOString();

  while (pageCount < MAX_PAGES) {
    const offset = pageCount * PAGE_SIZE;
    const { data: page, error: pageErr } = await supabase
      .from('events')
      .select('id, polymarket_id, title, start_date, end_date, outcomes, volume_24h, liquidity, polymarket_category')
      .eq('is_new_market', true)
      .eq('status', 'active')
      .gt('end_date', nowIso)
      .range(offset, offset + PAGE_SIZE - 1);

    if (pageErr) {
      await logEvent({
        component: 'early_market_detector',
        status: 'error',
        message: `events query failed at page ${pageCount}: ${pageErr.message}`,
      });
      return;
    }

    if (!page || page.length === 0) break;
    events.push(...page);
    if (page.length < PAGE_SIZE) break;
    pageCount++;
  }

  let evaluated = 0;
  let flagged = 0;
  let skippedStaleSnapshot = 0;
  let skippedFilters = 0;
  let skippedDedup = 0;

  for (const event of events) {
    evaluated++;

    const { data: snapshot } = await supabase
      .from('polymarket_snapshots')
      .select('best_bid, best_ask, mid_price, spread, captured_at')
      .eq('event_id', event.id)
      .order('captured_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!snapshot || snapshot.mid_price == null) continue;

    const snapshotAgeMs = Date.now() - new Date(snapshot.captured_at).getTime();
    if (snapshotAgeMs > FILTERS.max_snapshot_age_minutes * 60 * 1000) {
      skippedStaleSnapshot++;
      continue;
    }

    const currentPrice = snapshot.mid_price;
    const spread = snapshot.spread ?? 1;
    const volume24h = Number(event.volume_24h ?? 0);
    const liquidity = Number(event.liquidity ?? 0);

    if (volume24h < FILTERS.min_volume_24h) { skippedFilters++; continue; }
    if (Math.abs(currentPrice - 0.5) < FILTERS.min_price_distance_from_default) { skippedFilters++; continue; }
    if (currentPrice < FILTERS.min_price_for_signal || currentPrice > FILTERS.max_price_for_signal) { skippedFilters++; continue; }
    if (spread >= FILTERS.max_spread) { skippedFilters++; continue; }
    if (liquidity < FILTERS.min_liquidity) { skippedFilters++; continue; }

    const cooldownCutoff = new Date(Date.now() - COOLDOWN_AFTER_DISMISS_MS).toISOString();
    const { data: existing } = await supabase
      .from('detected_signals')
      .select('id, expires_at, dismissed, user_dismissed_at')
      .eq('signal_type', 'early_market')
      .eq('event_id', event.id)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (existing) {
      const stillActive = existing.expires_at > new Date().toISOString();
      const recentDismiss =
        existing.dismissed &&
        existing.user_dismissed_at &&
        existing.user_dismissed_at > cooldownCutoff;

      if (stillActive && !existing.dismissed) {
        await supabase
          .from('detected_signals')
          .update({
            expires_at: new Date(Date.now() + SIGNAL_TTL_MS).toISOString(),
            metadata: buildMetadata(event, currentPrice, volume24h, liquidity, spread),
          })
          .eq('id', existing.id);
        skippedDedup++;
        continue;
      }

      if (recentDismiss) {
        skippedDedup++;
        continue;
      }
    }

    const outcomes = (event.outcomes as { values?: string[] })?.values ?? ['Yes', 'No'];
    const primaryOutcome = outcomes[0] ?? 'Yes';
    const secondaryOutcome = outcomes[1] ?? 'No';

    const startDateMs = new Date(event.start_date as string).getTime();
    const hoursSinceOpen = (Date.now() - startDateMs) / (60 * 60 * 1000);

    const { data: firstSnap } = await supabase
      .from('polymarket_snapshots')
      .select('mid_price, captured_at')
      .eq('event_id', event.id)
      .order('captured_at', { ascending: true })
      .limit(1)
      .maybeSingle();

    const initialPrice = firstSnap?.mid_price ?? null;
    const priceMovementPct =
      initialPrice != null ? ((currentPrice - initialPrice) / initialPrice) * 100 : null;

    const metadata = {
      start_date: event.start_date,
      hours_since_open: hoursSinceOpen,
      current_yes_price: currentPrice,
      initial_yes_price: initialPrice,
      price_movement_pct: priceMovementPct,
      current_volume_24h: volume24h,
      current_liquidity: liquidity,
      current_spread: spread,
      category: event.polymarket_category,
      primary_outcome: primaryOutcome,
      secondary_outcome: secondaryOutcome,
      last_seen_at: new Date().toISOString(),
    };

    const { error: insErr } = await supabase.from('detected_signals').insert({
      signal_type: 'early_market',
      event_id: event.id,
      suggested_outcome: null,
      confidence_score: 0.5,
      reasoning: 'Early market: smart money signal detected in <24h market',
      metadata,
      expires_at: new Date(Date.now() + SIGNAL_TTL_MS).toISOString(),
    });

    if (!insErr) flagged++;
  }

  const durationMs = Date.now() - startedAt;
  await logEvent({
    component: 'early_market_detector',
    status: 'success',
    message: `Evaluated ${evaluated} new markets, ${flagged} flagged, ${skippedStaleSnapshot} stale snapshot, ${skippedFilters} skipped filters, ${skippedDedup} deduped in ${durationMs}ms`,
    metadata: { evaluated, flagged, skipped_stale_snapshot: skippedStaleSnapshot, skipped_filters: skippedFilters, skipped_dedup: skippedDedup, duration_ms: durationMs },
  });
}

function buildMetadata(
  event: any,
  currentPrice: number,
  volume24h: number,
  liquidity: number,
  spread: number,
): Record<string, unknown> {
  const outcomes = (event.outcomes as { values?: string[] })?.values ?? ['Yes', 'No'];
  const startDateMs = new Date(event.start_date as string).getTime();
  const hoursSinceOpen = (Date.now() - startDateMs) / (60 * 60 * 1000);

  return {
    start_date: event.start_date,
    hours_since_open: hoursSinceOpen,
    current_yes_price: currentPrice,
    current_volume_24h: volume24h,
    current_liquidity: liquidity,
    current_spread: spread,
    category: event.polymarket_category,
    primary_outcome: outcomes[0] ?? 'Yes',
    secondary_outcome: outcomes[1] ?? 'No',
    last_seen_at: new Date().toISOString(),
  };
}
