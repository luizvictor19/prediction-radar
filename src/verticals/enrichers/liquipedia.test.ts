import { test } from 'node:test';
import assert from 'node:assert/strict';

// O módulo importa o cliente do Supabase no topo. Criar o cliente não abre
// conexão — nenhum teste aqui toca banco ou rede: tudo é leitura de linha e
// montagem de fragmento, que são puras de propósito.
process.env['SUPABASE_URL'] ??= 'http://localhost:54321';
process.env['SUPABASE_SERVICE_KEY'] ??= 'test-key';

const {
  liquipediaEnricher,
  activeSquad,
  readMatch,
  tally,
  parseDate,
  readCachedPage,
  buildRosterFragment,
  buildH2hFragment,
  buildFormFragment,
  buildTournamentFragment,
  CONFIDENCE,
  WIKI_BY_VERTICAL,
} = await import('./liquipedia.js');

const ASOF = new Date('2026-08-07T12:00:00.000Z');

const NAVI = { teamId: 'team-a', displayName: 'Natus Vincere', page: 'Natus Vincere' };
const FAZE = { teamId: 'team-b', displayName: 'FaZe Clan', page: 'FaZe Clan' };

function squadRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    pagename: 'Natus Vincere',
    id: 'aleksib',
    name: 'Aleksi Virolainen',
    role: 'igl',
    joindate: '2025-01-01',
    leavedate: '',
    ...over,
  };
}

function matchRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    date: '2026-07-01',
    winner: '1',
    bestof: '3',
    tournament: 'IEM Cologne 2026',
    parent: 'IEM/Cologne/2026',
    match2opponents: [
      { name: 'Natus Vincere', score: 2 },
      { name: 'FaZe Clan', score: 1 },
    ],
    ...over,
  };
}

// ---------------------------------------------------------------------------
// A invariante que o eval depende
// ---------------------------------------------------------------------------

test('o enricher declara supportsPointInTime = false', () => {
  // Não é detalhe de configuração: a wiki é editada retroativamente e a LPDB não
  // diz QUANDO o fato foi registrado. Com `true`, todo replay de eval leria
  // conhecimento posterior ao instante que ele diz representar.
  assert.equal(liquipediaEnricher.supportsPointInTime, false);
});

test('a confiança fica acima do texto gerado por LLM e abaixo de fato de API', () => {
  assert.ok(CONFIDENCE > 0.4);
  assert.ok(CONFIDENCE < 1);
});

test('a wiki não é derivável do id da vertical', () => {
  assert.equal(WIKI_BY_VERTICAL['cs2'], 'counterstrike');
  assert.deepEqual(liquipediaEnricher.verticals.sort(), ['cs2', 'dota2', 'lol']);
});

// ---------------------------------------------------------------------------
// Datas
// ---------------------------------------------------------------------------

test('a data vazia do LPDB não vira 1970 nem ano zero', () => {
  assert.equal(parseDate(null), null);
  assert.equal(parseDate('0000-00-00'), null);
  assert.equal(parseDate('0000-00-00 00:00:00'), null);
  assert.equal(parseDate('2026-07-01')?.toISOString(), '2026-07-01T00:00:00.000Z');
});

// ---------------------------------------------------------------------------
// Roster ativo
// ---------------------------------------------------------------------------

test('quem saiu antes do instante pedido fica fora do line-up', () => {
  const rows = [
    squadRow({ id: 'ficou' }),
    squadRow({ id: 'saiu', leavedate: '2026-06-01' }),
    squadRow({ id: 'entra-depois', joindate: '2026-09-01' }),
  ];

  const squad = activeSquad(rows, 'Natus Vincere', ASOF);
  assert.deepEqual(squad.map(m => m.id), ['ficou']);
});

test('o line-up é filtrado por time, e underscore não separa páginas', () => {
  const rows = [squadRow(), squadRow({ pagename: 'FaZe_Clan', id: 'karrigan' })];

  assert.deepEqual(activeSquad(rows, 'FaZe Clan', ASOF).map(m => m.id), ['karrigan']);
  assert.deepEqual(activeSquad(rows, 'Natus Vincere', ASOF).map(m => m.id), ['aleksib']);
});

