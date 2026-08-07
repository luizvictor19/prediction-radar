import { supabase } from '../lib/supabase.js';
import { entityTablesAvailable } from './resolver.js';

/**
 * Propagação do desfecho: `events` → `esports_matches`.
 *
 * O auto-resolver (`resolved_detector`) descobre que um market fechou e carimba
 * `events.status = 'resolved'` com `events.resolved_outcome` — o RÓTULO
 * vencedor, uma string como 'Natus Vincere'. A camada de entidades não existia
 * quando ele foi escrito, e ninguém nunca traduziu aquele rótulo para
 * `esports_matches.winner_team_id`. Medido em 2026-08-07: 106 de 106 partidas
 * passadas com `winner_team_id` e `resolved_at` nulos, 33 análises acumuladas e
 * ZERO pontuáveis no eval.
 *
 * ## Por que isto é um passo próprio, e não um pedaço dos outros dois
 *
 * Foram três candidatos, e os dois óbvios têm o mesmo defeito.
 *
 *   NO `resolved_detector` — ele escreveria no instante da resolução, que é
 *   justamente quando o link pode ainda não existir: o resolver de esports roda
 *   a cada 10 min, o market pode ter sido descoberto minutos antes de fechar, e
 *   `market_match_links.outcome_a_index` pode nascer nulo (estado B) e só virar
 *   número no recompute SEMANAL. Escrita disparada por evento perde tudo que
 *   chega fora de ordem — e o que chega fora de ordem é exatamente o buraco de
 *   106 partidas que este arquivo existe para tapar. Somando: o auto-resolver é
 *   genérico por desenho (spec 000, item 2c) e não deve ganhar dependência da
 *   camada de esports.
 *
 *   NO `esports_resolver` — o varredor dele PULA evento que já tem link
 *   (`alreadyLinked`), e o moneyline de uma partida resolvida é, por definição,
 *   um evento que já tem link. Nada naquela varredura passa por ele de novo. E o
 *   recompute semanal, que passaria, segura o lock por até 30 min: uma partida
 *   que fecha no domingo de manhã esperaria o ciclo inteiro.
 *
 *   PASSO PRÓPRIO — a pergunta certa não é "o que acabou de acontecer" e sim
 *   "que partida ainda está sem desfecho e já tem como ter um". Reconciliação,
 *   não evento. Converge sozinha, é idempotente, e o backfill das 106 é a MESMA
 *   passada com a janela aberta em vez de código separado que envelhece à parte.
 *
 * ## A tradução, e onde ela pode falhar
 *
 * `events.resolved_outcome` é um rótulo; `winner_team_id` é uma entidade. A
 * ponte é `market_match_links.outcome_a_index`, que diz qual índice de
 * `events.outcomes.values` é o time A DAQUELE market — por market, porque 19 de
 * 79 eventos medidos têm markets irmãos com os outcomes em ordens diferentes.
 *
 * Só o market de papel `moneyline` decide a série. `child_moneyline` decide um
 * game, e um time pode vencer o game 1 e perder a série.
 *
 * O que NÃO se adivinha, e o destino de cada caso:
 *
 *   void          — market resolvido sem outcome vencedor. Terminal: carimba
 *                   `resolved_at` e deixa `winner_team_id` nulo. É esse par que
 *                   distingue void de "ainda não resolveu" no banco inteiro.
 *   sem índice    — estado B. NENHUMA escrita: o recompute semanal do resolver
 *                   preenche `outcome_a_index` e a passada seguinte conclui.
 *   ambíguo       — o rótulo não está em `outcomes.values`, ou casa em mais de
 *                   um, ou dois moneylines da mesma partida discordam. Estado A:
 *                   `needs_review = true` e nenhum desfecho gravado.
 *   sem moneyline — a partida só tem markets derivados linkados. Nada a fazer.
 *
 * Em nenhum deles se inventa vencedor. Uma partida sem desfecho pontuável é uma
 * linha a menos no eval; uma partida com desfecho ERRADO inverte o sinal da
 * métrica e não se anuncia.
 */

