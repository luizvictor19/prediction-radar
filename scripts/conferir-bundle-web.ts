import { conferirCanarios } from './lib/canario-no-bundle';

/**
 * `npm run conferir:bundle`: fails when a server secret is in what `web/` sends
 * to a browser: the client bundle and the prerendered pages. Run after `npm run build:web` with canary values in
 * `SUPABASE_SERVICE_KEY` (and optionally `RADAR_SENHA`,
 * `RADAR_SEGREDO_DE_SESSAO`), as CI does.
 */
const argumentos = process.argv.slice(2);
const raizes = argumentos.length > 0 ? argumentos : ['web/.next/static', 'web/.next/server/app'];
const { ok, mensagem } = conferirCanarios(raizes, process.env);
console.log(mensagem);
process.exit(ok ? 0 : 1);
