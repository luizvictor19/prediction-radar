import { test } from 'node:test';
import assert from 'node:assert/strict';

// Nada aqui toca rede: a validação é pura e `extrairRelacoes` recebe um cliente
// falso pela interface de `src/llm/client.ts`.
process.env['SUPABASE_URL'] ??= 'http://localhost:54321';
process.env['SUPABASE_SERVICE_KEY'] ??= 'test-key';

const { parseRelacoes, extrairRelacoes, estimarCustoUsd, modeloConhecido, ExtratorError } =
  await import('./extrator.js');
const { obterPrompt, versoesDePrompt, VERSAO_PADRAO } = await import('./prompts.js');

type LlmClient = import('../llm/client.js').LlmClient;
type CompletionResult = import('../llm/client.js').CompletionResult;
type MercadoParaPrompt = import('./prompts.js').MercadoParaPrompt;
type EntradaDoPrompt = import('./prompts.js').EntradaDoPrompt;

const ROTULOS = new Set(['M1', 'M2', 'M3']);

function relacao(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    tipo: 'implica',
    mercados: ['M1', 'M2'],
    confianca: 0.9,
    justificativa: 'M1 pede "Over 5.5" e M2 pede "Over 3.5"; todo total acima de 5.5 passa de 3.5.',
    ressalva_de_resolucao: null,
    ...over,
  };
}

function codigoDe(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    return err instanceof ExtratorError ? err.code : 'nao-e-ExtratorError';
  }
  return 'nao-lancou';
}

// ---------------------------------------------------------------------------
// O contrato de saída
// ---------------------------------------------------------------------------

test('resposta bem formada vira lista de relações', () => {
  const out = parseRelacoes({ relacoes: [relacao()] }, ROTULOS);
  assert.equal(out.length, 1);
  assert.equal(out[0]?.tipo, 'implica');
  assert.deepEqual(out[0]?.mercados, ['M1', 'M2']);
  assert.equal(out[0]?.ressalvaDeResolucao, null);
});

test('lista vazia é resposta válida — é o `nenhuma` do grupo inteiro', () => {
  assert.deepEqual(parseRelacoes({ relacoes: [] }, ROTULOS), []);
});

test('ressalva preenchida sobrevive; string vazia vira null', () => {
  const comRessalva = parseRelacoes(
    { relacoes: [relacao({ ressalva_de_resolucao: 'M1 resolve por AP, M2 por Reuters' })] },
    ROTULOS,
  );
  assert.equal(comRessalva[0]?.ressalvaDeResolucao, 'M1 resolve por AP, M2 por Reuters');

  const vazia = parseRelacoes({ relacoes: [relacao({ ressalva_de_resolucao: '   ' })] }, ROTULOS);
  assert.equal(vazia[0]?.ressalvaDeResolucao, null);
});

// ---------------------------------------------------------------------------
// A validação de rótulo — a regra que segurou 584/584 no analista
// ---------------------------------------------------------------------------

test('rótulo não entregue invalida a resposta INTEIRA, não só a entrada', () => {
  const resposta = { relacoes: [relacao(), relacao({ mercados: ['M1', 'M9'] })] };
  assert.equal(codigoDe(() => parseRelacoes(resposta, ROTULOS)), 'rotulo_desconhecido');
});

test('rótulo repetido na mesma relação é recusado', () => {
  // "M1 implica M1" passaria pela conferência de desfecho como compatível
  // sempre — um acerto de graça que inflaria a precisão.
  assert.equal(
    codigoDe(() => parseRelacoes({ relacoes: [relacao({ mercados: ['M1', 'M1'] })] }, ROTULOS)),
    'rotulo_repetido',
  );
});

// ---------------------------------------------------------------------------
// Tipo e aridade
// ---------------------------------------------------------------------------

test('tipo fora da lista fechada é recusado', () => {
  assert.equal(
    codigoDe(() => parseRelacoes({ relacoes: [relacao({ tipo: 'correlaciona' })] }, ROTULOS)),
    'tipo_invalido',
  );
});

test('conjuncao exige exatamente três mercados', () => {
  assert.equal(
    codigoDe(() =>
      parseRelacoes({ relacoes: [relacao({ tipo: 'conjuncao', mercados: ['M1', 'M2'] })] }, ROTULOS),
    ),
    'aridade',
  );
  const ok = parseRelacoes(
    { relacoes: [relacao({ tipo: 'conjuncao', mercados: ['M3', 'M1', 'M2'] })] },
    ROTULOS,
  );
  assert.equal(ok[0]?.mercados.length, 3);
});

