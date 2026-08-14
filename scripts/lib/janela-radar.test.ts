import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { Foto } from './janela-radar.js';
import {
  escolherAncora,
  JANELA_MS,
  lerJanelas,
  TOLERANCIA_MS,
  variacaoComBase,
} from './janela-radar.js';

/** Nada aqui toca a rede: a série é montada à mão, por desenho. */

const MIN = 60_000;
const T0 = Date.parse('2026-08-14T14:00:00.000Z');

/**
 * Uma foto com livro completo: bid e ask em volta do mid. Quando `mid` é nulo,
 * o livro fica vazio dos dois lados — é o caso "sem preço nenhum", diferente do
 * "livro de um lado só", que tem fixture própria.
 */
function foto(capturedAt: number, mid: number | null): Foto {
  if (mid === null) return { capturedAt, mid: null, bid: null, ask: null };
  return { capturedAt, mid, bid: mid - 0.01, ask: mid + 0.01 };
}

/** Uma série regular a cada 15 min, terminando em T0. */
function grade(fotos: number, mid: (i: number) => number | null = () => 0.5): Foto[] {
  const out: Foto[] = [];
  for (let i = fotos - 1; i >= 0; i--) {
    out.push(foto(T0 - i * 15 * MIN, mid(i)));
  }
  return out;
}

/** Azarão com só venda: ask existe, bid e mid não. */
function soAsk(capturedAt: number, ask: number): Foto {
  return { capturedAt, mid: null, bid: null, ask };
}

/** Só compra: bid existe, ask e mid não. */
function soBid(capturedAt: number, bid: number): Foto {
  return { capturedAt, mid: null, bid, ask: null };
}

describe('escolherAncora — a janela é por TEMPO, não por número de linhas', () => {
  it('pega a foto mais próxima do alvo, não a última anterior a ele', () => {
    const fotos: Foto[] = [
      foto(T0 - 70 * MIN, 0.3),
      foto(T0 - 55 * MIN, 0.4),
    ];
    // Alvo em -60: a de -55 está a 5 min, a de -70 está a 10.
    const a = escolherAncora(fotos, T0 - 60 * MIN, TOLERANCIA_MS.h1);
    assert.equal(a?.mid, 0.4);
  });

  it('devolve null quando a mais próxima está além da tolerância', () => {
    const fotos: Foto[] = [foto(T0 - 90 * MIN, 0.3)];
    assert.equal(escolherAncora(fotos, T0 - 60 * MIN, TOLERANCIA_MS.h1), null);
  });

  it('aceita exatamente na borda da tolerância', () => {
    const fotos: Foto[] = [foto(T0 - 75 * MIN, 0.3)];
    assert.equal(escolherAncora(fotos, T0 - 60 * MIN, TOLERANCIA_MS.h1)?.mid, 0.3);
  });

  it('um buraco na série NÃO faz a âncora escorregar para outra distância', () => {
    // O caso que "N fotos atrás" erra: falta o ciclo de -60, e contar 4 linhas
    // para trás a partir de T0 entregaria a de -75 achando que é a de -60.
    // Aqui a de -75 é entregue SABENDO que ela é a de -75 — span_1h_min = 75 —
    // e a de -45 é entregue quando está mais perto.
    const semSessenta: Foto[] = [
      foto(T0 - 75 * MIN, 0.20),
      foto(T0 - 45 * MIN, 0.25),
      foto(T0 - 30 * MIN, 0.30),
      foto(T0 - 15 * MIN, 0.35),
      foto(T0, 0.40),
    ];
    const a = escolherAncora(semSessenta, T0 - 60 * MIN, TOLERANCIA_MS.h1);
    // Empate real: -75 e -45 estão as duas a 15 min do alvo. Desempata pela
    // mais antiga, igual ao `order by abs(...), s.captured_at` do SQL.
    assert.equal(a?.capturedAt, T0 - 75 * MIN);
  });

  it('desempata pela mais antiga, sem depender da ordem de entrada', () => {
    const emp: Foto[] = [
      foto(T0 - 45 * MIN, 0.9),
      foto(T0 - 75 * MIN, 0.1),
    ];
    assert.equal(escolherAncora(emp, T0 - 60 * MIN, TOLERANCIA_MS.h1)?.mid, 0.1);
    assert.equal(escolherAncora([...emp].reverse(), T0 - 60 * MIN, TOLERANCIA_MS.h1)?.mid, 0.1);
  });

  it('série vazia não tem âncora', () => {
    assert.equal(escolherAncora([], T0 - 60 * MIN, TOLERANCIA_MS.h1), null);
  });

  it('a tolerância de 1h cobre um ciclo inteiro perdido (buraco de 30 min)', () => {
    // Dois ciclos consecutivos ausentes em volta do alvo: sobram -82,5 e -37,5.
    const fotos: Foto[] = [
      foto(T0 - 82.5 * MIN, 0.2),
      foto(T0 - 37.5 * MIN, 0.3),
    ];
    // 22,5 min de distância dos dois lados: além de ±15, então SEM âncora.
    assert.equal(escolherAncora(fotos, T0 - 60 * MIN, TOLERANCIA_MS.h1), null);

    // Com um ciclo só perdido (buraco de 30 min), a mais próxima está a 15 min
    // e a âncora existe.
    const umSo: Foto[] = [
      foto(T0 - 75 * MIN, 0.2),
      foto(T0 - 45 * MIN, 0.3),
    ];
    assert.notEqual(escolherAncora(umSo, T0 - 60 * MIN, TOLERANCIA_MS.h1), null);
  });
});

