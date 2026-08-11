import { test } from 'node:test';
import assert from 'node:assert/strict';

// O módulo importa o cliente do Supabase por transitividade. Criar o cliente não
// abre conexão — nenhum teste aqui toca banco ou rede: tudo abaixo é função
// pura, que é como as decisões deste enricher foram escritas de propósito.
process.env['SUPABASE_URL'] ??= 'http://localhost:54321';
process.env['SUPABASE_SERVICE_KEY'] ??= 'test-key';

const {
  sideByOutcomeOrder,
  DEFAULT_MARKET_ID,
  priceFormatOf,
  toProbability,
  fairPair,
  median,
  sideOf,
  lineAtAsOf,
  suspensionBlocks,
  blocksCoincide,
  coincidentBookmakers,
  buildBookLines,
  coverageOf,
  consensusOf,
  buildOddsSummary,
  buildSuspensionSummary,
  matchFixture,
  readCachedFixture,
  mergeFixtureIds,
  discoveryWindow,
  DISCOVERY_BLOCK_DAYS,
  DISCOVERY_PAD_DAYS,
  safeBookmakers,
  normalize,
  CONSENSUS_MAX_STALE_SECONDS,
  callFitsBudget,
  CALL_HEADROOM_MS,
  sideMatchTier,
  canonicalTeamName,
  distinguishingOf,
} = await import('./oddspapi.js');
const { oddspapiEnricher } = await import('./oddspapi.js');
const { waitMsFor, cooldownOf, resetOddsPapiState } = await import('../../lib/oddspapi-api.js');

type OddsEntry = Parameters<typeof lineAtAsOf>[0][number];

const ASOF = new Date('2026-07-10T18:00:00.000Z');

function at(minutesBefore: number): string {
  return new Date(ASOF.getTime() - minutesBefore * 60_000).toISOString();
}

function entry(over: Partial<OddsEntry> = {}): OddsEntry {
  return {
    createdAt: at(10),
    price: 1.8,
    limit: null,
    active: true,
    outcome: 'Natus Vincere',
    path: 'bookmakers.pinnacle.markets.0.outcomes.0.odds.0',
    ...over,
  };
}

// ---------------------------------------------------------------------------
// Formato de preço — a inversão que não tem como ser detectada depois
// ---------------------------------------------------------------------------

test('odd decimal e probabilidade são separadas por >1, não por palpite', () => {
  // É a única forma de este enricher produzir um número catastroficamente errado
  // com cara de certo: 1/0,55 = 1,82 é odd plausível, 1/1,82 = 0,55 é
  // probabilidade plausível, e nada no valor denuncia a troca.
  assert.equal(priceFormatOf([1.8, 2.05, 3.4]), 'decimal');
  assert.equal(priceFormatOf([0.55, 0.45]), 'probability');

  // Misturado é anomalia da fonte. Converter seria escolher uma das duas.
  assert.equal(priceFormatOf([1.8, 0.45]), 'unknown');
  assert.equal(priceFormatOf([]), 'unknown');

  assert.equal(toProbability(2, 'decimal'), 0.5);
  assert.equal(toProbability(0.5, 'probability'), 0.5);
  assert.equal(toProbability(2, 'unknown'), null);
  assert.equal(toProbability(0, 'decimal'), null);
});

test('a margem da casa sai antes de comparar com o Polymarket', () => {
  // 1/1,8 + 1/2,2 = 0,5555 + 0,4545 = 1,0101. O excesso é o lucro embutido, e
  // comparar o cru com um preço de mercado compararia duas coisas diferentes.
  const fair = fairPair(1 / 1.8, 1 / 2.2);
  assert.ok(fair !== null);
  assert.ok(Math.abs(fair.fairA + fair.fairB - 1) < 1e-9);
  assert.ok(Math.abs(fair.overround - 0.0101) < 0.001);
});

test('um lado só não vira probabilidade justa', () => {
  // Com metade da informação não há como saber quanto é margem. Um "justo"
  // inventado a partir disso seria pior que nenhum.
  assert.equal(fairPair(1 / 1.8, null), null);
  assert.equal(fairPair(null, 1 / 2.2), null);
});

test('median cobre par, ímpar e vazio', () => {
  assert.equal(median([0.4, 0.5, 0.6]), 0.5);
  assert.equal(median([0.4, 0.6]), 0.5);
  assert.equal(median([]), null);
});

// ---------------------------------------------------------------------------
// Lado — a queda por posição que NÃO existe
// ---------------------------------------------------------------------------

test('o lado sai do nome, e sem nome não há lado', () => {
  const a = ['Natus Vincere', 'NAVI', 'navi'];
  const b = ['Team Spirit', 'Spirit', 'ts'];

  assert.equal(sideOf('Natus Vincere', a, b), 'a');
  assert.equal(sideOf('navi', a, b), 'a');
  assert.equal(sideOf('Spirit', a, b), 'b');

  // Normalização: caixa, acento e pontuação não mudam identidade.
  assert.equal(sideOf('NATUS  VINCERE', a, b), 'a');
  assert.equal(normalize('Natus Vincere'), normalize('natus-vincere'));

  // Sem casar, não inventa: a alternativa seria posição no array, e o resolver
  // já mediu que a ordem dos outcomes NÃO é estável (19 de 79 eventos com
  // markets irmãos em ordens diferentes). Espelhar o mercado é o pior erro
  // possível aqui.
  assert.equal(sideOf('Outro Time', a, b), null);
  assert.equal(sideOf(null, a, b), null);

  // Apelido reivindicado pelos dois lados é config errada, não lado.
  assert.equal(sideOf('x', ['x'], ['x']), null);
});

// ---------------------------------------------------------------------------
// A linha no instante do asOf
// ---------------------------------------------------------------------------

test('a linha é a última ANTES do asOf, nunca a última', () => {
  // Em produção asOf é agora e os dois coincidem. A diferença aparece no dia em
  // que a flag de point-in-time virar — e é aqui que ela precisa já estar certa.
  const line = lineAtAsOf(
    [
      entry({ createdAt: at(60), price: 1.7 }),
      entry({ createdAt: at(5), price: 1.9 }),
      entry({ createdAt: at(-30), price: 2.5 }), // depois do asOf
    ],
    ASOF,
  );

  assert.equal(line?.price, 1.9);
  assert.equal(line?.staleSeconds, 300);
  assert.equal(line?.priceStaleSeconds, 300);
});

