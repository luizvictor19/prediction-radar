import { conferirCanarios } from './lib/canario-no-bundle';

/**
 * `npm run conferir:bundle`: fails when a server secret is in the browser
 * bundle of `web/`. Run after `npm run build:web` with canary values in
 * `SUPABASE_SERVICE_KEY` (and optionally `RADAR_SENHA`,
 * `RADAR_SEGREDO_DE_SESSAO`), as CI does.
 */
const raiz = process.argv[2] ?? 'web/.next/static';
const { ok, mensagem } = conferirCanarios(raiz, process.env);
console.log(mensagem);
process.exit(ok ? 0 : 1);
