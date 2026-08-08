import { test } from 'node:test';
import assert from 'node:assert/strict';

// O módulo importa o cliente do Supabase no topo. Criar o cliente não abre
// conexão — nenhum teste aqui toca banco ou rede: tudo é `planEvent` e amigos,
// que são puros de propósito.
process.env['SUPABASE_URL'] ??= 'http://localhost:54321';
process.env['SUPABASE_SERVICE_KEY'] ??= 'test-key';

const {
  planEvent,
  outcomeSideIndex,
  bestOfFromScore,
  combinedCounts,
  writtenCounts,
  emptyStats,
  classifyDiscoveryPrefixes,
} = await import('./resolver.js');

type ResolvableEvent = Parameters<typeof planEvent>[0];
type VerticalConfig = Parameters<typeof planEvent>[1][number];
type PlanContext = NonNullable<Parameters<typeof planEvent>[2]>;

const VERTICALS: VerticalConfig[] = [
  { verticalId: 'cs2', slugPrefix: 'cs2-', enabled: true },
  { verticalId: 'lol', slugPrefix: 'lol-', enabled: true },
  { verticalId: 'dota2', slugPrefix: 'dota2-', enabled: false },
];

/** O bloco que a descoberta grava hoje em `events.event_metadata`. */
function metadata(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    league: 'CCT Europe',
    leagueTier: '3',
    tournament: 'Playoffs',
    serie: 'Series #6',
    pandascoreMatchId: 1582194,
    polymarket_event_id: '806202',
    polymarket_sport: { sport: 'cs2', resolution: 'https://hltv.org' },
    polymarket_teams: [
      {
        id: 3270870,
        name: 'Nuclear TigeRES',
        abbreviation: 'ntr',
        providerId: 135673,
        league: 'csgo',
        ordering: 'home',
      },
      {
        id: 138975,
        name: 'Butterfly',
        abbreviation: 'btf',
        providerId: 138975,
        league: 'csgo',
        ordering: 'away',
      },
    ],
    ...overrides,
  };
}

function event(overrides: Partial<ResolvableEvent> = {}): ResolvableEvent {
  return {
    id: 'evt-1',
    slug: 'cs2-ntr-btf-2026-08-06',
    outcomes: { values: ['Nuclear TigeRES', 'Butterfly'] },
    event_metadata: metadata(),
    sports_market_type: 'moneyline',
    game_start_time: '2026-08-06T18:30:00.000Z',
    ...overrides,
  };
}

function plannedOf(row: ResolvableEvent, ctx: PlanContext = {}) {
  const result = planEvent(row, VERTICALS, ctx);
  assert.ok(result.ok, `esperava plano, veio ${result.ok === false ? result.reason : '?'}`);
  return result.plan;
}

// ---------------------------------------------------------------------------
// Caminho 1 — identidade exata
// ---------------------------------------------------------------------------

test('caminho 1: teams[] dá identidade completa, sem revisão', () => {
  const plan = plannedOf(event());

  assert.equal(plan.link.resolutionMethod, 'event_teams');
  assert.equal(plan.link.confidence, 1.0);
  assert.equal(plan.link.needsReview, false);
  assert.deepEqual(plan.reviewReasons, []);

  assert.equal(plan.match.matchSlug, 'cs2-ntr-btf-2026-08-06');
  assert.equal(plan.match.league, 'CCT Europe');
  assert.equal(plan.match.serie, 'Series #6');
  assert.equal(plan.match.stage, 'Playoffs');
  assert.equal(plan.match.leagueTier, '3');
  assert.deepEqual(plan.match.externalIds, {
    pandascore_match_id: 1582194,
    polymarket_event_id: '806202',
  });

  assert.deepEqual(plan.teams[0], {
    verticalId: 'cs2',
    polymarketCode: 'ntr',
    displayName: 'Nuclear TigeRES',
    polymarketTeamId: 3270870,
    pandascoreTeamId: 135673,
    authoritative: true,
  });
});

test('caminho 1: team_a é o home, team_b é o away — não a ordem do array', () => {
  const invertido = metadata({
    polymarket_teams: [
      { name: 'Butterfly', abbreviation: 'btf', ordering: 'away' },
      { name: 'Nuclear TigeRES', abbreviation: 'ntr', ordering: 'home' },
    ],
  });

  const plan = plannedOf(event({ event_metadata: invertido }));
  assert.equal(plan.teams[0]?.polymarketCode, 'ntr');
  assert.equal(plan.teams[1]?.polymarketCode, 'btf');
  assert.equal(plan.link.needsReview, false);
});

