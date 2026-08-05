import { supabase } from './supabase.js';

interface LogEventParams {
  component: string;
  status: 'success' | 'error' | 'partial';
  message: string;
  metadata?: Record<string, unknown>;
}

/**
 * Componente desligado por config não pode virar 480 linhas/dia em `system_logs`.
 *
 * A varredura por volume tica a cada 3 min e o estado desligado é permanente
 * (spec 000, item 4) — logar todo tick transformaria o desligamento na maior
 * fonte de log do sistema, que é o problema que acabou de ser resolvido
 * (755 MB / 2,7M linhas). Mas silêncio total também não serve: quem abre
 * `system_logs` procurando o coletor precisa achar a razão de ele não estar lá.
 *
 * O primeiro tick de cada processo sempre registra; depois, a cada 6h.
 */
const DISABLED_LOG_INTERVAL_MS = 6 * 60 * 60 * 1000;

const disabledLoggedAt = new Map<string, number>();

/** Separada de `logDisabled` para que a janela seja testável sem tocar no banco. */
export function shouldWriteDisabledLog(component: string, now: number = Date.now()): boolean {
  const last = disabledLoggedAt.get(component);
  if (last !== undefined && now - last < DISABLED_LOG_INTERVAL_MS) return false;

  disabledLoggedAt.set(component, now);
  return true;
}

export async function logDisabled(
  component: string,
  message: string,
  metadata?: Record<string, unknown>,
): Promise<void> {
  // O console sai em todo tick: no log do Railway o custo é zero e é onde se
  // olha primeiro quando um coletor "sumiu".
  console.log(`[${component}] ${message}`);
  if (!shouldWriteDisabledLog(component)) return;

  await logEvent({ component, status: 'success', message, metadata });
}

export async function logEvent(params: LogEventParams): Promise<void> {
  try {
    const { error } = await supabase.from('system_logs').insert({
      component: params.component,
      status: params.status,
      message: params.message,
      metadata: params.metadata ?? null,
    });

    if (error) {
      console.error('[logger] Failed to write log entry:', error.message, params);
    }
  } catch (err) {
    console.error('[logger] Exception writing log entry:', String(err), params);
  }
}
