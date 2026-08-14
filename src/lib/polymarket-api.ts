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

// ---------------------------------------------------------------------------
// O universo do radar: por TAG, e não por varredura de calendário
// ---------------------------------------------------------------------------

/**
 * O id numérico de uma tag, a partir do slug.
 *
 * Existe porque `/markets` só entende `tag_id`. Medido em 2026-08-13:
 * `tag_slug=ai` em `/markets` devolve 200 e a MESMA página que a chamada sem
 * filtro nenhum — o parâmetro é ignorado em silêncio, e um coletor que
 * acreditasse nele vigiaria a lista inteira do Polymarket achando que estava
 * lendo só IA. Em `/events` o `tag_slug` funciona; são endpoints diferentes.
 *
 * `null` quando a tag não existe. O chamador decide se isso é bug de config ou
 * tag renomeada — aqui não dá para saber.
 */
export async function fetchTagIdBySlug(slug: string): Promise<string | null> {
  try {
    const tag = await get<{ id?: string | number } | null>(
      `${GAMMA_URL}/tags/slug/${encodeURIComponent(slug)}`,
    );
    const id = tag?.id;
    return id == null ? null : String(id);
  } catch (err) {
    if (err instanceof GammaHttpError && err.status === 404) return null;
    throw err;
  }
}

/**
 * Uma página de markets de uma tag, dentro de uma janela de prazo.
 *
 * Quatro parâmetros do servidor fazem o trabalho pesado, e a diferença entre
 * eles importa (medido em 2026-08-13):
 *
 *   `tag_id`             funciona. É o recorte de CATEGORIA.
 *   `end_date_min/max`   funcionam, inclusive em `/events`.
 *   `liquidity_num_min`  funciona.
 *   `volume_24hr_min`    NÃO funciona — aceito e ignorado. 63 dos 100 markets
 *                        da primeira página voltaram abaixo do piso pedido.
 *
 * `orderByLiquidity` é o que torna a paginação BARATA e CORRETA ao mesmo tempo,
 * e sem ele o coletor estava errado dos dois jeitos. Sem ordenação, quatro das
 * doze tags do radar saturam o teto de offset 2000 (crypto, elections, politics
 * e sports devolvem 2100 markets na janela de 180 dias): o universo vinha
 * truncado numa ordem que a Gamma não promete, então o corte por liquidez era
 * feito sobre meia lista. E custava 155 chamadas / 107 MB por renovação.
 *
 * Com `order=liquidityNum&ascending=false` a ordem é monotônica DENTRO e ENTRE
 * páginas (medido: página 1 termina em 36.446 e a 2 começa em 35.365), então
 * quem quer os N maiores de uma tag lê ceil(N/100) páginas e prova que não
 * perdeu nada. `order=liquidity` NÃO serve: ordena pela coluna texto e sai não
 * monotônica.
 *
 * `limit` satura em 100 — pedir 500 devolve 100, sem erro.
 */
export async function fetchMarketsByTag(params: {
  tagId: string;
  endDateMin: string;
  endDateMax: string;
  minLiquidity?: number;
  limit?: number;
  offset?: number;
  orderByLiquidity?: boolean;
}): Promise<GammaMarket[]> {
  const {
    tagId,
    endDateMin,
    endDateMax,
    minLiquidity,
    limit = 100,
    offset = 0,
    orderByLiquidity = true,
  } = params;

  const query = new URLSearchParams({
    closed: 'false',
    active: 'true',
    archived: 'false',
    tag_id: tagId,
    end_date_min: endDateMin,
    end_date_max: endDateMax,
    limit: String(limit),
    offset: String(offset),
  });
  if (minLiquidity !== undefined) query.set('liquidity_num_min', String(minLiquidity));
  if (orderByLiquidity) {
    query.set('order', 'liquidityNum');
    query.set('ascending', 'false');
  }

  return get<GammaMarket[]>(`${GAMMA_URL}/markets?${query.toString()}`);
}

/**
 * Teto de tokens por chamada ao `POST /books`.
 *
 * Medido em 2026-08-13, todos 200 e com a lista completa de volta:
 *
 *    50 tokens ->  173 KB, 352ms
 *   100 tokens ->  342 KB, 457ms
 *   200 tokens ->  642 KB, 668ms
 *   300 tokens ->  916 KB, 636ms
 *   500 tokens -> 1284 KB, 850ms
 *
 * Ou seja: o custo por token CAI com o lote (3,5 KB/token a 50, 2,6 KB a 500) e
 * o limite não foi encontrado. 250 é metade do maior valor confirmado — margem
 * deliberada, porque um limite não documentado pode mudar sem aviso e o preço
 * de errar aqui é o ciclo inteiro sem foto. Com ele, 300 mercados custam 2
 * chamadas em vez de 6.
 */
export const MAX_TOKENS_PER_BOOK_REQUEST = 250;

/**
 * Os livros de vários tokens numa requisição só.
 *
 * O que o `GET /book` faz para um token, este faz para 50 — e é a diferença
 * entre 150 requisições por foto e 3. O corpo é a lista de `{token_id}`; a
 * resposta vem na mesma forma de `ClobOrderbook`, com `asset_id` para reparear.
 *
 * Ordenação dos níveis, medida e contra-intuitiva: `bids` vem CRESCENTE e `asks`
 * DECRESCENTE — o melhor de cada lado é o ÚLTIMO elemento. Ler o primeiro
 * inverte o spread inteiro sem dar erro (ver `bestLevels`).
 */
export async function fetchBooks(tokenIds: readonly string[]): Promise<ClobOrderbook[]> {
  if (tokenIds.length === 0) return [];
  if (tokenIds.length > MAX_TOKENS_PER_BOOK_REQUEST) {
    throw new Error(
      `fetchBooks: ${tokenIds.length} tokens excede o máximo de ${MAX_TOKENS_PER_BOOK_REQUEST}`,
    );
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const res = await fetch(`${CLOB_URL}/books`, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify(tokenIds.map(id => ({ token_id: id }))),
      signal: controller.signal,
    });
    if (!res.ok) throw new GammaHttpError(res.status, `${CLOB_URL}/books`);
    return (await res.json()) as ClobOrderbook[];
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error(`Timeout after ${FETCH_TIMEOUT_MS}ms fetching ${CLOB_URL}/books`);
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
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
