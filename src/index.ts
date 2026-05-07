import 'dotenv/config';
import cron from 'node-cron';
import { collectAll } from './collectors/polymarket.js';
import { collectOpenLegMarkets } from './collectors/open-legs-collector.js';
import { runAllDetectors } from './detectors/runner.js';
import { runRetentionJob } from './jobs/retention.js';

async function main(): Promise<void> {
  console.log('[main] Prediction Radar starting...');

  // Schedule crons FIRST so they run regardless of initial collection state
  cron.schedule('*/3 * * * *', () => {
    void collectAll().catch(err => console.error('[cron collectAll]', err));
  });

  void collectOpenLegMarkets().catch(err =>
    console.error('[main] Initial open_legs failed:', err),
  );
  cron.schedule('*/30 * * * * *', () => {
    void collectOpenLegMarkets().catch(err => console.error('[cron open_legs]', err));
  });

  cron.schedule('*/5 * * * *', () => {
    void runAllDetectors().catch(err => console.error('[cron detectors]', err));
  });

  cron.schedule('0 3 * * *', () => {
    void runRetentionJob().catch(err => console.error('[cron retention]', err));
  });

  // Run once at startup so cleanup happens immediately after deploy
  void runRetentionJob().catch(err => console.error('[retention] Initial run failed:', err));

  console.log('[main] Cron jobs scheduled. Running.');

  // Fire initial collectAll AFTER crons are scheduled — fire-and-forget
  void collectAll().catch(err =>
    console.error('[main] Initial collection failed (will retry on cron):', err),
  );
}

main().catch((err) => {
  console.error('[main] Fatal error:', err);
  process.exit(1);
});
