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

/** Matched exactly, never by prefix. */
export const CAMINHOS_PUBLICOS: ReadonlySet<string> = new Set(['/entrar', '/api/entrar']);

export type Decisao =
  | { tipo: 'passa' }
  | { tipo: 'para_o_login' }
  | { tipo: 'nao_autorizado' }
  | { tipo: 'origem_proibida' }
  | { tipo: 'sem_configuracao' };

export type Pedido = {
  metodo: string;
  caminho: string;
  cookie: string | undefined;
  /** The `Origin` header's host, when the browser sent one. */
  hostDaOrigem: string | null;
  host: string;
};

export function decidir(p: Pedido, cfg: Configuracao | null, agoraMs: number): Decisao {
  // Fail closed: no configuration opens nothing, the login page included.
  if (cfg === null) return { tipo: 'sem_configuracao' };

  // A browser always sends Origin on a cross-site POST. A missing one is not a
  // browser being tricked, so it is left to the session check below.
  const escreve = p.metodo !== 'GET' && p.metodo !== 'HEAD';
  if (escreve && p.hostDaOrigem !== null && p.hostDaOrigem !== p.host) {
    return { tipo: 'origem_proibida' };
  }

  if (CAMINHOS_PUBLICOS.has(p.caminho)) return { tipo: 'passa' };
  if (verificarSessao(p.cookie, cfg, agoraMs)) return { tipo: 'passa' };
  return p.caminho.startsWith('/api/') ? { tipo: 'nao_autorizado' } : { tipo: 'para_o_login' };
}

function hostDe(origem: string | null): string | null {
  if (origem === null) return null;
  try {
    return new URL(origem).host;
  } catch {
    // An unparsable Origin cannot match this host.
    return 'origem-ilegivel';
  }
}

function pedidoDe(req: Request): Pedido {
  const url = new URL(req.url);
  return {
    metodo: req.method.toUpperCase(),
    caminho: url.pathname,
    cookie: lerCookie(req.headers.get('cookie')),
    hostDaOrigem: hostDe(req.headers.get('origin')),
    host: req.headers.get('host') ?? url.host,
  };
}

function seguro(req: Request): boolean {
  return new URL(req.url).protocol === 'https:' || req.headers.get('x-forwarded-proto') === 'https';
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

/**
 * Absolute `Location`, resolved against the request: Next's Proxy answers 500
 * ("Invalid URL") to a relative one, measured under `next dev` on 2026-11-17.
 *
 * The host comes from the `Host` header, not from `req.url`: inside a route
 * handler `next dev -H 127.0.0.1` reports `localhost` in `req.url`, and a
 * login redirected there would land on a host without the cookie.
 */
function redirecionar(status: 303 | 307, req: Request, caminho: string, cookie?: string): Response {
  const url = new URL(req.url);
  const host = req.headers.get('host');
  const base = host === null ? url : new URL(`${url.protocol}//${host}`);
  const destino = new URL(caminho, base).toString();
  const headers = new Headers({ location: destino, 'cache-control': SEM_CACHE });
  if (cookie !== undefined) headers.set('set-cookie', cookie);
  return new Response(null, { status, headers });
}

/** `null` lets the request through; any other answer ends it. */
export function portaoDaRequisicao(req: Request, env: Env, agoraMs: number): Response | null {
  const d = decidir(pedidoDe(req), lerConfiguracao(env), agoraMs);
  switch (d.tipo) {
    case 'passa':
      return null;
    case 'para_o_login':
      return redirecionar(307, req, '/entrar');
    case 'nao_autorizado':
      return json(401, { erro: 'sem sessão: entre pela página /entrar' });
    case 'origem_proibida':
      return texto(403, 'origem recusada');
    case 'sem_configuracao':
      return texto(
        503,
        'tela fechada: falta RADAR_SENHA ou RADAR_SEGREDO_DE_SESSAO, ou a senha tem menos de 24 caracteres',
      );
  }
}

/**
 * Wraps a route handler with the same decision Proxy takes. Every `route.ts`
 * under `src/app/api` exports only wrapped verbs; `src/app/api/rotas.test.ts`
 * walks the files on disk and fails on one that is not.
 */
export function comSessao<C>(
  handler: (req: Request, ctx: C) => Promise<Response>,
): (req: Request, ctx: C) => Promise<Response> {
  return async (req, ctx) => portaoDaRequisicao(req, process.env, Date.now()) ?? handler(req, ctx);
}

const PAGINA_SENHA_ERRADA = `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><meta name="robots" content="noindex">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>Radar</title></head>
<body><p>Senha errada.</p><p><a href="/entrar">Tentar de novo</a></p></body></html>`;

/** The login form's target. A plain form post, so it works without JavaScript. */
export async function entrar(req: Request, env: Env, agoraMs: number): Promise<Response> {
  const barrado = portaoDaRequisicao(req, env, agoraMs);
  if (barrado !== null) return barrado;
  const cfg = lerConfiguracao(env);
  if (cfg === null) return texto(503, 'tela fechada');

  let tentativa = '';
  try {
    const campo = (await req.formData()).get('senha');
    if (typeof campo === 'string') tentativa = campo;
  } catch {
    // Not a form: same answer as a wrong password.
  }

  if (!senhaConfere(tentativa, cfg.senha)) {
    return new Response(PAGINA_SENHA_ERRADA, {
      status: 401,
      headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': SEM_CACHE },
    });
  }
  return redirecionar(303, req, '/', cookieDaSessao(emitirSessao(cfg, agoraMs), seguro(req)));
}

export function sair(req: Request): Response {
  return redirecionar(303, req, '/entrar', cookieQueApaga(seguro(req)));
}
