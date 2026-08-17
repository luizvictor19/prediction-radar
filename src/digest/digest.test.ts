import { test } from 'node:test';
import assert from 'node:assert/strict';

// Nada aqui toca rede: as funções de validação são puras e `runDigest` recebe um
// cliente falso pela interface de `src/llm/client.ts`. O que se testa é o
// guardrail — a validação que decide se uma resposta vira linha ou vira erro.
process.env['SUPABASE_URL'] ??= 'http://localhost:54321';
process.env['SUPABASE_SERVICE_KEY'] ??= 'test-key';

const {
  parseDigest,
  detectarOpiniao,
  estimateCostUsd,
  estimateOne,
  hashDescription,
  knownModel,
  runDigest,
  DigestError,
} = await import('./digest.js');

type LlmClient = import('../llm/client.js').LlmClient;
type CompletionResult = import('../llm/client.js').CompletionResult;
type DigestOutput = import('./digest.js').DigestOutput;
type DigestInput = import('./prompts.js').DigestInput;

// ---------------------------------------------------------------------------
// Material de teste
// ---------------------------------------------------------------------------

const REGRA_BOA = {
  resolve_sim: [
    'O Federal Reserve anunciar corte de pelo menos 0,25 ponto percentual na reunião de setembro de 2026.',
  ],
  resolve_nao: ['Qualquer outro desfecho, inclusive manutenção da taxa.'],
  fonte: 'Comunicado oficial do FOMC publicado em federalreserve.gov',
  anula_se: ['A reunião for cancelada e não remarcada até 31/12/2026.'],
  prazo: '30 de setembro de 2026, 23h59 ET',
  pegadinhas: [
    'Vazamento à imprensa antes do comunicado parece contar e não conta: a regra exige o comunicado oficial.',
    'Corte anunciado em reunião extraordinária não conta — a regra nomeia a reunião de setembro.',
  ],
  ambiguidades: [
    '"pelo menos 0,25 ponto" não diz se corte de 0,125 arredondado para cima conta.',
  ],
};

function outputFrom(raw: Record<string, unknown>): DigestOutput {
  return parseDigest(raw).output;
}

const INPUT: DigestInput = {
  question: 'Will the Fed cut rates in September 2026?',
  description: 'This market will resolve YES if the FOMC announces a cut of at least 25bps.',
  slug: 'fed-cut-september-2026',
  endDate: '2026-09-30T23:59:00Z',
  outcomes: ['Yes', 'No'],
};

function fakeClient(result: Partial<CompletionResult> & { text: string | null }): LlmClient {
  return {
    complete: async () => ({
      text: result.text,
      stop: result.stop ?? 'ok',
      usage: result.usage ?? { input: 1200, output: 600, cacheRead: 0, cacheWrite: 0 },
    }),
  };
}

// ---------------------------------------------------------------------------
// A forma
// ---------------------------------------------------------------------------

test('parseDigest aceita uma digestão completa', () => {
  const out = outputFrom(REGRA_BOA);
  assert.equal(out.resolveSim.length, 1);
  assert.equal(out.fonte, 'Comunicado oficial do FOMC publicado em federalreserve.gov');
  assert.equal(out.pegadinhas.length, 2);
  assert.equal(out.ambiguidades.length, 1);
});

test('parseDigest aceita listas vazias em pegadinhas e ambiguidades', () => {
  // Regra direta existe, e exigir o campo cheio mandaria o modelo inventar —
  // que é pior que o campo vazio, porque um item inventado não se distingue de
  // um item verdadeiro na leitura.
  const out = outputFrom({ ...REGRA_BOA, pegadinhas: [], ambiguidades: [] });
  assert.deepEqual(out.pegadinhas, []);
  assert.deepEqual(out.ambiguidades, []);
});

test('parseDigest aceita fonte e prazo nulos', () => {
  const out = outputFrom({ ...REGRA_BOA, fonte: null, prazo: null });
  assert.equal(out.fonte, null);
  assert.equal(out.prazo, null);
});

test('parseDigest normaliza string vazia para null', () => {
  const out = outputFrom({ ...REGRA_BOA, fonte: '   ' });
  assert.equal(out.fonte, null);
});

test('parseDigest recusa resposta sem condição de SIM', () => {
  assert.throws(
    () => outputFrom({ ...REGRA_BOA, resolve_sim: [] }),
    (err: unknown) => err instanceof DigestError && err.code === 'sem_resolve_sim',
  );
});

