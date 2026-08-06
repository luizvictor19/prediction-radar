import { test } from 'node:test';
import assert from 'node:assert/strict';

// O módulo importa o cliente do Supabase por transitividade. Criar o cliente não
// abre conexão — nenhum teste aqui toca banco ou rede.
process.env['SUPABASE_URL'] ??= 'http://localhost:54321';
process.env['SUPABASE_SERVICE_KEY'] ??= 'test-key';

const { cycleStatus } = await import('./esports-resolver.js');
const { emptyStats } = await import('../verticals/resolver.js');

test('ciclo limpo é success, inclusive quando não havia nada a resolver', () => {
  // O caso dominante em regime: o varredor chegou ao fim, nada novo entrou.
  // Isso é saúde, não ausência de trabalho.
  const stats = emptyStats();
  stats.scanned = 200;
  stats.alreadyLinked = 200;
  stats.reachedEnd = true;

  assert.equal(cycleStatus(stats), 'success');
});

test('só falha de verdade rebaixa para partial', () => {
  // Mesma lição do watchlist_collector: contagem alta de pendência não é falha
  // do ciclo. Um ciclo que resolveu 900 markets e mandou 12 para revisão correu
  // perfeitamente — a revisão é o produto, não o defeito.
  const comRevisao = emptyStats();
  comRevisao.byPath.slugParse.resolved = 900;
  comRevisao.byPath.slugParse.needsReview = 12;
  comRevisao.byPath.slugParse.recomputable = 300;
  comRevisao.byPath.slugParse.role.unknown = 40;
  assert.equal(cycleStatus(comRevisao), 'success');

  const comErro = emptyStats();
  comErro.errors.push('releitura de esports_teams: timeout');
  assert.equal(cycleStatus(comErro), 'partial');

  const comLinhaPerdida = emptyStats();
  comLinhaPerdida.writeFailedRows = 3;
  assert.equal(cycleStatus(comLinhaPerdida), 'partial');
});

test('migration não aplicada é partial, não error', () => {
  // É o estado esperado entre o deploy do código e o apply da migration (H4),
  // não incidente — mesmo tratamento que o job de partições dá ao seu caso.
  const stats = emptyStats();
  stats.tablesMissing = true;

  assert.equal(cycleStatus(stats), 'partial');
});