const COMPONENT = 'esports_outcome';

/**
 * O papel que decide a SÉRIE.
 *
 * Espelha `events.sports_market_type`. `child_moneyline` (moneyline de game),
 * `map_handicap` e o resto dos derivados não decidem quem venceu a partida.
 */
const SERIES_ROLE = 'moneyline';

/** `in(...)` vira query string; lote grande estoura o limite de URL do PostgREST. */
const IN_CHUNK = 200;

/** Partidas lidas por página. O teto de trabalho é `limit`, não este número. */
const PAGE = 500;

/** Trava contra laço patológico se o avanço de página não convergir. */
const MAX_PAGES = 200;

/** Amostras guardadas por passada, para diagnóstico. Não é censo. */
const MAX_SAMPLES = 10;

// ---------------------------------------------------------------------------
// Decisão pura
// ---------------------------------------------------------------------------

/** Um market de papel `moneyline` linkado à partida, com o que ele sabe. */
export interface MoneylineMarket {
  eventId: string;
  /** `events.status`. Só `resolved` conclui alguma coisa. */
  status: string;
  /** `events.resolved_outcome`: o RÓTULO vencedor, não o índice. */
  resolvedOutcome: string | null;
  /** `events.resolved_at`. Pode ser nulo em linha antiga — ver `stampOf`. */
  resolvedAt: string | null;
  /** `events.outcomes.values`, cru. */
  outcomes: readonly unknown[];
  /** `market_match_links.outcome_a_index`. Nulo = estado B. */
  outcomeAIndex: number | null;
}

export type MarketVerdict =
  | { kind: 'winner'; side: 'a' | 'b'; resolvedAt: string | null }
  | { kind: 'void'; resolvedAt: string | null }
  | { kind: 'pending' }
  | { kind: 'no_index' }
  | { kind: 'ambiguous'; reason: string };

