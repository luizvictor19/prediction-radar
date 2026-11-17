import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DURACAO_MS,
  NOME_DO_COOKIE,
  SENHA_MINIMA,
  cookieDaSessao,
  emitirSessao,
  lerConfiguracao,
  lerCookie,
  senhaConfere,
  verificarSessao,
  type Configuracao,
} from './sessao';

/**
 * The gate's primitives: the configuration, the password compare and the signed
 * cookie. The walk through the whole gate, asserted as a sequence, is in
 * `portao.test.ts`; this file holds the single cases each primitive must refuse.
 */

const SENHA = 'uma-senha-de-teste-com-32-caracteres';
const SEGREDO = 'um-segredo-de-sessao-de-teste';
const CFG: Configuracao = { senha: SENHA, segredo: SEGREDO };
const AGORA = Date.UTC(2026, 10, 16, 12, 0, 0);

test('configuração: sem senha, sem segredo ou senha curta fecham a tela', () => {
  const casos = [
    lerConfiguracao({}),
    lerConfiguracao({ RADAR_SENHA: SENHA }),
    lerConfiguracao({ RADAR_SEGREDO_DE_SESSAO: SEGREDO }),
    lerConfiguracao({ RADAR_SENHA: '', RADAR_SEGREDO_DE_SESSAO: SEGREDO }),
    lerConfiguracao({
      RADAR_SENHA: 'x'.repeat(SENHA_MINIMA - 1),
      RADAR_SEGREDO_DE_SESSAO: SEGREDO,
    }),
    lerConfiguracao({ RADAR_SENHA: 'x'.repeat(SENHA_MINIMA), RADAR_SEGREDO_DE_SESSAO: SEGREDO }),
  ];
  assert.deepEqual(
    casos.map((c) => c !== null),
    [false, false, false, false, false, true],
    'só a última configuração (senha de 24, segredo presente) abre a tela',
  );
});

test('a senha mínima é 24 caracteres', () => {
  assert.equal(SENHA_MINIMA, 24, 'o mínimo da senha é parte da decisão aprovada na issue 85');
});

test('senha: certa confere, errada não, e tamanhos diferentes não lançam', () => {
  assert.equal(senhaConfere(SENHA, SENHA), true, 'a senha certa devia conferir');
  assert.equal(senhaConfere(SENHA + 'x', SENHA), false, 'senha com um caractere a mais passou');
  // timingSafeEqual throws on unequal lengths; both sides are hashed first.
  assert.doesNotThrow(() => senhaConfere('', SENHA), 'senha vazia não pode lançar');
  assert.doesNotThrow(() => senhaConfere('a', SENHA), 'senha curta não pode lançar');
  assert.equal(senhaConfere('a', SENHA), false, 'senha curta passou');
});

test('sessão emitida agora vale até expirar, e não depois', () => {
  const valor = emitirSessao(CFG, AGORA);
  assert.deepEqual(
    [
      verificarSessao(valor, CFG, AGORA),
      verificarSessao(valor, CFG, AGORA + DURACAO_MS - 1),
      verificarSessao(valor, CFG, AGORA + DURACAO_MS),
    ],
    [true, true, false],
    'a sessão vale do instante da emissão até 30 dias depois, exclusive',
  );
});

test('a sessão dura 30 dias', () => {
  assert.equal(DURACAO_MS, 30 * 24 * 60 * 60 * 1000, 'a duração aprovada é de 30 dias');
});

test('sessão adulterada é recusada', () => {
  const valor = emitirSessao(CFG, AGORA);
  const [versao, expira, assinatura] = valor.split('.') as [string, string, string];
  const trocaUltimo = (s: string) => s.slice(0, -1) + (s.endsWith('A') ? 'B' : 'A');

  const adulteradas = {
    'expiração esticada': `${versao}.${Number(expira) + DURACAO_MS}.${assinatura}`,
    'assinatura trocada': `${versao}.${expira}.${trocaUltimo(assinatura)}`,
    'assinatura vazia': `${versao}.${expira}.`,
    'versão trocada': `v0.${expira}.${assinatura}`,
    'partes a mais': `${valor}.x`,
    'expiração não numérica': `${versao}.abc.${assinatura}`,
    vazia: '',
  };
  const aceitas = Object.entries(adulteradas)
    .filter(([, v]) => verificarSessao(v, CFG, AGORA))
    .map(([nome]) => nome);
  assert.deepEqual(aceitas, [], 'nenhuma sessão adulterada pode passar');
  assert.equal(verificarSessao(undefined, CFG, AGORA), false, 'sem cookie não pode passar');
});

test('trocar a senha ou o segredo encerra toda sessão', () => {
  const valor = emitirSessao(CFG, AGORA);
  assert.deepEqual(
    [
      verificarSessao(valor, CFG, AGORA),
      verificarSessao(valor, { ...CFG, senha: SENHA + '-nova' }, AGORA),
      verificarSessao(valor, { ...CFG, segredo: SEGREDO + '-novo' }, AGORA),
    ],
    [true, false, false],
    'a sessão assinada sob a senha ou o segredo anterior devia cair',
  );
});

test('cookie: HttpOnly, SameSite=Lax, 30 dias, e Secure só em https', () => {
  const https = cookieDaSessao('valor', true);
  const http = cookieDaSessao('valor', false);
  assert.match(https, new RegExp(`^${NOME_DO_COOKIE}=valor;`), 'o nome do cookie mudou');
  for (const atributo of ['HttpOnly', 'SameSite=Lax', 'Path=/', 'Max-Age=2592000', 'Secure']) {
    assert.ok(https.split('; ').includes(atributo), `falta ${atributo} no cookie em https`);
  }
  assert.ok(!http.split('; ').includes('Secure'), 'Secure em http impede o login local');
});

test('lerCookie acha o cookie da sessão entre outros', () => {
  assert.deepEqual(
    [
      lerCookie(null),
      lerCookie(''),
      lerCookie(`outro=1; ${NOME_DO_COOKIE}=abc.def; mais=2`),
      lerCookie(`${NOME_DO_COOKIE}x=abc`),
    ],
    [undefined, undefined, 'abc.def', undefined],
    'leitura do cabeçalho Cookie',
  );
});
