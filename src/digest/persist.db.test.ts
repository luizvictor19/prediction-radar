import { test } from 'node:test';
import assert from 'node:assert/strict';

import { testDatabase } from '../lib/test-db.js';
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

const MARKER = 'teste-gravacao-atomica';

type Client = Extract<Awaited<ReturnType<typeof testDatabase>>, { client: unknown }>['client'];

interface Counts {
  texts: number;
  digests: number;
  pegadinhas: number;
  ambiguidades: number;
}

const ZERO: Counts = { texts: 0, digests: 0, pegadinhas: 0, ambiguidades: 0 };
const FULL: Counts = { texts: 1, digests: 1, pegadinhas: 2, ambiguidades: 2 };

// Non-ASCII on purpose ("até", "não", "ç"): the function recomputes the hash from
// the UTF-8 bytes, and it has to agree with `hashDescription` on them.
function ruleText(name: string): string {
  return `${MARKER} ${name}: resolve Yes se o evento acontecer até 31/12, não depois; ação.`;
}

function buildOutput(overrides: Partial<DigestOutput> = {}): DigestOutput {
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
function reading(eventId: string, name: string, output = buildOutput()): DigestRows {
  const description = ruleText(name);
  const market = {
    eventId,
    polymarketId: `${MARKER}-${eventId}`,
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
  return buildDigestRows(market, result, 'v4', `${MARKER}-model`);
}

function shaOf(rows: DigestRows): string {
  return rows.digest['description_sha256'] as string;
}

/** A copy of `obj` without `key`: a payload whose builder forgot a field. */
function without(obj: Record<string, unknown>, key: string): Record<string, unknown> {
  return Object.fromEntries(Object.entries(obj).filter(([k]) => k !== key));
}

async function createEvent(db: Client, suffix: string): Promise<string> {
  const { data, error } = await db
    .from('events')
    .insert({ polymarket_id: `${MARKER}-${process.pid}-${suffix}`, title: `${MARKER} ${suffix}` })
    .select('id')
    .single();
  if (error) throw new Error(`events: ${error.message}`);
  return (data as { id: string }).id;
}

/** Events first (digests and children go with them by cascade), then the texts. */
async function cleanup(db: Client): Promise<void> {
  const { error } = await db.from('events').delete().like('polymarket_id', `${MARKER}-%`);
  if (error) throw new Error(`limpeza de events: ${error.message}`);
  const { error: e } = await db
    .from('market_rule_texts')
    .delete()
    .like('description', `${MARKER} %`);
  if (e) throw new Error(`limpeza de market_rule_texts: ${e.message}`);
}

async function countRows(db: Client, eventIds: string[], shas: string[]): Promise<Counts> {
  const { count: texts, error: et } = await db
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

  const children = async (table: string): Promise<number> => {
    if (ids.length === 0) return 0;
    const { count, error: ec } = await db
      .from(table)
      .select('*', { count: 'exact', head: true })
      .in('digest_id', ids);
    if (ec) throw new Error(ec.message);
    return count ?? 0;
  };

  return {
    texts: texts ?? 0,
    digests: ids.length,
    pegadinhas: await children('digest_pegadinhas'),
    ambiguidades: await children('digest_ambiguidades'),
  };
}

/** The answer of one call, with a failure kept as a value so it enters the sequence. */
async function recordOrError(
  db: Client,
  rows: DigestRows,
): Promise<RecordOutcome | `erro: ${string}`> {
  try {
    return await recordDigest(db, rows);
  } catch (err) {
    return `erro: ${(err as Error).message}`;
  }
}

/** Only the keys the payload sent, so the comparison is about what was written. */
function pickKeys(row: Record<string, unknown>, model: Record<string, unknown>) {
  return Object.fromEntries(Object.keys(model).map((k) => [k, row[k]]));
}

/**
 * What the manual loader leaves when it dies between inserts
 * (`scripts/carregar-digest.ts`): the text, the parent, and only the children
 * listed. Written straight to the tables, outside the function, on purpose.
 */
async function seedHalfWritten(
  db: Client,
  rows: DigestRows,
  children: Array<'pegadinhas' | 'ambiguidades'>,
): Promise<void> {
  const { error: et } = await db.from('market_rule_texts').insert(rows.text);
  if (et) throw new Error(`semente market_rule_texts: ${et.message}`);
  const { data, error } = await db.from('market_rule_digests').insert(rows.digest).select('id');
  if (error) throw new Error(`semente market_rule_digests: ${error.message}`);
  const digestId = (data as Array<{ id: string }>)[0]!.id;
  for (const kind of children) {
    const { error: ec } = await db
      .from(`digest_${kind}`)
      .insert(rows[kind].map((r) => ({ ...r, digest_id: digestId })));
    if (ec) throw new Error(`semente digest_${kind}: ${ec.message}`);
  }
}

async function withDatabase(
  t: { skip: (reason: string) => void },
  body: (db: Client) => Promise<void>,
): Promise<void> {
  const database = await testDatabase();
  if ('skipReason' in database) return t.skip(database.skipReason);
  const db = database.client;
  await cleanup(db);
  try {
    await body(db);
  } finally {
    await cleanup(db);
  }
}

test('record_rule_digest: a mesma leitura duas vezes devolve inserted e depois duplicate, e as filhas entram uma vez só', async (t) => {
  await withDatabase(t, async (db) => {
    const eventId = await createEvent(db, 'repete');
    const rows = reading(eventId, 'repete');
    const sha = shaOf(rows);

    const answers: string[] = [];
    const counts: Counts[] = [await countRows(db, [eventId], [sha])];
    for (let i = 0; i < 2; i++) {
      answers.push(await recordOrError(db, rows));
      counts.push(await countRows(db, [eventId], [sha]));
    }

    assert.deepEqual(answers, ['inserted', 'duplicate']);
    assert.deepEqual(
      counts,
      [ZERO, FULL, FULL],
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
    assert.deepEqual(pickKeys(digest, rows.digest), rows.digest);

    const digestId = (digest as { id: string }).id;
    for (const [table, expected] of [
      ['digest_pegadinhas', rows.pegadinhas],
      ['digest_ambiguidades', rows.ambiguidades],
    ] as const) {
      const { data: stored, error: es } = await db
        .from(table)
        .select('*')
        .eq('digest_id', digestId)
        .order('ordinal');
      if (es) throw new Error(es.message);
      assert.deepEqual(
        (stored ?? []).map((row: Record<string, unknown>, i: number) =>
          pickKeys(row, expected[i] ?? {}),
        ),
        expected,
        `${table} tem que guardar o que o payload mandou, na ordem do ordinal`,
      );
    }

    const { data: storedText, error: etx } = await db
      .from('market_rule_texts')
      .select('*')
      .eq('description_sha256', sha)
      .single();
    if (etx) throw new Error(etx.message);
    assert.deepEqual(pickKeys(storedText, rows.text), rows.text);
  });
});

test('record_rule_digest: filha que viola um CHECK derruba a leitura inteira, pai e texto inclusive', async (t) => {
  await withDatabase(t, async (db) => {
    const base = buildOutput();
    // The SECOND child of each table is the bad one, so the first child of the
    // same table was already inserted when the error came: only a transaction
    // takes it back.
    const cases = {
      // muda_resultado without a scenario: digest_pegadinhas_cenario_sustenta_severidade.
      pegadinha: buildOutput({
        pegadinhas: [base.pegadinhas[0]!, { ...base.pegadinhas[1]!, severidade: 'muda_resultado' }],
      }),
      // contradicao_interna without the second passage: digest_ambiguidades_conflito_so_na_contradicao.
      ambiguidade: buildOutput({
        ambiguidades: [base.ambiguidades[0]!, { ...base.ambiguidades[1]!, trechoConflito: null }],
      }),
    };

    for (const [name, bad] of Object.entries(cases)) {
      const eventId = await createEvent(db, `check-${name}`);
      const badRows = reading(eventId, `check-${name}`, bad);
      const goodRows = reading(eventId, `check-${name}`);
      const sha = shaOf(goodRows);

      const answers: string[] = [];
      const counts: Counts[] = [await countRows(db, [eventId], [sha])];
      for (const rows of [badRows, goodRows]) {
        answers.push(await recordOrError(db, rows));
        counts.push(await countRows(db, [eventId], [sha]));
      }

      assert.match(answers[0]!, /^erro: .*violates check constraint/, `${name}: a chamada ruim`);
      // The same key, corrected, is then `inserted`. Had the failed call left the
      // parent behind, this second call would not answer `inserted`.
      assert.equal(answers[1], 'inserted', `${name}: a mesma chave, corrigida`);
      assert.deepEqual(
        counts,
        [ZERO, ZERO, FULL],
        `${name}: a falha não pode deixar linha nenhuma, nem o pai, nem o texto`,
      );
    }
  });
});

test('record_rule_digest: o mesmo texto em dois mercados é uma linha de texto e duas digestões', async (t) => {
  await withDatabase(t, async (db) => {
    const events = [await createEvent(db, 'mesmo-texto-1'), await createEvent(db, 'mesmo-texto-2')];
    const sha = shaOf(reading(events[0]!, 'mesmo-texto'));

    const answers: string[] = [];
    const counts: Counts[] = [];
    for (const eventId of events) {
      answers.push(await recordOrError(db, reading(eventId, 'mesmo-texto')));
      counts.push(await countRows(db, events, [sha]));
    }

    assert.deepEqual(answers, ['inserted', 'inserted']);
    assert.deepEqual(counts, [FULL, { texts: 1, digests: 2, pegadinhas: 4, ambiguidades: 4 }]);
  });
});

test('record_rule_digest: oito chamadas simultâneas com a mesma chave dão exatamente um inserted', async (t) => {
  await withDatabase(t, async (db) => {
    const eventId = await createEvent(db, 'concorrencia');
    const rows = reading(eventId, 'concorrencia');

    const answers = await Promise.all(Array.from({ length: 8 }, () => recordOrError(db, rows)));

    assert.deepEqual(
      [...answers].sort(),
      [...Array<string>(7).fill('duplicate'), 'inserted'],
      'nenhuma chamada pode falhar e só uma pode ter gravado',
    );
    assert.deepEqual(await countRows(db, [eventId], [shaOf(rows)]), FULL);
  });
});

test('record_rule_digest: chave desconhecida ou hash divergente é erro, não descarte silencioso', async (t) => {
  await withDatabase(t, async (db) => {
    const eventId = await createEvent(db, 'payload');
    const rows = reading(eventId, 'payload');
    const sha = shaOf(rows);

    const bad: Array<[string, DigestRows, RegExp]> = [
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

    for (const [name, payload, reason] of bad) {
      const answer = await recordOrError(db, payload);
      assert.match(answer, /^erro: /, `${name}: tinha que falhar`);
      assert.match(answer, reason, `${name}: a mensagem tem que dizer o porquê`);
      assert.deepEqual(
        await countRows(db, [eventId], [sha]),
        ZERO,
        `${name}: nada pode ter ficado`,
      );
    }
  });
});

test('record_rule_digest: chave ausente no payload é erro com o nome dela, nunca NULL nem default', async (t) => {
  await withDatabase(t, async (db) => {
    const eventId = await createEvent(db, 'ausente');
    const rows = reading(eventId, 'ausente');
    const sha = shaOf(rows);

    // Two with a column default (leitura_n = 1, resolve_nao = '{}'), two nullable
    // with no default (fonte, trecho): a missing key used to become NULL or the
    // default without a word. guardado_por is NOT NULL with no default.
    const bad: Array<[string, DigestRows, RegExp]> = [
      ['leitura_n', { ...rows, digest: without(rows.digest, 'leitura_n') }, /p_digest\.leitura_n/],
      [
        'resolve_nao',
        { ...rows, digest: without(rows.digest, 'resolve_nao') },
        /p_digest\.resolve_nao/,
      ],
      ['fonte', { ...rows, digest: without(rows.digest, 'fonte') }, /p_digest\.fonte/],
      [
        'trecho de pegadinha',
        { ...rows, pegadinhas: [without(rows.pegadinhas[0]!, 'trecho')] },
        /p_pegadinhas\.trecho/,
      ],
      [
        'guardado_por',
        { ...rows, text: without(rows.text, 'guardado_por') },
        /p_text\.guardado_por/,
      ],
    ];

    for (const [name, payload, key] of bad) {
      const answer = await recordOrError(db, payload);
      assert.match(
        answer,
        /^erro: .*chaves ausentes/,
        `${name}: tinha que falhar por chave ausente`,
      );
      assert.match(answer, key, `${name}: a mensagem tem que nomear a chave`);
      assert.deepEqual(
        await countRows(db, [eventId], [sha]),
        ZERO,
        `${name}: nada pode ter ficado`,
      );
    }
  });
});

test('record_rule_digest: chave existente sem as filhas que o payload traz responde incomplete e não grava nada', async (t) => {
  await withDatabase(t, async (db) => {
    // The two shapes the manual loader can leave: no children at all, and the
    // traps without the ambiguities (it inserts them in that order).
    const cases: Array<[string, Array<'pegadinhas' | 'ambiguidades'>, Counts]> = [
      ['sem filhas', [], { texts: 1, digests: 1, pegadinhas: 0, ambiguidades: 0 }],
      [
        'sem ambiguidades',
        ['pegadinhas'],
        { texts: 1, digests: 1, pegadinhas: 2, ambiguidades: 0 },
      ],
    ];

    for (const [name, seeded, half] of cases) {
      const eventId = await createEvent(db, `incompleta-${seeded.length}`);
      const rows = reading(eventId, `incompleta-${seeded.length}`);
      await seedHalfWritten(db, rows, seeded);

      const answers: string[] = [];
      const counts: Counts[] = [await countRows(db, [eventId], [shaOf(rows)])];
      for (let i = 0; i < 2; i++) {
        answers.push(await recordOrError(db, rows));
        counts.push(await countRows(db, [eventId], [shaOf(rows)]));
      }

      assert.deepEqual(
        answers,
        ['incomplete', 'incomplete'],
        `${name}: leitura pela metade não pode passar por duplicate`,
      );
      assert.deepEqual(
        counts,
        [half, half, half],
        `${name}: incomplete não repara nada, reparar é decisão do dono`,
      );
    }

    // The control: a reading that legitimately has no children is a plain
    // duplicate, not an incomplete one.
    const eventId = await createEvent(db, 'vazia');
    const empty = reading(eventId, 'vazia', buildOutput({ pegadinhas: [], ambiguidades: [] }));
    const answers = [await recordOrError(db, empty), await recordOrError(db, empty)];
    assert.deepEqual(answers, ['inserted', 'duplicate'], 'leitura vazia legítima é duplicate');
  });
});

test('record_rule_digest: duplicate não tenta gravar o texto', async (t) => {
  await withDatabase(t, async (db) => {
    const eventId = await createEvent(db, 'duplicate-sem-texto');
    const rows = reading(eventId, 'duplicate-sem-texto');
    // A text payload that market_rule_texts_guardado_por refuses. A duplicate
    // that never tries the text insert does not reach the CHECK.
    const refusedText = { ...rows, text: { ...rows.text, guardado_por: 'outro' } };

    const answers = [await recordOrError(db, rows), await recordOrError(db, refusedText)];

    assert.deepEqual(
      answers,
      ['inserted', 'duplicate'],
      'a resposta duplicate tem que vir antes de qualquer insert, inclusive o do texto',
    );
    assert.deepEqual(await countRows(db, [eventId], [shaOf(rows)]), FULL);
  });
});

test('record_rule_digest: descrição que não bate com o hash é erro, mesmo com o hash já guardado', async (t) => {
  await withDatabase(t, async (db) => {
    const first = await createEvent(db, 'hash-1');
    const second = await createEvent(db, 'hash-2');
    const rows = reading(first, 'hash');
    const sha = shaOf(rows);
    const lie = (r: DigestRows): DigestRows => ({
      ...r,
      text: { ...r.text, description: `${MARKER} outro texto sob o mesmo hash` },
    });
    // Same hash, other text, twice. Under the same key the call never reaches an
    // insert (duplicate answers first), so only the function's own check can
    // refuse it. Under another market the text insert runs, and the table's
    // CHECK market_rule_texts_hash_confere would refuse it too.
    const answers = [
      await recordOrError(db, rows),
      await recordOrError(db, lie(rows)),
      await recordOrError(db, lie(reading(second, 'hash'))),
    ];

    assert.equal(answers[0], 'inserted');
    for (const [i, where] of [
      [1, 'sob a mesma chave'],
      [2, 'em outro mercado'],
    ] as const) {
      assert.match(
        answers[i]!,
        /^erro: .*descricao nao bate com o hash/,
        `${where}: o texto que mente sobre o hash tem que ser recusado pela função`,
      );
    }
    assert.deepEqual(
      await countRows(db, [first, second], [sha]),
      FULL,
      'as chamadas recusadas não podem ter gravado nada',
    );
  });
});
