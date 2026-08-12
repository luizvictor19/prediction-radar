import { test } from 'node:test';
import assert from 'node:assert/strict';

/**
 * O relatório é texto, e é por texto que ele engana.
 *
 * As contas já estão cobertas em `metrics.test.ts`. O que se confere AQUI é que
 * a leitura obrigatória chegou à página: um número certo impresso sem a frase
 * que diz como lê-lo produz exatamente a decisão que o número desaconselha —
 * gap abaixo de meio spread lido como achado fraco, dentro-da-amostra lido como
 * comparável com o fora-da-amostra. Essas frases são requisito, não enfeite, e
 * por isso têm teste.
 *
 * Nada aqui toca banco: `renderReport` recebe o dataset pronto e devolve string.
 */
process.env['SUPABASE_URL'] ??= 'http://localhost:54321';
process.env['SUPABASE_SERVICE_KEY'] ??= 'test-key';

const { renderReport } = await import('./report.js');

type EvalPoint = import('./metrics.js').EvalPoint;
type EvalDataset = import('./dataset.js').EvalDataset;

function point(overrides: Partial<EvalPoint> = {}): EvalPoint {
  return {
    analysisId: 'a1',
    matchSlug: 'cs2-navi-faze-2026-08-07',
    checkpointMinutes: 360,
    asOf: '2026-08-07T12:00:00.000Z',
    model: 'claude-opus-5',
    promptVersion: 'v1',
    probability: 0.6,
    marketMid: 0.55,
    liquidity: 12_000,
    spread: 0.02,
    outcome: 1,
    ...overrides,
  };
}

function dataset(points: readonly EvalPoint[]): EvalDataset {
  return {
    points: [...points],
    excluded: {
      sem_probabilidade: 0,
      sem_desfecho: 0,
      partida_void: 0,
      analise_sem_lado: 0,
      lado_incoerente: 0,
      fora_do_filtro: 0,
      partida_ausente: 0,
    },
    abstentions: [],
    unchanged: 0,
    claims: {
      total: 0,
      withFragment: 0,
      fragmentPruned: 0,
      byEnricher: [],
      byKind: [],
      analyzedWithoutClaims: 0,
      analyzedTotal: points.length,
    },
    failures: { totalFailed: 0, byCode: [], sampledCycles: 0, truncatedCycles: 0 },
    analysesRead: points.length,
    window: { since: null, until: null, vertical: null },
  };
}

/**
 * `n` partidas distintas com o mesmo preço, `wins` delas ganhas pelo time A.
 *
 * As vitórias são DISTRIBUÍDAS ao longo do calendário, não empilhadas no começo.
 * Empilhar faria a primeira metade ser toda vitória e a segunda toda derrota, e
 * o corte por data da seção 5 mediria essa construção do fixture em vez do que o
 * teste quer medir.
 */
function matches(
  n: number,
  mid: number,
  wins: number,
  extra: Partial<EvalPoint> = {},
): EvalPoint[] {
  return Array.from({ length: n }, (_, i) =>
    point({
      analysisId: `a${i}`,
      matchSlug: `cs2-partida-${i}`,
      asOf: `2026-08-${String((i % 27) + 1).padStart(2, '0')}T12:00:00.000Z`,
      marketMid: mid,
      outcome: Math.floor(((i + 1) * wins) / n) > Math.floor((i * wins) / n) ? 1 : 0,
      ...extra,
    }),
  );
}

// ---------------------------------------------------------------------------
// Estrutura
// ---------------------------------------------------------------------------

test('as duas seções novas entram, e as antigas são renumeradas sem sumir', () => {
  const text = renderReport(dataset(matches(10, 0.6, 5)));

  for (const heading of [
    '1. Brier',
    '2. Recortes',
    '3. Calibração — ele acredita no que diz?',
    '4. Calibração do MERCADO',
    '5. AGENT_DEBIASED',
    '6. Fidelidade',
    '7. Abstenções',
    '8. Cobertura',
  ]) {
    assert.ok(text.includes(heading), `faltou a seção: ${heading}`);
  }
});

