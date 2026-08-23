/**
 * How many digestions point at a rule text that no longer exists -- and how many
 * still depend on Polymarket not editing anything.
 *
 * `market_rule_digests` keeps `description_sha256`. The text got a home of its
 * own in `market_rule_texts` (issue #9), addressed by that hash. What this
 * measurement answers is the state of every digested text, in three buckets:
 *
 *   guardado          -- it is in `market_rule_texts`. It depends on nothing.
 *   ainda recuperável -- NOT stored, but some market's `events.description`
 *                        still matches the hash. This is the alarm: the evidence
 *                        exists today and vanishes the day the description is
 *                        edited.
 *   PERDIDO           -- not stored, and no current description matches. Every
 *                        finding from that text became a quotation of a document
 *                        nobody holds, and nothing brings it back.
 *
 * Before the backfill the middle bucket held all 267 texts; after it, zero, and
 * any number above zero here means a digestion landing without its text -- the
 * leak reopened.
 *
 * ## The sum is the backfill's own, on purpose
 *
 * What decides the three buckets is `planBackfill`, in `src/digest/texts.ts`,
 * which is pure and tested. A second implementation here would drift from the
 * first, and the measurement and the backfill would start disagreeing about what
 * is stored -- in silence. It is the defect the replicated view and the
 * duplicated `normalizarTrecho` already cost this project.
 *
 * ## What the reads cost, because a heavy read is not harmless
 *
 * Three queries, and none of them scans `events`:
 *
 * 1. all of `market_rule_digests`, projecting two columns -- the small table of
 *    the pair: 1264 readings and 267 distinct texts on 23/08/2026.
 * 2. all of `market_rule_texts`, projecting one.
 * 3. `events` by primary key, in batches, only for the `event_id`s the first
 *    query returned. `in` over the primary key uses the index; there is no
 *    `like`, no filter on an unindexed column, and the set is bounded by what
 *    already came back.
 *
 * SELECT only. It writes nothing.
 */
import 'dotenv/config';
import { supabase } from '../../src/lib/supabase.js';
import { planBackfill, type DigestedTextRef } from '../../src/digest/texts.js';

/** Batches for the `in`: PostgREST caps the URL length. */
const LOTE = 200;

/**
 * Ordenado por `id`, a chave primária, e não por `event_id`.
 *
 * `range` é OFFSET, e OFFSET sobre ordem NÃO TOTAL não é determinístico: o
 * Postgres não promete a mesma ordem entre uma página e a seguinte dentro de um
 * grupo empatado. `event_id` empata — são 1264 leituras para 1033 mercados —, e
 * com página de 1000 existe exatamente uma fronteira, caindo dentro de um desses
 * grupos. Uma linha empatada pode vir duas vezes ou nenhuma.
 *
 * Duplicata este script absorveria (a contagem é por chave), mas PERDA não: um
 * par sumido é um texto que a medição deixa de conferir e conta como se não
 * existisse. Numa medição cujo resultado é "zero perdidos", perder a linha é
 * perder exatamente a evidência que ela procura.
 *
 * É o defeito que `dados.ts` documenta e evita ordenando pela chave da view, e é
 * o mesmo que a issue #6 quer poder provar com um Postgres de verdade — escrito
 * aqui, no script que mede para a issue #9.
 */
async function lerPares(): Promise<DigestedTextRef[]> {
  const pares: DigestedTextRef[] = [];
  for (let de = 0; ; de += 1000) {
    const { data, error } = await supabase
      .from('market_rule_digests')
      .select('event_id, description_sha256')
      .order('id')
      .range(de, de + 999);
    if (error) throw new Error(`market_rule_digests: ${error.message}`);
    const linhas = (data ?? []) as { event_id: string; description_sha256: string }[];
    for (const l of linhas)
      pares.push({ eventId: l.event_id, descriptionSha256: l.description_sha256 });
    if (linhas.length < 1000) return pares;
  }
}

/**
 * What is stored. `null` when the table does not exist yet.
 *
 * The distinction matters: without it, the day before the apply and the day the
 * backfill did not run would print the same "0 stored", and only one of those is
 * an operations problem.
 */
async function lerGuardados(): Promise<Set<string> | null> {
  const guardados = new Set<string>();
  for (let de = 0; ; de += 500) {
    const { data, error } = await supabase
      .from('market_rule_texts')
      .select('description_sha256')
      .order('description_sha256')
      .range(de, de + 499);
    if (error) return null;
    const linhas = (data ?? []) as { description_sha256: string }[];
    for (const l of linhas) guardados.add(l.description_sha256);
    if (linhas.length < 500) return guardados;
  }
}

