import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { emitirSessao, lerConfiguracao, NOME_DO_COOKIE } from '../../lib/sessao';

/**
 * Route handlers against a fake PostgREST on 127.0.0.1: the real supabase-js
 * client, the real route, only the database replaced. It lives in its own file
 * because it configures the database, which `rotas.test.ts` must not have.
 */

const EVENTO_COM_TEXTO = '0b0e6a3e-3f1f-4a54-9a51-7d1c2e6f8a10';
const EVENTO_SEM_TEXTO = '1c1e6a3e-3f1f-4a54-9a51-7d1c2e6f8a11';
const EVENTO_QUE_NAO_EXISTE = '2d2e6a3e-3f1f-4a54-9a51-7d1c2e6f8a12';
const ORIGEM = 'https://radar.test';

/** `events` as the fake database holds it. */
const EVENTOS: Record<string, { description: string | null }> = {
  [EVENTO_COM_TEXTO]: { description: 'o regulamento' },
  [EVENTO_SEM_TEXTO]: { description: null },
};

function servidorFalso(): Promise<Server> {
  const servidor = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const id = url.searchParams.get('id')?.replace(/^eq\./, '') ?? '';
    const linhas = url.pathname === '/rest/v1/events' && EVENTOS[id] ? [EVENTOS[id]] : [];
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(linhas));
  });
  return new Promise((ok) => servidor.listen(0, '127.0.0.1', () => ok(servidor)));
}

test('texto da regra: 200 com texto, 200 com null, 404 para mercado que não existe', async () => {
  const servidor = await servidorFalso();
  try {
    const { port } = servidor.address() as AddressInfo;
    process.env['SUPABASE_URL'] = `http://127.0.0.1:${port}`;
    process.env['SUPABASE_SERVICE_KEY'] = 'canario-chave-do-teste';
    process.env['RADAR_SENHA'] = 'uma-senha-de-teste-com-32-caracteres';
    process.env['RADAR_SEGREDO_DE_SESSAO'] = 'um-segredo-de-sessao-de-teste';
    process.env['RADAR_HOSTS'] = 'radar.test';
    delete process.env['VERCEL'];

    const cfg = lerConfiguracao(process.env);
    assert.ok(cfg);
    const cookie = `${NOME_DO_COOKIE}=${emitirSessao(cfg, Date.now())}`;
    const { GET } = await import('./mercados/[id]/texto/route');

    const respostas: [number, unknown][] = [];
    for (const id of [EVENTO_COM_TEXTO, EVENTO_SEM_TEXTO, EVENTO_QUE_NAO_EXISTE]) {
      const r = await GET(
        new Request(`${ORIGEM}/api/mercados/${id}/texto`, { headers: { cookie } }),
        { params: Promise.resolve({ id }) },
      );
      respostas.push([r.status, await r.json()]);
    }
    assert.deepEqual(respostas, [
      [200, { texto: 'o regulamento' }],
      [200, { texto: null }],
      [404, { erro: 'mercado não encontrado' }],
    ]);
  } finally {
    servidor.close();
  }
});