test('entrada sem carimbo é descartada, não tratada como agora', () => {
  // Sem `createdAt` não há como afirmar que ela existia no instante pedido.
  assert.equal(lineAtAsOf([entry({ createdAt: null, price: 9 })], ASOF), null);
});

test('suspensão é o ESTADO; o preço vem da última cotação ativa', () => {
  // MEDIDO no snapshot real: em 64 dos 75 instantes com active=false a Pinnacle
  // TROCA os preços dos dois outcomes em relação ao último par ativo (a Stake,
  // 0 de 16). Ler o preço da linha suspensa produziria o mercado ESPELHADO
  // quando o asOf cai dentro de uma suspensão — sem sintoma nenhum, porque uma
  // probabilidade invertida é plausível.
  //
  // Então: estado do último registro, preço da última entrada ativa. Não é
  // filtrar o false — ele continua no fragmento e nos blocos.
  const line = lineAtAsOf(
    [
      entry({ createdAt: at(20), price: 1.336, limit: 800 }),
      entry({ createdAt: at(2), price: 3.1, active: false, limit: 800 }),
    ],
    ASOF,
  );

  assert.equal(line?.active, false, 'a suspensão continua visível');
  assert.equal(line?.staleSeconds, 120);
  assert.equal(line?.price, 1.336, 'o preço NÃO é o da linha suspensa');
  assert.equal(line?.priceStaleSeconds, 1200);
});

test('active ausente conta como cotação — só o false explícito é recusado', () => {
  // O espelhamento medido é do `false`. Casa que simplesmente não reporta estado
  // continua sendo lida, senão a fonte inteira sumiria por um campo ausente.
  const line = lineAtAsOf([entry({ createdAt: at(5), price: 2.4, active: null })], ASOF);
  assert.equal(line?.price, 2.4);
  assert.equal(line?.priceStaleSeconds, 300);
});

test('casa que só emite linha suspensa não tem preço, e diz isso', () => {
  const line = lineAtAsOf([entry({ createdAt: at(5), price: 3.1, active: false })], ASOF);
  assert.equal(line?.active, false);
  assert.equal(line?.price, null);
  assert.equal(line?.priceStaleSeconds, null);
});

// ---------------------------------------------------------------------------
// Suspensão
// ---------------------------------------------------------------------------

test('blocos de false saem por série, e o preço dos dois lados vem junto', () => {
  const serieA = 'bookmakers.pinnacle.markets.0.outcomes.0.odds';
  const blocks = suspensionBlocks(
    'pinnacle',
    [
      entry({ createdAt: at(60), price: 1.8, path: `${serieA}.0` }),
      entry({ createdAt: at(50), price: 1.8, active: false, path: `${serieA}.1` }),
      entry({ createdAt: at(45), price: 1.8, active: false, path: `${serieA}.2` }),
      entry({ createdAt: at(40), price: 2.05, path: `${serieA}.3` }),
    ],
    ASOF,
  );

  assert.equal(blocks.length, 1);
  assert.equal(blocks[0]?.entries, 2);
  assert.equal(blocks[0]?.enclosed, true);
  assert.equal(blocks[0]?.priceChanged, true);
});

test('séries distintas da mesma casa não são concatenadas', () => {
  // Sem separar por série, as entradas de outcomes diferentes viram uma
  // sequência só e a "alternância" medida é o intercalamento das duas —
  // comportamento da coleta, não da casa.
  const blocks = suspensionBlocks(
    'pinnacle',
    [
      entry({ createdAt: at(60), path: 'b.markets.0.outcomes.0.odds.0' }),
      entry({ createdAt: at(55), active: false, path: 'b.markets.0.outcomes.1.odds.0' }),
      entry({ createdAt: at(50), path: 'b.markets.0.outcomes.0.odds.1' }),
    ],
    ASOF,
  );

  // Um bloco, na série do outcome 1, e ele NÃO é fechado: naquela série não há
  // entrada ativa depois. Concatenar teria produzido um bloco fechado falso.
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0]?.enclosed, false);
});

test('active null é pulado — ausência de campo não é suspensão', () => {
  const blocks = suspensionBlocks(
    'stake',
    [entry({ active: null }), entry({ createdAt: at(5), active: null })],
    ASOF,
  );

  assert.deepEqual(blocks, []);
});

test('coincidência entre casas é registrada, não interpretada', () => {
  // Medido: ~50% dos blocos da Stake coincidem com outra casa, e os dados NÃO
  // separam evento real da partida de falha de feed do agregador. O enricher
  // registra e deixa a leitura para o agente.
  const serie = (book: string): string => `bookmakers.${book}.markets.0.outcomes.0.odds`;

  const pinnacle = suspensionBlocks(
    'pinnacle',
    [
      entry({ createdAt: at(60), path: `${serie('pinnacle')}.0` }),
      entry({ createdAt: at(50), active: false, path: `${serie('pinnacle')}.1` }),
      entry({ createdAt: at(45), price: 2.1, path: `${serie('pinnacle')}.2` }),
    ],
    ASOF,
  );
  const stake = suspensionBlocks(
    'stake',
    [
      entry({ createdAt: at(60), path: `${serie('stake')}.0` }),
      entry({ createdAt: at(49), active: false, path: `${serie('stake')}.1` }),
      entry({ createdAt: at(44), path: `${serie('stake')}.2` }),
    ],
    ASOF,
  );

  const all = [...pinnacle, ...stake];
  assert.ok(blocksCoincide(pinnacle[0] as never, stake[0] as never));
  assert.deepEqual(coincidentBookmakers(pinnacle[0] as never, all), ['stake']);
  // Um bloco nunca coincide consigo mesmo nem com outro da própria casa.
  assert.deepEqual(coincidentBookmakers(stake[0] as never, stake), []);
});

// ---------------------------------------------------------------------------
// A montagem, com a densidade desigual que foi medida
// ---------------------------------------------------------------------------

const ALIAS_A = ['Natus Vincere', 'NAVI'];
const ALIAS_B = ['Team Spirit', 'Spirit'];

// A forma REAL, confirmada no snapshot da sonda:
// bookmakers.{casa}.markets.{id}.outcomes.{id}.players.{id}[]
function path(slug: string, outcome: string, i = 0): string {
  return `bookmakers.${slug}.markets.171.outcomes.${outcome}.players.0.${i}`;
}

function book(slug: string, priceA: number, priceB: number, over: Partial<OddsEntry> = {}) {
  return [
    entry({ outcome: null, price: priceA, path: path(slug, '171'), ...over }),
    entry({ outcome: null, price: priceB, path: path(slug, '172'), ...over }),
  ];
}

