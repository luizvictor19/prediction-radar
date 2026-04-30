import 'dotenv/config';
import { collectAll } from './collectors/polymarket.js';

const COLLECT_INTERVAL_MS = 3 * 60 * 1000; // 3 min

async function main(): Promise<void> {
  console.log('[main] Prediction Radar starting...');

  await collectAll();

  setInterval(() => { void collectAll(); }, COLLECT_INTERVAL_MS);

  console.log('[main] Collection cron scheduled. Running.');
}

main().catch((err) => {
  console.error('[main] Fatal error:', err);
  process.exit(1);
});
