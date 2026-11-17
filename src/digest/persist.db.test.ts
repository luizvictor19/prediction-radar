import { test } from 'node:test';
import assert from 'node:assert/strict';

import { SKIP_REASON, testDatabase } from '../lib/test-db.js';
import { hashDescription, type DigestOutput, type DigestResult } from './digest.js';
import { recordDigest, type RecordOutcome } from './persist.js';
import { buildDigestRows, type DigestRows } from './rows.js';
import type { MarketToDigest } from './store.js';

// `record_rule_digest` against a real Postgres (issue 88).
//
// A transaction and a unique constraint under concurrency are exactly what a
// double cannot reproduce, so these tests run only under `npm run test:db`.
// Every test asserts the SEQUENCE (the answer and the counts after each call),
// not only the end state: a retry that wrote the children twice and a function
// that never wrote them both end with one digest row.
//
// The rows come from `buildDigestRows`, the same builder the scripts use, so a
// key the builder adds and the function does not know fails here.

const MARCA = 'teste-gravacao-atomica';

type Cliente = NonNullable<Awaited<ReturnType<typeof testDatabase>>>;

interface Contagem {
  textos: number;
  digests: number;
  pegadinhas: number;
  ambiguidades: number;
}

const ZERO: Contagem = { textos: 0, digests: 0, pegadinhas: 0, ambiguidades: 0 };

function texto(nome: string): string {
  return `${MARCA} ${nome}: resolve Yes se o evento acontecer até 31/12.`;
}

function saida(overrides: Partial<DigestOutput> = {}): DigestOutput {
  return {
    resolveSim: ['o evento acontece até 31/12'],
    resolveNao: ['o evento não acontece até 31/12'],
    fonte: 'fonte oficial',
    anulaSe: [],
    prazo: '31/12',
    pegadinhas: [
      {
        texto: 'o prazo é do fuso de NY',
        severidade: 'muda_timing',
        trecho: 'até 31/12',
        cenario: 'acontece às 23h de Brasília',
      },
      { texto: 'a fonte é uma só', severidade: 'detalhe', trecho: 'fonte oficial', cenario: null },
    ],
    ambiguidades: [
      {
        tipo: 'fuso_ausente',
        trecho: 'até 31/12',
        trechoConflito: null,
        leituraA: 'fuso de NY',
        leituraB: 'UTC',
      },
      {
        tipo: 'contradicao_interna',
        trecho: 'até 31/12',
        trechoConflito: 'até 30/12',
        leituraA: 'vale o dia 31',
        leituraB: 'vale o dia 30',
      },
    ],
    ...overrides,
  };
}

/** The rows of one reading, built by the production builder. */
function leitura(eventId: string, nome: string, output = saida()): DigestRows {
  const description = texto(nome);
  const market = {
    eventId,
    polymarketId: `${MARCA}-${eventId}`,
    tema: null,
    liquidez: null,
    status: null,
    input: { question: 'Q?', description, slug: null, endDate: null, outcomes: null },
  } satisfies MarketToDigest;
  const result = {
    output,
    usage: { input: 1000, output: 500, cacheRead: 200, cacheWrite: 0 },
    costUsd: 0.00231,
    latencyMs: 14900,
    descriptionSha256: hashDescription(description),
  } as DigestResult;
  return buildDigestRows(market, result, 'v4', `${MARCA}-model`);
}

async function criarEvento(db: Cliente, sufixo: string): Promise<string> {
  const { data, error } = await db
    .from('events')
    .insert({ polymarket_id: `${MARCA}-${process.pid}-${sufixo}`, title: `${MARCA} ${sufixo}` })
    .select('id')
    .single();
  if (error) throw new Error(`events: ${error.message}`);
  return (data as { id: string }).id;
}

/** Events first (digests and children go with them by cascade), then the texts. */
async function limpar(db: Cliente): Promise<void> {
  const { error } = await db.from('events').delete().like('polymarket_id', `${MARCA}-%`);
  if (error) throw new Error(`limpeza de events: ${error.message}`);
  const { error: e } = await db
    .from('market_rule_texts')
    .delete()
    .like('description', `${MARCA} %`);
  if (e) throw new Error(`limpeza de market_rule_texts: ${e.message}`);
}

