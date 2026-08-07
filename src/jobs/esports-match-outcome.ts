import { getSystemConfig } from '../lib/config.js';
import { logEvent, logDisabled } from '../lib/logger.js';
import { beat } from '../lib/heartbeat.js';
import { CycleLock } from '../lib/cycle-lock.js';
import { propagateMatchOutcomes, type OutcomeStats } from '../verticals/match-outcome.js';

/**
 * Agendamento da propagação de desfecho (`events` → `esports_matches`).
 *
 * O raciocínio sobre POR QUE isto é um passo próprio está em
 * `src/verticals/match-outcome.ts`. Aqui só moram cadência, janela e log.
 *
 * ## A cadência, e o offset de 5 minutos
 *
 * O cron roda nos minutos 5, 15, 25... — deslocado do resolver de esports, que
 * roda nos minutos cheios, de 10 em 10. Não é estética: a partida que acabou de
 * resolver precisa do LINK para ser traduzida, e o link é escrito pelo
 * resolver. Chegar cinco minutos depois dele significa ler o que ele acabou de
 * gravar, em vez de concluir "sem moneyline" e esperar o ciclo seguinte.
 *
 * ## Por que compartilha a flag do resolver
 *
 * `esports_resolver_enabled` desliga os dois. Uma flag própria custaria uma
 * migration de config para nascer `true` e nunca ser tocada — e o que ela
 * ligaria não é um componente independente: sem os links do resolver esta
 * passada não tem o que traduzir. Quem desliga um, desliga o par.
 *
 * ## A janela, e o que fica fora dela
 *
 * 30 dias para trás de `scheduled_at`. Partida que não concluiu nesse prazo não
 * concluiria em prazo nenhum sem dado NOVO: estado B espera o recompute
 * semanal, ambíguo espera humano, sem-moneyline espera o link aparecer. O que
 * cair fora da janela é trabalho do backfill
 * (`npm run backfill:match-outcomes`), que é a mesma passada sem piso.
 */

const COMPONENT = 'esports_outcome';

/** Cron de 10 min. Prazo folgado sobre o ciclo típico (dezenas de partidas). */
const CYCLE_TIMEOUT_MS = 4 * 60_000;

/**
 * Maior que o timeout, para o tick seguinte não tomar o lock de um ciclo que
 * está apenas demorando.
 */
const cycleLock = new CycleLock(15 * 60_000);

/** Janela de `scheduled_at` olhada por ciclo. Ver a nota no topo. */
const WINDOW_DAYS = 30;

/**
 * Teto de partidas examinadas por ciclo.
 *
 * Em regime a janela traz dezenas. O teto existe para que uma vertical nova
 * habilitada de uma vez (H7) não vire uma passada sem freio — e quando ele
 * corta, o log diz.
 */
const BATCH = 500;

export function cycleStatus(stats: OutcomeStats): 'success' | 'partial' {
  // `tablesMissing` é `partial` e não `error` pelo mesmo motivo do resolver: é o
  // estado esperado entre o deploy do código e o apply da migration (H4).
  return stats.errors.length > 0 || stats.writeFailed > 0 || stats.tablesMissing
    ? 'partial'
    : 'success';
}

export function summary(stats: OutcomeStats): string {
  return (
    `${stats.examined} sem desfecho examinadas, ` +
    `${stats.winners} com vencedor, ${stats.voids} void, ` +
    `${stats.pending} ainda abertas, ${stats.noIndex} sem outcome_a_index, ` +
    `${stats.noMoneyline} sem moneyline linkado, ${stats.ambiguous} ambíguas ` +
    `(${stats.flagged} novas na fila de revisão)`
  );
}

