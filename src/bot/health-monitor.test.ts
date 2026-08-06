import { test } from 'node:test';
import assert from 'node:assert/strict';

// O módulo puxa o cliente do Supabase. Criar o cliente não abre conexão — os
// valores abaixo só permitem o import. Nenhum teste aqui toca no banco.
process.env['SUPABASE_URL'] ??= 'http://localhost:54321';
process.env['SUPABASE_SERVICE_KEY'] ??= 'test-key';

const {
  evaluateComponent,
  formatDuration,
  resolveOpsChatId,
  buildDownMessage,
  buildRecoveredMessage,
  MONITORED_COMPONENTS,
} = await import('./health-monitor.js');

const NOW = Date.parse('2026-08-06T12:00:00Z');
const minutesAgo = (n: number): string => new Date(NOW - n * 60_000).toISOString();

function evaluate(overrides: Partial<Parameters<typeof evaluateComponent>[0]> = {}) {
  return evaluateComponent({
    thresholdMinutes: 15,
    cooldownMinutes: 60,
    heartbeat: { component: 'c', last_cycle_at: minutesAgo(1), last_status: 'success', last_detail: null },
    alertState: undefined,
    now: NOW,
    ...overrides,
  });
}

// --- estado saudável -------------------------------------------------------

test('batimento recente não gera nada', () => {
  assert.deepEqual(evaluate(), { kind: 'none' });
});

test('exatamente no limiar ainda não alerta — só passar dele conta', () => {
  assert.equal(evaluate({ heartbeat: beatAt(15) }).kind, 'none');
  assert.equal(evaluate({ heartbeat: beatAt(16) }).kind, 'alert');
});

function beatAt(min: number) {
  return { component: 'c', last_cycle_at: minutesAgo(min), last_status: 'success', last_detail: null };
}

// --- primeira detecção -----------------------------------------------------

test('parado além do limiar alerta, com o tempo real de parada', () => {
  const action = evaluate({ heartbeat: beatAt(52) });
  assert.equal(action.kind, 'alert');
  assert.equal(action.kind === 'alert' && action.staleMs, 52 * 60_000);
});

// --- cooldown --------------------------------------------------------------

test('ainda parado dentro do cooldown fica em silêncio', () => {
  // É o coração do requisito: sem isto seria uma mensagem por minuto, por
  // componente, enquanto o incidente durar.
  const action = evaluate({
    heartbeat: beatAt(120),
    alertState: { component: 'c', state: 'alerting', since: minutesAgo(105), last_notified_at: minutesAgo(30) },
  });
  assert.deepEqual(action, { kind: 'none' });
});

test('cooldown vencido gera lembrete, não novo alerta', () => {
  const action = evaluate({
    heartbeat: beatAt(120),
    alertState: { component: 'c', state: 'alerting', since: minutesAgo(105), last_notified_at: minutesAgo(61) },
  });
  assert.equal(action.kind, 'remind');
});

test('alerting sem last_notified_at avisa — incidente sem aviso é pior que aviso a mais', () => {
  const action = evaluate({
    heartbeat: beatAt(120),
    alertState: { component: 'c', state: 'alerting', since: minutesAgo(105), last_notified_at: null },
  });
  assert.equal(action.kind, 'remind');
});

// --- recuperação -----------------------------------------------------------

test('voltou a bater depois de alertar gera a mensagem de normalização', () => {
  const action = evaluate({
    heartbeat: beatAt(1),
    alertState: { component: 'c', state: 'alerting', since: minutesAgo(134), last_notified_at: minutesAgo(5) },
  });
  assert.equal(action.kind, 'recovered');
  assert.equal(action.kind === 'recovered' && action.downMs, 134 * 60_000);
});

test('recuperação não espera cooldown — o aviso de volta é imediato', () => {
  const action = evaluate({
    heartbeat: beatAt(1),
    alertState: { component: 'c', state: 'alerting', since: minutesAgo(20), last_notified_at: minutesAgo(0) },
  });
  assert.equal(action.kind, 'recovered');
});

test('saudável e já em estado ok não repete nada', () => {
  const action = evaluate({
    heartbeat: beatAt(1),
    alertState: { component: 'c', state: 'ok', since: null, last_notified_at: null },
  });
  assert.deepEqual(action, { kind: 'none' });
});

