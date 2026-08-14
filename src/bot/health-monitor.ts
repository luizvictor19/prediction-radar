import type { Bot } from 'grammy';
import type { BotContext } from './index.js';
import { supabase } from '../lib/supabase.js';
import { getSystemConfig } from '../lib/config.js';
import { logEvent } from '../lib/logger.js';
import { sendLongMessage } from './message-utils.js';
import type { SystemConfig } from '../types/index.js';

/**
 * Alerta de coletor parado.
 *
 * Motivação concreta: o collector geral ficou 48h travado sem ninguém notar.
 * Falha silenciosa não produz erro, e sem erro não há o que alertar — o sintoma
 * é a ausência de trabalho. `collector_heartbeats` transforma essa ausência em
 * sinal; este módulo a transforma em mensagem.
 *
 * ## Por que isto roda no processo do BOT
 *
 * É a decisão de desenho que faz o alerta valer alguma coisa. O modo de falha a
 * detectar é o processo dos coletores travar ou morrer. Um monitor dentro desse
 * mesmo processo trava junto e nunca dispara — seria um detector de incêndio
 * alimentado pela fiação que ele vigia. O bot é processo separado
 * (`npm run bot`), então sobrevive à morte do outro.
 *
 * **Isto pressupõe que bot e coletores rodam como serviços separados no
 * Railway.** Se um dia forem unificados num processo só, este módulo para de
 * cumprir a função — e o substituto tem que ser externo (cron de terceiro
 * batendo num endpoint, ou dead man's switch).
 *
 * ## O que continua sem cobertura
 *
 * Se o processo do BOT morrer, ninguém avisa — nem sobre o bot nem sobre os
 * coletores. Fechar isso exige um vigia fora da infraestrutura do projeto, e
 * está fora do escopo aqui. Fica dito para não virar falsa sensação de cobertura
 * total.
 */

const CHECK_INTERVAL_MS = 60_000;

/**
 * Para onde vai o alerta operacional.
 *
 * Destino próprio, e não `telegram_chat_id`, porque os dois têm donos diferentes
 * mesmo quando o número é o mesmo hoje: `telegram_chat_id` é "para quem vão os
 * sinais" e vira **por usuário** quando a A6 da spec 001 criar `users`. Alerta de
 * coletor parado não é notícia de usuário — é do operador, e continua sendo de um
 * só depois do multi-tenant.
 *
 * Manter os dois separados agora custa uma coluna. Separá-los depois custaria
 * caçar todo call site num sistema já multi-usuário, sob o risco de o alerta
 * operacional vazar para a caixa de quem não pode agir sobre ele.
 *
 * O fallback existe para que a coluna nova não exija configuração no dia do
 * apply: sem `ops_telegram_chat_id`, o alerta segue indo para onde já ia.
 */
export function resolveOpsChatId(
  config: Pick<SystemConfig, 'ops_telegram_chat_id' | 'telegram_chat_id'>,
): string | null {
  const ops = config.ops_telegram_chat_id?.trim();
  if (ops) return ops;
  return config.telegram_chat_id?.trim() || null;
}

/** Backoff quando as tabelas ainda não existem (migration aplicada à mão). */
const TABLE_RETRY_MS = 10 * 60_000;

/** Componentes vigiados, com a chave de limiar de cada um em `system_config`. */
export const MONITORED_COMPONENTS = [
  { component: 'discovery_collector', label: 'Descoberta',    thresholdKey: 'health_stale_discovery_minutes' },
  { component: 'watchlist_collector', label: 'Watchlist',     thresholdKey: 'health_stale_watchlist_minutes' },
  { component: 'resolved_detector',   label: 'Auto-resolver', thresholdKey: 'health_stale_resolved_detector_minutes' },
  { component: 'open_legs_collector', label: 'Open legs',     thresholdKey: 'health_stale_open_legs_minutes' },
  // O radar entra vigiado mesmo nascendo desligado, e não é contradição: o
  // caminho do desligamento BATE (`beat(..., 'desligado por config')`), então
  // componente parado por config tem batimento fresco e não alerta. O que o
  // limiar pega é o ciclo que morreu — que é o mesmo risco de sempre, e maior
  // aqui porque a foto de 15 min pode faltar por horas sem ninguém notar.
  { component: 'radar_collector',     label: 'Radar',         thresholdKey: 'health_stale_radar_minutes' },
] as const satisfies ReadonlyArray<{
  component: string;
  label: string;
  thresholdKey: keyof SystemConfig;
}>;

