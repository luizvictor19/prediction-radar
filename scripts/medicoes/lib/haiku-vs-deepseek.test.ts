import assert from 'node:assert/strict';
import { test } from 'node:test';

// `digestao.ts` creates the Supabase client on import; nothing here reaches it.
process.env['SUPABASE_URL'] ??= 'http://localhost:54321';
process.env['SUPABASE_SERVICE_KEY'] ??= 'test-key';

const {
  achadosDaLeitura,
  cobertura,
  consistencia,
  estimarCusto,
  mesmoAchado,
  nulosPorCausa,
  porcento,
  sortearTextos,
  somarPorClasse,
  uniao,
} = await import('./haiku-vs-deepseek.js');
const { hashDescription } = await import('../../../src/digest/digest.js');

type LeituraDeepseek = import('./haiku-vs-deepseek.js').LeituraDeepseek;
type Achado = import('./haiku-vs-deepseek.js').Achado;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function leitura(
  id: string,
  eventId: string,
  texto: string,
  criadoEm: string,
  tokens: [number, number] = [1_000, 12_000],
): LeituraDeepseek {
  return {
    id,
    eventId,
    sha: hashDescription(texto),
    criadoEm,
    tokensEntrada: tokens[0],
    tokensSaida: tokens[1],
    custoUsd: null,
  };
}

const TEXTOS = ['regra A', 'regra B', 'regra C', 'regra D', 'regra E'];
const GUARDADOS = new Map(TEXTOS.map((t) => [hashDescription(t), t]));

function corpo(): LeituraDeepseek[] {
  return TEXTOS.flatMap((t, i) => [
    leitura(`${i}-1`, `ev-${i}`, t, '2026-08-17T00:00:00Z'),
    leitura(`${i}-2`, `ev-${i}`, t, '2026-08-18T00:00:00Z'),
  ]);
}

const RADAR = new Set(TEXTOS.map((_, i) => `ev-${i}`));

// ---------------------------------------------------------------------------
// The sample
// ---------------------------------------------------------------------------

test('o sorteio devolve os mesmos textos qualquer que seja a ordem de chegada', () => {
  const base = { textosGuardados: GUARDADOS, mercadosNoRadar: RADAR, semente: 7, n: 3 };
  const a = sortearTextos({ ...base, leituras: corpo() });
  const b = sortearTextos({ ...base, leituras: [...corpo()].reverse() });

  assert.equal(a.amostra.length, 3);
  assert.deepEqual(
    a.amostra.map((t) => t.sha),
    b.amostra.map((t) => t.sha),
  );
  // A different seed is a different draw, or the seed would be decoration.
  const c = sortearTextos({ ...base, semente: 8, leituras: corpo() });
  assert.notDeepEqual(
    a.amostra.map((t) => t.sha),
    c.amostra.map((t) => t.sha),
  );
});

test('o sorteio conta cada motivo de fora, e só sorteia o que sobrou', () => {
  const leituras = [
    ...corpo(),
    // no stored text
    leitura('x-1', 'ev-x', 'sem texto guardado', '2026-08-17T00:00:00Z'),
    leitura('x-2', 'ev-x', 'sem texto guardado', '2026-08-18T00:00:00Z'),
    // a single reading
    leitura('y-1', 'ev-y', 'lida uma vez', '2026-08-17T00:00:00Z'),
    // no market left in the radar
    leitura('z-1', 'ev-fora', 'fora do radar', '2026-08-17T00:00:00Z'),
    leitura('z-2', 'ev-fora', 'fora do radar', '2026-08-18T00:00:00Z'),
  ];
  const guardados = new Map(GUARDADOS);
  guardados.set(hashDescription('lida uma vez'), 'lida uma vez');
  guardados.set(hashDescription('fora do radar'), 'fora do radar');
  // stored under a key it does not hash to
  const forjado = leitura('w-1', 'ev-w', 'texto original', '2026-08-17T00:00:00Z');
  guardados.set(forjado.sha, 'texto editado');
  leituras.push(forjado, { ...forjado, id: 'w-2', criadoEm: '2026-08-18T00:00:00Z' });

  const s = sortearTextos({
    leituras,
    textosGuardados: guardados,
    mercadosNoRadar: new Set([...RADAR, 'ev-x', 'ev-y', 'ev-w']),
    semente: 1,
    n: 100,
  });

  assert.deepEqual(s.fora, { semTexto: 1, hashNaoBate: 1, umaLeitura: 1, foraDoRadar: 1 });
  assert.equal(s.textos, 9);
  assert.equal(s.elegiveis, 5);
  assert.equal(s.amostra.length, 5);
});