test('implica com três mercados é recusado', () => {
  assert.equal(
    codigoDe(() => parseRelacoes({ relacoes: [relacao({ mercados: ['M1', 'M2', 'M3'] })] }, ROTULOS)),
    'aridade',
  );
});

test('particiona aceita o conjunto inteiro', () => {
  const out = parseRelacoes(
    { relacoes: [relacao({ tipo: 'particiona', mercados: ['M1', 'M2', 'M3'] })] },
    ROTULOS,
  );
  assert.equal(out[0]?.mercados.length, 3);
});

// ---------------------------------------------------------------------------
// Faixa e campos obrigatórios
// ---------------------------------------------------------------------------

test('confianca fora de [0,1] é recusada — o schema da API não checa faixa', () => {
  assert.equal(
    codigoDe(() => parseRelacoes({ relacoes: [relacao({ confianca: 1.4 })] }, ROTULOS)),
    'confianca_fora_de_faixa',
  );
});

test('justificativa vazia é recusada', () => {
  assert.equal(
    codigoDe(() => parseRelacoes({ relacoes: [relacao({ justificativa: '  ' })] }, ROTULOS)),
    'justificativa_vazia',
  );
});

test('resposta que não é objeto, ou sem lista, é recusada', () => {
  assert.equal(codigoDe(() => parseRelacoes('nada', ROTULOS)), 'schema');
  assert.equal(codigoDe(() => parseRelacoes({ relacoes: 'nada' }, ROTULOS)), 'schema');
});

// ---------------------------------------------------------------------------
// O VAZAMENTO DE DESFECHO — a armadilha central da fase 2
// ---------------------------------------------------------------------------

/**
 * Se o desfecho chegar ao prompt, o modelo deduz a relação do resultado em vez
 * de ler as perguntas, e a precisão medida vira ficção. Estes testes existem
 * para falhar no dia em que alguém acrescentar um campo de resultado ao que vai
 * para o modelo.
 */
const SENTINELA = 'SENTINELA-DE-DESFECHO-NAO-PODE-VAZAR';

function mercado(rotulo: string): MercadoParaPrompt {
  return {
    rotulo,
    pergunta: `Total Games O/U ${rotulo.slice(1)}.5`,
    desfechoSim: 'Over',
    desfechoNao: 'Under',
    regras: 'Resolve Over se o total de games passar do limiar, segundo o placar oficial.',
    fechamento: '2026-08-11T20:00:00Z',
    fonteDeResolucao: null,
  };
}

const ENTRADA: EntradaDoPrompt = {
  grupoId: 'g1',
  motivoDoGrupo: 'mesmo evento (12345)',
  mercados: [mercado('M1'), mercado('M2'), mercado('M3')],
};

test('o tipo que vai ao prompt não tem campo de desfecho', () => {
  // Estrutural, e é a defesa de verdade: as chaves de `MercadoParaPrompt` são
  // exatamente estas. Um campo de resultado acrescentado aqui quebra o teste
  // antes de quebrar a medição.
  assert.deepEqual(Object.keys(mercado('M1')).sort(), [
    'desfechoNao',
    'desfechoSim',
    'fechamento',
    'fonteDeResolucao',
    'pergunta',
    'regras',
    'rotulo',
  ]);
});

test('nenhuma versão de prompt deixa a sentinela de desfecho passar', () => {
  // Envenena TODO campo de string do que vai ao prompt com a sentinela ao lado
  // do valor real, e confere que o prompt montado carrega o valor real e nunca a
  // sentinela — ou seja, que nada é serializado genericamente (um
  // `JSON.stringify(mercado)` levaria os dois).
  const envenenado = {
    ...ENTRADA,
    mercados: ENTRADA.mercados.map((m) => ({ ...m, [SENTINELA]: SENTINELA })),
  } as EntradaDoPrompt;

  for (const versao of versoesDePrompt()) {
    const construir = obterPrompt(versao);
    assert.ok(construir !== null, `versão ${versao} não registrada`);
    const prompt = construir(envenenado);
    const todo = `${prompt.system}\n${prompt.user}`;
    assert.ok(!todo.includes(SENTINELA), `versão ${versao} vazou a sentinela`);
    assert.ok(todo.includes('Total Games O/U 1.5'), `versão ${versao} perdeu a pergunta`);
  }
});

test('o prompt não carrega preço — em mercado resolvido o preço É o desfecho', () => {
  const construir = obterPrompt(VERSAO_PADRAO);
  assert.ok(construir !== null);
  const { user, system } = construir(ENTRADA);
  const todo = `${system}\n${user}`;
  for (const proibido of ['outcomePrices', 'preço atual', 'preco', 'P(M1)', '0.97']) {
    assert.ok(!todo.includes(proibido), `prompt menciona ${proibido}`);
  }
});

