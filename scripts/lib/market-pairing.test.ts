import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { PairingMarket } from './market-pairing.js';
import {
  DEFAULT_COST_MODEL,
  DEFAULT_PAIRING_CONFIG,
  estimateExtractorCost,
  extractEntities,
  generateCandidates,
  sampleDiscardedPairs,
  tokenize,
} from './market-pairing.js';

/** Nada aqui toca a rede: o gerador recebe mercados prontos, por desenho. */
function market(over: Partial<PairingMarket> & { id: string; question: string }): PairingMarket {
  return {
    rules: 'This market will resolve to Yes if the event occurs.',
    eventId: null,
    seriesId: null,
    negRiskKey: null,
    tags: [],
    endDate: '2026-12-31T00:00:00Z',
    resolved: false,
    ...over,
  };
}

describe('tokenize', () => {
  it('derruba palavra gramatical e normaliza caixa', () => {
    assert.deepEqual(tokenize('Will the Lakers beat the Celtics?'), ['lakers', 'beat', 'celtics']);
  });

  it('preserva número, percentual e cifrão', () => {
    assert.deepEqual(tokenize('Will $BTC be above 100k in 2027?'), ['$btc', 'above', '100k', '2027']);
  });
});

describe('extractEntities', () => {
  it('pega nome próprio composto', () => {
    const e = extractEntities('Will Donald Trump win Pennsylvania?');
    assert.ok(e.includes('donald trump'));
    assert.ok(e.includes('pennsylvania'));
  });

  it('não trata o "Will" inicial como nome próprio', () => {
    const e = extractEntities('Will Bitcoin hit 200000 before July?');
    assert.ok(!e.some((x) => x.startsWith('will ')));
    assert.ok(e.includes('bitcoin'));
  });

  it('mas "Will" no meio da frase segue sendo nome', () => {
    const e = extractEntities('Does Will Smith host the Oscars?');
    assert.ok(e.includes('will smith'));
  });

  it('pega ticker e sigla', () => {
    const e = extractEntities('Will NVDA beat GDP growth?');
    assert.ok(e.includes('nvda'));
    assert.ok(e.includes('gdp'));
  });

  it('normaliza separador de milhar', () => {
    const a = extractEntities('Bitcoin above 100,000?');
    const b = extractEntities('Bitcoin above 100000?');
    assert.ok(a.includes('100000'));
    assert.ok(b.includes('100000'));
  });
});

describe('camada 1 — estrutura', () => {
  it('agrupa por evento e marca que precisa de modelo', () => {
    const markets = [
      market({ id: 'a', question: 'Team Alpha wins the series?', eventId: 'e1' }),
      market({ id: 'b', question: 'Team Alpha wins map 1?', eventId: 'e1' }),
      market({ id: 'c', question: 'Unrelated question about weather', eventId: 'e2' }),
    ];
    const { groups } = generateCandidates(markets);
    const l1 = groups.filter((g) => g.layer === 1);
    assert.equal(l1.length, 1);
    assert.deepEqual([...(l1[0]?.memberIds ?? [])].sort(), ['a', 'b']);
    assert.equal(l1[0]?.needsModel, true);
  });

  it('neg-risk vira grupo que NÃO precisa de modelo — a partição já veio da API', () => {
    const markets = ['x', 'y', 'z'].map((k) =>
      market({ id: k, question: `Candidate ${k.toUpperCase()} wins?`, eventId: 'e1', negRiskKey: 'nr1' }),
    );
    const { groups, stats } = generateCandidates(markets);
    const nr = groups.filter((g) => g.reason.includes('neg-risk'));
    assert.equal(nr.length, 1);
    assert.equal(nr[0]?.needsModel, false);
    assert.equal(stats.groupsNeedingModel, groups.length - 1);
  });

  it('neg-risk suprime o grupo redundante de evento', () => {
    const markets = ['x', 'y'].map((k) =>
      market({ id: k, question: `Candidate ${k} wins?`, eventId: 'e1', negRiskKey: 'nr1' }),
    );
    const { groups } = generateCandidates(markets);
    assert.equal(groups.filter((g) => g.reason.startsWith('mesmo evento')).length, 0);
  });

  it('NÃO trunca grupo neg-risk — a partição vale para os 384, não para os 60', () => {
    const size = DEFAULT_PAIRING_CONFIG.maxStructuralGroupSize + 40;
    const markets = Array.from({ length: size }, (_, i) =>
      market({ id: `m${i}`, question: `Person ${i} wins?`, eventId: 'nr', negRiskKey: 'event:nr' }),
    );
    const { groups } = generateCandidates(markets);
    const nr = groups.find((g) => g.reason.includes('neg-risk'));
    assert.equal(nr?.memberIds.length, size);
    assert.equal(nr?.needsModel, false);
  });

  it('trunca no teto duro e CONTA o que perdeu', () => {
    const size = DEFAULT_PAIRING_CONFIG.maxStructuralGroupSize + 5;
    const markets = Array.from({ length: size }, (_, i) =>
      market({ id: `m${i}`, question: `Outcome number ${i} happens?`, eventId: 'big' }),
    );
    const { stats } = generateCandidates(markets);
    const l1 = stats.byLayer[0];
    assert.ok((l1?.pairsDroppedToCap ?? 0) > 0);
    assert.equal(l1?.notes.some((n) => n.includes('truncados')), true);
  });
});