describe('variacaoComBase — mid nulo continua nulo, mas a variação não', () => {
  const A = (mid: number | null, bid: number | null, ask: number | null): Foto =>
    ({ capturedAt: T0, mid, bid, ask });
  const B = (mid: number | null, bid: number | null, ask: number | null): Foto =>
    ({ capturedAt: T0 - 60 * MIN, mid, bid, ask });

  it('mid nas duas pontas: base mid', () => {
    const r = variacaoComBase(A(0.42, 0.41, 0.43), B(0.40, 0.39, 0.41));
    assert.equal(r.base, 'mid');
    assert.ok(Math.abs((r.variacao as number) - 0.02) < 1e-9);
    assert.equal(r.ref, 0.40);
  });

  it('sem mid nas duas, com ask nas duas: base ask — o azarão que andou 2 centavos', () => {
    const r = variacaoComBase(soAsk(T0, 0.05), soAsk(T0 - 60 * MIN, 0.03));
    assert.equal(r.base, 'ask');
    assert.ok(Math.abs((r.variacao as number) - 0.02) < 1e-9);
    assert.equal(r.ref, 0.03);
  });

  it('sem mid e sem ask, com bid nas duas: base bid', () => {
    const r = variacaoComBase(soBid(T0, 0.30), soBid(T0 - 60 * MIN, 0.28));
    assert.equal(r.base, 'bid');
    assert.ok(Math.abs((r.variacao as number) - 0.02) < 1e-9);
  });

  it('mid numa ponta e ask na outra: cai para ask NAS DUAS, nunca mistura', () => {
    // Se misturasse, daria 0.42 - 0.41 = 0.01. Com ask nas duas dá 0.43 - 0.41.
    const r = variacaoComBase(A(0.42, 0.41, 0.43), B(null, null, 0.41));
    assert.equal(r.base, 'ask');
    assert.ok(Math.abs((r.variacao as number) - 0.02) < 1e-9);
    assert.equal(r.ref, 0.41);
  });

  it('ask numa ponta e bid na outra: NULO, porque não há lado comum', () => {
    const r = variacaoComBase(soAsk(T0, 0.05), soBid(T0 - 60 * MIN, 0.03));
    assert.equal(r.base, null);
    assert.equal(r.variacao, null);
    assert.equal(r.ref, null);
  });

  it('a ordem da cascata é mid, depois ask, depois bid', () => {
    // Livro completo dos dois lados: tem que escolher mid, não ask.
    const r = variacaoComBase(A(0.42, 0.41, 0.43), B(0.40, 0.39, 0.41));
    assert.equal(r.base, 'mid');
    // Sem mid, mas com os dois lados: ask ganha de bid.
    const r2 = variacaoComBase(A(null, 0.41, 0.43), B(null, 0.39, 0.41));
    assert.equal(r2.base, 'ask');
  });

  it('mesmo valor nas duas pontas dá ZERO — que é diferente de nulo', () => {
    assert.equal(variacaoComBase(soAsk(T0, 0.05), soAsk(T0 - 60 * MIN, 0.05)).variacao, 0);
  });

  it('0 é preço, não ausência', () => {
    const r = variacaoComBase(soBid(T0, 0), soBid(T0 - 60 * MIN, 0.4));
    assert.equal(r.base, 'bid');
    assert.ok(Math.abs((r.variacao as number) + 0.4) < 1e-9);
  });

  it('livro vazio dos dois lados nas duas pontas: nulo', () => {
    const r = variacaoComBase(A(null, null, null), B(null, null, null));
    assert.equal(r.base, null);
    assert.equal(r.variacao, null);
  });

  it('âncora ausente: nulo, sem exceção', () => {
    assert.equal(variacaoComBase(A(0.42, 0.41, 0.43), null).variacao, null);
    assert.equal(variacaoComBase(null, B(0.40, 0.39, 0.41)).variacao, null);
  });

  it('subtrai na ordem agora menos âncora', () => {
    const r = variacaoComBase(A(0.40, 0.39, 0.41), B(0.42, 0.41, 0.43));
    assert.ok((r.variacao as number) < 0);
  });
});

