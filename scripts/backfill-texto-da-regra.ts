import 'dotenv/config';
import { section, table } from './lib/probe-net.js';
import { supabase } from '../src/lib/supabase.js';
import { planBackfill, type BackfillPlan, type DigestedTextRef } from '../src/digest/texts.js';

/**
 * The issue #9 backfill: store in `market_rule_texts` the text of every
 * digestion that already exists, while it is still recoverable.
 *
 * `market_rule_digests` keeps `description_sha256` and never the text. The text
 * only lives in `events.description`, which is the CURRENT version and is
 * overwritten when Polymarket edits the description. Measured on 23/08/2026,
 * all 267 distinct texts behind the 1264 readings were recoverable -- 100%, and
 * that is the highest rate this script will ever see. Every day it does not run
 * is more evidence that can vanish in silence.
 *
 * **This script writes, and that is why the default is not to write.** Without
 * `--confirmar` it plans everything, prints the three numbers and stops. The
 * owner is the one who runs it with `--confirmar`.
 *
 *   npm run backfill:texto-da-regra
 *   npm run backfill:texto-da-regra -- --confirmar
 *
 * ## What the reads cost, because a heavy read is not harmless
 *
 * Three queries, and none of them scans `events`:
 *
 * 1. all of `market_rule_digests`, projecting two columns -- 1264 rows.
 * 2. all of `market_rule_texts`, projecting one -- what is already stored.
 * 3. `events` by primary key, in batches of 200, only for the `event_id`s the
 *    first query returned. `in` over the primary key uses the index; there is no
 *    `like` and no filter on an unindexed column.
 *
 * Same shape as `scripts/medicoes/texto-perdido.ts`, which already runs.
 *
 * ## What this script does NOT do
 *
 * It does not apply a migration. Without `market_rule_texts` in the database it
 * STOPS and names the file to apply -- there is no "create what is missing"
 * mode.
 *
 * And it invents no link: a text is only ever stored under a hash it produces
 * itself. The check is `planBackfill`, in `src/digest/texts.ts`, which is pure
 * and tested -- including against the mutation that removes that very check.
 */

const LABEL = 'backfill-texto-da-regra';

/** Batches for the `in`: PostgREST caps the URL length. */
const LOTE_LEITURA = 200;

/**
 * The write batch.
 *
 * 50, the same as `carregar-digest.ts` and for the same reason: PostgREST has an
 * 8s deadline and every row carries a whole regulation (median 945 characters,
 * measured maximum 5456). 267 serial round trips would be minutes of latency for
 * a job that takes seconds; a single round trip would be 326 KB in one POST.
 */
const LOTE_ESCRITA = 50;

async function lerDigests(): Promise<DigestedTextRef[]> {
  const refs: DigestedTextRef[] = [];
  for (let de = 0; ; de += 500) {
    const { data, error } = await supabase
      .from('market_rule_digests')
      .select('event_id, description_sha256')
      // Ordered by `id`, the primary key, and not by `event_id`: `range` is
      // OFFSET, and OFFSET over a NON-TOTAL order is not deterministic. A pair
      // lost at a page boundary is a text this script fails to store without
      // ever saying it did.
      .order('id')
      .range(de, de + 499);
    if (error) throw new Error(`market_rule_digests: ${error.message}`);
    const lote = (data ?? []) as { event_id: string; description_sha256: string }[];
    for (const l of lote)
      refs.push({ eventId: l.event_id, descriptionSha256: l.description_sha256 });
    if (lote.length < 500) return refs;
  }
}

/**
 * What is already stored.
 *
 * `null` when the table does not exist -- which is different from "it is empty".
 * Without the distinction the script would run all the way against a missing
 * table and only fail at the write, with the plan already printed as though it
 * were executable.
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
    const lote = (data ?? []) as { description_sha256: string }[];
    for (const l of lote) guardados.add(l.description_sha256);
    if (lote.length < 500) return guardados;
  }
}

async function lerDescricoes(ids: readonly string[]): Promise<Map<string, string | null>> {
  const porId = new Map<string, string | null>();
  for (let i = 0; i < ids.length; i += LOTE_LEITURA) {
    const { data, error } = await supabase
      .from('events')
      .select('id, description')
      .in('id', ids.slice(i, i + LOTE_LEITURA));
    if (error) throw new Error(`events: ${error.message}`);
    for (const row of (data ?? []) as { id: string; description: string | null }[])
      porId.set(row.id, row.description);
  }
  return porId;
}

/**
 * The write, in batches, with `guardado_por = 'backfill'`.
 *
 * `upsert` with `ignoreDuplicates` rather than `insert`: running twice must
 * neither duplicate nor blow up, and a crash halfway has to be able to pick up
 * where it stopped. The primary key is the hash, so "it is already there" is the
 * right answer and not an error to handle.
 *
 * `created_at` is not sent: the default is Postgres's `now()`. The clock of
 * whoever runs the script does not decide when the text was stored.
 */
