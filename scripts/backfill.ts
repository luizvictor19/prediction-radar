import 'dotenv/config';
import { collectMarkets, collectSnapshots } from '../src/collectors/polymarket.js';

async function backfill(): Promise<void> {
  console.log('[backfill] Running full market collection and snapshot pass...');
  await collectMarkets();
  await collectSnapshots();
  console.log('[backfill] Done.');
}

backfill().catch(console.error);