test('parseDigest recusa campo com tipo errado', () => {
  assert.throws(
    () => outputFrom({ ...REGRA_BOA, anula_se: 'nenhuma' }),
    (err: unknown) => err instanceof DigestError && err.code === 'schema',
  );
});

// ---------------------------------------------------------------------------
// A regra que não se quebra
// ---------------------------------------------------------------------------

test('a saída é RECUSADA quando contém probabilidade', () => {
  // Este é o teste que o componente existe para passar. O dono vai anotar a
  // própria probabilidade nestes mercados por dois meses; um número da IA na
  // tela antes disso ancora a estimativa e a medição deixa de responder nada.
  const comProbabilidade = {
    ...REGRA_BOA,
    ambiguidades: [
      ...REGRA_BOA.ambiguidades,
      'A probabilidade de a condição se realizar é alta dado o histórico recente.',
    ],
  };

  assert.throws(
    () => outputFrom(comProbabilidade),
    (err: unknown) => err instanceof DigestError && err.code === 'opiniao',
  );
});

test('a saída é RECUSADA quando contém recomendação', () => {
  const comRecomendacao = {
    ...REGRA_BOA,
    pegadinhas: [...REGRA_BOA.pegadinhas, 'Recomendo atenção: o preço parece barato para o risco.'],
  };

  assert.throws(
    () => outputFrom(comRecomendacao),
    (err: unknown) => err instanceof DigestError && err.code === 'opiniao',
  );
});

test('a recusa por opinião vale em QUALQUER campo, inclusive fonte e prazo', () => {
  for (const campo of ['fonte', 'prazo'] as const) {
    assert.throws(
      () => outputFrom({ ...REGRA_BOA, [campo]: 'provavelmente o FOMC' }),
      (err: unknown) => err instanceof DigestError && err.code === 'opiniao',
      `campo ${campo} passou`,
    );
  }
});

test('detectarOpiniao aponta o campo e o termo', () => {
  const out = outputFrom(REGRA_BOA);
  const sujo: DigestOutput = {
    ...out,
    pegadinhas: [
      { texto: 'boa oportunidade de entrada aqui', severidade: null, trecho: null, cenario: null },
    ],
  };

  const hit = detectarOpiniao(sujo);
  assert.notEqual(hit, null);
  assert.equal(hit?.field, 'pegadinhas');
  assert.equal(hit?.term, 'oportunidade');
});

test('números, percentuais e "venda" NÃO são opinião', () => {
  // A lista não pode banir dígito: a regra extraída é feita de números. E não
  // pode banir "venda" — "vendeu até 31 de maio" é o texto exato do caso de
  // US$ 60 milhões que motivou este componente. Bani-lo rejeitaria o exemplo
  // canônico da própria tese.
  const numerica = {
    ...REGRA_BOA,
    resolve_sim: [
      'A inflação anual medida pelo CPI ficar acima de 3,5% em dezembro.',
      'A empresa registrar a venda de pelo menos US$ 100 bilhões até 31 de maio.',
    ],
    ambiguidades: [
      '"vendeu até 31 de maio" pode significar a venda ou a divulgação dela — o texto não desempata.',
    ],
  };

  const out = outputFrom(numerica);
  assert.equal(detectarOpiniao(out), null);
  assert.equal(out.resolveSim.length, 2);
});

// ---------------------------------------------------------------------------
// v2 — severidade, tipo, e as duas leituras
// ---------------------------------------------------------------------------

const REGRA_V2 = {
  ...REGRA_BOA,
  pegadinhas: [
    {
      texto: 'Resolve NÃO na eliminação matemática, antes do fim da temporada.',
      severidade: 'muda_timing',
    },
    {
      texto: 'A Guarda Costeira Japonesa não é força militar; a Chinesa conta.',
      severidade: 'muda_resultado',
    },
  ],
  ambiguidades: [
    {
      tipo: 'fuso_ausente',
      trecho: 'March 31, 2027, 11:59 PM ET',
      leitura_a: 'ET como Eastern Standard Time (UTC-5).',
      leitura_b: 'ET como Eastern Daylight Time (UTC-4).',
    },
  ],
};

