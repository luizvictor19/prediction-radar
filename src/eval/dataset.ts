import { supabase } from '../lib/supabase.js';
import type { EvalPoint } from './metrics.js';

/**
 * A leitura do eval. Só SELECT — nenhuma escrita, nenhuma chamada de modelo.
 *
 * O trabalho de verdade aqui não é somar nada, é decidir o que ENTRA na amostra.
 * Uma análise só é pontuável quando o desfecho é conhecido E o lado a que a
 * probabilidade se refere fecha com o lado que venceu. Quando não fecha, a linha
 * sai da amostra e o motivo é contado — o relatório imprime a contagem, porque
 * amostra que encolhe em silêncio é a forma mais fácil de um eval mentir.
 */

const PAGE = 1000;

/** `in(...)` vira query string; lote grande estoura o limite de URL do PostgREST. */
const IN_CHUNK = 200;

type Row = Record<string, unknown>;

/**
 * O cliente Supabase é destipado neste projeto, então `data` chega como um tipo
 * que não indexa. O `as Row[]` é a mesma conversão que os outros leitores fazem
 * linha a linha, feita uma vez só aqui.
 */
interface PageResult {
  data: unknown;
  error: { message: string } | null;
}

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

/**
 * `numeric` do Postgres chega como string em algumas configurações do PostgREST.
 * `Number(null)` é 0, que aqui seria uma probabilidade de 0% inventada.
 */
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
// O que sai da amostra, e por quê
// ---------------------------------------------------------------------------

export type ExclusionReason =
  /** `abstained` ou `unchanged`: não há probabilidade para pontuar. */
  | 'sem_probabilidade'
  /** A partida ainda não foi resolvida — entra na amostra quando for. */
  | 'sem_desfecho'
  /** A análise não gravou `team_a_id`; sem lado, a probabilidade é ambígua. */
  | 'analise_sem_lado'
  /** O lado da análise não é nenhum dos dois lados da partida, ou o vencedor não é. */
  | 'lado_incoerente'
  /** Fora da vertical pedida no filtro. */
  | 'fora_do_filtro'
  /** A partida sumiu (não deveria acontecer: há FK). */
  | 'partida_ausente';

export type ExclusionCounts = Record<ExclusionReason, number>;

function emptyExclusions(): ExclusionCounts {
  return {
    sem_probabilidade: 0,
    sem_desfecho: 0,
    analise_sem_lado: 0,
    lado_incoerente: 0,
    fora_do_filtro: 0,
    partida_ausente: 0,
  };
}

export interface AbstentionRow {
  source: string;
  reason: string;
  n: number;
}

export interface ClaimStats {
  total: number;
  /** Ponteiro vivo para o fragmento. */
  withFragment: number;
  /**
   * `fragment_id` nulo. NÃO é citação inventada — ver a nota em `loadClaims`.
   */
  fragmentPruned: number;
  byEnricher: Array<{ key: string; n: number }>;
  byKind: Array<{ key: string; n: number }>;
  /** Análises `analyzed` sem nenhuma claim. Deveria ser zero; se não for, é bug. */
  analyzedWithoutClaims: number;
  analyzedTotal: number;
}

export interface FailureStats {
  /** Soma de `metadata.failed` nos ciclos do analista. Análises pagas e descartadas. */
  totalFailed: number;
  /** Códigos vistos nas amostras de erro. É LIMITE INFERIOR — ver a nota. */
  byCode: Array<{ key: string; n: number }>;
  sampledCycles: number;
  truncatedCycles: number;
}

export interface EvalDataset {
  points: EvalPoint[];
  excluded: ExclusionCounts;
  abstentions: AbstentionRow[];
  unchanged: number;
  claims: ClaimStats;
  failures: FailureStats;
  analysesRead: number;
  window: { since: string | null; until: string | null; vertical: string | null };
}

export interface EvalOptions {
  since?: string | null;
  until?: string | null;
  vertical?: string | null;
}

// ---------------------------------------------------------------------------
// Leitura
// ---------------------------------------------------------------------------

async function loadAnalyses(options: EvalOptions): Promise<Row[]> {
  return paginate((from, to) => {
    let query = supabase
      .from('esports_analyses')
      .select(
        'id, match_id, checkpoint_minutes, as_of, status, probability, ' +
          'abstain_reason, abstain_source, team_a_id, market_mid, market_liquidity, ' +
          'model, prompt_version',
      )
      .order('as_of', { ascending: true })
      .range(from, to);

    if (options.since) query = query.gte('as_of', options.since);
    if (options.until) query = query.lte('as_of', options.until);

    return query;
  });
}

async function loadMatches(matchIds: readonly string[]): Promise<Map<string, Row>> {
  const byId = new Map<string, Row>();

  for (const chunk of chunks(matchIds, IN_CHUNK)) {
    const { data, error } = await supabase
      .from('esports_matches')
      .select('id, match_slug, vertical_id, team_a_id, team_b_id, winner_team_id, resolved_at')
      .in('id', chunk);

    if (error) throw new Error(`leitura de esports_matches falhou: ${error.message}`);
    for (const row of (data ?? []) as Row[]) byId.set(row['id'] as string, row);
  }

  return byId;
}

