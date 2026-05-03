import 'dotenv/config';
import { supabase } from '../src/lib/supabase.js';
import { categorizeMarket } from '../src/collectors/categorizer.js';

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
  console.log('[backfill-polymarket-category] Starting...');

  const { data: events, error } = await supabase
    .from('events')
    .select('id, slug, title')
    .is('polymarket_category', null)
    .not('slug', 'is', null);

  if (error) {
    console.error('[backfill-polymarket-category] Failed to fetch events:', error.message);
    process.exit(1);
  }

  const rows = (events ?? []) as EventRow[];
  console.log(`[backfill-polymarket-category] ${rows.length} events to backfill`);

  let processed = 0;
  let updated = 0;
  let skipped = 0;
  let errors = 0;
  const categoryDistribution: Record<string, number> = {};

  for (const event of rows) {
    if (!event.slug) {
      skipped++;
      processed++;
      continue;
    }

    try {
      const market = await fetchMarketBySlug(event.slug);

      if (!market) {
        console.warn(`[backfill-polymarket-category] 404 for slug "${event.slug}" — skipping`);
        skipped++;
      } else {
        const feeType = (market['feeType'] as string | null) ?? null;
        const feeSchedule = market['feeSchedule'] as { rate?: number } | null;
        const feeRate = feeSchedule?.rate ?? null;
        // Recalculate is_ai_tech using the categorizer
        const { category: internalCategory } = categorizeMarket({
          question: (market['question'] as string) ?? event.title,
          id: market['id'] as string,
          slug: event.slug,
          description: (market['description'] as string) ?? '',
          outcomes: (market['outcomes'] as string) ?? '["Yes","No"]',
          outcomePrices: (market['outcomePrices'] as string) ?? '["0.5","0.5"]',
          active: true,
          closed: false,
          bestBid: 0,
          bestAsk: 0,
          spread: 0,
          lastTradePrice: 0,
          endDate: (market['endDate'] as string) ?? '',
        });
        const isAiTech = internalCategory !== 'other';

        const { error: updateErr } = await supabase
          .from('events')
          .update({ polymarket_category: feeType, polymarket_fee_rate: feeRate, is_ai_tech: isAiTech })
          .eq('id', event.id);

        if (updateErr) {
          console.error(`[backfill-polymarket-category] Update failed for ${event.id}:`, updateErr.message);
          errors++;
        } else {
          updated++;
          const key = feeType ?? 'null';
          categoryDistribution[key] = (categoryDistribution[key] ?? 0) + 1;
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[backfill-polymarket-category] Error on "${event.slug}": ${msg}`);
      errors++;
    }

    processed++;

    if (processed % 20 === 0) {
      console.log(
        `[backfill-polymarket-category] Progress: ${processed}/${rows.length} — updated=${updated} skipped=${skipped} errors=${errors}`,
      );
    }

    await sleep(RATE_LIMIT_MS);
  }

  console.log(
    `[backfill-polymarket-category] Done. Total=${rows.length} updated=${updated} skipped=${skipped} errors=${errors}`,
  );
  console.log('[backfill-polymarket-category] Category distribution:', categoryDistribution);
}

main().catch((err) => {
  console.error('[backfill-polymarket-category] Fatal:', err);
  process.exit(1);
});
