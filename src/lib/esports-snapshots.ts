import { supabase } from './supabase.js';
import { batchInsert, type BatchWriteResult } from './batch-write.js';
import type { GammaMarket } from '../types/index.js';

/**
 * Escrita da série temporal de esports (spec 000, item 3).
 *
 * `esports_snapshots` é estreita e particionada por dia justamente para que a
 * limpeza seja DROP PARTITION. `polymarket_snapshots`, que a retenção limpa com
 * DELETE em ciclo, é o que inflou um índice para 1492 MB sobre 80 MB de dado —
 * e a watchlist sozinha já grava ~650k linhas/dia lá.
 *
 * O destino é decidido aqui, e não no coletor, por causa de uma diferença
 * operacional do projeto: migration é aplicada à mão, em momento desconhecido,
 * enquanto o deploy do código é automático. Entre um e outro a tabela nova não
 * existe, e um insert nela derrubaria todo chunk — 650k linhas/dia de série
 * perdidas em silêncio, que é exatamente o dado que o backtest vai querer.
 * Enquanto a migration não estiver aplicada, a escrita continua onde estava.
 */

export interface EsportsSnapshotRow {
  event_id: string;
  captured_at: string;
  outcome: string;
  best_bid: number | null;
  best_ask: number | null;
  mid_price: number | null;
  volume_24h: number | null;
  liquidity: number | null;
}

/** Volume 24h do market, `null` quando a Gamma não manda nenhuma das variantes. */
export function gammaVolume24h(market: Pick<GammaMarket, 'volume24hr' | 'volume24hrClob'>): number | null {
  const raw = market.volume24hr ?? market.volume24hrClob;
  return raw == null || Number.isNaN(Number(raw)) ? null : Number(raw);
}

/**
 * Liquidez do market. `null` em vez de 0 quando ausente: 0 é um fato sobre o
 * book (acontece, e muito, no market recém-nascido) e não pode se confundir com
 * "a API não disse".
 */
export function gammaLiquidity(market: Pick<GammaMarket, 'liquidityNum' | 'liquidity'>): number | null {
  const raw = market.liquidityNum ?? market.liquidity;
  return raw == null || Number.isNaN(Number(raw)) ? null : Number(raw);
}

/**
 * A mesma linha no formato antigo.
 *
 * `liquidity` cai porque a coluna não existe em `polymarket_snapshots` — uma
 * chave a mais no payload derruba o chunk inteiro. `spread` não é reposto:
 * é `best_ask - best_bid`, e a coluna é nullable.
 */
export function toLegacySnapshotRow(row: EsportsSnapshotRow): Record<string, unknown> {
  const legacy: Record<string, unknown> = { ...row };
  delete legacy['liquidity'];
  return legacy;
}

/** Espaço para a migration ser aplicada sem redeploy — o probe volta a tentar. */
const PROBE_RETRY_MS = 10 * 60_000;

let tableAvailable: boolean | null = null;
let probedAt = 0;

/**
 * Uma vez positivo, para sempre: tabela não desaparece. O negativo tem validade
 * curta porque o que o desfaz é um `supabase db push` manual, sem deploy junto.
 */
async function esportsTableAvailable(): Promise<boolean> {
  const now = Date.now();
  if (tableAvailable === true) return true;
  if (tableAvailable === false && now - probedAt < PROBE_RETRY_MS) return false;

  const { error } = await supabase.from('esports_snapshots').select('event_id').limit(1);
  probedAt = now;
  tableAvailable = !error;

  if (error) {
    console.warn(`[esports_snapshots] indisponível (${error.message}) — gravando em polymarket_snapshots`);
  } else {
    console.log('[esports_snapshots] disponível — série de esports migrada');
  }

  return tableAvailable;
}

/** Só para teste: o cache do probe é global ao processo. */
export function resetEsportsTableProbe(): void {
  tableAvailable = null;
  probedAt = 0;
}

export interface SnapshotWriteResult extends BatchWriteResult {
  /** Onde as linhas foram parar. `null` quando não havia nada a gravar. */
  table: 'esports_snapshots' | 'polymarket_snapshots' | null;
}

export async function writeEsportsSnapshots(
  rows: readonly EsportsSnapshotRow[],
  label: string,
): Promise<SnapshotWriteResult> {
  if (rows.length === 0) {
    return { written: 0, failedRows: 0, errors: [], rows: [], table: null };
  }

  if (await esportsTableAvailable()) {
    const result = await batchInsert('esports_snapshots', rows, { label });
    return { ...result, table: 'esports_snapshots' };
  }

  const legacy = rows.map(toLegacySnapshotRow);
  const result = await batchInsert('polymarket_snapshots', legacy, { label });
  return { ...result, table: 'polymarket_snapshots' };
}
