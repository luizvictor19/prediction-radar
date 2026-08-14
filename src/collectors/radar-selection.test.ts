import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_RADAR_RULES,
  agruparPorAssunto,
  bestLevels,
  detectarEspelhos,
  montarLinha,
  montarRoster,
  precoYes,
  triar,
  type RadarCandidate,
  type RadarMarketInput,
  type RadarRules,
} from './radar-selection.js';

/**
 * A regra de coleta, sem rede.
 *
 * O que estes testes protegem, depois da revisão, é sobretudo o que a regra NÃO
 * faz: não olha preço, não olha volume, não corta por assunto. Um teste que
 * afirma ausência parece bobo até alguém "melhorar" o coletor devolvendo um
 * filtro de tese para dentro dele — que é exatamente como a série de esports
 * virou refém de uma tese que morreu.
 */

const AGORA = Date.parse('2026-08-13T12:00:00.000Z');
const DIA = 24 * 60 * 60 * 1000;

function mercado(over: Partial<RadarMarketInput> & { id: string }): RadarMarketInput {
  return {
    slug: `mercado-${over.id}`,
    question: `Pergunta ${over.id}?`,
    description: 'regra',
    outcomePrices: '["0.50","0.50"]',
    endDate: new Date(AGORA + 30 * DIA).toISOString(),
    closed: false,
    active: true,
    acceptingOrders: true,
    enableOrderBook: true,
    bestBid: 0.48,
    bestAsk: 0.52,
    liquidityNum: 10_000,
    volume24hr: 5_000,
    clobTokenIds: `["token-${over.id}","token-${over.id}-no"]`,
    tema: 'macro-e-mercados',
    ...over,
  };
}

const REGRAS: RadarRules = DEFAULT_RADAR_RULES;

// ---------------------------------------------------------------------------
// O que a coleta AINDA filtra: viabilidade e propriedade estável
// ---------------------------------------------------------------------------

test('mercado exemplar passa', () => {
  assert.equal(triar(mercado({ id: 'a' }), REGRAS, AGORA).ok, true);
});

test('prazo acima do teto de 180 dias cai', () => {
  const t = triar(
    mercado({ id: 'a', endDate: new Date(AGORA + 400 * DIA).toISOString() }),
    REGRAS,
    AGORA,
  );
  assert.equal(t.ok === false && t.motivo, 'prazo acima do teto');
});

test('NÃO existe prazo mínimo: mercado que resolve amanhã entra', () => {
  // O piso de 7 dias da versão anterior tirava do roster justamente a semana da
  // resolução, que é quando a notícia decide o desfecho.
  const t = triar(
    mercado({ id: 'a', endDate: new Date(AGORA + 1 * DIA).toISOString() }),
    REGRAS,
    AGORA,
  );
  assert.equal(t.ok, true);
});

test('endDate vencido cai', () => {
  const t = triar(
    mercado({ id: 'a', endDate: new Date(AGORA - 1 * DIA).toISOString() }),
    REGRAS,
    AGORA,
  );
  assert.equal(t.ok === false && t.motivo, 'endDate vencido');
});

test('UM lado de livro basta — azarão com venda e sem compra entra', () => {
  // O caso medido em 2026-08-14: exigir os dois lados descartava 274 mercados, e
  // os mais líquidos eram a tese em estado puro — Eduardo Leite (1,8M), Aldo
  // Rebelo (1,6M), Massa Jr. (1,6M) na eleição brasileira. Azarão com um lado só
  // não é livro vazio: tem preço real, e é onde a notícia move mais forte.
  const soAsk = triar(mercado({ id: 'a', bestBid: 0, bestAsk: 0.04 }), REGRAS, AGORA);
  const soBid = triar(mercado({ id: 'b', bestBid: 0.96, bestAsk: 0 }), REGRAS, AGORA);

  assert.equal(soAsk.ok, true);
  assert.equal(soBid.ok, true);
  assert.equal(soAsk.ok === true && soAsk.candidato.lados, 1);
  assert.equal(soBid.ok === true && soBid.candidato.lados, 1);
  // E o spread não é inventado a partir do lado que existe.
  assert.equal(soAsk.ok === true && soAsk.candidato.spread, null);
  assert.equal(soBid.ok === true && soBid.candidato.spread, null);
});

