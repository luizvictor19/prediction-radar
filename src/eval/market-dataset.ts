import { supabase } from '../lib/supabase.js';

/**
 * O dataset MARKET-CÊNTRICO: uma linha por (partida, checkpoint), sem agente.
 *
 * Existe ao lado de `dataset.ts` e não dentro dele, de propósito. O dataset de
 * análises responde "o agente presta?" e cresce no ritmo do analista — cada
 * ponto custa uma chamada de modelo. Este responde "o PREÇO erra em alguma
 * faixa?" e cresce no ritmo do calendário de CS2, que é ~39 partidas por dia.
 * São perguntas diferentes com denominadores diferentes; misturá-las numa
 * amostra só faria as duas mentirem — a calibração do mercado herdaria o
 * tamanho da amostra do analista, e o eval do analista herdaria linhas em que
 * nenhum agente opinou.
 *
 * O que se mede aqui não precisa de modelo nenhum: `(preço, desfecho)`. Se o
 * preço erra de forma sistemática e consistente numa faixa, o edge é mecânico —
 * declarável a partir do preço, que é observável antes do desfecho.
 *
 * SÓ LEITURA. Nenhum INSERT, UPDATE, DELETE ou DDL, nenhuma chamada de API paga.
 *
 * ## Custo no banco (leia antes de rodar)
 *
 * `esports_snapshots` é particionada por dia e tem um índice só,
 * `idx_esports_snapshots_event_time (event_id, captured_at desc)`. Toda leitura
 * de série aqui é UMA consulta por (partida, checkpoint), sempre com `event_id`
 * E os dois lados de `captured_at` — a janela é de ±`TOLERANCE_SECONDS` em
 * torno do instante alvo, nunca mais que isso. O piso não é redundante com o
 * teto: sem ele o planejador fica autorizado a varrer toda partição anterior.
 * Mesmo padrão de `probe-live-reversion.ts`.
 *
 * `polymarket_snapshots` (a sonda histórica) não é particionada, mas tem
 * `idx_snapshots_event_time (event_id, captured_at desc)` — mesma disciplina,
 * mesma razão.
 */

const LABEL = 'market-dataset';

// ---------------------------------------------------------------------------
// Constantes que NÃO são flag, e por que não são
// ---------------------------------------------------------------------------

const VERTICAL = 'cs2';

/**
 * Os mesmos checkpoints do analista (`analyst_checkpoints_minutes`).
 *
 * Fixos e iguais aos dele para os números serem comparáveis com o resto do eval:
 * uma calibração de mercado medida em T-90 não conversa com um Brier de agente
 * medido em T-60, e a comparação entre os dois é o ponto de ter as duas coisas.
 */
export const CHECKPOINTS: readonly number[] = [360, 60];

/**
 * Nascimento de `esports_snapshots` (migration 20260805142957).
 *
 * Antes dessa data a série de esports estava em `polymarket_snapshots`, de onde
 * a retenção antiga apagava a série de evento resolvido SEM condição de idade
 * (ver 20260806032316). Quanto sobrou disso não é suposição neste arquivo: é
 * `probeLegacyCoverage`, que mede.
 */
export const SERIES_START = '2026-08-05';

/**
 * Tolerância para casar o instante alvo com um snapshot, em segundos.
 *
 * 300s = um ciclo inteiro da cadência mais LENTA de pré-jogo
 * (`watchlist_interval_far_seconds`, 300s, usada a mais de 360 min do início).
 * Assim um ciclo perdido ainda produz linha e dois ciclos perdidos seguidos não
 * produzem: a linha some por falta de coleta, não por azar de arredondamento.
 * Em T-60 a cadência é de 60s (`watchlist_interval_soon_seconds`) e a tolerância
 * quase nunca é o que decide.
 *
 * SEM INTERPOLAÇÃO entre vizinhos, e isso é método e não preguiça: falta de
 * snapshot é sintoma de coletor tropeçando ou de mercado sem book — estados
 * correlacionados com o que se quer medir. Interpolar inventaria preço liso
 * exatamente onde o real foi um degrau. Sem snapshot na tolerância, a linha é
 * DESCARTADA e CONTADA.
 */
export const TOLERANCE_SECONDS = 300;