export interface HeartbeatRow {
  component: string;
  last_cycle_at: string;
  last_status: string | null;
  last_detail: string | null;
}

export interface AlertStateRow {
  component: string;
  state: string;
  since: string | null;
  last_notified_at: string | null;
}

export type HealthAction =
  /** Nada a fazer: saudável, ou em silêncio de cooldown, ou não monitorado. */
  | { kind: 'none' }
  /** Ficou obsoleto agora. Primeira mensagem. */
  | { kind: 'alert'; staleMs: number; thresholdMs: number }
  /** Continua obsoleto e o cooldown venceu. Mensagem de lembrete. */
  | { kind: 'remind'; staleMs: number; thresholdMs: number }
  /** Voltou a bater depois de ter alertado. */
  | { kind: 'recovered'; downMs: number }
  /** Nunca bateu uma vez. NÃO alerta — ver o comentário em `evaluateComponent`. */
  | { kind: 'never_beat' };

/**
 * A decisão para um componente. Pura, sem I/O, para ser testável — é aqui que
 * mora o cooldown, que é o que separa "alerta útil" de "alerta que se aprende a
 * silenciar".
 */
export function evaluateComponent(params: {
  thresholdMinutes: number;
  cooldownMinutes: number;
  heartbeat: HeartbeatRow | undefined;
  alertState: AlertStateRow | undefined;
  now: number;
}): HealthAction {
  const { thresholdMinutes, cooldownMinutes, heartbeat, alertState, now } = params;

  // 0 (ou negativo) desliga a vigilância deste componente. É o que permite
  // desligar um coletor pela config sem passar a receber alerta dele para
  // sempre — `logDisabled` bate a cada 6h, o que não sustenta limiar de minutos.
  if (!(thresholdMinutes > 0)) return { kind: 'none' };

  // Componente que nunca bateu não gera alerta, de propósito. Entre aplicar a
  // migration e subir o código que bate, TODOS estariam nesse estado — quatro
  // alertas falsos de estreia ensinariam a ignorar o canal no primeiro dia.
  //
  // O preço: um coletor que nunca rodou uma vez sequer é invisível para o
  // monitor. Aceitável porque esse caso aparece no boot do processo (`index.ts`
  // dispara todos na subida), enquanto o caso que motivou isto é o coletor que
  // rodava e parou.
  if (!heartbeat) return { kind: 'never_beat' };

  const thresholdMs = thresholdMinutes * 60_000;
  const lastCycleMs = Date.parse(heartbeat.last_cycle_at);

  // Timestamp ilegível é problema de dado, não prova de que o coletor caiu.
  if (Number.isNaN(lastCycleMs)) return { kind: 'none' };

  const staleMs = now - lastCycleMs;
  const isStale = staleMs > thresholdMs;
  const wasAlerting = alertState?.state === 'alerting';

  if (isStale && !wasAlerting) return { kind: 'alert', staleMs, thresholdMs };

  if (isStale && wasAlerting) {
    const lastNotifiedMs = alertState?.last_notified_at
      ? Date.parse(alertState.last_notified_at)
      : NaN;
    // Sem registro de último aviso, avisa — o risco de um aviso a mais é menor
    // que o de um incidente em curso sem nenhum.
    if (Number.isNaN(lastNotifiedMs)) return { kind: 'remind', staleMs, thresholdMs };
    if (now - lastNotifiedMs >= cooldownMinutes * 60_000) {
      return { kind: 'remind', staleMs, thresholdMs };
    }
    return { kind: 'none' };
  }

  if (!isStale && wasAlerting) {
    const sinceMs = alertState?.since ? Date.parse(alertState.since) : NaN;
    // Sem `since`, o tempo parado é desconhecido — reportar 0 seria mentir.
    return { kind: 'recovered', downMs: Number.isNaN(sinceMs) ? 0 : now - sinceMs };
  }

  return { kind: 'none' };
}