test('livro VAZIO dos dois lados cai — aí não há preço nenhum', () => {
  const t = triar(mercado({ id: 'a', bestBid: 0, bestAsk: 0 }), REGRAS, AGORA);
  assert.equal(t.ok === false && t.motivo, 'livro vazio (nenhum dos dois lados)');
});

test('ask em 1,00 e bid em 0 são preenchimento, não oferta', () => {
  // A Gamma devolve 0/1 para "ninguém desse lado" em vez de omitir o campo.
  // Tratar isso como preço poria um mercado a zero (ou a um) na série.
  const t = triar(mercado({ id: 'a', bestBid: 0, bestAsk: 1 }), REGRAS, AGORA);
  assert.equal(t.ok === false && t.motivo, 'livro vazio (nenhum dos dois lados)');
});

test('livro invertido NÃO barra mais: cruzar é propriedade que muda', () => {
  // Livro cruzado dura segundos; barrar por ele tirava o mercado do roster por
  // 6h (a renovação) por causa de um instante. Fica gravado como está.
  const t = triar(mercado({ id: 'a', bestBid: 0.6, bestAsk: 0.4 }), REGRAS, AGORA);
  assert.equal(t.ok, true);
  assert.equal(t.ok === true && t.candidato.lados, 2);
});

test('quem JÁ está marcado fica mesmo com o livro VAZIO', () => {
  // O que a marca dispensa agora é o piso do livro vazio: perto da resolução o
  // livro seca de verdade, e tirar o mercado do roster ali abriria buraco na
  // série no trecho mais informativo. Não custa linha falsa — sem livro,
  // `montarLinha` não grava nada.
  const t = triar(mercado({ id: 'a', bestBid: 0, bestAsk: 0, jaMarcado: true }), REGRAS, AGORA);

  assert.equal(t.ok, true);
  assert.equal(t.ok === true && t.candidato.lados, 0);
  assert.equal(t.ok === true && t.candidato.spread, null);
});

test('mercado sem token de CLOB cai — não haveria livro para fotografar', () => {
  const t = triar(mercado({ id: 'a', clobTokenIds: '[]' }), REGRAS, AGORA);
  assert.equal(t.ok === false && t.motivo, 'sem token de CLOB');
});

test('fechado ou inativo cai', () => {
  assert.equal(
    triar(mercado({ id: 'a', closed: true }), REGRAS, AGORA).ok === false,
    true,
  );
  assert.equal(
    triar(mercado({ id: 'b', active: false }), REGRAS, AGORA).ok === false,
    true,
  );
});

test('mercado de partida cai; o de temporada fica', () => {
  // `sportsMarketType` é propriedade estável — um mercado é de partida ou não é,
  // e isso não muda na vida dele. Por isso o filtro cabe na coleta.
  const partida = mercado({ id: 'a', sportsMarketType: 'moneyline', question: 'Brewers vs. Dodgers' });
  const temporada = mercado({ id: 'b', question: "Will Vitinha win the 2026 Ballon d'Or?" });

  const t = triar(partida, REGRAS, AGORA);
  assert.equal(t.ok, false);
  assert.equal(t.ok === false && t.motivo, 'mercado de partida (jogo único)');
  assert.equal(triar(temporada, REGRAS, AGORA).ok, true);
});

test('gameStartTime SOZINHO não é mercado de partida', () => {
  // Medido em 2026-08-14: `gameStartTime` aparece 104 vezes fora de esporte —
  // 61 no WTI Crude, 21 em política, 19 em geopolítica. A primeira versão deste
  // filtro descartava "Will WTI Crude Oil hit (LOW) $60 in August?", com 181 mil
  // de liquidez, como se fosse um jogo.
  const wti = mercado({
    id: 'a',
    question: 'Will WTI Crude Oil (WTI) hit (LOW) $60 in August?',
    gameStartTime: '2026-08-01 00:00:00+00',
  });

  assert.equal(triar(wti, REGRAS, AGORA).ok, true);
});

test('o filtro de partida não confunde string vazia com marca', () => {
  const vazios = mercado({ id: 'a', sportsMarketType: '', gameStartTime: '' });
  assert.equal(triar(vazios, REGRAS, AGORA).ok, true);
});

