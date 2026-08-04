import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CycleLock } from './cycle-lock.js';

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

/** Prazo curto para o teste não depender dos 20min do default. */
const STALE_MS = 150;

test('bloqueia um segundo ciclo enquanto o primeiro está dentro do prazo', () => {
  const lock = new CycleLock(STALE_MS);

  const first = lock.tryAcquire();
  assert.notEqual(first, null);
  assert.equal(first?.staleTakeoverMs, null, 'primeiro acquire não é takeover');

  assert.equal(lock.tryAcquire(), null, 'segundo tick é recusado');
  assert.ok((lock.heldForMs() ?? -1) >= 0, 'heldForMs reporta o ciclo em andamento');
});

test('assume o lock quando o ciclo anterior passa do prazo', async () => {
  const lock = new CycleLock(STALE_MS);

  lock.tryAcquire();
  assert.equal(lock.tryAcquire(), null, 'ainda dentro do prazo');

  await sleep(STALE_MS + 50);

  const takeover = lock.tryAcquire();
  assert.notEqual(takeover, null, 'takeover depois do prazo');
  assert.ok(
    (takeover?.staleTakeoverMs ?? 0) >= STALE_MS,
    'takeover reporta há quanto tempo o anterior estava preso',
  );
});

test('release de um ciclo zumbi não derruba o lock de quem assumiu', async () => {
  const lock = new CycleLock(STALE_MS);

  const zombie = lock.tryAcquire();
  assert.notEqual(zombie, null);

  await sleep(STALE_MS + 50);
  const successor = lock.tryAcquire();
  assert.notEqual(successor, null);

  // O ciclo travado finalmente retorna, muito depois de perder o lock.
  lock.release(zombie!);
  assert.equal(lock.tryAcquire(), null, 'o lock do sucessor continua de pé');

  lock.release(successor!);
  assert.notEqual(lock.tryAcquire(), null, 'release do detentor real libera');
});

test('release é idempotente', () => {
  const lock = new CycleLock(STALE_MS);

  const token = lock.tryAcquire();
  lock.release(token!);
  lock.release(token!);

  const next = lock.tryAcquire();
  assert.notEqual(next, null);
  assert.equal(next?.staleTakeoverMs, null, 'ciclo após release limpo não é takeover');
  assert.equal(lock.heldForMs() === null, false, 'heldForMs volta a reportar');
});

test('heldForMs é null quando não há ciclo', () => {
  const lock = new CycleLock(STALE_MS);
  assert.equal(lock.heldForMs(), null);

  const token = lock.tryAcquire();
  lock.release(token!);
  assert.equal(lock.heldForMs(), null);
});