/**
 * Teto de linhas por consulta de janela.
 *
 * A janela é de 2 × 300s e a cadência mínima é de 12s ao vivo — o pior caso cabe
 * em ~50 linhas. 500 é folga de uma ordem de grandeza; se alguma consulta bater
 * no teto, o contador `janelasTruncadas` reporta, porque uma janela truncada
 * pela borda esquerda enviesaria a escolha do vizinho mais próximo.
 */
const WINDOW_ROW_LIMIT = 500;

/** `range()` do PostgREST nas tabelas pequenas do universo. */
const PAGE = 1000;

/** `in(...)` vira query string; lote grande estoura o limite de URL do PostgREST. */
const IN_CHUNK = 200;

/**
 * Janela da sonda histórica em torno de `scheduled_at`, em horas para cada lado.
 *
 * Só serve para responder "existe ALGUM preço recuperável desta partida", então
 * é larga o bastante para conter os dois checkpoints (o mais antigo é −6h) com
 * margem, e estreita o bastante para continuar sendo uma faixa indexada de um
 * `event_id` só.
 */
const LEGACY_WINDOW_HOURS = 12;

// ---------------------------------------------------------------------------
// Tipos
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;

interface PageResult {
  data: unknown;
  error: { message: string } | null;
}

/**
 * Uma linha do dataset: o preço de um mercado num instante, e o que aconteceu.
 *
 * Satisfaz `CalibratablePoint` (`matchSlug` + `outcome`), que é o que a máquina
 * de baldes do eval exige — e nada além disso é fingido aqui. Não há
 * `probability`, não há `promptVersion`: nenhum agente participou desta linha.
 */
export interface MarketPoint {
  matchId: string;
  /** A unidade independente da amostra. Dois checkpoints da mesma partida são UMA. */
  matchSlug: string;
  eventId: string;
  checkpointMinutes: number;
  /** ISO. Define a metade temporal a que a partida pertence. */
  scheduledAt: string;
  /** De onde veio o horário acima. Ver `AnchorSource`. */
  anchorSource: AnchorSource;
  /** `scheduled_at − checkpoint`. O instante que se pediu. */
  targetAt: string;
  /** `captured_at` do snapshot que respondeu. */
  capturedAt: string;
  /** Distância entre os dois, com sinal: negativo = snapshot antes do alvo. */
  offsetSeconds: number;
  /** `mid_price` do lado do time A. É a previsão que está sendo pontuada. */
  price: number;
  /**
   * `best_ask − best_bid` no instante, ou `null` sem os dois lados do book.
   *
   * Não entra em métrica de acerto nenhuma: define a BARRA. Um gap de 0,01 num
   * mercado de spread 0,04 é acerto de medição e prejuízo de execução.
   */
  spread: number | null;
  /** 1 = o time A venceu. */
  outcome: 0 | 1;
}

/** O previsor deste dataset é o próprio preço. Não há outro. */
export const PRICE = (point: MarketPoint): number | null => point.price;

/** Por que uma partida resolvida não vira linha. Toda saída é contada. */
export type MarketDiscardReason =
  /** `scheduled_at` anterior a `SERIES_START` — série fora de `esports_snapshots`. */
  | 'anterior_a_serie'
  /** Sem `team_a_id`: com o lado A nulo, "o time A venceu" sairia sempre 0. */
  | 'sem_time_a'
  /**
   * Nem `esports_matches.scheduled_at` nem `events.game_start_time`.
   *
   * Sem âncora não há `scheduled_at − checkpoint`, e portanto não há instante a
   * pedir. Não é o mesmo que "sem preço": é sem a pergunta.
   */
  | 'sem_ancora'
  /** Nenhum `market_match_links` com `market_role = 'moneyline'`. */
  | 'sem_moneyline'
  /** Estado B do resolver: `outcome_a_index` ainda nulo. */
  | 'sem_outcome_a_index'
  /** O `event_id` do link não está mais em `events`. */
  | 'evento_ausente'
  /** `outcomes.values[outcome_a_index]` não é string — não há rótulo do lado A. */
  | 'rotulo_nao_resolvido';

export type MarketDiscardCounts = Record<MarketDiscardReason, number>;

function emptyDiscards(): MarketDiscardCounts {
  return {
    anterior_a_serie: 0,
    sem_time_a: 0,
    sem_ancora: 0,
    sem_moneyline: 0,
    sem_outcome_a_index: 0,
    evento_ausente: 0,
    rotulo_nao_resolvido: 0,
  };
}