async function lerDescricoes(ids: readonly string[]): Promise<Map<string, string | null>> {
  const porId = new Map<string, string | null>();
  for (let i = 0; i < ids.length; i += LOTE) {
    const { data, error } = await supabase
      .from('events')
      .select('id, description')
      .in('id', ids.slice(i, i + LOTE));
    if (error) throw new Error(`events: ${error.message}`);
    for (const row of (data ?? []) as { id: string; description: string | null }[])
      porId.set(row.id, row.description);
  }
  return porId;
}

type Balde = 'guardado' | 'recuperavel' | 'perdido';

async function medir() {
  const pares = await lerPares();
  const ids = [...new Set(pares.map(p => p.eventId))];
  const guardados = await lerGuardados();
  const descricoes = await lerDescricoes(ids);

  const plano = planBackfill(pares, descricoes, guardados ?? new Set());

  const balde = new Map<string, Balde>();
  for (const sha of plano.alreadyStored) balde.set(sha, 'guardado');
  for (const t of plano.toStore) balde.set(t.descriptionSha256, 'recuperavel');
  for (const t of plano.unrecoverable) balde.set(t.descriptionSha256, 'perdido');

  const conta = (quais: Balde) => [...balde.values()].filter(b => b === quais).length;
  const total = balde.size;
  const frac = (n: number, de: number) => (de === 0 ? '—' : `${((100 * n) / de).toFixed(1)}%`);

  if (guardados === null) {
    console.log('market_rule_texts NÃO EXISTE no banco: a migration 20260823190031 não foi aplicada.');
    console.log('Os números abaixo medem o mundo sem ela — nenhum texto guardado, por ausência de tabela.\n');
  }

  console.log(`textos de regra distintos digeridos: ${total}`);
  console.log(`  guardado em market_rule_texts:  ${conta('guardado')} (${frac(conta('guardado'), total)})`);
  console.log(`  ainda recuperável de events:    ${conta('recuperavel')} (${frac(conta('recuperavel'), total)})`);
  console.log(`  TEXTO PERDIDO:                  ${conta('perdido')} (${frac(conta('perdido'), total)})`);

  // The (market, text) pair is still reported because it is the unit the rule
  // screen draws: one block per pair. A lost text shared by ten markets is one
  // line in the block above and ten broken screens down here.
  const distintos = new Map<string, DigestedTextRef>();
  for (const p of pares) distintos.set(`${p.eventId}|${p.descriptionSha256}`, p);

  const porBalde = { guardado: 0, recuperavel: 0, perdido: 0 };
  const mercadosPerdidos = new Set<string>();
  for (const p of distintos.values()) {
    const b = balde.get(p.descriptionSha256);
    if (b === undefined) continue;
    porBalde[b] += 1;
    if (b === 'perdido') mercadosPerdidos.add(p.eventId);
  }

  const totalPares = distintos.size;
  console.log(`\npares (mercado, texto) digeridos: ${totalPares}`);
  console.log(`  guardado:                       ${porBalde.guardado} (${frac(porBalde.guardado, totalPares)})`);
  console.log(`  ainda recuperável:              ${porBalde.recuperavel} (${frac(porBalde.recuperavel, totalPares)})`);
  console.log(`  TEXTO PERDIDO:                  ${porBalde.perdido} (${frac(porBalde.perdido, totalPares)})`);
  console.log(`mercados distintos com ao menos um texto perdido: ${mercadosPerdidos.size} de ${ids.length}`);

  if (plano.unrecoverable.length > 0) {
    console.log('\nos textos perdidos, um por linha — nada os traz de volta:');
    for (const t of plano.unrecoverable) {
      const motivo = t.reason === 'edited' ? 'descrição editada' : 'sem descrição';
      console.log(`  ${t.descriptionSha256.slice(0, 8)}  ${motivo}  ${t.markets.length} mercado(s)`);
    }
  }

  if (conta('recuperavel') > 0 && guardados !== null) {
    console.log(
      `\n${conta('recuperavel')} texto(s) ainda dependem de a Polymarket não editar a descrição.` +
        '\nRode: npm run backfill:texto-da-regra',
    );
  }
}

medir().catch(e => {
  console.error(e);
  process.exitCode = 1;
});
