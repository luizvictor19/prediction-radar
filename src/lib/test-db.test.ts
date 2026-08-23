import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isLocalDatabase, requireLocalDatabase } from './test-db.js';

/**
 * The guard that keeps a writing test off the project's database.
 *
 * The mutation axes these exist to hold down:
 *
 * 1. **substring instead of hostname** — `url.includes('127.0.0.1')` passes every
 *    test below except `a host that merely CONTAINS a local one is not local`,
 *    which is the one that matters: an attacker-shaped or typo-shaped host that
 *    happens to embed the loopback address would be written to.
 * 2. **failing open on a bad URL** — returning `true` from the `catch` keeps the
 *    positive cases green and only breaks `garbage is not local`.
 * 3. **a host dropped from the set** — each accepted spelling has its own case,
 *    so narrowing the set cannot pass unnoticed.
 * 4. **a guard that measures and does not stop** — `requireLocalDatabase`
 *    returning instead of throwing is only caught by the two `throws` cases.
 */

test('the stack this machine publishes is local', () => {
  assert.equal(isLocalDatabase('http://127.0.0.1:54321'), true);
});

test('every accepted spelling of this machine is local', () => {
  for (const url of ['http://localhost:54321', 'http://[::1]:54321', 'https://127.0.0.1/rest']) {
    assert.equal(isLocalDatabase(url), true, url);
  }
});

test('the project database is not local', () => {
  assert.equal(isLocalDatabase('https://abcdefghijklm.supabase.co'), false);
});

/**
 * The case that separates a hostname check from a substring check. Both hosts
 * below contain `127.0.0.1` and neither resolves to this machine.
 */
test('a host that merely CONTAINS a local one is not local', () => {
  assert.equal(isLocalDatabase('http://127.0.0.1.attacker.example/rest/v1'), false);
  assert.equal(isLocalDatabase('https://127.0.0.1.supabase.co'), false);
});

test('garbage is not local', () => {
  for (const url of ['', 'not a url', '127.0.0.1:54321']) {
    assert.equal(isLocalDatabase(url), false, JSON.stringify(url));
  }
});

test('requireLocalDatabase lets a local URL through', () => {
  assert.doesNotThrow(() => requireLocalDatabase('http://127.0.0.1:54321'));
});

test('requireLocalDatabase throws on a remote URL, naming it', () => {
  assert.throws(() => requireLocalDatabase('https://abcdefghijklm.supabase.co'), {
    message: /refusing to use https:\/\/abcdefghijklm\.supabase\.co/,
  });
});

test('requireLocalDatabase throws on a host that only contains a local one', () => {
  assert.throws(() => requireLocalDatabase('http://127.0.0.1.attacker.example'), /refusing to use/);
});