async function gravar(plano: BackfillPlan): Promise<number> {
  let gravados = 0;
  for (let i = 0; i < plano.toStore.length; i += LOTE_ESCRITA) {
    const lote = plano.toStore.slice(i, i + LOTE_ESCRITA).map((t) => ({
      description_sha256: t.descriptionSha256,
      description: t.description,
      guardado_por: 'backfill',
    }));

    const { data, error } = await supabase
      .from('market_rule_texts')
      .upsert(lote, { onConflict: 'description_sha256', ignoreDuplicates: true })
      .select('description_sha256');

    if (error !== null) throw new Error(`insert em market_rule_texts falhou: ${error.message}`);

    gravados += data?.length ?? 0;
    console.log(`  ${gravados}/${plano.toStore.length} textos guardados`);
  }
  return gravados;
}

async function main() {
  const confirmar = process.argv.includes('--confirmar');

  console.log(section('Lendo'));

  const guardados = await lerGuardados();
  if (guardados === null) {
    console.error(
      `\n[${LABEL}] market_rule_texts não existe no banco.\n` +
        '  Aplique a 20260823190031_guardar_texto_da_regra.sql antes de rodar.\n' +
        '  Este script não aplica migration — quem aplica é o dono. Nada foi lido de events.',
    );
    process.exit(1);
    return;
  }

  const refs = await lerDigests();
  const mercados = [...new Set(refs.map((r) => r.eventId))];
  const textos = new Set(refs.map((r) => r.descriptionSha256));
  console.log(
    `  market_rule_digests: ${refs.length} leituras, ${mercados.length} mercados, ${textos.size} textos distintos`,
  );
  console.log(`  market_rule_texts:   ${guardados.size} textos já guardados`);

  const descricoes = await lerDescricoes(mercados);
  console.log(`  events:              ${descricoes.size} descrições lidas por PK`);

  const plano = planBackfill(refs, descricoes, guardados);

  console.log(section('O plano'));
  const total = textos.size;
  const frac = (n: number) => (total === 0 ? '—' : `${((100 * n) / total).toFixed(1)}%`);
  console.log(
    table(
      ['medida', 'textos', 'do total'],
      [
        ['a guardar agora', String(plano.toStore.length), frac(plano.toStore.length)],
        ['já guardados', String(plano.alreadyStored.length), frac(plano.alreadyStored.length)],
        ['IRRECUPERÁVEIS', String(plano.unrecoverable.length), frac(plano.unrecoverable.length)],
      ],
      [0],
    ),
  );

  if (plano.unrecoverable.length > 0) {
    // The whole list, never truncated. Every line here is evidence this project
    // lost for good, and the count alone does not say whose.
    console.error(
      `\n  ${plano.unrecoverable.length} texto(s) não existem mais em lugar nenhum. Nada os traz de volta:`,
    );
    for (const t of plano.unrecoverable) {
      const motivo = t.reason === 'edited' ? 'descrição editada' : 'sem descrição';
      console.error(
        `    ${t.descriptionSha256.slice(0, 8)}  ${motivo}  ${t.markets.length} mercado(s): ${t.markets.join(', ')}`,
      );
    }
  }

  if (plano.toStore.length === 0) {
    console.log('\n  nada a gravar.');
    return;
  }

  if (!confirmar) {
    console.log(
      `\n[${LABEL}] DRY RUN: nada foi escrito.\n` +
        `  ${plano.toStore.length} textos conferidos contra o próprio hash e prontos.\n` +
        '  Para gravar: npm run backfill:texto-da-regra -- --confirmar',
    );
    return;
  }

  console.log(section('Gravando'));
  const gravados = await gravar(plano);

  console.log(section('Gravado'));
  console.log(`  ${gravados} linhas em market_rule_texts, guardado_por = 'backfill'.`);
  // No "conferir se o hash bate" aqui: `market_rule_texts_hash_confere` já o fez,
  // por linha, no momento do insert. Uma linha que não hasheia para a própria
  // chave não chegou a existir, então a consulta de conferência mediria zero
  // sempre — e conferência que não pode falhar é decoração.
  console.log('\n  Confira com:');
  console.log('    npm run medir:texto-perdido');
  console.log('\n  E então, se ele acusar 0 recuperáveis e 0 perdidos, a validação da FK:');
  console.log('    alter table public.market_rule_digests');
  console.log('      validate constraint market_rule_digests_texto_guardado;');
}

main().catch((err: unknown) => {
  console.error(`[${LABEL}] falhou:`, err instanceof Error ? err.message : String(err));
  process.exit(1);
});
