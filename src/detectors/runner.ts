import { runCrossMarketIntraDetector } from './cross-market.js';
import { runCrossMarketInterDetector } from './cross-market-inter.js';
import { runCalendarDrivenDetector } from './calendar-driven.js';
import { runHypeRealityGapDetector } from './hype-reality-gap.js';
import { detectEarlyMarkets } from './early-market.js';
import { runStaleSignalsCleanup } from '../jobs/cleanup-stale-signals.js';
import { supabase } from '../lib/supabase.js';
import { logEvent } from '../lib/logger.js';
import { getSystemConfig } from '../lib/config.js';

type DetectorFn = () => Promise<void>;

let isRunning = false;

/**
 * Os cinco detectores genéricos, atrás de `system_config.generic_detectors_enabled`.
 *
 * Todos leem `events` + `polymarket_snapshots`. Com a varredura por volume
 * desligada (spec 000, item 4), o lado não-esports dessas tabelas parou de
 * receber dado novo — eles rodavam a cada 15 min sobre uma foto congelada.
 * A série que ainda cresce é a de esports, em `esports_snapshots`, e nenhum
 * deles lê de lá.
 *
 * Nada foi apagado: um UPDATE na flag traz os cinco de volta sem deploy.
 */
const GENERIC_DETECTORS: Array<{ name: string; fn: DetectorFn }> = [
  { name: 'cross_market_intra', fn: runCrossMarketIntraDetector },
  { name: 'cross_market_inter', fn: runCrossMarketInterDetector },
  { name: 'calendar_driven', fn: runCalendarDrivenDetector },
  { name: 'hype_reality_gap', fn: runHypeRealityGapDetector },
  { name: 'early_market', fn: detectEarlyMarkets },
];

/**
 * Fora da flag de propósito: é limpeza do que já existe, não detecção.
 *
 * E é com os detectores parados que ela mais importa — sem ninguém renovando
 * `last_seen_at`, todo sinal genérico ainda ativo vence e precisa ser dismissado,
 * ou a fila do bot fica com sinal morto para sempre.
 */
const MAINTENANCE_TASKS: Array<{ name: string; fn: DetectorFn }> = [
  { name: 'cleanup_stale_signals', fn: runStaleSignalsCleanup },
];

async function dismissStaleSignals(): Promise<void> {
  const config = await getSystemConfig();
  const cutoffMs = Date.now() - config.dismiss_stale_cutoff_minutes * 60 * 1000;

  const { data: candidates, error: selErr } = await supabase
    .from('detected_signals')
    .select('id, signal_type, metadata')
    .in('signal_type', [
      'cross_market_inter',
      'cross_market_intra',
      'calendar_driven',
      'hype_reality_gap',
      'early_market',
    ])
    .eq('dismissed', false)
    .eq('acted_on', false);

  if (selErr) {
    await logEvent({
      component: 'detector_runner',
      status: 'error',
      message: `dismissStaleSignals select failed: ${selErr.message}`,
    });
    return;
  }

  const stale = (candidates ?? []).filter(s => {
    const lastSeen = (s.metadata as any)?.last_seen_at;
    if (!lastSeen) return false;
    return new Date(lastSeen).getTime() < cutoffMs;
  });

  if (stale.length === 0) {
    await logEvent({
      component: 'detector_runner',
      status: 'success',
      message: `dismissStaleSignals: no stale signals (checked ${candidates?.length ?? 0})`,
    });
    return;
  }

  const ids = stale.map(s => s.id);
  const { error: updErr } = await supabase
    .from('detected_signals')
    .update({ dismissed: true })
    .in('id', ids);

  if (updErr) {
    await logEvent({
      component: 'detector_runner',
      status: 'error',
      message: `dismissStaleSignals update failed: ${updErr.message}`,
    });
    return;
  }

  await logEvent({
    component: 'detector_runner',
    status: 'success',
    message: `Dismissed ${ids.length} stale signal(s) (cutoff ${new Date(cutoffMs).toISOString()})`,
  });
}

export async function runAllDetectors(): Promise<void> {
  // Antes do lock: o que está desligado não roda, não toma lock e não entra na
  // contagem do ciclo. A leitura da config é cacheada por 60s.
  //
  // O guard vive aqui, e não dentro de cada detector, porque este é o único
  // chamador dos cinco. Se algum dia um deles for chamado direto (script, bot),
  // o guard não o cobre — nesse caso o certo é gatilhar na função, não aqui.
  const genericEnabled = (await getSystemConfig()).generic_detectors_enabled;

  if (isRunning) {
    await logEvent({
      component: 'detector_runner',
      status: 'partial',
      message: 'previous cycle still running, skipping this tick',
    });
    return;
  }
  isRunning = true;

  try {
    const start = Date.now();
    const results: Array<{ name: string; success: boolean; error?: string }> = [];

    const toRun = genericEnabled
      ? [...GENERIC_DETECTORS, ...MAINTENANCE_TASKS]
      : MAINTENANCE_TASKS;

    for (const detector of toRun) {
      try {
        await detector.fn();
        results.push({ name: detector.name, success: true });
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        results.push({ name: detector.name, success: false, error: msg });
        await logEvent({
          component: 'detector_runner',
          status: 'error',
          message: `Detector ${detector.name} failed: ${msg}`,
          metadata: { detector: detector.name, error: msg },
        });
      }
    }

    try {
      await dismissStaleSignals();
    } catch (err) {
      console.error('[detector_runner] dismissStaleSignals failed:', err);
      await logEvent({
        component: 'detector_runner',
        status: 'error',
        message: `dismissStaleSignals threw: ${(err as Error).message}`,
      });
    }

    const duration = Date.now() - start;
    // O estado desligado vai na linha que já existe, em vez de virar log próprio:
    // o runner tica a cada 15 min e uma segunda linha por ciclo seria 96 linhas/dia
    // para dizer sempre a mesma coisa.
    const disabledNote = genericEnabled
      ? ''
      : ` (genéricos desligados por system_config.generic_detectors_enabled)`;

    await logEvent({
      component: 'detector_runner',
      status: results.every((r) => r.success) ? 'success' : 'partial',
      message: `Ran ${results.length} detectors in ${duration}ms${disabledNote}`,
      metadata: {
        results,
        duration_ms: duration,
        generic_detectors_enabled: genericEnabled,
        skipped: genericEnabled ? null : GENERIC_DETECTORS.map(d => d.name),
      },
    });
  } finally {
    isRunning = false;
  }
}
