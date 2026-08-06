import { supabase } from '../../lib/supabase.js';
import { UNKNOWN_ROLE } from '../market-role.js';
import type { ContextFragment, Enricher, EnricherContext } from '../enricher.js';

/**
 * `market-history` — o enricher que valida o contrato inteiro sem depender de
 * integração externa nenhuma (spec 001, item 5 / Parte D).
 *
 * Lê `esports_snapshots`, a tabela particionada da spec 000 — e NÃO
 * `polymarket_snapshots`. A distinção não é detalhe de nome: a retenção geral
 * apaga `polymarket_snapshots` por idade e, no ramo `finalized`, sem nenhuma
 * condição de idade, poucas horas depois de a partida resolver. A série que
 * sobrevive é a da tabela particionada, e é dela que qualquer backtest vai ler.
 *
 * ## Por que ele é point-in-time por construção
 *
 * Toda leitura aqui é `captured_at <= asOf`. A tabela é série temporal
 * append-only: a linha das 14h continua sendo a linha das 14h depois de a
 * partida acabar. Não há estado atual a vazar porque não há estado atual — só
 * observações datadas. É o oposto de uma fonte que responde "o roster é X" e
 * obriga a acreditar que era X naquele dia.
 *
 * ## O que ele produz, e por que em três fragmentos
 *
 *   `odds`               — movimento de preço da série nas janelas antes de asOf
 *   `liquidity`          — liquidez e spread, nas mesmas âncoras
 *   `series_consistency` — só em BO3/BO5: o preço da série contra o implícito
 *                          pelos `child_moneyline` irmãos
 *
 * Separados porque são três perguntas, e um consumidor pode querer só uma. O
 * `kind` é o que permite pedir uma sem pagar as outras.
 *
 * ## O que ele deliberadamente NÃO cobre
 *
 * Só o moneyline da série entra como fonte de preço. Os mercados derivados
 * (`totals`, `map_handicap`, `kill_over_under_game`) ficam de fora: são dezenas
 * por partida, cada um com semântica própria, e transformá-los em fragmento
 * multiplicaria o volume da tabela por algo que ninguém pediu ainda. Os
 * `child_moneyline` entram, mas só como insumo da consistência — não geram
 * fragmento próprio.
 */

export const MARKET_HISTORY_ID = 'market-history';

/**
 * Vale para toda vertical de esports: a fonte é a nossa própria série de preço,
 * que não sabe de qual jogo é. Espelha o seed de `verticals` na migration
 * 20260806183705 — vertical nova entra aqui junto com a linha de lá.
 */
const MARKET_HISTORY_VERTICALS = ['cs2', 'lol', 'dota2'];

/** As janelas da spec: "movimento de preço nas últimas 24h / 6h / 1h". */
export const PRICE_WINDOWS = [
  { key: '1h', seconds: 3_600 },
  { key: '6h', seconds: 21_600 },
  { key: '24h', seconds: 86_400 },
] as const;

export type WindowKey = (typeof PRICE_WINDOWS)[number]['key'];

/**
 * Quão velho um snapshot pode ser e ainda valer como "o preço agora".
 *
 * A watchlist coleta entre 12s e 300s conforme a faixa, e o coletor geral a cada
 * 180s. Uma hora sem nada não é atraso de coleta, é mercado que parou de ser
 * coletado — e chamar aquele preço de "atual" seria a única invenção possível
 * neste arquivo. Sem snapshot dentro da janela, o enricher não produz fragmento.
 */
export const NOW_TOLERANCE_SECONDS = 3_600;

/**
 * Quanto um snapshot pode estar atrás da âncora e ainda representá-la.
 *
 * Proporcional à janela, com piso: pedir "o preço de 1h atrás" e receber um de
 * 3h atrás seria rotular errado. Um quarto da janela mantém o erro dentro da
 * ordem de grandeza da própria medida, e o payload registra o `captured_at` real
 * e o atraso de cada âncora — quem lê nunca precisa confiar na etiqueta.
 */
export function anchorToleranceSeconds(windowSeconds: number): number {
  return Math.max(Math.round(windowSeconds / 4), 900);
}

// ---------------------------------------------------------------------------
// Tipos
// ---------------------------------------------------------------------------

export interface AnchorSnapshot {
  capturedAt: string;
  midPrice: number | null;
  bestBid: number | null;
  bestAsk: number | null;
  liquidity: number | null;
  volume24h: number | null;
}

