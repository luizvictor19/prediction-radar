/**
 * The parts of the monthly archive of the radar series (issue 60) that
 * decide something or touch only local files.
 *
 * The orchestrator in `scripts/arquivar-particao.ts` shells out to the
 * Supabase CLI and rclone; everything here can be tested without a network or
 * a database.
 */

import { once } from 'node:events';
import { createReadStream, createWriteStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';

import { ARCHIVE_MIN_DAY } from '../../src/lib/radar-archive.js';

/** Day of the next month from which a closed month may leave the database. */
export const DIA_MINIMO = ARCHIVE_MIN_DAY;

export type Mes = {
  /** `YYYY-MM` as given. */
  mes: string;
  /** `polymarket_snapshots_pYYYYMM`. */
  particao: string;
  /** First instant of the month, UTC. */
  inicio: Date;
  /** First instant of the next month, UTC. */
  fim: Date;
};

/**
 * Parses `YYYY-MM` and refuses a month that cannot be archived yet: the
 * current or a future month, or the previous month before day 9 of this one.
 */
export function validarMes(mes: string, agora: Date): Mes {
  const m = /^(\d{4})-(\d{2})$/.exec(mes);
  if (!m) throw new Error(`mês inválido: "${mes}" (use YYYY-MM)`);

  const ano = Number(m[1]);
  const numero = Number(m[2]);
  if (numero < 1 || numero > 12) throw new Error(`mês inválido: "${mes}"`);

  const inicio = new Date(Date.UTC(ano, numero - 1, 1));
  const fim = new Date(Date.UTC(ano, numero, 1));
  const liberado = new Date(Date.UTC(ano, numero, DIA_MINIMO));

  if (agora < fim) throw new Error(`${mes} ainda não fechou`);
  if (agora < liberado) {
    throw new Error(
      `${mes} só pode sair a partir de ${liberado.toISOString().slice(0, 10)}: ` +
        'a tela e o bot ainda leem a última semana da série',
    );
  }

  return { mes, particao: `polymarket_snapshots_p${m[1]}${m[2]}`, inicio, fim };
}

/**
 * The `-x` list for `supabase db dump --data-only`: every public table except
 * the target, so the dump holds exactly one COPY block.
 */
export function listaDeExclusao(tabelas: readonly string[], alvo: string): string {
  const qualificado = `public.${alvo}`;
  if (!tabelas.includes(qualificado)) throw new Error(`${qualificado} não existe no banco`);
  return tabelas.filter((t) => t !== qualificado).join(',');
}

export type BlocoCopy = { tabela: string; linhas: number };

/**
 * Counts the data rows of every COPY block in a pg_dump text stream. A block
 * starts at `COPY "schema"."table" ... FROM stdin;` and ends at a line that is
 * exactly `\.`.
 */
export async function contarBlocosCopy(linhas: AsyncIterable<string>): Promise<BlocoCopy[]> {
  const blocos: BlocoCopy[] = [];
  let atual: BlocoCopy | null = null;

  for await (const linha of linhas) {
    if (atual) {
      if (linha === '\\.') {
        blocos.push(atual);
        atual = null;
      } else {
        atual.linhas++;
      }
      continue;
    }
    // The Supabase CLI quotes both names (`COPY "public"."t" ...`, seen in
    // the 2026-11-12 dumps); plain pg_dump quotes only when needed. Accept both.
    const m = /^COPY (?:"([^"]+)"|(\w+))\.(?:"([^"]+)"|(\w+)) .* FROM stdin;$/.exec(linha);
    if (m) atual = { tabela: `${m[1] ?? m[2]}.${m[3] ?? m[4]}`, linhas: 0 };
  }

  if (atual) throw new Error(`bloco COPY de ${atual.tabela} sem terminador`);
  return blocos;
}

/**
 * The dump must hold exactly the target block, with exactly the rows the
 * database counted. Anything else stops the archive.
 */
export function conferirDump(blocos: readonly BlocoCopy[], alvo: string, linhasNoBanco: number) {
  const qualificado = `public.${alvo}`;
  if (blocos.length !== 1 || blocos[0]?.tabela !== qualificado) {
    const achados = blocos.map((b) => b.tabela).join(', ') || 'nenhum';
    throw new Error(`o dump devia ter só ${qualificado}, tem: ${achados}`);
  }
  if (blocos[0].linhas !== linhasNoBanco) {
    throw new Error(
      `${qualificado}: ${blocos[0].linhas} linhas no dump, ${linhasNoBanco} no banco`,
    );
  }
}

/**
 * pg_dump --data-only also writes `setval` for every sequence in the schema.
 * Restoring an old month with them would wind `system_logs_id_seq` and
 * `polymarket_snapshots_id_seq` back to old values, and the next insert would
 * collide. The archive keeps data only.
 */
export function ehSetval(linha: string): boolean {
  return linha.startsWith('SELECT pg_catalog.setval(');
}

export type EntradaManifest = {
  table: string;
  file: string;
  rows: number;
  rows_in_db: number;
  bytes: number;
  sha256: string;
};

export function montarManifest(params: { criadoEm: Date; mes: Mes; entrada: EntradaManifest }) {
  const { criadoEm, mes, entrada } = params;
  return {
    created_at: criadoEm.toISOString().replace(/\.\d{3}Z$/, 'Z'),
    project: 'prediction-radar',
    issue: 60,
    month: mes.mes,
    format: 'supabase db dump --data-only --use-copy (pg_dump COPY), setval lines removed, gzip -9',
    restore:
      'create the partition first: create table public.' +
      `${mes.particao} partition of public.polymarket_snapshots for values from ` +
      `('${mes.inicio.toISOString()}') to ('${mes.fim.toISOString()}'); ` +
      'then gunzip -c FILE | psql <db-url>',
    tables: [entrada],
  };
}

/**
 * The guarded drop migration, the same shape as
 * 20261112041338_drop_archived_radar_months.sql with one partition.
 */
export function montarMigration(params: {
  mes: Mes;
  linhas: number;
  pastaDrive: string;
  arquivo: string;
  sha256: string;
}): string {
  const { mes, linhas, pastaDrive, arquivo, sha256 } = params;
  const p = mes.particao;
  return `-- Issue 60: drop ${p}, archived by \`npm run arquivar:particao -- ${mes.mes}\`.
--
-- Archive: ${pastaDrive}/${arquivo} (sha256 ${sha256}),
-- ${linhas} rows, equal to an exact count(*) in this database when the script
-- ran, and checked by rclone check --download after the upload. A second copy
-- lives on the owner's machine in ~/arquivo-frio-radar/. setval lines were
-- removed from the dump, so restoring does not rewind any sequence.
--
-- Restoring: if polymarket_snapshots_default holds rows in this month, move
-- them aside first; then
--   create table public.${p} partition of public.polymarket_snapshots
--     for values from ('${mes.inicio.toISOString()}') to ('${mes.fim.toISOString()}');
-- and \`gunzip -c ${arquivo} | psql <db-url>\`.
--
-- Same guard as 20261112041338: SHARE lock, recount, refuse on more rows than
-- the archive (a row written after the export), pass on a missing or empty
-- partition (a fresh local stack). lock_timeout caps the wait for ACCESS
-- EXCLUSIVE on the parent at 10 s; while it waits, new queries on the parent
-- queue behind it.

do $archive$
declare
  expected constant bigint := ${linhas};
  actual bigint;
begin
  perform set_config('lock_timeout', '10s', true);

  if to_regclass('public.${p}') is not null then
    lock table public.${p} in share mode;
    select count(*) into actual from public.${p};
    if actual > expected then
      raise exception 'issue 60: ${p} tem % linhas e o arquivo só tem %; nada foi apagado',
        actual, expected;
    end if;
    drop table public.${p};
  end if;
end
$archive$;
`;
}

/**
 * Reads the raw dump once: counts the COPY blocks and writes the gzip without
 * the setval lines, in the same pass.
 */
export async function comprimirSemSetval(bruto: string, destino: string) {
  const gzip = createGzip({ level: 9 });
  const escrita = pipeline(gzip, createWriteStream(destino));
  // Observed from the start, so a write error is never an unhandled rejection
  // while the reader is still busy; it is rethrown at the next drain wait or
  // at the final await.
  let falha: unknown = null;
  escrita.catch((err: unknown) => {
    falha = err;
  });

  async function* linhas() {
    const rl = createInterface({ input: createReadStream(bruto), crlfDelay: Infinity });
    for await (const linha of rl) {
      if (falha) throw falha;
      if (!ehSetval(linha) && !gzip.write(`${linha}\n`)) {
        // Waits for drain, or fails with the pipeline if the destination broke.
        await Promise.race([
          once(gzip, 'drain'),
          escrita.then(() => {
            throw new Error('a escrita do gzip terminou antes do fim do dump');
          }),
        ]);
      }
      yield linha;
    }
  }

  try {
    const blocos = await contarBlocosCopy(linhas());
    gzip.end();
    await escrita;
    return blocos;
  } catch (err) {
    gzip.destroy();
    throw err;
  }
}
