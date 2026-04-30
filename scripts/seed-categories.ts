import 'dotenv/config';
import { supabase } from '../src/lib/supabase.js';
import { categorizeMarket } from '../src/collectors/categorizer.js';
import type { GammaMarket } from '../src/types/index.js';

async function seed(): Promise<void> {
  console.log('[seed] Re-categorizing all events...');

  const { data: events, error } = await supabase
    .from('events')
    .select('id, polymarket_id, title, description');

  if (error || !events) {
    console.error('[seed] Failed:', error?.message);
    process.exit(1);
  }

  let updated = 0;
  for (const event of events) {
    const fakeMarket = {
      id: event.polymarket_id,
      title: event.title ?? '',
      description: event.description ?? '',
    } as GammaMarket;

    const { category, sub_category } = categorizeMarket(fakeMarket);

    await supabase
      .from('events')
      .update({ category, sub_category, updated_at: new Date().toISOString() })
      .eq('id', event.id);

    updated++;
  }

  console.log(`[seed] Updated ${updated} events.`);
}

seed().catch(console.error);