function normalizeLabel(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

/**
 * O veredito de UM market moneyline.
 *
 * A ordem das guardas é a ordem em que os fatos chegam, e não é permutável:
 * `resolved_outcome` nulo num evento resolvido é void — perguntar pelo índice
 * antes disso faria uma partida void virar "estado B" e ficar pendente para
 * sempre, esperando um índice que não mudaria nada.
 *
 * Sobre a leitura de void: quem grava `status = 'resolved'` sem
 * `resolved_outcome` é o `resolved_detector`, no caminho `{ kind: 'void' }`
 * (preços 0.5/0.5 na UMA). É a única escrita desse par no sistema hoje. Linha
 * anterior à coluna `resolved_outcome` cairia aqui também — daí a contagem
 * separada no relatório: void em série é sintoma, não desfecho.
 */
export function decideMarket(market: MoneylineMarket): MarketVerdict {
  if (market.status !== 'resolved') return { kind: 'pending' };
  if (market.resolvedOutcome === null) return { kind: 'void', resolvedAt: market.resolvedAt };
  if (market.outcomeAIndex === null) return { kind: 'no_index' };

  const values = market.outcomes.map(normalizeLabel);
  if (values.length === 0) {
    return { kind: 'ambiguous', reason: 'evento resolvido sem outcomes.values' };
  }

  const indexA = market.outcomeAIndex;
  if (indexA < 0 || indexA >= values.length) {
    return {
      kind: 'ambiguous',
      reason: `outcome_a_index ${indexA} fora de outcomes.values (${values.length} valores)`,
    };
  }

  const wanted = normalizeLabel(market.resolvedOutcome);
  const hits: number[] = [];
  for (let i = 0; i < values.length; i++) {
    if (values[i] === wanted) hits.push(i);
  }

  // Não casar é conflito entre duas fontes que deveriam ser a mesma: o rótulo
  // vem de `outcomes` da Gamma (ou de `polymarket_snapshots.outcome`, que é o
  // mesmo vocabulário) e `outcomes.values` vem do mesmo payload. Divergência
  // aqui é anomalia, e anomalia é humano — não é o estado B, que se cura
  // sozinho com mais dado.
  if (hits.length === 0) {
    return {
      kind: 'ambiguous',
      reason: `rótulo vencedor "${market.resolvedOutcome}" não está em outcomes.values`,
    };
  }
  if (hits.length > 1) {
    return {
      kind: 'ambiguous',
      reason: `rótulo vencedor "${market.resolvedOutcome}" casa em ${hits.length} outcomes`,
    };
  }

  const winnerIndex = hits[0] as number;
  if (winnerIndex === indexA) return { kind: 'winner', side: 'a', resolvedAt: market.resolvedAt };

  // "Não é o A" só identifica o B no binário. Com três outcomes (o empate de
  // futebol, quando a vertical existir) a exclusão não fecha, e chutar aqui
  // inverteria metade da amostra sem avisar.
  if (values.length !== 2) {
    return {
      kind: 'ambiguous',
      reason: `vencedor não é o time A e outcomes.values tem ${values.length} valores`,
    };
  }

  return { kind: 'winner', side: 'b', resolvedAt: market.resolvedAt };
}

/**
 * O veredito da PARTIDA a partir dos moneylines dela.
 *
 * Normalmente é um só. Mais de um acontece quando a mesma partida tem markets
 * duplicados (neg-risk, remarcação), e aí a regra é: concordar ou não concluir.
 * Dois moneylines com vencedores diferentes não é dado pobre, é contradição —
 * um dos dois links está errado, e escolher um pela ordem da query seria
 * decidir por sorteio.
 *
 * A precedência dos casos inconclusivos (ambíguo > sem índice > pendente) é do
 * mais informativo para o menos: se um market grita contradição, o silêncio dos
 * outros não a apaga.
 */
export function combineVerdicts(verdicts: readonly MarketVerdict[]): MarketVerdict {
  const ambiguous = verdicts.find((v): v is Extract<MarketVerdict, { kind: 'ambiguous' }> =>
    v.kind === 'ambiguous',
  );
  if (ambiguous) return ambiguous;

  const winners = verdicts.filter((v): v is Extract<MarketVerdict, { kind: 'winner' }> =>
    v.kind === 'winner',
  );
  const voids = verdicts.filter((v): v is Extract<MarketVerdict, { kind: 'void' }> =>
    v.kind === 'void',
  );

  const sides = new Set(winners.map(v => v.side));
  if (sides.size > 1) {
    return {
      kind: 'ambiguous',
      reason: 'moneylines da mesma partida apontam vencedores diferentes',
    };
  }
  if (sides.size === 1 && voids.length > 0) {
    return { kind: 'ambiguous', reason: 'um moneyline aponta vencedor e outro aponta void' };
  }

  if (winners.length > 0) {
    const first = winners[0] as Extract<MarketVerdict, { kind: 'winner' }>;
    return {
      kind: 'winner',
      side: first.side,
      resolvedAt: earliest(winners.map(v => v.resolvedAt)),
    };
  }
  if (voids.length > 0) return { kind: 'void', resolvedAt: earliest(voids.map(v => v.resolvedAt)) };

  // Estado B antes de "pendente": a partida cujo índice falta TEM desfecho, só
  // não tem como orientá-lo. Contar como pendente esconderia o que o recompute
  // semanal ainda deve a este passo.
  if (verdicts.some(v => v.kind === 'no_index')) return { kind: 'no_index' };
  return { kind: 'pending' };
}

/** O carimbo mais antigo entre os markets: o instante em que o desfecho passou a existir. */
function earliest(stamps: readonly (string | null)[]): string | null {
  const known = stamps.filter((s): s is string => s !== null).sort();
  return known[0] ?? null;
}

export type MatchOutcome =
  | { kind: 'winner'; teamId: string; resolvedAt: string | null }
  | { kind: 'void'; resolvedAt: string | null }
  | { kind: 'pending' }
  | { kind: 'no_index' }
  | { kind: 'no_moneyline' }
  | { kind: 'no_team_row' }
  | { kind: 'ambiguous'; reason: string };

export interface MatchSides {
  teamAId: string | null;
  teamBId: string | null;
}

/**
 * O desfecho da partida, já como id de time.
 *
 * `no_team_row` é a última guarda antes da escrita e não deveria disparar: o
 * resolver cria as duas linhas de time (mesmo no caminho 2, onde elas nascem só
 * com o código do slug) antes de gravar a partida. Se disparar, o CHECK
 * `esports_matches_winner_is_a_side` rejeitaria a escrita de qualquer jeito —
 * melhor contar e seguir do que perder o lote inteiro num chunk.
 */
export function decideMatch(
  sides: MatchSides,
  markets: readonly MoneylineMarket[],
): MatchOutcome {
  if (markets.length === 0) return { kind: 'no_moneyline' };

  const verdict = combineVerdicts(markets.map(decideMarket));

  if (verdict.kind !== 'winner') return verdict;

  const teamId = verdict.side === 'a' ? sides.teamAId : sides.teamBId;
  if (teamId === null) return { kind: 'no_team_row' };

  return { kind: 'winner', teamId, resolvedAt: verdict.resolvedAt };
}

// ---------------------------------------------------------------------------
// A passada
// ---------------------------------------------------------------------------

export interface OutcomeOptions {
  /**
   * Piso de `esports_matches.scheduled_at`. `null` abre o histórico inteiro e
   * inclui partida SEM horário — é o modo do backfill.
   *
   * O ciclo de produção usa uma janela curta porque partida que não concluiu
   * nela não concluiria em janela nenhuma sem dado novo (estado B espera o
   * recompute semanal; ambíguo espera humano), e reler o histórico inteiro a
   * cada 10 min seria pagar por essa espera seis vezes por hora.
   */
  since?: string | null;
  /** Teto de partidas EXAMINADAS por chamada. */
  limit?: number;
  /** Decide e conta, sem escrever nada. */
  dryRun?: boolean;
  /** Guarda amostras dos casos que não concluíram. Desligado no ciclo. */
  collectSamples?: boolean;
  /** Só para teste: o "agora" que recorta as partidas já começadas. */
  now?: Date;
}

export interface OutcomeSample {
  matchSlug: string;
  kind: MatchOutcome['kind'];
  detail: string;
}

export interface OutcomeStats {
  /** Partidas sem desfecho lidas nesta passada. */
  examined: number;
  winners: number;
  voids: number;
  /** Moneyline ainda aberto. O caso normal e dominante. */
  pending: number;
  /** Estado B: falta `outcome_a_index`. O recompute semanal é a cura. */
  noIndex: number;
  /** Partida sem nenhum market moneyline linkado. */
  noMoneyline: number;
  /** Lado vencedor sem linha em `esports_teams`. Não deveria acontecer. */
  noTeamRow: number;
  /** Estado A: contradição entre fontes. */
  ambiguous: number;
  /** Partidas que passaram a `needs_review` nesta passada (só a transição). */
  flagged: number;
  /** Linhas de `esports_matches` efetivamente atualizadas. */
  written: number;
  writeFailed: number;
  /** O teto de `limit` cortou partidas que ainda havia para examinar. */
  capHit: boolean;
  /** Migration 20260806183705 não aplicada — nada foi lido nem escrito. */
  tablesMissing: boolean;
  errors: string[];
  samples: OutcomeSample[];
}

export function emptyOutcomeStats(): OutcomeStats {
  return {
    examined: 0,
    winners: 0,
    voids: 0,
    pending: 0,
    noIndex: 0,
    noMoneyline: 0,
    noTeamRow: 0,
    ambiguous: 0,
    flagged: 0,
    written: 0,
    writeFailed: 0,
    capHit: false,
    tablesMissing: false,
    errors: [],
    samples: [],
  };
}

interface CandidateMatch {
  id: string;
  matchSlug: string;
  teamAId: string | null;
  teamBId: string | null;
}

function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * As partidas sem desfecho que já deveriam ter um.
 *
 * O filtro é o par (`winner_team_id`, `resolved_at`) nulo — o mesmo par que
 * codifica o void. É ele que torna a passada convergente: partida concluída sai
 * do conjunto na escrita, e nenhuma marca extra precisa ser mantida.
 *
 * Sem `since` NÃO há recorte de `scheduled_at` nenhum, nem o teto do "já
 * começou". É de propósito: partida sem horário existe (o `game_start_time` do
 * evento nem sempre chega) e um recorte por data a deixaria fora do backfill
 * para sempre. O custo é ler as partidas futuras junto — todas concluem em
 * `pending` numa leitura em lote, e é a ordenação que faz isso não importar:
 * crescente com os nulos na frente, o passado vem primeiro e o teto corta o
 * futuro, que é justamente o que não tem desfecho para propagar.
 */