/**
 * De onde saiu o horário da partida.
 *
 * Os dois são o MESMO relógio, e é isso que autoriza o fallback:
 * `esports_matches.scheduled_at` é gravado a partir de `events.game_start_time`
 * pelo resolver (ver `resolver.ts`, `scheduledAt: row.game_start_time`). Partida
 * com `scheduled_at` nulo é partida que resolveu quando o evento ainda não tinha
 * o carimbo — e o carimbo chegou depois, no evento, sem que ninguém reescrevesse
 * a partida. Ler o `events` de novo não é inventar horário, é ler a fonte.
 *
 * Impresso no relatório mesmo assim: se a amostra passar a depender do fallback,
 * quem lê tem que poder ver isso sem ir ao código.
 */
export type AnchorSource = 'scheduled_at' | 'game_start_time';

export interface UniverseMatch {
  matchId: string;
  matchSlug: string;
  eventId: string;
  /** O rótulo do time A como aparece em `esports_snapshots.outcome`. */
  teamLabel: string;
  outcome: 0 | 1;
  scheduledAt: Date;
  anchorSource: AnchorSource;
}

/**
 * Partida resolvida, com moneyline e rótulo, e SEM horário em lugar nenhum.
 *
 * Não vira linha nunca — sem âncora não há instante a pedir. Mas continua sendo
 * uma pergunta legítima e barata: sobrou série do mercado dela? A resposta
 * decide se o que falta para essas 1,7k partidas é um backfill de horário (caro,
 * mas possível) ou nada (e aí não há o que recuperar).
 */
export interface AnchorlessMatch {
  matchId: string;
  matchSlug: string;
  eventId: string;
  teamLabel: string;
  outcome: 0 | 1;
}

export interface MarketUniverse {
  matches: UniverseMatch[];
  /** Partidas cs2 resolvidas lidas de `esports_matches`, antes de qualquer corte. */
  resolvedRead: number;
  /** Resolvidas com `scheduled_at` anterior a `SERIES_START`. A sonda histórica. */
  legacy: UniverseMatch[];
  /** Resolvidas, ligadas e sem horário. Ver `AnchorlessMatch`. */
  anchorless: AnchorlessMatch[];
  discards: MarketDiscardCounts;
  /** Partidas com mais de um moneyline — escolhido o menor `event_id`. */
  duplicateMoneyline: number;
}

/** Linhas perdidas na leitura da série, por checkpoint. */
export interface CoverageCounts {
  /** Alvo sem nenhum snapshot dentro da tolerância. A linha some — e é contada. */
  semSnapshotNaTolerancia: number;
  /** Havia snapshot, mas sem `mid_price`. Também não vira linha. */
  semMid: number;
  /** Consultas que bateram em `WINDOW_ROW_LIMIT`. Deveria ser zero. */
  janelasTruncadas: number;
}

export interface MarketDataset {
  points: MarketPoint[];
  universe: MarketUniverse;
  /** Chave: minutos do checkpoint. */
  coverage: Map<number, CoverageCounts>;
  snapshotsRead: number;
  /** Consultas feitas a `esports_snapshots`. Uma por (partida, checkpoint). */
  queries: number;
}

// ---------------------------------------------------------------------------
// Utilidades de leitura
// ---------------------------------------------------------------------------

async function paginate(
  page: (from: number, to: number) => PromiseLike<PageResult>,
): Promise<Row[]> {
  const rows: Row[] = [];

  for (let offset = 0; ; offset += PAGE) {
    const { data, error } = await page(offset, offset + PAGE - 1);
    if (error) throw new Error(error.message);

    const batch = (data ?? []) as Row[];
    rows.push(...batch);
    if (batch.length < PAGE) return rows;
  }
}

function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** `numeric` do Postgres chega como string; `Number(null)` seria um preço de 0. */
function asNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

// ---------------------------------------------------------------------------
// O universo
// ---------------------------------------------------------------------------

/**
 * Partidas cs2 resolvidas, com moneyline ligado e rótulo do lado A resolvido.
 *
 * Três tabelas pequenas, três consultas — nada aqui toca série.
 *
 * O rótulo do time A sai de `events.outcomes.values[outcome_a_index]` porque é
 * ELE que aparece em `esports_snapshots.outcome`: a série é gravada por rótulo,
 * não por índice, e markets irmãos aparecem com os outcomes em ordens
 * diferentes (medido: 19 de 79 eventos). Adivinhar o lado aqui inverteria o
 * preço e o desfecho ao mesmo tempo, produzindo uma tabela de calibração
 * perfeitamente coerente e completamente errada.
 */
