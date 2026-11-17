import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CAMINHOS_PUBLICOS, entrar, portaoDaRequisicao, sair } from './portao';
import { DURACAO_MS, NOME_DO_COOKIE } from './sessao';

/**
 * The gate, end to end, without Next: the decision for each request, the login
 * and the logout, all on the standard `Request` and `Response`.
 *
 * The first test walks the whole life of a session and compares the LIST of
 * answers, not the last one (`CLAUDE.md`, "Teste que afirma só o estado
 * final"). Expiry and a changed password both end in the same 401, so a test
 * that only looked at the end could not tell which rule produced it.
 */

const ORIGEM = 'https://radar.test';
const SENHA = 'uma-senha-de-teste-com-32-caracteres';
const ENV = { RADAR_SENHA: SENHA, RADAR_SEGREDO_DE_SESSAO: 'um-segredo-de-sessao-de-teste' };
const AGORA = Date.UTC(2026, 10, 16, 12, 0, 0);

function pedido(
  caminho: string,
  opcoes: { metodo?: string; cookie?: string; origem?: string; corpo?: string } = {},
): Request {
  const headers = new Headers();
  if (opcoes.cookie !== undefined) headers.set('cookie', `${NOME_DO_COOKIE}=${opcoes.cookie}`);
  if (opcoes.origem !== undefined) headers.set('origin', opcoes.origem);
  if (opcoes.corpo !== undefined) headers.set('content-type', 'application/x-www-form-urlencoded');
  return new Request(ORIGEM + caminho, {
    method: opcoes.metodo ?? 'GET',
    headers,
    body: opcoes.corpo,
  });
}

function login(senha: string): Request {
  return pedido('/api/entrar', {
    metodo: 'POST',
    origem: ORIGEM,
    corpo: new URLSearchParams({ senha }).toString(),
  });
}

/** One line per answer: status, where it sends the browser, whether it sets a cookie. */
function resumo(r: Response | null): string {
  if (r === null) return 'passa';
  const partes = [String(r.status)];
  const destino = r.headers.get('location');
  if (destino !== null) partes.push(new URL(destino, ORIGEM).pathname);
  if (r.headers.get('set-cookie') !== null) partes.push('com cookie');
  return partes.join(' ');
}

function valorDoCookie(r: Response): string {
  const cabecalho = r.headers.get('set-cookie') ?? '';
  const m = new RegExp(`^${NOME_DO_COOKIE}=([^;]*)`).exec(cabecalho);
  assert.ok(m, `o login não devolveu o cookie ${NOME_DO_COOKIE}: ${cabecalho}`);
  return m[1]!;
}

test('a vida de uma sessão, passo a passo', async () => {
  const passos: string[] = [];

  passos.push(resumo(portaoDaRequisicao(pedido('/'), ENV, AGORA)));
  passos.push(resumo(portaoDaRequisicao(pedido('/api/radar'), ENV, AGORA)));

  const errada = await entrar(login(SENHA + 'x'), ENV, AGORA);
  passos.push(resumo(errada));

  const certa = await entrar(login(SENHA), ENV, AGORA);
  passos.push(resumo(certa));
  const cookie = valorDoCookie(certa);

  passos.push(resumo(portaoDaRequisicao(pedido('/api/radar', { cookie }), ENV, AGORA)));
  passos.push(resumo(portaoDaRequisicao(pedido('/', { cookie }), ENV, AGORA)));

  // The clock moved past expiry; the password did not change.
  passos.push(
    resumo(portaoDaRequisicao(pedido('/api/radar', { cookie }), ENV, AGORA + DURACAO_MS)),
  );

  // The password changed; the clock is still inside the 30 days.
  const envNovo = { ...ENV, RADAR_SENHA: SENHA + '-trocada' };
  passos.push(resumo(portaoDaRequisicao(pedido('/api/radar', { cookie }), envNovo, AGORA + 1)));
  passos.push(resumo(portaoDaRequisicao(pedido('/', { cookie }), envNovo, AGORA + 1)));

  assert.deepEqual(
    passos,
    [
      '307 /entrar', // página sem cookie
      '401', // API sem cookie
      '401', // senha errada, e sem cookie
      '303 / com cookie', // senha certa
      'passa', // cookie aceito na API
      'passa', // cookie aceito na página
      '401', // relógio adiantado além da expiração
      '401', // senha trocada
      '307 /entrar', // senha trocada, na página
    ],
    'a sequência de respostas do portão mudou',
  );
});

test('o cookie do login é HttpOnly, SameSite=Lax e Secure em https', async () => {
  const r = await entrar(login(SENHA), ENV, AGORA);
  const atributos = (r.headers.get('set-cookie') ?? '').split('; ');
  for (const a of ['HttpOnly', 'SameSite=Lax', 'Secure']) {
    assert.ok(atributos.includes(a), `falta ${a} no cookie do login`);
  }
});

