import 'dotenv/config';
import { supabase } from '../src/lib/supabase.js';

const GAMMA_URL = process.env['POLYMARKET_GAMMA_URL'] ?? 'https://gamma-api.polymarket.com';
const RATE_LIMIT_MS = 100;

interface EventRow {
  id: string;
  slug: string | null;
  title: string;
}

async function fetchMarketBySlug(slug: string) {
  const res = await fetch(`${GAMMA_URL}/markets?slug=${encodeURIComponent(slug)}`, {
    headers: { Accept: 'application/json' },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = (await res.json()) as Array<Record<string, unknown>>;
  return data[0] ?? null;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  console.log('[backfill-neg-risk] Starting...');

  const { data: events, error } = await supabase
    .from('events')
    .select('id, slug, title')
    .is('neg_risk_market_id', null)
    .not('slug', 'is', null);

  if (error) {
    console.error('[backfill-neg-risk] Failed to fetch events:', error.message);
    process.exit(1);
  }

  const rows = (events ?? []) as EventRow[];
  console.log(`[backfill-neg-risk] ${rows.length} events to process`);

  let processed = 0;
  let updated = 0;
  let skipped = 0;
  let errors = 0;

  for (const event of rows) {
    if (!event.slug) {
      skipped++;
      continue;
    }

    try {
      const market = await fetchMarketBySlug(event.slug);

      if (!market) {
        console.warn(`[backfill-neg-risk] 404 for slug "${event.slug}" — marking inactive`);
        await supabase.from('events').update({ status: 'inactive' }).eq('id', event.id);
        skipped++;
      } else {
        const series = market['series'] as Array<{ id: string; slug: string; recurrence?: string }> | null;

        await supabase
          .from('events')
          .update({
            neg_risk_market_id: (market['negRiskMarketID'] as string | null) ?? null,
            series_id: series?.[0]?.id ?? null,
            series_slug: series?.[0]?.slug ?? null,
            series_recurrence: series?.[0]?.recurrence ?? null,
            event_metadata: (market['eventMetadata'] as Record<string, unknown> | null) ?? null,
          })
          .eq('id', event.id);

        if (market['negRiskMarketID']) {
          updated++;
        } else {
          skipped++;
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[backfill-neg-risk] Error on "${event.slug}": ${msg}`);
      errors++;
    }

    processed++;

    if (processed % 10 === 0) {
      console.log(`[backfill-neg-risk] Progress: ${processed}/${rows.length} — updated=${updated} skipped=${skipped} errors=${errors}`);
    }

    await sleep(RATE_LIMIT_MS);
  }

  console.log(`[backfill-neg-risk] Done. Total=${rows.length} updated=${updated} skipped=${skipped} errors=${errors}`);
}

main().catch((err) => {
  console.error('[backfill-neg-risk] Fatal:', err);
  process.exit(1);
});