export interface ResolvedWindow {
  key: WindowKey;
  /** O instante pedido: `asOf - janela`. */
  target: string;
  /** `null` = nada dentro da tolerância. É ausência de dado, não zero. */
  snapshot: AnchorSnapshot | null;
}

export interface GamePrice {
  game: number;
  eventId: string;
  /** Preço do MESMO lado do time A da série. */
  mid: number;
  capturedAt: string;
}

export type BestOfSource = 'column' | 'inferred';

// ---------------------------------------------------------------------------
// Funções puras — a decisão e o texto, testáveis sem banco
// ---------------------------------------------------------------------------

export function spreadOf(snapshot: AnchorSnapshot): number | null {
  const { bestBid, bestAsk } = snapshot;
  return bestBid !== null && bestAsk !== null ? bestAsk - bestBid : null;
}

function ageSeconds(capturedAt: string, target: string): number {
  return Math.round((new Date(target).getTime() - new Date(capturedAt).getTime()) / 1000);
}

/** Preço em três casas: a coluna é `numeric(6,4)` e o mercado vive em [0,1]. */
function price(value: number): string {
  return value.toFixed(3);
}

/** Delta de preço em pontos percentuais, que é como se fala de movimento aqui. */
function pp(delta: number): string {
  const points = delta * 100;
  const sign = points > 0 ? '+' : points < 0 ? '−' : '';
  return `${sign}${Math.abs(points).toFixed(1)} pp`;
}

/**
 * Dinheiro em escala compacta e com ponto decimal fixo.
 *
 * Sem `toLocaleString`: o separador dele depende do ICU do runtime, e o `summary`
 * é texto gravado no banco — não pode mudar de forma porque o processo subiu em
 * outra imagem.
 */