async function loadCandidates(
  since: string | null,
  nowIso: string,
  offset: number,
  pageSize: number,
): Promise<{ rows: CandidateMatch[]; error: string | null }> {
  let query = supabase
    .from('esports_matches')
    .select('id, match_slug, team_a_id, team_b_id, scheduled_at')
    .is('winner_team_id', null)
    .is('resolved_at', null)
    .order('scheduled_at', { ascending: true, nullsFirst: true })
    .order('id', { ascending: true })
    .range(offset, offset + pageSize - 1);

  if (since !== null) query = query.gte('scheduled_at', since).lte('scheduled_at', nowIso);

  const { data, error } = await query;
  if (error) return { rows: [], error: `leitura de esports_matches: ${error.message}` };

  return {
    rows: (data ?? []).map(row => ({
      id: row['id'] as string,
      matchSlug: (row['match_slug'] as string | null) ?? '(sem slug)',
      teamAId: (row['team_a_id'] as string | null) ?? null,
      teamBId: (row['team_b_id'] as string | null) ?? null,
    })),
    error: null,
  };
}

/** Os moneylines de cada partida, já com o que o evento sabe do desfecho. */
async function loadMoneylines(
  matchIds: readonly string[],
  errors: string[],
): Promise<Map<string, MoneylineMarket[]>> {
  const byMatch = new Map<string, MoneylineMarket[]>();
  const linkRows: Array<{ matchId: string; eventId: string; outcomeAIndex: number | null }> = [];

  for (const chunk of chunks(matchIds, IN_CHUNK)) {
    const { data, error } = await supabase
      .from('market_match_links')
      .select('match_id, event_id, outcome_a_index')
      .in('match_id', chunk)
      .eq('market_role', SERIES_ROLE);

    if (error) {
      errors.push(`leitura de market_match_links: ${error.message}`);
      continue;
    }

    for (const row of data ?? []) {
      linkRows.push({
        matchId: row['match_id'] as string,
        eventId: row['event_id'] as string,
        outcomeAIndex: (row['outcome_a_index'] as number | null) ?? null,
      });
    }
  }

  if (linkRows.length === 0) return byMatch;

  const eventById = new Map<string, Record<string, unknown>>();
  for (const chunk of chunks([...new Set(linkRows.map(l => l.eventId))], IN_CHUNK)) {
    const { data, error } = await supabase
      .from('events')
      .select('id, status, resolved_outcome, resolved_at, outcomes')
      .in('id', chunk);

    if (error) {
      errors.push(`leitura de events: ${error.message}`);
      continue;
    }

    for (const row of data ?? []) eventById.set(row['id'] as string, row);
  }

  for (const link of linkRows) {
    const event = eventById.get(link.eventId);

    // Sem o evento não há o que concluir. Não é erro de dado (o link tem FK com
    // cascade), é chunk que falhou — e o erro já está em `errors`.
    if (event === undefined) continue;

    const values = (event['outcomes'] as Record<string, unknown> | null)?.['values'];

    const list = byMatch.get(link.matchId) ?? [];
    list.push({
      eventId: link.eventId,
      status: (event['status'] as string | null) ?? '',
      resolvedOutcome: (event['resolved_outcome'] as string | null) ?? null,
      resolvedAt: (event['resolved_at'] as string | null) ?? null,
      outcomes: Array.isArray(values) ? values : [],
      outcomeAIndex: link.outcomeAIndex,
    });
    byMatch.set(link.matchId, list);
  }

  return byMatch;
}

