import type { GammaMarket, GammaEvent, ClobOrderbook } from '../types/index.js';

const GAMMA_URL = process.env['POLYMARKET_GAMMA_URL'] ?? 'https://gamma-api.polymarket.com';
const CLOB_URL = process.env['POLYMARKET_CLOB_URL'] ?? 'https://clob.polymarket.com';

// Sem timeout, um socket pendurado deixa a promise do coletor sem resolver
// para sempre — e com ela o lock de ciclo, que só é solto no finally.
const FETCH_TIMEOUT_MS = 20_000;

/**
 * Erro de HTTP da Gamma carregando o status, para que o chamador distinga
 * "acabou a paginação" (422 no teto de offset) de "a API caiu" (5xx).
 */
export class GammaHttpError extends Error {
  constructor(readonly status: number, readonly url: string) {
    super(`HTTP ${status} fetching ${url}`);
    this.name = 'GammaHttpError';
  }
}

async function get<T>(url: string): Promise<T> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
    if (!res.ok) throw new GammaHttpError(res.status, url);
    return (await res.json()) as T;
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error(`Timeout after ${FETCH_TIMEOUT_MS}ms fetching ${url}`);
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Teto rígido de offset da Gamma (medido em 2026-08-04): offset 2000 responde 200,
 * 2050 em diante responde 422 — nenhuma ordenação escapa. Quem pagina precisa tratar
 * o 422 como fim de paginação, não como falha (ver GammaHttpError).
 */
export async function fetchActiveMarkets(params: {
  limit?: number;
  offset?: number;
  order?: string;
  ascending?: boolean;
}): Promise<GammaMarket[]> {
  const { limit = 500, offset = 0, order, ascending } = params;
  let url = `${GAMMA_URL}/markets?active=true&closed=false&limit=${limit}&offset=${offset}`;
  if (order) {
    url += `&order=${encodeURIComponent(order)}`;
    if (ascending !== undefined) {
      url += `&ascending=${ascending}`;
    }
  }
  return get<GammaMarket[]>(url);
}

/** Máximo de ids por chamada ao filtro `id=` (medido 2026-08-04). */
export const MAX_IDS_PER_REQUEST = 100;

/**
 * Busca markets por id, em lote. Sem offset, sem teto.
 *
 * Duas armadilhas, ambas medidas em 2026-08-04 e ambas silenciosas:
 *
 * 1. `limit` default é 20 e se aplica também ao filtro por id. Sem `limit`
 *    explícito, um lote de 50 ids devolve 20 — sem erro, sem aviso.
 * 2. O filtro `id=` aplica `closed=false` por padrão. Um lote de ids devolve
 *    vazio exatamente para os markets que resolveram. Daí `closed` ser
 *    parâmetro obrigatório aqui: quem chama tem que decidir qual lado quer.
 *
 * O chamador deve comparar quantos ids mandou com quantos voltaram — ausência
 * pode ser resolução (esperado) ou lote truncado (bug).
 */
export async function fetchMarketsByIds(
  ids: readonly string[],
  opts: { closed: boolean },
): Promise<GammaMarket[]> {
  if (ids.length === 0) return [];
  if (ids.length > MAX_IDS_PER_REQUEST) {
    throw new Error(`fetchMarketsByIds: ${ids.length} ids excede o máximo de ${MAX_IDS_PER_REQUEST}`);
  }

  const query = ids.map(id => `id=${encodeURIComponent(id)}`).join('&');
  const url = `${GAMMA_URL}/markets?limit=${ids.length}&closed=${opts.closed}&${query}`;
  return get<GammaMarket[]>(url);
}

/** Tag da Gamma que delimita o universo de esports. */
export const ESPORTS_TAG_SLUG = 'esports';

/**
 * Teto de itens por chamada ao `/events` (medido 2026-08-06). Vale tanto para a
 * paginação quanto para o filtro por slug.
 */
export const MAX_EVENTS_PER_REQUEST = 100;