export function formatUsd(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1_000_000) return `US$ ${(value / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `US$ ${(value / 1_000).toFixed(1)}k`;
  return `US$ ${Math.round(value)}`;
}

/**
 * O número do game a partir do sufixo do slug.
 *
 * Só `gameN` puro. `game1-total-rounds` não é o moneyline do game 1 — é um
 * derivado dele, e tratá-lo como preço do game envenenaria a consistência.
 *
 * `sports_market_type` é autoritativo quando existe (Parte B da spec): sufixo
 * `gameN` com papel declarado que não seja `child_moneyline` é veto, não dúvida.
 * O papel `unknown` passa porque é o do histórico sem a coluna, onde o sufixo é
 * a única evidência que existe — e ele é determinístico.
 */
export function gameNumberOf(suffix: string | null, role: string): number | null {
  if (suffix === null) return null;

  const match = /^game(\d+)$/.exec(suffix);
  if (!match?.[1]) return null;

  if (role !== 'child_moneyline' && role !== UNKNOWN_ROLE) return null;

  const n = Number(match[1]);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * `best_of` da coluna quando existe; inferido do conjunto de games quando não.
 *
 * A inferência existe porque hoje `esports_matches.best_of` é null para TODA
 * partida, e não por falha do resolver: `gammaEventMetadata` exclui `score` de
 * propósito (é estado ao vivo numa coluna que é sobrescrita a cada ciclo), e
 * `score` era a fonte do `Bo{N}`. Sem inferir, este fragmento seria código morto
 * até alguém mudar a coleta.
 *
 * Regras da inferência, e elas são estreitas de propósito:
 *
 *   - o conjunto de games tem que ser exatamente {1..n}, sem buraco;
 *   - n tem que ser 3 ou 5, que são os formatos reais. Um n = 2 ou 4 é listagem
 *     parcial de um BO3/BO5, não um formato — e inferir dali daria um número
 *     errado com cara de certo.
 *
 * O que a inferência NÃO consegue distinguir, e por isso vai marcado no payload
 * e rebaixa a confiança: um BO5 cujos markets de game 4 e 5 ainda não foram
 * listados é indistinguível de um BO3. O erro existe, é conhecido, e quem lê o
 * fragmento vê `best_of_source: 'inferred'` antes de acreditar no número.
 */
export function resolveBestOf(
  columnBestOf: number | null,
  gameNumbers: readonly number[],
): { bestOf: number; source: BestOfSource } | null {
  const distinct = [...new Set(gameNumbers)].sort((a, b) => a - b);
  const max = distinct[distinct.length - 1] ?? 0;

  if (columnBestOf !== null && Number.isInteger(columnBestOf) && columnBestOf > 0) {
    // Coluna e markets se contradizendo: existe game 5 numa série declarada BO3.
    // Um dos dois está errado e não é aqui que se descobre qual. Calcular sobre
    // os três primeiros games devolveria um número plausível e sem sentido, que
    // é pior que não devolver número nenhum.
    if (max > columnBestOf) return null;
    return { bestOf: columnBestOf, source: 'column' };
  }

  if (distinct.length === 0) return null;

  if (max !== 3 && max !== 5) return null;
  if (distinct.length !== max) return null;
  if (distinct.some((n, i) => n !== i + 1)) return null;

  return { bestOf: max, source: 'inferred' };
}

/**
 * P(time A vence a série) implicada pelos preços de game, sob independência.
 *
 * Usa a identidade padrão de best-of-n: vencer a série equivale a vencer pelo
 * menos `floor(n/2) + 1` dos n games se todos fossem disputados. Vale mesmo com
 * a série encerrada cedo, e vale com `p` diferente por game — o que importa aqui,
 * porque game já decidido tem preço colado em 0 ou 1 e entra na conta como o
 * fato que é.
 *
 * **A independência é uma suposição, e é a única deste arquivo.** Séries de CS2
 * têm momentum, veto de mapa condicionado ao resultado anterior e troca de lado —
 * nada disso é independente. Por isso o número sai rotulado como modelo no
 * payload e a confiança do fragmento não é 1.0: os insumos são exatos, a
 * combinação deles não é.
 */
export function impliedSeriesProbability(
  gameProbs: readonly number[],
  bestOf: number,
): number | null {
  if (!Number.isInteger(bestOf) || bestOf < 1) return null;
  if (gameProbs.length !== bestOf) return null;
  if (gameProbs.some(p => !Number.isFinite(p) || p < 0 || p > 1)) return null;

  // Distribuição do número de vitórias do time A, acumulada game a game.
  let dist = [1];
  for (const p of gameProbs) {
    const next = new Array<number>(dist.length + 1).fill(0);
    for (let wins = 0; wins < dist.length; wins++) {
      const mass = dist[wins] as number;
      next[wins] = (next[wins] as number) + mass * (1 - p);
      next[wins + 1] = (next[wins + 1] as number) + mass * p;
    }
    dist = next;
  }

  const needed = Math.floor(bestOf / 2) + 1;
  return dist.slice(needed).reduce((sum, mass) => sum + mass, 0);
}

export interface PriceFragmentInput {
  eventId: string;
  slug: string | null;
  matchSlug: string | null;
  /** O rótulo de `outcomes.values` que corresponde ao time A. */
  teamLabel: string;
  now: AnchorSnapshot;
  windows: readonly ResolvedWindow[];
}

function windowPayload(
  window: ResolvedWindow,
  current: AnchorSnapshot,
): Record<string, unknown> {
  if (window.snapshot === null) {
    return { window: window.key, target: window.target, missing: true };
  }

  const past = window.snapshot;
  const currentSpread = spreadOf(current);
  const pastSpread = spreadOf(past);

  return {
    window: window.key,
    target: window.target,
    captured_at: past.capturedAt,
    // Distância entre a âncora pedida e o snapshot que a representa. Quem lê
    // decide se ela invalida a leitura; nós não escondemos o número.
    lag_seconds: ageSeconds(past.capturedAt, window.target),
    mid_price: past.midPrice,
    price_delta:
      current.midPrice !== null && past.midPrice !== null ? current.midPrice - past.midPrice : null,
    liquidity: past.liquidity,
    liquidity_delta:
      current.liquidity !== null && past.liquidity !== null
        ? current.liquidity - past.liquidity
        : null,
    spread: pastSpread,
    spread_delta:
      currentSpread !== null && pastSpread !== null ? currentSpread - pastSpread : null,
    volume_24h: past.volume24h,
  };
}

/**
 * Os dois fragmentos que saem das mesmas âncoras: preço e liquidez.
 *
 * `asOf` do fragmento é o `captured_at` do snapshot mais recente, e não o `asOf`
 * pedido pelo contexto. É a definição da coluna: quando o fato era verdade. O
 * preço foi 0.62 no instante em que o coletor o viu, não no instante em que nós
 * decidimos perguntar.
 */
export function buildPriceFragments(input: PriceFragmentInput): ContextFragment[] {
  const { now, windows, teamLabel } = input;
  const asOf = new Date(now.capturedAt);
  const fragments: ContextFragment[] = [];

  const base = {
    event_id: input.eventId,
    slug: input.slug,
    match_slug: input.matchSlug,
    outcome: teamLabel,
    captured_at: now.capturedAt,
  };

  const windowRows = windows.map(w => windowPayload(w, now));

  // --- preço ---------------------------------------------------------------
  if (now.midPrice !== null) {
    const moves = windows
      .map(w => {
        const past = w.snapshot;
        if (past?.midPrice == null || now.midPrice === null) return null;
        return `${pp(now.midPrice - past.midPrice)} em ${w.key}`;
      })
      .filter((s): s is string => s !== null);

    const book =
      now.bestBid !== null && now.bestAsk !== null
        ? ` (bid ${price(now.bestBid)} / ask ${price(now.bestAsk)})`
        : '';

    const movement =
      moves.length > 0
        ? ` Movimento: ${moves.join(', ')}.`
        : ' Sem série anterior dentro das janelas para medir movimento.';

    fragments.push({
      enricherId: MARKET_HISTORY_ID,
      kind: 'odds',
      asOf,
      payload: {
        ...base,
        mid_price: now.midPrice,
        best_bid: now.bestBid,
        best_ask: now.bestAsk,
        windows: windowRows,
      },
      summary: `Moneyline da série: ${teamLabel} em ${price(now.midPrice)}${book}.${movement}`,
      confidence: 1.0,
    });
  }

  // --- liquidez e spread ---------------------------------------------------
  const currentSpread = spreadOf(now);
  if (now.liquidity !== null || currentSpread !== null) {
    const parts: string[] = [];
    if (now.liquidity !== null) parts.push(`liquidez ${formatUsd(now.liquidity)}`);
    if (currentSpread !== null) parts.push(`spread ${price(currentSpread)}`);
    if (now.volume24h !== null) parts.push(`volume 24h ${formatUsd(now.volume24h)}`);

    const past24h = windows.find(w => w.key === '24h')?.snapshot ?? null;
    const trend: string[] = [];
    if (past24h !== null && now.liquidity !== null && past24h.liquidity !== null) {
      trend.push(`liquidez era ${formatUsd(past24h.liquidity)} em 24h`);
    }
    const pastSpread = past24h !== null ? spreadOf(past24h) : null;
    if (pastSpread !== null && currentSpread !== null) {
      trend.push(`spread era ${price(pastSpread)}`);
    }

    fragments.push({
      enricherId: MARKET_HISTORY_ID,
      kind: 'liquidity',
      asOf,
      payload: {
        ...base,
        liquidity: now.liquidity,
        spread: currentSpread,
        volume_24h: now.volume24h,
        windows: windowRows,
      },
      summary:
        `Book do moneyline da série: ${parts.join(', ')}.` +
        (trend.length > 0 ? ` Comparado a 24h atrás: ${trend.join('; ')}.` : ''),
      confidence: 1.0,
    });
  }

  return fragments;
}

export interface ConsistencyInput {
  eventId: string;
  matchSlug: string | null;
  teamLabel: string;
  bestOf: number;
  bestOfSource: BestOfSource;
  seriesMid: number;
  seriesCapturedAt: string;
  games: readonly GamePrice[];
}

/**
 * O fragmento de consistência série × games.
 *
 * `asOf` é o `captured_at` MAIS ANTIGO entre os insumos, e não o mais recente. A
 * afirmação é composta — "a série está em 0.62 enquanto os games estão em X, Y,
 * Z" — e ela só foi simultaneamente verdadeira até o instante do insumo mais
 * velho. Datar pelo mais novo alegaria que o game de 40 min atrás ainda valia
 * agora, que é precisamente o tipo de exagero que `as_of` existe para não
 * cometer. O payload traz o `captured_at` de cada perna e o atraso máximo.
 */
export function buildConsistencyFragment(input: ConsistencyInput): ContextFragment | null {
  const { bestOf, games, seriesMid, teamLabel } = input;

  const ordered = [...games].sort((a, b) => a.game - b.game);
  if (ordered.length !== bestOf) return null;

  const implied = impliedSeriesProbability(
    ordered.map(g => g.mid),
    bestOf,
  );
  if (implied === null) return null;

  const stamps = [input.seriesCapturedAt, ...ordered.map(g => g.capturedAt)];
  const times = stamps.map(s => new Date(s).getTime());
  const oldest = Math.min(...times);
  const newest = Math.max(...times);

  const divergence = seriesMid - implied;

  return {
    enricherId: MARKET_HISTORY_ID,
    kind: 'series_consistency',
    asOf: new Date(oldest),
    payload: {
      event_id: input.eventId,
      match_slug: input.matchSlug,
      outcome: teamLabel,
      best_of: bestOf,
      best_of_source: input.bestOfSource,
      series_mid: seriesMid,
      series_captured_at: input.seriesCapturedAt,
      implied_from_games: implied,
      divergence,
      // O rótulo do modelo fica no payload porque o número não é observação: é
      // leitura de observações sob uma hipótese que a própria modalidade viola.
      model: 'independent_games',
      max_staleness_seconds: Math.round((newest - oldest) / 1000),
      games: ordered.map(g => ({
        game: g.game,
        event_id: g.eventId,
        mid_price: g.mid,
        captured_at: g.capturedAt,
      })),
    },
    summary:
      `Série BO${bestOf}${input.bestOfSource === 'inferred' ? ' (best_of inferido dos markets de game)' : ''}: ` +
      `${teamLabel} em ${price(seriesMid)}; os games precificam ${ordered.map(g => price(g.mid)).join(' / ')}, ` +
      `o que implica ${price(implied)} para a série sob independência entre games. ` +
      `Divergência de ${pp(divergence)}.`,
    // Insumos exatos, combinação modelada. A independência entre games é falsa em
    // esports (momentum, veto de mapa, troca de lado) — o número é indicativo, e
    // a confiança diz isso. Com `best_of` inferido, cai mais: a inferência não
    // distingue BO5 com markets faltando de BO3.
    confidence: input.bestOfSource === 'column' ? 0.8 : 0.5,
  };
}

// ---------------------------------------------------------------------------
// Leitura
// ---------------------------------------------------------------------------

const COMPONENT = MARKET_HISTORY_ID;

function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim().length > 0) {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

interface LinkedMarket {
  eventId: string;
  role: string;
  suffix: string | null;
  outcomeAIndex: number | null;
  slug: string | null;
  teamLabel: string | null;
}

/**
 * O snapshot que representa um instante, ou `null`.
 *
 * O `gte` não é redundante com o `lte`: `esports_snapshots` é particionada por
 * dia, e um `captured_at <= T` sozinho autoriza o planejador a olhar toda
 * partição anterior a T. Com os dois lados, a consulta toca uma ou duas
 * partições e usa `idx_esports_snapshots_event_time` dentro delas.
 */
async function anchorAt(
  eventId: string,
  outcome: string,
  at: Date,
  toleranceSeconds: number,
): Promise<AnchorSnapshot | null> {
  const floor = new Date(at.getTime() - toleranceSeconds * 1000);

  const { data, error } = await supabase
    .from('esports_snapshots')
    .select('captured_at, best_bid, best_ask, mid_price, volume_24h, liquidity')
    .eq('event_id', eventId)
    .eq('outcome', outcome)
    .lte('captured_at', at.toISOString())
    .gte('captured_at', floor.toISOString())
    .order('captured_at', { ascending: false })
    .limit(1);

  if (error) {
    console.warn(`[${COMPONENT}] leitura de esports_snapshots falhou: ${error.message}`);
    return null;
  }

  const row = data?.[0];
  if (!row) return null;

  return {
    capturedAt: row['captured_at'] as string,
    midPrice: asNumber(row['mid_price']),
    bestBid: asNumber(row['best_bid']),
    bestAsk: asNumber(row['best_ask']),
    liquidity: asNumber(row['liquidity']),
    volume24h: asNumber(row['volume_24h']),
  };
}

async function loadLinkedMarkets(matchId: string): Promise<LinkedMarket[]> {
  const { data: links, error: linkError } = await supabase
    .from('market_match_links')
    .select('event_id, market_role, slug_suffix, outcome_a_index')
    .eq('match_id', matchId);

  if (linkError) {
    console.warn(`[${COMPONENT}] leitura de market_match_links falhou: ${linkError.message}`);
    return [];
  }

  const rows = links ?? [];
  if (rows.length === 0) return [];

  const { data: events, error: eventError } = await supabase
    .from('events')
    .select('id, slug, outcomes')
    .in(
      'id',
      rows.map(r => r['event_id'] as string),
    );

  if (eventError) {
    console.warn(`[${COMPONENT}] leitura de events falhou: ${eventError.message}`);
    return [];
  }

  const byId = new Map((events ?? []).map(e => [e['id'] as string, e] as const));

  return rows.map(row => {
    const eventId = row['event_id'] as string;
    const event = byId.get(eventId);
    const outcomeAIndex = row['outcome_a_index'] as number | null;
    const values = (event?.['outcomes'] as Record<string, unknown> | null)?.['values'];

    // O rótulo do time A vem de `outcomes.values[outcome_a_index]` porque é ele
    // que aparece em `esports_snapshots.outcome` — a série é gravada por rótulo,
    // não por índice (ver `buildSnapshotRows`). Sem índice resolvido não há como
    // saber qual lado é o time A, e adivinhar inverteria o sinal do movimento.
    const teamLabel =
      Array.isArray(values) && outcomeAIndex !== null && typeof values[outcomeAIndex] === 'string'
        ? (values[outcomeAIndex] as string)
        : null;

    return {
      eventId,
      role: (row['market_role'] as string | null) ?? UNKNOWN_ROLE,
      suffix: row['slug_suffix'] as string | null,
      outcomeAIndex,
      slug: (event?.['slug'] as string | null) ?? null,
      teamLabel,
    };
  });
}

async function fetchMarketHistory(ctx: EnricherContext): Promise<ContextFragment[]> {
  const markets = await loadLinkedMarkets(ctx.matchId);
  if (markets.length === 0) return [];

  const series = markets.find(m => m.role === 'moneyline' && m.teamLabel !== null);
  if (!series?.teamLabel) return [];

  const now = await anchorAt(series.eventId, series.teamLabel, ctx.asOf, NOW_TOLERANCE_SECONDS);
  if (now === null) return [];

  const { data: match } = await supabase
    .from('esports_matches')
    .select('match_slug, best_of')
    .eq('id', ctx.matchId)
    .maybeSingle();

  const matchSlug = (match?.['match_slug'] as string | null) ?? null;
  const columnBestOf = asNumber(match?.['best_of']);

  const windows: ResolvedWindow[] = [];
  for (const window of PRICE_WINDOWS) {
    const target = new Date(ctx.asOf.getTime() - window.seconds * 1000);
    windows.push({
      key: window.key,
      target: target.toISOString(),
      snapshot: await anchorAt(
        series.eventId,
        series.teamLabel,
        target,
        anchorToleranceSeconds(window.seconds),
      ),
    });
  }

  const fragments = buildPriceFragments({
    eventId: series.eventId,
    slug: series.slug,
    matchSlug,
    teamLabel: series.teamLabel,
    now,
    windows,
  });

  // --- consistência BO3/BO5 ------------------------------------------------
  const gameMarkets = markets
    .map(m => ({ market: m, game: gameNumberOf(m.suffix, m.role) }))
    .filter((g): g is { market: LinkedMarket; game: number } => g.game !== null);

  const format = resolveBestOf(
    columnBestOf,
    gameMarkets.map(g => g.game),
  );

  if (format !== null && format.bestOf >= 3 && now.midPrice !== null) {
    const games: GamePrice[] = [];

    for (const { market, game } of gameMarkets) {
      if (game > format.bestOf || market.teamLabel === null) continue;

      const snapshot = await anchorAt(
        market.eventId,
        market.teamLabel,
        ctx.asOf,
        NOW_TOLERANCE_SECONDS,
      );
      if (snapshot?.midPrice == null) continue;

      games.push({
        game,
        eventId: market.eventId,
        mid: snapshot.midPrice,
        capturedAt: snapshot.capturedAt,
      });
    }

    // `buildConsistencyFragment` devolve null quando falta preço de algum game.
    // É o comportamento certo: completar o conjunto com a média dos conhecidos
    // seria inventar o preço que o mercado não deu.
    const consistency = buildConsistencyFragment({
      eventId: series.eventId,
      matchSlug,
      teamLabel: series.teamLabel,
      bestOf: format.bestOf,
      bestOfSource: format.source,
      seriesMid: now.midPrice,
      seriesCapturedAt: now.capturedAt,
      games,
    });

    if (consistency !== null) fragments.push(consistency);
  }

  return fragments;
}

export const marketHistoryEnricher: Enricher = {
  id: MARKET_HISTORY_ID,
  verticals: MARKET_HISTORY_VERTICALS,
  /** A faixa mais lenta da watchlist. Mais rápido que isso repetiria o mesmo snapshot. */
  ttlSeconds: 300,
  supportsPointInTime: true,
  fetch: fetchMarketHistory,
};
