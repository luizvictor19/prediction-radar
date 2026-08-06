import { test } from 'node:test';
import assert from 'node:assert/strict';

// O módulo importa o cliente do Supabase no topo. Criar o cliente não abre
// conexão — nada aqui toca banco ou rede: só o registry e as duas guardas, que
// são puras de propósito.
process.env['SUPABASE_URL'] ??= 'http://localhost:54321';
process.env['SUPABASE_SERVICE_KEY'] ??= 'test-key';

const {
  registerEnricher,
  getEnrichers,
  resetEnrichers,
  enricherSkipReason,
  fragmentRejection,
  DEFAULT_POINT_IN_TIME_TOLERANCE_MS,
} = await import('./enricher.js');

type Enricher = Parameters<typeof registerEnricher>[0];
type ContextFragment = Parameters<typeof fragmentRejection>[0];

const NOW = new Date('2026-08-06T18:00:00.000Z');

function enricher(overrides: Partial<Enricher> = {}): Enricher {
  return {
    id: 'market-history',
    verticals: ['cs2'],
    ttlSeconds: 300,
    supportsPointInTime: true,
    fetch: async () => [],
    ...overrides,
  };
}

function fragment(overrides: Partial<ContextFragment> = {}): ContextFragment {
  return {
    enricherId: 'market-history',
    kind: 'odds',
    asOf: NOW,
    payload: { mid_price: 0.62 },
    summary: 'Preço subiu de 0.55 para 0.62 nas últimas 6h.',
    confidence: 1.0,
    ...overrides,
  };
}