/**
 * A escrita do desfecho.
 *
 * As guardas `is(... null)` no UPDATE não são zelo: entre a leitura e a escrita
 * o recompute do resolver pode ter passado pela mesma linha, e um desfecho já
 * gravado nunca deve ser sobrescrito por esta passada. Zero linhas afetadas é
 * resultado válido — significa que alguém chegou antes com a mesma conclusão.
 */
async function writeOutcome(
  matchId: string,
  patch: Record<string, unknown>,
): Promise<{ written: boolean; error: string | null }> {
  const { data, error } = await supabase
    .from('esports_matches')
    .update(patch)
    .eq('id', matchId)
    .is('winner_team_id', null)
    .is('resolved_at', null)
    .select('id');

  if (error) return { written: false, error: error.message };
  return { written: (data ?? []).length > 0, error: null };
}

/**
 * Marca a partida para revisão humana (estado A).
 *
 * `eq('needs_review', false)` é o que impede a passada de reescrever a mesma
 * linha a cada 10 min: partida ambígua continua candidata para sempre — ela não
 * tem desfecho — e sem essa guarda seriam 144 UPDATEs por dia por partida
 * contraditória.
 *
 * O recompute semanal do resolver pode zerar esta marca: o upsert dele manda
 * `needs_review` no payload e o valor de lá vem do planejamento do LINK, que não
 * sabe nada de desfecho. Não é problema a corrigir aqui — a partida continua
 * ambígua, continua candidata, e a passada seguinte a remarca. O que não pode é
 * esta função tentar ser esperta e escrever fora da transição.
 */
