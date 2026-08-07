import { supabase } from '../lib/supabase.js';
import { batchUpsert, dedupeByKey } from '../lib/batch-write.js';
import { slugPrefixFilter } from '../lib/slug-prefixes.js';
import {
  inspectMarketSlug,
  DEFAULT_VERTICAL_PREFIXES,
  type VerticalSlugPrefix,
} from './slug-parser.js';
import {
  guessMarketRole,
  learnedMarketRole,
  learnRoles,
  roleLearnKey,
  suffixFamily,
  UNKNOWN_ROLE,
  type LearnedRoles,
} from './market-role.js';

/**
 * Resolução mercado → partida (spec 001, item 3 / Parte C).
 *
 * Dois caminhos, escolhidos pela presença de
 * `events.event_metadata->'polymarket_teams'`. Nenhum dos dois chama a API: o
 * metadado já está na coluna desde 2026-08-06.
 *
 *   CAMINHO 1 — `teams[]` presente. Identidade exata. Medido no dry-run:
 *   446 markets, 0 outcomes não casados, 0 pendências. É o caso dominante daqui
 *   pra frente e não alimenta fila.
 *
 *   CAMINHO 2 — sem metadado. 21.169 markets, o histórico anterior a
 *   ~junho/2026, que NÃO será enriquecido por re-busca (re-fetch de evento
 *   antigo devolve 200 com `teams: []`). Só o slug dá identidade.
 *
 * ## `needs_review` é para decisão humana, e só para ela
 *
 * A primeira versão marcava todo o caminho 2 e produziu uma fila de 21.169
 * linhas — que é o mesmo que não ter fila. O erro conceitual: confundir
 * POBREZA com INCERTEZA. O caminho 2 é pobre (código sem nome, sem liga, sem
 * tier) e ao mesmo tempo determinístico — o parser deu 0 slugs fora do padrão em
 * 464 medidos. Pobre não é duvidoso.
 *
 * Três estados, e cada pendência vai para exatamente um:
 *
 *   A. REVISÃO HUMANA (`needs_review = true`) — só onde um humano acrescenta o
 *      que nenhuma máquina tem: conflito entre o slug e `teams[]`, casamento
 *      ambíguo, `teams[]` sem `ordering`, e outcome não casado NO CAMINHO 1
 *      (onde a medição diz que deveria casar, então falhar é anomalia).
 *
 *   B. RECOMPUTÁVEL (`recomputable`, sem flag no banco) — outcome não casado no
 *      caminho 2. A causa é conhecida: compara-se uma contração (`navi`) com um
 *      nome (`Natus Vincere`). A cura é o registro de times, que o caminho 1
 *      preenche com `display_name` para o mesmo `polymarket_code` — e uma
 *      passada nova do resolver resolve sozinha. Não é trabalho de humano.
 *
 *   C. RELATÓRIO DE FAMÍLIA — sufixo sem papel mapeável. A pergunta não é sobre
 *      a linha, é sobre a família: uma regra nova resolve milhares de markets, e
 *      milhares de confirmações no Telegram não resolvem nenhum.
 *
 * `confidence` continua registrando a pobreza. É lá que ela pertence.
 *
 * ## A regra que atravessa o arquivo
 *
 * Nunca inventar. O que muda com os três estados é o DESTINO da ambiguidade,
 * não a tolerância a ela: `outcome_a_index` que não casou continua `null`,
 * papel desconhecido continua `unknown`, e `esports_tournaments.tier` continua
 * sem ser escrito aqui — é decisão humana (H6).
 */

const COMPONENT = 'esports_resolver';

/** Eventos lidos por página do varredor. */
const PAGE_SIZE = 200;

/** Teto de valores por `in(...)` na releitura de ids — URL do PostgREST é GET. */
const READ_BACK_CHUNK = 100;

/** Páginas do aprendizado de papéis. Ver `loadLearnedRoles`. */
const LEARN_PAGE_SIZE = 1000;

/**
 * Teto de leitura por chamada quando o chamador não pede outro.
 *
 * Generoso de propósito: o custo de ler evento já linkado é uma fração do de
 * planejá-lo, e é isso que permite ao varredor reatravessar o histórico inteiro
 * depois de um deploy e ainda alcançar o mercado novo na mesma chamada.
 */
const DEFAULT_MAX_SCAN = 50_000;

const EVENT_COLUMNS = 'id, slug, outcomes, event_metadata, sports_market_type, game_start_time';

// ---------------------------------------------------------------------------
// Tipos
// ---------------------------------------------------------------------------

export interface VerticalConfig extends VerticalSlugPrefix {
  enabled: boolean;
}

export interface ResolvableEvent {
  id: string;
  slug: string | null;
  outcomes: Record<string, unknown> | null;
  event_metadata: Record<string, unknown> | null;
  sports_market_type: string | null;
  game_start_time: string | null;
}

export interface PlannedTeam {
  verticalId: string;
  polymarketCode: string;
  displayName: string | null;
  polymarketTeamId: number | null;
  pandascoreTeamId: number | null;
  /** Veio de `teams[]` da API. False = derivado do slug, e não pode sobrescrever. */
  authoritative: boolean;
}

export interface PlannedMatch {
  verticalId: string;
  matchSlug: string;
  codeA: string;
  codeB: string;
  league: string | null;
  /** Nunca null. Ver A3 da spec: `''` é "edição sem série nomeada". */
  serie: string;
  stage: string | null;
  leagueTier: string | null;
  bestOf: number | null;
  scheduledAt: string | null;
  externalIds: Record<string, unknown>;
  needsReview: boolean;
  authoritative: boolean;
}

export interface PlannedLink {
  eventId: string;
  matchSlug: string;
  marketRole: string;
  slugSuffix: string | null;
  outcomeAIndex: number | null;
  confidence: number;
  resolutionMethod: 'event_teams' | 'slug_parse';
  needsReview: boolean;
}

export type RoleSource = 'column' | 'guess' | 'learned' | 'unknown';
export type OutcomeKind = 'matched' | 'no_team_side' | 'unmatched' | 'ambiguous';

export interface EventPlan {
  teams: [PlannedTeam, PlannedTeam];
  match: PlannedMatch;
  link: PlannedLink;
  roleSource: RoleSource;
  outcomeKind: OutcomeKind;
  /** Estado A: o que exige humano. Não vazio ⇒ `needs_review`. */
  reviewReasons: string[];
  /** Estados B e C: observado, registrado, e resolvido por máquina ou por regra. */
  notes: string[];
  /** Estado B: uma passada futura, com o registro de times mais rico, resolve. */
  recomputable: boolean;
}

export type PlanRejection = 'not_esports' | 'malformed_slug' | 'vertical_disabled';

export type PlanResult = { ok: true; plan: EventPlan } | { ok: false; reason: PlanRejection };

/**
 * O que o plano pode consultar sem tocar no banco.
 *
 * É o que mantém `planEvent` puro: quem lê o registro de times e o mapa
 * aprendido é o varredor, uma vez por página, e passa o resultado pronto.
 */
