import { comSessao, entrar } from '../../../lib/portao';

// The one public route: `comSessao` lets `/api/entrar` through without a
// session, and still answers 503 without configuration and 403 to a foreign
// Origin.
export const POST = comSessao((req: Request) => entrar(req, process.env, Date.now()));