test('o módulo de prompt não importa o de desfecho', async () => {
  // A separação de arquivos é a defesa; este teste a torna verificável em vez de
  // convencionada.
  const { readFile } = await import('node:fs/promises');
  const fonte = await readFile(new URL('./prompts.ts', import.meta.url), 'utf8');
  const imports = fonte.match(/^import .*$/gm) ?? [];
  assert.ok(
    !imports.some((linha) => linha.includes('desfecho')),
    `prompts.ts importa desfecho: ${imports.join(' | ')}`,
  );
});

// ---------------------------------------------------------------------------
// Preço
// ---------------------------------------------------------------------------

test('modelo sem preço não roda — sem preço não há teto de gasto', () => {
  assert.equal(modeloConhecido('claude-sonnet-4-6'), true);
  assert.equal(modeloConhecido('modelo-inventado'), false);
  assert.equal(estimarCustoUsd('modelo-inventado', { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }), null);
});

test('a conta de custo reproduz o medido em esports_analyses', () => {
  // v2 do analista: 8.714 tokens de entrada, 359 de saída, US$ 0,0315 medidos.
  const custo = estimarCustoUsd('claude-sonnet-4-6', {
    input: 8714,
    output: 359,
    cacheRead: 0,
    cacheWrite: 0,
  });
  assert.ok(custo !== null);
  assert.ok(Math.abs((custo as number) - 0.0315) < 0.0005, `previu ${custo}`);
});

// ---------------------------------------------------------------------------
// A chamada, com cliente falso
// ---------------------------------------------------------------------------

function clienteQueResponde(payload: unknown, over: Partial<CompletionResult> = {}): LlmClient {
  return {
    async complete(): Promise<CompletionResult> {
      return {
        text: JSON.stringify(payload),
        stop: 'ok',
        usage: { input: 3000, output: 400, cacheRead: 0, cacheWrite: 0 },
        ...over,
      };
    },
  };
}

const PEDIDO = {
  modelo: 'claude-sonnet-4-6',
  versaoDePrompt: VERSAO_PADRAO,
  esforco: 'medium',
  timeoutMs: 1000,
  entrada: ENTRADA,
};

test('chamada bem sucedida devolve relações, uso e custo', async () => {
  const r = await extrairRelacoes({
    ...PEDIDO,
    client: clienteQueResponde({ relacoes: [relacao()] }),
  });
  assert.equal(r.relacoes.length, 1);
  assert.equal(r.uso.input, 3000);
  assert.ok((r.custoUsd ?? 0) > 0);
  assert.ok(r.prompt.user.includes('[M1]'));
});

test('recusa, truncagem e texto ausente são falhas distintas', async () => {
  const casos: Array<[Partial<CompletionResult>, string]> = [
    [{ stop: 'refusal', text: null }, 'refusal'],
    [{ stop: 'truncated', text: null }, 'truncated'],
    [{ stop: 'ok', text: null }, 'no_text'],
  ];
  for (const [over, esperado] of casos) {
    await assert.rejects(
      () => extrairRelacoes({ ...PEDIDO, client: clienteQueResponde({}, over) }),
      (err: unknown) => err instanceof ExtratorError && err.code === esperado,
      `esperava ${esperado}`,
    );
  }
});

test('versão de prompt desconhecida PARA em vez de cair na v1', async () => {
  await assert.rejects(
    () =>
      extrairRelacoes({
        ...PEDIDO,
        versaoDePrompt: 'v999',
        client: clienteQueResponde({ relacoes: [] }),
      }),
    (err: unknown) => err instanceof ExtratorError && err.code === 'prompt_desconhecido',
  );
});

test('modelo desconhecido para antes de gastar a chamada', async () => {
  let chamou = false;
  const espiao: LlmClient = {
    async complete() {
      chamou = true;
      return { text: '{}', stop: 'ok', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
    },
  };
  await assert.rejects(
    () => extrairRelacoes({ ...PEDIDO, modelo: 'inventado', client: espiao }),
    (err: unknown) => err instanceof ExtratorError && err.code === 'modelo_desconhecido',
  );
  assert.equal(chamou, false);
});

test('os rótulos validados são os do grupo, não uma lista fixa', async () => {
  await assert.rejects(
    () =>
      extrairRelacoes({
        ...PEDIDO,
        entrada: { ...ENTRADA, mercados: [mercado('M1'), mercado('M2')] },
        client: clienteQueResponde({ relacoes: [relacao({ mercados: ['M1', 'M3'] })] }),
      }),
    (err: unknown) => err instanceof ExtratorError && err.code === 'rotulo_desconhecido',
  );
});