async function contar(db: Cliente, eventIds: string[], shas: string[]): Promise<Contagem> {
  const { count: textos, error: et } = await db
    .from('market_rule_texts')
    .select('*', { count: 'exact', head: true })
    .in('description_sha256', shas);
  if (et) throw new Error(et.message);

  const { data, error } = await db
    .from('market_rule_digests')
    .select('id')
    .in('event_id', eventIds);
  if (error) throw new Error(error.message);
  const ids = (data ?? []).map((r: { id: string }) => r.id);

  const filhas = async (tabela: string): Promise<number> => {
    if (ids.length === 0) return 0;
    const { count, error: ef } = await db
      .from(tabela)
      .select('*', { count: 'exact', head: true })
      .in('digest_id', ids);
    if (ef) throw new Error(ef.message);
    return count ?? 0;
  };

  return {
    textos: textos ?? 0,
    digests: ids.length,
    pegadinhas: await filhas('digest_pegadinhas'),
    ambiguidades: await filhas('digest_ambiguidades'),
  };
}

/** The answer of one call, with a failure kept as a value so it enters the sequence. */
async function gravar(db: Cliente, rows: DigestRows): Promise<RecordOutcome | `erro: ${string}`> {
  try {
    return await recordDigest(db, rows);
  } catch (err) {
    return `erro: ${(err as Error).message}`;
  }
}

/** Only the keys the payload sent, so the comparison is about what was written. */
function soAsChaves(linha: Record<string, unknown>, modelo: Record<string, unknown>) {
  return Object.fromEntries(Object.keys(modelo).map((k) => [k, linha[k]]));
}

async function comBanco(
  t: { skip: (reason: string) => void },
  corpo: (db: Cliente) => Promise<void>,
): Promise<void> {
  const db = await testDatabase();
  if (db === null) return t.skip(SKIP_REASON);
  await limpar(db);
  try {
    await corpo(db);
  } finally {
    await limpar(db);
  }
}

test('record_rule_digest: a mesma leitura duas vezes devolve inserted e depois duplicate, e as filhas entram uma vez só', async (t) => {
  await comBanco(t, async (db) => {
    const eventId = await criarEvento(db, 'repete');
    const rows = leitura(eventId, 'repete');
    const sha = rows.digest['description_sha256'] as string;

    const respostas: string[] = [];
    const contagens: Contagem[] = [await contar(db, [eventId], [sha])];
    for (let i = 0; i < 2; i++) {
      respostas.push(await gravar(db, rows));
      contagens.push(await contar(db, [eventId], [sha]));
    }

    assert.deepEqual(respostas, ['inserted', 'duplicate']);
    const cheia = { textos: 1, digests: 1, pegadinhas: 2, ambiguidades: 2 };
    assert.deepEqual(
      contagens,
      [ZERO, cheia, cheia],
      'antes, depois da primeira e depois da segunda chamada: a repetição não pode mudar nada',
    );

    // What was stored is what the builder sent, key by key. A key the function
    // silently dropped would show up here as null.
    const { data: digest, error } = await db
      .from('market_rule_digests')
      .select('*')
      .eq('event_id', eventId)
      .single();
    if (error) throw new Error(error.message);
    assert.deepEqual(soAsChaves(digest, rows.digest), rows.digest);

    const digestId = (digest as { id: string }).id;
    for (const [tabela, esperadas] of [
      ['digest_pegadinhas', rows.pegadinhas],
      ['digest_ambiguidades', rows.ambiguidades],
    ] as const) {
      const { data: filhas, error: ef } = await db
        .from(tabela)
        .select('*')
        .eq('digest_id', digestId)
        .order('ordinal');
      if (ef) throw new Error(ef.message);
      assert.deepEqual(
        (filhas ?? []).map((f: Record<string, unknown>, i: number) =>
          soAsChaves(f, esperadas[i] ?? {}),
        ),
        esperadas,
        `${tabela} tem que guardar o que o payload mandou, na ordem do ordinal`,
      );
    }

    const { data: textoGuardado, error: etx } = await db
      .from('market_rule_texts')
      .select('*')
      .eq('description_sha256', sha)
      .single();
    if (etx) throw new Error(etx.message);
    assert.deepEqual(soAsChaves(textoGuardado, rows.text), rows.text);
  });
});

