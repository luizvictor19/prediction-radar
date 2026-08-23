import { test } from 'node:test';
import assert from 'node:assert/strict';

import { SKIP_REASON, testDatabase } from '../../../src/lib/test-db.js';
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
 */

/** Read the table above before touching this. 4000 clears the measured frontier. */
const LINHAS = 4000;

const MARCA = 'teste-paginacao';

function sha(i: number): string {
  // Fixed width: in 64-position hex, lexicographic order is numeric order, so the
  // sorted seeded list is `sha(0)..sha(n-1)` without depending on a comparator.
  return i.toString(16).padStart(64, '0');
}

type Cliente = NonNullable<Awaited<ReturnType<typeof testDatabase>>>;

/**
 * The pages SEPARATED, not the concatenated list: where a row shows up is part of
 * the finding, and an already-flattened list cannot tell "came twice on the same
 * page" from "came on two pages".
 */
async function paginasDe(db: Cliente, ordemTotal: boolean): Promise<string[][]> {
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
    paginas.push(lote.map((l) => l.description_sha256));
    if (lote.length < PAGINA) return paginas;
  }
}

async function semear(db: Cliente): Promise<string> {
  const { data, error } = await db
    .from('events')
    .insert({
      polymarket_id: `${MARCA}-${process.pid}`,
      title: `${MARCA}: offset sob ordem não-total`,
    })
    .select('id')
    .single();
  if (error) throw new Error(`events: ${error.message}`);
  const eventId = (data as { id: string }).id;

  for (let i = 0; i < LINHAS; i += 200) {
    const lote = Array.from({ length: Math.min(200, LINHAS - i) }, (_, k) => ({
      event_id: eventId,
      description_sha256: sha(i + k),
      resolve_sim: ['sim'],
      model: MARCA,
      prompt_version: MARCA,
    }));
    const { error: e } = await db.from('market_rule_digests').insert(lote);
    if (e) throw new Error(`market_rule_digests: ${e.message}`);
  }
  return eventId;
}

/** Takes the digestions with it, through the FK cascade. */
async function limpar(db: Cliente) {
  const { error } = await db.from('events').delete().like('polymarket_id', `${MARCA}-%`);
  if (error) throw new Error(`limpeza: ${error.message}`);
}

test(
  'paginação da tela: ordem total não perde nem duplica linha empatada em event_id',
  { timeout: 300_000 },
  async (t) => {
    const db = await testDatabase();
    if (db === null) return t.skip(SKIP_REASON);

    // Leftovers from an earlier run that died halfway.
    await limpar(db);

    // The query is `lerContagens`'s, which does NOT filter by market — filtering
    // changes the plan and the defect does not show up. So the view has to hold
    // the fixture and nothing else.
    const { count, error } = await db
      .from('digest_achados_por_mercado')
      .select('*', { count: 'exact', head: true });
    if (error) throw new Error(error.message);
    assert.equal(
      count,
      0,
      `o banco de teste precisa estar vazio para este teste (a view tem ${count} linhas). ` +
        'Zere com `supabase stop --no-backup && npm run test:db`.',
    );

    const esperado = Array.from({ length: LINHAS }, (_, i) => sha(i));

    await semear(db);
    try {
      const comOrdemTotal = await paginasDe(db, true);
      const soPorEventId = await paginasDe(db, false);

      // --- the claim that matters: the total order pages the whole set --------
      //
      // The sequence, and not just the set: the concatenated list has to come out
      // ordered, page by page, from the first sha to the last.
      assert.deepEqual(
        comOrdemTotal.flat(),
        esperado,
        'ordenarContagens devia devolver as 4000 linhas, cada uma uma vez, em ordem',
      );

      const paginasDe500 = Math.ceil(LINHAS / PAGINA);
      assert.deepEqual(
        comOrdemTotal.map((p) => p.length),
        [...Array<number>(paginasDe500).fill(PAGINA), 0],
        'a sequência de tamanhos de página tem que ser 8 cheias e a última vazia',
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