export async function loadMarketUniverse(): Promise<MarketUniverse> {
  const matchRows = await paginate((from, to) =>
    supabase
      .from('esports_matches')
      .select('id, match_slug, team_a_id, winner_team_id, scheduled_at')
      .eq('vertical_id', VERTICAL)
      .not('winner_team_id', 'is', null)
      .order('scheduled_at', { ascending: true })
      .range(from, to),
  );

  const discards = emptyDiscards();

  interface Candidate {
    matchId: string;
    matchSlug: string;
    outcome: 0 | 1;
    /** `null` aqui não é descarte ainda: o horário pode vir do evento. */
    scheduledAt: Date | null;
  }

  const candidates = new Map<string, Candidate>();
  const seriesStartMs = new Date(`${SERIES_START}T00:00:00.000Z`).getTime();

  for (const row of matchRows) {
    const teamAId = asString(row['team_a_id']);
    const winnerId = asString(row['winner_team_id']);
    const scheduled = asString(row['scheduled_at']);
    const scheduledAt = scheduled === null ? null : new Date(scheduled);

    if (teamAId === null) {
      discards.sem_time_a += 1;
      continue;
    }

    candidates.set(row['id'] as string, {
      matchId: row['id'] as string,
      matchSlug: asString(row['match_slug']) ?? '(sem slug)',
      outcome: winnerId === teamAId ? 1 : 0,
      scheduledAt:
        scheduledAt !== null && Number.isFinite(scheduledAt.getTime()) ? scheduledAt : null,
    });
  }

  // --- o moneyline de cada partida ------------------------------------------

  interface Link {
    eventId: string;
    outcomeAIndex: number | null;
  }

  const linkByMatch = new Map<string, Link>();
  const seenTwice = new Set<string>();

  for (const chunk of chunks([...candidates.keys()], IN_CHUNK)) {
    const { data, error } = await supabase
      .from('market_match_links')
      .select('match_id, event_id, outcome_a_index')
      .in('match_id', chunk)
      .eq('market_role', 'moneyline');

    if (error) throw new Error(`leitura de market_match_links falhou: ${error.message}`);

    for (const row of (data ?? []) as Row[]) {
      const matchId = row['match_id'] as string;
      const eventId = row['event_id'] as string;
      const current = linkByMatch.get(matchId);

      // Mais de um moneyline para a mesma partida é anomalia conhecida. Escolha
      // determinística pelo menor `event_id`, igual a `probe-live-reversion` e
      // `match-history`: o número do relatório não pode depender de qual linha o
      // Postgres devolveu primeiro.
      if (current === undefined) {
        linkByMatch.set(matchId, { eventId, outcomeAIndex: asNumber(row['outcome_a_index']) });
        continue;
      }

      seenTwice.add(matchId);
      if (eventId < current.eventId) {
        linkByMatch.set(matchId, { eventId, outcomeAIndex: asNumber(row['outcome_a_index']) });
      }
    }
  }

  // --- o rótulo do lado A ----------------------------------------------------

  const eventIds = [...new Set([...linkByMatch.values()].map((link) => link.eventId))];
  const outcomesById = new Map<string, unknown[]>();
  const gameStartById = new Map<string, Date>();

  for (const chunk of chunks(eventIds, IN_CHUNK)) {
    // `in('id', ...)` é sondagem de PK, nunca varredura — é a única forma de
    // tocar `events` (711 MB, 551k linhas) sem virar incidente.
    const { data, error } = await supabase
      .from('events')
      .select('id, outcomes, game_start_time')
      .in('id', chunk);
    if (error) throw new Error(`leitura de events falhou: ${error.message}`);

    for (const row of (data ?? []) as Row[]) {
      const values = (row['outcomes'] as Record<string, unknown> | null)?.['values'];
      if (Array.isArray(values)) outcomesById.set(row['id'] as string, values);

      const start = asString(row['game_start_time']);
      if (start === null) continue;
      const at = new Date(start);
      if (Number.isFinite(at.getTime())) gameStartById.set(row['id'] as string, at);
    }
  }

  const matches: UniverseMatch[] = [];
  const legacy: UniverseMatch[] = [];
  const anchorless: AnchorlessMatch[] = [];

  for (const candidate of candidates.values()) {
    const link = linkByMatch.get(candidate.matchId);
    if (link === undefined) {
      discards.sem_moneyline += 1;
      continue;
    }
    if (link.outcomeAIndex === null) {
      discards.sem_outcome_a_index += 1;
      continue;
    }

    const values = outcomesById.get(link.eventId);
    if (values === undefined) {
      discards.evento_ausente += 1;
      continue;
    }

    const teamLabel = values[link.outcomeAIndex];
    if (typeof teamLabel !== 'string' || teamLabel.length === 0) {
      discards.rotulo_nao_resolvido += 1;
      continue;
    }

    const fallback = gameStartById.get(link.eventId) ?? null;
    const scheduledAt = candidate.scheduledAt ?? fallback;
    if (scheduledAt === null) {
      discards.sem_ancora += 1;
      anchorless.push({
        matchId: candidate.matchId,
        matchSlug: candidate.matchSlug,
        eventId: link.eventId,
        teamLabel,
        outcome: candidate.outcome,
      });
      continue;
    }

    const match: UniverseMatch = {
      matchId: candidate.matchId,
      matchSlug: candidate.matchSlug,
      eventId: link.eventId,
      teamLabel,
      outcome: candidate.outcome,
      scheduledAt,
      anchorSource: candidate.scheduledAt === null ? 'game_start_time' : 'scheduled_at',
    };

    // A partida velha não some da contabilidade: sai do dataset (a série dela não
    // está em `esports_snapshots`) e vai para a sonda histórica, que é quem
    // decide se ela é recuperável ou não.
    if (scheduledAt.getTime() < seriesStartMs) {
      discards.anterior_a_serie += 1;
      legacy.push(match);
      continue;
    }

    matches.push(match);
  }

  return {
    matches,
    resolvedRead: matchRows.length,
    legacy,
    anchorless,
    discards,
    duplicateMoneyline: seenTwice.size,
  };
}