test('parseDigest v1 e v2 produzem o MESMO tipo de saída', () => {
  // A v1 não pedia severidade nem tipo. Elas viram `null` — AUSENTE, não
  // "detalhe" e não "outro". Contar as v1 como detalhe inflaria a categoria mais
  // fraca com material que nunca foi classificado.
  const v1 = parseDigest(REGRA_BOA, 'v1').output;
  assert.equal(v1.pegadinhas[0]?.severidade, null);
  assert.equal(v1.ambiguidades[0]?.tipo, null);
  assert.equal(v1.ambiguidades[0]?.trecho, null);
  assert.equal(v1.ambiguidades[0]?.leituraB, null);
  assert.equal(typeof v1.pegadinhas[0]?.texto, 'string');

  const v2 = parseDigest(REGRA_V2, 'v2').output;
  assert.equal(v2.pegadinhas[0]?.severidade, 'muda_timing');
  assert.equal(v2.ambiguidades[0]?.tipo, 'fuso_ausente');
  assert.equal(v2.ambiguidades[0]?.trecho, 'March 31, 2027, 11:59 PM ET');
  assert.equal(v2.ambiguidades[0]?.leituraB, 'ET como Eastern Daylight Time (UTC-4).');
});

test('v2 aceita zero pegadinhas — regra direta é resposta, não falha', () => {
  const out = parseDigest({ ...REGRA_V2, pegadinhas: [] }, 'v2').output;
  assert.deepEqual(out.pegadinhas, []);
});

test('v2 recusa severidade fora da lista fechada', () => {
  const forjada = {
    ...REGRA_V2,
    pegadinhas: [{ texto: 'algo', severidade: 'importante' }],
  };
  assert.throws(
    () => parseDigest(forjada, 'v2'),
    (err: unknown) => err instanceof DigestError && err.code === 'severidade_invalida',
  );
});

test('v2 recusa tipo de ambiguidade fora da lista fechada', () => {
  const forjada = {
    ...REGRA_V2,
    ambiguidades: [
      { tipo: 'confuso', trecho: 'x', leitura_a: 'a', leitura_b: 'b' },
    ],
  };
  assert.throws(
    () => parseDigest(forjada, 'v2'),
    (err: unknown) => err instanceof DigestError && err.code === 'tipo_invalido',
  );
});

test('v2 exige o trecho e as DUAS leituras', () => {
  // Sem trecho a categoria é uma afirmação sobre a regra que ninguém confere.
  // Sem a segunda leitura, o campo volta a ser o texto solto da v1 — e é o
  // formato de duas leituras que impede o modelo de dizer qual vence.
  for (const faltando of ['trecho', 'leitura_a', 'leitura_b'] as const) {
    const amb: Record<string, unknown> = {
      tipo: 'data_ambigua',
      trecho: 'x',
      leitura_a: 'a',
      leitura_b: 'b',
    };
    delete amb[faltando];
    assert.throws(
      () => parseDigest({ ...REGRA_V2, ambiguidades: [amb] }, 'v2'),
      (err: unknown) => err instanceof DigestError && err.code === 'schema',
      `faltando ${faltando} passou`,
    );
  }
});

test('a trava da opinião vale nas duas leituras da v2', () => {
  const opinando = {
    ...REGRA_V2,
    ambiguidades: [
      {
        tipo: 'data_ambigua',
        trecho: 'until May 31',
        leitura_a: 'a venda em si — leitura mais provável.',
        leitura_b: 'a divulgação da venda.',
      },
    ],
  };
  assert.throws(
    () => parseDigest(opinando, 'v2'),
    (err: unknown) => err instanceof DigestError && err.code === 'opiniao',
  );
});

test('a trava NÃO varre o trecho — ele é cópia literal da regra', () => {
  // Uma regra de terceiro que use a palavra "provável" faria a trava recusar a
  // digestão por causa do texto que ela está extraindo. O que o modelo escreve
  // continua todo varrido.
  const trechoComPalavraProibida = {
    ...REGRA_V2,
    ambiguidades: [
      {
        tipo: 'outro',
        trecho: 'the most probable outcome as determined by provável consenso',
        leitura_a: 'o critério é o consenso da imprensa.',
        leitura_b: 'o critério é a decisão do administrador.',
      },
    ],
  };
  const out = parseDigest(trechoComPalavraProibida, 'v2').output;
  assert.equal(out.ambiguidades.length, 1);
});

// ---------------------------------------------------------------------------
// v3 — mecanismo no lugar de instrução
// ---------------------------------------------------------------------------

