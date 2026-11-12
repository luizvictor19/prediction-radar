import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

// The module reaches health-monitor.ts, which builds the Supabase client.
// Building it opens no connection; these values only let the import run.
process.env['SUPABASE_URL'] ??= 'http://localhost:54321';
process.env['SUPABASE_SERVICE_KEY'] ??= 'test-key';

const { buildDatabaseSizeMessage, DATABASE_SIZE_COMPONENT, evaluateDatabaseSize, monthToArchive } =
  await import('./database-size.js');

const NOW = Date.parse('2026-12-18T12:00:00Z');
const MB = 1_000_000;
const minutesAgo = (n: number) => new Date(NOW - n * 60_000).toISOString();

function evaluate(overrides: Partial<Parameters<typeof evaluateDatabaseSize>[0]> = {}) {
  return evaluateDatabaseSize({
    thresholdBytes: 850 * MB,
    cooldownMinutes: 60,
    databaseBytes: 700 * MB,
    alertState: undefined,
    now: NOW,
    ...overrides,
  });
}

const alerting = (lastNotifiedMinutesAgo: number | null, sinceMinutesAgo = 120) => ({
  component: DATABASE_SIZE_COMPONENT,
  state: 'alerting',
  since: minutesAgo(sinceMinutesAgo),
  last_notified_at: lastNotifiedMinutesAgo === null ? null : minutesAgo(lastNotifiedMinutesAgo),
});

describe('evaluateDatabaseSize', () => {
  it('abaixo do limiar e sem alerta aberto: nada', () => {
    assert.deepEqual(evaluate(), { kind: 'none' });
  });

  it('acima do limiar pela primeira vez: alerta', () => {
    assert.deepEqual(evaluate({ databaseBytes: 851 * MB }), { kind: 'alert' });
  });

  it('exatamente no limiar ainda não alerta', () => {
    assert.deepEqual(evaluate({ databaseBytes: 850 * MB }), { kind: 'none' });
  });

  it('continua acima: silêncio dentro do cooldown, lembrete depois dele', () => {
    assert.deepEqual(evaluate({ databaseBytes: 900 * MB, alertState: alerting(59) }), {
      kind: 'none',
    });
    assert.deepEqual(evaluate({ databaseBytes: 900 * MB, alertState: alerting(60) }), {
      kind: 'remind',
    });
  });

  it('alerta aberto sem registro do último aviso: lembra', () => {
    assert.deepEqual(evaluate({ databaseBytes: 900 * MB, alertState: alerting(null) }), {
      kind: 'remind',
    });
  });

  it('voltou para baixo com alerta aberto: normalizado, com o tempo acima', () => {
    assert.deepEqual(evaluate({ alertState: alerting(10, 180) }), {
      kind: 'recovered',
      overMs: 180 * 60_000,
    });
  });

  it('a sequência de um mês esquecido: nada, alerta, silêncio, lembrete, normalizado', () => {
    const passos: Array<{ bytes: number; minutos: number }> = [
      { bytes: 800 * MB, minutos: 0 },
      { bytes: 860 * MB, minutos: 60 },
      { bytes: 861 * MB, minutos: 90 },
      { bytes: 862 * MB, minutos: 120 },
      { bytes: 500 * MB, minutos: 180 },
    ];
    let state: Parameters<typeof evaluateDatabaseSize>[0]['alertState'];
    const kinds: string[] = [];
    for (const p of passos) {
      const now = NOW + p.minutos * 60_000;
      const a = evaluateDatabaseSize({
        thresholdBytes: 850 * MB,
        cooldownMinutes: 60,
        databaseBytes: p.bytes,
        alertState: state,
        now,
      });
      kinds.push(a.kind);
      const iso = new Date(now).toISOString();
      if (a.kind === 'alert') {
        state = {
          component: DATABASE_SIZE_COMPONENT,
          state: 'alerting',
          since: iso,
          last_notified_at: iso,
        };
      } else if (a.kind === 'remind' && state) {
        state = { ...state, last_notified_at: iso };
      } else if (a.kind === 'recovered') {
        state = {
          component: DATABASE_SIZE_COMPONENT,
          state: 'ok',
          since: null,
          last_notified_at: null,
        };
      }
    }
    assert.deepEqual(kinds, ['none', 'alert', 'none', 'remind', 'recovered']);
  });

  it('limiar 0 desliga, mesmo com alerta aberto', () => {
    assert.deepEqual(evaluate({ thresholdBytes: 0, databaseBytes: 2_000 * MB }), { kind: 'none' });
    assert.deepEqual(evaluate({ thresholdBytes: 0, alertState: alerting(10) }), { kind: 'none' });
  });

  it('leitura falhou (null): nada, nem alerta nem normalizado', () => {
    assert.deepEqual(evaluate({ databaseBytes: null }), { kind: 'none' });
    assert.deepEqual(evaluate({ databaseBytes: null, alertState: alerting(10) }), {
      kind: 'none',
    });
  });
});

describe('monthToArchive', () => {
  it('a partir do dia 9 sugere o mês anterior; antes disso, o retrasado', () => {
    assert.equal(monthToArchive(Date.parse('2026-12-09T00:00:00Z')), '2026-11');
    assert.equal(monthToArchive(Date.parse('2026-12-08T23:59:59Z')), '2026-10');
    assert.equal(monthToArchive(Date.parse('2027-01-20T00:00:00Z')), '2026-12');
    assert.equal(monthToArchive(Date.parse('2027-01-05T00:00:00Z')), '2026-11');
  });
});

describe('buildDatabaseSizeMessage', () => {
  it('alerta diz o tamanho, o limiar e o comando a rodar', () => {
    const msg = buildDatabaseSizeMessage({
      action: { kind: 'alert' },
      databaseBytes: 912_345_678,
      thresholdBytes: 850 * MB,
      now: NOW,
    });
    assert.match(msg, /912 MB/);
    assert.match(msg, /850 MB/);
    assert.match(msg, /npm run arquivar:particao -- 2026-11/);
  });

  it('normalizado diz quanto tempo ficou acima', () => {
    const msg = buildDatabaseSizeMessage({
      action: { kind: 'recovered', overMs: 3 * 3_600_000 },
      databaseBytes: 480 * MB,
      thresholdBytes: 850 * MB,
      now: NOW,
    });
    assert.match(msg, /480 MB/);
    assert.match(msg, /3h/);
  });
});
