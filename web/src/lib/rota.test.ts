import { test } from 'node:test';
import assert from 'node:assert/strict';

import { cronometroApos, HOJE, mercadoDaRota, type Rota } from './rota.js';

/**
 * The route, and the stopwatch that rides on it -- step 1 of item 5.
 *
 * Hoje, Regra and Operar are not three parallel places, they are one flow: you
 * list, you pick a market, and only then you decide whether to bet. The tabs
 * pretended otherwise, and the Operar tab always knew which market it meant --
 * the tab was just hiding it. So the market now travels IN the route, and
 * `{ tela: 'operar' }` without a market stops being representable.
 *
 * The mutation axes these tests exist to lock, all three on the stopwatch:
 *
 * 1. **restarting mid-flow** -- what the screen does today. `abrirOperar` sets
 *    `inicioMs` on every call, so Hoje -> Regra -> Operar measures only the last
 *    leg. Under the tabs that was survivable because Operar was reachable
 *    straight from a card; once the flow always crosses Regra, it measures the
 *    wrong thing every single time.
 * 2. **not clearing on the way back to Hoje** -- the next measurement inherits
 *    the previous one's start and reports time spent on another market.
 * 3. **fabricating a start on arrival** -- a run that was never timed gets a
 *    number anyway. Null is the honest answer, and it is the same distinction
 *    `somaDigest` makes by returning `null` instead of `0`.
 */

const M1 = 'evt-flavio-bolsonaro';
const M2 = 'evt-uranio-iraniano';

const regra = (id: string): Rota => ({ tela: 'regra', mercadoId: id });
const operar = (id: string): Rota => ({ tela: 'operar', mercadoId: id });

// ---------------------------------------------------------------------------
// The market travels in the route
// ---------------------------------------------------------------------------

test('a rota carrega o mercado, e só Hoje não tem nenhum', () => {
  assert.equal(mercadoDaRota(HOJE), null);
  assert.equal(mercadoDaRota(regra(M1)), M1);
  assert.equal(mercadoDaRota(operar(M1)), M1);
});

// ---------------------------------------------------------------------------
// AXIS 1 -- the clock does not restart mid-flow
// ---------------------------------------------------------------------------

test('o relógio começa ao sair de Hoje', () => {
  assert.equal(cronometroApos(HOJE, regra(M1), null, 1_000), 1_000);
});

test('ir da Regra para Operar NÃO reinicia o relógio', () => {
  // The whole point of the measurement is "from the list to here". Restarting
  // at the Operar click would measure the click, which is always near zero and
  // always flattering.
  assert.equal(cronometroApos(regra(M1), operar(M1), 1_000, 9_000), 1_000);
});

test('o fluxo inteiro mede da lista até Operar, e não a última perna', () => {
  let inicio: number | null = null;
  let atual: Rota = HOJE;

  for (const [proxima, agora] of [
    [regra(M1), 1_000],
    [operar(M1), 9_000],
  ] as const) {
    inicio = cronometroApos(atual, proxima, inicio, agora);
    atual = proxima;
  }

  // 8s of reading the rule, not the 0s of pressing the button.
  assert.equal(inicio, 1_000);
  assert.equal(9_000 - (inicio as number), 8_000);
});

// ---------------------------------------------------------------------------
// AXIS 2 -- back to the list clears it
// ---------------------------------------------------------------------------

test('voltar para Hoje zera o relógio', () => {
  assert.equal(cronometroApos(operar(M1), HOJE, 1_000, 9_000), null);
});

test('a medição seguinte não herda o começo da anterior', () => {
  const visto: (number | null)[] = [];
  let inicio: number | null = null;
  let atual: Rota = HOJE;

  for (const [proxima, agora] of [
    [regra(M1), 1_000],
    [operar(M1), 9_000],
    [HOJE, 10_000],
    [regra(M2), 50_000],
  ] as const) {
    inicio = cronometroApos(atual, proxima, inicio, agora);
    atual = proxima;
    visto.push(inicio);
  }

  // The null in the middle is the assertion. Landing back on the list with a
  // clock still running is what would charge the next market for time spent on
  // this one -- and asserting only the final 50_000 would not catch it, because
  // leaving Hoje restarts the clock anyway.
  assert.deepEqual(visto, [1_000, 1_000, null, 50_000]);
});

test('trocar de mercado recomeça a medição', () => {
  // Not reachable by clicking today, since every path crosses Hoje. It is the
  // rule anyway: a measurement belongs to one market.
  assert.equal(cronometroApos(regra(M1), regra(M2), 1_000, 9_000), 9_000);
});

test('renavegar para a MESMA rota não recomeça nada', () => {
  assert.equal(cronometroApos(regra(M1), regra(M1), 1_000, 9_000), 1_000);
});

// ---------------------------------------------------------------------------
// AXIS 3 -- never invents a start
// ---------------------------------------------------------------------------

test('chegar em Operar sem relógio não inventa um começo', () => {
  // If the clock never started, the honest answer is "not measured" -- and
  // `Operar` already renders nothing for a null `levouMs`. Inventing `agoraMs`
  // here would print "da lista até aqui: 0s" for a run nobody timed.
  assert.equal(cronometroApos(regra(M1), operar(M1), null, 9_000), null);
});

test('Hoje para Hoje continua sem relógio', () => {
  assert.equal(cronometroApos(HOJE, HOJE, null, 1_000), null);
});
