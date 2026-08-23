import { test } from 'node:test';
import assert from 'node:assert/strict';
import { escolherRegulamento, type DescricaoAtual, type TextoGuardado } from './regulamento';

/**
 * Which text the right-hand column shows, and whether it may highlight on it.
 *
 * It looks like one question and it is two: "is this text the one that produced
 * these findings?" and "does the text that produced these findings still exist
 * anywhere?". Before `market_rule_texts` the second had no possible answer, and
 * the screen answered both with the same sentence.
 */

const SHA = 'a'.repeat(64);
const OUTRO = 'b'.repeat(64);
const TEXTO = 'This market resolves YES if the team wins by 11:59 PM ET.';
const EDITADO = 'This market resolves YES if the team wins by 11:59 PM EDT.';

const LENDO: DescricaoAtual = { fase: 'lendo' };
const GUARDADO_LENDO: TextoGuardado = { fase: 'lendo' };

test('o texto guardado vence a descrição atual, mesmo quando as duas chegaram', () => {
  const r = escolherRegulamento(
    SHA,
    { fase: 'lido', texto: EDITADO, sha: OUTRO },
    { fase: 'guardado', texto: TEXTO },
  );

  assert.deepEqual(r, { fase: 'guardado', texto: TEXTO });
});

test('sem texto guardado, a descrição atual só vale se o hash dela for o do bloco', () => {
  const bate = escolherRegulamento(
    SHA,
    { fase: 'lido', texto: TEXTO, sha: SHA },
    { fase: 'ausente' },
  );
  assert.deepEqual(bate, { fase: 'atual', texto: TEXTO });

  const naoBate = escolherRegulamento(
    SHA,
    { fase: 'lido', texto: EDITADO, sha: OUTRO },
    { fase: 'ausente' },
  );
  assert.deepEqual(naoBate, { fase: 'nao-guardado', atual: EDITADO });
});

test('sem texto guardado e sem descrição, não há o que mostrar', () => {
  const r = escolherRegulamento(SHA, { fase: 'ausente' }, { fase: 'ausente' });
  assert.deepEqual(r, { fase: 'ausente' });
});

test('a SEQUÊNCIA de uma regra editada nunca passa por "não guardado"', () => {
  // The case the destination alone cannot prove. The two reads land in
  // different orders, and at the middle step the current description has come
  // back with the hash of ANOTHER version while `market_rule_texts` has not
  // answered yet. Deciding there announces "the digested text is not stored" an
  // instant before it arrives -- and the final state is 'guardado' either way,
  // so an assertion about the end alone passes with the early decision inside.
  const editada: DescricaoAtual = { fase: 'lido', texto: EDITADO, sha: OUTRO };
  const passos: TextoGuardado[] = [
    GUARDADO_LENDO,
    GUARDADO_LENDO,
    { fase: 'guardado', texto: TEXTO },
  ];
  const atuais: DescricaoAtual[] = [LENDO, editada, editada];

  const fases = passos.map((g, i) => escolherRegulamento(SHA, atuais[i] as DescricaoAtual, g).fase);

  assert.deepEqual(fases, ['lendo', 'lendo', 'guardado']);
});

test('a SEQUÊNCIA de um texto que nunca foi guardado termina em "não guardado"', () => {
  const editada: DescricaoAtual = { fase: 'lido', texto: EDITADO, sha: OUTRO };
  const fases = [
    escolherRegulamento(SHA, LENDO, GUARDADO_LENDO),
    escolherRegulamento(SHA, editada, GUARDADO_LENDO),
    escolherRegulamento(SHA, editada, { fase: 'ausente' }),
  ].map((r) => r.fase);

  assert.deepEqual(fases, ['lendo', 'lendo', 'nao-guardado']);
});

test('descrição atual conferida pelo hash não espera a consulta ao texto guardado', () => {
  // The other side of the same sequence: when the hash MATCHES, the document in
  // hand is already the right one -- proven, not presumed. Holding the column on
  // a spinner until `market_rule_texts` answers would be waiting for a second
  // copy of the text that is already here.
  const igual: DescricaoAtual = { fase: 'lido', texto: TEXTO, sha: SHA };
  const fases = [
    escolherRegulamento(SHA, LENDO, GUARDADO_LENDO),
    escolherRegulamento(SHA, igual, GUARDADO_LENDO),
    escolherRegulamento(SHA, igual, { fase: 'ausente' }),
  ].map((r) => r.fase);

  assert.deepEqual(fases, ['lendo', 'atual', 'atual']);
});

test('erro ao ler o texto guardado não vira "não guardado"', () => {
  // "I could not ask" and "I asked and it is not there" are different things,
  // and only the second lets the screen say the text is not stored.
  const r = escolherRegulamento(
    SHA,
    { fase: 'lido', texto: EDITADO, sha: OUTRO },
    { fase: 'erro', motivo: 'timeout' },
  );

  assert.deepEqual(r, { fase: 'erro', motivo: 'timeout' });
});

test('erro ao ler o texto guardado é irrelevante quando a descrição atual bate no hash', () => {
  const r = escolherRegulamento(
    SHA,
    { fase: 'lido', texto: TEXTO, sha: SHA },
    { fase: 'erro', motivo: 'timeout' },
  );

  assert.deepEqual(r, { fase: 'atual', texto: TEXTO });
});

test('erro ao ler a descrição atual continua sendo erro quando não há texto guardado', () => {
  const r = escolherRegulamento(SHA, { fase: 'erro', motivo: 'PGRST116' }, { fase: 'ausente' });
  assert.deepEqual(r, { fase: 'erro', motivo: 'PGRST116' });
});

test('o texto guardado salva a coluna de um erro na leitura da descrição atual', () => {
  const r = escolherRegulamento(
    SHA,
    { fase: 'erro', motivo: 'PGRST116' },
    { fase: 'guardado', texto: TEXTO },
  );

  assert.deepEqual(r, { fase: 'guardado', texto: TEXTO });
});

test('descrição ausente com o texto guardado mostra o texto guardado', () => {
  // The market lost its description entirely and the evidence survives anyway.
  // It is the scenario issue #9 exists to make possible.
  const r = escolherRegulamento(SHA, { fase: 'ausente' }, { fase: 'guardado', texto: TEXTO });
  assert.deepEqual(r, { fase: 'guardado', texto: TEXTO });
});
