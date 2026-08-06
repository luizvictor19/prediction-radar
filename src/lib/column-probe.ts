import { supabase } from './supabase.js';

/**
 * Sonda se uma coluna já existe na tabela.
 *
 * Migration neste projeto é aplicada à mão, depois do deploy do código que a
 * usa (spec 000, Parte E). Entre um e outro a coluna não existe, e o PostgREST
 * não perdoa nenhum dos dois lados: mandá-la no payload derruba o chunk inteiro
 * do upsert, lê-la no `select` derruba a query inteira. A sonda é o que permite
 * o código subir antes do apply em vez de esperar por ele.
 *
 * O resultado negativo tem validade curta de propósito — a migration é aplicada
 * sem redeploy, e um cache negativo eterno faria a coluna nunca começar a valer.
 * O positivo é definitivo: coluna não desaparece.
 */
const PROBE_RETRY_MS = 10 * 60_000;

export class ColumnProbe {
  private supported: boolean | null = null;
  private probedAt = 0;

  constructor(
    private readonly table: string,
    private readonly column: string,
    /** Prefixo do log. Normalmente o componente que sonda. */
    private readonly label: string,
  ) {}

  async isSupported(): Promise<boolean> {
    const now = Date.now();
    if (this.supported === true) return true;
    if (this.supported === false && now - this.probedAt < PROBE_RETRY_MS) return false;

    const { error } = await supabase.from(this.table).select(this.column).limit(1);
    const wasSupported = this.supported;
    this.probedAt = now;
    this.supported = !error;

    // Só na transição: repetir a linha a cada 10 min encheria o log com o que
    // já se sabe.
    if (wasSupported !== this.supported) {
      if (error) {
        console.warn(
          `[${this.label}] ${this.table}.${this.column} indisponível (${error.message}) — seguindo sem a coluna`,
        );
      } else {
        console.log(`[${this.label}] ${this.table}.${this.column} disponível`);
      }
    }

    return this.supported;
  }

  /**
   * As mesmas linhas, sem a coluna, enquanto ela não existir.
   *
   * Um upsert do PostgREST exige o mesmo conjunto de chaves em todas as linhas
   * do lote — por isso a remoção é do lote inteiro, nunca linha a linha.
   */
  async strip<T extends Record<string, unknown>>(rows: T[]): Promise<T[]> {
    if (rows.length === 0) return rows;
    if (await this.isSupported()) return rows;

    return rows.map(row => {
      const copy = { ...row };
      delete copy[this.column];
      return copy;
    });
  }

  /** A lista do `select` com a coluna anexada, quando ela existe. */
  async selectList(base: string): Promise<string> {
    return (await this.isSupported()) ? `${base}, ${this.column}` : base;
  }
}