const SIDES = { aliasesA: ALIAS_A, aliasesB: ALIAS_B, sideAIndex: 1 as const, marketId: '171' };

test('a densidade desigual medida vira coverage, não erro', () => {
  // Pinnacle densa e com limit, Stake rala e sem limit, bet365 ausente apesar de
  // entitulada. Nenhuma dessas três coisas é defeito, e o fragmento tem que
  // dizer isso — quem lê não pode tomar ausência por sinal.
  const perBook = new Map<string, OddsEntry[]>([
    ['pinnacle', book('pinnacle', 1.8, 2.2, { limit: 500 })],
    ['stake', book('stake', 1.85, 2.1)],
    ['bet365', []],
  ]);

  const { lines, format } = buildBookLines(perBook, SIDES, ASOF);
  assert.equal(format, 'decimal');

  const coverage = coverageOf(['pinnacle', 'stake', 'bet365'], lines);
  assert.deepEqual(coverage.absent, ['bet365']);
  assert.deepEqual(coverage.withLimit, ['pinnacle']);
  assert.deepEqual(coverage.unmatched, []);

  const consensus = consensusOf(lines);
  assert.equal(consensus.books, 2);
  assert.ok((consensus.fairA ?? 0) > 0.5 && (consensus.fairA ?? 1) < 0.56);

  const summary = buildOddsSummary(
    'Natus Vincere',
    'Team Spirit',
    lines,
    consensus,
    coverage,
    format,
  );
  assert.match(summary, /consenso \(mediana de 2\)/);
  assert.match(summary, /ausência é normal/);
  assert.match(summary, /Stake máximo reportado só por: pinnacle/);
});

test('casa parada há mais de uma hora sai do consenso e fica no payload', () => {
  // Casa que não move há horas não está discordando do Polymarket — está
  // desligada. Somá-la puxaria a mediana para um preço que ninguém oferece.
  const stale = CONSENSUS_MAX_STALE_SECONDS / 60 + 30;
  const perBook = new Map<string, OddsEntry[]>([
    ['pinnacle', book('pinnacle', 1.8, 2.2)],
    ['stake', book('stake', 1.4, 3.5, { createdAt: at(stale) })],
  ]);

  const { lines } = buildBookLines(perBook, SIDES, ASOF);
  const consensus = consensusOf(lines);

  assert.equal(consensus.books, 1);
  const excluded = lines.find((l) => l.bookmaker === 'stake');
  assert.equal(excluded?.inConsensus, false);
  assert.match(excluded?.excludedBecause ?? '', /parada/);
  // Continua no payload com o preço: ausência de atualização é dado.
  assert.equal(excluded?.a?.price, 1.4);
});

test('casa sem lado identificável não entra no consenso nem some do relatório', () => {
  // Outcomes NÃO consecutivos: a guarda de `sideByOutcomeOrder` recusa, e a casa
  // fica sem lado em vez de receber um lado inventado.
  const perBook = new Map<string, OddsEntry[]>([
    ['pinnacle', book('pinnacle', 1.8, 2.2)],
    [
      'ggbet',
      [
        entry({ outcome: null, price: 1.9, path: path('ggbet', '171') }),
        entry({ outcome: null, price: 2.0, path: path('ggbet', '999') }),
      ],
    ],
  ]);

  const { lines } = buildBookLines(perBook, SIDES, ASOF);
  const coverage = coverageOf(['pinnacle', 'ggbet'], lines);

  assert.deepEqual(coverage.unmatched, ['ggbet']);
  assert.equal(consensusOf(lines).books, 1);
});

test('sem casa comparável o summary diz isso, e diz que é normal', () => {
  const perBook = new Map<string, OddsEntry[]>([['bet365', []]]);
  const { lines, format } = buildBookLines(perBook, SIDES, ASOF);
  const coverage = coverageOf(['bet365'], lines);

  const summary = buildOddsSummary('A', 'B', lines, consensusOf(lines), coverage, format);
  assert.match(summary, /Nenhuma casa cotou/);
  assert.match(summary, /normal nesta fonte e não é sinal/);
});

test('o summary declara a janela coberta — 19h é o dia da partida, não a abertura', () => {
  const perBook = new Map<string, OddsEntry[]>([
    [
      'pinnacle',
      [
        entry({
          outcome: null,
          price: 1.7,
          createdAt: at(19 * 60),
          path: path('pinnacle', '171', 0),
        }),
        entry({ outcome: null, price: 1.8, createdAt: at(3), path: path('pinnacle', '171', 1) }),
        entry({ outcome: null, price: 2.2, createdAt: at(3), path: path('pinnacle', '172', 0) }),
      ],
    ],
  ]);

  const { lines, format } = buildBookLines(perBook, SIDES, ASOF);
  const summary = buildOddsSummary(
    'A',
    'B',
    lines,
    consensusOf(lines),
    coverageOf(['pinnacle'], lines),
    format,
  );

  assert.match(summary, /~19h/);
  assert.match(summary, /não linha de abertura/);
});

test('o summary de suspensão carrega a ambiguidade em vez de resolvê-la', () => {
  const blocks = [
    {
      bookmaker: 'pinnacle',
      series: 's1',
      startAt: at(50),
      endAt: at(48),
      entries: 2,
      enclosed: true,
      priceBefore: 1.8,
      priceAfter: 2.05,
      priceChanged: true,
    },
    {
      bookmaker: 'stake',
      series: 's2',
      startAt: at(49),
      endAt: at(47),
      entries: 1,
      enclosed: true,
      priceBefore: 1.85,
      priceAfter: 1.85,
      priceChanged: false,
    },
  ];

  const summary = buildSuspensionSummary('A', 'B', blocks, ['pinnacle']);

  assert.match(summary, /2 bloco\(s\)/);
  assert.match(summary, /Suspensa AGORA em: pinnacle/);
  assert.match(summary, /reprecificado/);
  // As duas leituras aparecem, e nenhuma é escolhida.
  assert.match(summary, /evento real da partida/);
  assert.match(summary, /falha do feed/);
});

// ---------------------------------------------------------------------------
// Identidade e orçamento
// ---------------------------------------------------------------------------

