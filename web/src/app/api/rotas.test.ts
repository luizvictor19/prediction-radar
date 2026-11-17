import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { emitirSessao, lerConfiguracao, NOME_DO_COOKIE } from '../../lib/sessao';

/**
 * Every route handler on disk, called the way an outsider would call it.
 *
 * The files are found by walking `src/app/api`, not listed by hand: a route
 * added later without `comSessao` fails here without anyone remembering to
 * write a test for it. The only declared exception is the login route, which
 * has to answer without a session.
 *
 * The database is never configured in this file. A handler that answers 401
 * did not reach it; one that reached it would answer 503 from `banco.ts`.
 */

const AQUI = dirname(fileURLToPath(import.meta.url));
const VERBOS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'] as const;
/** Login and logout: the only routes that answer without a session. */
const PUBLICAS = new Set(['entrar', 'sair']);
const ORIGEM = 'https://radar.test';

const EVENTO = '0b0e6a3e-3f1f-4a54-9a51-7d1c2e6f8a10';
const SHA = 'a'.repeat(64);

process.env['RADAR_SENHA'] = 'uma-senha-de-teste-com-32-caracteres';
process.env['RADAR_SEGREDO_DE_SESSAO'] = 'um-segredo-de-sessao-de-teste';
process.env['RADAR_HOSTS'] = 'radar.test';
delete process.env['VERCEL'];
delete process.env['SUPABASE_URL'];
delete process.env['SUPABASE_SERVICE_KEY'];

type Handler = (req: Request, ctx: unknown) => Promise<Response>;
type Rota = { nome: string; verbos: Map<string, Handler> };

/** `mercados/[id]/achados`, from the file's path. */
function nomeDa(arquivo: string): string {
  return relative(AQUI, dirname(arquivo)).split(sep).join('/');
}

async function rotasNoDisco(): Promise<Rota[]> {
  const arquivos = readdirSync(AQUI, { recursive: true, encoding: 'utf8' })
    .filter((f) => f.endsWith(`${sep}route.ts`) || f === 'route.ts')
    .map((f) => join(AQUI, f))
    .sort();
  const rotas: Rota[] = [];
  for (const arquivo of arquivos) {
    const modulo = (await import(pathToFileURL(arquivo).href)) as Record<string, unknown>;
    const verbos = new Map<string, Handler>();
    for (const v of VERBOS) {
      if (typeof modulo[v] === 'function') verbos.set(v, modulo[v] as Handler);
    }
    rotas.push({ nome: nomeDa(arquivo), verbos });
  }
  return rotas;
}

function contexto(): { params: Promise<Record<string, string>> } {
  return { params: Promise.resolve({ id: EVENTO, sha: SHA }) };
}

function pedido(caminho: string, metodo: string, cookie?: string, corpo?: string): Request {
  const headers = new Headers({ origin: ORIGEM, 'content-type': 'application/json' });
  if (cookie !== undefined) headers.set('cookie', `${NOME_DO_COOKIE}=${cookie}`);
  return new Request(ORIGEM + caminho, {
    method: metodo,
    headers,
    body: metodo === 'GET' || metodo === 'HEAD' ? undefined : (corpo ?? '{}'),
  });
}

function sessaoValida(): string {
  const cfg = lerConfiguracao(process.env);
  assert.ok(cfg, 'a configuração de teste devia abrir a tela');
  return emitirSessao(cfg, Date.now());
}

test('a busca acha os arquivos de rota (busca vazia não é ausência)', async () => {
  const nomes = (await rotasNoDisco()).map((r) => r.nome);
  for (const esperada of [
    'entrar',
    'sair',
    'radar',
    'contagens',
    'corpus',
    'contradicoes',
    'mercados/[id]/achados',
    'mercados/[id]/leituras',
    'mercados/[id]/texto',
    'textos/[sha]',
    'previsoes',
    'legs',
  ]) {
    assert.ok(nomes.includes(esperada), `a rota ${esperada} não foi achada em ${AQUI}`);
  }
});

test('toda rota, em todo verbo exportado, responde 401 sem cookie', async () => {
  const abertas: string[] = [];
  let chamadas = 0;
  for (const rota of await rotasNoDisco()) {
    if (PUBLICAS.has(rota.nome)) continue;
    assert.ok(rota.verbos.size > 0, `a rota ${rota.nome} não exporta verbo nenhum`);
    for (const [verbo, handler] of rota.verbos) {
      chamadas++;
      const r = await handler(pedido(`/api/${rota.nome}`, verbo), contexto());
      if (r.status !== 401) abertas.push(`${verbo} /api/${rota.nome} → ${r.status}`);
    }
  }
  assert.ok(chamadas >= 10, `só ${chamadas} handlers chamados; a busca perdeu rotas`);
  assert.deepEqual(abertas, [], 'rota respondendo sem sessão');
});

