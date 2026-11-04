import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DISK_USAGE_RPC, probeDiskUsage, type DiskUsageRpc } from './disk-usage.js';

const VAZIO = { database_bytes: null, wal_bytes: null };

/** A stand-in for `supabase.rpc` that records the function name it was asked for. */
function rpcQueDevolve(resposta: { data: unknown; error: { message: string } | null }) {
  const chamadas: string[] = [];
  const rpc: DiskUsageRpc = async (fn) => {
    chamadas.push(fn);
    return resposta;
  };
  return { rpc, chamadas };
}

describe('probeDiskUsage', () => {
  it('chama a função database_disk_usage', async () => {
    const { rpc, chamadas } = rpcQueDevolve({ data: [], error: null });
    await probeDiskUsage(rpc);
    assert.deepEqual(chamadas, [DISK_USAGE_RPC]);
    assert.equal(DISK_USAGE_RPC, 'database_disk_usage');
  });

  it('devolve null nos dois quando a função ainda não existe', async () => {
    // `data` filled on purpose: with `data: null` the empty-row branch would
    // return the same value, and the error branch would go untested.
    const { rpc } = rpcQueDevolve({
      data: [{ database_bytes: 1, wal_bytes: 2 }],
      error: { message: 'Could not find the function public.database_disk_usage' },
    });
    assert.deepEqual(await probeDiskUsage(rpc), VAZIO);
  });

  it('devolve null nos dois quando a chamada lança, sem derrubar o job', async () => {
    const rpc: DiskUsageRpc = async () => {
      throw new Error('fetch failed');
    };
    assert.deepEqual(await probeDiskUsage(rpc), VAZIO);
  });

  it('devolve null nos dois quando o resultado vem vazio', async () => {
    const { rpc } = rpcQueDevolve({ data: [], error: null });
    assert.deepEqual(await probeDiskUsage(rpc), VAZIO);
  });

  it('devolve null no campo que não é número', async () => {
    const { rpc } = rpcQueDevolve({
      data: [{ database_bytes: 3576692736, wal_bytes: 'abc' }],
      error: null,
    });
    assert.deepEqual(await probeDiskUsage(rpc), { database_bytes: 3576692736, wal_bytes: null });
  });

  it('aceita bigint vindo como string do PostgREST', async () => {
    const { rpc } = rpcQueDevolve({
      data: [{ database_bytes: '3576692736', wal_bytes: '1073741824' }],
      error: null,
    });
    assert.deepEqual(await probeDiskUsage(rpc), {
      database_bytes: 3576692736,
      wal_bytes: 1073741824,
    });
  });

  it('aceita a linha única fora de array', async () => {
    const { rpc } = rpcQueDevolve({
      data: { database_bytes: 10, wal_bytes: 20 },
      error: null,
    });
    assert.deepEqual(await probeDiskUsage(rpc), { database_bytes: 10, wal_bytes: 20 });
  });
});