test('o par de base prefere duas leituras do mercado que o Haiku vai ler', () => {
  const t = 'regra compartilhada';
  const guardados = new Map([[hashDescription(t), t]]);
  const leituras = [
    // the oldest reading is from a market that left the radar
    leitura('a', 'ev-saiu', t, '2026-08-17T00:00:00Z'),
    leitura('b', 'ev-1', t, '2026-08-18T00:00:00Z'),
    leitura('c', 'ev-2', t, '2026-08-19T00:00:00Z'),
    leitura('d', 'ev-1', t, '2026-08-20T00:00:00Z'),
  ];
  const s = sortearTextos({
    leituras,
    textosGuardados: guardados,
    mercadosNoRadar: new Set(['ev-1', 'ev-2']),
    semente: 1,
    n: 1,
  });

  assert.equal(s.amostra[0]?.eventId, 'ev-1');
  assert.deepEqual(s.amostra[0]?.par, ['b', 'd']);
  assert.equal(s.amostra[0]?.parMesmoMercado, true);
  assert.equal(s.amostra[0]?.leiturasDeepseek, 4);

  // With one reading per market the pair falls back to the first two overall,
  // and says it did.
  const s2 = sortearTextos({
    leituras: leituras.filter((l) => l.id !== 'd'),
    textosGuardados: guardados,
    mercadosNoRadar: new Set(['ev-1', 'ev-2']),
    semente: 1,
    n: 1,
  });
  assert.deepEqual(s2.amostra[0]?.par, ['a', 'b']);
  assert.equal(s2.amostra[0]?.parMesmoMercado, false);
});

// ---------------------------------------------------------------------------
// The estimate
// ---------------------------------------------------------------------------

test('a estimativa usa a média de tokens do texto, vezes as leituras, no preço do modelo', () => {
  const t = 'regra única';
  const leituras = [
    leitura('1', 'ev', t, '2026-08-17T00:00:00Z', [1_000, 10_000]),
    leitura('2', 'ev', t, '2026-08-18T00:00:00Z', [1_000, 14_000]),
  ];
  const s = sortearTextos({
    leituras,
    textosGuardados: new Map([[hashDescription(t), t]]),
    mercadosNoRadar: new Set(['ev']),
    semente: 1,
    n: 1,
  });

  const e = estimarCusto('claude-haiku-5-5', s.amostra, leituras, 2);
  // mean 1,000 in and 12,000 out, read twice: 2,000 x 0.10 + 24,000 x 0.50 per MTok
  assert.deepEqual(e, { chamadas: 2, tokensEntrada: 2_000, tokensSaida: 24_000, usd: 0.0122 });
  assert.equal(estimarCusto('modelo-sem-preco', s.amostra, leituras, 2), null);
});

// ---------------------------------------------------------------------------
// Findings
// ---------------------------------------------------------------------------

function peg(trecho: string): Achado {
  return achadosDaLeitura(
    'd',
    [{ texto: 't', severidade: 'detalhe', trecho, cenario: null }],
    [],
  )[0] as Achado;
}

function amb(tipo: string, trecho: string, conflito: string | null = null): Achado {
  return achadosDaLeitura(
    'd',
    [],
    [{ tipo, trecho, trecho_conflito: conflito, leitura_a: 'a', leitura_b: 'b' }],
  )[0] as Achado;
}