/**
 * As claims das análises em escopo.
 *
 * Sobre `fragment_id` nulo: NÃO significa citação inventada. O agente valida
 * cada rótulo citado contra os fragmentos que entraram no prompt e a análise
 * inteira é descartada quando um não confere (`unknown_fragment` em
 * `parseAnalysis`) — ou seja, toda claim que chegou a esta tabela citava um
 * fragmento real no momento da escrita. O nulo aparece depois, quando a retenção
 * de 365 dias leva o fragmento e a FK faz `set null`.
 *
 * A consequência incomoda e é o achado mais importante desta seção: a taxa de
 * citação inventada NÃO está no banco. Ela está no contador `failed` do job e
 * nas strings de erro de `system_logs` — ver `loadFailures`.
 */
async function loadClaims(analysisIds: readonly string[]): Promise<Row[]> {
  const rows: Row[] = [];

  for (const chunk of chunks(analysisIds, IN_CHUNK)) {
    const { data, error } = await supabase
      .from('analysis_claims')
      .select('analysis_id, fragment_id, fragment_enricher_id, fragment_kind')
      .in('analysis_id', chunk);

    if (error) throw new Error(`leitura de analysis_claims falhou: ${error.message}`);
    rows.push(...((data ?? []) as Row[]));
  }

  return rows;
}

/** Códigos que `AnalystError` pode carregar. Fora desta lista, é ruído de parse. */
const FAILURE_CODES = new Set([
  'not_json',
  'schema',
  'probability_range',
  'confidence_range',
  'missing_thesis',
  'no_claims',
  'unknown_fragment',
  'refusal',
  'truncated',
  'no_text',
  'unknown_model',
  'unknown_prompt',
  'api_error',
]);

/**
 * As análises que foram pagas e descartadas, reconstruídas dos logs do job.
 *
 * `esports_analyses` só tem as que sobreviveram à validação — por desenho, para
 * não contaminar o dataset. O efeito colateral é que a taxa de rejeição, que é
 * justamente a medida de fidelidade que interessa, só existe em `system_logs`:
 * `metadata.failed` (contagem exata por ciclo) e `metadata.errors` (amostra
 * TRUNCADA em 5 por ciclo).
 *
 * Por isso a contagem por código é LIMITE INFERIOR. Um ciclo com 9 falhas
 * contribui 9 para `totalFailed` e no máximo 5 para `byCode`. `truncatedCycles`
 * diz em quantos ciclos isso aconteceu — quando for zero, os dois números
 * coincidem e a distribuição é exata.
 */
async function loadFailures(options: EvalOptions): Promise<FailureStats> {
  const rows = await paginate((from, to) => {
    let query = supabase
      .from('system_logs')
      .select('created_at, metadata')
      .eq('component', 'esports_analyst')
      .order('created_at', { ascending: true })
      .range(from, to);

    if (options.since) query = query.gte('created_at', options.since);
    if (options.until) query = query.lte('created_at', options.until);

    return query;
  });

  const byCode = new Map<string, number>();
  let totalFailed = 0;
  let sampledCycles = 0;
  let truncatedCycles = 0;

  for (const row of rows) {
    const metadata = row['metadata'] as Record<string, unknown> | null;
    if (metadata === null || typeof metadata !== 'object') continue;

    const failed = asNumber(metadata['failed']) ?? 0;
    if (failed === 0) continue;

    totalFailed += failed;
    sampledCycles += 1;

    const errors = Array.isArray(metadata['errors']) ? metadata['errors'] : [];
    if (errors.length < failed) truncatedCycles += 1;

    for (const entry of errors) {
      if (typeof entry !== 'string') continue;
      // Formato gravado pelo job: `{slug}@{checkpoint}: {code} — {erro}`.
      const code = /:\s([a-z_]+)\s—/.exec(entry)?.[1];
      if (code === undefined || !FAILURE_CODES.has(code)) continue;
      byCode.set(code, (byCode.get(code) ?? 0) + 1);
    }
  }

  return {
    totalFailed,
    byCode: [...byCode].map(([key, n]) => ({ key, n })).sort((a, b) => b.n - a.n),
    sampledCycles,
    truncatedCycles,
  };
}

// ---------------------------------------------------------------------------
// A montagem
// ---------------------------------------------------------------------------

/**
 * Decide o desfecho do ponto de vista do time A da ANÁLISE.
 *
 * Compara contra o `team_a_id` que a análise gravou, e não contra o da partida
 * hoje, porque o recompute semanal do resolver pode ter trocado os lados depois.
 * Se `team_a_id` da análise não for mais um dos dois lados da partida, ou se o
 * vencedor não for, o ponto sai da amostra — não há como orientar a
 * probabilidade sem adivinhar, e adivinhar aqui inverte o sinal do eval inteiro.
 */