test('senha errada não devolve cookie nenhum', async () => {
  for (const senha of ['', 'curta', SENHA + 'x', SENHA.slice(0, -1)]) {
    const r = await entrar(login(senha), ENV, AGORA);
    assert.equal(r.status, 401, `senha ${JSON.stringify(senha)} não deu 401`);
    assert.equal(r.headers.get('set-cookie'), null, `senha errada devolveu cookie`);
  }
});

test('sem configuração, ou com senha curta, a tela inteira responde 503', async () => {
  const caminhos = ['/', '/entrar', '/api/entrar', '/api/radar', '/api/previsoes'];
  const envs = {
    'sem nada': {},
    'sem segredo': { RADAR_SENHA: SENHA },
    'senha de 23': { ...ENV, RADAR_SENHA: 'x'.repeat(23) },
  };
  for (const [nome, env] of Object.entries(envs)) {
    const respostas = caminhos.map(
      (c) => portaoDaRequisicao(pedido(c, { cookie: 'qualquer' }), env, AGORA)?.status,
    );
    assert.deepEqual(respostas, [503, 503, 503, 503, 503], `configuração "${nome}" abriu a tela`);
  }
  const r = await entrar(login(SENHA), {}, AGORA);
  assert.equal(r.status, 503, 'o login sem configuração não respondeu 503');
});

test('POST com Origin de outro host leva 403, com ou sem sessão', async () => {
  const certa = await entrar(login(SENHA), ENV, AGORA);
  const cookie = valorDoCookie(certa);
  const respostas = [
    portaoDaRequisicao(
      pedido('/api/entrar', { metodo: 'POST', origem: 'https://outro.test' }),
      ENV,
      AGORA,
    ),
    portaoDaRequisicao(
      pedido('/api/previsoes', { metodo: 'POST', origem: 'https://outro.test', cookie }),
      ENV,
      AGORA,
    ),
    portaoDaRequisicao(
      pedido('/api/previsoes', { metodo: 'POST', origem: ORIGEM, cookie }),
      ENV,
      AGORA,
    ),
  ].map(resumo);
  assert.deepEqual(respostas, ['403', '403', 'passa'], 'a conferência de Origin mudou');
});

test('só a página e a rota de login são públicas', () => {
  assert.deepEqual([...CAMINHOS_PUBLICOS].sort(), ['/api/entrar', '/entrar']);
  assert.deepEqual(
    ['/entrar', '/api/entrar', '/entrar/x', '/api/entrar/x', '/api/radar'].map((c) =>
      resumo(portaoDaRequisicao(pedido(c), ENV, AGORA)),
    ),
    ['passa', 'passa', '307 /entrar', '401', '401'],
    'um caminho público a mais, ou casado por prefixo, abre a tela',
  );
});

test('respostas do portão não vão para cache compartilhado', () => {
  const r = portaoDaRequisicao(pedido('/api/radar'), ENV, AGORA);
  assert.equal(r?.headers.get('cache-control'), 'private, no-store');
});

test('sair apaga o cookie e manda para o login', () => {
  const r = sair(pedido('/api/sair', { metodo: 'POST', origem: ORIGEM }));
  assert.equal(resumo(r), '303 /entrar com cookie');
  assert.match(r.headers.get('set-cookie') ?? '', /Max-Age=0/, 'o cookie não foi apagado');
});

test('todo redirecionamento leva URL absoluta, porque o Proxy do Next recusa a relativa', async () => {
  const destinos = [
    portaoDaRequisicao(pedido('/'), ENV, AGORA),
    await entrar(login(SENHA), ENV, AGORA),
    sair(pedido('/api/sair', { metodo: 'POST', origem: ORIGEM })),
  ].map((r) => r?.headers.get('location'));
  assert.deepEqual(destinos, [`${ORIGEM}/entrar`, `${ORIGEM}/`, `${ORIGEM}/entrar`]);
});

test('o redirecionamento usa o host do cabeçalho Host, não o de req.url', async () => {
  // Inside a route handler, `next dev -H 127.0.0.1` reports `localhost` in
  // `req.url`; the browser is on 127.0.0.1 and holds the cookie there.
  const req = new Request('http://localhost:5173/api/entrar', {
    method: 'POST',
    headers: {
      host: '127.0.0.1:5173',
      origin: 'http://127.0.0.1:5173',
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ senha: SENHA }).toString(),
  });
  const r = await entrar(req, ENV, AGORA);
  assert.equal(r.headers.get('location'), 'http://127.0.0.1:5173/');
});
