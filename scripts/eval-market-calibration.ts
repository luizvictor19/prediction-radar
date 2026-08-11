import 'dotenv/config';
import {
  CHECKPOINTS,
  SERIES_START,
  TOLERANCE_SECONDS,
  loadMarketDataset,
  loadMarketUniverse,
  probeAnchorlessSeries,
  probeLegacyCoverage,
} from '../src/eval/market-dataset.js';
import { renderMarketReport } from '../src/eval/market-report.js';

/**
 * Calibração do mercado de CS2: o PREÇO erra sistematicamente em alguma faixa?
 *
 * Roda sobre um dataset market-cêntrico, separado do dataset de análises: uma
 * linha por (partida, checkpoint), nenhum agente envolvido. A diferença é de
 * denominador, e é a razão de este script existir — o eval do analista cresce a
 * duas análises por dez horas, o calendário de CS2 resolve ~39 partidas por dia,
 * e a calibração do preço não precisa do analista para nada.
 *
 * SÓ LEITURA. Nenhum INSERT, UPDATE, DELETE ou DDL, nenhuma chamada de API paga.
 * É sonda, não job: não tem cron, não grava resultado, e o que produz é texto
 * para alguém ler e decidir.
 *
 * ## Custo no banco (leia antes de rodar)
 *
 * Uma consulta por (partida, checkpoint), sempre com `event_id` E os dois lados
 * de `captured_at`, numa janela de ±${TOLERANCE_SECONDS}s. Nunca há varredura de
 * `esports_snapshots` sem `event_id`: a estimativa do planner erra por centenas
 * de vezes nessa tabela e, sem o `event_id` fixado, o plano escolhido varre
 * partição inteira.
 *
 * `--dry-run` dimensiona sem ler uma única série.
 *
 * ## Uso
 *
 *   npm run eval:market -- --dry-run     # só dimensiona
 *   npm run eval:market
 *   npm run eval:market -- --legacy-limit=0     # pula a sonda histórica
 *   npm run eval:market -- --legacy-limit=200   # sonda uma amostra
 *   npm run eval:market -- --json > market.json
 *
 * O progresso vai para stderr e o relatório para stdout.
 */

const LABEL = 'eval-market-calibration';

interface Args {
  dryRun: boolean;
  json: boolean;
  /** `null` = sondar todas as partidas anteriores a SERIES_START. `0` = pular. */
  legacyLimit: number | null;
}

function parseArgs(argv: readonly string[]): Args | { error: string } {
  const args: Args = { dryRun: false, json: false, legacyLimit: null };

  for (const arg of argv) {
    if (arg === '--dry-run') {
      args.dryRun = true;
      continue;
    }
    if (arg === '--json') {
      args.json = true;
      continue;
    }

    const match = /^--legacy-limit=(.+)$/.exec(arg);
    if (match === null) return { error: `argumento desconhecido: ${arg}` };

    const value = Number(match[1]);
    if (!Number.isInteger(value) || value < 0) {
      return { error: `--legacy-limit=${match[1] ?? ''} precisa ser um inteiro >= 0` };
    }
    args.legacyLimit = value;
  }

  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if ('error' in args) {
    console.error(`[${LABEL}] ${args.error}`);
    console.error(`[${LABEL}] uso: npm run eval:market -- [--dry-run] [--json] [--legacy-limit=N]`);
    process.exit(1);
    return;
  }

  console.error(`[${LABEL}] lendo universo (esports_matches + market_match_links + events)…`);
  const universe = await loadMarketUniverse();

  if (args.dryRun) {
    const events = new Set(universe.matches.map((m) => m.eventId)).size;
    const cap = (n: number): number =>
      args.legacyLimit === null ? n : Math.min(args.legacyLimit, n);
    const legacyProbes = cap(universe.legacy.length);
    const anchorlessProbes = cap(universe.anchorless.length);

    console.log(
      [
        'DRY RUN — dimensionamento, nenhuma série lida',
        '=============================================',
        '',
        `  partidas cs2 resolvidas lidas:            ${universe.resolvedRead}`,
        `  partidas no universo (>= ${SERIES_START}):      ${universe.matches.length}`,
        `  eventos distintos:                        ${events}`,
        `  partidas anteriores a ${SERIES_START}:          ${universe.legacy.length}`,
        '',
        '  descartes de partida:',
        ...(Object.entries(universe.discards) as Array<[string, number]>)
          .filter(([, n]) => n > 0)
          .sort((a, b) => b[1] - a[1])
          .map(([reason, n]) => `    ${reason.padEnd(24)} ${n}`),
        '',
        `  A passada completa faria ${universe.matches.length * CHECKPOINTS.length} consulta(s) a esports_snapshots`,
        `  (${universe.matches.length} partidas × ${CHECKPOINTS.length} checkpoints), cada uma com event_id e uma janela`,
        `  de ±${TOLERANCE_SECONDS}s em captured_at.`,
        '',
        `  A sonda histórica faria ${legacyProbes * 2} consulta(s) de janela larga (2 por partida, uma`,
        '  por tabela, com limit(1)) mais 1 a 4 por partida que tiver série — o esperado',
        '  é zero dessas, e é justamente isso que ela existe para verificar.',
        '',
        `  A sonda sem-âncora faria ${anchorlessProbes * 2} consulta(s) — as ${universe.anchorless.length} partidas resolvidas`,
        '  que não têm horário em lugar nenhum, uma sondagem de índice por evento e por',
        '  tabela (event_id + order by captured_at desc limit 1).',
        '',
        '  Nenhuma série foi lida. Rode sem --dry-run para medir.',
      ].join('\n'),
    );
    return;
  }

  if (universe.matches.length === 0) {
    console.log('Nenhuma partida no universo — não há o que medir.');
    return;
  }

  console.error(
    `[${LABEL}] lendo série de ${universe.matches.length} partida(s) × ${CHECKPOINTS.length} checkpoint(s)…`,
  );
  const data = await loadMarketDataset(universe);

  const legacy =
    args.legacyLimit === 0 || universe.legacy.length === 0
      ? null
      : await probeLegacyCoverage(universe.legacy, { limit: args.legacyLimit });

  const anchorless =
    args.legacyLimit === 0 || universe.anchorless.length === 0
      ? null
      : await probeAnchorlessSeries(universe.anchorless, { limit: args.legacyLimit });

  if (args.json) {
    console.log(
      JSON.stringify(
        {
          points: data.points,
          coverage: Object.fromEntries(data.coverage),
          universe: {
            resolvedRead: data.universe.resolvedRead,
            matches: data.universe.matches.length,
            legacy: data.universe.legacy.length,
            discards: data.universe.discards,
            duplicateMoneyline: data.universe.duplicateMoneyline,
          },
          snapshotsRead: data.snapshotsRead,
          queries: data.queries,
          legacyCoverage: legacy,
          anchorlessCoverage: anchorless,
        },
        null,
        2,
      ),
    );
    return;
  }

  console.log(renderMarketReport(data, legacy, anchorless));
}

main().catch((err: unknown) => {
  console.error(`[${LABEL}] falhou:`, err instanceof Error ? err.message : String(err));
  process.exit(1);
});