// ---------------------------------------------------------------------------
// A série, e a escolha do snapshot
// ---------------------------------------------------------------------------

export interface SnapshotRow {
  capturedAtMs: number;
  mid: number | null;
  bid: number | null;
  ask: number | null;
}

/**
 * O snapshot mais próximo do alvo DENTRO da tolerância, ou `null`.
 *
 * Mais próximo dos dois lados, e não "o último antes do alvo": esta amostra já
 * conhece o desfecho e não simula decisão em tempo real — o vizinho posterior é
 * a leitura mais fiel do instante pedido. (É o oposto da convenção de
 * `market-history.anchorAt`, que existe para o enricher não enxergar o futuro.)
 *
 * Empate exato de distância resolve para o snapshot POSTERIOR. É arbitrário, mas
 * tem que ser determinístico: a mesma partida não pode cair em baldes diferentes
 * entre duas rodadas.
 */
export function pickNearest(
  rows: readonly SnapshotRow[],
  targetMs: number,
  toleranceMs: number,
): SnapshotRow | null {
  let best: SnapshotRow | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (const row of rows) {
    const distance = Math.abs(row.capturedAtMs - targetMs);
    if (distance > toleranceMs) continue;
    // `<` e não `<=` mantém o primeiro de um empate exato... e como as linhas
    // chegam em ordem crescente de `captured_at`, o primeiro empate é o ANTERIOR.
    // Por isso o desempate explícito abaixo, que prefere o posterior.
    if (
      distance < bestDistance ||
      (distance === bestDistance && row.capturedAtMs > (best?.capturedAtMs ?? 0))
    ) {
      best = row;
      bestDistance = distance;
    }
  }

  return best;
}

/** `best_ask − best_bid`, ou `null` sem os dois lados. Negativo é book cruzado. */
export function spreadOf(row: SnapshotRow): number | null {
  if (row.bid === null || row.ask === null) return null;
  return row.ask - row.bid;
}

function parseSnapshots(rows: readonly Row[]): SnapshotRow[] {
  const out: SnapshotRow[] = [];

  for (const row of rows) {
    const at = asString(row['captured_at']);
    if (at === null) continue;

    const ms = new Date(at).getTime();
    if (!Number.isFinite(ms)) continue;

    out.push({
      capturedAtMs: ms,
      mid: asNumber(row['mid_price']),
      bid: asNumber(row['best_bid']),
      ask: asNumber(row['best_ask']),
    });
  }

  return out;
}

