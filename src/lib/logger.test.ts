import { test } from 'node:test';
import assert from 'node:assert/strict';

// O módulo importa o cliente do Supabase no topo, que exige env. Criar o cliente
// não abre conexão — os valores abaixo só permitem o import. Nenhum teste aqui
// toca no banco ou na rede.
process.env['SUPABASE_URL'] ??= 'http://localhost:54321';
process.env['SUPABASE_SERVICE_KEY'] ??= 'test-key';

const { shouldWriteDisabledLog } = await import('./logger.js');

const HOUR = 60 * 60 * 1000;

test('componente desligado escreve no primeiro tick e cala pelas 6h seguintes', () => {
  // A varredura tica a cada 3 min. Sem a janela, o desligamento permanente do
  // item 4 viraria ~480 linhas/dia em `system_logs` — a tabela que acabou de sair
  // de 755 MB.
  const t0 = 1_000_000;

  assert.equal(shouldWriteDisabledLog('c1', t0), true);
  assert.equal(shouldWriteDisabledLog('c1', t0 + 3 * 60_000), false);
  assert.equal(shouldWriteDisabledLog('c1', t0 + 5 * HOUR), false);
  assert.equal(shouldWriteDisabledLog('c1', t0 + 6 * HOUR), true);
  // A janela conta a partir da última escrita, não do primeiro tick.
  assert.equal(shouldWriteDisabledLog('c1', t0 + 11 * HOUR), false);
  assert.equal(shouldWriteDisabledLog('c1', t0 + 12 * HOUR), true);
});

test('a janela é por componente — um coletor calado não cala o outro', () => {
  const t0 = 2_000_000;

  assert.equal(shouldWriteDisabledLog('c2', t0), true);
  assert.equal(shouldWriteDisabledLog('c3', t0), true);
  assert.equal(shouldWriteDisabledLog('c2', t0), false);
});
