import { supabase } from '../lib/supabase.js';
import { getSystemConfig } from '../lib/config.js';
import { logEvent } from '../lib/logger.js';
import { CycleLock } from '../lib/cycle-lock.js';

/**
 * Manutenção das partições de `esports_snapshots` (spec 000, item 3).
 *
 * Duas obrigações, uma por dia:
 *
 * 1. Criar a partição do dia seguinte. Sem ela o insert cai na partição default,
 *    que nada esvazia — a rede de segurança existe para não perder linha, não
 *    para virar destino.
 * 2. Dropar as partições fora da janela de retenção. `DROP TABLE` de partição é
 *    instantâneo e leva o índice junto. É a razão de a tabela ser particionada:
 *    o DELETE em ciclo da retenção de `polymarket_snapshots` inflou um índice
 *    para 1492 MB sobre 80 MB de dado, e B-tree não devolve página depois.
 *
 * O DDL mora todo em `manage_esports_partitions` no banco; aqui só se chama a
 * função e se lê o que ela reporta.
 */

const COMPONENT = 'esports_partitions';

/**
 * Hoje + 2 dias. A spec pede o dia seguinte; o terceiro é folga para que uma
 * execução perdida (deploy no horário do cron, banco fora do ar) não derrube
 * insert nenhum.
 */
const LOOKAHEAD_DAYS = 2;

/**
 * Teto de partições dropadas por execução.
 *
 * Retenção é config editável e DROP não tem desfazer. Com o teto, uma retenção
 * reduzida por engano apaga no máximo 16 dias por rodada e `drop_eligible` no
 * retorno mostra o tamanho do resto — tempo de perceber antes de o histórico ir
 * embora. (O banco ainda aplica um piso de 30 dias por cima disso.)
 */
const MAX_DROPS_PER_RUN = 16;

const CYCLE_TIMEOUT_MS = 120_000;

const cycleLock = new CycleLock();

/** O que `manage_esports_partitions` devolve. */
interface PartitionReport {
  today_utc: string;
  created: string[];
  dropped: string[];
  drop_eligible: number;
  retention_days: number;
  retention_clamped: boolean;
  default_rows_at_least: number;
  errors: string[];
}

export async function runEsportsPartitionJob(): Promise<void> {
  const lockToken = cycleLock.tryAcquire();

  if (!lockToken) {
    await logEvent({
      component: COMPONENT,
      status: 'partial',
      message: 'previous cycle still running, skipping this tick',
      metadata: { previous_cycle_running_for_ms: cycleLock.heldForMs() ?? 0 },
    });
    return;
  }

  if (lockToken.staleTakeoverMs !== null) {
    const stuckMinutes = Math.round(lockToken.staleTakeoverMs / 60000);
    console.warn(`[esports_partitions] Previous cycle stuck for ${stuckMinutes}min — assuming dead, starting a new one`);
    await logEvent({
      component: COMPONENT,
      status: 'partial',
      message: `WARNING: previous cycle stuck for ${stuckMinutes}min — assumed dead, starting a new one`,
      metadata: { stuck_for_ms: lockToken.staleTakeoverMs },
    });
  }

  // O lock é solto quando o trabalho real termina, não quando a race termina:
  // soltar no timeout deixaria o próximo tick rodar em cima do ciclo zumbi.
  const cyclePromise = _run().finally(() => cycleLock.release(lockToken));

  const timeoutPromise = new Promise<void>((_, reject) =>
    setTimeout(() => reject(new Error('cycle timeout 120s')), CYCLE_TIMEOUT_MS),
  );

  try {
    await Promise.race([cyclePromise, timeoutPromise]);
  } catch (err) {
    await logEvent({
      component: COMPONENT,
      status: 'error',
      message: `Partition cycle failed: ${err instanceof Error ? err.message : String(err)}`,
      metadata: { error: String(err) },
    });
  }
}

async function _run(): Promise<void> {
  const startedAt = Date.now();

  const config = await getSystemConfig();
  const retentionDays = config.esports_snapshot_retention_days;

  const { data, error } = await supabase.rpc('manage_esports_partitions', {
    lookahead_days: LOOKAHEAD_DAYS,
    retention_days: retentionDays,
    max_drops: MAX_DROPS_PER_RUN,
  });

  if (error) {
    // Antes de a migration ser aplicada a função não existe. Isso não é falha do
    // job: nesse intervalo a série ainda está indo para `polymarket_snapshots`
    // (ver src/lib/esports-snapshots.ts) e não há partição a manter.
    const notDeployed = error.code === 'PGRST202' || /manage_esports_partitions/.test(error.message);

    await logEvent({
      component: COMPONENT,
      status: notDeployed ? 'partial' : 'error',
      message: notDeployed
        ? 'manage_esports_partitions ainda não existe — migration 20260805142957 não aplicada'
        : `manage_esports_partitions falhou: ${error.message}`,
      metadata: { error: error.message, code: error.code ?? null },
    });
    return;
  }

  const report = data as PartitionReport;
  const durationMs = Date.now() - startedAt;

  // Cada um destes é um problema diferente, e nenhum é fatal no momento em que
  // aparece — por isso `partial` e não `error`. O que não pode acontecer é
  // passarem despercebidos: linha na default significa insert fora de partição
  // de dia, e `drop_eligible` acima do teto significa retenção encolhendo mais
  // rápido do que este job consegue (ou deveria) aplicar.
  const status =
    report.errors.length > 0 ||
    report.default_rows_at_least > 0 ||
    report.retention_clamped ||
    report.drop_eligible > report.dropped.length
      ? 'partial'
      : 'success';

  await logEvent({
    component: COMPONENT,
    status,
    message:
      `Partições: ${report.created.length} criadas, ${report.dropped.length} dropadas ` +
      `(retenção ${report.retention_days}d${report.retention_clamped ? ', valor da config abaixo do piso' : ''})` +
      `${report.drop_eligible > report.dropped.length ? `, ${report.drop_eligible - report.dropped.length} vencidas adiadas pelo teto de ${MAX_DROPS_PER_RUN}` : ''}` +
      `${report.default_rows_at_least > 0 ? `, ATENÇÃO: ${report.default_rows_at_least}+ linhas na partição default` : ''} ` +
      `em ${durationMs}ms`,
    metadata: {
      today_utc: report.today_utc,
      created: report.created,
      dropped: report.dropped,
      drop_eligible: report.drop_eligible,
      max_drops_per_run: MAX_DROPS_PER_RUN,
      lookahead_days: LOOKAHEAD_DAYS,
      retention_days_config: retentionDays,
      retention_days_effective: report.retention_days,
      // true = o valor em system_config está abaixo do piso do banco e foi ignorado.
      retention_clamped: report.retention_clamped,
      // > 0 = linha gravada fora de qualquer partição de dia. Nada a esvazia:
      // ou o job ficou parado dias, ou chegou `captured_at` com data absurda.
      default_rows_at_least: report.default_rows_at_least,
      partition_errors: report.errors.length > 0 ? report.errors : null,
      duration_ms: durationMs,
    },
  });

  console.log(
    `[esports_partitions] +${report.created.length} / -${report.dropped.length} ` +
      `(retenção ${report.retention_days}d, ${durationMs}ms)`,
  );
}
