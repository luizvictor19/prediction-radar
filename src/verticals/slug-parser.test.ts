import { test } from 'node:test';
import assert from 'node:assert/strict';

// Sem env e sem mock: o parser é função pura e não importa cliente de banco.
import {
  parseMarketSlug,
  inspectMarketSlug,
  DEFAULT_VERTICAL_PREFIXES,
  type ParsedMarketSlug,
} from './slug-parser.js';

// ---------------------------------------------------------------------------
// A tabela de casos da spec (Parte B), verbatim
// ---------------------------------------------------------------------------
//
// Critério de pronto do item 2: esta tabela passa 100%. Ela é suficiente e não
// precisa crescer especulativamente — dos 464 markets medidos, 0 ficaram fora
// do padrão e todos tinham exatamente 2 segmentos entre prefixo e data.

const CASES: Array<{
  slug: string;
  matchSlug: string | null;
  suffix: string | null;
  nota?: string;
}> = [
  { slug: 'cs2-ts7-g2-2026-06-19', matchSlug: 'cs2-ts7-g2-2026-06-19', suffix: null },
  { slug: 'lol-g2-t1-2026-07-08-game4', matchSlug: 'lol-g2-t1-2026-07-08', suffix: 'game4' },
  {
    slug: 'cs2-yaw-guara-2026-08-04-total-games-2pt5',
    matchSlug: 'cs2-yaw-guara-2026-08-04',
    suffix: 'total-games-2pt5',
  },
  {
    slug: 'cs2-fnc-lilmix-2026-08-03-map-handicap-away-1pt5',
    matchSlug: 'cs2-fnc-lilmix-2026-08-03',
    suffix: 'map-handicap-away-1pt5',
  },
  {
    slug: 'cs2-1win-ruby1-2026-08-03',
    matchSlug: 'cs2-1win-ruby1-2026-08-03',
    suffix: null,
    nota: 'código com dígito inicial',
  },
  {
    slug: 'cs2-mouzn-mis-2026-08-03',
    matchSlug: 'cs2-mouzn-mis-2026-08-03',
    suffix: null,
    nota: 'mouzn != mouz: time academy, e não erro de digitação a corrigir',
  },
  { slug: 'dota2-aur1-lgd-2026-06-06', matchSlug: 'dota2-aur1-lgd-2026-06-06', suffix: null },
  { slug: 'bitcoin-up-or-down-july-8', matchSlug: null, suffix: null, nota: 'não-esports' },
];

for (const c of CASES) {
  test(`tabela da spec: ${c.slug}${c.nota ? ` (${c.nota})` : ''}`, () => {
    const parsed = parseMarketSlug(c.slug);

    if (c.matchSlug === null) {
      assert.equal(parsed, null);
      return;
    }

    assert.notEqual(parsed, null);
    assert.equal(parsed?.matchSlug, c.matchSlug);
    assert.equal(parsed?.suffix, c.suffix);
  });
}

// ---------------------------------------------------------------------------
// Identidade
// ---------------------------------------------------------------------------

test('a decomposição devolve vertical, os dois códigos e a data', () => {
  const parsed = parseMarketSlug('cs2-ts7-g2-2026-06-19') as ParsedMarketSlug;
  assert.deepEqual(parsed, {
    verticalId: 'cs2',
    teamCodeA: 'ts7',
    teamCodeB: 'g2',
    matchDate: '2026-06-19',
    matchSlug: 'cs2-ts7-g2-2026-06-19',
    suffix: null,
  });
});

test('a ordem dos códigos é a do slug, não alfabética', () => {
  // O resolver confere estes dois contra `teams[].ordering` (home/away), e a
  // medição que autoriza isso — 2307/2307 na ordem do slug — só vale se o
  // parser não reordenar nada.
  const parsed = parseMarketSlug('cs2-zzz-aaa-2026-06-19') as ParsedMarketSlug;
  assert.equal(parsed.teamCodeA, 'zzz');
  assert.equal(parsed.teamCodeB, 'aaa');
});

test('markets irmãos da mesma partida convergem para o mesmo matchSlug', () => {
  // É a propriedade de que `esports_matches.match_slug` depende: a série e todos
  // os derivados (game N, handicap, total) têm que cair na mesma linha. Sem
  // isso, uma partida com 39 markets viraria 39 partidas.
  const irmaos = [
    'lol-g2-t1-2026-07-08',
    'lol-g2-t1-2026-07-08-game1',
    'lol-g2-t1-2026-07-08-game4',
    'lol-g2-t1-2026-07-08-total-games-2pt5',
    'lol-g2-t1-2026-07-08-map-handicap-away-1pt5',
  ];

  const slugs = new Set(irmaos.map(s => parseMarketSlug(s)?.matchSlug));
  assert.deepEqual([...slugs], ['lol-g2-t1-2026-07-08']);
});

test('o sufixo sai cru, com os hífens que tiver', () => {
  // O parser não interpreta sufixo: quem determina o papel do market é
  // `events.sports_market_type`. Qualquer normalização aqui seria o começo de um
  // vocabulário paralelo.
  const parsed = parseMarketSlug('cs2-a1-b2-2026-08-03-round-over-under-game-2-13pt5');
  assert.equal(parsed?.suffix, 'round-over-under-game-2-13pt5');
});

test('código de time com dígito no meio, no fim e no começo', () => {
  for (const [a, b] of [
    ['9z', 'fal2'],
    ['ast10', 'big5'],
    ['aur1', 'hle1'],
    ['imp11', 'g1'],
  ]) {
    const parsed = parseMarketSlug(`cs2-${a}-${b}-2026-08-03`);
    assert.equal(parsed?.teamCodeA, a);
    assert.equal(parsed?.teamCodeB, b);
  }
});

