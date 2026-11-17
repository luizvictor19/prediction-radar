import { SEM_CACHE } from '../portao';
import { BancoSemConfiguracao } from './banco';

/** JSON, never cached: the journal does not belong in a shared cache. */
export function json(corpo: unknown, status = 200): Response {
  return new Response(JSON.stringify(corpo), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': SEM_CACHE },
  });
}

/** Thrown inside `responder` for a key with no row: answers 404 with its message. */
export class NaoEncontrado extends Error {}

export function invalido(motivo: string): Response {
  return json({ erro: motivo }, 400);
}

/**
 * Runs one query and answers with its result. A missing database configuration
 * answers 503, like the gate does; any other failure answers 500 with the
 * database's message, which is what the screen already showed before.
 */
export async function responder(consulta: () => Promise<unknown>, status = 200): Promise<Response> {
  try {
    return json(await consulta(), status);
  } catch (e) {
    if (e instanceof BancoSemConfiguracao) return json({ erro: e.message }, 503);
    if (e instanceof NaoEncontrado) return json({ erro: e.message }, 404);
    return json({ erro: e instanceof Error ? e.message : String(e) }, 500);
  }
}

/** The request body as JSON, or `undefined` when it is not JSON. */
export async function corpoJson(req: Request): Promise<unknown> {
  try {
    return (await req.json()) as unknown;
  } catch {
    return undefined;
  }
}