function metadataOf(stats: OutcomeStats, windowDays: number): Record<string, unknown> {
  return {
    examined: stats.examined,
    winners: stats.winners,
    voids: stats.voids,
    pending: stats.pending,
    // Estado B. Cresce sem parar ⇒ o recompute semanal não está colhendo os
    // `display_name` que deveria.
    no_index: stats.noIndex,
    no_moneyline: stats.noMoneyline,
    // Não deveria acontecer: o resolver cria as duas linhas de time antes da
    // partida. Qualquer valor aqui é bug de escrita do resolver.
    no_team_row: stats.noTeamRow,
    // Estado A: contradição entre o rótulo resolvido e os outcomes do market.
    ambiguous: stats.ambiguous,
    flagged_for_review: stats.flagged,
    written: stats.written,
    write_failed: stats.writeFailed,
    cap_hit: stats.capHit,
    window_days: windowDays,
    tables_missing: stats.tablesMissing,
    errors: stats.errors.slice(0, 5),
  };
}

async function runCycle(): Promise<void> {
  const config = await getSystemConfig();

  if (config.esports_resolver_enabled === false) {
    await logDisabled(
      COMPONENT,
      'Propagação de desfecho desligada: esports_resolver_enabled = false',
    );
    // Desligado pela config é ciclo completo — mesmo contrato dos coletores.
    await beat(COMPONENT, 'success', 'desligado pela config');
    return;
  }

  const since = new Date(Date.now() - WINDOW_DAYS * 24 * 60 * 60_000).toISOString();
  const stats = await propagateMatchOutcomes({ since, limit: BATCH });

  if (stats.tablesMissing) {
    await logEvent({
      component: COMPONENT,
      status: 'partial',
      message:
        'tabelas de entidade não existem — migration 20260806183705_esports_entities não aplicada (spec 001, H4)',
    });
    await beat(COMPONENT, 'partial', 'migration 20260806183705 não aplicada');
    return;
  }

  // Uma linha a cada 10 min dizendo "nada mudou" seriam 144/dia de nada, e este
  // projeto já teve `system_logs` em 2,7M linhas. O batimento carimba saúde; o
  // log entra quando há o que contar.
  const worthLogging =
    stats.winners > 0 ||
    stats.voids > 0 ||
    stats.ambiguous > 0 ||
    stats.errors.length > 0 ||
    stats.capHit;

  if (worthLogging) {
    await logEvent({
      component: COMPONENT,
      status: cycleStatus(stats),
      message: `Desfechos: ${summary(stats)}`,
      metadata: metadataOf(stats, WINDOW_DAYS),
    });
  }

  console.log(`[${COMPONENT}] ${summary(stats)}`);

  await beat(
    COMPONENT,
    cycleStatus(stats),
    stats.written > 0
      ? `${stats.written} partidas com desfecho gravado`
      : `nada novo, ${stats.examined} examinadas`,
  );
}

/** O ciclo de 10 min, com lock, takeover de ciclo travado e timeout. */
export async function runEsportsMatchOutcome(): Promise<void> {
  const lockToken = cycleLock.tryAcquire();

  if (!lockToken) {
    console.log(
      `[${COMPONENT}] ciclo anterior ainda rodando há ${Math.round((cycleLock.heldForMs() ?? 0) / 1000)}s — pulando`,
    );
    return;
  }

  if (lockToken.staleTakeoverMs !== null) {
    const stuckMinutes = Math.round(lockToken.staleTakeoverMs / 60000);
    console.warn(`[${COMPONENT}] ciclo anterior preso há ${stuckMinutes}min — assumindo`);
    await logEvent({
      component: COMPONENT,
      status: 'partial',
      message: `WARNING: ciclo anterior preso há ${stuckMinutes}min — assumido como morto`,
      metadata: { stuck_for_ms: lockToken.staleTakeoverMs },
    });
  }

  const cyclePromise = runCycle().finally(() => cycleLock.release(lockToken));

  const timeoutPromise = new Promise<void>((_, reject) =>
    setTimeout(() => reject(new Error(`cycle timeout ${CYCLE_TIMEOUT_MS}ms`)), CYCLE_TIMEOUT_MS),
  );

  try {
    await Promise.race([cyclePromise, timeoutPromise]);
  } catch (err) {
    await logEvent({
      component: COMPONENT,
      status: 'error',
      message: `ciclo falhou: ${err instanceof Error ? err.message : String(err)}`,
      metadata: { error: String(err) },
    });
  }
}
