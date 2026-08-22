import { test } from 'node:test';
import assert from 'node:assert/strict';

// O módulo importa o cliente do Supabase no topo, que exige env. Criar o cliente
// não abre conexão — os valores abaixo só permitem o import.
process.env['SUPABASE_URL'] ??= 'http://localhost:54321';
process.env['SUPABASE_SERVICE_KEY'] ??= 'test-key';

const { safeSlugPrefixes, planTracks } = await import('./resolved-detector.js');

const JANELA = { from: '2026-05-24T00:00:00Z', to: '2026-09-21T00:00:00Z' };

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

// ---------------------------------------------------------------------------
// planTracks: which slices of `events` get checked for resolution
// ---------------------------------------------------------------------------

test('mercado do radar sem aposta nenhuma continua sendo checado', () => {
  // O caso que deixava mercado resolvido na tela. `v_radar` filtra
  // `status = 'active'` (20260814151752_...sql:162) e o filtro está certo — o
  // que faltava era alguém virar o status. `triar` rejeita `closed` antes do
  // upsert (radar-selection.ts), então o radar-collector nunca reescreve a
  // linha, e sem trilha do roster aqui o mercado fica 'active' para sempre.
  const tracks = planTracks({ legs: [], prefixes: [], ...JANELA });

  assert.ok(
    tracks.some(t => t.name === 'roster'),
    `sem trilha do roster: ${JSON.stringify(tracks.map(t => t.name))}`,
  );
});

test('a trilha do roster não é prioritária', () => {
  // Prioritário habilita o fallback por preço extremo, que ESCREVE resolução a
  // partir de snapshot. Isso é para onde há dinheiro, não para o roster inteiro.
  const roster = planTracks({ legs: [], prefixes: [], ...JANELA }).find(
    t => t.name === 'roster',
  );

  assert.equal(roster?.priority, false);
});

test('leg aberta é a única trilha prioritária', () => {
  const tracks = planTracks({
    legs: [{ event_id: 'e1', closed_at: null }],
    prefixes: ['cs2-'],
    ...JANELA,
  });

  assert.deepEqual(
    tracks.filter(t => t.priority).map(t => t.name),
    ['open_leg'],
  );
});

test('leg fechada entra em any_leg e não em open_leg', () => {
  const tracks = planTracks({
    legs: [{ event_id: 'e1', closed_at: '2026-08-01T00:00:00Z' }],
    prefixes: [],
    ...JANELA,
  });

  assert.equal(
    tracks.some(t => t.name === 'open_leg'),
    false,
  );
  const anyLeg = tracks.find(t => t.name === 'any_leg');
  assert.deepEqual(anyLeg && 'eventIds' in anyLeg ? anyLeg.eventIds : null, ['e1']);
});

test('sem prefixo configurado não existe trilha da vertical', () => {
  // A 20260814000233_desligar_esports.sql esvaziou `discovery_slug_prefixes`.
  const tracks = planTracks({ legs: [], prefixes: [], ...JANELA });

  assert.equal(
    tracks.some(t => t.name === 'vertical'),
    false,
  );
});