async function flagForReview(matchId: string): Promise<{ flagged: boolean; error: string | null }> {
  const { data, error } = await supabase
    .from('esports_matches')
    .update({ needs_review: true })
    .eq('id', matchId)
    .eq('needs_review', false)
    .select('id');

  if (error) return { flagged: false, error: error.message };
  return { flagged: (data ?? []).length > 0, error: null };
}

/**
 * Amostra do que NÃO concluiu.
 *
 * Desfecho gravado não entra: ele já está no banco e nos contadores, e enchendo
 * a amostra empurraria para fora justamente o caso que alguém precisa ler.
 */
function sample(stats: OutcomeStats, match: CandidateMatch, outcome: MatchOutcome): void {
  if (outcome.kind === 'winner' || outcome.kind === 'void') return;
  if (stats.samples.length >= MAX_SAMPLES) return;

  stats.samples.push({
    matchSlug: match.matchSlug,
    kind: outcome.kind,
    detail: outcome.kind === 'ambiguous' ? outcome.reason : '',
  });
}

/**
 * Uma passada de reconciliação.
 *
 * Lê as partidas sem desfecho, traduz o rótulo vencedor do moneyline em
 * `winner_team_id` e escreve. Idempotente: rodar duas vezes seguidas conclui
 * exatamente as mesmas partidas na primeira e nenhuma na segunda.
 *
 * A paginação avança pelo que SOBROU. Toda partida concluída sai do conjunto de
 * candidatas na hora da escrita, então as seguintes deslizam para trás — um
 * offset ingênuo pularia exatamente uma partida por conclusão. Em `dryRun` nada
 * sai, e o offset avança pela página inteira.
 */
