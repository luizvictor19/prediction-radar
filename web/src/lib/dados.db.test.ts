import { test } from 'node:test';
import assert from 'node:assert/strict';

import { hashDescription } from '../../../src/digest/digest.js';
import { testDatabase } from '../../../src/lib/test-db.js';
import { COLUNAS_CONTAGEM, ordenarContagens, PAGINA } from './paginacao.js';

/**
 * `lerContagens`'s pagination against a REAL Postgres.
 *
 * ## Why this needs a database
 *
 * The defect is OFFSET under a non-total order: the view
 * `digest_achados_por_mercado` has grain (market, text), and ordering by
 * `event_id` alone leaves two texts of the same market tied. Postgres is FREE to
 * return a tie in any order, and that freedom is where the defect is born — one
 * row arrives on two pages and another on none. No double produces this, because
 * the freedom is exactly what a double does not have. That is what the two
 * substitutes rejected in `f755843` could not do: spying on the query builder and
 * simulating PostgREST both assert that the code calls what it already calls.
 *
 * ## The frontier, measured
 *
 * On 2026-08-23, on this machine, with a page of 500 and every row tied on
 * `event_id`:
 *
 * | rows | pages | ordered by `event_id` only | ordered by `(event_id, sha)` |
 * |------|-------|----------------------------|------------------------------|
 * | 1200 | 3     | 0 dup / 0 lost             | clean                        |
 * | 1500 | 3     | 0 / 0                      | clean                        |
 * | 2000 | 4     | 0 / 0                      | clean                        |
 * | 2500 | 5     | **1 / 1**                  | clean                        |
 * | 3000 | 6     | **1 / 1**                  | clean                        |
 * | 4000 | 8     | **1 / 2**                  | clean                        |
 *
 * The frontier sits between 2000 and 2500 rows: below it Postgres returns the
 * ties in the same order on every page and the defect does not exist. It is
 * deterministic — identical across three rounds at each size — and the duplicated
 * row is always the first one seeded, reappearing once per additional page: at
 * 2500 and 3000 it comes out on pages 0 and 1; at 4000, on pages 0, 1 and 2, and
 * then two rows go missing.
 *
 * **That is why the fixture is 4000 and not 2500.** 2500 sits on the frontier: on
 * a machine with a larger `work_mem` the defect would vanish and this test would
 * pass silently, which is the failure this project treats as worse than no test
 * at all. Lowering `LINHAS` to "save time" undoes the measurement above.
 *
 * ## What this test does NOT claim
 *
 * The internal cause was not identified. The suspicion is a change of sort
 * strategy driven by `work_mem`, but `EXPLAIN` does not travel through PostgREST
 * and it was not checked. **The test pins behavior, not mechanism** — and this
 * comment says so instead of inventing an explanation.
 *
 * One hypothesis was tested and DISCARDED: a concurrent write between pages. With
 * 1200 rows and an `UPDATE` after each page — which rewrites the tuple at the end
 * of the heap, as collection does in production — the result was 0 duplicated and
 * 0 lost. What produces the defect is the size of the sort, not the write.
 *
 * ## Sharing the view with other database tests (issue 90)
 *
 * The view is global: every digest of any event shows up in it, and other test
 * files write digests while this one runs (`node --test` runs files in parallel).
 * So the query stays unfiltered, as in `lerContagens`, and each page is filtered
 * to the fixture's shas only after it comes back. Filtering the query instead
 * would change the plan and hide the defect.
 *
 * The fixture's event gets the nil uuid as its id. Both orders start with
 * `event_id`, and the nil uuid sorts before every other uuid, so the fixture
 * always fills the first `LINHAS` positions: rows another test writes or deletes
 * while the pages are read sort after it and cannot move a fixture row across a
 * page boundary. The nil uuid is reserved for this fixture; no other test may
 * use it as an event id.
 */

/** Read the table above before touching this. 4000 clears the measured frontier. */
const LINHAS = 4000;

const MARCA = 'teste-paginacao';

/** Sorts before every other uuid. See "Sharing the view" in the header. */
const EVENTO_DO_FIXTURE = '00000000-0000-0000-0000-000000000000';

// One distinct text per row. The sha has to be the real sha256 of the text:
// `market_rule_texts_hash_confere` refuses anything else, and the digests' FK
// (`market_rule_digests_texto_guardado`) refuses a digest whose text is not stored.
function texto(i: number): string {
  return `${MARCA} texto ${i}`;
}

type Cliente = Extract<Awaited<ReturnType<typeof testDatabase>>, { client: unknown }>['client'];

/**
 * The pages SEPARATED, not the concatenated list: where a row shows up is part of
 * the finding, and an already-flattened list cannot tell "came twice on the same
 * page" from "came on two pages".
 *
 * Each page keeps only the fixture's shas, filtered after the query. The raw page
 * length still decides when paging stops, as in `paginar`.
 */
async function paginasDe(
  db: Cliente,
  ordemTotal: boolean,
  doFixture: ReadonlySet<string>,
): Promise<string[][]> {
  const paginas: string[][] = [];
  for (let de = 0; ; de += PAGINA) {
    const base = db.from('digest_achados_por_mercado').select(COLUNAS_CONTAGEM);
    // The total order comes from `ordenarContagens` — the SAME function
    // `lerContagens` uses. If it stops ordering by the pair, this test is what
    // falls.
    const q = ordemTotal ? ordenarContagens(base) : base.order('event_id');
    const { data, error } = await q.range(de, de + PAGINA - 1);
    if (error) throw new Error(error.message);
    // Through `unknown`, like `lerAchados`: the client has no generated types.
    const lote = (data ?? []) as unknown as { description_sha256: string }[];
    paginas.push(lote.map((l) => l.description_sha256).filter((sha) => doFixture.has(sha)));
    if (lote.length < PAGINA) return paginas;
  }
}