// ---------------------------------------------------------------------------
// Recusa: os dois motivos são diferentes de propósito
// ---------------------------------------------------------------------------

test('slug de outra categoria é not_esports, e isso não vai para fila nenhuma', () => {
  for (const slug of [
    'bitcoin-up-or-down-july-8',
    'will-gpt-6-be-released-in-2026',
    '',
    'cs2',
    'cs2x-a-b-2026-08-03',
  ]) {
    const result = inspectMarketSlug(slug);
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.reason, 'not_esports', slug);
  }
});

test('prefixo conhecido que não decompõe é malformed, não silêncio', () => {
  // Esta é a diferença que o `null` sozinho apagava. Slug que começa com `cs2-`
  // e mesmo assim não decompõe é anomalia — 0 casos em 464 medidos — e a spec
  // manda mandar para revisão em vez de adivinhar.
  for (const slug of [
    'cs2-ts7-2026-06-19', //          um código só
    'cs2-ts7-g2-2026-06', //          data incompleta
    'cs2-ts7-g2-06-19-2026', //       data em outra ordem
    'cs2-ts7-g2-2026-6-19', //        mês sem zero à esquerda
    'cs2--g2-2026-06-19', //          código vazio
    'cs2-ts7--2026-06-19', //         o outro código vazio
    'cs2-finals-2026', //             não é slug de partida
  ]) {
    const result = inspectMarketSlug(slug);
    assert.equal(result.ok, false, slug);
    assert.equal(result.ok === false && result.reason, 'malformed', slug);
  }
});

test('data que casa com o regex mas não existe no calendário é malformed', () => {
  // `2026-02-30` tem a forma certa e não é um dia. Aceitá-la seria confirmar uma
  // decomposição que só pode estar desalinhada.
  assert.equal(parseMarketSlug('cs2-a1-b2-2026-02-30'), null);
  assert.equal(parseMarketSlug('cs2-a1-b2-2026-13-01'), null);
  assert.equal(parseMarketSlug('cs2-a1-b2-2026-00-10'), null);
  assert.equal(parseMarketSlug('cs2-a1-b2-2026-06-00'), null);
  assert.equal(parseMarketSlug('cs2-a1-b2-2026-06-31'), null);

  assert.notEqual(parseMarketSlug('cs2-a1-b2-2026-02-28'), null);
  assert.notEqual(parseMarketSlug('cs2-a1-b2-2028-02-29'), null); // bissexto
  assert.notEqual(parseMarketSlug('cs2-a1-b2-2026-06-30'), null);
});

// ---------------------------------------------------------------------------
// Normalização e lista de verticais
// ---------------------------------------------------------------------------

test('caixa e espaço em volta não mudam a identidade da partida', () => {
  // Duas caixas produzindo dois match_slug seria duplicata de chave de tabela.
  const parsed = parseMarketSlug('  CS2-TS7-G2-2026-06-19-Game1  ');
  assert.equal(parsed?.matchSlug, 'cs2-ts7-g2-2026-06-19');
  assert.equal(parsed?.suffix, 'game1');
  assert.equal(parsed?.verticalId, 'cs2');
});

test('vertical desligada continua sendo parseada', () => {
  // `enabled` é política do resolver, não do parser. Se o parser filtrasse por
  // ela, o validador ficaria cego para lol e dota2 e o histórico dessas
  // verticais viraria "não é esports".
  const enabled = DEFAULT_VERTICAL_PREFIXES.map(v => v.verticalId);
  assert.deepEqual(enabled, ['cs2', 'lol', 'dota2']);
  assert.equal(parseMarketSlug('dota2-aur1-lgd-2026-06-06')?.verticalId, 'dota2');
  assert.equal(parseMarketSlug('lol-g2-t1-2026-07-08')?.verticalId, 'lol');
});

test('aur1 em cs2 e em dota2 são o mesmo código em verticais diferentes', () => {
  // O achado que sustenta `unique (vertical_id, polymarket_code)`: a chave é o
  // par, não o código. O parser tem que devolver os dois lados dele.
  const cs2 = parseMarketSlug('cs2-aur1-g2-2026-08-03') as ParsedMarketSlug;
  const dota = parseMarketSlug('dota2-aur1-lgd-2026-06-06') as ParsedMarketSlug;
  assert.equal(cs2.teamCodeA, dota.teamCodeA);
  assert.notEqual(cs2.verticalId, dota.verticalId);
});

test('a lista de verticais é injetável, e o prefixo mais longo ganha', () => {
  // A tabela `verticals` é a autoridade; o embutido é piso. E com prefixos que
  // se contêm, a ordem de declaração não pode decidir — o específico tem que
  // vencer o genérico.
  const custom = [
    { verticalId: 'cs2', slugPrefix: 'cs2-' },
    { verticalId: 'cs2legacy', slugPrefix: 'cs2-legacy-' },
  ];

  assert.equal(parseMarketSlug('cs2-legacy-a1-b2-2026-08-03', custom)?.verticalId, 'cs2legacy');
  assert.equal(parseMarketSlug('cs2-a1-b2-2026-08-03', custom)?.verticalId, 'cs2');
  // Vertical fora da lista passada não existe para o parser.
  assert.equal(parseMarketSlug('valorant-a1-b2-2026-08-03', custom), null);
});
