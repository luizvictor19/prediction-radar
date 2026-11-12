/**
 * Archives one closed month of the radar series to Google Drive and writes the
 * guarded migration that drops it (issue 60).
 *
 *   npm run arquivar:particao -- 2026-11
 *
 * Run from the main checkout, which is linked to the production project. It
 * needs the Supabase CLI logged in and an rclone remote `gdrive` (see
 * docs/commands.md, "Arquivar o mês").
 *
 * Read-only on the database. Its writes are local files, the upload to Drive
 * and a new migration file. It never drops, deletes or overwrites: an
 * existing local folder or Drive file stops the run. The drop happens only
 * when Luiz applies the migration.
 *
 * Steps, stopping at the first failure:
 *   1. date guard (day 9 of the next month or later);
 *   2. table list from the catalog, to dump only the target partition;
 *   3. exact count(*) of the partition (a seq scan of a closed month, ~170 MB,
 *      approved in issue 60);
 *   4. data-only dump, setval lines removed, gzip -9, rows checked against 3;
 *   5. sha256 and manifest.json;
 *   6. rclone copy to Drive, then rclone check --download;
 *   7. supabase migration new, filled with the guarded drop.
 */

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { mkdir, stat, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';

import {
  comprimirSemSetval,
  conferirDump,
  listaDeExclusao,
  montarManifest,
  montarMigration,
  validarMes,
} from './lib/arquivo-frio.js';

const exec = promisify(execFile);

const REMOTO = 'gdrive:prediction-radar-arquivo-frio';
const PASTA_LOCAL = join(homedir(), 'arquivo-frio-radar');
const ENV = { ...process.env, SUPABASE_NO_UPDATE_CHECK: '1' };
const BUFFER = 64 * 1024 * 1024;

function rclone(): string {
  if (process.env['RCLONE']) return process.env['RCLONE'];
  const local = join(homedir(), '.local', 'bin', 'rclone');
  return existsSync(local) ? local : 'rclone';
}

async function rodar(cmd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await exec(cmd, args, { env: ENV, maxBuffer: BUFFER });
    return stdout;
  } catch (err) {
    const e = err as { stderr?: string; message: string };
    throw new Error(`${cmd} ${args[0] ?? ''} falhou: ${(e.stderr ?? e.message).trim()}`);
  }
}

/** `supabase db query --linked -o json`, rows only. */
async function consultar<T>(sql: string): Promise<T[]> {
  const out = await rodar('supabase', ['db', 'query', '--linked', sql, '-o', 'json']);
  const inicio = out.indexOf('{');
  if (inicio < 0) throw new Error(`resposta inesperada do supabase db query: ${out.slice(0, 200)}`);
  const json = JSON.parse(out.slice(inicio)) as { rows?: T[] };
  if (!Array.isArray(json.rows)) throw new Error('supabase db query sem "rows"');
  return json.rows;
}

async function sha256De(caminho: string): Promise<string> {
  const hash = createHash('sha256');
  await pipeline(createReadStream(caminho), hash);
  return hash.digest('hex');
}