test('slug de esports cai: a coleta deles foi desligada', () => {
  for (const slug of ['cs2-navi-faze-2026-09-01', 'lol-t1-geng-2026-09-01', 'dota2-a-b-2026-09-01']) {
    const t = triar(mercado({ id: slug, slug }), REGRAS, AGORA);
    assert.equal(t.ok === false && t.motivo, 'esports (coleta desligada)', slug);
  }
});

// ---------------------------------------------------------------------------
// O que a coleta NÃO filtra mais — e não pode voltar a filtrar
// ---------------------------------------------------------------------------

test('preço extremo NÃO barra: 0,03 e 0,97 entram', () => {
  const barato = triar(
    mercado({ id: 'a', outcomePrices: '["0.03","0.97"]', bestBid: 0.02, bestAsk: 0.04 }),
    REGRAS,
    AGORA,
  );
  const caro = triar(
    mercado({ id: 'b', outcomePrices: '["0.97","0.03"]', bestBid: 0.96, bestAsk: 0.98 }),
    REGRAS,
    AGORA,
  );

  assert.equal(barato.ok, true, 'faixa de preço é where na view, não porta na coleta');
  assert.equal(caro.ok, true);
});

test('volume zero NÃO barra: o mercado quieto de hoje é o que explode amanhã', () => {
  const t = triar(mercado({ id: 'a', volume24hr: 0 }), REGRAS, AGORA);
  assert.equal(t.ok, true);
  assert.equal(t.ok === true && t.candidato.volume24h, 0);
});

test('spread largo NÃO barra, mas é gravado', () => {
  const t = triar(mercado({ id: 'a', bestBid: 0.2, bestAsk: 0.6 }), REGRAS, AGORA);
  assert.equal(t.ok, true);
  assert.equal(t.ok === true && Number(t.candidato.spread?.toFixed(2)), 0.4);
});

test('preço cai para lastTradePrice quando outcomePrices não serve, e null não barra', () => {
  assert.equal(precoYes(mercado({ id: 'a', outcomePrices: '[]', lastTradePrice: 0.42 })), 0.42);
  const semPreco = mercado({ id: 'b', outcomePrices: '[]', lastTradePrice: 0 });
  assert.equal(precoYes(semPreco), null);
  assert.equal(triar(semPreco, REGRAS, AGORA).ok, true);
});

// ---------------------------------------------------------------------------
// Espelho — virou contador
// ---------------------------------------------------------------------------

function candidato(over: Partial<RadarCandidate> & { id: string }): RadarCandidate {
  const base: RadarCandidate = {
    market: over.market ?? mercado({ id: over.id }),
    tema: 'macro-e-mercados',
    preco: 0.5,
    liquidez: 10_000,
    volume24h: 1_000,
    spread: 0.04,
    lados: 2,
    eventId: 'evento-1',
    grupoId: -1,
    assunto: '—',
    jaMarcado: false,
  };
  return { ...base, ...over, market: base.market };
}

test('espelho é DETECTADO e nenhum dos dois é descartado', () => {
  const semMudanca = candidato({ id: 'boj-hold', preco: 0.27, volume24h: 3_000 });
  const alta = candidato({ id: 'boj-hike', preco: 0.72, volume24h: 9_000 });

  const pares = detectarEspelhos([semMudanca, alta]);

  assert.equal(pares.length, 1);
  assert.equal(pares[0]?.soma.toFixed(2), '0.99');
});

test('espelho não atravessa evento', () => {
  const a = candidato({ id: 'a', preco: 0.3, eventId: 'evento-1' });
  const b = candidato({ id: 'b', preco: 0.7, eventId: 'evento-2' });

  assert.equal(detectarEspelhos([a, b]).length, 0);
});

test('soma fora de 0,97–1,03 não é espelho', () => {
  const a = candidato({ id: 'a', preco: 0.3 });
  const b = candidato({ id: 'b', preco: 0.6 });

  assert.equal(detectarEspelhos([a, b]).length, 0);
});

// ---------------------------------------------------------------------------
// Assunto — virou coluna
// ---------------------------------------------------------------------------

