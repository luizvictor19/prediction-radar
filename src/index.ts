import 'dotenv/config';
import { collectMarkets, collectSnapshots } from './collectors/polymarket.js';

const COLLECT_MARKETS_INTERVAL_MS = 3 * 60 * 1000;   // 3 min
const COLLECT_SNAPSHOTS_INTERVAL_MS = 3 * 60 * 1000;  // 3 min

async function main(): Promise<void> {
  console.log('[main] Prediction Radar starting...');

  // Initial run
  await collectMarkets();
  await collectSnapshots();

  // Recurring collection
  setInterval(() => { void collectMarkets(); }, COLLECT_MARKETS_INTERVAL_MS);
  setInterval(() => { void collectSnapshots(); }, COLLECT_SNAPSHOTS_INTERVAL_MS);

  console.log('[main] Crons scheduled. Running.');
}

main().catch((err) => {
  console.error('[main] Fatal error:', err);
  process.exit(1);
});
