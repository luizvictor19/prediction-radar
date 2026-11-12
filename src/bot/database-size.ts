/**
 * Database size alert, the decision and the message (issue 60).
 *
 * The Free plan quota is 500 MB of database per project, summed across the
 * organization. The radar series grows ~10 MB/day, and one closed month is
 * archived on day 9 of the next (`npm run arquivar:particao`). A skipped
 * archive is the expected way to cross the quota, so the alert names the
 * command that undoes it.
 *
 * Pure: no I/O here, so the cooldown and the transitions are testable. The
 * state lives in `collector_health_alerts` under `DATABASE_SIZE_COMPONENT`,
 * with the same `ok`/`alerting` states and the same cooldown as the collector
 * alerts in `health-monitor.ts`.
 */

import { ARCHIVE_MIN_DAY } from '../lib/radar-archive.js';
import { formatDuration, type AlertStateRow } from './health-monitor.js';

export const DATABASE_SIZE_COMPONENT = 'database_size';

export type DatabaseSizeAction =
  | { kind: 'none' }
  | { kind: 'alert' }
  | { kind: 'remind' }
  | { kind: 'recovered'; overMs: number };

export function evaluateDatabaseSize(params: {
  thresholdBytes: number;
  cooldownMinutes: number;
  /** `null` when `database_disk_usage()` could not be read. */
  databaseBytes: number | null;
  alertState: AlertStateRow | undefined;
  now: number;
}): DatabaseSizeAction {
  const { thresholdBytes, cooldownMinutes, databaseBytes, alertState, now } = params;

  // 0 turns the check off, open alert included: nothing is sent and the
  // stored state is left as it is. Turning it back on resumes from that
  // state, so an alert open at the time may close with one late
  // "back to normal" message.
  if (!(thresholdBytes > 0)) return { kind: 'none' };

  // A failed read proves nothing either way; the next hour reads again.
  if (databaseBytes === null) return { kind: 'none' };

  const over = databaseBytes > thresholdBytes;
  const wasAlerting = alertState?.state === 'alerting';

  if (over && !wasAlerting) return { kind: 'alert' };

  if (over && wasAlerting) {
    const lastMs = alertState?.last_notified_at ? Date.parse(alertState.last_notified_at) : NaN;
    if (Number.isNaN(lastMs) || now - lastMs >= cooldownMinutes * 60_000) {
      return { kind: 'remind' };
    }
    return { kind: 'none' };
  }

  if (!over && wasAlerting) {
    const sinceMs = alertState?.since ? Date.parse(alertState.since) : NaN;
    return { kind: 'recovered', overMs: Number.isNaN(sinceMs) ? 0 : now - sinceMs };
  }

  return { kind: 'none' };
}

/**
 * The month the archive script accepts now: the previous one from day 9 on,
 * the one before it until then. `YYYY-MM`.
 */
export function monthToArchive(now: number): string {
  const d = new Date(now);
  const back = d.getUTCDate() >= ARCHIVE_MIN_DAY ? 1 : 2;
  const m = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - back, 1));
  return m.toISOString().slice(0, 7);
}

const mb = (bytes: number) => `${Math.round(bytes / 1_000_000)} MB`;

export function buildDatabaseSizeMessage(params: {
  action: DatabaseSizeAction;
  databaseBytes: number;
  thresholdBytes: number;
  now: number;
}): string {
  const { action, databaseBytes, thresholdBytes, now } = params;

  if (action.kind === 'recovered') {
    return [
      '✅ *Banco de volta abaixo do limite*',
      '',
      `Agora: *${mb(databaseBytes)}* (limite ${mb(thresholdBytes)}).`,
      `Ficou acima por *${formatDuration(action.overMs)}*.`,
    ].join('\n');
  }

  const title =
    action.kind === 'remind' ? '🔴 *Banco continua acima do limite*' : '🔴 *Banco acima do limite*';
  return [
    title,
    '',
    `Agora: *${mb(databaseBytes)}* (limite ${mb(thresholdBytes)}, \`system_config.database_alert_bytes\`).`,
    'A cota do plano Free é de 500 MB por projeto, somados na organização.',
    '',
    'Provável causa: um mês fechado da série do radar ainda no banco. Na pasta do projeto:',
    `\`npm run arquivar:particao -- ${monthToArchive(now)}\``,
    'e aplicar a migration que ele gera. Consulta 12 de `supabase/queries/health-checks.sql` mostra os meses ainda no banco.',
  ].join('\n');
}