test('achadosDaLeitura usa a chave da tela, a mesma para os dois modelos', () => {
  assert.equal(peg('By 11:59 PM  ET').chave, 'pegadinha||by 11:59 pm et');
  assert.equal(
    amb('fonte_vaga', 'Official Source').chave,
    'ambiguidade||fonte_vaga||official source',
  );
  assert.equal(amb('contradicao_interna', 'B side', 'a side').classe, 'contradicao');
});

test('mesmoAchado aceita um trecho dentro do outro, na borda de palavra', () => {
  assert.equal(mesmoAchado(peg('by 11:59 PM ET'), peg('by 11:59 PM ET on December 31')), true);
  assert.equal(mesmoAchado(peg('by 11:59 PM ET on December 31'), peg('by 11:59 PM ET')), true);
  // `et` inside `market` is not a quote of the same passage
  assert.equal(mesmoAchado(peg('the market resolves'), peg('ET')), false);
});

test('mesmoAchado exige a mesma classe e, na ambiguidade, o mesmo tipo', () => {
  assert.equal(mesmoAchado(peg('official source'), amb('fonte_vaga', 'official source')), false);
  assert.equal(
    mesmoAchado(amb('fonte_vaga', 'official source'), amb('momento_ambiguo', 'official source')),
    false,
  );
  assert.equal(
    mesmoAchado(amb('fonte_vaga', 'official source'), amb('fonte_vaga', 'the official source')),
    true,
  );
});

test('mesmoAchado casa a contradição com os dois trechos em qualquer ordem', () => {
  const a = amb('contradicao_interna', 'resolves Yes on approval', 'resolves No if delayed');
  const b = amb('contradicao_interna', 'resolves No if delayed', 'resolves Yes on approval');
  const c = amb('contradicao_interna', 'resolves Yes on approval', 'another clause here');
  assert.equal(mesmoAchado(a, b), true);
  assert.equal(mesmoAchado(a, c), false);
});

test('a união guarda cada achado uma vez, mesmo citado com recortes diferentes', () => {
  const u = uniao([
    [peg('by 11:59 PM ET'), peg('official source')],
    [peg('by 11:59 PM ET on December 31')],
  ]);
  assert.equal(u.length, 2);
});

// ---------------------------------------------------------------------------
// The measures
// ---------------------------------------------------------------------------

test('a consistência conta dos dois lados e soma contagens, não percentuais', () => {
  const a = [peg('passage one'), peg('passage two')];
  const b = [peg('passage one'), peg('passage three'), amb('fonte_vaga', 'official source')];
  const r = consistencia(a, b);
  // A: 1 of 2 found in B. B: 1 of 3 found in A. Together 2 of 5.
  assert.deepEqual(r.total, { parte: 2, todo: 5 });
  assert.deepEqual(r.pegadinha, { parte: 2, todo: 4 });
  assert.deepEqual(r.ambiguidade, { parte: 0, todo: 1 });
  assert.equal(porcento(r.total), '40.0%');

  // Pooled: a text with one finding does not weigh as much as one with five.
  const pequeno = consistencia([peg('lonely passage')], [peg('lonely passage')]);
  assert.deepEqual(somarPorClasse([r, pequeno]).total, { parte: 4, todo: 7 });
});

test('a cobertura é assimétrica: quanto de um o outro também achou', () => {
  const haiku = [peg('passage one'), peg('passage two')];
  const deepseek = [peg('passage one')];
  assert.deepEqual(cobertura(haiku, deepseek).total, { parte: 1, todo: 2 });
  assert.deepEqual(cobertura(deepseek, haiku).total, { parte: 1, todo: 1 });
  assert.equal(porcento(cobertura([], haiku).total), '—');
});

test('os nulos listam toda causa, zero incluído, e não somem com código novo', () => {
  const r = new Map(nulosPorCausa(['refusal', 'opiniao', 'opiniao', 'algo_novo']));
  assert.equal(r.get('guarda_opiniao'), 2);
  assert.equal(r.get('recusa_do_modelo'), 1);
  assert.equal(r.get('truncado'), 0);
  assert.equal(r.get('desconhecido:algo_novo'), 1);
});
