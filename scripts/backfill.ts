import 'dotenv/config';
import { collectAll } from '../src/collectors/polymarket.js';

async function backfill(): Promise<void> {
  console.log('[backfill] Running full market collection and snapshot pass...');
  await collectAll();
  console.log('[backfill] Done.');
}

backfill().catch(console.error);