/**
 * A janela de tolerância de UM alvo, em UMA consulta.
 *
 * `event_id` fixado E os dois lados de `captured_at` em toda leitura, sem
 * exceção: a estimativa do planner erra por centenas de vezes nesta tabela e,
 * sem o `event_id`, o plano escolhido varre partição inteira. A janela é de
 * ±tolerância — 10 minutos no total —, então cai em uma ou duas partições de dia.
 */
async function loadWindow(
  table: 'esports_snapshots' | 'polymarket_snapshots',
  eventId: string,
  outcomeLabel: string,
  targetMs: number,
  toleranceMs: number,
): Promise<{ rows: SnapshotRow[]; truncated: boolean }> {
  const { data, error } = await supabase
    .from(table)
    .select('captured_at, mid_price, best_bid, best_ask')
    .eq('event_id', eventId)
    .eq('outcome', outcomeLabel)
    .gte('captured_at', new Date(targetMs - toleranceMs).toISOString())
    .lte('captured_at', new Date(targetMs + toleranceMs).toISOString())
    .order('captured_at', { ascending: true })
    .limit(WINDOW_ROW_LIMIT);

  if (error) throw new Error(`leitura de ${table} falhou: ${error.message}`);

  const rows = (data ?? []) as Row[];
  return { rows: parseSnapshots(rows), truncated: rows.length >= WINDOW_ROW_LIMIT };
}

function emptyCoverage(): CoverageCounts {
  return { semSnapshotNaTolerancia: 0, semMid: 0, janelasTruncadas: 0 };
}

/**
 * O dataset: uma linha por (partida, checkpoint) que teve preço na tolerância.
 *
 * Uma consulta por linha TENTADA, não por linha produzida — a que não produz
 * linha é justamente a que precisa ser contada, e o contador está em `coverage`.
 */
export async function loadMarketDataset(
  universe: MarketUniverse,
  checkpoints: readonly number[] = CHECKPOINTS,
): Promise<MarketDataset> {
  const points: MarketPoint[] = [];
  const coverage = new Map<number, CoverageCounts>();
  for (const checkpoint of checkpoints) coverage.set(checkpoint, emptyCoverage());

  const toleranceMs = TOLERANCE_SECONDS * 1000;
  let snapshotsRead = 0;
  let queries = 0;
  let done = 0;

  for (const match of universe.matches) {
    done += 1;
    if (done % 25 === 0 || done === universe.matches.length) {
      console.error(`[${LABEL}] partida ${done}/${universe.matches.length}…`);
    }

    for (const checkpoint of checkpoints) {
      const counts = coverage.get(checkpoint) ?? emptyCoverage();
      const targetMs = match.scheduledAt.getTime() - checkpoint * 60_000;

      const { rows, truncated } = await loadWindow(
        'esports_snapshots',
        match.eventId,
        match.teamLabel,
        targetMs,
        toleranceMs,
      );

      queries += 1;
      snapshotsRead += rows.length;
      if (truncated) counts.janelasTruncadas += 1;

      const nearest = pickNearest(rows, targetMs, toleranceMs);
      if (nearest === null) {
        counts.semSnapshotNaTolerancia += 1;
        continue;
      }
      if (nearest.mid === null) {
        counts.semMid += 1;
        continue;
      }

      points.push({
        matchId: match.matchId,
        matchSlug: match.matchSlug,
        eventId: match.eventId,
        checkpointMinutes: checkpoint,
        scheduledAt: match.scheduledAt.toISOString(),
        anchorSource: match.anchorSource,
        targetAt: new Date(targetMs).toISOString(),
        capturedAt: new Date(nearest.capturedAtMs).toISOString(),
        offsetSeconds: (nearest.capturedAtMs - targetMs) / 1000,
        price: nearest.mid,
        spread: spreadOf(nearest),
        outcome: match.outcome,
      });
    }
  }

  return { points, universe, coverage, snapshotsRead, queries };
}

// ---------------------------------------------------------------------------
// A sonda histórica: sobrou preço de antes de 05/08?
// ---------------------------------------------------------------------------