/**
 * O universo de esports pelo endpoint de eventos.
 *
 * Quatro diferenças em relação a `/markets`, todas medidas em 2026-08-06:
 *
 * 1. `limit` satura em 100. Pedir 500 devolve 100 — sem erro, sem aviso.
 * 2. O teto de offset é o mesmo 2000, mas a borda é diferente: offset 2000
 *    devolve lista vazia e 2500 responde 422. Quem pagina trata os dois como
 *    fim de paginação (ver GammaHttpError).
 * 3. Cada evento traz `markets[]` completo. O market aninhado é idêntico ao de
 *    `/markets`: pareei 90 markets pelos dois caminhos e os 15 campos que o
 *    normalizador lê bateram em 90/90, incluindo `negRiskMarketID` e
 *    `outcomePrices`. O que o aninhado não tem é `events[]` e `series[]` —
 *    ambos vêm do evento pai (ver `gammaToEvent`).
 * 4. É aqui, e só aqui, que `teams[]` e `sport` existem.
 *
 * Custo medido: 4,2 KB por market contra 6,3 KB em `/markets` — o aninhado sai
 * mais barato porque `/markets` repete o embed `events[]` em cada market.
 *
 * A tag delimita o universo a paginar; ela NÃO decide o que é coletado. Quem
 * decide continua sendo `discovery_slug_prefixes`, aplicado market a market.
 */
export async function fetchEsportsEvents(params: {
  limit?: number;
  offset?: number;
  order?: string;
  ascending?: boolean;
  closed?: boolean;
  tagSlug?: string;
}): Promise<GammaEvent[]> {
  const {
    limit = MAX_EVENTS_PER_REQUEST,
    offset = 0,
    order,
    ascending,
    closed = false,
    tagSlug = ESPORTS_TAG_SLUG,
  } = params;

  let url =
    `${GAMMA_URL}/events?tag_slug=${encodeURIComponent(tagSlug)}` +
    `&closed=${closed}&limit=${limit}&offset=${offset}`;
  if (order) {
    url += `&order=${encodeURIComponent(order)}`;
    if (ascending !== undefined) {
      url += `&ascending=${ascending}`;
    }
  }
  return get<GammaEvent[]>(url);
}

/**
 * Eventos por slug, em lote. A chave é `events.event_group_slug`, que já é
 * gravada — não existe coluna para o id do evento na Gamma.
 *
 * As duas armadilhas de `fetchMarketsByIds` valem idênticas aqui, ambas
 * medidas em 2026-08-06 e ambas silenciosas:
 *
 * 1. Sem `limit` explícito, um lote de 50 slugs devolve 20.
 * 2. O filtro aplica `closed=false` por padrão — daí `closed` ser obrigatório.
 *
 * O teto por chamada é 100: com 200 slugs a Gamma responde 422.
 */
export async function fetchEventsBySlugs(
  slugs: readonly string[],
  opts: { closed: boolean },
): Promise<GammaEvent[]> {
  if (slugs.length === 0) return [];
  if (slugs.length > MAX_EVENTS_PER_REQUEST) {
    throw new Error(
      `fetchEventsBySlugs: ${slugs.length} slugs excede o máximo de ${MAX_EVENTS_PER_REQUEST}`,
    );
  }

  const query = slugs.map(slug => `slug=${encodeURIComponent(slug)}`).join('&');
  const url = `${GAMMA_URL}/events?limit=${slugs.length}&closed=${opts.closed}&${query}`;
  return get<GammaEvent[]>(url);
}

/**
 * @deprecated Gamma API ignores negRiskMarketID as a server-side filter — returns the full
 * paginated universe instead. Use DB aggregation (events table) for group size checks.
 */
export async function fetchMarketsByNegRiskId(negRiskMarketId: string): Promise<GammaMarket[]> {
  const all: GammaMarket[] = [];
  const limit = 500;
  let offset = 0;

  while (true) {
    const url = `${GAMMA_URL}/markets?negRiskMarketID=${encodeURIComponent(negRiskMarketId)}&limit=${limit}&offset=${offset}`;
    const page = await get<GammaMarket[]>(url);
    all.push(...page);
    if (page.length < limit) break;
    offset += limit;
  }

  return all;
}

// Reserved for detectors that need deep orderbook data (not used in normal collection)
export async function fetchOrderbook(tokenId: string): Promise<ClobOrderbook> {
  return get<ClobOrderbook>(`${CLOB_URL}/book?token_id=${tokenId}`);
}
