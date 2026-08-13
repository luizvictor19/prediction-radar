import { test } from 'node:test';
import assert from 'node:assert/strict';

import { SEMENTE_PADRAO, ordenarFila, pendentes } from './fila.js';

const grupos = (n: number): Array<{ id: string }> =>
  Array.from({ length: n }, (_, i) => ({ id: `g${i}` }));

test('mesma semente, mesma fila, sempre', () => {
  const a = ordenarFila(grupos(50), SEMENTE_PADRAO).map((g) => g.id);
  const b = ordenarFila(grupos(50), SEMENTE_PADRAO).map((g) => g.id);
  assert.deepEqual(a, b);
});

test('a ordem de entrada não muda a fila', () => {
  const direto = ordenarFila(grupos(30), 's').map((g) => g.id);
  const invertido = ordenarFila([...grupos(30)].reverse(), 's').map((g) => g.id);
  assert.deepEqual(direto, invertido);
});

test('semente diferente, fila diferente', () => {
  const a = ordenarFila(grupos(50), 'semente-a').map((g) => g.id);
  const b = ordenarFila(grupos(50), 'semente-b').map((g) => g.id);
  assert.notDeepEqual(a, b);
});

test('a fila embaralha de verdade — não devolve a ordem de entrada', () => {
  const entrada = grupos(50).map((g) => g.id);
  assert.notDeepEqual(ordenarFila(grupos(50), SEMENTE_PADRAO).map((g) => g.id), entrada);
});

test('grupo novo se encaixa sem reembaralhar os antigos', () => {
  // A propriedade que um Fisher-Yates com PRNG não tem, e sem a qual "os 100
  // primeiros" muda de significado toda vez que a coleta muda: a fatia já
  // rodada deixaria de ser um prefixo, e a retomada passaria a repetir e a
  // pular ao mesmo tempo.
  const antes = ordenarFila(grupos(20), SEMENTE_PADRAO).map((g) => g.id);
  const depois = ordenarFila([...grupos(20), { id: 'novo-1' }, { id: 'novo-2' }], SEMENTE_PADRAO)
    .map((g) => g.id)
    .filter((id) => !id.startsWith('novo'));
  assert.deepEqual(depois, antes);
});

test('retomada tira quem já tem registro e mantém a ordem', () => {
  const fila = ordenarFila(grupos(10), SEMENTE_PADRAO);
  const feitos = fila.slice(0, 4).map((g) => ({ grupoId: g.id, status: 'ok' as const }));
  const r = pendentes(fila, feitos);
  assert.equal(r.jaFeitos, 4);
  assert.deepEqual(
    r.pendentes.map((g) => g.id),
    fila.slice(4).map((g) => g.id),
  );
});

test('falha conta como feito — retentar em silêncio gastaria em looping', () => {
  const fila = ordenarFila(grupos(5), SEMENTE_PADRAO);
  const r = pendentes(fila, [{ grupoId: fila[0]?.id as string, status: 'falha' }]);
  assert.equal(r.jaFeitos, 1);
  assert.ok(!r.pendentes.some((g) => g.id === fila[0]?.id));
});

test('sem registro nenhum, a fila inteira está pendente', () => {
  const fila = ordenarFila(grupos(7), SEMENTE_PADRAO);
  assert.equal(pendentes(fila, []).pendentes.length, 7);
});

test('rodar 100 e depois 300 processa os 200 do meio, na mesma ordem', () => {
  const fila = ordenarFila(grupos(400), SEMENTE_PADRAO);
  const primeiraRodada = fila.slice(0, 100);
  const registros = primeiraRodada.map((g) => ({ grupoId: g.id, status: 'ok' as const }));
  const segunda = pendentes(fila, registros).pendentes.slice(0, 200);
  assert.deepEqual(
    segunda.map((g) => g.id),
    fila.slice(100, 300).map((g) => g.id),
  );
});