test('caminho 1: serie ausente vira string vazia e NÃO é pendência', () => {
  for (const serie of [undefined, null, '', '   ']) {
    const meta = metadata();
    if (serie === undefined) delete meta['serie'];
    else meta['serie'] = serie;

    const plan = plannedOf(event({ event_metadata: meta }));
    assert.equal(plan.match.serie, '');
    assert.equal(plan.link.needsReview, false, `serie=${JSON.stringify(serie)}`);
  }
});

// ---------------------------------------------------------------------------
// Estado A — o que exige humano, e só isso
// ---------------------------------------------------------------------------

test('A: código do slug divergente de teams[] vira revisão', () => {
  const plan = plannedOf(event({ slug: 'cs2-xxx-btf-2026-08-06' }));

  assert.equal(plan.teams[0]?.polymarketCode, 'ntr');
  assert.equal(plan.link.needsReview, true);
  assert.match(plan.reviewReasons.join(' '), /códigos divergentes/);
});

test('A: vertical do slug divergente de polymarket_sport vira revisão', () => {
  const plan = plannedOf(
    event({ event_metadata: metadata({ polymarket_sport: { sport: 'dota2' } }) }),
  );

  assert.equal(plan.match.verticalId, 'cs2');
  assert.equal(plan.link.needsReview, true);
  assert.match(plan.reviewReasons.join(' '), /vertical divergente/);
});

test('A: teams[] sem ordering vira revisão — quem é o A passa a ser convenção nossa', () => {
  const semOrdering = metadata({
    polymarket_teams: [
      { name: 'Nuclear TigeRES', abbreviation: 'ntr' },
      { name: 'Butterfly', abbreviation: 'btf' },
    ],
  });

  const plan = plannedOf(event({ event_metadata: semOrdering }));
  assert.equal(plan.link.needsReview, true);
  assert.match(plan.reviewReasons.join(' '), /ordering/);
});

test('A: outcome não casado NO CAMINHO 1 é anomalia, não pobreza', () => {
  // A medição diz que `teams[].name` bate exato com `outcomes.values`, e o
  // dry-run deu 0 casos em 446. Se aparecer, uma premissa quebrou.
  const plan = plannedOf(event({ outcomes: { values: ['Alguma Coisa', 'Outra Coisa'] } }));

  assert.equal(plan.outcomeKind, 'unmatched');
  assert.equal(plan.link.outcomeAIndex, null);
  assert.equal(plan.link.confidence, 0.5);
  assert.equal(plan.link.needsReview, true);
  assert.equal(plan.recomputable, false);
});

test('A: casamento ambíguo é humano nos DOIS caminhos', () => {
  // Ambiguidade não se resolve com mais dado nem com regra nova: os dois lados
  // casaram, e escolher um seria inventar.
  const caminho1 = plannedOf(
    event({
      event_metadata: metadata({
        polymarket_teams: [
          { name: 'G2', abbreviation: 'g2', ordering: 'home' },
          { name: 'T1', abbreviation: 't1', ordering: 'away' },
        ],
      }),
      slug: 'cs2-g2-t1-2026-08-06',
      outcomes: { values: ['G2', 'G2'] },
    }),
  );
  assert.equal(caminho1.outcomeKind, 'ambiguous');
  assert.equal(caminho1.link.needsReview, true);

  const caminho2 = plannedOf(
    event({
      event_metadata: null,
      slug: 'cs2-g2-t1-2026-01-15',
      outcomes: { values: ['G2 Esports', 'G2 Academy'] },
    }),
  );
  assert.equal(caminho2.outcomeKind, 'ambiguous');
  assert.equal(caminho2.link.needsReview, true);
  assert.equal(caminho2.recomputable, false);
});

// ---------------------------------------------------------------------------
// Estado B — recomputável, sem fila
// ---------------------------------------------------------------------------

