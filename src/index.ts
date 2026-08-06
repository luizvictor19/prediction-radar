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
import { runEsportsPartitionJob } from './jobs/esports-partitions.js';
import { runEsportsResolver, runEsportsResolverRecompute } from './jobs/esports-resolver.js';

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

  // Refresh da watchlist de esports (spec 000, itens 2b e 3b). Fecha a lacuna
  // que a descoberta abriu: o market de esports nasce com volume 0, não entra na
  // varredura por volume nem tem aposta aberta — descoberto no minuto em que
  // nasce e, sem isto, sem nenhuma leitura de preço depois.
  //
  // O tick é de 5s, mas não é a cadência de coleta: quem decide o que é
  // refrescado é a faixa de cada mercado (ao vivo / falta pouco / longe), lida
  // de `system_config`. O tick só precisa ser mais rápido que a faixa mais
  // rápida — com 10-15s ao vivo, 5s dá a folga que evita aliasing.
  cron.schedule('*/5 * * * * *', () => {
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

  // Resolver de esports (spec 001, item 3): liga cada market a uma partida, com
  // times, liga e edição como entidades. Roda depois da descoberta na ordem
  // natural das coisas — resolve o que ela trouxe — mas sem acoplamento: o
  // varredor pega o que ainda não tem link, independente de quem o inseriu.
  //
  // 10 min é folga sobre a descoberta (3 min). O ciclo não tem prazo curto: um
  // market que espera 10 minutos por identidade não perde nada, porque a série
  // de preço quem grava é a watchlist, e ela não depende disto.
  cron.schedule('*/10 * * * *', () => {
    void runEsportsResolver().catch(err => console.error('[cron esports_resolver]', err));
  });

  // Sem execução no start, ao contrário dos coletores acima — e é decisão, não
  // esquecimento. O primeiro ciclo depois de um deploy é o mais caro que existe
  // (o cursor vive em memória, então ele reatravessa o histórico já linkado para
  // reencontrar o fim da fila), e o boot já dispara sete outras cargas iniciais
  // contra o mesmo Postgres — que tem taxa de erro em aberto (spec 001, H2).
  //
  // O que se ganharia é adiantar em até 10 minutos uma resolução que ninguém
  // espera: a série de preço quem grava é a watchlist, e ela não depende disto.

  // Recompute semanal — o estado B da spec 001. O caminho 2 casa `outcome_a_index`
  // comparando o código do slug (`navi`) com o nome do outcome ('Natus Vincere'),
  // e falha até o registro de times conhecer o nome. Quem preenche isso é o
  // caminho 1, quando o MESMO código reaparece num evento recente — então o
  // histórico melhora sozinho conforme o presente é coletado, e esta passada é o
  // que colhe a melhora.
  //
  // Domingo 04:00: depois da retenção (03:00) e longe do horário de jogo. Semanal
  // porque o registro de times cresce na escala de temporada, não de horas.
  cron.schedule('0 4 * * 0', () => {
    void runEsportsResolverRecompute().catch(err =>
      console.error('[cron esports_resolver_recompute]', err),
    );
  });

  // Partições de `esports_snapshots` (spec 000, item 3): cria as dos próximos
  // dias e dropa as vencidas. Roda antes da retenção porque são coisas opostas —
  // a retenção deleta linha de `polymarket_snapshots` (e é o DELETE em ciclo que
  // inflou um índice para 1492 MB); aqui a limpeza é DROP PARTITION.
  //
  // Diário basta: a folga de criação é de 2 dias à frente. A execução no start
  // garante que um deploy no horário do cron não deixe o dia sem partição.
  cron.schedule('30 2 * * *', () => {
    void runEsportsPartitionJob().catch(err => console.error('[cron esports_partitions]', err));
  });

  void runEsportsPartitionJob().catch(err =>
    console.error('[esports_partitions] Initial run failed:', err),
  );

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