function minutesBefore(n: number): Date {
  return new Date(NOW.getTime() - n * 60_000);
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

test('id duplicado explode no registro — enricher_id é a chave de proveniência', () => {
  resetEnrichers();
  registerEnricher(enricher());
  assert.throws(() => registerEnricher(enricher({ ttlSeconds: 60 })), /duplicado/);
});

test('o registry recusa declaração incompleta antes de qualquer escrita', () => {
  resetEnrichers();
  assert.throws(() => registerEnricher(enricher({ id: '  ' })), /sem id/);
  assert.throws(() => registerEnricher(enricher({ verticals: [] })), /vertical/);
  assert.throws(() => registerEnricher(enricher({ ttlSeconds: -1 })), /ttlSeconds/);
  // Esquecer a flag cairia no lado seguro (falsy = sem point-in-time), mas o
  // enricher sumiria de todo replay sem dizer por quê.
  assert.throws(
    () => registerEnricher(enricher({ supportsPointInTime: undefined as unknown as boolean })),
    /supportsPointInTime/,
  );
});

test('getEnrichers filtra por vertical e devolve em ordem estável de id', () => {
  resetEnrichers();
  registerEnricher(enricher({ id: 'polymarket-context', verticals: ['cs2', 'lol'] }));
  registerEnricher(enricher({ id: 'market-history', verticals: ['cs2'] }));
  registerEnricher(enricher({ id: 'lol-only', verticals: ['lol'] }));

  assert.deepEqual(
    getEnrichers('cs2').map(e => e.id),
    ['market-history', 'polymarket-context'],
  );
  assert.deepEqual(
    getEnrichers('lol').map(e => e.id),
    ['lol-only', 'polymarket-context'],
  );
  assert.deepEqual(getEnrichers('dota2'), []);
});

test('mutar o array de verticals depois do registro não muda o registry', () => {
  resetEnrichers();
  const verticals = ['cs2'];
  registerEnricher(enricher({ verticals }));
  verticals.push('lol');
  assert.deepEqual(getEnrichers('lol'), []);
});

// ---------------------------------------------------------------------------
// A guarda de point-in-time — o que impede o eval de mentir
// ---------------------------------------------------------------------------

test('point-in-time roda em qualquer asOf do passado', () => {
  const e = enricher({ supportsPointInTime: true });
  assert.equal(enricherSkipReason(e, minutesBefore(60 * 24 * 30), NOW), null);
  assert.equal(enricherSkipReason(e, NOW, NOW), null);
});

test('requirePointInTime pula a fonte sem histórico mesmo com asOf = agora', () => {
  const e = enricher({ supportsPointInTime: false });
  assert.equal(enricherSkipReason(e, NOW, NOW), null);
  assert.match(
    enricherSkipReason(e, NOW, NOW, { requirePointInTime: true }) ?? '',
    /point-in-time/,
  );
});

test('fonte sem histórico é recusada em asOf passado mesmo sem o chamador pedir', () => {
  // A recusa que protege de esquecimento: quem monta um replay e não passa a
  // flag continua não recebendo resposta contaminada pelo que veio depois.
  const e = enricher({ supportsPointInTime: false });
  assert.match(enricherSkipReason(e, minutesBefore(60), NOW) ?? '', /asOf está 60 min no passado/);
});

test('a tolerância separa atraso de agendamento de replay histórico', () => {
  const e = enricher({ supportsPointInTime: false });
  const inside = new Date(NOW.getTime() - DEFAULT_POINT_IN_TIME_TOLERANCE_MS + 1_000);
  const outside = new Date(NOW.getTime() - DEFAULT_POINT_IN_TIME_TOLERANCE_MS - 1_000);

  assert.equal(enricherSkipReason(e, inside, NOW), null);
  assert.notEqual(enricherSkipReason(e, outside, NOW), null);
});

test('asOf no futuro é recusado inclusive para fonte point-in-time', () => {
  // Nenhuma fonte responde sobre instante que não chegou; deixar passar geraria
  // fragmento que o replay leria como conhecimento antecipado.
  const future = new Date(NOW.getTime() + 60 * 60_000);
  assert.match(enricherSkipReason(enricher(), future, NOW) ?? '', /futuro/);
  assert.match(
    enricherSkipReason(enricher({ supportsPointInTime: false }), future, NOW) ?? '',
    /futuro/,
  );
});

test('asOf inválido é recusado antes de virar Invalid Date no payload', () => {
  assert.equal(enricherSkipReason(enricher(), new Date('não é data'), NOW), 'asOf inválido');
});

// ---------------------------------------------------------------------------
// Validação de fragmento — um enricher ruim não derruba o lote dos outros
// ---------------------------------------------------------------------------

test('fragmento bem formado passa', () => {
  assert.equal(fragmentRejection(fragment(), NOW), null);
});

test('confidence fora de [0,1] é descartada — a coluna é numeric(3,2) e aceitaria 9.99', () => {
  assert.match(fragmentRejection(fragment({ confidence: 1.5 }), NOW) ?? '', /confidence/);
  assert.match(fragmentRejection(fragment({ confidence: -0.1 }), NOW) ?? '', /confidence/);
  assert.match(fragmentRejection(fragment({ confidence: NaN }), NOW) ?? '', /confidence/);
  assert.equal(fragmentRejection(fragment({ confidence: 0 }), NOW), null);
});

test('payload ausente é descartado: NULL derrubaria o chunk inteiro', () => {
  assert.equal(fragmentRejection(fragment({ payload: null }), NOW), 'payload ausente');
  assert.equal(fragmentRejection(fragment({ payload: undefined }), NOW), 'payload ausente');
  // Objeto vazio é payload legítimo — "a fonte respondeu e não havia nada" é fato.
  assert.equal(fragmentRejection(fragment({ payload: {} }), NOW), null);
});

test('summary e kind em branco são descartados, não gravados vazios', () => {
  assert.equal(fragmentRejection(fragment({ summary: '   ' }), NOW), 'summary vazio');
  assert.equal(fragmentRejection(fragment({ kind: '' }), NOW), 'kind vazio');
});

test('as_of do fragmento pode ser muito anterior a agora — backfill é legítimo', () => {
  // É exatamente o caso que obriga o replay a filtrar por observed_at: a linha
  // é gravada hoje, o fato é de duas semanas atrás.
  assert.equal(fragmentRejection(fragment({ asOf: minutesBefore(60 * 24 * 14) }), NOW), null);
});

test('as_of do fragmento no futuro é descartado', () => {
  const future = new Date(NOW.getTime() + 2 * 60 * 60_000);
  assert.match(fragmentRejection(fragment({ asOf: future }), NOW) ?? '', /futuro/);
});