test('B: caminho 2 sozinho NÃO é pendência — pobre não é duvidoso', () => {
  // A regressão que motivou os três estados: marcar todo o caminho 2 produziu
  // uma fila de 21.169 linhas, que é o mesmo que não ter fila.
  const plan = plannedOf(
    event({
      event_metadata: null,
      outcomes: { values: ['G2 Esports', 'Team Liquid'] },
      slug: 'cs2-g2-tl-2026-01-15',
    }),
  );

  assert.equal(plan.link.resolutionMethod, 'slug_parse');
  assert.equal(plan.link.needsReview, false);
  assert.deepEqual(plan.reviewReasons, []);
  assert.equal(plan.link.confidence, 0.7);
  // A pobreza fica registrada onde ela pertence: na confiança e nas notas.
  assert.match(plan.notes.join(' '), /derivada do slug/);
});

test('B: outcome não casado no caminho 2 é recomputável, não revisável', () => {
  const plan = plannedOf(
    event({
      event_metadata: null,
      slug: 'cs2-navi-vit-2026-05-03',
      outcomes: { values: ['Natus Vincere', 'Team Vitality'] },
    }),
  );

  // Sem registro de nomes, `navi` não é token de 'Natus Vincere'.
  assert.equal(plan.outcomeKind, 'unmatched');
  assert.equal(plan.link.outcomeAIndex, null);
  assert.equal(plan.link.needsReview, false);
  assert.equal(plan.recomputable, true);
  assert.equal(plan.link.confidence, 0.5);
});

test('B: com o registro de times, o mesmo evento casa sozinho', () => {
  // É a cura do estado B: `display_name` vem do caminho 1 para o mesmo
  // `polymarket_code`, e uma passada nova resolve sem humano nenhum.
  const teamNames = new Map([
    ['cs2|navi', 'Natus Vincere'],
    ['cs2|vit', 'Team Vitality'],
  ]);

  const plan = plannedOf(
    event({
      event_metadata: null,
      slug: 'cs2-navi-vit-2026-05-03',
      outcomes: { values: ['Natus Vincere', 'Team Vitality'] },
    }),
    { teamNames },
  );

  assert.equal(plan.outcomeKind, 'matched');
  assert.equal(plan.link.outcomeAIndex, 0);
  assert.equal(plan.recomputable, false);
  assert.equal(plan.link.confidence, 0.7);
});

test('o caso da amostra: map-handicap invertido em relação aos irmãos', () => {
  // `cs2-navi-vit-2026-05-03-map-handicap-home-2pt5` tem `outcomes.values` em
  // ordem inversa à dos irmãos da mesma partida. É o motivo de
  // `outcome_a_index` ser resolvido POR MARKET e não uma vez por partida:
  // gravar o índice da série valeria o oposto do certo justamente aqui.
  const teamNames = new Map([
    ['cs2|navi', 'Natus Vincere'],
    ['cs2|vit', 'Team Vitality'],
  ]);

  const serie = plannedOf(
    event({
      event_metadata: null,
      slug: 'cs2-navi-vit-2026-05-03',
      outcomes: { values: ['Natus Vincere', 'Team Vitality'] },
    }),
    { teamNames },
  );

  const handicap = plannedOf(
    event({
      event_metadata: null,
      slug: 'cs2-navi-vit-2026-05-03-map-handicap-home-2pt5',
      outcomes: { values: ['Team Vitality', 'Natus Vincere'] },
    }),
    { teamNames },
  );

  assert.equal(serie.match.matchSlug, handicap.match.matchSlug);
  assert.equal(serie.link.outcomeAIndex, 0);
  assert.equal(handicap.link.outcomeAIndex, 1);
  assert.equal(handicap.link.needsReview, false);
});

test('mercado derivado sem lado de time tem índice null, e isso não é pendência', () => {
  const plan = plannedOf(
    event({
      slug: 'cs2-ntr-btf-2026-08-06-total-games-2pt5',
      outcomes: { values: ['Over', 'Under'] },
      sports_market_type: 'totals',
    }),
  );

  assert.equal(plan.outcomeKind, 'no_team_side');
  assert.equal(plan.link.outcomeAIndex, null);
  assert.equal(plan.link.needsReview, false);
  assert.equal(plan.recomputable, false);
  assert.equal(plan.link.confidence, 1.0);
});