test('assunto junta o que o eventId separa, e separa o que só compartilha país', () => {
  const perguntas = [
    'US-Iran Final Nuclear Deal by December 31, 2026?',
    'Will no qualifying diplomatic US-Iran meeting occur by September 30, 2026?',
    'Will Russia capture Kostyantynivka by September 30?',
  ];
  const cands = perguntas.map((q, i) =>
    candidato({ id: `m${i}`, eventId: `evento-${i}`, market: mercado({ id: `m${i}`, question: q }) }),
  );

  const grupos = agruparPorAssunto(cands);
  const tamanhos = grupos.map(g => g.membros.length).sort((a, b) => b - a);

  assert.deepEqual(tamanhos, [2, 1], 'os dois do Irã juntos, a Rússia sozinha');
});

test('o assunto vira rótulo em cada mercado do roster, e não corta nenhum', () => {
  const universo = [1, 2, 3, 4, 5].map(i =>
    mercado({
      id: `iran-${i}`,
      question: `Will Iran nuclear talks reach milestone ${i} by September 30?`,
      liquidityNum: i * 1_000,
      events: [{ id: `evento-${i}` }] as RadarMarketInput['events'],
    }),
  );

  const r = montarRoster(universo, REGRAS, AGORA);

  assert.equal(r.roster.length, 5, 'os cinco do mesmo assunto ficam');
  assert.equal(new Set(r.roster.map(c => c.grupoId)).size, 1, 'e todos no mesmo grupo');
  assert.ok(r.roster.every(c => c.assunto.includes('iran')), 'com rótulo gravável');
});

// ---------------------------------------------------------------------------
// O teto — ranking de liquidez
// ---------------------------------------------------------------------------

test('o teto por categoria corta os MENORES em liquidez, e o corte é contado', () => {
  const regras: RadarRules = { ...REGRAS, maxPorCategoria: 2 };
  const universo = [1, 2, 3, 4].map(i =>
    mercado({
      id: `m${i}`,
      question: `Assunto totalmente distinto número ${i} sobre coisa ${i}?`,
      liquidityNum: i * 1_000,
      // Volume ao contrário da liquidez: se o corte fosse por volume, a ordem
      // sairia invertida. É o teste que separa as duas réguas.
      volume24hr: (5 - i) * 1_000,
      events: [{ id: `evento-${i}` }] as RadarMarketInput['events'],
    }),
  );

  const r = montarRoster(universo, regras, AGORA);

  assert.deepEqual(r.roster.map(c => c.market.id), ['m4', 'm3']);
  assert.equal(r.cortadosPorTeto, 2);
  assert.equal(r.liquidezDoCorte, 3_000);
  assert.equal(r.liquidezDoPrimeiroCortado, 2_000);
});

test('o teto é POR CATEGORIA: a categoria pequena não é comida pela grande', () => {
  // O caso medido que motivou o desenho: num ranking global de liquidez, um teto
  // de 400 dá 208 vagas a esporte e 15 a IA. O teto global não é neutro — ele é
  // uma opinião sobre categoria, dita pelo tamanho do livro médio de cada uma.
  const regras: RadarRules = { ...REGRAS, maxPorCategoria: 2 };
  const universo = [
    ...[1, 2, 3, 4].map(i =>
      mercado({
        id: `esporte-${i}`,
        question: `Campeonato coisa ${i} tem vencedor ${i}?`,
        tema: 'esporte-de-temporada',
        liquidityNum: 500_000 + i,
        events: [{ id: `evento-e${i}` }] as RadarMarketInput['events'],
      }),
    ),
    ...[1, 2].map(i =>
      mercado({
        id: `ia-${i}`,
        question: `Modelo novo ${i} sai até dezembro?`,
        tema: 'ia-e-tecnologia',
        liquidityNum: 3_000 + i,
        events: [{ id: `evento-i${i}` }] as RadarMarketInput['events'],
      }),
    ),
  ];

  const r = montarRoster(universo, regras, AGORA);

  assert.deepEqual(r.porTema, { 'esporte-de-temporada': 2, 'ia-e-tecnologia': 2 });
  assert.equal(r.porCategoria['ia-e-tecnologia']?.liquidezDoCorte, 3_001);
  assert.equal(r.porCategoria['esporte-de-temporada']?.liquidezDoPrimeiroCortado, 500_002);
});