describe('lerJanelas — o alvo é a última FOTO, não o relógio', () => {
  it('ancora em agora.capturedAt, de modo que a janela medida é a janela pedida', () => {
    // Série de 8h a cada 15 min. A última foto é T0.
    const fotos = grade(33, i => 0.5 - i * 0.001);
    const r = lerJanelas(fotos);
    assert.equal(r.agora?.capturedAt, T0);
    // A âncora de 1h cai exatamente em T0 - 1h, sem desvio.
    assert.equal(r.ancoras.h1?.capturedAt, T0 - JANELA_MS.h1);
    assert.equal(r.variacoes.h1.base, 'mid');
    assert.ok(Math.abs((r.variacoes.h1.variacao as number) - 0.004) < 1e-9);
  });

  it('série curta: 1h existe, 24h e 7d não — e não viram zero', () => {
    // 10,6 h de série é o que o radar tinha em 20260814. 24h e 7d são nulos
    // porque não há dado, e nulo é a resposta certa.
    const fotos = grade(43);
    const r = lerJanelas(fotos);
    assert.notEqual(r.ancoras.h1, null);
    assert.equal(r.ancoras.h24, null);
    assert.equal(r.ancoras.d7, null);
    assert.equal(r.variacoes.h24.variacao, null);
    assert.equal(r.variacoes.d7.variacao, null);
  });

  it('livro vazio dos dois lados: âncora existe, variação é nula', () => {
    // Sem bid, sem ask e sem mid não há base nenhuma — e nulo é a resposta.
    const fotos = grade(33, () => null);
    const r = lerJanelas(fotos);
    assert.notEqual(r.agora, null);
    assert.notEqual(r.ancoras.h1, null);
    assert.equal(r.variacoes.h1.base, null);
    assert.equal(r.variacoes.h1.variacao, null);
  });

  it('livro de um lado só nas duas pontas: SEM mid, mas COM variação por ask', () => {
    // Os 123 mercados que a base alternativa recupera. `mid` continua nulo —
    // essa regra não muda — mas o movimento aparece.
    const fotos: Foto[] = [];
    for (let i = 32; i >= 0; i--) fotos.push(soAsk(T0 - i * 15 * MIN, 0.03 + (32 - i) * 0.0005));
    const r = lerJanelas(fotos);
    assert.equal(r.agora?.mid, null);
    assert.equal(r.variacoes.h1.base, 'ask');
    assert.ok((r.variacoes.h1.variacao as number) > 0);
  });

  it('âncora com livro vazio no meio de uma série cheia: variação nula', () => {
    // Um ciclo em que o livro secou dos dois lados, bem em cima da âncora de
    // 1h. Não há base comum, e o resultado é nulo — não o mid do ciclo vizinho.
    const fotos = grade(33, i => (i === 4 ? null : 0.5));
    const r = lerJanelas(fotos);
    assert.equal(r.ancoras.h1?.capturedAt, T0 - JANELA_MS.h1);
    assert.equal(r.ancoras.h1?.mid, null);
    assert.equal(r.variacoes.h1.variacao, null);
  });

  it('âncora só com ask contra agora com livro cheio: base ask nas duas', () => {
    const fotos = grade(33, () => 0.5);
    fotos[fotos.length - 5] = soAsk(T0 - JANELA_MS.h1, 0.49);
    const r = lerJanelas(fotos);
    assert.equal(r.ancoras.h1?.capturedAt, T0 - JANELA_MS.h1);
    assert.equal(r.variacoes.h1.base, 'ask');
    // agora.ask = 0.51, âncora.ask = 0.49 -> +0.02. Nunca 0.5 - 0.49 = 0.01,
    // que seria mid contra ask.
    assert.ok(Math.abs((r.variacoes.h1.variacao as number) - 0.02) < 1e-9);
    assert.equal(r.variacoes.h1.ref, 0.49);
  });

  it('mercado sem foto nenhuma: tudo nulo, e não quebra', () => {
    const r = lerJanelas([]);
    assert.equal(r.agora, null);
    assert.equal(r.ancoras.h1, null);
    assert.equal(r.variacoes.h1.variacao, null);
    assert.equal(r.variacoes.d7.variacao, null);
  });

  it('uma foto só: agora existe, nenhuma janela existe', () => {
    const r = lerJanelas([foto(T0, 0.5)]);
    assert.equal(r.agora?.mid, 0.5);
    assert.equal(r.ancoras.h1, null);
    assert.equal(r.variacoes.h1.variacao, null);
  });
});