test('odd/even também é vocabulário sem lado de time', () => {
  const plan = plannedOf(
    event({
      slug: 'cs2-ntr-btf-2026-08-06-game1-odd-even-total-rounds',
      outcomes: { values: ['Odd', 'Even'] },
      sports_market_type: 'odd_even_rounds',
    }),
  );

  assert.equal(plan.outcomeKind, 'no_team_side');
  assert.equal(plan.link.needsReview, false);
});

// ---------------------------------------------------------------------------
// Estado C — papel do mercado
// ---------------------------------------------------------------------------

test('sports_market_type presente é autoritativo e mantém a confiança cheia', () => {
  const plan = plannedOf(event({ sports_market_type: 'child_moneyline' }));
  assert.equal(plan.roleSource, 'column');
  assert.equal(plan.link.marketRole, 'child_moneyline');
  assert.equal(plan.link.confidence, 1.0);
  assert.equal(plan.link.needsReview, false);
});

test('C: papel inferido do sufixo rebaixa a confiança e NÃO gera fila', () => {
  const plan = plannedOf(event({ sports_market_type: null, slug: 'cs2-ntr-btf-2026-08-06-game2' }));

  assert.equal(plan.roleSource, 'guess');
  assert.equal(plan.link.marketRole, 'child_moneyline');
  assert.equal(plan.link.confidence, 0.7);
  assert.equal(plan.link.needsReview, false);
  assert.match(plan.notes.join(' '), /papel inferido/);
});

test('C: papel desconhecido vira nota de família, não pendência de linha', () => {
  // Uma regra nova resolve milhares de markets; milhares de confirmações no
  // Telegram não resolvem nenhum.
  const plan = plannedOf(
    event({ sports_market_type: null, slug: 'cs2-ntr-btf-2026-08-06-pistol-round-winner' }),
  );

  assert.equal(plan.roleSource, 'unknown');
  assert.equal(plan.link.marketRole, 'unknown');
  assert.equal(plan.link.confidence, 0.3);
  assert.equal(plan.link.needsReview, false);
  assert.match(plan.notes.join(' '), /família: pistol-round-winner/);
});

test('C: o mapa aprendido cobre o que o estático não conhece', () => {
  // `gameN-odd-even-total-rounds` (1.365 markets) não tem rótulo que a gente
  // conheça — mas os eventos recentes com a coluna preenchida têm, e é de lá
  // que ele vem. Vocabulário medido, não inventado.
  const learnedRoles = { 'game1-odd-even-total-rounds': 'odd_even_rounds_game_1' };

  const plan = plannedOf(
    event({
      sports_market_type: null,
      slug: 'cs2-ntr-btf-2026-08-06-game1-odd-even-total-rounds',
    }),
    { learnedRoles },
  );

  assert.equal(plan.roleSource, 'learned');
  assert.equal(plan.link.marketRole, 'odd_even_rounds_game_1');
  assert.equal(plan.link.confidence, 0.7);
  assert.equal(plan.link.needsReview, false);
});

test('C: o mapa estático tem precedência sobre o aprendido', () => {
  // O estático distingue o número do game na forma canônica do Polymarket; o
  // aprendido é rede para o que ele não conhece, não substituto.
  const plan = plannedOf(
    event({ sports_market_type: null, slug: 'cs2-ntr-btf-2026-08-06-game2-round-total-24pt5' }),
    { learnedRoles: { 'game2-round-total-X': 'qualquer_outra_coisa' } },
  );

  assert.equal(plan.roleSource, 'guess');
  assert.equal(plan.link.marketRole, 'round_over_under_game_2');
});

// ---------------------------------------------------------------------------
// outcome_a_index — mecânica
// ---------------------------------------------------------------------------

test('outcomeSideIndex: o lado B identifica o A por exclusão só no binário', () => {
  assert.deepEqual(outcomeSideIndex(['G2 Esports', 'Team Liquid'], ['tl'], ['g2'], 'token'), {
    kind: 'matched',
    index: 1,
  });

  assert.equal(
    outcomeSideIndex(['G2 Esports', 'Alguém', 'Outro'], ['tl'], ['g2'], 'token').kind,
    'unmatched',
  );
});

test('outcomeSideIndex por token não casa código dentro de palavra maior', () => {
  assert.equal(
    outcomeSideIndex(['Cognitive', 'Alguém'], ['og'], ['xx'], 'token').kind,
    'unmatched',
  );
  assert.equal(outcomeSideIndex(['OG Esports', 'Alguém'], ['og'], ['xx'], 'token').index, 0);
});