test('sem data de saída o jogador está no time', () => {
  assert.equal(activeSquad([squadRow({ leavedate: '0000-00-00' })], 'Natus Vincere', ASOF).length, 1);
});

// ---------------------------------------------------------------------------
// Partidas
// ---------------------------------------------------------------------------

test('o vencedor é lido por ÍNDICE base 1, não por nome', () => {
  assert.equal(readMatch(matchRow({ winner: '1' })).winner, 'Natus Vincere');
  assert.equal(readMatch(matchRow({ winner: '2' })).winner, 'FaZe Clan');
});

test('índice fora da faixa é "sem vencedor", não o primeiro lado', () => {
  // Empate, cancelamento e partida ainda não jogada caem aqui. Ler como vitória
  // do lado 1 inflaria a forma recente de todo mundo.
  assert.equal(readMatch(matchRow({ winner: '0' })).winner, null);
  assert.equal(readMatch(matchRow({ winner: '' })).winner, null);
  assert.equal(readMatch(matchRow({ winner: '3' })).winner, null);
});

test('a contagem separa vitória, derrota e o que não tem vencedor', () => {
  const matches = [
    readMatch(matchRow({ winner: '1' })),
    readMatch(matchRow({ winner: '2' })),
    readMatch(matchRow({ winner: '2' })),
    readMatch(matchRow({ winner: '0' })),
  ];

  assert.deepEqual(tally(matches, 'Natus Vincere'), { wins: 1, losses: 2, other: 1 });
  assert.deepEqual(tally(matches, 'FaZe Clan'), { wins: 2, losses: 1, other: 1 });
});

// ---------------------------------------------------------------------------
// Memoização da identidade
// ---------------------------------------------------------------------------

test('external_ids responde página conhecida, ausência recente ou nada', () => {
  const now = new Date('2026-08-07T00:00:00.000Z');

  assert.deepEqual(readCachedPage({ liquipedia_page: 'G2 Esports' }, now), {
    kind: 'page',
    page: 'G2 Esports',
  });

  // Ausência recente não é reconsultada: o orçamento é de 60 requisições por
  // HORA, e time de tier baixo sem página é caso comum.
  assert.deepEqual(
    readCachedPage({ liquipedia_page: null, liquipedia_missing_at: '2026-08-01T00:00:00Z' }, now),
    { kind: 'missing' },
  );

  // Ausência velha volta a ser pergunta: a página pode ter sido criada.
  assert.deepEqual(
    readCachedPage({ liquipedia_page: null, liquipedia_missing_at: '2026-01-01T00:00:00Z' }, now),
    { kind: 'unknown' },
  );

  assert.deepEqual(readCachedPage({}, now), { kind: 'unknown' });
  assert.deepEqual(readCachedPage(null, now), { kind: 'unknown' });
});

// ---------------------------------------------------------------------------
// Fragmentos e atribuição
// ---------------------------------------------------------------------------

test('todo fragmento carrega a atribuição no texto E no payload', () => {
  // CC BY-SA 3.0 exige atribuir a fonte. No texto porque é o `summary` que entra
  // no prompt: quem concatena summaries perde os campos estruturados.
  const fragments = [
    buildRosterFragment(
      'counterstrike',
      [{ identity: NAVI, squad: activeSquad([squadRow()], 'Natus Vincere', ASOF) }],
      ASOF,
    ),
    buildH2hFragment('counterstrike', NAVI, FAZE, [readMatch(matchRow())], ASOF),
    buildFormFragment('counterstrike', NAVI, [readMatch(matchRow())], ASOF),
    buildTournamentFragment(
      'counterstrike',
      { name: 'IEM Cologne 2026', pagename: 'IEM/Cologne/2026', liquipediatier: '1' },
      3,
      ASOF,
    ),
  ];

  for (const fragment of fragments) {
    assert.ok(fragment !== null);
    assert.match(fragment.summary, /Liquipedia \(CC BY-SA 3\.0\)/);
    assert.deepEqual((fragment.payload as Record<string, unknown>)['source'], {
      source: 'Liquipedia',
      license: 'CC BY-SA 3.0',
      license_url: 'https://creativecommons.org/licenses/by-sa/3.0/',
    });
    assert.equal(fragment.enricherId, 'liquipedia');
    assert.equal(fragment.asOf, ASOF);
  }
});