const REGRA_TEXTO =
  'This market will resolve YES if the closing price is higher than $76,000 as of market close ' +
  'on August 15, 2026, 11:59 PM ET. The resolution source will be a consensus of credible reporting.';

function comPegadinhas(pegadinhas: unknown[]): Record<string, unknown> {
  return { ...REGRA_BOA, pegadinhas, ambiguidades: [] };
}

const PEGADINHA_BOA = {
  texto: 'Fechamento exatamente em US$ 76.000 resolve NÃO — a regra diz "higher than".',
  trecho: 'higher than $76,000',
  severidade: 'muda_resultado',
  cenario: 'Se o fechamento for exatamente US$ 76.000, quem leu o título espera SIM e a regra dá NÃO.',
};

test('v3 mantém a pegadinha cujo trecho está na regra', () => {
  const parsed = parseDigest(comPegadinhas([PEGADINHA_BOA]), 'v3', REGRA_TEXTO);
  assert.equal(parsed.output.pegadinhas.length, 1);
  assert.equal(parsed.output.pegadinhas[0]?.severidade, 'muda_resultado');
  assert.equal(parsed.descartes.trechoInexistente, 0);
});

test('v3 DESCARTA a pegadinha cujo trecho não está na regra', () => {
  // O enchimento morre por falta de fonte, não por instrução: não existe
  // passagem da regra que sustente "market cap não é receita".
  const inventada = {
    texto: "Pode parecer que 'maior empresa' é receita, mas a regra diz market cap.",
    trecho: 'largest company by revenue',
    severidade: 'detalhe',
    cenario: null,
  };

  const parsed = parseDigest(comPegadinhas([PEGADINHA_BOA, inventada]), 'v3', REGRA_TEXTO);
  assert.equal(parsed.output.pegadinhas.length, 1);
  assert.equal(parsed.descartes.trechoInexistente, 1);
  assert.equal(parsed.descartes.amostras[0]?.motivo, 'trecho não está na regra');
});

test('v3 descarta trecho curto demais — senão o mecanismo se anula', () => {
  // "the" é substring de toda descrição em inglês. Sem piso, uma pegadinha
  // ancorada em "the" passa na conferência sem estar ancorada em nada.
  const ancorada_em_nada = { ...PEGADINHA_BOA, trecho: 'the' };
  const parsed = parseDigest(comPegadinhas([ancorada_em_nada]), 'v3', REGRA_TEXTO);
  assert.equal(parsed.output.pegadinhas.length, 0);
  assert.equal(parsed.descartes.trechoCurto, 1);
});

test('v3 colapsa duas pegadinhas que citam o mesmo trecho, mantendo a mais específica', () => {
  const generica = { ...PEGADINHA_BOA, texto: 'O limiar é exclusivo.' };
  const parsed = parseDigest(comPegadinhas([generica, PEGADINHA_BOA]), 'v3', REGRA_TEXTO);

  assert.equal(parsed.output.pegadinhas.length, 1);
  assert.equal(parsed.output.pegadinhas[0]?.texto, PEGADINHA_BOA.texto);
  assert.equal(parsed.descartes.trechoRepetido, 1);
});

test('v3 tolera aspas tipográficas e espaço, não tolera paráfrase', () => {
  // Descrição com aspas curvas; o modelo copia com aspas retas e espaço duplo.
  const descricaoCurva = 'The market resolves on the “official close”  of the NYSE session.';

  const copiaFiel = { ...PEGADINHA_BOA, trecho: 'the "official close" of the NYSE' };
  const ok = parseDigest(comPegadinhas([copiaFiel]), 'v3', descricaoCurva);
  assert.equal(ok.output.pegadinhas.length, 1);

  const parafrase = { ...PEGADINHA_BOA, trecho: 'o fechamento oficial da NYSE' };
  const podada = parseDigest(comPegadinhas([parafrase]), 'v3', descricaoCurva);
  assert.equal(podada.output.pegadinhas.length, 0);
  assert.equal(podada.descartes.trechoInexistente, 1);
});

test('v3 REBAIXA para detalhe a severidade forte sem cenário', () => {
  // Quando o nível mais forte não custa nada, o nível mais forte é o que sai.
  // O cenário é o custo, e a queda é em código — não é pedido ao modelo.
  const semCenario = { ...PEGADINHA_BOA, cenario: null };
  const parsed = parseDigest(comPegadinhas([semCenario]), 'v3', REGRA_TEXTO);

  assert.equal(parsed.output.pegadinhas[0]?.severidade, 'detalhe');
  assert.equal(parsed.descartes.severidadeRebaixada, 1);
});