export interface LegacyCoverage {
  /** Partidas resolvidas com `scheduled_at` anterior a `SERIES_START` e com link. */
  candidates: number;
  /** Quantas foram efetivamente sondadas (pode ser menos, com `--legacy-limit`). */
  probed: number;
  /** Tem ALGUM snapshot na janela larga, em `polymarket_snapshots`. */
  comSeriePolymarket: number;
  /** Tem ALGUM snapshot na janela larga, em `esports_snapshots`. */
  comSerieEsports: number;
  /** Tem preço em pelo menos um checkpoint, dentro da tolerância. */
  comCheckpoint: number;
  /** Linhas que o dataset ganharia se estas partidas entrassem. */
  linhasRecuperaveis: number;
  queries: number;
}

/**
 * Quantas partidas de ANTES de 05/08 ainda têm preço recuperável — medido, não
 * suposto.
 *
 * A suposição confortável é "nenhuma": a retenção antiga apagava a série de
 * evento resolvido sem condição de idade, e o conserto (20260806032316) só entrou
 * em 06/08. Mas a suposição decide o tamanho do universo desta análise — 200
 * partidas ou 2.100 —, e uma diferença dessas não se resolve com plausibilidade.
 *
 * Barato por desenho: primeiro UMA consulta de janela larga por partida e por
 * tabela, com `limit(1)`; só quem tem algo lá é que paga as consultas de
 * checkpoint. Com a expectativa de zero hits, o custo é 2 consultas por partida.
 */
export async function probeLegacyCoverage(
  legacy: readonly UniverseMatch[],
  options: { limit?: number | null; checkpoints?: readonly number[] } = {},
): Promise<LegacyCoverage> {
  const checkpoints = options.checkpoints ?? CHECKPOINTS;
  const limit = options.limit ?? null;
  const targets = limit === null ? legacy : legacy.slice(0, limit);

  const out: LegacyCoverage = {
    candidates: legacy.length,
    probed: targets.length,
    comSeriePolymarket: 0,
    comSerieEsports: 0,
    comCheckpoint: 0,
    linhasRecuperaveis: 0,
    queries: 0,
  };

  const windowMs = LEGACY_WINDOW_HOURS * 3600_000;
  const toleranceMs = TOLERANCE_SECONDS * 1000;
  let done = 0;

  for (const match of targets) {
    done += 1;
    if (done % 50 === 0 || done === targets.length) {
      console.error(`[${LABEL}] sonda histórica ${done}/${targets.length}…`);
    }

    const centre = match.scheduledAt.getTime();
    const tables: Array<'polymarket_snapshots' | 'esports_snapshots'> = [
      'polymarket_snapshots',
      'esports_snapshots',
    ];

    const hasSeries: Record<string, boolean> = {};

    for (const table of tables) {
      const { data, error } = await supabase
        .from(table)
        .select('captured_at')
        .eq('event_id', match.eventId)
        .eq('outcome', match.teamLabel)
        .gte('captured_at', new Date(centre - windowMs).toISOString())
        .lte('captured_at', new Date(centre + windowMs).toISOString())
        .limit(1);

      out.queries += 1;
      if (error) throw new Error(`leitura de ${table} falhou: ${error.message}`);

      hasSeries[table] = ((data ?? []) as Row[]).length > 0;
    }

    if (hasSeries['polymarket_snapshots'] === true) out.comSeriePolymarket += 1;
    if (hasSeries['esports_snapshots'] === true) out.comSerieEsports += 1;
    if (hasSeries['polymarket_snapshots'] !== true && hasSeries['esports_snapshots'] !== true) {
      continue;
    }

    let recovered = 0;

    for (const checkpoint of checkpoints) {
      const targetMs = centre - checkpoint * 60_000;

      for (const table of tables) {
        if (hasSeries[table] !== true) continue;

        const { rows } = await loadWindow(
          table,
          match.eventId,
          match.teamLabel,
          targetMs,
          toleranceMs,
        );
        out.queries += 1;

        const nearest = pickNearest(rows, targetMs, toleranceMs);
        if (nearest?.mid != null) {
          recovered += 1;
          break;
        }
      }
    }

    if (recovered > 0) out.comCheckpoint += 1;
    out.linhasRecuperaveis += recovered;
  }

  return out;
}

