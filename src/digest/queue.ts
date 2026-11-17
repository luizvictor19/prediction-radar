import { hasTerminalStatus } from '../lib/market-status.js';

/**
 * Who enters the queue that PAYS for a model call, and who stays out.
 *
 * Moved from `scripts/lib/fila-digestao.ts` (issue 93) so the scheduled run in
 * `src/aws/` filters with the same function as the manual script, without
 * `src/` importing from `scripts/`. The old path re-exports everything here,
 * and the names stay as they were: they are the vocabulary of the digestion
 * spec, and renaming them would cut that link for no behavior change.
 *
 * This module imports no database client, so it is testable without a network.
 */

/** The least this module needs to know about a market. */
export interface MercadoFiltravel {
  eventId: string;
  status: string | null;
}

export interface Descarte<T> {
  digeriveis: T[];
  /** How many left, by status. A discard nobody counts is lost coverage. */
  descartados: Map<string, number>;
}

/** The bucket label for a market with no readable status. */
export const SEM_STATUS = '(nulo/ausente)';

/**
 * Removes the markets whose outcome already arrived.
 *
 * Returns the count of what left together with what stayed: the
 * `(nulo/ausente)` bucket exists for the day a value outside the known
 * vocabulary shows up. It is NOT discarded (see `hasTerminalStatus`), but it is
 * counted, because a new value in `events.status` is news and must not arrive
 * as silence.
 */
export function filtrarDigeriveis<T extends MercadoFiltravel>(mercados: readonly T[]): Descarte<T> {
  const digeriveis: T[] = [];
  const descartados = new Map<string, number>();

  for (const mercado of mercados) {
    if (hasTerminalStatus(mercado.status)) {
      const rotulo = mercado.status ?? SEM_STATUS;
      descartados.set(rotulo, (descartados.get(rotulo) ?? 0) + 1);
      continue;
    }
    digeriveis.push(mercado);
  }

  return { digeriveis, descartados };
}
