import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

/**
 * The screen's session: one shared password, one signed cookie (ADR 0013).
 *
 * Stateless on purpose. The cookie carries its own expiry and an HMAC over that
 * expiry and the password's hash, keyed by a separate secret. Nothing is stored,
 * so there is no table and no migration; changing the password or the secret
 * ends every session at once, and that is the only way to end one.
 *
 * Server only: it imports `node:crypto`. The bundle scan in CI
 * (`scripts/conferir-bundle-web.ts`) is what proves no secret reaches the
 * browser, not an import guard.
 */

export const NOME_DO_COOKIE = 'radar_sessao';

/** 30 days. */
export const DURACAO_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * The brute-force control that travels with the code. 24 random characters
 * cannot be guessed online at any rate, so the dashboard rate limit is a second
 * line, not the only one.
 */
export const SENHA_MINIMA = 24;

const VERSAO = 'v1';

export type Configuracao = { senha: string; segredo: string };

/**
 * `null` closes the screen (503). A missing value, or a password shorter than
 * the minimum, is refused here so that no caller can open the screen with it.
 */
export function lerConfiguracao(env: Record<string, string | undefined>): Configuracao | null {
  const senha = env['RADAR_SENHA'];
  const segredo = env['RADAR_SEGREDO_DE_SESSAO'];
  if (!senha || !segredo) return null;
  if (senha.length < SENHA_MINIMA) return null;
  return { senha, segredo };
}

function sha256(texto: string): Buffer {
  return createHash('sha256').update(texto, 'utf8').digest();
}

/**
 * Constant-time compare. Both sides are hashed first, so they always have the
 * same length: `timingSafeEqual` throws on unequal lengths, and a length check
 * before it would leak the password's length.
 */
export function senhaConfere(tentativa: string, senha: string): boolean {
  return timingSafeEqual(sha256(tentativa), sha256(senha));
}

function assinar(texto: string, cfg: Configuracao): string {
  // The password's hash is part of the signed text: a cookie signed before a
  // password change stops verifying, even with the same secret.
  return createHmac('sha256', cfg.segredo)
    .update(`${texto}.${sha256(cfg.senha).toString('hex')}`)
    .digest('base64url');
}

/** The cookie's value: `v1.<expiry ms>.<signature>`. */
export function emitirSessao(cfg: Configuracao, agoraMs: number): string {
  const corpo = `${VERSAO}.${agoraMs + DURACAO_MS}`;
  return `${corpo}.${assinar(corpo, cfg)}`;
}

export function verificarSessao(
  valor: string | undefined,
  cfg: Configuracao,
  agoraMs: number,
): boolean {
  if (!valor) return false;
  const partes = valor.split('.');
  if (partes.length !== 3) return false;
  const [versao, expira, assinatura] = partes as [string, string, string];
  if (versao !== VERSAO || !/^\d{1,16}$/.test(expira)) return false;
  if (Number(expira) <= agoraMs) return false;

  const recebida = Buffer.from(assinatura);
  const esperada = Buffer.from(assinar(`${versao}.${expira}`, cfg));
  return recebida.length === esperada.length && timingSafeEqual(recebida, esperada);
}

function atributos(seguro: boolean, maxAgeS: number): string {
  const lista = ['Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAgeS}`];
  // Not on plain http: `next dev` on 127.0.0.1 would drop a Secure cookie.
  if (seguro) lista.push('Secure');
  return lista.join('; ');
}

export function cookieDaSessao(valor: string, seguro: boolean): string {
  return `${NOME_DO_COOKIE}=${valor}; ${atributos(seguro, DURACAO_MS / 1000)}`;
}

export function cookieQueApaga(seguro: boolean): string {
  return `${NOME_DO_COOKIE}=; ${atributos(seguro, 0)}`;
}

/** The session cookie's value from a `Cookie` header, if present. */
export function lerCookie(cabecalho: string | null): string | undefined {
  if (!cabecalho) return undefined;
  for (const par of cabecalho.split(';')) {
    const i = par.indexOf('=');
    if (i === -1) continue;
    if (par.slice(0, i).trim() === NOME_DO_COOKIE) return par.slice(i + 1).trim();
  }
  return undefined;
}
