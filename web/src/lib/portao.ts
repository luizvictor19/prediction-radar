import {
  cookieDaSessao,
  cookieQueApaga,
  emitirSessao,
  lerConfiguracao,
  lerCookie,
  senhaConfere,
  verificarSessao,
  type Configuracao,
} from './sessao';

/**
 * The gate (ADR 0013). One decision for every request, taken twice: in
 * `src/proxy.ts` before anything renders, and again inside every route handler
 * through `comSessao`. The Next docs say a matcher change can silently remove
 * Proxy coverage, so Proxy is not trusted alone.
 *
 * Plain `Request` and `Response`, no `next` import, so the whole gate runs
 * under `tsx --test` with the rest of the suite.
 */

type Env = Record<string, string | undefined>;

/**
 * Paths that answer without a session, matched exactly, never by prefix. The
 * logout is here so that it works with an expired cookie or after a password
 * change; it only clears the cookie, and still goes through the Origin check.
 */
export const CAMINHOS_SEM_SESSAO: ReadonlySet<string> = new Set([
  '/entrar',
  '/api/entrar',
  '/api/sair',
]);

/** Local names `next dev` and `next start` answer on, any port, off Vercel only. */
const NOMES_LOCAIS = new Set(['127.0.0.1', 'localhost']);

/**
 * The host this request is for, if this screen answers on it; `null` if not.
 *
 * The candidate is the `Host` header (or `req.url`'s host when there is none),
 * and it is trusted only when it is on the allow-list: `RADAR_HOSTS` (comma
 * separated, for a custom domain), the deployment hosts Vercel sets in
 * `VERCEL_PROJECT_PRODUCTION_URL`, `VERCEL_BRANCH_URL` and `VERCEL_URL`, and,
 * off Vercel, 127.0.0.1 and localhost. `X-Forwarded-Host` is not read: Vercel
 * routes by `Host` and hands it to the function, so a second header would only
 * be one more thing to trust. Redirects and the Origin check both use this
 * host, so neither is built from a value the client chose freely.
 */
export function hostConfiavel(req: Request, env: Env): string | null {
  const candidato = (req.headers.get('host') ?? new URL(req.url).host).toLowerCase();
  const naVercel = env['VERCEL'] === '1';

  const lista = [
    ...(env['RADAR_HOSTS'] ?? '').split(','),
    env['VERCEL_PROJECT_PRODUCTION_URL'],
    env['VERCEL_BRANCH_URL'],
    env['VERCEL_URL'],
  ]
    .map((h) => (h ?? '').trim().toLowerCase())
    .filter((h) => h !== '');
  if (lista.includes(candidato)) return candidato;

  if (!naVercel) {
    try {
      if (NOMES_LOCAIS.has(new URL(`http://${candidato}`).hostname)) return candidato;
    } catch {
      // Not a host at all.
    }
  }
  return null;
}

export type Decisao =
  | { tipo: 'passa' }
  | { tipo: 'para_o_login' }
  | { tipo: 'nao_autorizado' }
  | { tipo: 'origem_proibida' }
  | { tipo: 'host_desconhecido' }
  | { tipo: 'sem_configuracao' };

export type Pedido = {
  metodo: string;
  caminho: string;
  cookie: string | undefined;
  /** The `Origin` header's host, when the browser sent one. */
  hostDaOrigem: string | null;
  /** From `hostConfiavel`: `null` when the host is not on the allow-list. */
  host: string | null;
};

export function decidir(p: Pedido, cfg: Configuracao | null, agoraMs: number): Decisao {
  // Fail closed: no configuration opens nothing, the login page included.
  if (cfg === null) return { tipo: 'sem_configuracao' };
  if (p.host === null) return { tipo: 'host_desconhecido' };

  // A browser always sends Origin on a cross-site POST. A missing one is not a
  // browser being tricked, so it is left to the session check below.
  const escreve = p.metodo !== 'GET' && p.metodo !== 'HEAD';
  if (escreve && p.hostDaOrigem !== null && p.hostDaOrigem !== p.host) {
    return { tipo: 'origem_proibida' };
  }

  if (CAMINHOS_SEM_SESSAO.has(p.caminho)) return { tipo: 'passa' };
  if (verificarSessao(p.cookie, cfg, agoraMs)) return { tipo: 'passa' };
  return p.caminho.startsWith('/api/') ? { tipo: 'nao_autorizado' } : { tipo: 'para_o_login' };
}

function hostDe(origem: string | null): string | null {
  if (origem === null) return null;
  try {
    return new URL(origem).host.toLowerCase();
  } catch {
    // An unparsable Origin cannot match this host.
    return 'origem-ilegivel';
  }
}

/** Nothing from the gate or the journal goes into a shared cache. */
export const SEM_CACHE = 'private, no-store';

function texto(status: number, corpo: string): Response {
  return new Response(corpo, {
    status,
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': SEM_CACHE },
  });
}

function json(status: number, corpo: unknown): Response {
  return new Response(JSON.stringify(corpo), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': SEM_CACHE },
  });
}