/** '2h 14min', '52min', '45s'. */
export function formatDuration(ms: number): string {
  if (ms <= 0) return 'desconhecido';
  const totalMinutes = Math.floor(ms / 60_000);
  if (totalMinutes < 1) return `${Math.round(ms / 1000)}s`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return `${minutes}min`;
  if (hours < 24) return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}min`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}

interface Outcome {
  label: string;
  component: string;
  action: HealthAction;
  heartbeat: HeartbeatRow | undefined;
}

/** A mensagem de "está parado", já agregando todos os componentes afetados. */
export function buildDownMessage(outcomes: readonly Outcome[]): string {
  const lines = ['🔴 *Coletor sem completar ciclo*', ''];

  for (const o of outcomes) {
    const a = o.action;
    if (a.kind !== 'alert' && a.kind !== 'remind') continue;

    lines.push(
      `*${o.label}* (\`${o.component}\`) — parado há *${formatDuration(a.staleMs)}*` +
        ` (limiar ${formatDuration(a.thresholdMs)})`,
    );
    if (o.heartbeat?.last_status) {
      const detail = o.heartbeat.last_detail ? ` — ${o.heartbeat.last_detail}` : '';
      lines.push(`  último ciclo: \`${o.heartbeat.last_status}\`${detail}`);
    }
  }

  // Quando os quatro caem juntos, o problema quase nunca é dos quatro.
  const downCount = outcomes.filter(o => o.action.kind === 'alert' || o.action.kind === 'remind').length;
  if (downCount === MONITORED_COMPONENTS.length) {
    lines.push('', '⚠️ _Todos os coletores pararam juntos — provavelmente o processo caiu, não um coletor._');
  }

  return lines.join('\n');
}

export function buildRecoveredMessage(outcomes: readonly Outcome[]): string {
  const lines = ['✅ *Coletor normalizado*', ''];

  for (const o of outcomes) {
    if (o.action.kind !== 'recovered') continue;
    lines.push(
      `*${o.label}* (\`${o.component}\`) voltou a completar ciclos` +
        ` — parado por *${formatDuration(o.action.downMs)}*.`,
    );
  }

  return lines.join('\n');
}

let tablesMissingSince: number | null = null;
/** Componentes que já tiveram o `never_beat` registrado. Evita repetir o log. */
const neverBeatLogged = new Set<string>();

export function startHealthMonitor(bot: Bot<BotContext>): void {
  setInterval(() => {
    void runHealthCheck(bot);
  }, CHECK_INTERVAL_MS);
}

