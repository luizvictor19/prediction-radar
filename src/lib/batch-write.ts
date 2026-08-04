import { supabase } from './supabase.js';

/**
 * Escrita em lote no PostgREST.
 *
 * O custo dominante do sistema não era a query, era o número de round-trips:
 * dezenas de milhões de INSERT de uma linha só saturavam o PostgREST e empurravam
 * as leituras dos detectores para além do timeout de 8s (spec 000, item 1).
 *
 * Cada chunk é uma transação única — uma linha inválida derruba o chunk inteiro.
 * Por isso o erro é logado com o range das linhas e o ciclo segue: um chunk ruim
 * não pode abortar a coleta.
 */

/** Ponto de partida. Payload grande demais estoura o limite do PostgREST. */
export const DEFAULT_CHUNK_SIZE = 500;

/**
 * `events` carrega `description` — linhas ~10x mais gordas que um snapshot
 * (~1,3 KB de média na tabela hoje). Chunk menor para não arriscar o limite
 * de payload, que derrubaria o lote inteiro.
 */
export const EVENTS_CHUNK_SIZE = 200;

export interface BatchWriteResult<R = unknown> {
  /** Linhas em chunks que passaram. */
  written: number;
  /** Linhas perdidas em chunks que falharam. */
  failedRows: number;
  /** Uma entrada por chunk que falhou, com o range das linhas. */
  errors: string[];
  /** Linhas retornadas pelo `select`, quando pedido. Vazio caso contrário. */
  rows: R[];
}

interface BatchOptions {
  chunkSize?: number;
  /** Prefixo no log de erro. Default: nome da tabela. */
  label?: string;
  /** Colunas a ler de volta. Necessário quando o chamador depende do `id` gerado. */
  select?: string;
}

interface BatchUpsertOptions extends BatchOptions {
  onConflict: string;
  ignoreDuplicates?: boolean;
}

type ChunkResponse = { data: unknown; error: { message: string } | null };

async function runChunked<R>(
  table: string,
  rows: readonly unknown[],
  opts: BatchOptions,
  exec: (chunk: unknown[]) => PromiseLike<ChunkResponse>,
): Promise<BatchWriteResult<R>> {
  const chunkSize = opts.chunkSize ?? DEFAULT_CHUNK_SIZE;
  const label = opts.label ?? table;
  const result: BatchWriteResult<R> = { written: 0, failedRows: 0, errors: [], rows: [] };

  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize) as unknown[];
    const range = `${i}-${i + chunk.length - 1}`;

    let response: ChunkResponse;
    try {
      response = await exec(chunk);
    } catch (err) {
      response = { data: null, error: { message: String(err) } };
    }

    if (response.error) {
      result.failedRows += chunk.length;
      result.errors.push(`rows ${range}: ${response.error.message}`);
      console.error(`[batch:${label}] ${table} rows ${range} failed: ${response.error.message}`);
      continue;
    }

    result.written += chunk.length;
    if (Array.isArray(response.data)) result.rows.push(...(response.data as R[]));
  }

  return result;
}

export function batchInsert<R = unknown>(
  table: string,
  rows: readonly unknown[],
  opts: BatchOptions = {},
): Promise<BatchWriteResult<R>> {
  return runChunked<R>(table, rows, opts, (chunk) => {
    const query = supabase.from(table).insert(chunk);
    return (opts.select ? query.select(opts.select) : query) as PromiseLike<ChunkResponse>;
  });
}

export function batchUpsert<R = unknown>(
  table: string,
  rows: readonly unknown[],
  opts: BatchUpsertOptions,
): Promise<BatchWriteResult<R>> {
  return runChunked<R>(table, rows, opts, (chunk) => {
    const query = supabase.from(table).upsert(chunk, {
      onConflict: opts.onConflict,
      ignoreDuplicates: opts.ignoreDuplicates ?? false,
    });
    return (opts.select ? query.select(opts.select) : query) as PromiseLike<ChunkResponse>;
  });
}

/**
 * Remove duplicatas pela chave de conflito, mantendo a última ocorrência.
 *
 * `ON CONFLICT DO UPDATE` não pode afetar a mesma linha duas vezes na mesma
 * instrução — sem isso, uma duplicata dentro do chunk derruba o lote inteiro.
 */
export function dedupeByKey<T>(rows: readonly T[], key: (row: T) => string): T[] {
  const byKey = new Map<string, T>();
  for (const row of rows) byKey.set(key(row), row);
  return [...byKey.values()];
}