async function main() {
  const arg = process.argv[2];
  if (!arg) throw new Error('uso: npm run arquivar:particao -- YYYY-MM');

  const agora = new Date();
  const mes = validarMes(arg, agora);
  // One folder per month, so the manifest of one month never meets another's.
  const nomePasta = `radar-${mes.mes}`;
  const pasta = join(PASTA_LOCAL, nomePasta);
  const arquivo = `${mes.particao}.sql.gz`;
  const destinoDrive = `${REMOTO}/${nomePasta}`;
  const rc = rclone();

  console.log(`[arquivar] ${mes.mes}: ${mes.particao} -> ${destinoDrive}/${arquivo}`);

  // Nothing is overwritten: a previous partial run is looked at, not papered over.
  if (existsSync(join(pasta, arquivo)) || existsSync(join(pasta, 'manifest.json'))) {
    throw new Error(`${pasta} já tem ${arquivo} ou manifest.json; confira antes de rodar de novo`);
  }
  const noDrive = await rodar(rc, ['lsf', destinoDrive]).catch(() => '');
  if (noDrive.split('\n').some((l) => l === arquivo || l === 'manifest.json')) {
    throw new Error(
      `${destinoDrive} já tem ${arquivo} ou manifest.json; confira antes de rodar de novo`,
    );
  }

  const tabelas = (
    await consultar<{ t: string }>(
      "select n.nspname || '.' || c.relname as t from pg_class c " +
        'join pg_namespace n on n.oid = c.relnamespace ' +
        "where n.nspname = 'public' and c.relkind = 'r' order by 1",
    )
  ).map((r) => r.t);
  const excluir = listaDeExclusao(tabelas, mes.particao);

  console.log('[arquivar] contando linhas no banco (seq scan do mês fechado)...');
  const [contagem] = await consultar<{ n: string }>(
    `select count(*)::text as n from public.${mes.particao}`,
  );
  const linhasNoBanco = Number(contagem?.n);
  if (!Number.isSafeInteger(linhasNoBanco)) throw new Error(`contagem inválida: ${contagem?.n}`);
  console.log(`[arquivar] ${linhasNoBanco} linhas no banco`);

  await mkdir(pasta, { recursive: true });
  const bruto = join(pasta, `${mes.particao}.sql`);
  console.log('[arquivar] dump...');
  await rodar('supabase', [
    'db',
    'dump',
    '--linked',
    '--data-only',
    '--use-copy',
    '-s',
    'public',
    '-x',
    excluir,
    '-f',
    bruto,
  ]);

  const caminhoGz = join(pasta, arquivo);
  const blocos = await comprimirSemSetval(bruto, caminhoGz);
  conferirDump(blocos, mes.particao, linhasNoBanco);
  await unlink(bruto);

  const sha256 = await sha256De(caminhoGz);
  const { size } = await stat(caminhoGz);
  const manifest = montarManifest({
    criadoEm: agora,
    mes,
    entrada: {
      table: `public.${mes.particao}`,
      file: arquivo,
      rows: blocos[0]?.linhas ?? 0,
      rows_in_db: linhasNoBanco,
      bytes: size,
      sha256,
    },
  });
  await writeFile(join(pasta, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`[arquivar] ${arquivo}: ${size} bytes, sha256 ${sha256}`);

  const filtro = ['--include', `/${arquivo}`, '--include', '/manifest.json'];
  console.log('[arquivar] enviando para o Drive...');
  await rodar(rc, ['copy', pasta, destinoDrive, ...filtro]);
  await rodar(rc, ['check', pasta, destinoDrive, ...filtro, '--download']);
  console.log('[arquivar] rclone check --download: 0 diferenças');

  const criada = await rodar('supabase', [
    'migration',
    'new',
    `drop_archived_radar_month_${mes.particao.slice(-6)}`,
  ]);
  // The CLI prints either text or {"path":"/abs/.../x.sql"}; take the path only.
  const caminhoMigration = /([^\s"]*supabase\/migrations\/[^\s"]+?\.sql)/.exec(criada)?.[1];
  if (!caminhoMigration) throw new Error(`não achei o caminho da migration em: ${criada}`);
  await writeFile(
    caminhoMigration,
    montarMigration({ mes, linhas: linhasNoBanco, pastaDrive: destinoDrive, arquivo, sha256 }),
  );

  console.log(`
[arquivar] pronto. ${mes.particao}: ${linhasNoBanco} linhas, conferidas no dump e no Drive.
  cópia local: ${pasta}
  Drive:       ${destinoDrive}
  migration:   ${caminhoMigration} (NÃO aplicada)

Falta (Luiz): revisar a migration e aplicar com \`supabase db push\`.
O DROP devolve o disco na hora, sem VACUUM.`);
}

main().catch((err: unknown) => {
  console.error(`[arquivar] parou: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