test('o backstop global corta depois do teto por categoria, e é contado à parte', () => {
  const regras: RadarRules = { ...REGRAS, maxPorCategoria: 3, rosterMax: 2 };
  const universo = ['a', 'b', 'c'].map((s, i) =>
    mercado({
      id: s,
      question: `Coisa distinta ${s} acontece?`,
      tema: i === 0 ? 'brasil' : 'macro-e-mercados',
      liquidityNum: (i + 1) * 1_000,
      events: [{ id: `evento-${s}` }] as RadarMarketInput['events'],
    }),
  );

  const r = montarRoster(universo, regras, AGORA);

  assert.equal(r.roster.length, 2);
  assert.equal(r.cortadosPorTeto, 0);
  assert.equal(r.cortadosPeloBackstop, 1);
});

test('teto que não morde não corta nada e não tem primeiro cortado', () => {
  const r = montarRoster([mercado({ id: 'a' })], REGRAS, AGORA);

  assert.equal(r.cortadosPorTeto, 0);
  assert.equal(r.liquidezDoPrimeiroCortado, null);
  assert.equal(r.liquidezDoCorte, 10_000);
});

test('o mesmo market vindo por duas tags entra uma vez só', () => {
  const um = mercado({ id: 'a', tema: 'ia-e-tecnologia' });
  const outro = { ...mercado({ id: 'a' }), tema: 'macro-e-mercados' };

  const r = montarRoster([um, outro], REGRAS, AGORA);

  assert.equal(r.roster.length, 1);
  assert.equal(r.roster[0]?.tema, 'ia-e-tecnologia', 'vale a primeira categoria que o trouxe');
});

test('todo descarte é contado por motivo', () => {
  const universo = [
    mercado({ id: 'ok' }),
    mercado({ id: 'longe', endDate: new Date(AGORA + 400 * DIA).toISOString() }),
    mercado({ id: 'sem-livro', bestBid: 0, bestAsk: 0 }),
    mercado({ id: 'fechado', closed: true }),
    // Volume, preço extremo e MEIO LIVRO não aparecem aqui: deixaram de ser motivo.
    mercado({ id: 'quieto', volume24hr: 0, outcomePrices: '["0.99","0.01"]' }),
    mercado({ id: 'meio-livro', bestAsk: 0 }),
  ];

  const r = montarRoster(universo, REGRAS, AGORA);

  assert.equal(r.roster.length, 3);
  assert.deepEqual(r.descartes, {
    'prazo acima do teto': 1,
    'livro vazio (nenhum dos dois lados)': 1,
    'fechado ou inativo': 1,
  });
  assert.equal(r.comUmLadoSo, 1, 'o de meio livro entra e é contado');
});

test('o roster sai por categoria contada', () => {
  const universo = [
    mercado({ id: 'a', tema: 'brasil' }),
    mercado({ id: 'b', tema: 'brasil' }),
    mercado({ id: 'c', tema: 'ia-e-tecnologia' }),
  ];

  assert.deepEqual(montarRoster(universo, REGRAS, AGORA).porTema, {
    brasil: 2,
    'ia-e-tecnologia': 1,
  });
});

// ---------------------------------------------------------------------------
// A foto
// ---------------------------------------------------------------------------

test('bestLevels lê o ÚLTIMO nível de cada lado, não o primeiro', () => {
  // `bids` crescente, `asks` decrescente — medido na CLOB. Ler o primeiro
  // inverteria o spread sem dar erro nenhum.
  const niveis = bestLevels(
    [
      { price: '0.021', size: '77730.44' },
      { price: '0.400', size: '1000' },
    ],
    [
      { price: '0.900', size: '500' },
      { price: '0.420', size: '2000' },
    ],
  );

  assert.equal(niveis.bid, 0.4);
  assert.equal(niveis.ask, 0.42);
  assert.equal(niveis.bidDepth, 400);
  assert.equal(niveis.askDepth, 840);
});

test('livro vazio não vira mid de 0,50 — vira linha nenhuma', () => {
  const niveis = bestLevels([], []);
  assert.deepEqual(niveis, { bid: null, ask: null, bidDepth: null, askDepth: null });
  assert.equal(montarLinha('evento', 'Yes', niveis, 1000, '2026-08-13T12:00:00.000Z'), null);
});