test('outcomeSideIndex: casar nos dois lados é ambiguidade, não índice', () => {
  const result = outcomeSideIndex(['G2 Esports', 'G2 Academy'], ['g2'], ['t1'], 'token');
  assert.equal(result.kind, 'ambiguous');
  assert.equal(result.index, null);
});

// ---------------------------------------------------------------------------
// best_of
// ---------------------------------------------------------------------------

test('bestOfFromScore lê o BoN do placar', () => {
  assert.equal(bestOfFromScore('0-0|1-2|Bo3'), 3);
  assert.equal(bestOfFromScore('2-1|Bo5'), 5);
  assert.equal(bestOfFromScore('BO1'), 1);
  assert.equal(bestOfFromScore(null), null);
  assert.equal(bestOfFromScore(''), null);
  assert.equal(bestOfFromScore('0-0|1-2'), null);
  assert.equal(bestOfFromScore(42), null);
});

test('best_of fica null porque `score` não é gravado em event_metadata', () => {
  const plan = plannedOf(event());
  assert.equal(plan.match.bestOf, null);

  const comScore = plannedOf(event({ event_metadata: metadata({ score: '1-0|Bo3' }) }));
  assert.equal(comScore.match.bestOf, 3);
});

// ---------------------------------------------------------------------------
// Recusas
// ---------------------------------------------------------------------------

test('recusas: não-esports, slug malformado e vertical desligada são distintos', () => {
  const cases: Array<[Partial<ResolvableEvent>, string]> = [
    [{ slug: 'bitcoin-up-or-down-july-8' }, 'not_esports'],
    [{ slug: null }, 'not_esports'],
    [{ slug: 'cs2-ntr-2026-08-06' }, 'malformed_slug'],
    [{ slug: 'dota2-aur1-lgd-2026-06-06' }, 'vertical_disabled'],
  ];

  for (const [overrides, reason] of cases) {
    const result = planEvent(event(overrides), VERTICALS);
    assert.equal(result.ok, false, JSON.stringify(overrides));
    assert.equal(result.ok === false && result.reason, reason);
  }
});

// ---------------------------------------------------------------------------
// Robustez do jsonb
// ---------------------------------------------------------------------------

test('metadado com tipos inesperados não derruba o plano', () => {
  const plan = plannedOf(
    event({
      event_metadata: metadata({
        league: 42,
        leagueTier: 3,
        tournament: null,
        serie: { nested: true },
        pandascoreMatchId: '1582194',
        polymarket_sport: 'cs2',
      }),
    }),
  );

  assert.equal(plan.match.league, '42');
  assert.equal(plan.match.leagueTier, '3');
  assert.equal(plan.match.stage, null);
  assert.equal(plan.match.serie, '');
  assert.equal(plan.match.externalIds['pandascore_match_id'], 1582194);
});

test('outcomes ausente ou malformado vira unmatched, nunca índice inventado', () => {
  assert.equal(plannedOf(event({ outcomes: null })).link.outcomeAIndex, null);
  assert.equal(plannedOf(event({ outcomes: {} })).outcomeKind, 'unmatched');
  assert.equal(plannedOf(event({ outcomes: { values: 'nope' } })).outcomeKind, 'unmatched');
});

// ---------------------------------------------------------------------------
// Instrumentação
// ---------------------------------------------------------------------------

test('a mesma partida tocada em várias páginas conta uma vez', () => {
  // A regressão que motivou trocar contador por conjunto: a deduplicação de
  // escrita é POR PÁGINA, e uma partida com 8 markets é reenviada em cada
  // página que contenha um deles. Somar as operações reportou 4.139 partidas
  // onde existiam 2.557 — sem perda nenhuma, só contabilidade errada.
  const stats = emptyStats();

  for (let pagina = 0; pagina < 8; pagina++) {
    stats.written.matches.add('cs2-navi-vit-2026-05-03');
    stats.written.teams.add('cs2|navi');
    stats.written.teams.add('cs2|vit');
    stats.written.links.add(`evt-${pagina}`);
  }

  const counts = writtenCounts(stats.written);
  assert.equal(counts.matches, 1);
  assert.equal(counts.teams, 2);
  // Links são um por market, e esses SÃO distintos entre si.
  assert.equal(counts.links, 8);
});

