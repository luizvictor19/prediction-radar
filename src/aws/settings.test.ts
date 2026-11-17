import { test } from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_MODEL_ROUTES } from '../llm/registry.js';
import { readSettings } from './settings.js';

const BASE = { RADAR_SSM_PREFIX: '/radar/dev', RADAR_TABLE: 'radar-dev-digest' };

test('configuração: sem os opcionais vale teto de US$ 3, 100 itens e a tabela de rotas padrão', () => {
  assert.deepEqual(readSettings(BASE), {
    ssmPrefix: '/radar/dev',
    table: 'radar-dev-digest',
    monthlyCapUsd: 3,
    maxItems: 100,
    routes: DEFAULT_MODEL_ROUTES,
  });
});

test('configuração: os opcionais sobrescrevem', () => {
  const settings = readSettings({
    ...BASE,
    RADAR_MONTHLY_MODEL_BUDGET_USD: '1.5',
    RADAR_MAX_ITEMS: '3',
    RADAR_MODEL_ROUTES: '{"claude-haiku-5-5":"anthropic:claude-haiku-5-5"}',
  });
  assert.equal(settings.monthlyCapUsd, 1.5);
  assert.equal(settings.maxItems, 3);
  assert.deepEqual(settings.routes, { 'claude-haiku-5-5': 'anthropic:claude-haiku-5-5' });
});

test('configuração: obrigatória ausente ou número inválido para na partida', () => {
  assert.throws(() => readSettings({ RADAR_TABLE: 't' }), /RADAR_SSM_PREFIX/);
  assert.throws(() => readSettings({ RADAR_SSM_PREFIX: '/p' }), /RADAR_TABLE/);
  assert.throws(
    () => readSettings({ ...BASE, RADAR_MONTHLY_MODEL_BUDGET_USD: '0' }),
    /RADAR_MONTHLY_MODEL_BUDGET_USD/,
  );
  assert.throws(() => readSettings({ ...BASE, RADAR_MAX_ITEMS: 'muitos' }), /RADAR_MAX_ITEMS/);
  assert.throws(() => readSettings({ ...BASE, RADAR_MAX_ITEMS: '0.5' }), /RADAR_MAX_ITEMS/);
});