test('v3 rebaixa muda_timing sem cenário também', () => {
  const semCenario = { ...PEGADINHA_BOA, severidade: 'muda_timing', cenario: '  ' };
  const parsed = parseDigest(comPegadinhas([semCenario]), 'v3', REGRA_TEXTO);
  assert.equal(parsed.output.pegadinhas[0]?.severidade, 'detalhe');
  assert.equal(parsed.descartes.severidadeRebaixada, 1);
});

test('v3 não rebaixa detalhe — ele nunca precisou de cenário', () => {
  const detalhe = { ...PEGADINHA_BOA, severidade: 'detalhe', cenario: null };
  const parsed = parseDigest(comPegadinhas([detalhe]), 'v3', REGRA_TEXTO);
  assert.equal(parsed.output.pegadinhas[0]?.severidade, 'detalhe');
  assert.equal(parsed.descartes.severidadeRebaixada, 0);
});

test('a poda preserva a ordem original das que sobrevivem', () => {
  // O primeiro item de uma lista costuma ser o mais forte, e essa hipótese só
  // se mede se a ordem não for embaralhada pela poda.
  const primeira = { ...PEGADINHA_BOA, texto: 'Primeira.', trecho: 'higher than $76,000' };
  const morta = { ...PEGADINHA_BOA, texto: 'Morta.', trecho: 'nada disso existe no texto' };
  const ultima = { ...PEGADINHA_BOA, texto: 'Última.', trecho: 'consensus of credible reporting' };

  const parsed = parseDigest(comPegadinhas([primeira, morta, ultima]), 'v3', REGRA_TEXTO);
  assert.deepEqual(
    parsed.output.pegadinhas.map(p => p.texto),
    ['Primeira.', 'Última.'],
  );
});

test('momento_ambiguo vale na v3 e NÃO vale na v2', () => {
  // A lista da v2 não é editada: aquele schema ofereceu oito valores, e aceitar
  // um nono agora faria a taxa de `outro` daquela rodada significar outra coisa.
  const amb = {
    tipo: 'momento_ambiguo',
    trecho: 'as of market close',
    leitura_a: 'o fechamento da bolsa onde o ativo é listado.',
    leitura_b: 'um horário de referência global.',
  };

  const naV3 = parseDigest({ ...REGRA_BOA, pegadinhas: [], ambiguidades: [amb] }, 'v3', REGRA_TEXTO);
  assert.equal(naV3.output.ambiguidades[0]?.tipo, 'momento_ambiguo');

  assert.throws(
    () => parseDigest({ ...REGRA_V2, ambiguidades: [amb] }, 'v2'),
    (err: unknown) => err instanceof DigestError && err.code === 'tipo_invalido',
  );
});

// ---------------------------------------------------------------------------
// v4 — a lista fechada que fecha, e os dois trechos da contradição
// ---------------------------------------------------------------------------

/**
 * A regra que se contradiz, com as duas passagens literais dentro.
 *
 * É o caso real do mercado "Trump out as President": "for any period of time"
 * três parágrafos acima de "Only permanent removal from office will qualify".
 * Um afastamento temporário resolve SIM pela primeira e NÃO pela segunda.
 */
const REGRA_CONTRADITORIA =
  'This market will resolve YES if Donald Trump ceases to be the President of the United States ' +
  'for any period of time by August 31, 2026. Only permanent removal from office will qualify.';

const CONTRADICAO = {
  tipo: 'contradicao_interna',
  trecho: 'for any period of time',
  trecho_conflito: 'Only permanent removal from office will qualify',
  leitura_a: 'Qualquer interrupção, mesmo temporária, satisfaz a condição.',
  leitura_b: 'Apenas a saída definitiva do cargo satisfaz a condição.',
};

function comAmbiguidades(ambiguidades: unknown[]): Record<string, unknown> {
  return { ...REGRA_BOA, pegadinhas: [], ambiguidades };
}