export interface PlanContext {
  /** `vertical|code` → `display_name` acumulado em `esports_teams`. */
  teamNames?: Map<string, string>;
  learnedRoles?: LearnedRoles;
}

export interface OutcomeCounts {
  matched: number;
  noTeamSide: number;
  unmatched: number;
  ambiguous: number;
}

export interface RoleCounts {
  column: number;
  guess: number;
  learned: number;
  unknown: number;
}

/**
 * Todo contador de qualidade é POR CAMINHO, e não somado.
 *
 * O dry-run mostrou por quê: `unmatched` no caminho 1 é anomalia (a medição diz
 * que `teams[].name` bate exato com `outcomes.values`, e deu 0 na prática); no
 * caminho 2 é o previsto. Somados, os dois números não permitiriam distinguir
 * regressão de comportamento esperado.
 */
export interface PathCounts {
  resolved: number;
  outcome: OutcomeCounts;
  role: RoleCounts;
  needsReview: number;
  recomputable: number;
  /** Partidas sem `best_of`. Hoje é 100% delas — ver `bestOfFromScore`. */
  missingBestOf: number;
}

export interface UnmatchedSample {
  slug: string;
  path: 'event_teams' | 'slug_parse';
  outcomes: string[];
  labelA: string;
  labelB: string;
}

export interface ResolveSamples {
  unknownSuffixFamilies: Record<string, { count: number; example: string }>;
  unmatched: UnmatchedSample[];
}

/**
 * Entidades DISTINTAS tocadas, por chave natural — não operações de upsert.
 *
 * A primeira versão somava `batchUpsert().written`, que é o número de linhas
 * ENVIADAS por lote, e enganava em dois eixos ao mesmo tempo:
 *
 *   - a deduplicação é por página, então a mesma partida é reenviada em toda
 *     página que contenha outro market dela — 4.139 "partidas" para 2.557 reais;
 *   - metade das escritas é `ON CONFLICT DO NOTHING`, então boa parte das linhas
 *     enviadas não altera nada no banco.
 *
 * Nenhuma das duas era perda de dado — só contabilidade errada. Conjunto de
 * chave natural conta o que a pergunta realmente é: quantas entidades distintas
 * este backfill tocou.
 */
export interface WrittenEntities {
  /** `vertical|code` */
  teams: Set<string>;
  /** `vertical|name` */
  leagues: Set<string>;
  /** `leagueId|serie` */
  tournaments: Set<string>;
  /** `match_slug` */
  matches: Set<string>;
  /** `event_id` */
  links: Set<string>;
}

export interface WrittenCounts {
  teams: number;
  leagues: number;
  tournaments: number;
  matches: number;
  links: number;
}

export function writtenCounts(written: WrittenEntities): WrittenCounts {
  return {
    teams: written.teams.size,
    leagues: written.leagues.size,
    tournaments: written.tournaments.size,
    matches: written.matches.size,
    links: written.links.size,
  };
}

export interface ResolveStats {
  scanned: number;
  alreadyLinked: number;
  notEsports: number;
  verticalDisabled: number;
  malformedSlug: number;
  byPath: { eventTeams: PathCounts; slugParse: PathCounts };
  written: WrittenEntities;
  /**
   * Linhas em chunks que falharam no PostgREST.
   *
   * Fica ao lado de `written` de propósito: as chaves distintas são as
   * ENVIADAS, e só com este número em zero elas equivalem às gravadas.
   */
  writeFailedRows: number;
  /** Formas de sufixo aprendidas dos eventos que têm `sports_market_type`. */
  learnedRoleForms: number;
  errors: string[];
  /** Migration das tabelas de entidade ainda não aplicada: nada foi escrito. */
  tablesMissing: boolean;
  reachedEnd: boolean;
  samples: ResolveSamples;
}

export function emptyPathCounts(): PathCounts {
  return {
    resolved: 0,
    outcome: { matched: 0, noTeamSide: 0, unmatched: 0, ambiguous: 0 },
    role: { column: 0, guess: 0, learned: 0, unknown: 0 },
    needsReview: 0,
    recomputable: 0,
    missingBestOf: 0,
  };
}

export function emptyStats(): ResolveStats {
  return {
    scanned: 0,
    alreadyLinked: 0,
    notEsports: 0,
    verticalDisabled: 0,
    malformedSlug: 0,
    byPath: { eventTeams: emptyPathCounts(), slugParse: emptyPathCounts() },
    written: {
      teams: new Set(),
      leagues: new Set(),
      tournaments: new Set(),
      matches: new Set(),
      links: new Set(),
    },
    writeFailedRows: 0,
    learnedRoleForms: 0,
    errors: [],
    tablesMissing: false,
    reachedEnd: false,
    samples: { unknownSuffixFamilies: {}, unmatched: [] },
  };
}

/** Os dois caminhos somados, para as linhas de total do relatório. */
export function combinedCounts(stats: ResolveStats): PathCounts {
  const { eventTeams: a, slugParse: b } = stats.byPath;
  return {
    resolved: a.resolved + b.resolved,
    outcome: {
      matched: a.outcome.matched + b.outcome.matched,
      noTeamSide: a.outcome.noTeamSide + b.outcome.noTeamSide,
      unmatched: a.outcome.unmatched + b.outcome.unmatched,
      ambiguous: a.outcome.ambiguous + b.outcome.ambiguous,
    },
    role: {
      column: a.role.column + b.role.column,
      guess: a.role.guess + b.role.guess,
      learned: a.role.learned + b.role.learned,
      unknown: a.role.unknown + b.role.unknown,
    },
    needsReview: a.needsReview + b.needsReview,
    recomputable: a.recomputable + b.recomputable,
    missingBestOf: a.missingBestOf + b.missingBestOf,
  };
}

// ---------------------------------------------------------------------------
// Leitura defensiva de jsonb
// ---------------------------------------------------------------------------
//
// `event_metadata` é jsonb de vocabulário aberto, escrito por um provedor que
// mudou o formato três vezes entre março e agosto de 2026. Nada aqui pode
// assumir tipo: um número onde se esperava string derrubaria a página inteira do
// backfill por causa de um evento.

