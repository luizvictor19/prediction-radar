/**
 * The screen's pagination, and the ordering it requires.
 *
 * This lived inside `dados.ts` until issue #6. It moved because `dados.ts`
 * imports the browser client — which reads `import.meta.env` and
 * `window.location.origin` — and a Node test cannot load that module. Without
 * the split, the test that runs against a real Postgres would have to RESTATE
 * the query it claims is correct, and would then be asserting about the copy.
 * That is the same defect the duplicated view and the duplicated
 * `normalizarTrecho` already cost this project.
 *
 * No client here: only the page size, the ordering, and the function that
 * applies them.
 */

export const PAGINA = 500;

/**
 * `data: unknown` on purpose: the client has no generated database types, and
 * supabase-js's `select()` parser only understands a LITERAL string — the column
 * list is built at runtime. The real shapes live in `tipos.ts`, written against
 * the migrations.
 */
export type Resposta = PromiseLike<{ data: unknown; error: { message: string } | null }>;

/**
 * PostgREST truncates at 1000 rows per response and does not say so — the list
 * would come back cut with the face of a complete one. Same pattern as
 * `scripts/nivelar-leituras.ts`.
 */
export async function paginar<T>(monta: (de: number, ate: number) => Resposta): Promise<T[]> {
  const tudo: T[] = [];
  for (let de = 0; ; de += PAGINA) {
    const { data, error } = await monta(de, de + PAGINA - 1);
    if (error) throw new Error(error.message);
    const lote = (data ?? []) as T[];
    tudo.push(...lote);
    if (lote.length < PAGINA) return tudo;
  }
}

export const COLUNAS_CONTAGEM = [
  'event_id',
  'description_sha256',
  'leituras_do_texto',
  'mercados_do_texto',
  'achados_total',
  'achados_acusados',
  'achados_herdados',
  'pegadinhas',
  'ambiguidades',
  'contradicoes',
  'pegadinhas_muda_resultado',
  'confirmacao_maxima',
].join(', ');

/**
 * The ordering of `digest_achados_por_mercado`, and it is a TOTAL order on
 * purpose.
 *
 * The view's grain is (market, rule text), so `event_id` alone is NOT a total
 * order: two texts of the same market tie on it. Paging by `range` is OFFSET,
 * and with a tie Postgres does not promise a stable order between one page and
 * the next — at the boundary, one of the tied rows can arrive twice or not at
 * all. Then the list counts one text's contradiction twice, or loses another's,
 * and silently.
 *
 * This does not bite in production today: each market has a single text — 1033
 * rows for 1033 markets, measured 2026-08-22 by `npm run medir:tela-regra` —,
 * and with one text per market `event_id` is unique. But it is exactly the case
 * `juntarRadarComDigest` and `textosParaLer` came to support, and a description
 * edited on Polymarket creates the second row.
 *
 * `(event_id, description_sha256)` is the view's key — its `group by` ends on
 * those two — so it is a total order, and pagination becomes deterministic
 * again.
 *
 * This stopped being a promise and became a measured claim in
 * `dados.db.test.ts`, against a real Postgres.
 */
export const ORDEM_CONTAGENS = ['event_id', 'description_sha256'] as const;

/** Only what exposes a chainable `order`; neither the client nor supabase-js's generics. */
export interface Ordenavel<Q> {
  order(coluna: string): Q;
}

export function ordenarContagens<Q extends Ordenavel<Q>>(q: Q): Q {
  return ORDEM_CONTAGENS.reduce<Q>((acc, coluna) => acc.order(coluna), q);
}