test('o relatório não quebra com amostra vazia', () => {
  const text = renderReport(dataset([]));
  assert.ok(text.includes('4. Calibração do MERCADO'));
  assert.ok(text.includes('5. AGENT_DEBIASED'));
});

// ---------------------------------------------------------------------------
// Calibração do mercado — a barra de meio spread
// ---------------------------------------------------------------------------

test('a barra é meio spread típico, e o número aparece impresso', () => {
  // Spread 0,04 em toda a amostra → barra 0,02.
  const text = renderReport(dataset(matches(10, 0.6, 5, { spread: 0.04 })));
  assert.ok(text.includes('0.0200'), 'a barra de meio spread não foi impressa');
  assert.ok(text.includes('½ de um spread típico de 0.0400'));
});

test('sem spread gravado o relatório diz que não há barra, em vez de assumir uma', () => {
  // 24 partidas: amostra bastante para concluir, e ainda assim sem barra a que
  // comparar o gap. É o caso em que o eval sabe que o mercado erra e não sabe se
  // o erro paga a travessia.
  const text = renderReport(dataset(matches(24, 0.85, 12, { spread: null })));
  assert.ok(text.includes('NÃO EXISTE nesta amostra'));
  assert.ok(text.includes('sem spread'), 'o balde devia ficar marcado como sem barra');
  assert.ok(!text.includes('CANDIDATO A EDGE'), 'sem barra não há candidato a edge');
});

test('a frase que impede a leitura errada do gap pequeno está no texto', () => {
  // O requisito operacional: gap abaixo da barra não é achado fraco, é não-achado.
  const text = renderReport(dataset(matches(10, 0.6, 5)));
  assert.ok(text.includes('academicamente interessante e operacionalmente inútil'));
  assert.ok(text.includes('não paga a travessia do book'));
  assert.ok(text.includes('atravessa o book'));
});

test('balde com menos de 20 partidas distintas sai marcado como não conclusivo', () => {
  // 19 partidas, gap enorme (previsto 0,85, observado ~0) — e ainda assim não
  // conclui: a contagem que vale é a de partidas.
  const text = renderReport(dataset(matches(19, 0.85, 0)));
  assert.ok(text.includes('não conclusivo'));
  assert.ok(!text.includes('CANDIDATO A EDGE'), 'amostra curta não pode virar candidato');
  assert.ok(text.includes('NENHUM balde é conclusivo'));
});

test('checkpoint repetido não promove um balde a conclusivo', () => {
  // 19 partidas em dois checkpoints = 38 análises e 19 desfechos. Se a marca
  // olhasse `n` em vez de partidas distintas, isto passaria por conclusivo.
  const base = matches(19, 0.85, 0);
  const duplicated = [
    ...base,
    ...base.map((p) => point({ ...p, analysisId: `${p.analysisId}-t60`, checkpointMinutes: 60 })),
  ];

  const text = renderReport(dataset(duplicated));
  assert.ok(text.includes('não conclusivo'));
  assert.ok(!text.includes('CANDIDATO A EDGE'));
});

test('balde conclusivo com gap acima da barra vira candidato a edge', () => {
  // 24 partidas a 0,85 das quais 12 ganharam: gap +0,35, contra barra de 0,01.
  const text = renderReport(dataset(matches(24, 0.85, 12)));
  assert.ok(text.includes('CANDIDATO A EDGE'));
  assert.ok(text.includes('Há balde conclusivo acima da barra'));
  // E mesmo assim exige direção repetida em faixa vizinha antes de virar decisão.
  assert.ok(text.includes('faixa vizinha'));
});

test('balde conclusivo com gap abaixo da barra é dito não-achado, não achado fraco', () => {
  // Spread 0,40 → barra 0,20. Gap de 0,05 não paga a travessia.
  const text = renderReport(dataset(matches(24, 0.55, 12, { spread: 0.4 })));
  assert.ok(text.includes('abaixo da barra'));
  assert.ok(text.includes('Nenhum balde conclusivo supera meio spread'));
});

