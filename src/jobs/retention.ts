import { supabase } from '../lib/supabase.js';
import { getSystemConfig } from '../lib/config.js';
import { logEvent } from '../lib/logger.js';

/**
 * Retenção de `polymarket_snapshots` e `system_logs`.
 *
 * A série de esports NÃO é apagada aqui — a exclusão vive dentro de
 * `run_snapshot_retention_batch` (migration 20260806032316, spec 000 item 8), e
 * não neste arquivo, de propósito: a função protege o que qualquer produtor
 * escrever, inclusive o `open-legs-collector`, que grava esports em
 * `polymarket_snapshots` sem passar por `writeEsportsSnapshots`.
 *
 * Quem limpa `esports_snapshots` é o `esports_partitions`, por DROP PARTITION.
 * Os dois jobs não se cruzam: tabelas distintas, funções distintas.
 */

/**
 * Teto da sondagem de série de esports presa na tabela antiga. Interessa a ordem
 * de grandeza, não o número exato — um count(*) completo custaria mais que o
 * próprio job.
 */
const LEGACY_PROBE_LIMIT = 500;

/**
 * Quantos events de esports ainda têm snapshot em `polymarket_snapshots`.
 *
 * > 0 significa série no lugar errado: protegida da retenção, mas fora da tabela
 * particionada. Enquanto o fallback de `writeEsportsSnapshots` estiver ativo (ou
 * o `open-legs` gravando lá), este número não zera.
 *
 * `null` = a função ainda não existe, ou a leitura falhou. Não é erro do job.
 */
async function probeLegacyEsports(): Promise<number | null> {
  const { data, error } = await supabase.rpc('esports_legacy_snapshot_events', {
    sample_limit: LEGACY_PROBE_LIMIT,
  });

  return error ? null : ((data as number) ?? null);
}

export async function runRetentionJob(): Promise<void> {
  const startedAt = Date.now();
  const config = await getSystemConfig();
  const retentionHours = config.snapshot_retention_days * 24;

  const BATCH_SIZE = 5000;
  const MAX_BATCHES = 200; // safety cap: 1M rows máximo por job

  /**
   * Um ramo da retenção, em lotes até secar.
   *
   * Devolve o erro em vez de abortar o job. O `return` que estava aqui fazia um
   * ramo quebrado levar junto o resto da execução — inclusive a limpeza de
   * `system_logs`, que é o que mantém aquela tabela longe dos 2,7M de linhas da
   * spec 000. Enquanto o ramo `old` esteve falhando por timeout, nenhum log foi
   * podado: a falha barata alimentava a cara.
   *
   * Os dois ramos são independentes por construção — filtros distintos sobre a
   * mesma tabela, sem ordem entre eles — então um cair não invalida o outro.
   */
  async function runBranch(
    deleteType: 'old' | 'finalized',
  ): Promise<{ deleted: number; error: string | null }> {
    let total = 0;

    for (let i = 0; i < MAX_BATCHES; i++) {
      const { data, error } = await supabase.rpc('run_snapshot_retention_batch', {
        delete_type: deleteType,
        retention_hours: retentionHours,
        batch_size: BATCH_SIZE,
      });

      if (error) {
        return { deleted: total, error: `Batch '${deleteType}' failed at iteration ${i}: ${error.message}` };
      }

      const deleted = (data as number) ?? 0;
      total += deleted;
      if (deleted < BATCH_SIZE) break;
    }

    return { deleted: total, error: null };
  }

  const oldBranch = await runBranch('old');
  const finalizedBranch = await runBranch('finalized');

  const branchErrors = [oldBranch.error, finalizedBranch.error].filter(
    (e): e is string => e !== null,
  );

  const result = {
    old_deleted: oldBranch.deleted,
    finalized_deleted: finalizedBranch.deleted,
  };

  // Logs: client delete is fine (no UUID list, just timestamp filter)
  const logCutoff = new Date(
    Date.now() - config.system_logs_retention_days * 24 * 60 * 60 * 1000,
  ).toISOString();

  const { count: logCount, error: logError } = await supabase
    .from('system_logs')
    .delete({ count: 'exact' })
    .lt('created_at', logCutoff)
    .neq('component', 'retention_job');

  // Mesmo motivo do `runBranch`: falha aqui é registrada, não aborta o relatório
  // final. O que se perde ao voltar cedo é a única linha que diz quanto as
  // outras etapas apagaram e quantos events de esports seguem na tabela errada.
  const errors = logError
    ? [...branchErrors, `Failed to delete logs: ${logError.message}`]
    : branchErrors;

  const legacyEsportsEvents = await probeLegacyEsports();

  const durationMs = Date.now() - startedAt;
  await logEvent({
    component: 'retention_job',
    status: errors.length > 0 ? 'error' : 'success',
    message:
      `Deleted ${result.old_deleted ?? 0} old (>${retentionHours}h) + ${result.finalized_deleted ?? 0} from finalized events + ${logCount ?? 0} logs in ${durationMs}ms` +
      (errors.length > 0 ? ` — ${errors.join('; ')}` : ''),
    metadata: {
      errors: errors.length > 0 ? errors : undefined,
      old_deleted: result.old_deleted ?? 0,
      finalized_deleted: result.finalized_deleted ?? 0,
      logs_deleted: logCount ?? 0,
      // Events de esports com série ainda em `polymarket_snapshots` — protegida da
      // retenção pelo item 8, mas fora da tabela particionada. `null` = função
      // ainda não aplicada; `500` = bateu no teto da sondagem, não é o total.
      legacy_esports_events: legacyEsportsEvents,
      duration_ms: durationMs,
    },
  });
}
