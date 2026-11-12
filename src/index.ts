import 'dotenv/config';
import cron from 'node-cron';
import { collectOpenLegMarkets } from './collectors/open-legs-collector.js';
import { collectRadar } from './collectors/radar-collector.js';
import { detectResolvedMarkets } from './collectors/resolved-detector.js';
import { runRetentionJob } from './jobs/retention.js';
import { runEsportsPartitionJob } from './jobs/esports-partitions.js';

async function main(): Promise<void> {
  console.log('[main] Prediction Radar starting...');

  void collectOpenLegMarkets().catch((err) =>
    console.error('[main] Initial open_legs failed:', err),
  );
  cron.schedule('*/10 * * * * *', () => {
    void collectOpenLegMarkets().catch((err) => console.error('[cron open_legs]', err));
  });

  // Auto-resolver: componente próprio (spec 000, item 2c). Antes rodava no fim
  // do collectAll e recebia dele o conjunto "sumiu do feed" — quando a varredura
  // por volume for desligada no item 4, ela levaria o auto-resolver junto.
  // O custo agora é ~2 requisições por 100 candidatos, então 5min é folgado.
  cron.schedule('*/5 * * * *', () => {
    void detectResolvedMarkets().catch((err) => console.error('[cron resolved]', err));
  });

  void detectResolvedMarkets().catch((err) => console.error('[resolved] Initial run failed:', err));

  // Coletor do radar: a lista viva de mercados que o dono consegue julgar, e a
  // série de preço dela. Nasce desligado (`radar_collector_enabled`).
  //
  // O tick de 5 min NÃO é a cadência de nada. Quem decide são os dois intervalos
  // da config — foto a cada 15 min, roster a cada 6h — e o tick só precisa ser
  // mais rápido que o menor deles.
  //
  // Sem execução no start: o primeiro ciclo é o
  // mais caro que existe (renova o roster inteiro, ~30 chamadas à Gamma) e o
  // boot já dispara outras cargas contra o mesmo Postgres. O que se ganha
  // esperando até 5 minutos é nada: a série é de dias, não de minutos.
  cron.schedule('*/5 * * * *', () => {
    void collectRadar().catch((err) => console.error('[cron radar]', err));
  });

  // Partições de `esports_snapshots` (spec 000, item 3): cria as dos próximos
  // dias e dropa as vencidas. Roda antes da retenção porque são coisas opostas —
  // a retenção deleta linha de `polymarket_snapshots` (e é o DELETE em ciclo que
  // inflou um índice para 1492 MB); aqui a limpeza é DROP PARTITION.
  //
  // Diário basta: a folga de criação é de 2 dias à frente. A execução no start
  // garante que um deploy no horário do cron não deixe o dia sem partição.
  cron.schedule('30 2 * * *', () => {
    void runEsportsPartitionJob().catch((err) => console.error('[cron esports_partitions]', err));
  });

  void runEsportsPartitionJob().catch((err) =>
    console.error('[esports_partitions] Initial run failed:', err),
  );

  cron.schedule('0 3 * * *', () => {
    void runRetentionJob().catch((err) => console.error('[cron retention]', err));
  });

  // Run once at startup so cleanup happens immediately after deploy
  void runRetentionJob().catch((err) => console.error('[retention] Initial run failed:', err));

  console.log('[main] Cron jobs scheduled. Running.');
}

main().catch((err) => {
  console.error('[main] Fatal error:', err);
  process.exit(1);
});