export async function propagateMatchOutcomes(
  options: OutcomeOptions = {},
): Promise<OutcomeStats> {
  const stats = emptyOutcomeStats();
  const dryRun = options.dryRun === true;
  const limit = Math.max(options.limit ?? 500, 1);
  const since = options.since ?? null;
  const nowIso = (options.now ?? new Date()).toISOString();

  if (!(await entityTablesAvailable())) {
    stats.tablesMissing = true;
    return stats;
  }

  let offset = 0;
  let pages = 0;

  for (; pages < MAX_PAGES && stats.examined < limit; pages++) {
    const pageSize = Math.min(PAGE, limit - stats.examined);
    const { rows, error } = await loadCandidates(since, nowIso, offset, pageSize);

    if (error !== null) {
      stats.errors.push(error);
      break;
    }
    if (rows.length === 0) break;

    const moneylines = await loadMoneylines(rows.map(r => r.id), stats.errors);
    let removed = 0;

    for (const match of rows) {
      stats.examined++;

      const outcome = decideMatch(
        { teamAId: match.teamAId, teamBId: match.teamBId },
        moneylines.get(match.id) ?? [],
      );

      if (outcome.kind === 'pending') {
        stats.pending++;
        continue;
      }

      if (options.collectSamples === true) sample(stats, match, outcome);

      switch (outcome.kind) {
        case 'no_index':
          stats.noIndex++;
          continue;
        case 'no_moneyline':
          stats.noMoneyline++;
          continue;
        case 'no_team_row':
          stats.noTeamRow++;
          continue;
        case 'ambiguous': {
          stats.ambiguous++;
          if (dryRun) continue;

          const { flagged, error: flagError } = await flagForReview(match.id);
          if (flagError !== null) {
            stats.errors.push(`${match.matchSlug}: needs_review falhou — ${flagError}`);
            continue;
          }
          if (flagged) stats.flagged++;
          continue;
        }
        case 'winner':
        case 'void': {
          if (outcome.kind === 'winner') stats.winners++;
          else stats.voids++;

          if (dryRun) continue;

          // `resolved_at` do evento é a hora da resolução na UMA. Nulo só em
          // linha antiga; cair no relógio de agora é melhor que deixar a
          // partida sem carimbo — sem ele, void não existe como estado.
          const patch: Record<string, unknown> =
            outcome.kind === 'winner'
              ? { winner_team_id: outcome.teamId, resolved_at: outcome.resolvedAt ?? nowIso }
              : { resolved_at: outcome.resolvedAt ?? nowIso };

          const { written, error: writeError } = await writeOutcome(match.id, patch);
          if (writeError !== null) {
            stats.writeFailed++;
            stats.errors.push(`${match.matchSlug}: escrita falhou — ${writeError}`);
            continue;
          }

          if (written) stats.written++;
          removed++;
          continue;
        }
      }
    }

    // Página menor que o pedido significa fim do conjunto — não há próxima.
    if (rows.length < pageSize) return stats;

    offset += rows.length - removed;
  }

  // Freio que se anuncia: os dois tetos param a passada com partidas ainda por
  // examinar, e quem lê o log precisa saber que a conta está incompleta. O de
  // páginas só é alcançável com `limit` acima de MAX_PAGES * PAGE, e mesmo assim
  // não pode terminar em silêncio.
  if (pages >= MAX_PAGES) {
    stats.errors.push(`teto de ${MAX_PAGES} páginas atingido — rode de novo para continuar`);
  }

  stats.capHit = stats.examined >= limit || pages >= MAX_PAGES;
  return stats;
}

export { COMPONENT as OUTCOME_COMPONENT };