test('v4 aceita os três tipos novos, e a v3 recusa os três', () => {
  // A lista da v3 não é editada pelo mesmo motivo que a da v2 não foi: aquele
  // schema ofereceu nove valores, e a taxa de `outro` de 30,4% da rodada dela é
  // sobre os nove. Aceitar um décimo agora faria aquele número medir outra coisa.
  const novos = [
    { tipo: 'precedencia_de_fonte', trecho: 'consensus of credible reporting' },
    { tipo: 'criterio_discricionario', trecho: 'consensus of credible reporting' },
  ];

  for (const { tipo, trecho } of novos) {
    const amb = { tipo, trecho, leitura_a: 'Uma rota.', leitura_b: 'Outra rota.' };

    const naV4 = parseDigest(comAmbiguidades([amb]), 'v4', REGRA_TEXTO);
    assert.equal(naV4.output.ambiguidades[0]?.tipo, tipo);

    assert.throws(
      () => parseDigest(comAmbiguidades([amb]), 'v3', REGRA_TEXTO),
      (err: unknown) => err instanceof DigestError && err.code === 'tipo_invalido',
    );
  }

  const naV4 = parseDigest(comAmbiguidades([CONTRADICAO]), 'v4', REGRA_CONTRADITORIA);
  assert.equal(naV4.output.ambiguidades[0]?.tipo, 'contradicao_interna');

  assert.throws(
    () => parseDigest(comAmbiguidades([CONTRADICAO]), 'v3', REGRA_CONTRADITORIA),
    (err: unknown) => err instanceof DigestError && err.code === 'tipo_invalido',
  );
});

test('v4 guarda as DUAS passagens da contradição', () => {
  const parsed = parseDigest(comAmbiguidades([CONTRADICAO]), 'v4', REGRA_CONTRADITORIA);
  const amb = parsed.output.ambiguidades[0];

  assert.equal(amb?.trecho, 'for any period of time');
  assert.equal(amb?.trechoConflito, 'Only permanent removal from office will qualify');
  assert.equal(parsed.descartes.contradicaoSemSegundoTrecho, 0);
  assert.equal(parsed.descartes.contradicaoNaoAncorada, 0);
});

test('v4 DESCARTA a contradição que veio com uma passagem só', () => {
  // Com um campo de trecho só, o modelo cita uma passagem e descreve a outra em
  // prosa — e aí a afirmação "estas duas se contradizem" deixa de ser conferível.
  const meia = { ...CONTRADICAO, trecho_conflito: null };
  const parsed = parseDigest(comAmbiguidades([meia]), 'v4', REGRA_CONTRADITORIA);

  assert.equal(parsed.output.ambiguidades.length, 0);
  assert.equal(parsed.descartes.contradicaoSemSegundoTrecho, 1);
  assert.equal(
    parsed.descartes.amostrasAmbiguidade[0]?.motivo,
    'contradição sem a segunda passagem',
  );
});

test('v4 DESCARTA a contradição cujo segundo trecho não está na regra', () => {
  const inventada = { ...CONTRADICAO, trecho_conflito: 'removal requires a Senate conviction' };
  const parsed = parseDigest(comAmbiguidades([inventada]), 'v4', REGRA_CONTRADITORIA);

  assert.equal(parsed.output.ambiguidades.length, 0);
  assert.equal(parsed.descartes.contradicaoNaoAncorada, 1);
});

test('v4 descarta a contradição ancorada em trecho curto demais', () => {
  // Mesmo motivo do piso das pegadinhas: "the" é substring de toda descrição em
  // inglês, e uma contradição ancorada em "the" passa sem estar ancorada em nada.
  const curta = { ...CONTRADICAO, trecho_conflito: 'the' };
  const parsed = parseDigest(comAmbiguidades([curta]), 'v4', REGRA_CONTRADITORIA);

  assert.equal(parsed.output.ambiguidades.length, 0);
  assert.equal(parsed.descartes.contradicaoNaoAncorada, 1);
});

test('a contradição podada leva só a si mesma — o resto da digestão vive', () => {
  // Mesma regra da poda de pegadinhas: derrubar a digestão inteira por causa de
  // um item jogaria fora o material bom junto com o que não se sustentou.
  const meia = { ...CONTRADICAO, trecho_conflito: null };
  const boa = {
    tipo: 'fuso_ausente',
    trecho: 'August 31, 2026',
    leitura_a: 'ET como Eastern Standard Time.',
    leitura_b: 'ET como Eastern Daylight Time.',
  };

  const parsed = parseDigest(comAmbiguidades([meia, boa]), 'v4', REGRA_CONTRADITORIA);
  assert.equal(parsed.output.ambiguidades.length, 1);
  assert.equal(parsed.output.ambiguidades[0]?.tipo, 'fuso_ausente');
  assert.equal(parsed.output.resolveSim.length, REGRA_BOA.resolve_sim.length);
});