test('linhas perdidas ficam fora da contagem de distintas', () => {
  // As chaves são as ENVIADAS. Só com `writeFailedRows` em zero elas equivalem
  // ao que está no banco — por isso os dois números andam juntos no relatório.
  const stats = emptyStats();
  assert.equal(stats.writeFailedRows, 0);
  assert.deepEqual(writtenCounts(stats.written), {
    teams: 0,
    leagues: 0,
    tournaments: 0,
    matches: 0,
    links: 0,
  });
});

test('combinedCounts soma os dois caminhos sem perder a quebra', () => {
  const stats = emptyStats();
  stats.byPath.eventTeams.resolved = 446;
  stats.byPath.eventTeams.outcome.matched = 446;
  stats.byPath.slugParse.resolved = 21169;
  stats.byPath.slugParse.outcome.unmatched = 9824;

  const all = combinedCounts(stats);
  assert.equal(all.resolved, 21615);
  assert.equal(all.outcome.matched, 446);
  assert.equal(all.outcome.unmatched, 9824);
  // A quebra original continua intacta — é ela que separa anomalia de esperado.
  assert.equal(stats.byPath.eventTeams.outcome.unmatched, 0);
});

test('prefixo declarado sai do aviso e continua contado', () => {
  // O estado de hoje: `lol-` e `dota2-` coletados de propósito, `cs2-` é o
  // único domínio analisado. Nada aqui é anomalia, e nada aqui pode virar aviso.
  const verticais = [
    { verticalId: 'cs2', slugPrefix: 'cs2-', enabled: true },
    { verticalId: 'lol', slugPrefix: 'lol-', enabled: false },
    { verticalId: 'dota2', slugPrefix: 'dota2-', enabled: false },
  ];

  const split = classifyDiscoveryPrefixes(['cs2-', 'lol-', 'dota2-'], verticais, [
    'lol-',
    'dota2-',
  ]);

  assert.deepEqual(split.uncovered, []);
  // Continuam visíveis: é neles que a contagem de órfãos é feita.
  assert.deepEqual(split.collectOnly, ['lol-', 'dota2-']);
});

test('prefixo esquecido continua virando aviso', () => {
  // O bug que a detecção pegou, na forma que ela precisa continuar pegando:
  // alguém acrescenta o prefixo à descoberta e não habilita nem declara.
  const split = classifyDiscoveryPrefixes(
    ['cs2-', 'lol-', 'valorant-'],
    [
      { verticalId: 'cs2', slugPrefix: 'cs2-', enabled: true },
      { verticalId: 'lol', slugPrefix: 'lol-', enabled: false },
    ],
    ['lol-'],
  );

  assert.deepEqual(split.uncovered, ['valorant-']);
  assert.deepEqual(split.collectOnly, ['lol-']);
});

test('vertical habilitada nunca é órfã, mesmo com declaração obsoleta', () => {
  // Habilitar a vertical não obriga a limpar `collect_only_prefixes`: a
  // declaração fica sem efeito, e não pode fazer o prefixo sumir da contagem
  // como se ainda fosse coleta cega.
  const split = classifyDiscoveryPrefixes(
    ['cs2-', 'lol-'],
    [
      { verticalId: 'cs2', slugPrefix: 'cs2-', enabled: true },
      { verticalId: 'lol', slugPrefix: 'lol-', enabled: true },
    ],
    ['lol-', 'dota2-'],
  );

  assert.deepEqual(split.uncovered, []);
  assert.deepEqual(split.collectOnly, []);
});

test('sem nenhuma vertical habilitada, todo prefixo coletado é órfão', () => {
  // O caso em que o varredor não tem universo nenhum para varrer. Ele sai cedo,
  // mas não antes de classificar — sair antes produziria um ciclo mudo com a
  // descoberta rodando contra ninguém.
  const split = classifyDiscoveryPrefixes(
    ['cs2-', 'lol-'],
    [
      { verticalId: 'cs2', slugPrefix: 'cs2-', enabled: false },
      { verticalId: 'lol', slugPrefix: 'lol-', enabled: false },
    ],
    ['lol-'],
  );

  assert.deepEqual(split.uncovered, ['cs2-']);
  assert.deepEqual(split.collectOnly, ['lol-']);
});
