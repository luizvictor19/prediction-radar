import 'dotenv/config';
import cron from 'node-cron';
import { collectAll } from './collectors/polymarket.js';
import { collectOpenLegMarkets } from './collectors/open-legs-collector.js';
import { runAllDetectors } from './detectors/runner.js';
import { runRetentionJob } from './jobs/retention.js';

async function main(): Promise<void> {
  console.log('[main] Prediction Radar starting...');

  try {
    await collectAll();
  } catch (err) {
    console.error('[main] Initial collection failed (will retry on cron):', err);
  }

  // Collector: every 3 minutes
  cron.schedule('*/3 * * * *', () => {
    void collectAll();
  });

  // Open legs collector: every 30 seconds (mid_price fresco pra /positions e /status)
  void collectOpenLegMarkets();
  cron.schedule('*/30 * * * * *', () => {
    void collectOpenLegMarkets();
  });

  // Detector runner: every 5 minutes
  cron.schedule('*/5 * * * *', () => {
    void runAllDetectors();
  });

  // Retention job: daily at 3am UTC
  cron.schedule('0 3 * * *', () => {
    void runRetentionJob();
  });

  console.log('[main] Cron jobs scheduled. Running.');
}

main().catch((err) => {
  console.error('[main] Fatal error:', err);
  process.exit(1);
});