// ---------------------------------------------------------------------------
// AGENT_DEBIASED
// ---------------------------------------------------------------------------

test('o viés do mercado é reportado ao lado do viés do agente', () => {
  const text = renderReport(dataset(matches(24, 0.85, 12)));
  assert.ok(text.includes('ANTES DE TUDO: o mercado tem o mesmo viés?'));
  assert.ok(text.includes('viés (1ª metade)'));
  assert.ok(text.includes('viés (amostra toda)'));
  assert.ok(text.includes('COMPOSIÇÃO da amostra'));
});

test('mercado com viés parecido leva o relatório a chamar a correção de ruído', () => {
  // Agente 0,85 e mercado 0,85 sobre 24 partidas com 12 vitórias: os dois erram
  // +0,35 na mesma direção. É composição da amostra, não defeito do agente.
  const text = renderReport(dataset(matches(24, 0.85, 12, { probability: 0.85 })));
  assert.ok(text.includes('o mercado tem viés parecido'));
  assert.ok(text.includes('vira ruído sintonizado'));
});

test('vieses em direções opostas sustentam a leitura contrária', () => {
  // Agente aposta alto no time A, mercado aposta baixo, e o time A ganha metade.
  const text = renderReport(dataset(matches(24, 0.2, 12, { probability: 0.85 })));
  assert.ok(text.includes('direções opostas'));
  assert.ok(text.includes('Aqui a correção mede algo do agente'));
});

test('o fora-da-amostra é o número principal e o dentro-da-amostra vem rotulado', () => {
  const text = renderReport(dataset(matches(24, 0.6, 12)));

  assert.ok(text.includes('O NÚMERO PRINCIPAL — fora da amostra'));
  assert.ok(text.includes('que não participou da estimativa'));
  assert.ok(text.includes('REFERÊNCIA — dentro da amostra (OVERFIT, NÃO COMPARÁVEL)'));
  assert.ok(text.includes('NÃO é comparável'));
  assert.ok(text.includes('só como TETO'));

  // A ordem importa tanto quanto a presença: o principal antes da referência.
  assert.ok(
    text.indexOf('O NÚMERO PRINCIPAL') < text.indexOf('REFERÊNCIA — dentro da amostra'),
    'o overfit não pode aparecer antes do fora-da-amostra',
  );
});

test('o travamento é sempre impresso, mesmo quando é zero', () => {
  const text = renderReport(dataset(matches(24, 0.6, 12)));
  assert.ok(text.includes('TRAVAMENTO'));
  assert.ok(/Pontos travados fora da amostra: \d+ de \d+/.test(text));
  assert.ok(text.includes('Travamento baixo'));
});

test('travamento alto denuncia o transformador errado e nomeia o certo', () => {
  // Previsões coladas na borda: p = 0,02 com deslocamento de 0,02 leva todo
  // ponto para fora de [0,01; 0,99].
  const text = renderReport(dataset(matches(24, 0.5, 0, { probability: 0.02 })));
  assert.ok(text.includes('TRAVAMENTO ALTO'));
  assert.ok(text.includes('transformador ERRADO'));
  assert.ok(text.includes('espaço LOGIT'));
});

test('o relatório imprime a AUSÊNCIA de vazamento, e não só a presença', () => {
  // Quatro partidas, cada uma com os dois checkpoints em `as_of` diferentes — o
  // caso que antes dividia checkpoints do mesmo desfecho entre as metades. Com o
  // corte por partida a interseção é vazia, e a confirmação vai impressa:
  // garantia que ninguém confere é garantia que volta a falhar.
  const points = [1, 2, 3, 4].flatMap((n) => [
    point({
      analysisId: `a${n}-360`,
      matchSlug: `cs2-partida-${n}`,
      asOf: `2026-08-0${n}T06:00:00.000Z`,
      checkpointMinutes: 360,
      outcome: 1,
    }),
    point({
      analysisId: `a${n}-60`,
      matchSlug: `cs2-partida-${n}`,
      asOf: `2026-08-0${n}T11:00:00.000Z`,
      checkpointMinutes: 60,
      outcome: 1,
    }),
  ]);

  const text = renderReport(dataset(points));
  assert.ok(text.includes('SEM VAZAMENTO: 0 partida(s) nas duas metades'));
  assert.ok(!text.includes('VAZAMENTO: 1 partida'));
});

