/**
 * Validation of everything a route receives from the browser, and the two
 * insert rows built from it.
 *
 * Each row is built from a whitelist, key by key. Nothing in the body is
 * spread into a row, so a body with `estrategia`, `placed_at` or `id` writes
 * the same row as one without them. Anything that fails here answers 400 and
 * never reaches the database.
 */

export type Resultado<T> = { ok: true; valor: T } | { ok: false; motivo: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** `description_sha256`: lowercase hex, as `hashDescription` writes it. */
const SHA256 = /^[0-9a-f]{64}$/;
/** `defeito_id`: an md5 in lowercase hex (`20260817040920_...sql`). */
const MD5 = /^[0-9a-f]{32}$/;

/** Cap on `?ids=` of the contradictions route. */
export const MAXIMO_DE_IDS = 200;

const TEXTO_CURTO = 200;
const TEXTO_LONGO = 20_000;

function falha(motivo: string): { ok: false; motivo: string } {
  return { ok: false, motivo };
}

export function lerEventId(valor: unknown): Resultado<string> {
  return typeof valor === 'string' && UUID.test(valor)
    ? { ok: true, valor }
    : falha('id de mercado inválido');
}

export function lerSha(valor: unknown): Resultado<string> {
  return typeof valor === 'string' && SHA256.test(valor)
    ? { ok: true, valor }
    : falha('hash de texto inválido');
}

export function lerDefeitoIds(param: string | null): Resultado<string[]> {
  if (param === null || param === '') return { ok: true, valor: [] };
  const ids = param.split(',');
  if (ids.length > MAXIMO_DE_IDS) return falha(`mais de ${MAXIMO_DE_IDS} ids`);
  if (!ids.every((id) => MD5.test(id))) return falha('id de defeito inválido');
  return { ok: true, valor: ids };
}

function ehObjeto(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function numeroEntre(v: unknown, min: number, max: number): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;
}

/** `undefined` and `null` both mean "no value"; anything else must be a string up to `max`. */
function textoOuNulo(v: unknown, max: number): Resultado<string | null> {
  if (v === undefined || v === null) return { ok: true, valor: null };
  if (typeof v !== 'string' || v.length > max) return falha('texto inválido');
  return { ok: true, valor: v };
}

/** The `my_bets` row, with the keys the old `gravarPrevisao` sent and no other. */
export function validarPrevisao(corpo: unknown): Resultado<Record<string, unknown>> {
  if (!ehObjeto(corpo)) return falha('corpo não é um objeto');

  const eventId = lerEventId(corpo['eventId']);
  if (!eventId.ok) return eventId;
  if (!numeroEntre(corpo['prob'], 0, 1)) return falha('prob tem que ser um número entre 0 e 1');

  const preco = corpo['precoMercado'];
  if (preco !== null && preco !== undefined && !numeroEntre(preco, 0, 1)) {
    return falha('precoMercado tem que ser nulo ou um número entre 0 e 1');
  }

  const categoria = textoOuNulo(corpo['categoria'], TEXTO_CURTO);
  const nota = textoOuNulo(corpo['nota'], TEXTO_LONGO);
  const precoEm = textoOuNulo(corpo['precoMercadoEm'], 64);
  const precoOutcome = textoOuNulo(corpo['precoMercadoOutcome'], TEXTO_CURTO);
  const probOutcome = textoOuNulo(corpo['probSelfOutcome'], TEXTO_CURTO);
  for (const [nome, r] of [
    ['categoria', categoria],
    ['nota', nota],
    ['precoMercadoEm', precoEm],
    ['precoMercadoOutcome', precoOutcome],
    ['probSelfOutcome', probOutcome],
  ] as const) {
    if (!r.ok) return falha(`${nome}: ${r.motivo}`);
  }
  if (precoEm.ok && precoEm.valor !== null && Number.isNaN(Date.parse(precoEm.valor))) {
    return falha('precoMercadoEm não é uma data');
  }

  const linha: Record<string, unknown> = {
    event_id: eventId.valor,
    prob_self: corpo['prob'],
    estrategia: 'radar',
    polymarket_category: categoria.ok ? categoria.valor : null,
    preco_mercado: preco ?? null,
    preco_mercado_em: precoEm.ok ? precoEm.valor : null,
    preco_mercado_outcome: precoOutcome.ok ? precoOutcome.valor : null,
    prob_self_outcome: probOutcome.ok ? probOutcome.valor : null,
  };
  if (nota.ok && nota.valor) {
    linha['thesis'] = nota.valor;
    linha['thesis_type'] = 'radar';
  }
  return { ok: true, valor: linha };
}

/**
 * The `my_bet_legs` row. `shares` is computed here, as the old `gravarLeg` did,
 * and never taken from the body.
 */
export function validarLeg(corpo: unknown): Resultado<Record<string, unknown>> {
  if (!ehObjeto(corpo)) return falha('corpo não é um objeto');

  const betId = lerEventId(corpo['betId']);
  if (!betId.ok) return falha('id da previsão inválido');
  const eventId = lerEventId(corpo['eventId']);
  if (!eventId.ok) return eventId;

  const outcome = corpo['outcome'];
  if (typeof outcome !== 'string' || !outcome.trim() || outcome.length > TEXTO_CURTO) {
    return falha('falta o lado');
  }
  // Same range the Operar form enforces before sending.
  const entrada = corpo['entryPrice'];
  if (!numeroEntre(entrada, Number.MIN_VALUE, 1)) {
    return falha('preço de entrada tem que estar em (0, 1]');
  }
  const stake = corpo['stakeUsd'];
  if (!numeroEntre(stake, Number.MIN_VALUE, Number.MAX_VALUE)) {
    return falha('stake tem que ser > 0');
  }

  return {
    ok: true,
    valor: {
      bet_id: betId.valor,
      event_id: eventId.valor,
      outcome,
      entry_price: entrada,
      stake_usd: stake,
      shares: Math.round((stake / entrada) * 10000) / 10000,
    },
  };
}
