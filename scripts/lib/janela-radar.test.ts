import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { Foto } from './janela-radar.js';
import {
  escolherAncora,
  JANELA_MS,
  lerJanelas,
  TOLERANCIA_MS,
  variacao,
} from './janela-radar.js';

/** Nada aqui toca a rede: a série é montada à mão, por desenho. */

const MIN = 60_000;
const T0 = Date.parse('2026-08-14T14:00:00.000Z');

/** Uma série regular a cada 15 min, terminando em T0, todas com mid. */
function grade(fotos: number, mid: (i: number) => number | null = () => 0.5): Foto[] {
  const out: Foto[] = [];
  for (let i = fotos - 1; i >= 0; i--) {
    out.push({ capturedAt: T0 - i * 15 * MIN, mid: mid(i) });
  }
  return out;
}

describe('escolherAncora — a janela é por TEMPO, não por número de linhas', () => {
  it('pega a foto mais próxima do alvo, não a última anterior a ele', () => {
    const fotos: Foto[] = [
      { capturedAt: T0 - 70 * MIN, mid: 0.3 },
      { capturedAt: T0 - 55 * MIN, mid: 0.4 },
    ];
    // Alvo em -60: a de -55 está a 5 min, a de -70 está a 10.
    const a = escolherAncora(fotos, T0 - 60 * MIN, TOLERANCIA_MS.h1);
    assert.equal(a?.mid, 0.4);
  });

  it('devolve null quando a mais próxima está além da tolerância', () => {
    const fotos: Foto[] = [{ capturedAt: T0 - 90 * MIN, mid: 0.3 }];
    assert.equal(escolherAncora(fotos, T0 - 60 * MIN, TOLERANCIA_MS.h1), null);
  });

  it('aceita exatamente na borda da tolerância', () => {
    const fotos: Foto[] = [{ capturedAt: T0 - 75 * MIN, mid: 0.3 }];
    assert.equal(escolherAncora(fotos, T0 - 60 * MIN, TOLERANCIA_MS.h1)?.mid, 0.3);
  });

  it('um buraco na série NÃO faz a âncora escorregar para outra distância', () => {
    // O caso que "N fotos atrás" erra: falta o ciclo de -60, e contar 4 linhas
    // para trás a partir de T0 entregaria a de -75 achando que é a de -60.
    // Aqui a de -75 é entregue SABENDO que ela é a de -75 — span_1h_min = 75 —
    // e a de -45 é entregue quando está mais perto.
    const semSessenta: Foto[] = [
      { capturedAt: T0 - 75 * MIN, mid: 0.20 },
      { capturedAt: T0 - 45 * MIN, mid: 0.25 },
      { capturedAt: T0 - 30 * MIN, mid: 0.30 },
      { capturedAt: T0 - 15 * MIN, mid: 0.35 },
      { capturedAt: T0, mid: 0.40 },
    ];
    const a = escolherAncora(semSessenta, T0 - 60 * MIN, TOLERANCIA_MS.h1);
    // Empate real: -75 e -45 estão as duas a 15 min do alvo. Desempata pela
    // mais antiga, igual ao `order by abs(...), s.captured_at` do SQL.
    assert.equal(a?.capturedAt, T0 - 75 * MIN);
  });

  it('desempata pela mais antiga, sem depender da ordem de entrada', () => {
    const emp: Foto[] = [
      { capturedAt: T0 - 45 * MIN, mid: 0.9 },
      { capturedAt: T0 - 75 * MIN, mid: 0.1 },
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
      { capturedAt: T0 - 82.5 * MIN, mid: 0.2 },
      { capturedAt: T0 - 37.5 * MIN, mid: 0.3 },
    ];
    // 22,5 min de distância dos dois lados: além de ±15, então SEM âncora.
    assert.equal(escolherAncora(fotos, T0 - 60 * MIN, TOLERANCIA_MS.h1), null);

    // Com um ciclo só perdido (buraco de 30 min), a mais próxima está a 15 min
    // e a âncora existe.
    const umSo: Foto[] = [
      { capturedAt: T0 - 75 * MIN, mid: 0.2 },
      { capturedAt: T0 - 45 * MIN, mid: 0.3 },
    ];
    assert.notEqual(escolherAncora(umSo, T0 - 60 * MIN, TOLERANCIA_MS.h1), null);
  });
});

describe('variacao — mid nulo continua nulo', () => {
  it('mid de agora nulo dá variação nula, nunca zero', () => {
    assert.equal(variacao(null, 0.4), null);
  });

  it('mid da âncora nulo dá variação nula, nunca zero', () => {
    assert.equal(variacao(0.4, null), null);
  });

  it('os dois nulos dão nulo', () => {
    assert.equal(variacao(null, null), null);
  });

  it('mid igual dos dois lados dá ZERO — que é diferente de nulo', () => {
    assert.equal(variacao(0.4, 0.4), 0);
  });

  it('mid 0 é preço, não ausência', () => {
    assert.equal(variacao(0, 0.4), -0.4);
  });

  it('subtrai na ordem agora menos âncora', () => {
    assert.equal(Math.round((variacao(0.42, 0.40) as number) * 100) / 100, 0.02);
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
    assert.ok(Math.abs((r.variacoes.h1 as number) - 0.004) < 1e-9);
  });

  it('série curta: 1h existe, 24h e 7d não — e não viram zero', () => {
    // 10,6 h de série é o que o radar tinha em 20260814. 24h e 7d são nulos
    // porque não há dado, e nulo é a resposta certa.
    const fotos = grade(43);
    const r = lerJanelas(fotos);
    assert.notEqual(r.ancoras.h1, null);
    assert.equal(r.ancoras.h24, null);
    assert.equal(r.ancoras.d7, null);
    assert.equal(r.variacoes.h24, null);
    assert.equal(r.variacoes.d7, null);
  });

  it('mercado com foto mas sem mid: âncora existe, variação é nula', () => {
    // Os 119 mercados de livro de um lado só. A âncora é achada — a série está
    // lá — mas a variação não pode ser calculada, e não vira zero.
    const fotos = grade(33, () => null);
    const r = lerJanelas(fotos);
    assert.notEqual(r.agora, null);
    assert.notEqual(r.ancoras.h1, null);
    assert.equal(r.variacoes.h1, null);
  });

  it('mid que aparece e some no meio da série não contamina a variação', () => {
    // mid nulo só na âncora de 1h.
    const fotos = grade(33, i => (i === 4 ? null : 0.5));
    const r = lerJanelas(fotos);
    assert.equal(r.ancoras.h1?.capturedAt, T0 - JANELA_MS.h1);
    assert.equal(r.ancoras.h1?.mid, null);
    assert.equal(r.variacoes.h1, null);
  });

  it('mercado sem foto nenhuma: tudo nulo, e não quebra', () => {
    const r = lerJanelas([]);
    assert.equal(r.agora, null);
    assert.equal(r.ancoras.h1, null);
    assert.equal(r.variacoes.h1, null);
    assert.equal(r.variacoes.d7, null);
  });

  it('uma foto só: agora existe, nenhuma janela existe', () => {
    const r = lerJanelas([{ capturedAt: T0, mid: 0.5 }]);
    assert.equal(r.agora?.mid, 0.5);
    assert.equal(r.ancoras.h1, null);
    assert.equal(r.variacoes.h1, null);
  });
});
