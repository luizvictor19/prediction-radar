import { test } from 'node:test';
import assert from 'node:assert/strict';

// O módulo importa o cliente do Supabase no topo, que exige env. Criar o cliente
// não abre conexão — os valores abaixo só permitem o import.
process.env['SUPABASE_URL'] ??= 'http://localhost:54321';
process.env['SUPABASE_SERVICE_KEY'] ??= 'test-key';

const { safeSlugPrefixes } = await import('./resolved-detector.js');

test('mantém prefixo de slug normal', () => {
  assert.deepEqual(safeSlugPrefixes(['cs2-', 'lol-', 'dota2-']), ['cs2-', 'lol-', 'dota2-']);
});

test('descarta prefixo vazio', () => {
  assert.deepEqual(safeSlugPrefixes(['', 'cs2-']), ['cs2-']);
});

test('descarta prefixo que quebraria a string do filtro or=', () => {
  // Vírgula, ponto e parênteses são estrutura no filtro do PostgREST. Um valor
  // com eles não vira erro — vira outro filtro. `or=(slug.like.a,status.eq.x)`
  // passaria a casar qualquer status, e o detector agiria sobre o que não devia.
  const perigosos = ['a,status.eq.resolved', 'a.b', 'a)', '(a', "a'b", 'a b', 'a%'];
  assert.deepEqual(safeSlugPrefixes(perigosos), []);
});

test('lista vazia continua vazia', () => {
  assert.deepEqual(safeSlugPrefixes([]), []);
});
