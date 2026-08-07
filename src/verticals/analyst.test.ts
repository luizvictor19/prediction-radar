import { test } from 'node:test';
import assert from 'node:assert/strict';

// O módulo importa o SDK da Anthropic, mas o cliente é criado sob demanda —
// nada aqui toca rede. O que se testa é o guardrail: a validação que decide se
// uma resposta vira linha ou vira erro.
process.env['SUPABASE_URL'] ??= 'http://localhost:54321';
process.env['SUPABASE_SERVICE_KEY'] ??= 'test-key';

const { parseAnalysis, estimateCostUsd, fingerprintFragments, knownModel, AnalystError } =
  await import('./analyst.js');

const LABELS = new Set(['F1', 'F2', 'F3']);

function response(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    abstain: false,
    abstain_reason: null,
    probability: 0.62,
    confidence: 0.7,
    thesis: 'NAVI entra favorita. O preço subiu 8pp em 24h com liquidez crescente.',
    claims: [{ claim: 'o preço subiu 8pp em 24h', fragment: 'F1' }],
    ...overrides,
  };
}

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    return err instanceof AnalystError ? err.code : 'not-an-AnalystError';
  }
  return 'no-throw';
}

// ---------------------------------------------------------------------------
// O contrato de saída
// ---------------------------------------------------------------------------

test('resposta bem formada vira análise', () => {
  const output = parseAnalysis(response(), LABELS);
  assert.equal(output.abstain, false);
  assert.equal(output.probability, 0.62);
  assert.equal(output.claims.length, 1);
});

test('probabilidade fora de [0,1] falha alto — a API não checa faixa', () => {
  // `minimum`/`maximum` não são suportados em structured outputs e o SDK os
  // remove do schema antes de enviar. Esta é a única checagem que existe.
  assert.equal(codeOf(() => parseAnalysis(response({ probability: 1.4 }), LABELS)), 'probability_range');
  assert.equal(codeOf(() => parseAnalysis(response({ probability: -0.1 }), LABELS)), 'probability_range');
  assert.equal(codeOf(() => parseAnalysis(response({ confidence: 2 }), LABELS)), 'confidence_range');

  // Os extremos são válidos: 0 e 1 são convicções legítimas.
  assert.equal(parseAnalysis(response({ probability: 0 }), LABELS).probability, 0);
  assert.equal(parseAnalysis(response({ probability: 1 }), LABELS).probability, 1);
});

test('citação de fragmento inexistente é rejeitada, não ignorada', () => {
  // É o defeito exato que a rastreabilidade existe para medir. Gravar seria
  // envenenar o dataset com a própria coisa que ele mede.
  assert.equal(
    codeOf(() => parseAnalysis(response({ claims: [{ claim: 'x', fragment: 'F9' }] }), LABELS)),
    'unknown_fragment',
  );
});

test('tese sem afirmação rastreável não é análise', () => {
  assert.equal(codeOf(() => parseAnalysis(response({ claims: [] }), LABELS)), 'no_claims');
  assert.equal(codeOf(() => parseAnalysis(response({ thesis: '  ' }), LABELS)), 'missing_thesis');
});

test('abstenção é resposta válida — mas exige motivo', () => {
  const output = parseAnalysis(
    response({
      abstain: true,
      abstain_reason: 'só há preço; nada sobre a partida',
      probability: null,
      confidence: null,
      thesis: null,
      claims: [],
    }),
    LABELS,
  );

  assert.equal(output.abstain, true);
  assert.match(output.abstainReason ?? '', /só há preço/);
  // Abster-se e opinar ao mesmo tempo não é uma resposta, são duas.
  assert.equal(output.probability, null);
  assert.equal(output.thesis, null);

  assert.equal(
    codeOf(() => parseAnalysis(response({ abstain: true, abstain_reason: null }), LABELS)),
    'schema',
  );
});

test('forma inválida cai em schema, não em exceção genérica', () => {
  assert.equal(codeOf(() => parseAnalysis(null, LABELS)), 'schema');
  assert.equal(codeOf(() => parseAnalysis(response({ abstain: 'sim' }), LABELS)), 'schema');
  assert.equal(codeOf(() => parseAnalysis(response({ claims: 'F1' }), LABELS)), 'schema');
  assert.equal(codeOf(() => parseAnalysis(response({ probability: null }), LABELS)), 'schema');
});

// ---------------------------------------------------------------------------
// Custo
// ---------------------------------------------------------------------------

test('custo sai dos tokens e das tarifas do modelo', () => {
  // Opus 5: US$ 5/MTok de entrada, US$ 25/MTok de saída.
  const cost = estimateCostUsd('claude-opus-5', {
    input: 3000,
    output: 500,
    cacheRead: 0,
    cacheWrite: 0,
  });
  assert.equal(cost, 0.0275);
});

test('modelo sem preço conhecido não tem custo — e por isso não roda', () => {
  // Sem preço não há como somar gasto; sem soma não há teto; e um teto que não
  // sabe contar é pior que não ter teto, porque parece que tem.
  assert.equal(knownModel('claude-opus-5'), true);
  assert.equal(knownModel('modelo-inventado'), false);
  assert.equal(
    estimateCostUsd('modelo-inventado', { input: 1000, output: 100, cacheRead: 0, cacheWrite: 0 }),
    null,
  );
});

test('leitura de cache entra a 0,1x e escrita a 1,25x', () => {
  const cost = estimateCostUsd('claude-sonnet-5', {
    input: 0,
    output: 0,
    cacheRead: 1_000_000,
    cacheWrite: 1_000_000,
  });
  // 3 * 0.1 + 3 * 1.25 = 4.05
  assert.equal(cost, 4.05);
});

// ---------------------------------------------------------------------------
// Fingerprint
// ---------------------------------------------------------------------------

test('o fingerprint não depende da ordem em que o banco devolveu', () => {
  const a = fingerprintFragments([
    { fragmentId: 2, asOf: '2026-08-07T10:00:00.000Z' },
    { fragmentId: 1, asOf: '2026-08-07T09:00:00.000Z' },
  ]);
  const b = fingerprintFragments([
    { fragmentId: 1, asOf: '2026-08-07T09:00:00.000Z' },
    { fragmentId: 2, asOf: '2026-08-07T10:00:00.000Z' },
  ]);
  assert.equal(a, b);
});

test('fragmento novo muda o fingerprint; conjunto igual mantém', () => {
  const base = [{ fragmentId: 1, asOf: '2026-08-07T09:00:00.000Z' }];
  const grown = [...base, { fragmentId: 2, asOf: '2026-08-07T10:00:00.000Z' }];

  assert.equal(fingerprintFragments(base), fingerprintFragments([...base]));
  assert.notEqual(fingerprintFragments(base), fingerprintFragments(grown));
});

test('conjunto vazio tem fingerprint estável', () => {
  assert.equal(fingerprintFragments([]), fingerprintFragments([]));
});