// --- desligamentos e bordas ------------------------------------------------

test('limiar 0 desliga a vigilância do componente', () => {
  // É o que permite desligar um coletor pela config sem receber alerta dele
  // para sempre: `logDisabled` bate a cada 6h, o que não sustenta limiar em min.
  assert.deepEqual(evaluate({ thresholdMinutes: 0, heartbeat: beatAt(9999) }), { kind: 'none' });
  assert.deepEqual(evaluate({ thresholdMinutes: -1, heartbeat: beatAt(9999) }), { kind: 'none' });
});

test('componente que nunca bateu não alerta', () => {
  // Entre o apply da migration e o deploy do código que bate, os quatro estão
  // nesse estado. Quatro alertas falsos de estreia ensinariam a ignorar o canal.
  assert.deepEqual(evaluate({ heartbeat: undefined }), { kind: 'never_beat' });
});

test('timestamp ilegível não vira alerta', () => {
  // Problema de dado não é prova de que o coletor caiu.
  const action = evaluate({
    heartbeat: { component: 'c', last_cycle_at: 'não é data', last_status: null, last_detail: null },
  });
  assert.deepEqual(action, { kind: 'none' });
});

// --- destino do alerta -----------------------------------------------------

test('ops_telegram_chat_id tem precedência sobre telegram_chat_id', () => {
  assert.equal(resolveOpsChatId({ ops_telegram_chat_id: '111', telegram_chat_id: '222' }), '111');
});

test('sem ops configurado, cai no chat de sinais', () => {
  // A coluna nova não pode exigir configuração no dia do apply.
  assert.equal(resolveOpsChatId({ ops_telegram_chat_id: null, telegram_chat_id: '222' }), '222');
  assert.equal(resolveOpsChatId({ ops_telegram_chat_id: '   ', telegram_chat_id: '222' }), '222');
});

test('sem nenhum dos dois, não há para onde mandar', () => {
  assert.equal(resolveOpsChatId({ ops_telegram_chat_id: null, telegram_chat_id: null }), null);
});

// --- mensagens -------------------------------------------------------------

const outcome = (component: string, label: string, staleMin: number) => ({
  component,
  label,
  heartbeat: { component, last_cycle_at: minutesAgo(staleMin), last_status: 'partial', last_detail: 'stop: page_cap' },
  action: { kind: 'alert' as const, staleMs: staleMin * 60_000, thresholdMs: 15 * 60_000 },
});

test('a mensagem nomeia o componente, o tempo parado e o limiar', () => {
  const msg = buildDownMessage([outcome('discovery_collector', 'Descoberta', 52)]);
  assert.match(msg, /Descoberta/);
  assert.match(msg, /discovery_collector/);
  assert.match(msg, /52min/);
  assert.match(msg, /15min/);
  assert.match(msg, /stop: page_cap/);
});

test('todos parados juntos aponta para o processo, não para os coletores', () => {
  // Quando os quatro caem no mesmo minuto o problema quase nunca é dos quatro.
  const all = MONITORED_COMPONENTS.map(m => outcome(m.component, m.label, 30));
  assert.match(buildDownMessage(all), /processo caiu/);

  const one = [outcome('discovery_collector', 'Descoberta', 30)];
  assert.doesNotMatch(buildDownMessage(one), /processo caiu/);
});

test('a mensagem de normalização diz por quanto tempo ficou parado', () => {
  const msg = buildRecoveredMessage([
    {
      component: 'watchlist_collector',
      label: 'Watchlist',
      heartbeat: undefined,
      action: { kind: 'recovered', downMs: 134 * 60_000 },
    },
  ]);
  assert.match(msg, /Watchlist/);
  assert.match(msg, /2h 14min/);
});

test('duração é legível em cada escala', () => {
  assert.equal(formatDuration(45_000), '45s');
  assert.equal(formatDuration(52 * 60_000), '52min');
  assert.equal(formatDuration(2 * 3_600_000), '2h');
  assert.equal(formatDuration(2 * 3_600_000 + 14 * 60_000), '2h 14min');
  assert.equal(formatDuration(48 * 3_600_000), '2d 0h');
  // O caso que motivou tudo isto.
  assert.match(formatDuration(48 * 3_600_000), /^2d/);
});