test('trecho_conflito fora de contradicao_interna vira null', () => {
  // O CHECK da migration exige NULL em todo tipo que não seja contradição:
  // deixar passar um segundo trecho decorativo em `fonte_vaga` faria o insert
  // falhar no meio do laço, longe de onde o defeito nasceu.
  const decorativo = {
    tipo: 'fonte_vaga',
    trecho: 'consensus of credible reporting',
    trecho_conflito: 'higher than $76,000',
    leitura_a: 'Uma leitura.',
    leitura_b: 'Outra leitura.',
  };

  const parsed = parseDigest(comAmbiguidades([decorativo]), 'v4', REGRA_TEXTO);
  assert.equal(parsed.output.ambiguidades[0]?.trechoConflito, null);
});

test('a conferência verbatim é SÓ de contradicao_interna, e isso é recorte, não esquecimento', () => {
  // As outras onze categorias apontam UMA passagem e dizem que ela admite duas
  // leituras — e o formato de duas leituras já impede o modelo de decidir por
  // conta. Só a contradição afirma algo sobre duas passagens ao mesmo tempo.
  const parafraseada = {
    tipo: 'fonte_vaga',
    trecho: 'consenso de reportagens confiáveis',
    leitura_a: 'Uma leitura.',
    leitura_b: 'Outra leitura.',
  };

  const parsed = parseDigest(comAmbiguidades([parafraseada]), 'v4', REGRA_TEXTO);
  assert.equal(parsed.output.ambiguidades.length, 1);
});

test('a trava de opinião não varre nenhum dos dois trechos', () => {
  // Os dois são cópia literal da regra, escrita por terceiro. Uma regra que use
  // "provável" faria a trava recusar a digestão pelo texto que ela extrai.
  const regra =
    'The market resolves to the most provável outcome for any period of time. ' +
    'Only the dificilmente disputed reading will qualify.';
  const amb = {
    tipo: 'contradicao_interna',
    trecho: 'the most provável outcome for any period of time',
    trecho_conflito: 'Only the dificilmente disputed reading will qualify',
    leitura_a: 'Uma leitura.',
    leitura_b: 'Outra leitura.',
  };

  const parsed = parseDigest(comAmbiguidades([amb]), 'v4', regra);
  assert.equal(parsed.output.ambiguidades.length, 1);
});

// ---------------------------------------------------------------------------
// Preço, hash e estimativa
// ---------------------------------------------------------------------------

test('knownModel recusa os modelos aposentados em 24/07/2026', () => {
  assert.equal(knownModel('deepseek-v4-flash'), true);
  assert.equal(knownModel('deepseek-v4-pro'), true);
  assert.equal(knownModel('deepseek-chat'), false);
  assert.equal(knownModel('deepseek-reasoner'), false);
});

test('estimateCostUsd soma entrada, saída e cache', () => {
  const custo = estimateCostUsd('deepseek-v4-flash', {
    input: 1_000_000,
    output: 1_000_000,
    cacheRead: 0,
    cacheWrite: 0,
  });
  assert.equal(custo, 0.42); // 0,14 + 0,28

  const comCache = estimateCostUsd('deepseek-v4-flash', {
    input: 0,
    output: 0,
    cacheRead: 1_000_000,
    cacheWrite: 0,
  });
  assert.equal(comCache, 0.014); // 0,1x a entrada
});

test('estimateCostUsd devolve null para modelo sem preço', () => {
  assert.equal(
    estimateCostUsd('deepseek-chat', { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }),
    null,
  );
});

test('estimateOne conta o system prompt, não só a descrição', () => {
  const curta = estimateOne('deepseek-v4-flash', 'v1', { ...INPUT, description: 'x' });
  assert.notEqual(curta, null);
  // O system prompt sozinho passa de mil tokens; uma estimativa que só olhasse
  // a descrição diria quase zero aqui e subestimaria o laço inteiro.
  assert.ok((curta?.inputTokens ?? 0) > 500, `inputTokens=${curta?.inputTokens}`);

  const longa = estimateOne('deepseek-v4-flash', 'v1', {
    ...INPUT,
    description: 'x'.repeat(4000),
  });
  assert.ok((longa?.inputTokens ?? 0) > (curta?.inputTokens ?? 0));
});

