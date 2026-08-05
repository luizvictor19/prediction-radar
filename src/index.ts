import 'dotenv/config';
import cron from 'node-cron';
import { collectAll } from './collectors/polymarket.js';
import { collectOpenLegMarkets } from './collectors/open-legs-collector.js';
import { collectEarlyMarkets } from './collectors/early-markets-collector.js';
import { collectDiscovery } from './collectors/discovery-collector.js';
import { collectWatchlist } from './collectors/watchlist-collector.js';
import { detectResolvedMarkets } from './collectors/resolved-detector.js';
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
  cron.schedule('*/10 * * * * *', () => {
    void collectOpenLegMarkets().catch(err => console.error('[cron open_legs]', err));
  });

  // Descoberta por startDate (spec 000, item 2a). Roda ao lado da varredura por
  // volume nesta etapa, de propósito, para comparar o que cada uma enxerga.
  //
  // A cadência não é arbitrária: o teto de offset 2000 da Gamma alcança só ~36min
  // de criação de markets (medido 2026-08-04). A cada 3min a janela é de ~5min,
  // ~10x de folga na taxa normal e ainda dentro do teto em rajada.
  cron.schedule('*/3 * * * *', () => {
    void collectDiscovery().catch(err => console.error('[cron discovery]', err));
  });

  void collectDiscovery().catch(err =>
    console.error('[discovery] Initial run failed:', err),
  );

  // Refresh da watchlist de esports (spec 000, item 2b). Fecha a lacuna que a
  // descoberta abriu: o market de esports nasce com volume 0, não entra na
  // varredura por volume nem tem aposta aberta — descoberto no minuto em que
  // nasce e, sem isto, sem nenhuma leitura de preço depois.
  //
  // 3min é a granularidade atual dos snapshots. Cadência por estado da partida
  // (5min / 1min / 10-15s ao vivo) é o item 7, não este.
  cron.schedule('*/3 * * * *', () => {
    void collectWatchlist().catch(err => console.error('[cron watchlist]', err));
  });

  void collectWatchlist().catch(err =>
    console.error('[watchlist] Initial run failed:', err),
  );

  // Auto-resolver: componente próprio (spec 000, item 2c). Antes rodava no fim
  // do collectAll e recebia dele o conjunto "sumiu do feed" — quando a varredura
  // por volume for desligada no item 4, ela levaria o auto-resolver junto.
  // O custo agora é ~2 requisições por 100 candidatos, então 5min é folgado.
  cron.schedule('*/5 * * * *', () => {
    void detectResolvedMarkets().catch(err => console.error('[cron resolved]', err));
  });

  void detectResolvedMarkets().catch(err =>
    console.error('[resolved] Initial run failed:', err),
  );

  // Ciclo leva ~5-7min; 15min dá folga e o lock interno previne overlap
  cron.schedule('*/15 * * * *', () => {
    void runAllDetectors().catch(err => console.error('[cron detectors]', err));
  });

  void collectEarlyMarkets().catch(err =>
    console.error('[early-markets] Initial run failed:', err),
  );
  cron.schedule('*/10 * * * *', () => {
    void collectEarlyMarkets().catch(err => console.error('[cron early-markets]', err));
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
