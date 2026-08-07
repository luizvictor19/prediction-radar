import 'dotenv/config';
import { loadEvalDataset } from '../src/eval/dataset.js';
import { renderReport } from '../src/eval/report.js';

/**
 * Eval do agente analista: as análises prestam?
 *
 * Compara `probability` com o desfecho real da partida e mede contra dois
 * baselines na mesma amostra — o preço do mercado no `as_of` da análise (o duro:
 * sem bater ele não há edge) e 50/50 (o burro). Recorta por checkpoint, modelo,
 * versão de prompt e faixa de liquidez, porque uma média única esconde onde o
 * agente é bom e onde é ruim.
 *
 * SÓ LEITURA. Não grava análise, não chama modelo, não escreve em lugar nenhum.
 * Roda sob demanda — não tem cron, e não deve ter: o número só muda quando
 * partidas resolvem, e olhar todo dia um Brier que se move na terceira casa é
 * como se toma decisão a partir de ruído.
 *
 * Uso:
 *   npm run eval:analyst
 *   npm run eval:analyst -- --since=2026-08-01
 *   npm run eval:analyst -- --since=2026-08-01 --until=2026-09-01 --vertical=cs2
 *   npm run eval:analyst -- --json > eval.json
 *
 * A janela filtra por `as_of` — o instante da análise, não o da partida. É o
 * recorte certo para "como o agente andou em agosto": uma análise de agosto
 * conta em agosto mesmo que a partida só resolva em setembro (e até lá ela
 * aparece como "sem desfecho" na seção de cobertura, não some).
 */

const LABEL = 'eval-analyst';

interface Args {
  since: string | null;
  until: string | null;
  vertical: string | null;
  json: boolean;
}

function parseArgs(argv: readonly string[]): Args | { error: string } {
  const args: Args = { since: null, until: null, vertical: null, json: false };

  for (const arg of argv) {
    if (arg === '--json') {
      args.json = true;
      continue;
    }

    const match = /^--(since|until|vertical)=(.+)$/.exec(arg);
    if (match === null) return { error: `argumento desconhecido: ${arg}` };

    const [, key, value] = match;
    if (key === 'vertical') {
      args.vertical = value ?? null;
      continue;
    }

    // Data inválida vira `Invalid Date` e o filtro sai silenciosamente errado —
    // a janela ficaria aberta e o relatório mediria outra coisa sem avisar.
    const parsed = new Date(value ?? '');
    if (Number.isNaN(parsed.getTime())) {
      return { error: `--${key}=${value} não é uma data válida (use YYYY-MM-DD)` };
    }

    if (key === 'since') args.since = parsed.toISOString();
    else args.until = parsed.toISOString();
  }

  return args;
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));

  if ('error' in parsed) {
    console.error(`[${LABEL}] ${parsed.error}`);
    console.error(
      `[${LABEL}] uso: npm run eval:analyst -- [--since=YYYY-MM-DD] [--until=YYYY-MM-DD] [--vertical=cs2] [--json]`,
    );
    process.exit(1);
    return;
  }

  const data = await loadEvalDataset({
    since: parsed.since,
    until: parsed.until,
    vertical: parsed.vertical,
  });

  if (parsed.json) {
    // O dataset cru, para quem quiser plotar o reliability diagram de verdade em
    // vez de ler a tabela.
    console.log(JSON.stringify(data, null, 2));
    return;
  }

  console.log(renderReport(data));
}

main().catch((err: unknown) => {
  console.error(`[${LABEL}] falhou:`, err instanceof Error ? err.message : String(err));
  process.exit(1);
});
