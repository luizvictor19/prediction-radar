import type { Bot } from 'grammy';
import type { BotContext } from './index.js';
import { supabase } from '../lib/supabase.js';
import { getSystemConfig } from '../lib/config.js';
import { logEvent } from '../lib/logger.js';
import { probeDiskUsage } from '../lib/disk-usage.js';
import { sendLongMessage } from './message-utils.js';
import { resolveOpsChatId } from './health-monitor.js';
import {
  buildDatabaseSizeMessage,
  DATABASE_SIZE_COMPONENT,
  evaluateDatabaseSize,
} from './database-size.js';

/**
 * Hourly check of the database size against `system_config.database_alert_bytes`
 * (issue 60). Runs in the bot process for the reason health-monitor.ts gives:
 * it is the process that sends Telegram, and it survives the collectors' one.
 *
 * Once an hour is plenty for a ~10 MB/day slope. `database_disk_usage()` reads
 * the catalog only (pg_database_size, pg_ls_waldir), no user table.
 */
const CHECK_INTERVAL_MS = 60 * 60_000;

export function startDatabaseSizeMonitor(bot: Bot<BotContext>): void {
  void runDatabaseSizeCheck(bot);
  setInterval(() => {
    void runDatabaseSizeCheck(bot);
  }, CHECK_INTERVAL_MS);
}

export async function runDatabaseSizeCheck(bot: Bot<BotContext>): Promise<void> {
  try {
    const config = await getSystemConfig();
    if (!config.health_alerts_enabled) return;

    const chatId = resolveOpsChatId(config);
    if (!chatId) return;

    const disk = await probeDiskUsage((fn) => supabase.rpc(fn));

    const { data: alertState, error } = await supabase
      .from('collector_health_alerts')
      .select('component, state, since, last_notified_at')
      .eq('component', DATABASE_SIZE_COMPONENT)
      .maybeSingle();

    if (error) {
      // 42P01: the alerts table is not there yet; the collector monitor
      // already reports that, so stay quiet and try next hour.
      if (error.code !== '42P01') {
        await logEvent({
          component: 'health_monitor',
          status: 'error',
          message: `tamanho do banco: leitura do estado falhou: ${error.message}`,
        });
      }
      return;
    }

    const now = Date.now();
    const thresholdBytes = Number(config.database_alert_bytes ?? 0);
    const action = evaluateDatabaseSize({
      thresholdBytes,
      cooldownMinutes: config.health_alert_cooldown_minutes,
      databaseBytes: disk.database_bytes,
      alertState: alertState ?? undefined,
      now,
    });

    if (action.kind === 'none' || disk.database_bytes === null) return;

    await sendLongMessage(
      bot,
      chatId,
      buildDatabaseSizeMessage({
        action,
        databaseBytes: disk.database_bytes,
        thresholdBytes,
        now,
      }),
      { parseMode: 'Markdown' },
    );

    const nowIso = new Date(now).toISOString();
    const row =
      action.kind === 'alert'
        ? {
            component: DATABASE_SIZE_COMPONENT,
            state: 'alerting',
            since: nowIso,
            last_notified_at: nowIso,
          }
        : action.kind === 'remind'
          ? { component: DATABASE_SIZE_COMPONENT, state: 'alerting', last_notified_at: nowIso }
          : {
              component: DATABASE_SIZE_COMPONENT,
              state: 'ok',
              since: null,
              last_notified_at: null,
            };

    const { error: upsertError } = await supabase
      .from('collector_health_alerts')
      .upsert(row, { onConflict: 'component' });
    if (upsertError) {
      // The next hour repeats the alert. Worse than one message, better than
      // swallowing it.
      console.error('[database-size] falha ao gravar estado:', upsertError.message);
    }

    await logEvent({
      component: 'health_monitor',
      status: action.kind === 'recovered' ? 'success' : 'error',
      message: `tamanho do banco: ${action.kind}, ${disk.database_bytes} bytes (limite ${thresholdBytes})`,
      metadata: { database_bytes: disk.database_bytes, threshold_bytes: thresholdBytes },
    });
  } catch (err) {
    // A monitor that takes the bot down would take the signal notifications
    // with it, which are the bot's main job.
    console.error('[database-size] runDatabaseSizeCheck falhou:', err);
  }
}