async function semear(db: Cliente): Promise<string> {
  const { data, error } = await db
    .from('events')
    .insert({
      id: EVENTO_DO_FIXTURE,
      polymarket_id: `${MARCA}-${process.pid}`,
      title: `${MARCA}: offset sob ordem não-total`,
    })
    .select('id')
    .single();
  if (error) throw new Error(`events: ${error.message}`);
  const eventId = (data as { id: string }).id;

  // Texts first, like `scripts/carregar-digest.ts`: the digest FK points at them.
  for (let i = 0; i < LINHAS; i += 200) {
    const lote = Array.from({ length: Math.min(200, LINHAS - i) }, (_, k) => ({
      description_sha256: hashDescription(texto(i + k)),
      description: texto(i + k),
      guardado_por: 'digestao',
    }));
    const { error: e } = await db.from('market_rule_texts').insert(lote);
    if (e) throw new Error(`market_rule_texts: ${e.message}`);
  }

  for (let i = 0; i < LINHAS; i += 200) {
    const lote = Array.from({ length: Math.min(200, LINHAS - i) }, (_, k) => ({
      event_id: eventId,
      description_sha256: hashDescription(texto(i + k)),
      resolve_sim: ['sim'],
      model: MARCA,
      prompt_version: MARCA,
    }));
    const { error: e } = await db.from('market_rule_digests').insert(lote);
    if (e) throw new Error(`market_rule_digests: ${e.message}`);
  }
  return eventId;
}

/**
 * Events first: they take the digestions with them, through the FK cascade. Only
 * then the texts, which the digests' FK would otherwise hold in place.
 */
async function limpar(db: Cliente) {
  const { error } = await db.from('events').delete().like('polymarket_id', `${MARCA}-%`);
  if (error) throw new Error(`limpeza: ${error.message}`);
  const { error: e } = await db
    .from('market_rule_texts')
    .delete()
    .like('description', `${MARCA} texto %`);
  if (e) throw new Error(`limpeza market_rule_texts: ${e.message}`);
}

test(
  'paginação da tela: ordem total não perde nem duplica linha empatada em event_id',
  { timeout: 300_000 },
  async (t) => {
    const banco = await testDatabase();
    if ('skipReason' in banco) return t.skip(banco.skipReason);
    const db = banco.client;

    // Leftovers from an earlier run that died halfway.
    await limpar(db);

    // With a single event_id, `ordenarContagens` orders by the sha, so the
    // expectation is the hex strings sorted, not the seeding order.
    const esperado = Array.from({ length: LINHAS }, (_, i) => hashDescription(texto(i))).sort();
    const doFixture = new Set(esperado);

    await semear(db);
    try {
      const comOrdemTotal = await paginasDe(db, true, doFixture);
      const soPorEventId = await paginasDe(db, false, doFixture);

      // --- the claim that matters: the total order pages the whole set --------
      //
      // The sequence, and not just the set: the concatenated list has to come out
      // ordered, page by page, from the first sha to the last.
      assert.deepEqual(
        comOrdemTotal.flat(),
        esperado,
        'ordenarContagens devia devolver as 4000 linhas, cada uma uma vez, em ordem',
      );

      // Rows of other tests sort after the fixture, so the sequence is: the
      // fixture fills the first pages completely, and every later page (there may
      // be none, one or many, depending on what else is in the view) holds none.
      const paginasDe500 = Math.ceil(LINHAS / PAGINA);
      const tamanhos = comOrdemTotal.map((p) => p.length);
      assert.deepEqual(
        tamanhos,
        [
          ...Array<number>(paginasDe500).fill(PAGINA),
          ...Array<number>(Math.max(0, tamanhos.length - paginasDe500)).fill(0),
        ],
        'linhas do fixture por página: as 8 primeiras cheias e nenhuma depois delas',
      );

      const emDuasPaginas = esperado.filter(
        (s) => comOrdemTotal.filter((pagina) => pagina.includes(s)).length > 1,
      );
      assert.deepEqual(emDuasPaginas, [], 'nenhuma linha pode aparecer em duas páginas');

      // --- the guard: does the fixture still bite? ----------------------------
      //
      // This does NOT measure pagination. It measures whether this environment
      // still reproduces the defect the assertion above exists to hold down. See
      // the failure message.
      assert.notDeepEqual(
        soPorEventId.flat(),
        esperado,
        'ATENÇÃO: esta falha NÃO quer dizer que a paginação quebrou. Quem mede a paginação ' +
          'é a asserção acima, com ordenarContagens, e ela passou. O que esta falha diz é que ' +
          'o fixture parou de reproduzir o defeito — ordenar só por event_id devolveu as 4000 ' +
          'linhas certas, o que era esperado ACIMA de 2000 linhas nesta máquina em 23/08/2026. ' +
          'Provavelmente work_mem maior neste ambiente; aumente LINHAS até o defeito voltar a ' +
          'aparecer e atualize a tabela no cabeçalho deste arquivo.',
      );
    } finally {
      await limpar(db);
    }
  },
);