test('estimateOne devolve null para modelo ou prompt desconhecido', () => {
  assert.equal(estimateOne('deepseek-chat', 'v1', INPUT), null);
  assert.equal(estimateOne('deepseek-v4-flash', 'v99', INPUT), null);
});

test('hashDescription muda quando o texto muda', () => {
  const a = hashDescription('regra original');
  const b = hashDescription('regra original.');
  assert.equal(a, hashDescription('regra original'));
  assert.notEqual(a, b);
  assert.equal(a.length, 64);
});

// ---------------------------------------------------------------------------
// A chamada
// ---------------------------------------------------------------------------

test('runDigest devolve saída, custo e o hash da descrição', async () => {
  const result = await runDigest({
    model: 'deepseek-v4-flash',
    promptVersion: 'v1',
    timeoutMs: 1000,
    input: INPUT,
    client: fakeClient({ text: JSON.stringify(REGRA_BOA) }),
  });

  assert.equal(result.output.resolveSim.length, 1);
  assert.equal(result.descriptionSha256, hashDescription(INPUT.description));
  assert.ok((result.costUsd ?? 0) > 0);
  assert.ok(result.prompt.user.includes(INPUT.description));
});

test('runDigest para em modelo sem preço, ANTES de chamar', async () => {
  let chamou = false;
  const client: LlmClient = {
    complete: async () => {
      chamou = true;
      throw new Error('não deveria chegar aqui');
    },
  };

  await assert.rejects(
    runDigest({
      model: 'deepseek-chat',
      promptVersion: 'v1',
      timeoutMs: 1000,
      input: INPUT,
      client,
    }),
    (err: unknown) => err instanceof DigestError && err.code === 'unknown_model',
  );
  assert.equal(chamou, false);
});

test('runDigest para em versão de prompt desconhecida', async () => {
  await assert.rejects(
    runDigest({
      model: 'deepseek-v4-flash',
      promptVersion: 'v99',
      timeoutMs: 1000,
      input: INPUT,
      client: fakeClient({ text: '{}' }),
    }),
    (err: unknown) => err instanceof DigestError && err.code === 'unknown_prompt',
  );
});

test('runDigest distingue recusa, truncagem e JSON quebrado', async () => {
  const casos: Array<[Partial<CompletionResult> & { text: string | null }, string]> = [
    [{ text: null, stop: 'refusal' }, 'refusal'],
    [{ text: null, stop: 'truncated' }, 'truncated'],
    [{ text: null }, 'no_text'],
    [{ text: 'não sou JSON' }, 'not_json'],
  ];

  for (const [completion, code] of casos) {
    await assert.rejects(
      runDigest({
        model: 'deepseek-v4-flash',
        promptVersion: 'v1',
        timeoutMs: 1000,
        input: INPUT,
        client: fakeClient(completion),
      }),
      (err: unknown) => err instanceof DigestError && err.code === code,
      `esperava ${code}`,
    );
  }
});

test('runDigest usa o schema E o parser da versão pedida', async () => {
  // A v2 é a primeira versão que muda a FORMA da saída, não só o texto. Se o
  // `promptVersion` não chegasse ao parser, a saída da v2 seria lida com as
  // regras da v1 e a severidade sumiria em silêncio.
  const result = await runDigest({
    model: 'deepseek-v4-flash',
    promptVersion: 'v2',
    timeoutMs: 1000,
    input: INPUT,
    client: fakeClient({ text: JSON.stringify(REGRA_V2) }),
  });

  assert.equal(result.output.pegadinhas[0]?.severidade, 'muda_timing');
  assert.equal(result.output.ambiguidades[0]?.tipo, 'fuso_ausente');
  // E o prompt enviado é o da v2, não o da v1.
  assert.ok(result.prompt.system.includes('muda_timing'));
});

test('runDigest recusa a chamada inteira quando a saída opina', async () => {
  await assert.rejects(
    runDigest({
      model: 'deepseek-v4-flash',
      promptVersion: 'v1',
      timeoutMs: 1000,
      input: INPUT,
      client: fakeClient({
        text: JSON.stringify({
          ...REGRA_BOA,
          pegadinhas: ['A chance de isso acontecer antes do prazo é remota.'],
        }),
      }),
    }),
    (err: unknown) => err instanceof DigestError && err.code === 'opiniao',
  );
});
