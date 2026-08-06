import { test } from 'node:test';
import assert from 'node:assert/strict';

// O módulo importa o cliente do Supabase no topo. Criar o cliente não abre
// conexão — o que este arquivo testa é a guarda de vazamento e a montagem do
// fragmento, ambas puras.
process.env['SUPABASE_URL'] ??= 'http://localhost:54321';
process.env['SUPABASE_SERVICE_KEY'] ??= 'test-key';

const {
  readContextBlock,
  contextAsOf,
  shouldSkipRewrite,
  firstSentences,
  buildContextFragment,
  CONTEXT_CONFIDENCE_DATED,
  CONTEXT_CONFIDENCE_UNDATED,
  POLYMARKET_CONTEXT_ID,
} = await import('./polymarket-context.js');

type PolymarketContextBlock = NonNullable<ReturnType<typeof readContextBlock>>;

const NOW = new Date('2026-08-06T18:00:00.000Z');
const TOLERANCE_MS = 5 * 60_000;

const DESCRIPTION =
  'Nuclear TigeRES chega embalada de três vitórias seguidas na fase de grupos. ' +
  'Butterfly perdeu o último confronto direto por 2-0. O head-to-head recente favorece a primeira.';

function block(overrides: Partial<PolymarketContextBlock> = {}): PolymarketContextBlock {
  return {
    description: DESCRIPTION,
    updatedAt: '2026-08-06T15:01:18.892Z',
    requiresRegen: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Leitura do bloco
// ---------------------------------------------------------------------------

test('lê o bloco context_* em snake_case e em camelCase', () => {
  assert.deepEqual(
    readContextBlock({
      league: 'CCT Europe',
      context_description: 'texto',
      context_updated_at: '2026-08-06T15:01:18.892Z',
      context_requires_regen: true,
    }),
    { description: 'texto', updatedAt: '2026-08-06T15:01:18.892Z', requiresRegen: true },
  );

  assert.deepEqual(
    readContextBlock({ contextDescription: 'texto', contextRequiresRegen: false }),
    { description: 'texto', updatedAt: null, requiresRegen: false },
  );
});

test('sem texto não há bloco — e metadata nulo não explode', () => {
  assert.equal(readContextBlock({ league: 'LPL' }), null);
  assert.equal(readContextBlock({ context_description: '   ' }), null);
  assert.equal(readContextBlock(null), null);
});

test('requires_regen ausente é null, não false', () => {
  // A distinção importa: a spec quer medir depois se texto marcado como stale
  // tem qualidade pior, e "a Polymarket não disse" não é "a Polymarket disse não".
  assert.equal(readContextBlock({ context_description: 'x' })?.requiresRegen, null);
});

// ---------------------------------------------------------------------------
// A guarda de vazamento — o que sustenta supportsPointInTime = true
// ---------------------------------------------------------------------------

test('texto datado antes do asOf entra com o carimbo da fonte', () => {
  const result = contextAsOf(block(), NOW, NOW, TOLERANCE_MS);
  assert.equal(result.kind, 'source');
  assert.equal(result.kind === 'source' && result.asOf.toISOString(), '2026-08-06T15:01:18.892Z');
});

test('texto mais novo que o asOf é RECUSADO — é o vazamento direto', () => {
  // `event_metadata` é sobrescrito a cada ciclo: ler a coluna num replay devolve
  // o texto atual. Sem esta recusa, o replay receberia um parágrafo escrito
  // depois do instante que ele diz representar.
  const asOfPassado = new Date('2026-08-06T14:00:00.000Z');
  const result = contextAsOf(block(), asOfPassado, NOW, TOLERANCE_MS);

  assert.equal(result.kind, 'refuse');
  assert.match(result.kind === 'refuse' ? result.reason : '', /depois do asOf/);
});

test('a tolerância de relógio não deixa o presente virar vazamento', () => {
  // Carimbo dois minutos "no futuro" contra o nosso relógio é desvio de clock,
  // não conhecimento antecipado.
  const doisMinutosDepois = new Date(NOW.getTime() + 2 * 60_000);
  const result = contextAsOf(
    block({ updatedAt: doisMinutosDepois.toISOString() }),
    NOW,
    NOW,
    TOLERANCE_MS,
  );
  assert.equal(result.kind, 'source');
});

test('texto sem carimbo vale para o presente e não vale para replay', () => {
  const agora = contextAsOf(block({ updatedAt: null }), NOW, NOW, TOLERANCE_MS);
  assert.equal(agora.kind, 'observation');
  assert.equal(agora.kind === 'observation' && agora.asOf.toISOString(), NOW.toISOString());

  const replay = contextAsOf(
    block({ updatedAt: null }),
    new Date('2026-08-01T00:00:00.000Z'),
    NOW,
    TOLERANCE_MS,
  );
  assert.equal(replay.kind, 'refuse');
  assert.match(replay.kind === 'refuse' ? replay.reason : '', /replay/);
});

test('carimbo ilegível é recusa, não palpite', () => {
  const result = contextAsOf(block({ updatedAt: 'ontem à tarde' }), NOW, NOW, TOLERANCE_MS);
  assert.equal(result.kind, 'refuse');
  assert.match(result.kind === 'refuse' ? result.reason : '', /ilegível/);
});

// ---------------------------------------------------------------------------
// Regravação
// ---------------------------------------------------------------------------

test('carimbo igual = texto igual: não regrava', () => {
  const asOf = new Date('2026-08-06T15:01:18.892Z');
  assert.equal(shouldSkipRewrite(asOf, asOf, 'source', 3_600), true);
  assert.equal(shouldSkipRewrite(new Date('2026-08-06T12:00:00.000Z'), asOf, 'source', 3_600), false);
  assert.equal(shouldSkipRewrite(null, asOf, 'source', 3_600), false);
});

test('sem carimbo, quem decide a cadência é o TTL', () => {
  const meiaHoraAtras = new Date(NOW.getTime() - 30 * 60_000);
  const duasHorasAtras = new Date(NOW.getTime() - 2 * 60 * 60_000);

  assert.equal(shouldSkipRewrite(meiaHoraAtras, NOW, 'observation', 3_600), true);
  assert.equal(shouldSkipRewrite(duasHorasAtras, NOW, 'observation', 3_600), false);
});

// ---------------------------------------------------------------------------
// O fragmento
// ---------------------------------------------------------------------------

test('corta em fronteira de frase quando dá', () => {
  const cortado = firstSentences(DESCRIPTION, 120);
  assert.ok(cortado.endsWith('.'));
  assert.ok(cortado.length <= 120);
  assert.doesNotMatch(cortado, /…$/);
});

test('sem fronteira de frase, corta em palavra e marca o corte', () => {
  const cortado = firstSentences('palavra '.repeat(50), 50);
  assert.ok(cortado.endsWith('…'));
  assert.ok(cortado.length <= 51);
});

test('texto curto passa inteiro, com espaços normalizados', () => {
  assert.equal(firstSentences('  duas   frases.  Ok. ', 400), 'duas frases. Ok.');
});

function fragment(source: 'source' | 'observation' = 'source') {
  return buildContextFragment({
    eventId: 'evt-1',
    slug: 'cs2-ntr-btf-2026-08-06',
    block: block({ requiresRegen: true }),
    asOf: new Date('2026-08-06T15:01:18.892Z'),
    asOfSource: source,
  });
}

test('o aviso de fonte viaja dentro do summary, não só na confiança', () => {
  // Um consumidor que concatene summaries num prompt perde os campos e fica só
  // com as frases.
  const f = fragment();
  assert.match(f.summary, /gerado por LLM/);
  assert.match(f.summary, /não usar como fato isolado/);
  assert.match(f.summary, /Nuclear TigeRES chega embalada/);
  assert.equal(f.enricherId, POLYMARKET_CONTEXT_ID);
  assert.equal(f.kind, 'news');
});

test('a confiança respeita o teto da spec e cai quando o texto não é datado', () => {
  assert.equal(fragment('source').confidence, CONTEXT_CONFIDENCE_DATED);
  assert.equal(fragment('observation').confidence, CONTEXT_CONFIDENCE_UNDATED);
  assert.ok(CONTEXT_CONFIDENCE_DATED <= 0.4);
});

test('requires_regen é gravado no payload e NÃO rebaixa a confiança', () => {
  // Precificá-lo agora responderia com a suposição a pergunta que o eval existe
  // para responder com o dado.
  const payload = fragment().payload as Record<string, unknown>;
  assert.equal(payload['context_requires_regen'], true);
  assert.equal(fragment().confidence, CONTEXT_CONFIDENCE_DATED);
});

test('o payload guarda o texto inteiro, e o summary só a abertura', () => {
  const f = fragment();
  const payload = f.payload as Record<string, unknown>;

  assert.equal(payload['description'], DESCRIPTION);
  assert.equal(payload['length_chars'], DESCRIPTION.length);
  assert.equal(payload['context_updated_at'], '2026-08-06T15:01:18.892Z');
  assert.equal(payload['as_of_source'], 'source');
  assert.ok(f.summary.length < DESCRIPTION.length + 120);
});