test('a fixture exige os DOIS lados, em qualquer ordem', () => {
  const rows = [
    { fixtureId: 'f1', startTime: null, finished: true, hasOdds: true, sides: [['G2'], ['FaZe']] },
    {
      fixtureId: 'f2',
      startTime: null,
      finished: true,
      hasOdds: true,
      sides: [
        ['Team Spirit', 'Spirit'],
        ['Natus Vincere', 'NAVI'],
      ],
    },
  ];

  const link = matchFixture(
    rows,
    { displayName: 'Natus Vincere', polymarketCode: 'navi' },
    { displayName: 'Team Spirit', polymarketCode: 'ts' },
  );
  assert.equal(link?.fixtureId, 'f2');
  // Na f2 o nosso time A é o participant2 deles — e é isso que orienta o lado
  // quando a resposta de odds não traz nome nenhum.
  assert.equal(link?.sideAIndex, 2);
  // Os apelidos gravados são os do lado CERTO, não os da ordem deles.
  assert.deepEqual(link?.aliasesA, ['Natus Vincere', 'NAVI']);
  assert.deepEqual(link?.aliasesB, ['Team Spirit', 'Spirit']);

  // Um lado só casaria com qualquer partida do time no dia — e a fixture errada
  // produziria a linha de outra partida com cara de certa.
  assert.equal(
    matchFixture(
      rows,
      { displayName: 'Natus Vincere', polymarketCode: 'navi' },
      { displayName: 'Outro Time Qualquer', polymarketCode: 'otq' },
    ),
    null,
  );
});

test('o cache negativo é o que protege o orçamento mensal', () => {
  const now = new Date('2026-07-10T18:00:00.000Z');
  const recent = new Date(now.getTime() - 3_600_000).toISOString();
  const old = new Date(now.getTime() - 48 * 3_600_000).toISOString();

  assert.equal(readCachedFixture({ oddspapi_missing_at: recent }, now).kind, 'missing');
  // Passadas 24h, procura de novo: a OddsPapi pode ter passado a cobrir.
  assert.equal(readCachedFixture({ oddspapi_missing_at: old }, now).kind, 'unknown');
  assert.equal(readCachedFixture(null, now).kind, 'unknown');

  const cached = readCachedFixture(
    {
      oddspapi_fixture_id: 'f9',
      oddspapi_aliases_a: ['A'],
      oddspapi_aliases_b: ['B'],
      oddspapi_side_a_index: 2,
    },
    now,
  );
  assert.equal(cached.kind, 'fixture');
  assert.equal(cached.kind === 'fixture' ? cached.link.sideAIndex : null, 2);

  // Cache SEM `oddspapi_side_a_index` não é utilizável: sem ele a ordem dos
  // outcomes não vira lado, e o fragmento sairia sem probabilidade. Vale também
  // para o cache gravado por uma versão anterior — ele simplesmente é
  // reaprendido, ao custo de uma janela billable.
  assert.equal(
    readCachedFixture(
      { oddspapi_fixture_id: 'f9', oddspapi_aliases_a: ['A'], oddspapi_aliases_b: ['B'] },
      now,
    ).kind,
    'unknown',
  );
  assert.equal(readCachedFixture({ oddspapi_fixture_id: 'f9' }, now).kind, 'unknown');
});

// ---------------------------------------------------------------------------
// Só a rede sustenta conclusão sobre ausência
// ---------------------------------------------------------------------------

test('ausência apurada em lista de CACHE não vira carimbo de 24h', () => {
  // A interação entre os dois caches, que é o defeito que o TTL de 6h criaria:
  // lista em cache com 5h + fixture cadastrada nesse meio-tempo = partida não
  // encontrada, carimbada por 24h. Atraso de 6h deles vira 30h de silêncio
  // nosso — e o carimbo estaria registrando como FATO SOBRE A PARTIDA o que foi
  // só uma lista desatualizada.
  const now = new Date('2026-08-11T12:00:00.000Z');
  const current = { polymarket_slug: 'navi-vs-spirit' };

  const merged = mergeFixtureIds(current, { kind: 'absent', source: 'cache' }, now);

  assert.equal(merged, null, 'resposta de cache não sustenta conclusão sobre ausência');

  // E o efeito que importa: sem carimbo, a partida continua `unknown` e é
  // reavaliada no ciclo seguinte — que também será cache hit, e portanto não
  // gasta billable nenhum até a lista renovar.
  assert.equal(readCachedFixture(current, now).kind, 'unknown');
});

test('ausência apurada na REDE vira carimbo de 24h', () => {
  // O cache negativo continua existindo e continua protegendo o orçamento: o
  // CS2 de tier baixo não interessa a casa nenhuma, e sem carimbo essas partidas
  // custariam uma janela billable por ciclo, para sempre.
  const now = new Date('2026-08-11T12:00:00.000Z');

  const merged = mergeFixtureIds(
    { polymarket_slug: 'navi-vs-spirit' },
    { kind: 'absent', source: 'network' },
    now,
  );

  assert.notEqual(merged, null);
  assert.equal(merged?.['oddspapi_missing_at'], now.toISOString());
  assert.equal(merged?.['polymarket_slug'], 'navi-vs-spirit', 'o merge preserva o que já havia');
  assert.equal(readCachedFixture(merged, now).kind, 'missing');

  // Dezenove horas depois ainda cala; passadas as 24h, procura de novo.
  const dezenove = new Date(now.getTime() + 19 * 3_600_000);
  const vinteECinco = new Date(now.getTime() + 25 * 3_600_000);
  assert.equal(readCachedFixture(merged, dezenove).kind, 'missing');
  assert.equal(readCachedFixture(merged, vinteECinco).kind, 'unknown');
});

test('fixture encontrada apaga o carimbo, venha de onde vier a lista', () => {
  const now = new Date('2026-08-11T12:00:00.000Z');

  const merged = mergeFixtureIds(
    { oddspapi_missing_at: '2026-08-10T00:00:00.000Z' },
    {
      kind: 'found',
      link: { fixtureId: 'f7', aliasesA: ['NAVI'], aliasesB: ['Spirit'], sideAIndex: 2, tier: 'canonical' },
    },
    now,
  );

  assert.equal(merged?.['oddspapi_fixture_id'], 'f7');
  assert.equal(merged?.['oddspapi_side_a_index'], 2);
  assert.equal(merged?.['oddspapi_match_tier'], 'canonical');
  assert.equal('oddspapi_missing_at' in (merged ?? {}), false);
  assert.equal(readCachedFixture(merged, now).kind, 'fixture');
});

// ---------------------------------------------------------------------------
// A janela de descoberta — a função com mais consequência do arquivo
// ---------------------------------------------------------------------------