test('o as_of do fragmento é a OBSERVAÇÃO, não a data do fato', () => {
  // Um roster com joindate de janeiro observado hoje tem as_of de hoje. Dizer
  // janeiro seria afirmar que nós sabíamos em janeiro.
  const fragment = buildRosterFragment(
    'counterstrike',
    [{ identity: NAVI, squad: activeSquad([squadRow({ joindate: '2025-01-01' })], 'Natus Vincere', ASOF) }],
    ASOF,
  );

  assert.ok(fragment !== null);
  assert.equal(fragment.asOf.toISOString(), ASOF.toISOString());
  const payload = fragment.payload as Record<string, unknown>;
  assert.equal(payload['active_at'], ASOF.toISOString());
  const teams = payload['teams'] as Array<Record<string, unknown>>;
  const players = teams[0]?.['players'] as Array<Record<string, unknown>>;
  assert.equal(players[0]?.['join_date'], '2025-01-01T00:00:00.000Z');
});

test('o roster destaca entrada recente, que é o que o preço pode não ter', () => {
  const recente = buildRosterFragment(
    'counterstrike',
    [{ identity: NAVI, squad: activeSquad([squadRow({ joindate: '2026-07-20' })], 'Natus Vincere', ASOF) }],
    ASOF,
  );
  assert.match(recente?.summary ?? '', /Mudança recente de line-up/);

  const antigo = buildRosterFragment(
    'counterstrike',
    [{ identity: NAVI, squad: activeSquad([squadRow({ joindate: '2024-01-01' })], 'Natus Vincere', ASOF) }],
    ASOF,
  );
  assert.match(antigo?.summary ?? '', /Nenhuma entrada nos últimos 60 dias/);
});

test('o h2h é contado do ponto de vista do lado A', () => {
  const matches = [
    readMatch(matchRow({ winner: '1' })),
    readMatch(matchRow({ winner: '1' })),
    readMatch(matchRow({ winner: '2' })),
  ];

  const doLadoA = buildH2hFragment('counterstrike', NAVI, FAZE, matches, ASOF);
  const doLadoB = buildH2hFragment('counterstrike', FAZE, NAVI, matches, ASOF);

  assert.match(doLadoA?.summary ?? '', /2-1 para Natus Vincere/);
  assert.match(doLadoB?.summary ?? '', /1-2 para FaZe Clan/);
});

test('sem partida não se inventa fragmento vazio', () => {
  assert.equal(buildH2hFragment('counterstrike', NAVI, FAZE, [], ASOF), null);
  assert.equal(buildFormFragment('counterstrike', NAVI, [], ASOF), null);
  assert.equal(buildRosterFragment('counterstrike', [{ identity: NAVI, squad: [] }], ASOF), null);
  assert.equal(buildTournamentFragment('counterstrike', {}, null, ASOF), null);
});

test('time sem página na Liquipedia não gera h2h', () => {
  const semPagina = { teamId: 'team-c', displayName: 'Time Obscuro', page: null };
  assert.equal(buildH2hFragment('counterstrike', NAVI, semPagina, [readMatch(matchRow())], ASOF), null);
});

test('a URL da página é montada com underscore e escape', () => {
  const fragment = buildTournamentFragment(
    'counterstrike',
    { name: 'IEM Cologne 2026', pagename: 'IEM/Cologne/2026' },
    null,
    ASOF,
  );

  assert.equal(
    (fragment?.payload as Record<string, unknown>)['url'],
    'https://liquipedia.net/counterstrike/IEM%2FCologne%2F2026',
  );
});
