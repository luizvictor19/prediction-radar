import { test } from 'node:test';
import assert from 'node:assert/strict';

// Sem rede e sem banco: as cinco restrições da Parte B são funções puras sobre
// desfechos já lidos.
import { conferirRelacao, lerDesfecho, type Desfecho } from './desfecho.js';
import type { Relacao, TipoRelacao } from './taxonomia.js';

function rel(tipo: TipoRelacao, mercados: string[]): Relacao {
  return { tipo, mercados, confianca: 0.9, justificativa: 'x', ressalvaDeResolucao: null };
}

function desfechos(pares: Record<string, Desfecho>): Map<string, Desfecho> {
  return new Map(Object.entries(pares));
}

function veredito(tipo: TipoRelacao, mercados: string[], estado: Record<string, Desfecho>): string {
  return conferirRelacao(rel(tipo, mercados), desfechos(estado)).veredito;
}

// ---------------------------------------------------------------------------
// A leitura do desfecho
// ---------------------------------------------------------------------------

test('SIM é o primeiro desfecho listado vencendo', () => {
  assert.equal(lerDesfecho(['Over', 'Under'], ['1', '0']), 'sim');
  assert.equal(lerDesfecho(['Over', 'Under'], ['0', '1']), 'nao');
  assert.equal(lerDesfecho(['Yes', 'No'], ['1', '0']), 'sim');
});

test('mercado antigo com ["0","0"] não tem desfecho legível', () => {
  // Nem sim nem não. Inventar leitura aqui fabricaria gabarito, e gabarito
  // fabricado aparece como precisão em vez de aparecer como lacuna.
  assert.equal(lerDesfecho(['Yes', 'No'], ['0', '0']), null);
  assert.equal(lerDesfecho(['Yes', 'No'], ['0.5', '0.5']), null);
});

test('mercado que não é binário não tem proposição', () => {
  assert.equal(lerDesfecho(['A', 'B', 'C'], ['1', '0', '0']), null);
  assert.equal(lerDesfecho(['Yes'], ['1']), null);
});

// ---------------------------------------------------------------------------
// implica — A=SIM ⇒ B=SIM
// ---------------------------------------------------------------------------

test('implica: A=SIM e B=NÃO refuta', () => {
  assert.equal(veredito('implica', ['M1', 'M2'], { M1: 'sim', M2: 'nao' }), 'refutada');
});

test('implica: A=SIM e B=SIM é compatível', () => {
  assert.equal(veredito('implica', ['M1', 'M2'], { M1: 'sim', M2: 'sim' }), 'compativel');
});

test('implica: A=NÃO não testa nada — o antecedente não disparou', () => {
  assert.equal(veredito('implica', ['M1', 'M2'], { M1: 'nao', M2: 'sim' }), 'nao_testavel');
  assert.equal(veredito('implica', ['M1', 'M2'], { M1: 'nao', M2: 'nao' }), 'nao_testavel');
});

test('implica: a ORDEM decide — invertê-la muda o veredito', () => {
  const estado = { M1: 'sim', M2: 'nao' } as Record<string, Desfecho>;
  assert.equal(veredito('implica', ['M1', 'M2'], estado), 'refutada');
  assert.equal(veredito('implica', ['M2', 'M1'], estado), 'nao_testavel');
});

// ---------------------------------------------------------------------------
// exclui — não podem acontecer juntos
// ---------------------------------------------------------------------------

test('exclui: os dois SIM refuta', () => {
  assert.equal(veredito('exclui', ['M1', 'M2'], { M1: 'sim', M2: 'sim' }), 'refutada');
});

test('exclui: exatamente um SIM é compatível', () => {
  assert.equal(veredito('exclui', ['M1', 'M2'], { M1: 'sim', M2: 'nao' }), 'compativel');
  assert.equal(veredito('exclui', ['M1', 'M2'], { M1: 'nao', M2: 'sim' }), 'compativel');
});

test('exclui: os dois NÃO não exerce a restrição', () => {
  assert.equal(veredito('exclui', ['M1', 'M2'], { M1: 'nao', M2: 'nao' }), 'nao_testavel');
});

// ---------------------------------------------------------------------------
// particiona — exatamente um
// ---------------------------------------------------------------------------

test('particiona: exatamente um SIM é compatível', () => {
  assert.equal(
    veredito('particiona', ['M1', 'M2', 'M3'], { M1: 'nao', M2: 'sim', M3: 'nao' }),
    'compativel',
  );
});

test('particiona: zero ou dois SIM refuta', () => {
  assert.equal(
    veredito('particiona', ['M1', 'M2', 'M3'], { M1: 'nao', M2: 'nao', M3: 'nao' }),
    'refutada',
  );
  assert.equal(
    veredito('particiona', ['M1', 'M2', 'M3'], { M1: 'sim', M2: 'sim', M3: 'nao' }),
    'refutada',
  );
});

// ---------------------------------------------------------------------------
// equivale — mesmo desfecho
// ---------------------------------------------------------------------------

test('equivale: iguais compatível, diferentes refutada, e sempre testável', () => {
  assert.equal(veredito('equivale', ['M1', 'M2'], { M1: 'sim', M2: 'sim' }), 'compativel');
  assert.equal(veredito('equivale', ['M1', 'M2'], { M1: 'nao', M2: 'nao' }), 'compativel');
  assert.equal(veredito('equivale', ['M1', 'M2'], { M1: 'sim', M2: 'nao' }), 'refutada');
});

// ---------------------------------------------------------------------------
// conjuncao — C ⇔ A e B
// ---------------------------------------------------------------------------

test('conjuncao: C=SIM com A e B SIM é compatível', () => {
  assert.equal(
    veredito('conjuncao', ['M3', 'M1', 'M2'], { M3: 'sim', M1: 'sim', M2: 'sim' }),
    'compativel',
  );
});

test('conjuncao: C=SIM sem A e B refuta', () => {
  assert.equal(
    veredito('conjuncao', ['M3', 'M1', 'M2'], { M3: 'sim', M1: 'sim', M2: 'nao' }),
    'refutada',
  );
});

test('conjuncao: A e B SIM sem C também refuta — é bicondicional', () => {
  assert.equal(
    veredito('conjuncao', ['M3', 'M1', 'M2'], { M3: 'nao', M1: 'sim', M2: 'sim' }),
    'refutada',
  );
});

test('conjuncao: C=NÃO com A ou B em NÃO é compatível', () => {
  assert.equal(
    veredito('conjuncao', ['M3', 'M1', 'M2'], { M3: 'nao', M1: 'sim', M2: 'nao' }),
    'compativel',
  );
});

// ---------------------------------------------------------------------------
// Bordas
// ---------------------------------------------------------------------------

test('desfecho ausente de qualquer membro torna a relação não testável', () => {
  assert.equal(veredito('equivale', ['M1', 'M2'], { M1: 'sim' }), 'nao_testavel');
  assert.equal(
    veredito('particiona', ['M1', 'M2', 'M3'], { M1: 'sim', M2: 'nao' }),
    'nao_testavel',
  );
});

test('`nenhuma` nunca é testável — não afirma restrição', () => {
  assert.equal(veredito('nenhuma', ['M1', 'M2'], { M1: 'sim', M2: 'sim' }), 'nao_testavel');
});

test('todo veredito vem com motivo legível', () => {
  const c = conferirRelacao(rel('implica', ['M1', 'M2']), desfechos({ M1: 'sim', M2: 'nao' }));
  assert.equal(c.veredito, 'refutada');
  assert.ok(c.motivo.includes('M1') && c.motivo.includes('M2'));
});