test('a rota de logout é a outra exceção: sem sessão ela só apaga o cookie', async () => {
  const sair = (await rotasNoDisco()).find((r) => r.nome === 'sair');
  assert.ok(sair, 'rota de logout não achada');
  assert.deepEqual([...sair.verbos.keys()], ['POST'], 'logout só aceita POST');
  const r = await sair.verbos.get('POST')!(pedido('/api/sair', 'POST'), contexto());
  assert.equal(r.status, 303);
  assert.equal(r.headers.get('location'), `${ORIGEM}/entrar`);
  assert.match(r.headers.get('set-cookie') ?? '', /Max-Age=0/);
});

test('a rota de login é a exceção, e mesmo ela não abre com senha errada', async () => {
  const rotas = await rotasNoDisco();
  const entrar = rotas.find((r) => r.nome === 'entrar');
  assert.ok(entrar, 'rota de login não achada');
  assert.deepEqual([...entrar.verbos.keys()], ['POST'], 'login só aceita POST');
  const req = new Request(`${ORIGEM}/api/entrar`, {
    method: 'POST',
    headers: { origin: ORIGEM, 'content-type': 'application/x-www-form-urlencoded' },
    body: 'senha=errada',
  });
  const r = await entrar.verbos.get('POST')!(req, contexto());
  assert.equal(r.status, 401);
  assert.equal(r.headers.get('set-cookie'), null);
});

test('com sessão, entrada malformada leva 400 antes de chegar ao banco', async () => {
  const rotas = new Map((await rotasNoDisco()).map((r) => [r.nome, r]));
  const cookie = sessaoValida();
  const chamar = (nome: string, verbo: string, caminho: string, params: object, corpo?: string) =>
    rotas.get(nome)!.verbos.get(verbo)!(pedido(caminho, verbo, cookie, corpo), {
      params: Promise.resolve(params),
    }).then((r) => r.status);

  const md5 = 'b'.repeat(32);
  const respostas = {
    'achados, id malformado': await chamar(
      'mercados/[id]/achados',
      'GET',
      '/api/mercados/x/achados',
      { id: 'x' },
    ),
    'leituras, sem sha': await chamar(
      'mercados/[id]/leituras',
      'GET',
      `/api/mercados/${EVENTO}/leituras`,
      { id: EVENTO },
    ),
    'texto, id malformado': await chamar('mercados/[id]/texto', 'GET', '/api/mercados/1/texto', {
      id: '1',
    }),
    'textos, sha malformado': await chamar('textos/[sha]', 'GET', '/api/textos/abc', {
      sha: 'abc',
    }),
    'contradições, 201 ids': await chamar(
      'contradicoes',
      'GET',
      `/api/contradicoes?ids=${Array<string>(201).fill(md5).join(',')}`,
      {},
    ),
    'previsão, corpo não JSON': await chamar('previsoes', 'POST', '/api/previsoes', {}, 'x'),
    'previsão, prob fora': await chamar(
      'previsoes',
      'POST',
      '/api/previsoes',
      {},
      JSON.stringify({ eventId: EVENTO, prob: 2 }),
    ),
    'leg, stake zero': await chamar(
      'legs',
      'POST',
      '/api/legs',
      {},
      JSON.stringify({
        betId: EVENTO,
        eventId: EVENTO,
        outcome: 'Yes',
        entryPrice: 0.5,
        stakeUsd: 0,
      }),
    ),
  };
  const fora = Object.entries(respostas).filter(([, s]) => s !== 400);
  assert.deepEqual(fora, [], 'entrada malformada não deu 400');
});

test('com sessão e sem banco configurado, a rota responde 503 e não 500', async () => {
  const radar = (await rotasNoDisco()).find((r) => r.nome === 'radar')!;
  const r = await radar.verbos.get('GET')!(pedido('/api/radar', 'GET', sessaoValida()), contexto());
  assert.equal(r.status, 503, 'o banco sem configuração devia fechar a rota com 503');
  assert.equal(r.headers.get('cache-control'), 'private, no-store');
});