export function resolveOutcome(
  analysisTeamA: string | null,
  match: { teamAId: string | null; teamBId: string | null; winnerTeamId: string | null },
): { outcome: 0 | 1 } | { excluded: ExclusionReason } {
  if (match.winnerTeamId === null) return { excluded: 'sem_desfecho' };
  if (analysisTeamA === null) return { excluded: 'analise_sem_lado' };

  const sides = [match.teamAId, match.teamBId].filter((id): id is string => id !== null);
  if (!sides.includes(analysisTeamA) || !sides.includes(match.winnerTeamId)) {
    return { excluded: 'lado_incoerente' };
  }
  // Dois lados iguais não é partida; sem isto o desfecho seria sempre 1.
  if (match.teamAId === match.teamBId) return { excluded: 'lado_incoerente' };

  return { outcome: match.winnerTeamId === analysisTeamA ? 1 : 0 };
}

export async function loadEvalDataset(options: EvalOptions = {}): Promise<EvalDataset> {
  const analyses = await loadAnalyses(options);
  const excluded = emptyExclusions();

  const matches = await loadMatches([...new Set(analyses.map((row) => row['match_id'] as string))]);

  const points: EvalPoint[] = [];
  const abstentions = new Map<string, AbstentionRow>();
  const analyzedIds: string[] = [];
  let unchanged = 0;

  for (const row of analyses) {
    const status = row['status'] as string;
    const match = matches.get(row['match_id'] as string);

    if (match === undefined) {
      excluded.partida_ausente += 1;
      continue;
    }

    if (options.vertical && match['vertical_id'] !== options.vertical) {
      excluded.fora_do_filtro += 1;
      continue;
    }

    if (status === 'unchanged') {
      unchanged += 1;
      excluded.sem_probabilidade += 1;
      continue;
    }

    if (status === 'abstained') {
      const source = asString(row['abstain_source']) ?? 'desconhecida';
      const reason = asString(row['abstain_reason']) ?? 'sem motivo';
      const key = `${source} ${reason}`;
      const existing = abstentions.get(key);
      if (existing === undefined) abstentions.set(key, { source, reason, n: 1 });
      else existing.n += 1;

      excluded.sem_probabilidade += 1;
      continue;
    }

    const probability = asNumber(row['probability']);
    if (probability === null) {
      // O CHECK do banco impede analyzed sem probabilidade; se chegou aqui, a
      // linha é anterior ao CHECK ou veio por outro caminho.
      excluded.sem_probabilidade += 1;
      continue;
    }

    analyzedIds.push(row['id'] as string);

    const resolved = resolveOutcome(asString(row['team_a_id']), {
      teamAId: asString(match['team_a_id']),
      teamBId: asString(match['team_b_id']),
      winnerTeamId: asString(match['winner_team_id']),
    });

    if ('excluded' in resolved) {
      excluded[resolved.excluded] += 1;
      continue;
    }

    points.push({
      analysisId: row['id'] as string,
      matchSlug: (match['match_slug'] as string | null) ?? '(sem slug)',
      checkpointMinutes: Number(row['checkpoint_minutes']),
      asOf: row['as_of'] as string,
      model: asString(row['model']),
      promptVersion: asString(row['prompt_version']) ?? '(sem versão)',
      probability,
      marketMid: asNumber(row['market_mid']),
      liquidity: asNumber(row['market_liquidity']),
      outcome: resolved.outcome,
    });
  }

  const claimRows = analyzedIds.length > 0 ? await loadClaims(analyzedIds) : [];
  const failures = await loadFailures(options);

  return {
    points,
    excluded,
    abstentions: [...abstentions.values()].sort((a, b) => b.n - a.n),
    unchanged,
    claims: summariseClaims(claimRows, analyzedIds),
    failures,
    analysesRead: analyses.length,
    window: {
      since: options.since ?? null,
      until: options.until ?? null,
      vertical: options.vertical ?? null,
    },
  };
}

function summariseClaims(rows: readonly Row[], analyzedIds: readonly string[]): ClaimStats {
  const byEnricher = new Map<string, number>();
  const byKind = new Map<string, number>();
  const withClaims = new Set<string>();

  let withFragment = 0;
  let fragmentPruned = 0;

  for (const row of rows) {
    withClaims.add(row['analysis_id'] as string);

    if (row['fragment_id'] === null || row['fragment_id'] === undefined) fragmentPruned += 1;
    else withFragment += 1;

    const enricher = asString(row['fragment_enricher_id']) ?? '(sem enricher)';
    const kind = asString(row['fragment_kind']) ?? '(sem tipo)';
    byEnricher.set(enricher, (byEnricher.get(enricher) ?? 0) + 1);
    byKind.set(kind, (byKind.get(kind) ?? 0) + 1);
  }

  const rank = (map: Map<string, number>): Array<{ key: string; n: number }> =>
    [...map].map(([key, n]) => ({ key, n })).sort((a, b) => b.n - a.n);

  return {
    total: rows.length,
    withFragment,
    fragmentPruned,
    byEnricher: rank(byEnricher),
    byKind: rank(byKind),
    analyzedWithoutClaims: analyzedIds.filter((id) => !withClaims.has(id)).length,
    analyzedTotal: analyzedIds.length,
  };
}
