/**
 * Lock de ciclo para coletores agendados por cron.
 *
 * Um `let isRunning = false` liberado em `finally` cobre o caso do ciclo que
 * lança, mas não o do ciclo que nunca retorna — um fetch pendurado prende o
 * lock para sempre e o coletor para de rodar em silêncio, tick após tick.
 *
 * Por isso o lock guarda o instante em que o ciclo começou: passado
 * `staleAfterMs`, o próximo tick assume que o anterior morreu e toma o lock.
 */

/** Default pedido no incidente: ciclo com mais de 20 min é considerado travado. */
export const DEFAULT_STALE_AFTER_MS = 20 * 60 * 1000;

export interface CycleLockToken {
  /** Identifica o detentor. Só ele pode liberar o lock. */
  readonly generation: number;
  /** Há quanto tempo o ciclo anterior estava preso, quando houve takeover. */
  readonly staleTakeoverMs: number | null;
}

export class CycleLock {
  private holder: number | null = null;
  private startedAt = 0;
  private nextGeneration = 1;

  constructor(private readonly staleAfterMs: number = DEFAULT_STALE_AFTER_MS) {}

  /** Retorna `null` quando há um ciclo em andamento dentro do prazo. */
  tryAcquire(): CycleLockToken | null {
    const now = Date.now();
    let staleTakeoverMs: number | null = null;

    if (this.holder !== null) {
      const heldForMs = now - this.startedAt;
      if (heldForMs < this.staleAfterMs) return null;
      staleTakeoverMs = heldForMs;
    }

    const generation = this.nextGeneration++;
    this.holder = generation;
    this.startedAt = now;
    return { generation, staleTakeoverMs };
  }

  /**
   * Idempotente e seguro contra o ciclo zumbi: se um ciclo travado finalmente
   * retorna depois de o lock ter sido tomado, o release dele não pode derrubar
   * o lock de quem assumiu.
   */
  release(token: CycleLockToken): void {
    if (this.holder === token.generation) this.holder = null;
  }

  /** Há quanto tempo o ciclo atual está rodando. `null` se não há ciclo. */
  heldForMs(): number | null {
    return this.holder === null ? null : Date.now() - this.startedAt;
  }
}
