import { NextResponse, type NextRequest } from 'next/server';

import { portaoDaRequisicao } from './lib/portao';

/**
 * The gate's first check, before any page or route renders (ADR 0013). The
 * decision lives in `lib/portao.ts`; this file only adapts it to Next. Every
 * route handler checks again through `comSessao`, because a matcher change
 * would silently drop Proxy coverage.
 *
 * Proxy runs on the Node.js runtime by default in Next 16, so `node:crypto`
 * is available to `lib/sessao.ts`.
 */
export default function proxy(req: NextRequest) {
  return portaoDaRequisicao(req, process.env, Date.now()) ?? NextResponse.next();
}

export const config = {
  // Everything except Next's own static assets.
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
