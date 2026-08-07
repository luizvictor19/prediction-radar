import 'dotenv/config';
import {
  propagateMatchOutcomes,
  type OutcomeStats,
} from '../src/verticals/match-outcome.js';

/**
 * Backfill do desfecho das partidas: `events` → `esports_matches`.
 *
 * O auto-resolver marca `events.status = 'resolved'` e `resolved_outcome` desde
 * antes de a camada de entidades existir, e nunca propagou nada para
 * `esports_matches`. Medido em 2026-08-07: 106 de 106 partidas passadas com
 * `winner_team_id` e `resolved_at` nulos — e, por consequência, 33 análises
 * acumuladas e ZERO pontuáveis no eval.
 *
 * Este script é a MESMA passada que o job de 10 min faz, com a janela aberta: o
 * job olha 30 dias para trás, este olha o histórico inteiro e inclui partida sem
 * `scheduled_at`. Nenhuma regra é diferente aqui — se um caso fosse decidido de
 * um jeito no backfill e de outro em produção, o dataset ficaria com duas
 * semânticas e ninguém saberia qual linha veio de qual.
 *
 * ## Ordem recomendada
 *
 *   1. `--dry-run` primeiro. Não escreve nada e imprime a conta completa: quantas
 *      partidas ganham vencedor, quantas são void, quantas travam em estado B
 *      (sem `outcome_a_index`) e quantas são ambíguas.
 *   2. Se o estado B for grande, rode antes o recompute do resolver
 *      (`npm run backfill:esports-matches -- --recompute`): é ele que preenche
 *      `outcome_a_index` a partir dos `display_name` que o caminho 1 aprendeu.
 *   3. A rodada real, sem flag.
 *
 * Idempotente: a segunda rodada encontra as mesmas partidas já concluídas, o
 * filtro não as traz de volta, e nada é reescrito. As guardas do UPDATE
 * garantem isso mesmo que duas rodadas se cruzem.
 *
 * Uso:
 *   npm run backfill:match-outcomes -- --dry-run
 *   npm run backfill:match-outcomes -- --limit=200
 *   npm run backfill:match-outcomes
 *   npm run backfill:match-outcomes -- --since=2026-05-01
 */

const LABEL = 'backfill-outcomes';

/** Teto padrão: folgado sobre o universo de partidas de hoje (~2,5k). */
const DEFAULT_LIMIT = 100_000;

function flag(name: string): string | null {
  const hit = process.argv.slice(2).find(arg => arg === `--${name}` || arg.startsWith(`--${name}=`));
  if (hit === undefined) return null;
  const [, value] = hit.split('=');
  return value ?? '';
}

function pct(part: number, whole: number): string {
  return whole === 0 ? '—' : `${((part / whole) * 100).toFixed(1)}%`;
}

function report(stats: OutcomeStats, dryRun: boolean, since: string | null): string {
  const concluded = stats.winners + stats.voids;

  return `
[${LABEL}] ================= RESUMO =================
  janela ................. ${since === null ? 'histórico inteiro' : `scheduled_at >= ${since}`}
  partidas examinadas .... ${stats.examined}   <- só as que estavam sem desfecho

  COM DESFECHO ........... ${concluded} (${pct(concluded, stats.examined)})
    vencedor ............. ${stats.winners}
    void ................. ${stats.voids}   <- resolved_at carimbado, winner_team_id fica nulo

  sem concluir
    moneyline ainda aberto ${stats.pending}
    sem outcome_a_index .. ${stats.noIndex}   <- estado B: rode o --recompute do resolver
    sem moneyline linkado  ${stats.noMoneyline}
    lado sem linha de time ${stats.noTeamRow}   <- não deveria acontecer; ver o resolver
    ambíguas ............. ${stats.ambiguous}   <- estado A: contradição entre fontes

  escrita${dryRun ? ' (DRY-RUN: nada foi escrito)' : ''}
    linhas atualizadas ... ${stats.written}
    marcadas p/ revisão .. ${stats.flagged}
    escritas que falharam  ${stats.writeFailed}

  teto atingido .......... ${stats.capHit ? 'SIM — rode de novo' : 'não'}
  erros .................. ${stats.errors.length}
==========================================`;
}

async function main(): Promise<void> {
  const dryRun = flag('dry-run') !== null;
  const limitArg = flag('limit');
  const sinceArg = flag('since');

  const limit = limitArg !== null && limitArg.length > 0 ? Number(limitArg) : DEFAULT_LIMIT;
  if (!Number.isFinite(limit) || limit <= 0) {
    console.error(`[${LABEL}] --limit inválido: ${String(limitArg)}`);
    process.exit(1);
  }

  // Data inválida vira `Invalid Date` e o filtro sai silenciosamente errado — a
  // janela ficaria aberta e o backfill tocaria outra coisa sem avisar.
  let since: string | null = null;
  if (sinceArg !== null && sinceArg.length > 0) {
    const parsed = new Date(sinceArg);
    if (Number.isNaN(parsed.getTime())) {
      console.error(`[${LABEL}] --since inválido: ${sinceArg}`);
      process.exit(1);
    }
    since = parsed.toISOString();
  }

  console.log(
    `[${LABEL}] iniciando${dryRun ? ' EM DRY-RUN (nada será escrito)' : ''}, ` +
      `teto de ${limit} partidas`,
  );

  const stats = await propagateMatchOutcomes({
    since,
    limit,
    dryRun,
    // Amostras sempre: aqui não é ciclo, é uma rodada que alguém está lendo — e
    // o que interessa nela é justamente o que NÃO concluiu.
    collectSamples: true,
  });

  if (stats.tablesMissing) {
    console.error(
      `[${LABEL}] as tabelas de entidade não existem — a migration ` +
        `20260806183705_esports_entities ainda não foi aplicada (spec 001, H4).`,
    );
    process.exit(1);
  }

  console.log(report(stats, dryRun, since));

  if (stats.samples.length > 0) {
    console.log(`
[${LABEL}] ===== AMOSTRA DO QUE NÃO CONCLUIU =====`);
    for (const s of stats.samples) {
      console.log(`  [${s.kind}] ${s.matchSlug}${s.detail === '' ? '' : ` — ${s.detail}`}`);
    }
  }

  for (const err of stats.errors.slice(0, 10)) console.error(`[${LABEL}] erro: ${err}`);

  if (stats.errors.length > 0 || stats.writeFailed > 0) process.exit(1);
}

main().catch(err => {
  console.error(`[${LABEL}] Fatal:`, err);
  process.exit(1);
});