/** Dias entre as duas pontas da janela, que a API exige abaixo de 10. */
function spanDays({ from, to }: { from: string; to: string }): number {
  return (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000;
}

/**
 * A faixa que a API de fato cobre: `[from, to)`.
 *
 * MEDIDO — `to` é exclusivo (ver `DISCOVERY_PAD_DAYS`). Testar com `<=` no fim
 * afirmaria cobertura de um dia que não vem, que é justamente o defeito que
 * passou despercebido enquanto ninguém tinha medido a semântica.
 */
function covers({ from, to }: { from: string; to: string }, day: string): boolean {
  return from <= day && day < to;
}

function dayOf(epochDay: number): string {
  return new Date(epochDay * 86_400_000).toISOString().slice(0, 10);
}

function blockStartOf(date: Date): number {
  return (
    Math.floor(Math.floor(date.getTime() / 86_400_000) / DISCOVERY_BLOCK_DAYS) *
    DISCOVERY_BLOCK_DAYS
  );
}

test('partidas em dias DIFERENTES do mesmo bloco compartilham a janela', () => {
  // A razão de existir da mudança. Com a janela antiga (D-1..D+1) cada dia era
  // uma chave de cache: duas janelas em voo, 8 chamadas/dia contra 4,3
  // disponíveis, e as duas pagando pelo quase mesmo conjunto de fixtures.
  const segunda = discoveryWindow(new Date('2026-08-10T18:00:00.000Z'));
  const terca = discoveryWindow(new Date('2026-08-11T02:00:00.000Z'));
  const quarta = discoveryWindow(new Date('2026-08-12T23:59:59.000Z'));

  assert.deepEqual(segunda, terca);
  assert.deepEqual(segunda, quarta);
});

test('a partida na BORDA do bloco continua dentro da janela, pela folga', () => {
  // A folga existe porque a data da fixture deles pode diferir em um dia da
  // nossa `scheduled_at` (fuso, partida de madrugada UTC). Sem ela a partida da
  // borda não acha a própria fixture — e a perda viraria "não coberta".
  const dentro = new Date('2026-08-11T12:00:00.000Z');
  const janela = discoveryWindow(dentro);

  const inicioBloco = blockStartOf(dentro);
  const primeiroDia = dayOf(inicioBloco);
  const ultimoDia = dayOf(inicioBloco + DISCOVERY_BLOCK_DAYS - 1);

  // As duas pontas do bloco produzem a MESMA janela, e ela cobre as duas datas.
  assert.deepEqual(discoveryWindow(new Date(`${primeiroDia}T00:00:00Z`)), janela);
  assert.deepEqual(discoveryWindow(new Date(`${ultimoDia}T23:59:59Z`)), janela);
  assert.ok(covers(janela, primeiroDia));
  assert.ok(covers(janela, ultimoDia));

  // E a folga é de um dia de cada lado, não zero.
  assert.ok(janela.from < primeiroDia);
  assert.equal(janela.from, dayOf(inicioBloco - DISCOVERY_PAD_DAYS));
});

test('a folga do FIM é consultada de fato — o `to` da API é exclusivo', () => {
  // MEDIDO em 11/08/2026: pedir `2026-08-10..2026-08-12` devolve só 10 e 11, e a
  // janela maior prova que havia 16 fixtures em 12/08. A faixa é `[from, to)`.
  //
  // Enquanto o fim era calculado como se fosse inclusivo, o dia de folga depois
  // do bloco caía fora e a folga só existia no começo — a partida do último dia
  // do bloco, com fixture um dia à frente por fuso, não era encontrada.
  const dentro = new Date('2026-08-11T12:00:00.000Z');
  const janela = discoveryWindow(dentro);
  const inicioBloco = blockStartOf(dentro);

  const diaDeFolgaDoFim = dayOf(inicioBloco + DISCOVERY_BLOCK_DAYS);
  assert.ok(
    covers(janela, diaDeFolgaDoFim),
    `${diaDeFolgaDoFim} deveria estar coberto por [${janela.from}, ${janela.to})`,
  );

  // O `to` é o primeiro dia FORA, e é um a mais que o último coberto.
  assert.equal(janela.to, dayOf(inicioBloco + DISCOVERY_BLOCK_DAYS + DISCOVERY_PAD_DAYS));
  assert.equal(janela.to, dayOf(inicioBloco + 8));
  assert.ok(!covers(janela, janela.to));

  // Nove datas cobertas: `blocoInício - 1` até `blocoInício + 7`.
  assert.equal(spanDays(janela), DISCOVERY_BLOCK_DAYS + 2 * DISCOVERY_PAD_DAYS);
  assert.equal(spanDays(janela), 9);
});

test('blocos vizinhos produzem janelas diferentes', () => {
  const DAY = 86_400_000;
  const agora = new Date('2026-08-11T12:00:00.000Z');
  const anterior = new Date(agora.getTime() - DISCOVERY_BLOCK_DAYS * DAY);
  const seguinte = new Date(agora.getTime() + DISCOVERY_BLOCK_DAYS * DAY);

  assert.notDeepEqual(discoveryWindow(anterior), discoveryWindow(agora));
  assert.notDeepEqual(discoveryWindow(seguinte), discoveryWindow(agora));
  // Blocos vizinhos se tocam pela folga, mas não são a mesma chave de cache.
  assert.ok(discoveryWindow(anterior).from < discoveryWindow(agora).from);
});

test('to − from fica abaixo de 10 dias para toda data — mês, ano e bissexto', () => {
  // O limite é medido, não suposto: acima de 10 a API devolve
  // `INVALID_PARAMETER`, "must be under 10 days apart". Uma janela grande demais
  // não degrada, ela falha inteira.
  const datas = [
    '2026-01-01T00:00:00.000Z',
    '2026-01-31T23:59:59.000Z',
    '2026-02-28T12:00:00.000Z',
    '2024-02-29T12:00:00.000Z', // bissexto
    '2024-12-31T23:59:59.000Z', // virada de ano
    '2025-01-01T00:00:00.000Z',
    '2026-08-11T12:00:00.000Z',
    '2026-12-31T00:00:00.000Z',
    '2027-03-01T00:00:00.000Z',
  ];

  for (const iso of datas) {
    const janela = discoveryWindow(new Date(iso));
    assert.ok(spanDays(janela) < 10, `${iso}: janela de ${spanDays(janela)} dias`);
    assert.ok(covers(janela, iso.slice(0, 10)), `${iso}: fora da própria janela`);
  }

  // E para 400 dias corridos, que cobre todo alinhamento possível do bloco. A
  // cada dia se confere também que a folga do fim entrou — o span de 9 dias só
  // vale se ele continuar abaixo de 10 em toda virada de mês, ano e bissexto.
  const inicio = Date.parse('2026-01-01T06:00:00Z');
  for (let i = 0; i < 400; i += 1) {
    const dia = new Date(inicio + i * 86_400_000);
    const janela = discoveryWindow(dia);
    const bloco = blockStartOf(dia);

    assert.ok(spanDays(janela) < 10, `${dia.toISOString()}: span ${spanDays(janela)}`);
    assert.ok(covers(janela, dia.toISOString().slice(0, 10)));
    assert.ok(covers(janela, dayOf(bloco - DISCOVERY_PAD_DAYS)), 'folga do começo');
    assert.ok(covers(janela, dayOf(bloco + DISCOVERY_BLOCK_DAYS)), 'folga do fim');
  }
});

test('a fronteira do bloco NÃO depende de "hoje"', () => {
  // Se a fronteira andasse com o relógio, toda partida mudaria de janela à
  // meia-noite e o cache de 6h se invalidaria sozinho todo dia — a mudança
  // inteira perderia o efeito sem nada parecer errado.
  const partida = new Date('2026-08-11T12:00:00.000Z');
  const esperada = discoveryWindow(partida);

  const realNow = Date.now;
  try {
    for (const fakeNow of ['2026-08-09T00:00:00Z', '2026-08-14T23:00:00Z', '2027-01-01T00:00:00Z']) {
      Date.now = () => Date.parse(fakeNow);
      assert.deepEqual(discoveryWindow(partida), esperada, `mudou com "hoje" = ${fakeNow}`);
    }
  } finally {
    Date.now = realNow;
  }
});

test('a lista de casas respeita o teto de 3 e descarta slug torto', () => {
  // Descartar e seguir, em vez de levantar: uma entrada torta na config não pode
  // custar o fragmento inteiro.
  assert.deepEqual(safeBookmakers(['pinnacle', 'sta ke', 'ggbet', 'stake', 'bet365']), [
    'pinnacle',
    'ggbet',
    'stake',
  ]);
  assert.deepEqual(safeBookmakers(null), []);
});

// ---------------------------------------------------------------------------
// O contrato
// ---------------------------------------------------------------------------

test('o enricher declara supportsPointInTime = false', () => {
  // Por AUSÊNCIA DE GARANTIA de imutabilidade, não por defeito conhecido — a
  // distinção contra a Liquipedia está no topo do arquivo e na spec 001, Parte D.
  // A medição está pendente e o snapshot já foi gravado.
  assert.equal(oddspapiEnricher.supportsPointInTime, false);
  assert.equal(oddspapiEnricher.id, 'oddspapi');
  // Só as verticais cujo sportId foi medido. LoL e Dota 2 estão anotados como
  // "conferir com /v4/sports", e um sportId errado gasta billable para nada.
  assert.deepEqual(oddspapiEnricher.verticals, ['cs2']);
});

// ---------------------------------------------------------------------------
// A forma real da resposta, confirmada no snapshot da sonda
// ---------------------------------------------------------------------------

test('o lado sai da ORDEM dos ids de outcome, e a guarda recusa o resto', () => {
  // A resposta real não tem nome em nível nenhum (3.589 entradas, todas sem), e
  // os outcomes de um mercado têm ids consecutivos: 171 -> 171,172.
  const comoA1 = sideByOutcomeOrder(['172', '171'], 1);
  assert.equal(comoA1?.get('171'), 'a');
  assert.equal(comoA1?.get('172'), 'b');

  // Nosso time A sendo o participant2 inverte, e é justamente por isso que
  // `sideAIndex` fica gravado no cache junto com os apelidos.
  const comoA2 = sideByOutcomeOrder(['171', '172'], 2);
  assert.equal(comoA2?.get('171'), 'b');
  assert.equal(comoA2?.get('172'), 'a');

  // Guardas: dois outcomes, ids consecutivos. Qualquer outra forma é `null` —
  // sem lado é melhor que lado inventado, porque o erro aqui é o mercado
  // espelhado e ele não tem sintoma.
  assert.equal(sideByOutcomeOrder(['171'], 1), null);
  assert.equal(sideByOutcomeOrder(['171', '172', '173'], 1), null);
  assert.equal(sideByOutcomeOrder(['171', '999'], 1), null);
  assert.equal(sideByOutcomeOrder(['a', 'b'], 1), null);
});

test('lê UM mercado, não os sete que a Pinnacle devolve', () => {
  // Medido: 7 mercados na Pinnacle, 4 na Stake. Misturar produziria uma "linha"
  // que é a última entrada de qualquer mercado — handicap de mapa, total de
  // rounds — comparada com o moneyline do Polymarket. Sem sentido e sem sintoma.
  const perBook = new Map<string, OddsEntry[]>([
    [
      'pinnacle',
      [
        ...book('pinnacle', 1.8, 2.2),
        // Mercado derivado, mais recente: não pode virar a linha.
        entry({
          outcome: null,
          price: 9.9,
          createdAt: at(1),
          path: `bookmakers.pinnacle.markets.1747.outcomes.1747.players.0.0`,
        }),
        entry({
          outcome: null,
          price: 1.05,
          createdAt: at(1),
          path: `bookmakers.pinnacle.markets.1747.outcomes.1748.players.0.0`,
        }),
      ],
    ],
  ]);

  const { lines, sideSource } = buildBookLines(perBook, SIDES, ASOF);
  const line = lines[0];

  assert.equal(line?.a?.price, 1.8, 'a linha é a do mercado 171, não a do 1747');
  assert.equal(line?.entries, 4);
  assert.equal(line?.entriesInMarket, 2);
  assert.deepEqual(line?.marketsSeen, ['171', '1747']);
  // E o payload declara que o lado veio de ordem, não de nome.
  assert.equal(sideSource, 'outcome_order');
});

test('casa que não cota o mercado lido é dita, não sumida', () => {
  const perBook = new Map<string, OddsEntry[]>([
    ['pinnacle', book('pinnacle', 1.8, 2.2)],
    [
      'stake',
      [
        entry({
          outcome: null,
          price: 3.1,
          path: `bookmakers.stake.markets.1749.outcomes.1749.players.0.0`,
        }),
      ],
    ],
  ]);

  const { lines } = buildBookLines(perBook, SIDES, ASOF);
  const stake = lines.find((l) => l.bookmaker === 'stake');
  assert.match(stake?.excludedBecause ?? '', /não cota o mercado 171/);

  // `markets_seen` é o que denuncia o dia em que a taxonomia deles mudar.
  assert.deepEqual(coverageOf(['pinnacle', 'stake'], lines).marketsSeen, ['171', '1749']);
});

test('o mercado default é o moneyline medido', () => {
  assert.equal(DEFAULT_MARKET_ID, '171');
});

// ---------------------------------------------------------------------------
// Orçamento de tempo — o incidente do ciclo que não fechava
// ---------------------------------------------------------------------------

test('a chamada é recusada quando não cabe no que resta do ciclo', () => {
  // O gargalo medido: 5,5s de cooldown por chamada, 40 partidas na janela, 220s
  // de espera num ciclo de 240s. Sem esta guarda a espera decide o destino do
  // ciclo inteiro — e leva junto os outros três enrichers, que estão saudáveis.
  const agora = Date.now();

  // Cooldown já vencido: sobra só a folga da requisição em si.
  assert.equal(callFitsBudget('/v4/historical-odds', 60_000, agora), null);
  assert.equal(callFitsBudget('/v4/historical-odds', CALL_HEADROOM_MS, agora), null);

  const recusa = callFitsBudget('/v4/historical-odds', CALL_HEADROOM_MS - 1, agora);
  assert.ok(recusa !== null);
  // A recusa é NOMEADA: vira contagem no metadata, não silêncio.
  assert.match(recusa, /orçamento de tempo do ciclo/);
  assert.match(recusa, /historical-odds/);
});

test('sem prazo, nada é recusado por tempo', () => {
  // Backfill e scripts não têm ciclo para estourar. A mesma função serve aos
  // dois casos, e o `Infinity` é o que os separa.
  assert.equal(callFitsBudget('/v4/historical-odds', Infinity), null);
  assert.equal(callFitsBudget('/v4/fixtures', Infinity), null);
});

test('a espera do cooldown é consultável sem dormir', () => {
  // O erro não era o cooldown ser por processo — isso está certo, é o limite da
  // chave deles. Era a espera ser invisível: `call` dormia 5,5s por dentro e
  // cobrava de quem chamou sem avisar.
  resetOddsPapiState();
  assert.equal(waitMsFor('/v4/historical-odds'), 0, 'sem chamada anterior, não espera');
  assert.equal(cooldownOf('/v4/historical-odds'), 5_500);
  assert.equal(cooldownOf('/v4/fixtures'), 2_500);
});

test('sem consenso o summary diz isso — não inventa "mediana de 0"', () => {
  // O bug que o contador expôs: saía `consenso (mediana de 0) ? para <time>`.
  // Mediana de zero casas não é consenso fraco, é ausência de consenso, e `?` no
  // lugar da probabilidade é a forma mais fácil de o agente ler ausência como
  // número.
  const velho = CONSENSUS_MAX_STALE_SECONDS / 60 + 600;
  const perBook = new Map<string, OddsEntry[]>([
    ['pinnacle', book('pinnacle', 1.8, 2.2, { createdAt: at(velho) })],
  ]);

  const { lines, format } = buildBookLines(perBook, SIDES, ASOF);
  const consensus = consensusOf(lines);
  assert.equal(consensus.books, 0, 'a única casa está parada há horas');

  const summary = buildOddsSummary(
    '6666',
    'Team Spirit',
    lines,
    consensus,
    coverageOf(['pinnacle'], lines),
    format,
  );

  assert.match(summary, /SEM CONSENSO/);
  assert.doesNotMatch(summary, /mediana de 0/);
  // E não sobra `?` fingindo ser probabilidade na frase do consenso.
  assert.doesNotMatch(summary, /\? para/);
  // O preço de cada casa continua lá, com a idade — é o que diz que o mercado
  // delas parou.
  assert.match(summary, /pinnacle/);
  assert.match(summary, /parada/);
});

test('com consenso utilizável a frase volta a ser a de sempre', () => {
  const perBook = new Map<string, OddsEntry[]>([
    ['pinnacle', book('pinnacle', 1.8, 2.2)],
    ['stake', book('stake', 1.85, 2.1)],
  ]);
  const { lines, format } = buildBookLines(perBook, SIDES, ASOF);
  const consensus = consensusOf(lines);

  const summary = buildOddsSummary(
    'A',
    'B',
    lines,
    consensus,
    coverageOf(['pinnacle', 'stake'], lines),
    format,
  );

  assert.match(summary, /consenso \(mediana de 2\)/);
  assert.doesNotMatch(summary, /SEM CONSENSO/);
});

test('o relógio do cooldown é o presente, nunca o asOf do ciclo', () => {
  // REGRESSÃO. `resolveFixture` passava `ctx.asOf` como relógio para
  // `callFitsBudget`. Como `asOf` é o começo do ciclo e a última chamada é
  // registrada no presente, `cooldown - (asOf - últimaChamada)` fica negativo e
  // a espera cresce exatamente o tempo decorrido do ciclo. O log de produção
  // mostrou `exige 133s (129s de cooldown)` num endpoint de cooldown 2,5s.
  //
  // Efeito: passados os primeiros segundos de cada ciclo, TODA descoberta era
  // recusada — e as 26 partidas sem fixture nunca chegavam a ser procuradas.
  resetOddsPapiState();

  const agora = Date.now();
  const asOfDoCiclo = agora - 129_000;

  // Com o relógio certo, um endpoint sem chamada anterior não espera nada.
  assert.equal(waitMsFor('/v4/fixtures', agora), 0);
  assert.equal(callFitsBudget('/v4/fixtures', 30_000, agora), null);

  // A espera nunca pode passar do cooldown nominal do endpoint, qualquer que
  // seja o relógio — é isto que o bug violava.
  assert.ok(waitMsFor('/v4/fixtures', asOfDoCiclo) <= cooldownOf('/v4/fixtures'));
});

// ---------------------------------------------------------------------------
// O casador de nomes — 66% da perda de cobertura era aqui
// ---------------------------------------------------------------------------

function fx(id: string, side1: string[], side2: string[]) {
  return { fixtureId: id, startTime: null, finished: true, hasOdds: true, sides: [side1, side2] };
}
const semCodigo = (nome: string) => ({ displayName: nome, polymarketCode: null });

test('enfeite de organização não impede o casamento', () => {
  // Os padrões medidos nas falhas reais.
  assert.equal(sideMatchTier(semCodigo('DENDELE CS'), ['Dendele']), 'canonical');
  assert.equal(sideMatchTier(semCodigo('NIO'), ['Nio eSports']), 'canonical');
  assert.equal(sideMatchTier(semCodigo('Kreazion'), ['Team Kreazion']), 'canonical');
  assert.equal(sideMatchTier(semCodigo('Dendele'), ['Dendele']), 'exact');
});

test('sigla e abreviação casam, com o degrau certo', () => {
  assert.equal(sideMatchTier(semCodigo('Inner Circle Esports'), ['IC eSports']), 'abbrev');
  assert.equal(sideMatchTier(semCodigo('Natus Vincere'), ['NAVI']), 'abbrev');
  // O código da Polymarket é degrau próprio, acima da abreviação.
  assert.equal(
    sideMatchTier({ displayName: 'Nome Que Nao Casa', polymarketCode: 'nqnc' }, ['NQNC']),
    'code',
  );
});

test('time B da mesma organização NUNCA casa com o principal', () => {
  // A proteção central, e ela vem do dado medido: a lista de falhas tem
  // `Inner Circle Esports` e `Inner Circle Prospect` na mesma janela. Ligar a
  // partida de um à linha do outro é erro sem sintoma — mesma família do mercado
  // espelhado.
  assert.equal(sideMatchTier(semCodigo('Inner Circle Esports'), ['Inner Circle Prospect']), null);
  assert.equal(sideMatchTier(semCodigo('Inner Circle Prospect'), ['Inner Circle Esports']), null);

  // E a sigla não pode expressar "Prospect", então o nome com palavra distintiva
  // não desce para os degraus fracos de jeito nenhum.
  assert.equal(sideMatchTier(semCodigo('Inner Circle Prospect'), ['INN']), null);
  assert.equal(
    sideMatchTier({ displayName: 'Spirit Academy', polymarketCode: 'sa' }, ['SA']),
    null,
  );

  // Mas com a MESMA palavra distintiva dos dois lados, casa normalmente.
  assert.equal(sideMatchTier(semCodigo('Spirit Academy'), ['Team Spirit Academy']), 'canonical');
});

test('o par exige os dois lados na MESMA fixture', () => {
  // O relatório de cobertura mostrava os dois times "PRESENTE" e sem casar. Isso
  // é compatível com estarem em fixtures diferentes, contra outros adversários —
  // e nesse caso NÃO casar é o comportamento certo.
  const rows = [fx('f1', ['HOTU'], ['Outro Time']), fx('f2', ['GenOne'], ['Mais Outro'])];

  assert.equal(matchFixture(rows, semCodigo('HOTU'), semCodigo('GenOne')), null);

  // Juntos na mesma fixture, casa.
  const juntos = [...rows, fx('f3', ['HOTU'], ['GenOne'])];
  assert.equal(matchFixture(juntos, semCodigo('HOTU'), semCodigo('GenOne'))?.fixtureId, 'f3');
});

test('empate no mesmo degrau é recusado, não desempatado', () => {
  // Duas fixtures igualmente plausíveis são a mesma organização aparecendo duas
  // vezes no dia. Escolher uma seria adivinhar qual partida o nosso mercado
  // está precificando.
  const rows = [fx('f1', ['Dendele CS'], ['Nio']), fx('f2', ['Dendele'], ['Nio eSports'])];

  assert.equal(matchFixture(rows, semCodigo('Dendele'), semCodigo('NIO')), null);
});

test('o degrau mais forte ganha quando não há empate', () => {
  const rows = [fx('f1', ['DENDELE CS'], ['Nio eSports']), fx('f2', ['Dendele'], ['NIO'])];

  const link = matchFixture(rows, semCodigo('Dendele'), semCodigo('NIO'));
  assert.equal(link?.fixtureId, 'f2');
  assert.equal(link?.tier, 'exact');
});

test('o par carrega o degrau MAIS FRACO dos dois lados', () => {
  const rows = [fx('f1', ['Dendele'], ['Nio eSports'])];
  const link = matchFixture(rows, semCodigo('Dendele'), semCodigo('NIO'));

  assert.equal(link?.tier, 'canonical', 'exato de um lado, canônico do outro');
});

test('canonicalTeamName tira enfeite sem esvaziar o nome', () => {
  assert.equal(canonicalTeamName('DENDELE CS'), 'dendele');
  assert.equal(canonicalTeamName('Nio eSports'), 'nio');
  assert.equal(canonicalTeamName('Virtus.pro'), 'virtuspro');

  // Nome feito SÓ de enfeite não pode virar string vazia — aí casaria com
  // qualquer outro nome igualmente vazio.
  assert.equal(canonicalTeamName('Team CS'), 'teamcs');
});

test('distinguishingOf enxerga o que separa time principal de time B', () => {
  assert.deepEqual(distinguishingOf('Inner Circle Prospect'), ['prospect']);
  assert.deepEqual(distinguishingOf('Spirit Academy'), ['academy']);
  assert.deepEqual(distinguishingOf('Team Spirit'), []);
});

test('revanche na janela é desempatada pela data, não recusada', () => {
  // REGRESSÃO da cobertura: `cs2-is-6666-2026-08-07` e `cs2-6666-is-2026-08-08`
  // apontavam para fixtures com os dois times exatos e não casavam. Os mesmos
  // dois times se enfrentam duas vezes na janela, as duas fixtures empatavam no
  // degrau `exact`, e o casador recusava as duas.
  const rows = [
    { ...fx('dia7', ['Iberian Soul'], ['6666']), startTime: '2026-08-07T18:00:00.000Z' },
    { ...fx('dia8', ['Iberian Soul'], ['6666']), startTime: '2026-08-08T18:00:00.000Z' },
  ];

  const a = semCodigo('Iberian Soul');
  const b = semCodigo('6666');

  assert.equal(matchFixture(rows, a, b, new Date('2026-08-07T18:00:00.000Z'))?.fixtureId, 'dia7');
  assert.equal(matchFixture(rows, a, b, new Date('2026-08-08T17:30:00.000Z'))?.fixtureId, 'dia8');

  // Sem data para desempatar, continua recusando: escolher seria adivinhar qual
  // partida o nosso mercado está precificando.
  assert.equal(matchFixture(rows, a, b), null);
});

test('empate exato na distância continua sendo recusa', () => {
  const rows = [
    { ...fx('f1', ['Dendele'], ['Nio']), startTime: '2026-08-07T12:00:00.000Z' },
    { ...fx('f2', ['Dendele'], ['Nio']), startTime: '2026-08-07T18:00:00.000Z' },
  ];

  // Exatamente no meio: as duas à mesma distância.
  const meio = new Date('2026-08-07T15:00:00.000Z');
  assert.equal(matchFixture(rows, semCodigo('Dendele'), semCodigo('NIO'), meio), null);
});
