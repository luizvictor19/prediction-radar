/**
 * Where the screen is, and which market it is about -- step 1 of item 5.
 *
 * Hoje, Regra and Operar were three tabs, which framed them as three parallel
 * destinations. They are one flow: you list, you pick a market, and only then
 * you decide whether to bet. The Operar tab always knew which market it meant --
 * it read it from application state, and the tab only hid that.
 *
 * So the market travels IN the route. `selecionadoId` disappears as a separate
 * field, and `{ tela: 'operar' }` with no market id stops being representable --
 * the tabs had to disable themselves against exactly that state.
 *
 * It carries an ID, not a market: resolving it against the loaded roster can
 * still miss, and `App` says so rather than rendering an empty screen. "The
 * route names no market" and "the roster does not have it" are different facts.
 */
export type Rota =
  | { tela: 'hoje' }
  | { tela: 'regra'; mercadoId: string }
  | { tela: 'operar'; mercadoId: string };

/** The list. The only route with no market attached. */
export const HOJE: Rota = { tela: 'hoje' };

/** The market the route is about, or `null` on the list. */
export function mercadoDaRota(rota: Rota): string | null {
  return rota.tela === 'hoje' ? null : rota.mercadoId;
}

/**
 * The stopwatch of the readiness criterion, across one route change.
 *
 * It measures how long it took from leaving the list to arriving at the bet --
 * "rápido" without a number is an opinion. Pure, and the clock is a parameter,
 * so the rule can be tested without waiting for time to pass.
 *
 * Four cases, and each one is a decision:
 *
 * - **Back to Hoje clears it.** The measurement is over, or it was abandoned.
 *   Carrying it forward would charge the next market for time spent on this one.
 * - **Leaving Hoje starts it.** That is what "from the list" means.
 * - **A different market restarts it.** A measurement belongs to one market.
 * - **Anything else keeps it.** Regra -> Operar is the case that matters, and it
 *   is the one the screen gets wrong today: `abrirOperar` stamps `inicioMs` on
 *   every call, so the flow measures the button press instead of the reading.
 *
 * It never fabricates a start. Arriving at Operar with a null clock stays null,
 * and `Operar` renders nothing for a null `levouMs` -- "not measured" is a
 * different fact from "0s", the same distinction `somaDigest` makes by returning
 * `null` instead of `0`.
 */
export function cronometroApos(
  anterior: Rota,
  proxima: Rota,
  inicioMs: number | null,
  agoraMs: number,
): number | null {
  if (proxima.tela === 'hoje') return null;

  const de = mercadoDaRota(anterior);
  if (de === null || de !== mercadoDaRota(proxima)) return agoraMs;

  return inicioMs;
}