describe('camada 2 — entidades', () => {
  it('agrupa pela entidade mais rara, não pela mais comum', () => {
    // "Bitcoin" aparece em todos; "Solana" só em dois. O balde útil é o raro.
    const markets = [
      market({ id: 'a', question: 'Bitcoin above 100000 in March?' }),
      market({ id: 'b', question: 'Bitcoin above 100000 in April?' }),
      market({ id: 'c', question: 'Bitcoin and Solana both up in March?' }),
      market({ id: 'd', question: 'Solana above 500 in March?' }),
    ];
    const { groups } = generateCandidates(markets);
    const solana = groups.find((g) => g.reason.includes('solana'));
    assert.ok(solana !== undefined);
    assert.deepEqual([...(solana?.memberIds ?? [])].sort(), ['c', 'd']);
  });

  it('recusa balde genérico demais e diz isso na nota', () => {
    const size = DEFAULT_PAIRING_CONFIG.entityBucketCeiling + 3;
    // Mesma pergunta em todos: a única entidade compartilhada é "Zephyr", e ela
    // acaba sendo a chave de um balde grande demais para virar grupo.
    const markets = Array.from({ length: size }, (_, i) =>
      market({ id: `m${i}`, question: 'Zephyr wins the round?' }),
    );
    const { stats } = generateCandidates(markets);
    const l2 = stats.byLayer[1];
    assert.ok((l2?.pairsRejected ?? 0) > 0);
    assert.equal(l2?.notes.some((n) => n.includes('genérica demais')), true);
  });
});

describe('camada 3 — proximidade textual', () => {
  it('junta perguntas parecidas de eventos diferentes', () => {
    const markets = [
      market({ id: 'a', question: 'Zorbax wins the Kappa tournament?', eventId: 'e1' }),
      market({ id: 'b', question: 'Zorbax wins the Kappa tournament final?', eventId: 'e2' }),
      market({ id: 'c', question: 'Rainfall in Reykjavik exceeds 40mm?', eventId: 'e3' }),
    ];
    const { groups } = generateCandidates(markets);
    const near = groups.filter((g) => g.layer === 3 || g.layer === 2);
    assert.ok(near.some((g) => [...g.memberIds].sort().join(',') === 'a,b'));
    assert.ok(!near.some((g) => g.memberIds.includes('c')));
  });
});

describe('contabilidade dos pares', () => {
  it('coberto + descartado = C(N,2), sempre', () => {
    const markets = Array.from({ length: 40 }, (_, i) =>
      market({
        id: `m${i}`,
        question: `Will Team ${String.fromCharCode(65 + (i % 7))} win match ${i}?`,
        eventId: `e${i % 9}`,
        resolved: i % 3 === 0,
      }),
    );
    const { stats } = generateCandidates(markets);
    assert.equal(stats.totalPairs, (40 * 39) / 2);
    assert.equal(stats.pairsCovered + stats.pairsDiscarded, stats.totalPairs);
  });

  it('nenhum par novo é contado duas vezes entre camadas', () => {
    const markets = Array.from({ length: 25 }, (_, i) =>
      market({ id: `m${i}`, question: `Aurox phase ${i} completes?`, eventId: `e${i % 4}` }),
    );
    const { stats } = generateCandidates(markets);
    const sumNew = stats.byLayer.reduce((s, l) => s + l.pairsNew, 0);
    assert.equal(sumNew, stats.pairsCovered);
  });

  it('nenhum mercado entra em mais de 4 grupos', () => {
    // É o invariante que sustenta o teto de custo da fase 1: chamadas <= 4N /
    // tamanho médio de grupo, INDEPENDENTE de quão denso o universo fique.
    // Se ele cair, o teto some junto e a fase 2 volta a ser um cheque em branco.
    const markets = Array.from({ length: 120 }, (_, i) =>
      market({
        id: `m${i}`,
        question: `Will Team ${String.fromCharCode(65 + (i % 9))} beat Team ${String.fromCharCode(75 + (i % 5))} in round ${i % 11}?`,
        eventId: `e${i % 20}`,
        seriesId: i % 3 === 0 ? `s${i % 6}` : null,
        negRiskKey: i % 7 === 0 ? `nr${i % 4}` : null,
      }),
    );
    const { groups } = generateCandidates(markets);
    const count = new Map<string, number>();
    for (const g of groups) {
      for (const id of g.memberIds) count.set(id, (count.get(id) ?? 0) + 1);
    }
    const worst = Math.max(...count.values());
    assert.ok(worst <= 4, `algum mercado entrou em ${worst} grupos`);
  });

  it('universo vazio ou unitário não quebra', () => {
    assert.equal(generateCandidates([]).stats.totalPairs, 0);
    assert.equal(generateCandidates([market({ id: 'a', question: 'Solo?' })]).stats.groups, 0);
  });
});