/** What the gate hands to a handler it lets through. */
export type Sessao<C> = {
  ctx: C;
  cfg: Configuracao;
  agoraMs: number;
  /** `https://<trusted host>` on Vercel; the request's own scheme elsewhere. */
  origem: string;
};

type Avaliacao = { resposta: Response } | { cfg: Configuracao; origem: string };

/**
 * Absolute `Location`: Next's Proxy answers 500 ("Invalid URL") to a relative
 * one, measured under `next dev` on 2026-11-17. The base is the trusted host,
 * never `req.url`, whose host is `localhost` inside a route handler under
 * `next dev -H 127.0.0.1`.
 */
function redirecionar(status: 303 | 307, origem: string, caminho: string, cookie?: string) {
  const headers = new Headers({
    location: new URL(caminho, origem).toString(),
    'cache-control': SEM_CACHE,
  });
  if (cookie !== undefined) headers.set('set-cookie', cookie);
  return new Response(null, { status, headers });
}

export function avaliar(req: Request, env: Env, agoraMs: number): Avaliacao {
  const url = new URL(req.url);
  const host = hostConfiavel(req, env);
  const cfg = lerConfiguracao(env);
  const d = decidir(
    {
      metodo: req.method.toUpperCase(),
      caminho: url.pathname,
      cookie: lerCookie(req.headers.get('cookie')),
      hostDaOrigem: hostDe(req.headers.get('origin')),
      host,
    },
    cfg,
    agoraMs,
  );
  const origem = `${env['VERCEL'] === '1' ? 'https:' : url.protocol}//${host ?? ''}`;

  switch (d.tipo) {
    case 'passa':
      // `decidir` only passes with a configuration and a trusted host.
      return { cfg: cfg!, origem };
    case 'para_o_login':
      return { resposta: redirecionar(307, origem, '/entrar') };
    case 'nao_autorizado':
      return { resposta: json(401, { erro: 'sem sessão: entre pela página /entrar' }) };
    case 'origem_proibida':
      return { resposta: texto(403, 'origem recusada') };
    case 'host_desconhecido':
      return {
        resposta: texto(421, 'host desconhecido: acrescente-o a RADAR_HOSTS se ele for desta tela'),
      };
    case 'sem_configuracao':
      return {
        resposta: texto(
          503,
          'tela fechada: falta RADAR_SENHA ou RADAR_SEGREDO_DE_SESSAO, ou a senha tem menos de 24 caracteres',
        ),
      };
  }
}

/** For Proxy: `null` lets the request through; any other answer ends it. */
export function portaoDaRequisicao(req: Request, env: Env, agoraMs: number): Response | null {
  const a = avaliar(req, env, agoraMs);
  return 'resposta' in a ? a.resposta : null;
}

/** Runs `handler` only when the gate lets the request through. */
export async function atender<C>(
  req: Request,
  ctx: C,
  env: Env,
  agoraMs: number,
  handler: (req: Request, s: Sessao<C>) => Promise<Response>,
): Promise<Response> {
  const a = avaliar(req, env, agoraMs);
  if ('resposta' in a) return a.resposta;
  return handler(req, { ctx, cfg: a.cfg, agoraMs, origem: a.origem });
}

/**
 * Wraps a route handler with the same decision Proxy takes. Every `route.ts`
 * under `src/app/api` exports only wrapped verbs; `src/app/api/rotas.test.ts`
 * walks the files on disk and fails on one that is not.
 */
export function comSessao<C>(
  handler: (req: Request, s: Sessao<C>) => Promise<Response>,
): (req: Request, ctx: C) => Promise<Response> {
  return (req, ctx) => atender(req, ctx, process.env, Date.now(), handler);
}

const PAGINA_SENHA_ERRADA = `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><meta name="robots" content="noindex">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>Radar</title></head>
<body><p>Senha errada.</p><p><a href="/entrar">Tentar de novo</a></p></body></html>`;

function ehHttps(origem: string): boolean {
  return origem.startsWith('https:');
}

/** The login form's target. A plain form post, so it works without JavaScript. */
export async function entrar(req: Request, s: Sessao<unknown>): Promise<Response> {
  let tentativa = '';
  try {
    const campo = (await req.formData()).get('senha');
    if (typeof campo === 'string') tentativa = campo;
  } catch {
    // Not a form: same answer as a wrong password.
  }

  if (!senhaConfere(tentativa, s.cfg.senha)) {
    return new Response(PAGINA_SENHA_ERRADA, {
      status: 401,
      headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': SEM_CACHE },
    });
  }
  const cookie = cookieDaSessao(emitirSessao(s.cfg, s.agoraMs), ehHttps(s.origem));
  return redirecionar(303, s.origem, '/', cookie);
}

export async function sair(_req: Request, s: Sessao<unknown>): Promise<Response> {
  return redirecionar(303, s.origem, '/entrar', cookieQueApaga(ehHttps(s.origem)));
}