function asString(value: unknown): string | null {
  if (typeof value === 'string') return value.trim().length > 0 ? value.trim() : null;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim().length > 0) {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

// ---------------------------------------------------------------------------
// Funções puras — toda a decisão vive aqui, e é o que os testes cobrem
// ---------------------------------------------------------------------------

/**
 * `best_of` a partir do campo `score` da Gamma: `'0-0|1-2|Bo3'`.
 *
 * **Hoje isto devolve `null` para todo mundo, e não é bug deste arquivo.**
 * `gammaEventMetadata` (src/lib/normalize.ts) exclui `score` de propósito — é
 * estado ao vivo, e a coluna `event_metadata` é sobrescrita a cada ciclo, então
 * guardar placar ali seria guardar só o último valor. A spec 001 assume que
 * `best_of` sai daí; a implementação da coleta decidiu o contrário, e a decisão
 * da coleta é a que está em produção.
 *
 * A função fica porque a leitura é a mesma no dia em que houver fonte, e porque
 * `null` silencioso é pior que `null` explicado: o contador `missingBestOf`
 * denuncia o buraco em vez de deixá-lo passar por dado ausente.
 */
export function bestOfFromScore(raw: unknown): number | null {
  const score = asString(raw);
  if (score === null) return null;

  const match = score.match(/\bbo(\d+)\b/i);
  if (!match?.[1]) return null;

  const n = Number(match[1]);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * Vocabulário de outcome que não tem lado de time.
 *
 * Mercado derivado (`totals`, `kill_over_under_game`) traz `["Over","Under"]`.
 * Isso NÃO é falha de casamento — é a forma correta desse mercado.
 */
const NON_TEAM_OUTCOMES = new Set(['over', 'under', 'yes', 'no', 'draw', 'tie', 'odd', 'even']);

function normalizeLabel(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

/**
 * Casamento por token, para código de time contra nome.
 *
 * O slug dá `g2`; `outcomes.values` dá `'G2 Esports'`. Comparar por igualdade
 * não casaria nunca, e comparar por `includes` casaria `og` dentro de
 * `'Cognitive'`. Token exato é o meio-termo.
 */
function hasToken(value: string, token: string): boolean {
  return value.split(/[^a-z0-9]+/).some(part => part.length > 0 && part === token);
}

type LabelHit = { kind: 'one'; index: number } | { kind: 'none' } | { kind: 'ambiguous' };

function indexOfLabel(
  values: readonly string[],
  labels: readonly string[],
  mode: 'exact' | 'token',
): LabelHit {
  const wanted = labels.map(normalizeLabel).filter(l => l.length > 0);
  if (wanted.length === 0) return { kind: 'none' };

  const hits: number[] = [];
  for (let i = 0; i < values.length; i++) {
    const value = values[i] ?? '';
    const hit = wanted.some(label => (mode === 'exact' ? value === label : hasToken(value, label)));
    if (hit) hits.push(i);
  }

  if (hits.length === 1) return { kind: 'one', index: hits[0] as number };
  return hits.length === 0 ? { kind: 'none' } : { kind: 'ambiguous' };
}

export interface OutcomeMatch {
  kind: OutcomeKind;
  index: number | null;
}

/**
 * Qual índice de `events.outcomes.values` é o time A — resolvido POR MARKET.
 *
 * Medido: 19 de 79 eventos têm markets irmãos com `outcomes.values` em ordens
 * diferentes. O caso concreto da amostra é
 * `cs2-navi-vit-2026-05-03-map-handicap-home-2pt5`, invertido em relação aos
 * irmãos da mesma partida. Resolver o índice uma vez por PARTIDA gravaria o
 * valor errado justamente nesse tipo de market.
 *
 * Quatro saídas, e a diferença entre as três últimas é o que separa os estados:
 *
 *   `matched`      → índice conhecido;
 *   `no_team_side` → o mercado não tem lado de time. Correto, não é pendência;
 *   `unmatched`    → não casou. Recomputável (estado B) no caminho 2, anomalia
 *                    (estado A) no caminho 1;
 *   `ambiguous`    → o rótulo casou em mais de um outcome. Sempre humano: nem
 *                    mais dado nem regra nova desempatam.
 */
export function outcomeSideIndex(
  rawValues: readonly unknown[],
  labelsA: readonly string[],
  labelsB: readonly string[],
  mode: 'exact' | 'token',
): OutcomeMatch {
  const values = rawValues.map(normalizeLabel);
  if (values.length === 0) return { kind: 'unmatched', index: null };

  if (values.every(v => NON_TEAM_OUTCOMES.has(v))) return { kind: 'no_team_side', index: null };

  const a = indexOfLabel(values, labelsA, mode);
  if (a.kind === 'one') return { kind: 'matched', index: a.index };
  if (a.kind === 'ambiguous') return { kind: 'ambiguous', index: null };

  // O lado B identifica o A por exclusão, mas só no binário: com três outcomes
  // "não é o B" não diz qual dos outros dois é o A.
  const b = indexOfLabel(values, labelsB, mode);
  if (b.kind === 'one' && values.length === 2) return { kind: 'matched', index: 1 - b.index };
  if (b.kind === 'ambiguous') return { kind: 'ambiguous', index: null };

  return { kind: 'unmatched', index: null };
}

interface MetadataTeam {
  code: string;
  name: string | null;
  polymarketTeamId: number | null;
  pandascoreTeamId: number | null;
  ordering: string | null;
}

function readMetadataTeams(raw: unknown): MetadataTeam[] {
  if (!Array.isArray(raw)) return [];

  const teams: MetadataTeam[] = [];
  for (const entry of raw) {
    const record = asRecord(entry);
    if (!record) continue;

    const code = asString(record['abbreviation'])?.toLowerCase() ?? null;
    if (code === null) continue;

    teams.push({
      code,
      name: asString(record['name']),
      polymarketTeamId: asNumber(record['id']),
      pandascoreTeamId: asNumber(record['providerId']),
      ordering: asString(record['ordering'])?.toLowerCase() ?? null,
    });
  }

  return teams;
}

function orderTeams(
  teams: MetadataTeam[],
): { a: MetadataTeam; b: MetadataTeam; byField: boolean } | null {
  if (teams.length < 2) return null;

  const home = teams.find(t => t.ordering === 'home');
  const away = teams.find(t => t.ordering === 'away');
  if (home && away && home !== away) return { a: home, b: away, byField: true };

  const [first, second] = teams as [MetadataTeam, MetadataTeam];
  return { a: first, b: second, byField: false };
}

function teamFrom(verticalId: string, team: MetadataTeam): PlannedTeam {
  return {
    verticalId,
    polymarketCode: team.code,
    displayName: team.name,
    polymarketTeamId: team.polymarketTeamId,
    pandascoreTeamId: team.pandascoreTeamId,
    authoritative: true,
  };
}

/**
 * O time como o slug o conhece: código e mais nada.
 *
 * `displayName` fica null mesmo quando o registro JÁ sabe o nome. O nome é do
 * caminho 1 e é lá que ele é mantido; aqui ele serve para casar o outcome, não
 * para ser reescrito por uma linha que não o descobriu. É também por isso que a
 * escrita do caminho 2 é insert-if-absent.
 */
function codeOnlyTeam(verticalId: string, code: string): PlannedTeam {
  return {
    verticalId,
    polymarketCode: code,
    displayName: null,
    polymarketTeamId: null,
    pandascoreTeamId: null,
    authoritative: false,
  };
}

/**
 * Decide tudo sobre um evento sem tocar no banco.
 *
 * Separar isto da escrita é o que permite testar a regra de `needs_review` — o
 * produto real deste item — sem Postgres nenhum.
 */
export function planEvent(
  row: ResolvableEvent,
  verticals: readonly VerticalConfig[],
  ctx: PlanContext = {},
): PlanResult {
  if (row.slug === null) return { ok: false, reason: 'not_esports' };

  const parsed = inspectMarketSlug(row.slug, verticals);
  if (!parsed.ok) {
    return { ok: false, reason: parsed.reason === 'malformed' ? 'malformed_slug' : 'not_esports' };
  }

  const { verticalId, teamCodeA, teamCodeB, matchSlug, suffix } = parsed.parsed;

  // `enabled` é política, e é aqui que ela vale — o parser continua parseando
  // tudo, porque o validador precisa enxergar as verticais desligadas.
  const vertical = verticals.find(v => v.verticalId === verticalId);
  if (vertical && !vertical.enabled) return { ok: false, reason: 'vertical_disabled' };

  const meta = row.event_metadata ?? {};
  const outcomeValues = Array.isArray(row.outcomes?.['values']) ? row.outcomes['values'] : [];

  /** Estado A: exige humano. */
  const reviewReasons: string[] = [];
  /** Estados B e C: observado, sem fila. */
  const notes: string[] = [];

  // --- papel do mercado, comum aos dois caminhos ---------------------------
  //
  // Ordem: coluna (autoritativa) → mapa estático → mapa aprendido dos eventos
  // que TÊM a coluna. Nenhum dos três inventa vocabulário.
  const columnRole = row.sports_market_type;
  const codes = [teamCodeA, teamCodeB];
  const learnKey = roleLearnKey(suffix, codes);

  const inferred =
    columnRole !== null
      ? null
      : (guessMarketRole(suffix) ?? learnedMarketRole(learnKey, ctx.learnedRoles));

  const roleSource: RoleSource =
    columnRole !== null
      ? 'column'
      : inferred === null
        ? 'unknown'
        : guessMarketRole(suffix) !== null
          ? 'guess'
          : 'learned';

  const marketRole = columnRole ?? inferred?.role ?? UNKNOWN_ROLE;
  const roleConfidence = columnRole !== null ? 1.0 : (inferred?.confidence ?? 0.3);

  // Estado C: papel inferido ou desconhecido não gera fila. O primeiro é
  // rebaixamento de confiança; o segundo é uma regra faltando, e regra se
  // conserta no código, não no Telegram.
  if (roleSource === 'guess' || roleSource === 'learned') {
    notes.push(`papel inferido (${roleSource}): ${marketRole}`);
  }
  if (roleSource === 'unknown') {
    notes.push(`papel desconhecido, família: ${suffixFamily(suffix, codes)}`);
  }

  const metadataTeams = readMetadataTeams(meta['polymarket_teams']);
  const ordered = orderTeams(metadataTeams);

  if (ordered !== null) {
    // ---------------------------------------------------------------------
    // Caminho 1 — identidade exata
    // ---------------------------------------------------------------------
    const { a, b, byField } = ordered;

    if (!byField) {
      reviewReasons.push('teams[] sem ordering home/away — usada a ordem do array');
    }

    const sport = asString(asRecord(meta['polymarket_sport'])?.['sport'])?.toLowerCase() ?? null;
    if (sport !== null && sport !== verticalId) {
      reviewReasons.push(`vertical divergente: slug=${verticalId} polymarket_sport=${sport}`);
    }

    // A conferência que a medição autoriza (2307/2307, 0 invertidos). Quando ela
    // falha, quem manda continua sendo `teams[]` — mas o caso vira pendência.
    if (a.code !== teamCodeA || b.code !== teamCodeB) {
      reviewReasons.push(
        `códigos divergentes: slug=${teamCodeA}/${teamCodeB} teams=${a.code}/${b.code}`,
      );
    }

    const outcome = outcomeSideIndex(
      outcomeValues,
      [a.name ?? '', a.code],
      [b.name ?? '', b.code],
      'exact',
    );

    // No caminho 1 não casar É anomalia: a medição diz que `teams[].name` bate
    // exato com `outcomes.values`, e o dry-run deu 0 casos. Se aparecer, alguma
    // premissa quebrou e alguém tem que olhar.
    if (outcome.kind === 'unmatched') {
      reviewReasons.push('nomes de teams[] não casaram com outcomes.values');
    }
    if (outcome.kind === 'ambiguous') {
      reviewReasons.push('o mesmo nome casou em mais de um outcome');
    }

    const needsReview = reviewReasons.length > 0;

    const externalIds: Record<string, unknown> = {};
    const pandascore = asNumber(meta['pandascoreMatchId']);
    const grid = asNumber(meta['gridSeriesId']);
    const polymarketEventId = asString(meta['polymarket_event_id']);
    if (pandascore !== null) externalIds['pandascore_match_id'] = pandascore;
    if (grid !== null) externalIds['grid_series_id'] = grid;
    if (polymarketEventId !== null) externalIds['polymarket_event_id'] = polymarketEventId;

    return {
      ok: true,
      plan: {
        teams: [teamFrom(verticalId, a), teamFrom(verticalId, b)],
        match: {
          verticalId,
          matchSlug,
          codeA: a.code,
          codeB: b.code,
          league: asString(meta['league']),
          serie: asString(meta['serie']) ?? '',
          stage: asString(meta['tournament']),
          leagueTier: asString(meta['leagueTier']),
          bestOf: bestOfFromScore(meta['score']),
          scheduledAt: row.game_start_time,
          externalIds,
          needsReview,
          authoritative: true,
        },
        link: {
          eventId: row.id,
          matchSlug,
          marketRole,
          slugSuffix: suffix,
          outcomeAIndex: outcome.index,
          confidence: Math.min(
            outcome.kind === 'unmatched' || outcome.kind === 'ambiguous' ? 0.5 : 1.0,
            roleConfidence,
          ),
          resolutionMethod: 'event_teams',
          needsReview,
        },
        roleSource,
        outcomeKind: outcome.kind,
        reviewReasons,
        notes,
        recomputable: false,
      },
    };
  }

  // -------------------------------------------------------------------------
  // Caminho 2 — só o slug, mais o que o registro de times já souber
  // -------------------------------------------------------------------------
  //
  // Não é degradação temporária: para o evento anterior a junho/2026 este é o
  // único dado que vai existir, porque re-buscar devolve `teams: []`. O que
  // MELHORA com o tempo é o rótulo — `esports_teams.display_name` é preenchido
  // pelo caminho 1 para o mesmo `polymarket_code`, e a partir daí `navi` casa
  // com `Natus Vincere` sem ninguém digitar nada.
  notes.push('identidade derivada do slug (sem polymarket_teams)');

  const nameA = ctx.teamNames?.get(`${verticalId}|${teamCodeA}`) ?? null;
  const nameB = ctx.teamNames?.get(`${verticalId}|${teamCodeB}`) ?? null;

  // Primeiro o nome canônico, por igualdade; o código por token é a rede de
  // baixo, para quando o registro ainda não conhece o time.
  let outcome: OutcomeMatch =
    nameA !== null || nameB !== null
      ? outcomeSideIndex(outcomeValues, [nameA ?? ''], [nameB ?? ''], 'exact')
      : { kind: 'unmatched', index: null };

  if (outcome.kind === 'unmatched') {
    outcome = outcomeSideIndex(outcomeValues, [teamCodeA], [teamCodeB], 'token');
  }

  // Estado B: a causa é falta de rótulo, e a cura é uma passada nova depois que
  // o registro crescer. Humano nenhum acrescenta aqui o que a API já vai dar.
  const recomputable = outcome.kind === 'unmatched';
  if (recomputable) {
    notes.push(
      `outcome não casado: ${nameA === null && nameB === null ? 'time ainda sem nome no registro' : 'nome do registro não bate com outcomes.values'}`,
    );
  }

  // Estado A mesmo no caminho 2: ambiguidade não se resolve com mais dado.
  if (outcome.kind === 'ambiguous') {
    reviewReasons.push('o mesmo rótulo casou em mais de um outcome');
  }

  return {
    ok: true,
    plan: {
      teams: [codeOnlyTeam(verticalId, teamCodeA), codeOnlyTeam(verticalId, teamCodeB)],
      match: {
        verticalId,
        matchSlug,
        codeA: teamCodeA,
        codeB: teamCodeB,
        league: null,
        serie: '',
        stage: null,
        leagueTier: null,
        bestOf: null,
        scheduledAt: row.game_start_time,
        externalIds: {},
        needsReview: reviewReasons.length > 0,
        authoritative: false,
      },
      link: {
        eventId: row.id,
        matchSlug,
        marketRole,
        slugSuffix: suffix,
        outcomeAIndex: outcome.index,
        confidence: Math.min(
          outcome.kind === 'matched' || outcome.kind === 'no_team_side' ? 0.7 : 0.5,
          roleConfidence,
        ),
        resolutionMethod: 'slug_parse',
        needsReview: reviewReasons.length > 0,
      },
      roleSource,
      outcomeKind: outcome.kind,
      reviewReasons,
      notes,
      recomputable,
    },
  };
}

// ---------------------------------------------------------------------------
// Escrita
// ---------------------------------------------------------------------------

/**
 * A migration `20260806183705_esports_entities` é aplicada à mão (H4), e o
 * deploy do código é automático. Entre um e outro estas tabelas não existem.
 */
const PROBE_RETRY_MS = 10 * 60_000;
let tablesAvailable: boolean | null = null;
let probedAt = 0;

export function resetResolverProbe(): void {
  tablesAvailable = null;
  probedAt = 0;
}

/**
 * Exportada porque a propagação de desfecho (`match-outcome.ts`) depende das
 * MESMAS tabelas e da mesma migration. Duplicar a sonda lá dobraria as
 * requisições de verificação e daria duas respostas diferentes durante os
 * segundos do apply.
 */
export async function entityTablesAvailable(): Promise<boolean> {
  const now = Date.now();
  if (tablesAvailable === true) return true;
  if (tablesAvailable === false && now - probedAt < PROBE_RETRY_MS) return false;

  const { error } = await supabase.from('market_match_links').select('event_id').limit(1);
  probedAt = now;
  tablesAvailable = !error;

  if (error) {
    console.warn(
      `[${COMPONENT}] tabelas de entidade indisponíveis (${error.message}) — migration 20260806183705 não aplicada`,
    );
  }

  return tablesAvailable;
}

export async function loadVerticals(): Promise<VerticalConfig[] | null> {
  const { data, error } = await supabase.from('verticals').select('id, slug_prefix, enabled');

  if (error) return null;

  return (data ?? []).map(row => ({
    verticalId: row['id'] as string,
    slugPrefix: row['slug_prefix'] as string,
    enabled: row['enabled'] === true,
  }));
}

async function readBack<T>(
  table: string,
  columns: string,
  column: string,
  values: readonly string[],
  errors: string[],
): Promise<T[]> {
  const out: T[] = [];

  for (let i = 0; i < values.length; i += READ_BACK_CHUNK) {
    const chunk = values.slice(i, i + READ_BACK_CHUNK);
    const { data, error } = await supabase.from(table).select(columns).in(column, chunk);

    if (error) {
      errors.push(`releitura de ${table}: ${error.message}`);
      continue;
    }

    out.push(...((data ?? []) as unknown as T[]));
  }

  return out;
}

/**
 * O registro de nomes, para o casamento do caminho 2.
 *
 * Falha em silêncio de propósito: em dry-run pré-migration a tabela não existe,
 * e isso não é erro do backfill — é só a ausência do enriquecimento. O caminho 2
 * cai no casamento por token, que é o comportamento anterior.
 */
async function loadTeamNames(codes: readonly string[]): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  if (codes.length === 0) return names;

  for (let i = 0; i < codes.length; i += READ_BACK_CHUNK) {
    const chunk = codes.slice(i, i + READ_BACK_CHUNK);
    const { data, error } = await supabase
      .from('esports_teams')
      .select('vertical_id, polymarket_code, display_name')
      .in('polymarket_code', chunk);

    if (error) return names;

    for (const row of data ?? []) {
      const name = row['display_name'] as string | null;
      if (name === null || name.length === 0) continue;
      names.set(`${row['vertical_id'] as string}|${row['polymarket_code'] as string}`, name);
    }
  }

  return names;
}

/**
 * Cache do mapa aprendido. Uma varredura inteira usa o mesmo.
 *
 * Com validade, e não eterno: o processo do cron vive por dias, e um mapa
 * congelado no primeiro ciclo depois do deploy nunca aprenderia a família nova
 * que a Gamma publicasse depois. 6h é folgado contra o custo (uma varredura de
 * ~8 requisições sobre os eventos que têm `sports_market_type`).
 */
const LEARNED_ROLES_TTL_MS = 6 * 60 * 60_000;

let learnedRolesCache: LearnedRoles | null = null;
let learnedRolesAt = 0;

export function resetLearnedRoles(): void {
  learnedRolesCache = null;
  learnedRolesAt = 0;
}

/**
 * Aprende o papel de cada forma de sufixo a partir dos eventos que TÊM
 * `sports_market_type`.
 *
 * É o que permite mapear famílias cujo nome oficial nós não conhecemos — as
 * duas de odd/even, 2.523 markets — sem inventar rótulo. A pergunta "o que o
 * Polymarket chama isto?" já está respondida no próprio banco, nos eventos
 * recentes com a coluna preenchida.
 */
async function loadLearnedRoles(prefixes: readonly string[]): Promise<LearnedRoles> {
  const now = Date.now();
  if (learnedRolesCache !== null && now - learnedRolesAt < LEARNED_ROLES_TTL_MS) {
    return learnedRolesCache;
  }

  const observations: Array<{ learnKey: string; role: string }> = [];

  for (let offset = 0; ; offset += LEARN_PAGE_SIZE) {
    const { data, error } = await supabase
      .from('events')
      .select('slug, sports_market_type')
      .not('sports_market_type', 'is', null)
      .or(slugPrefixFilter(prefixes))
      .order('id', { ascending: true })
      .range(offset, offset + LEARN_PAGE_SIZE - 1);

    if (error) break;

    const rows = data ?? [];
    for (const row of rows) {
      const slug = row['slug'] as string | null;
      const role = row['sports_market_type'] as string | null;
      if (slug === null || role === null) continue;

      const parsed = inspectMarketSlug(slug);
      if (!parsed.ok) continue;

      observations.push({
        learnKey: roleLearnKey(parsed.parsed.suffix, [
          parsed.parsed.teamCodeA,
          parsed.parsed.teamCodeB,
        ]),
        role,
      });
    }

    if (rows.length < LEARN_PAGE_SIZE) break;
  }

  learnedRolesCache = learnRoles(observations);
  learnedRolesAt = now;
  return learnedRolesCache;
}

/**
 * Registra o resultado de uma escrita em lote.
 *
 * As chaves entram no conjunto de distintas; as linhas perdidas em chunks que
 * falharam entram no contador que fica ao lado dele. Não dá para saber QUAIS
 * linhas caíram (o `batchUpsert` reporta faixas, não linhas), e por isso o
 * relatório apresenta as duas coisas juntas em vez de fingir precisão que não
 * existe: chaves distintas enviadas, e quantas linhas não passaram.
 */
function record(
  stats: ResolveStats,
  target: Set<string>,
  keys: readonly string[],
  result: { errors: string[]; failedRows: number },
): void {
  for (const key of keys) target.add(key);
  stats.writeFailedRows += result.failedRows;
  stats.errors.push(...result.errors);
}

/**
 * Grava um lote de planos.
 *
 * Cada nível é escrito em duas famílias, e a separação impede o histórico de
 * destruir o dado bom: o que veio da API é UPSERT (atualiza), o que veio do slug
 * é INSERT ... ON CONFLICT DO NOTHING (só cria se não existir).
 */
async function persistPlans(plans: EventPlan[], stats: ResolveStats): Promise<void> {
  if (plans.length === 0) return;

  // --- times --------------------------------------------------------------
  const allTeams = plans.flatMap(p => p.teams);
  const teamKey = (t: PlannedTeam): string => `${t.verticalId}|${t.polymarketCode}`;
  const teams = dedupeByKey(
    [...allTeams].sort((x, y) => Number(x.authoritative) - Number(y.authoritative)),
    teamKey,
  );

  // `needs_review` é sempre false aqui, inclusive no time que veio só do slug.
  // Time sem nome não é time duvidoso: é time pobre, e quem o identifica é
  // `display_name IS NULL`, não uma flag de fila. O nome chega pelo caminho 1
  // quando o mesmo código aparecer num evento recente — não por digitação.
  const teamRow = (t: PlannedTeam): Record<string, unknown> => ({
    vertical_id: t.verticalId,
    polymarket_code: t.polymarketCode,
    display_name: t.displayName,
    polymarket_team_id: t.polymarketTeamId,
    pandascore_team_id: t.pandascoreTeamId,
    needs_review: false,
  });

  const authTeams = teams.filter(t => t.authoritative);
  const slugTeams = teams.filter(t => !t.authoritative);

  if (authTeams.length > 0) {
    const result = await batchUpsert('esports_teams', authTeams.map(teamRow), {
      onConflict: 'vertical_id,polymarket_code',
      label: COMPONENT,
    });
    record(stats, stats.written.teams, authTeams.map(teamKey), result);
  }

  if (slugTeams.length > 0) {
    const result = await batchUpsert('esports_teams', slugTeams.map(teamRow), {
      onConflict: 'vertical_id,polymarket_code',
      ignoreDuplicates: true,
      label: COMPONENT,
    });
    record(stats, stats.written.teams, slugTeams.map(teamKey), result);
  }

  const teamRows = await readBack<{ id: string; vertical_id: string; polymarket_code: string }>(
    'esports_teams',
    'id, vertical_id, polymarket_code',
    'polymarket_code',
    [...new Set(teams.map(t => t.polymarketCode))],
    stats.errors,
  );

  const teamIdByKey = new Map(
    teamRows.map(r => [`${r.vertical_id}|${r.polymarket_code}`, r.id] as const),
  );

  // --- ligas --------------------------------------------------------------
  const leagues = dedupeByKey(
    plans
      .map(p => p.match)
      .filter((m): m is PlannedMatch & { league: string } => m.league !== null)
      .map(m => ({ verticalId: m.verticalId, name: m.league })),
    l => `${l.verticalId}|${l.name}`,
  );

  const leagueIdByKey = new Map<string, string>();

  if (leagues.length > 0) {
    const result = await batchUpsert(
      'esports_leagues',
      leagues.map(l => ({ vertical_id: l.verticalId, name: l.name })),
      { onConflict: 'vertical_id,name', ignoreDuplicates: true, label: COMPONENT },
    );
    record(stats, stats.written.leagues, leagues.map(l => `${l.verticalId}|${l.name}`), result);

    const rows = await readBack<{ id: string; vertical_id: string; name: string }>(
      'esports_leagues',
      'id, vertical_id, name',
      'name',
      leagues.map(l => l.name),
      stats.errors,
    );
    for (const row of rows) leagueIdByKey.set(`${row.vertical_id}|${row.name}`, row.id);
  }

  // --- edições ------------------------------------------------------------
  //
  // `tier` e `is_lan` NÃO entram no payload: são colunas de decisão humana (H6),
  // e mandá-las como null apagaria a revisão de quem já revisou.
  const tournaments = dedupeByKey(
    plans
      .map(p => p.match)
      .filter(m => m.league !== null)
      .map(m => ({
        verticalId: m.verticalId,
        leagueId: leagueIdByKey.get(`${m.verticalId}|${m.league}`) ?? null,
        serie: m.serie,
      }))
      .filter(
        (t): t is { verticalId: string; leagueId: string; serie: string } => t.leagueId !== null,
      ),
    t => `${t.leagueId}|${t.serie}`,
  );

  const tournamentIdByKey = new Map<string, string>();

  if (tournaments.length > 0) {
    const result = await batchUpsert(
      'esports_tournaments',
      tournaments.map(t => ({ vertical_id: t.verticalId, league_id: t.leagueId, serie: t.serie })),
      { onConflict: 'vertical_id,league_id,serie', ignoreDuplicates: true, label: COMPONENT },
    );
    record(
      stats,
      stats.written.tournaments,
      tournaments.map(t => `${t.leagueId}|${t.serie}`),
      result,
    );

    const rows = await readBack<{ id: string; league_id: string; serie: string }>(
      'esports_tournaments',
      'id, league_id, serie',
      'league_id',
      [...new Set(tournaments.map(t => t.leagueId))],
      stats.errors,
    );
    for (const row of rows) tournamentIdByKey.set(`${row.league_id}|${row.serie}`, row.id);
  }

  // --- partidas -----------------------------------------------------------
  const matches = dedupeByKey(
    [...plans.map(p => p.match)].sort((x, y) => Number(x.authoritative) - Number(y.authoritative)),
    m => m.matchSlug,
  );

  const matchRow = (m: PlannedMatch): Record<string, unknown> => {
    const leagueId = m.league !== null ? leagueIdByKey.get(`${m.verticalId}|${m.league}`) : null;
    const tournamentId =
      leagueId != null ? (tournamentIdByKey.get(`${leagueId}|${m.serie}`) ?? null) : null;

    return {
      vertical_id: m.verticalId,
      match_slug: m.matchSlug,
      team_a_id: teamIdByKey.get(`${m.verticalId}|${m.codeA}`) ?? null,
      team_b_id: teamIdByKey.get(`${m.verticalId}|${m.codeB}`) ?? null,
      tournament_id: tournamentId,
      stage: m.stage,
      league_tier: m.leagueTier,
      best_of: m.bestOf,
      scheduled_at: m.scheduledAt,
      external_ids: m.externalIds,
      needs_review: m.needsReview,
    };
  };

  const authMatches = matches.filter(m => m.authoritative);
  const slugMatches = matches.filter(m => !m.authoritative);

  if (authMatches.length > 0) {
    const result = await batchUpsert('esports_matches', authMatches.map(matchRow), {
      onConflict: 'match_slug',
      label: COMPONENT,
    });
    record(stats, stats.written.matches, authMatches.map(m => m.matchSlug), result);
  }

  if (slugMatches.length > 0) {
    const result = await batchUpsert('esports_matches', slugMatches.map(matchRow), {
      onConflict: 'match_slug',
      ignoreDuplicates: true,
      label: COMPONENT,
    });
    record(stats, stats.written.matches, slugMatches.map(m => m.matchSlug), result);
  }

  const matchRows = await readBack<{ id: string; match_slug: string }>(
    'esports_matches',
    'id, match_slug',
    'match_slug',
    matches.map(m => m.matchSlug),
    stats.errors,
  );
  const matchIdBySlug = new Map(matchRows.map(r => [r.match_slug, r.id] as const));

  // --- links --------------------------------------------------------------
  const linkRows = plans
    .map(p => p.link)
    .map(link => {
      const matchId = matchIdBySlug.get(link.matchSlug);
      if (matchId === undefined) return null;

      return {
        event_id: link.eventId,
        match_id: matchId,
        market_role: link.marketRole,
        slug_suffix: link.slugSuffix,
        outcome_a_index: link.outcomeAIndex,
        confidence: link.confidence,
        resolution_method: link.resolutionMethod,
        needs_review: link.needsReview,
      };
    })
    .filter((row): row is NonNullable<typeof row> => row !== null);

  const orphans = plans.length - linkRows.length;
  if (orphans > 0) {
    stats.errors.push(`${orphans} eventos sem match_id após a releitura — não linkados`);
  }

  if (linkRows.length > 0) {
    const result = await batchUpsert('market_match_links', linkRows, {
      onConflict: 'event_id',
      label: COMPONENT,
    });
    record(stats, stats.written.links, linkRows.map(r => r.event_id), result);
  }
}

function countPlan(plan: EventPlan, stats: ResolveStats): void {
  const bucket =
    plan.link.resolutionMethod === 'event_teams' ? stats.byPath.eventTeams : stats.byPath.slugParse;

  bucket.resolved++;

  if (plan.outcomeKind === 'matched') bucket.outcome.matched++;
  else if (plan.outcomeKind === 'no_team_side') bucket.outcome.noTeamSide++;
  else if (plan.outcomeKind === 'ambiguous') bucket.outcome.ambiguous++;
  else bucket.outcome.unmatched++;

  bucket.role[plan.roleSource]++;
  if (plan.match.bestOf === null) bucket.missingBestOf++;
  if (plan.link.needsReview) bucket.needsReview++;
  if (plan.recomputable) bucket.recomputable++;
}

/** Teto da amostra de `unmatched`. Diagnóstico não precisa de censo. */
const MAX_UNMATCHED_SAMPLES = 20;

/** Teto de famílias distintas, contra cardinalidade patológica em memória. */
const MAX_SUFFIX_FAMILIES = 2000;

function collectSample(row: ResolvableEvent, plan: EventPlan, stats: ResolveStats): void {
  if (plan.roleSource === 'unknown') {
    const family = suffixFamily(plan.link.slugSuffix, [plan.match.codeA, plan.match.codeB]);
    const seen = stats.samples.unknownSuffixFamilies[family];

    if (seen) {
      seen.count++;
    } else if (Object.keys(stats.samples.unknownSuffixFamilies).length < MAX_SUFFIX_FAMILIES) {
      stats.samples.unknownSuffixFamilies[family] = {
        count: 1,
        example: plan.link.slugSuffix ?? '(sem sufixo)',
      };
    }
  }

  if (
    (plan.outcomeKind === 'unmatched' || plan.outcomeKind === 'ambiguous') &&
    stats.samples.unmatched.length < MAX_UNMATCHED_SAMPLES
  ) {
    const values = Array.isArray(row.outcomes?.['values']) ? row.outcomes['values'] : [];
    const [a, b] = plan.teams;

    stats.samples.unmatched.push({
      slug: row.slug ?? '(sem slug)',
      path: plan.link.resolutionMethod,
      outcomes: values.map(v => (typeof v === 'string' ? v : JSON.stringify(v))),
      labelA: a.displayName ?? a.polymarketCode,
      labelB: b.displayName ?? b.polymarketCode,
    });
  }
}

// ---------------------------------------------------------------------------
// API pública
// ---------------------------------------------------------------------------

export async function resolveEventToMatch(eventId: string): Promise<void> {
  if (!(await entityTablesAvailable())) return;

  const verticals = (await loadVerticals()) ?? enabledDefaults();

  const { data, error } = await supabase
    .from('events')
    .select(EVENT_COLUMNS)
    .eq('id', eventId)
    .maybeSingle();

  if (error || !data) {
    console.warn(`[${COMPONENT}] evento ${eventId} não lido: ${error?.message ?? 'inexistente'}`);
    return;
  }

  const row = data as unknown as ResolvableEvent;
  const parsed = row.slug === null ? null : inspectMarketSlug(row.slug, verticals);
  const codes =
    parsed?.ok === true ? [parsed.parsed.teamCodeA, parsed.parsed.teamCodeB] : [];

  const ctx: PlanContext = {
    teamNames: await loadTeamNames(codes),
    learnedRoles: await loadLearnedRoles(verticals.filter(v => v.enabled).map(v => v.slugPrefix)),
  };

  const result = planEvent(row, verticals, ctx);
  if (!result.ok) {
    console.warn(`[${COMPONENT}] evento ${eventId} não resolvido: ${result.reason}`);
    return;
  }

  const stats = emptyStats();
  countPlan(result.plan, stats);
  await persistPlans([result.plan], stats);

  if (stats.errors.length > 0) {
    console.error(`[${COMPONENT}] ${eventId}: ${stats.errors.join(' | ')}`);
  }
}

export interface ResolveOptions {
  /**
   * Planeja e conta, sem escrever nada.
   *
   * Em dry-run as tabelas de entidade nem precisam existir — dá para medir a
   * distribuição dos dois caminhos ANTES do apply.
   */
  dryRun?: boolean;

  /**
   * Coleta as amostras de `ResolveSamples`. Desligado por padrão: são
   * acumuladores em memória, e o varredor de produção roda em ciclo.
   */
  collectSamples?: boolean;

  /**
   * Reprocessa evento que já tem link — o estado B em ação.
   *
   * O caso de uso é exatamente um: depois que o caminho 1 acrescentou
   * `display_name` a times que o histórico só conhecia por código, uma passada
   * com isto ligado recalcula os `outcome_a_index` que antes ficaram nulos. Sem
   * isto o varredor pula quem já tem link, que é o certo no dia a dia.
   */
  recompute?: boolean;

  /**
   * Teto de eventos LIDOS por chamada, contra varredura sem fim.
   *
   * Diferente de `limit`, que é o teto de eventos PLANEJADOS. Ler evento que já
   * tem link é barato — nenhuma escrita, nenhum planejamento, nenhuma consulta
   * ao registro de times — e é o que o varredor faz para reencontrar o fim da
   * fila depois de um reinício.
   */
  maxScan?: number;
}

/**
 * O varredor.
 *
 * Percorre `events` em ordem de criação, em páginas, pulando o que já tem link
 * (salvo `recompute`). Ordem crescente significa que o histórico é resolvido
 * primeiro e, chegando ao fim, o cursor fica lá: os eventos novos entram depois
 * e são exatamente os próximos a serem lidos. O varredor vira incremental
 * sozinho, sem marca de "último processado" no banco.
 *
 * O cursor é offset e vive em MEMÓRIA. Um deploy o zera, e zerar é seguro por
 * dois motivos: toda escrita aqui é idempotente, e reencontrar o fim da fila
 * custa ~3 requisições por 200 eventos já linkados — nenhum planejamento,
 * nenhuma escrita, nenhuma consulta ao registro de times. Para os ~21,6k
 * eventos de hoje são ~324 requisições, uma vez por reinício.
 *
 * É por isso que `limit` conta evento PLANEJADO e não evento lido: com o teto
 * sobre leitura, uma chamada logo após o deploy gastaria o orçamento inteiro
 * pulando histórico e o mercado novo — a única coisa urgente — esperaria dezenas
 * de ciclos. Se um dia esse custo incomodar, a saída é cursor persistido em
 * `system_config`, não teto menor.
 */
let cursor = 0;

export function resetResolverCursor(): void {
  cursor = 0;
}

export async function resolveUnlinkedEvents(
  limit = 1000,
  opts: ResolveOptions = {},
): Promise<ResolveStats> {
  const stats = emptyStats();
  const dryRun = opts.dryRun === true;

  if (!dryRun && !(await entityTablesAvailable())) {
    stats.tablesMissing = true;
    return stats;
  }

  const verticals = (await loadVerticals()) ?? enabledDefaults();
  const prefixes = verticals.filter(v => v.enabled).map(v => v.slugPrefix);

  if (prefixes.length === 0) {
    stats.reachedEnd = true;
    return stats;
  }

  const learnedRoles = await loadLearnedRoles(prefixes);
  stats.learnedRoleForms = Object.keys(learnedRoles).length;

  const maxScan = opts.maxScan ?? DEFAULT_MAX_SCAN;
  let planned = 0;

  // `limit` conta EVENTO PLANEJADO, não evento lido, e a diferença aparece
  // depois de todo deploy: o cursor vive em memória, então um processo novo
  // recomeça do offset 0 e reencontra os ~21,6k eventos que já têm link. Se o
  // teto contasse leitura, o orçamento inteiro de uma chamada seria gasto
  // pulando histórico já resolvido, e o mercado novo — a única coisa urgente —
  // só seria alcançado depois de ~22 ciclos.
  //
  // Página inteiramente já linkada custa 3 requisições (a página + duas de
  // conferência de link) e nenhum planejamento, escrita ou consulta ao registro
  // de times. Percorrer 21,6k eventos assim são ~324 requisições: caro uma vez
  // por reinício, barato demais para justificar um cursor persistido.
  //
  // `maxScan` é o teto de leitura, para uma chamada nunca varrer sem fim.
  while (planned < limit && stats.scanned < maxScan) {
    const pageSize = Math.min(PAGE_SIZE, maxScan - stats.scanned);

    const { data, error } = await supabase
      .from('events')
      .select(EVENT_COLUMNS)
      .or(slugPrefixFilter(prefixes))
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .range(cursor, cursor + pageSize - 1);

    if (error) {
      stats.errors.push(`leitura de events: ${error.message}`);
      break;
    }

    const rows = (data ?? []) as unknown as ResolvableEvent[];
    if (rows.length === 0) {
      stats.reachedEnd = true;
      break;
    }

    cursor += rows.length;
    stats.scanned += rows.length;

    // Em dry-run nada foi escrito, e em recompute o link existente é justamente
    // o que se quer refazer: nos dois casos "já linkado" não é filtro.
    const linked =
      dryRun || opts.recompute === true
        ? []
        : await readBack<{ event_id: string }>(
            'market_match_links',
            'event_id',
            'event_id',
            rows.map(r => r.id),
            stats.errors,
          );
    const linkedIds = new Set(linked.map(l => l.event_id));

    const pending = rows.filter(row => {
      if (!linkedIds.has(row.id)) return true;
      stats.alreadyLinked++;
      return false;
    });

    // Página toda já linkada não custa mais nada: sem registro de times, sem
    // planejamento, sem escrita. Depois de um deploy é o caso da esmagadora
    // maioria das páginas, e era daqui que vinham consultas inúteis ao registro
    // — os códigos saíam de `rows`, não do que sobrou para planejar.
    if (pending.length === 0) {
      if (rows.length < pageSize) {
        stats.reachedEnd = true;
        break;
      }
      continue;
    }

    // Os códigos do que SERÁ planejado, numa consulta só ao registro de times.
    const pageCodes = new Set<string>();
    for (const row of pending) {
      if (row.slug === null) continue;
      const parsed = inspectMarketSlug(row.slug, verticals);
      if (parsed.ok) {
        pageCodes.add(parsed.parsed.teamCodeA);
        pageCodes.add(parsed.parsed.teamCodeB);
      }
    }

    const ctx: PlanContext = {
      teamNames: dryRun ? new Map() : await loadTeamNames([...pageCodes]),
      learnedRoles,
    };

    const plans: EventPlan[] = [];
    for (const row of pending) {
      const result = planEvent(row, verticals, ctx);
      if (!result.ok) {
        if (result.reason === 'not_esports') stats.notEsports++;
        else if (result.reason === 'vertical_disabled') stats.verticalDisabled++;
        else stats.malformedSlug++;
        continue;
      }

      countPlan(result.plan, stats);
      if (opts.collectSamples === true) collectSample(row, result.plan, stats);
      plans.push(result.plan);
      planned++;
    }

    if (!dryRun) await persistPlans(plans, stats);

    if (rows.length < pageSize) {
      stats.reachedEnd = true;
      break;
    }
  }

  return stats;
}

function enabledDefaults(): VerticalConfig[] {
  // Só quando a tabela `verticals` não responde. `cs2` é a única habilitada no
  // seed da migration, e habilitar as outras é decisão do dono (H7).
  return DEFAULT_VERTICAL_PREFIXES.map(v => ({ ...v, enabled: v.verticalId === 'cs2' }));
}
