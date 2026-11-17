import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/**
 * The check that the browser bundle of `web/` holds no server secret (issue 85,
 * ADR 0013). CI builds `web/` with canary values in the secret variables and
 * this scans `web/.next/static`, which is everything a browser can download.
 *
 * Bytes, not lines: `Buffer.indexOf` reads a file with a NUL byte like any
 * other, where `grep` would skip it as binary and report nothing (`CLAUDE.md`,
 * "Busca vazia não é ausência").
 */

/** The variables whose values must never reach the browser. */
export const VARIAVEIS_SECRETAS = [
  'SUPABASE_SERVICE_KEY',
  'RADAR_SENHA',
  'RADAR_SEGREDO_DE_SESSAO',
] as const;

/** Every canary starts with this, so the scan never runs on a real secret. */
export const PREFIXO_DO_CANARIO = 'canario-';

export type Achado = { arquivo: string; variavel: number };

function arquivosDe(raiz: string): string[] {
  return readdirSync(raiz, { recursive: true, encoding: 'utf8' })
    .map((f) => join(raiz, f))
    .filter((f) => statSync(f).isFile())
    .sort();
}

export function procurarCanarios(
  raiz: string,
  canarios: string[],
): { arquivos: number; achados: Achado[] } {
  const arquivos = arquivosDe(raiz);
  const agulhas = canarios.map((c) => Buffer.from(c, 'utf8'));
  const achados: Achado[] = [];
  for (const arquivo of arquivos) {
    const bytes = readFileSync(arquivo);
    agulhas.forEach((agulha, i) => {
      if (bytes.indexOf(agulha) !== -1) {
        achados.push({ arquivo: relative(raiz, arquivo).split(sep).join('/'), variavel: i });
      }
    });
  }
  return { arquivos: arquivos.length, achados };
}

/**
 * The verdict, with a message for the operator. Only the variable NAMES are
 * ever printed, never a value.
 */
export function conferirCanarios(
  raiz: string,
  env: Record<string, string | undefined>,
): { ok: boolean; mensagem: string } {
  const presentes = VARIAVEIS_SECRETAS.filter((v) => env[v] !== undefined && env[v] !== '');
  if (!presentes.includes('SUPABASE_SERVICE_KEY')) {
    return {
      ok: false,
      mensagem: 'SUPABASE_SERVICE_KEY não está definida: o build tem que ser feito com um canário.',
    };
  }
  const reais = presentes.filter((v) => !env[v]!.startsWith(PREFIXO_DO_CANARIO));
  if (reais.length > 0) {
    return {
      ok: false,
      mensagem:
        `${reais.join(', ')} não começa com "${PREFIXO_DO_CANARIO}". ` +
        'Esta conferência só roda sobre um build feito com canários, nunca com o segredo real.',
    };
  }

  if (!existsSync(raiz)) {
    return { ok: false, mensagem: `${raiz} não existe: rode o build de web/ antes.` };
  }
  const canarios = presentes.map((v) => env[v]!);
  const { arquivos, achados } = procurarCanarios(raiz, canarios);
  if (arquivos === 0) {
    return { ok: false, mensagem: `${raiz} está vazia: nada foi lido, então nada foi provado.` };
  }
  if (achados.length > 0) {
    const linhas = achados.map((a) => `  ${presentes[a.variavel]} em ${a.arquivo}`);
    return {
      ok: false,
      mensagem: `SEGREDO NO BUNDLE DO NAVEGADOR (${achados.length}):\n${linhas.join('\n')}`,
    };
  }
  return {
    ok: true,
    mensagem: `${arquivos} arquivos lidos em ${raiz}; nenhum contém ${presentes.join(', ')}.`,
  };
}