test('a seção 4 avisa que a amostra é filtrada pelo portão e aponta para o eval:market', () => {
  // O "não conclusivo" da tabela salva quem lê o rodapé. Esta seção mede a
  // calibração do mercado DEPOIS do portão de liquidez, e quem bate o olho na
  // tabela precisa ver o denominador antes dos números — foi essa filtragem que
  // produziu gaps que não se reproduzem no dataset market-cêntrico.
  const text = renderReport(dataset([point()]));

  assert.ok(text.includes('FILTRADA PELO PORTÃO'));
  assert.ok(text.includes('npm run eval:market'));
  assert.ok(text.includes('no recorte que o agente vê'));
});

test('amostra indivisível não finge ter fora-da-amostra', () => {
  const text = renderReport(dataset([point()]));
  assert.ok(text.includes('Amostra pequena demais para dividir'));
  assert.ok(!text.includes('O NÚMERO PRINCIPAL'));
});

test('melhora da quarta casa decimal é dita desprezível, não "o viés sobrevive"', () => {
  // Agente a 0,52 com metade das partidas ganhas: viés de 0,02, e a correção
  // move o Brier em 0,0004. O sinal é positivo e não significa nada — é a
  // leitura errada que esta seção existe para impedir.
  const text = renderReport(dataset(matches(24, 0.5, 12, { probability: 0.52 })));
  assert.ok(text.includes('EFEITO DESPREZÍVEL'));
  assert.ok(text.includes('NÃO HÁ viés a corrigir com esta amostra'));
  assert.ok(!text.includes('O viés sobrevive à troca de período'));
});

test('efeito grande passa a ser reportado como viés que sobrevive, com a ressalva do mercado', () => {
  const text = renderReport(dataset(matches(24, 0.5, 12, { probability: 0.9 })));
  assert.ok(text.includes('O viés sobrevive à troca de período'));
  assert.ok(!text.includes('EFEITO DESPREZÍVEL'));
  // E mesmo assim continua subordinado ao veredito do mercado.
  assert.ok(text.includes('Sujeito ao veredito do mercado'));
});

test('a melhora é sempre expressa em fração do erro, não só em pontos de Brier', () => {
  const text = renderReport(dataset(matches(24, 0.6, 12)));
  assert.ok(/do erro do\n  agente cru/.test(text), 'faltou a razão contra o erro do agente cru');
});

test('versão de prompt inteira de um lado do corte é denunciada como confundimento', () => {
  // O corte por data separa versões junto com o calendário: v1 primeiro, v2
  // depois. Estimar em v1 e cobrar em v2 responde outra pergunta.
  const points = Array.from({ length: 12 }, (_, i) =>
    point({
      analysisId: `a${i}`,
      matchSlug: `cs2-partida-${i}`,
      asOf: `2026-08-${String(i + 1).padStart(2, '0')}T12:00:00.000Z`,
      promptVersion: i < 6 ? 'v1' : 'v2',
      outcome: (i % 2) as 0 | 1,
    }),
  );

  const text = renderReport(dataset(points));
  assert.ok(text.includes('CONFUNDIMENTO'));
  assert.ok(text.includes('v2 não aparece na 1ª metade'));
  assert.ok(text.includes('Versão de prompt na 1ª metade: v1×6'));
});

test('corte dentro de uma única versão não acusa confundimento', () => {
  const text = renderReport(dataset(matches(24, 0.6, 12)));
  assert.ok(text.includes('Versão de prompt na 1ª metade: v1×12'));
  assert.ok(!text.includes('CONFUNDIMENTO'));
});