test('record_rule_digest: filha que viola um CHECK derruba a leitura inteira, pai e texto inclusive', async (t) => {
  await comBanco(t, async (db) => {
    const base = saida();
    // The SECOND child of each table is the bad one, so the first child of the
    // same table was already inserted when the error came: only a transaction
    // takes it back.
    const casos = {
      // muda_resultado without a scenario: digest_pegadinhas_cenario_sustenta_severidade.
      pegadinha: saida({
        pegadinhas: [base.pegadinhas[0]!, { ...base.pegadinhas[1]!, severidade: 'muda_resultado' }],
      }),
      // contradicao_interna without the second passage: digest_ambiguidades_conflito_so_na_contradicao.
      ambiguidade: saida({
        ambiguidades: [base.ambiguidades[0]!, { ...base.ambiguidades[1]!, trechoConflito: null }],
      }),
    };

    for (const [nome, ruim] of Object.entries(casos)) {
      const eventId = await criarEvento(db, `check-${nome}`);
      const rowsRuins = leitura(eventId, `check-${nome}`, ruim);
      const rowsBoas = leitura(eventId, `check-${nome}`);
      const sha = rowsBoas.digest['description_sha256'] as string;

      const respostas: string[] = [];
      const contagens: Contagem[] = [await contar(db, [eventId], [sha])];
      for (const rows of [rowsRuins, rowsBoas]) {
        respostas.push(await gravar(db, rows));
        contagens.push(await contar(db, [eventId], [sha]));
      }

      assert.match(respostas[0]!, /^erro: .*violates check constraint/, `${nome}: a chamada ruim`);
      // The same key, corrected, is then `inserted`. Had the failed call left the
      // parent behind, this second call would answer `duplicate` and the reading
      // would stay without children for good.
      assert.equal(respostas[1], 'inserted', `${nome}: a mesma chave, corrigida`);
      assert.deepEqual(
        contagens,
        [ZERO, ZERO, { textos: 1, digests: 1, pegadinhas: 2, ambiguidades: 2 }],
        `${nome}: a falha não pode deixar linha nenhuma, nem o pai, nem o texto`,
      );
    }
  });
});

test('record_rule_digest: o mesmo texto em dois mercados é uma linha de texto e duas digestões', async (t) => {
  await comBanco(t, async (db) => {
    const eventos = [
      await criarEvento(db, 'mesmo-texto-1'),
      await criarEvento(db, 'mesmo-texto-2'),
    ];
    const sha = leitura(eventos[0]!, 'mesmo-texto').digest['description_sha256'] as string;

    const respostas: string[] = [];
    const contagens: Contagem[] = [];
    for (const eventId of eventos) {
      respostas.push(await gravar(db, leitura(eventId, 'mesmo-texto')));
      contagens.push(await contar(db, eventos, [sha]));
    }

    assert.deepEqual(respostas, ['inserted', 'inserted']);
    assert.deepEqual(contagens, [
      { textos: 1, digests: 1, pegadinhas: 2, ambiguidades: 2 },
      { textos: 1, digests: 2, pegadinhas: 4, ambiguidades: 4 },
    ]);
  });
});

test('record_rule_digest: oito chamadas simultâneas com a mesma chave dão exatamente um inserted', async (t) => {
  await comBanco(t, async (db) => {
    const eventId = await criarEvento(db, 'concorrencia');
    const rows = leitura(eventId, 'concorrencia');
    const sha = rows.digest['description_sha256'] as string;

    const respostas = await Promise.all(Array.from({ length: 8 }, () => gravar(db, rows)));

    assert.deepEqual(
      [...respostas].sort(),
      [
        'duplicate',
        'duplicate',
        'duplicate',
        'duplicate',
        'duplicate',
        'duplicate',
        'duplicate',
        'inserted',
      ],
      'nenhuma chamada pode falhar e só uma pode ter gravado',
    );
    assert.deepEqual(await contar(db, [eventId], [sha]), {
      textos: 1,
      digests: 1,
      pegadinhas: 2,
      ambiguidades: 2,
    });
  });
});

test('record_rule_digest: chave desconhecida ou hash divergente é erro, não descarte silencioso', async (t) => {
  await comBanco(t, async (db) => {
    const eventId = await criarEvento(db, 'payload');
    const rows = leitura(eventId, 'payload');
    const sha = rows.digest['description_sha256'] as string;

    const ruins: Array<[string, DigestRows, RegExp]> = [
      [
        'chave nova no digest',
        { ...rows, digest: { ...rows.digest, coluna_nova: 1 } },
        /coluna_nova/,
      ],
      ['chave nova no texto', { ...rows, text: { ...rows.text, coluna_nova: 1 } }, /coluna_nova/],
      [
        'chave nova numa pegadinha',
        { ...rows, pegadinhas: [{ ...rows.pegadinhas[0]!, coluna_nova: 1 }] },
        /coluna_nova/,
      ],
      [
        'chave nova numa ambiguidade',
        { ...rows, ambiguidades: [{ ...rows.ambiguidades[0]!, coluna_nova: 1 }] },
        /coluna_nova/,
      ],
      [
        'texto e digestão com hashes diferentes',
        { ...rows, digest: { ...rows.digest, description_sha256: 'b'.repeat(64) } },
        /hash/,
      ],
    ];

    for (const [nome, payload, motivo] of ruins) {
      const resposta = await gravar(db, payload);
      assert.match(resposta, /^erro: /, `${nome}: tinha que falhar`);
      assert.match(resposta, motivo, `${nome}: a mensagem tem que dizer o porquê`);
      assert.deepEqual(await contar(db, [eventId], [sha]), ZERO, `${nome}: nada pode ter ficado`);
    }
  });
});