describe('marcação de resolvidos', () => {
  it('grupo inteiramente resolvido é marcado — vira teste automático', () => {
    const markets = [
      market({ id: 'a', question: 'Team Zeta wins game 1?', eventId: 'e1', resolved: true }),
      market({ id: 'b', question: 'Team Zeta wins game 2?', eventId: 'e1', resolved: true }),
      market({ id: 'c', question: 'Team Omega wins game 1?', eventId: 'e2', resolved: false }),
      market({ id: 'd', question: 'Team Omega wins game 2?', eventId: 'e2', resolved: true }),
    ];
    const { groups, stats } = generateCandidates(markets);
    const e1 = groups.find((g) => g.memberIds.includes('a') && g.memberIds.includes('b'));
    assert.equal(e1?.fullyResolved, true);
    assert.equal(e1?.resolvedCount, 2);
    const e2 = groups.find((g) => g.memberIds.includes('c') && g.memberIds.includes('d'));
    assert.equal(e2?.fullyResolved, false);
    assert.equal(stats.fullyResolvedGroups >= 1, true);
  });
});

describe('auditoria do descarte', () => {
  it('sorteia só pares fora dos grupos, e de forma reprodutível', () => {
    const markets = Array.from({ length: 60 }, (_, i) =>
      market({ id: `m${i}`, question: `Topic ${i} of unrelated subject ${i * 7} resolves?` }),
    );
    const result = generateCandidates(markets);
    const a = sampleDiscardedPairs(markets, result, 100, 42);
    const b = sampleDiscardedPairs(markets, result, 100, 42);
    assert.equal(a.sampled, b.sampled);
    assert.equal(a.maxSimilarity, b.maxSimilarity);
    assert.ok(a.sampled > 0);
    assert.ok(a.maxSimilarity < 1);
  });
});

describe('custo', () => {
  it('reproduz o preço medido do analista dentro de 5%', () => {
    // v2 de `esports_analyses`: 8.714 tokens de entrada, 359 de saída,
    // US$ 0,0315 medidos. Se a fórmula daqui não reproduz isso, ela não pode
    // ser usada para prever o custo do extrator.
    const usd = (8714 * 3) / 1_000_000 + (359 * 15) / 1_000_000;
    assert.ok(Math.abs(usd - 0.0315) / 0.0315 < 0.05, `previu ${usd}`);
  });

  it('grupo que não precisa de modelo não custa nada', () => {
    const markets = ['x', 'y', 'z'].map((k) =>
      market({ id: k, question: `Candidate ${k} wins?`, eventId: 'e1', negRiskKey: 'nr1' }),
    );
    const { groups } = generateCandidates(markets);
    const free = groups.filter((g) => !g.needsModel);
    assert.ok(free.length > 0);
    assert.equal(estimateExtractorCost(free).calls, 0);
    assert.equal(estimateExtractorCost(free).usd, 0);
  });

  it('o modo pessimista custa mais que o realista', () => {
    const markets = Array.from({ length: 12 }, (_, i) =>
      market({ id: `m${i}`, question: `Outcome ${i}?`, eventId: 'e1', rules: 'x'.repeat(600) }),
    );
    const { groups } = generateCandidates(markets);
    const optimistic = estimateExtractorCost(groups, DEFAULT_COST_MODEL, false);
    const pessimistic = estimateExtractorCost(groups, DEFAULT_COST_MODEL, true);
    assert.equal(optimistic.calls, pessimistic.calls);
    assert.ok(pessimistic.usd > optimistic.usd);
  });

  it('uma chamada por grupo, não uma por par', () => {
    const markets = Array.from({ length: 10 }, (_, i) =>
      market({ id: `m${i}`, question: `Outcome ${i}?`, eventId: 'e1' }),
    );
    const { groups } = generateCandidates(markets);
    const needing = groups.filter((g) => g.needsModel);
    assert.equal(estimateExtractorCost(groups).calls, needing.length);
    assert.ok(estimateExtractorCost(groups).calls < (10 * 9) / 2);
  });
});