export async function runHealthCheck(bot: Bot<BotContext>): Promise<void> {
  try {
    const now = Date.now();

    if (tablesMissingSince !== null) {
      if (now - tablesMissingSince < TABLE_RETRY_MS) return;
      tablesMissingSince = null;
    }

    const config = await getSystemConfig();
    if (!config.health_alerts_enabled) return;

    const chatId = resolveOpsChatId(config);
    if (!chatId) return;

    const [beats, states] = await Promise.all([
      supabase.from('collector_heartbeats').select('component, last_cycle_at, last_status, last_detail'),
      supabase.from('collector_health_alerts').select('component, state, since, last_notified_at'),
    ]);

    // 42P01 = tabela não existe: estado esperado entre o deploy e o apply.
    if (beats.error?.code === '42P01' || states.error?.code === '42P01') {
      tablesMissingSince = now;
      console.warn('[health] tabelas de saúde ainda não existem — monitor inativo por 10 min');
      return;
    }
    if (beats.error || states.error) {
      await logEvent({
        component: 'health_monitor',
        status: 'error',
        message: `leitura falhou: ${beats.error?.message ?? states.error?.message}`,
      });
      return;
    }

    const beatByComponent = new Map(
      (beats.data ?? []).map(r => [r.component as string, r as HeartbeatRow]),
    );
    const stateByComponent = new Map(
      (states.data ?? []).map(r => [r.component as string, r as AlertStateRow]),
    );

    const outcomes: Outcome[] = MONITORED_COMPONENTS.map(m => {
      const heartbeat = beatByComponent.get(m.component);
      return {
        label: m.label,
        component: m.component,
        heartbeat,
        action: evaluateComponent({
          thresholdMinutes: Number(config[m.thresholdKey] ?? 0),
          cooldownMinutes: config.health_alert_cooldown_minutes,
          heartbeat,
          alertState: stateByComponent.get(m.component),
          now,
        }),
      };
    });

    const down = outcomes.filter(o => o.action.kind === 'alert' || o.action.kind === 'remind');
    const recovered = outcomes.filter(o => o.action.kind === 'recovered');

    // Uma mensagem por grupo, e não uma por componente: quando o processo cai,
    // os quatro ficam obsoletos no mesmo minuto, e quatro mensagens idênticas
    // são exatamente o spam que o cooldown existe para evitar.
    if (down.length > 0) {
      await sendLongMessage(bot, chatId, buildDownMessage(down), { parseMode: 'Markdown' });
    }
    if (recovered.length > 0) {
      await sendLongMessage(bot, chatId, buildRecoveredMessage(recovered), { parseMode: 'Markdown' });
    }

    await persistOutcomes(outcomes, now);

    for (const o of outcomes) {
      if (o.action.kind === 'never_beat' && !neverBeatLogged.has(o.component)) {
        neverBeatLogged.add(o.component);
        await logEvent({
          component: 'health_monitor',
          status: 'partial',
          message: `${o.component} nunca registrou batimento — não vigiado até o primeiro ciclo`,
        });
      }
    }

    if (down.length > 0 || recovered.length > 0) {
      await logEvent({
        component: 'health_monitor',
        status: down.length > 0 ? 'error' : 'success',
        message:
          `saúde: ${down.length} parado(s), ${recovered.length} normalizado(s)`,
        metadata: {
          down: down.map(o => o.component),
          recovered: recovered.map(o => o.component),
        },
      });
    }
  } catch (err) {
    // Um monitor que derruba o processo do bot levaria junto as notificações de
    // sinal, que são a função principal dele.
    console.error('[health] runHealthCheck falhou:', err);
  }
}

/** Grava o novo estado. Só escreve o que mudou — nada a cada minuto. */
async function persistOutcomes(outcomes: readonly Outcome[], now: number): Promise<void> {
  const nowIso = new Date(now).toISOString();
  const rows: Record<string, unknown>[] = [];

  for (const o of outcomes) {
    const a = o.action;
    if (a.kind === 'alert') {
      rows.push({
        component: o.component,
        state: 'alerting',
        // `since` é o instante em que o ciclo parou, não o da detecção: é o que
        // faz a mensagem de recuperação reportar o tempo real de parada.
        since: new Date(now - a.staleMs).toISOString(),
        last_notified_at: nowIso,
      });
    } else if (a.kind === 'remind') {
      rows.push({ component: o.component, state: 'alerting', last_notified_at: nowIso });
    } else if (a.kind === 'recovered') {
      rows.push({ component: o.component, state: 'ok', since: null, last_notified_at: null });
    }
  }

  if (rows.length === 0) return;

  // Um upsert por formato de linha: o PostgREST exige o mesmo conjunto de chaves
  // em todas as linhas do lote (mesma armadilha do `splitForUpsert`).
  const byShape = new Map<string, Record<string, unknown>[]>();
  for (const row of rows) {
    const shape = Object.keys(row).sort().join(',');
    if (!byShape.has(shape)) byShape.set(shape, []);
    byShape.get(shape)!.push(row);
  }

  for (const group of byShape.values()) {
    const { error } = await supabase
      .from('collector_health_alerts')
      .upsert(group, { onConflict: 'component' });
    if (error) {
      // Falhar aqui significa repetir o alerta no próximo tick. Ruim, mas menos
      // ruim que engolir o incidente — por isso é log, não return.
      console.error('[health] falha ao gravar estado de alerta:', error.message);
    }
  }
}