export interface AnchorlessCoverage {
  candidates: number;
  probed: number;
  /** Tem ao menos uma linha em `polymarket_snapshots`, em qualquer instante. */
  comSeriePolymarket: number;
  /** Tem ao menos uma linha em `esports_snapshots`, em qualquer instante. */
  comSerieEsports: number;
  /** O `captured_at` mais recente encontrado, em qualquer das duas. Só diagnóstico. */
  ultimaCaptura: string | null;
  queries: number;
}

/**
 * Sobrou série das partidas SEM horário? Uma sondagem de índice por evento.
 *
 * `where event_id = $1 order by captured_at desc limit 1` é exatamente o formato
 * de `idx_snapshots_event_time (event_id, captured_at desc)` e de
 * `idx_esports_snapshots_event_time`: o planejador entra pela coluna líder, lê
 * uma linha e para. É a única leitura desta tabela que se pode fazer sem faixa
 * de `captured_at` — e só se pode porque não há faixa a dar: estas partidas não
 * têm horário nenhum, que é justamente o motivo de estarem aqui.
 *
 * A pergunta que ela responde é de dimensionamento, não de calibração: se sobrou
 * série, falta um backfill de horário para essas 1,7k partidas entrarem; se não
 * sobrou, não há o que recuperar e o universo é o pós-05/08, ponto final.
 */
export async function probeAnchorlessSeries(
  anchorless: readonly AnchorlessMatch[],
  options: { limit?: number | null } = {},
): Promise<AnchorlessCoverage> {
  const limit = options.limit ?? null;
  const targets = limit === null ? anchorless : anchorless.slice(0, limit);

  const out: AnchorlessCoverage = {
    candidates: anchorless.length,
    probed: targets.length,
    comSeriePolymarket: 0,
    comSerieEsports: 0,
    ultimaCaptura: null,
    queries: 0,
  };

  let done = 0;

  for (const match of targets) {
    done += 1;
    if (done % 100 === 0 || done === targets.length) {
      console.error(`[${LABEL}] sonda sem-âncora ${done}/${targets.length}…`);
    }

    for (const table of ['polymarket_snapshots', 'esports_snapshots'] as const) {
      const { data, error } = await supabase
        .from(table)
        .select('captured_at')
        .eq('event_id', match.eventId)
        .order('captured_at', { ascending: false })
        .limit(1);

      out.queries += 1;
      if (error) throw new Error(`leitura de ${table} falhou: ${error.message}`);

      const at = asString(((data ?? []) as Row[])[0]?.['captured_at']);
      if (at === null) continue;

      if (table === 'polymarket_snapshots') out.comSeriePolymarket += 1;
      else out.comSerieEsports += 1;

      if (out.ultimaCaptura === null || at > out.ultimaCaptura) out.ultimaCaptura = at;
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// Recortes
// ---------------------------------------------------------------------------

/**
 * Metade mais antiga contra metade mais recente — o corte que separa achado de
 * miragem.
 *
 * O corte é por PARTIDA e não por linha, e isso não é detalhe: os dois
 * checkpoints da mesma partida dividem o mesmo desfecho, e deixá-los cair em
 * metades opostas colocaria a mesma evidência dos dois lados da comparação que
 * existe justamente para ser independente. Aqui, por construção, nenhuma partida
 * atravessa o corte.
 *
 * Ordenado por `scheduledAt` — o instante da partida — porque a pergunta é se um
 * viés medido num pedaço do calendário sobrevive no seguinte. Empate exato de
 * horário vai para a metade recente; é no máximo uma partida e não move nada.
 */
export function splitByMatchTime(points: readonly MarketPoint[]): {
  older: MarketPoint[];
  newer: MarketPoint[];
} {
  const byMatch = new Map<string, string>();
  for (const point of points) byMatch.set(point.matchId, point.scheduledAt);

  const ordered = [...byMatch.entries()].sort(([idA, a], [idB, b]) =>
    a < b ? -1 : a > b ? 1 : idA < idB ? -1 : 1,
  );

  const half = Math.floor(ordered.length / 2);
  const olderIds = new Set(ordered.slice(0, half).map(([id]) => id));

  return {
    older: points.filter((point) => olderIds.has(point.matchId)),
    newer: points.filter((point) => !olderIds.has(point.matchId)),
  };
}

/** Partidas distintas por trás de uma lista de linhas. A unidade que conta. */
export function distinctMatches(points: readonly MarketPoint[]): number {
  return new Set(points.map((point) => point.matchId)).size;
}