test('um lado só ainda vira linha, sem mid e sem spread', () => {
  const niveis = bestLevels([{ price: '0.30', size: '100' }], []);
  const linha = montarLinha('evento', 'Yes', niveis, 1000, '2026-08-13T12:00:00.000Z');

  assert.equal(linha?.best_bid, 0.3);
  assert.equal(linha?.best_ask, null);
  assert.equal(linha?.mid_price, null);
  assert.equal(linha?.spread, null);
  assert.equal(linha?.bid_depth, 30);
});

test('mid_price NUNCA é preenchido com um lado ausente', () => {
  /**
   * A ARMADILHA desta rodada, e ela volta calada.
   *
   * A coleta passou a aceitar livro de um lado só — o que é certo, porque azarão
   * com venda e sem compra tem preço real. O preço disso é que uma parte do
   * roster chega em `montarLinha` com metade do livro, e a tentação óbvia
   * ("preencher" o mid com o lado que existe, ou com 0,50, ou com a média de um
   * valor e um zero) produz um número que PARECE preço e não é. Meio dólar por
   * aritmética de livro incompleto já fabricou edge falso neste projeto.
   *
   * Este teste varre os dois lados ausentes em vários níveis de preço e afirma a
   * ausência: `mid_price` e `spread` nulos, sempre. Se alguém "melhorar" isso, é
   * aqui que quebra — e em particular o 0,50, que é o valor que passaria
   * despercebido num mercado equilibrado.
   */
  const precos = ['0.02', '0.30', '0.50', '0.75', '0.98'];

  for (const p of precos) {
    const nivel = [{ price: p, size: '100' }];

    for (const [rotulo, niveis] of [
      ['só bid', bestLevels(nivel, [])],
      ['só bid (asks undefined)', bestLevels(nivel, undefined)],
      ['só ask', bestLevels([], nivel)],
      ['só ask (bids undefined)', bestLevels(undefined, nivel)],
    ] as const) {
      const linha = montarLinha('evento', 'Yes', niveis, 1000, '2026-08-13T12:00:00.000Z');

      assert.notEqual(linha, null, `${rotulo} @ ${p}: um lado é preço, tem que virar linha`);
      assert.equal(linha?.mid_price, null, `${rotulo} @ ${p}: mid_price tem que ser NULO`);
      assert.equal(linha?.spread, null, `${rotulo} @ ${p}: spread tem que ser NULO`);
      // O lado que existe é gravado como é, e no campo certo — sem repetir no outro.
      assert.equal(linha?.best_bid, rotulo.startsWith('só bid') ? Number(p) : null);
      assert.equal(linha?.best_ask, rotulo.startsWith('só ask') ? Number(p) : null);
    }
  }
});

test('mid_price com os dois lados é média de verdade, e 0,50 só sai de 0,50', () => {
  // O contraponto do teste acima: a regra não pode ser "nunca preencher mid".
  // Com os dois lados o mid existe e é a média — e o único jeito de sair 0,50 é
  // o livro dizer 0,50.
  const equilibrado = montarLinha(
    'evento',
    'Yes',
    bestLevels([{ price: '0.49', size: '1' }], [{ price: '0.51', size: '1' }]),
    null,
    '2026-08-13T12:00:00.000Z',
  );
  assert.equal(equilibrado?.mid_price, 0.5);

  const torto = montarLinha(
    'evento',
    'Yes',
    bestLevels([{ price: '0.02', size: '1' }], [{ price: '0.06', size: '1' }]),
    null,
    '2026-08-13T12:00:00.000Z',
  );
  assert.equal(torto?.mid_price, 0.04);
});

test('a linha carrega os sete campos que a coluna espera', () => {
  const linha = montarLinha(
    'evento',
    'Yes',
    bestLevels([{ price: '0.48', size: '1000' }], [{ price: '0.52', size: '2000' }]),
    12_345,
    '2026-08-13T12:00:00.000Z',
  );

  // `spread` sai de uma subtração de floats: comparar o literal aqui seria
  // testar a representação binária, não a regra.
  assert.deepEqual(
    { ...linha, spread: Number(linha?.spread?.toFixed(4)) },
    {
      event_id: 'evento',
      outcome: 'Yes',
      best_bid: 0.48,
      best_ask: 0.52,
      mid_price: 0.5,
      spread: 0.04,
      bid_depth: 480,
      ask_depth: 1040,
      volume_24h: 12_345,
      captured_at: '2026-08-13T12:00:00.000Z',
    },
  );
});
