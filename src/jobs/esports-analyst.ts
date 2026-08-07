import { supabase } from '../lib/supabase.js';
import { getSystemConfig } from '../lib/config.js';
import { logEvent, logDisabled } from '../lib/logger.js';
import { beat } from '../lib/heartbeat.js';
import { CycleLock } from '../lib/cycle-lock.js';
import {
  AnalystError,
  fingerprintFragments,
  knownModel,
  runAnalysis,
  type AnalysisResult,
  type PromptFragment,
} from '../verticals/analyst.js';
import { getPrompt } from '../verticals/analyst-prompts.js';

/**
 * Agendamento do agente analista (spec 001).
 *
 * É o único componente do sistema que gasta dinheiro por ciclo, e o desenho
 * inteiro deste arquivo sai daí: cada guarda existe para não chamar o modelo, e
 * a chamada é a última coisa que acontece.
 *
 * A ordem das guardas é a ordem do custo:
 *
 *   1. checkpoint devido e ainda não feito  — uma consulta
 *   2. fingerprint mudou desde a última     — nenhuma consulta extra
 *   3. o mercado tem preço formado          — lido dos próprios fragmentos
 *   4. sobra orçamento no dia               — uma consulta por ciclo
 *   5. chamada                              — aqui começa a gastar
 *
 * Nada disso é otimização. As três primeiras são recusas com significado, e a
 * quarta é o freio. Só o que passa pelas quatro merece uma opinião.
 */

const COMPONENT = 'esports_analyst';

/** Cron de 5 min; o prazo cobre um punhado de chamadas sequenciais. */
const CYCLE_TIMEOUT_MS = 10 * 60_000;

const cycleLock = new CycleLock(20 * 60_000);

/**
 * Quanto tempo depois do horário nominal um checkpoint ainda pode ser feito.
 *
 * Existe porque o cron tica a cada 5 min e o checkpoint é um instante. Sem
 * tolerância, um tick que caísse 30s depois perderia o checkpoint; com
 * tolerância grande demais, uma parada de 3h faria a análise "T-6h" rodar em
 * T-3h com o rótulo errado — e o rótulo errado é pior que a análise ausente,
 * porque o backtest acredita nele.
 */
const CHECKPOINT_TOLERANCE_MS = 20 * 60_000;

/** Teto de análises por ciclo. Freio contra janela mal configurada. */
const MAX_PER_CYCLE = 10;

/** Fragmentos lidos por partida antes da deduplicação por (enricher, kind). */
const FRAGMENT_READ_LIMIT = 200;

/** Respiro entre chamadas: são requisições de segundos contra a mesma API. */
const PAUSE_BETWEEN_CALLS_MS = 500;

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Tipos
// ---------------------------------------------------------------------------

export interface AnalystCandidate {
  matchId: string;
  verticalId: string;
  matchSlug: string;
  scheduledAt: string;
  bestOf: number | null;
  stage: string | null;
  teamAId: string | null;
  teamBId: string | null;
}

export interface StoredFragment {
  id: number;
  enricherId: string;
  kind: string;
  asOf: string;
  observedAt: string;
  confidence: number;
  summary: string;
  payload: unknown;
}

export interface MarketSnapshot {
  mid: number | null;
  liquidity: number | null;
  spread: number | null;
  /** Rótulo do lado a que `mid` se refere — o time A. */
  outcomeLabel: string | null;
}

export type GateVerdict =
  | { ok: true }
  | { ok: false; reason: 'no_price' | 'low_liquidity' | 'wide_spread' | 'insufficient_context'; detail: string };

export interface GateThresholds {
  minLiquidityUsd: number;
  maxSpread: number;
  minFragments: number;
}

export interface AnalystStats {
  candidates: number;
  analyzed: number;
  abstainedGate: number;
  abstainedModel: number;
  unchanged: number;
  failed: number;
  spentUsd: number;
  budgetStop: boolean;
  truncated: boolean;
  errors: string[];
}

export function emptyAnalystStats(): AnalystStats {
  return {
    candidates: 0,
    analyzed: 0,
    abstainedGate: 0,
    abstainedModel: 0,
    unchanged: 0,
    failed: 0,
    spentUsd: 0,
    budgetStop: false,
    truncated: false,
    errors: [],
  };
}

// ---------------------------------------------------------------------------
// Decisão pura
// ---------------------------------------------------------------------------

/**
 * Quais checkpoints desta partida estão vencendo agora.
 *
 * Um checkpoint de `c` minutos vence em `scheduled_at - c` e continua elegível
 * por `CHECKPOINT_TOLERANCE_MS`. Fora dessa janela ele é perdido para sempre, de
 * propósito: o checkpoint É um instante, e refazê-lo mais tarde produziria uma
 * linha rotulada "T-6h" com o que se sabia em T-3h.
 */
export function dueCheckpoints(
  now: Date,
  scheduledAt: string,
  checkpoints: readonly number[],
  toleranceMs: number,
): number[] {
  const start = new Date(scheduledAt).getTime();
  if (!Number.isFinite(start)) return [];

  const due: number[] = [];
  for (const minutes of checkpoints) {
    const at = start - minutes * 60_000;
    const age = now.getTime() - at;
    if (age >= 0 && age <= toleranceMs) due.push(minutes);
  }

  // Do mais próximo do jogo para o mais distante: se o teto por ciclo cortar,
  // corta o menos urgente.
  return due.sort((a, b) => a - b);
}

/**
 * O estado do conhecimento em `as_of`: a observação mais recente de cada
 * (enricher, kind).
 *
 * Uma observação mais nova do mesmo par substitui a anterior — o preço de agora
 * torna o preço de 30 min atrás irrelevante, e a evolução que importa já está
 * DENTRO do fragmento (as janelas de 1h/6h/24h). Mandar as duas seria pagar
 * token para o modelo reconstruir o que o enricher já reconstruiu.
 *
 * Os fragmentos chegam ordenados por `observed_at` decrescente, então a primeira
 * ocorrência de cada par é a boa.
 */
export function latestPerKind(fragments: readonly StoredFragment[]): StoredFragment[] {
  const seen = new Map<string, StoredFragment>();
  for (const fragment of fragments) {
    const key = `${fragment.enricherId}|${fragment.kind}`;
    if (!seen.has(key)) seen.set(key, fragment);
  }
  return [...seen.values()].sort((a, b) => a.enricherId.localeCompare(b.enricherId));
}

function payloadNumber(payload: unknown, key: string): number | null {
  const record = typeof payload === 'object' && payload !== null ? payload : null;
  if (record === null) return null;
  const value = (record as Record<string, unknown>)[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function payloadString(payload: unknown, key: string): string | null {
  const record = typeof payload === 'object' && payload !== null ? payload : null;
  if (record === null) return null;
  const value = (record as Record<string, unknown>)[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * O preço do mercado, lido dos PRÓPRIOS fragmentos.
 *
 * Deliberadamente não relê `esports_snapshots`. O gate e o modelo têm que ver o
 * mesmo instante — se o gate lesse o preço de agora enquanto o prompt carrega o
 * preço de `as_of`, uma análise poderia ser aprovada por uma liquidez que ela
 * nunca viu. Ler dos fragmentos torna essa divergência impossível por
 * construção, e de quebra elimina uma consulta por partida.
 */
export function marketFrom(fragments: readonly StoredFragment[]): MarketSnapshot {
  const odds = fragments.find(f => f.kind === 'odds');
  const liquidity = fragments.find(f => f.kind === 'liquidity');

  return {
    mid: odds ? payloadNumber(odds.payload, 'mid_price') : null,
    liquidity: liquidity ? payloadNumber(liquidity.payload, 'liquidity') : null,
    spread: liquidity ? payloadNumber(liquidity.payload, 'spread') : null,
    outcomeLabel: odds ? payloadString(odds.payload, 'outcome') : null,
  };
}

/**
 * Abstenção de portão: as três recusas que não precisam de modelo para serem
 * tomadas.
 *
 * Um mercado com spread de 0,90 e US$ 67 de liquidez não tem preço formado. Não
 * há com o que discordar, e uma probabilidade contra ele não é sinal — é ruído
 * com aparência de convicção. O mesmo vale para contexto que só fala de preço:
 * uma tese construída sobre a própria série é o que o backtest já faz melhor e
 * de graça.
 *
 * A ordem das checagens é a ordem em que a informação falta: sem preço, a
 * liquidez não importa; com liquidez de brinquedo, o spread não importa.
 */
export function gateDecision(
  fragments: readonly StoredFragment[],
  market: MarketSnapshot,
  thresholds: GateThresholds,
): GateVerdict {
  if (market.mid === null || market.outcomeLabel === null) {
    return {
      ok: false,
      reason: 'no_price',
      detail: 'sem fragmento de preço em as_of — nada a analisar',
    };
  }

  if (market.liquidity === null || market.liquidity < thresholds.minLiquidityUsd) {
    return {
      ok: false,
      reason: 'low_liquidity',
      detail: `liquidez ${market.liquidity === null ? 'desconhecida' : `US$ ${Math.round(market.liquidity)}`} abaixo do piso de US$ ${thresholds.minLiquidityUsd}`,
    };
  }

  // Spread nulo é o book com um lado só. Não é "desconhecido": é a forma
  // extrema do mesmo defeito que o teto de spread mede.
  if (market.spread === null || market.spread > thresholds.maxSpread) {
    return {
      ok: false,
      reason: 'wide_spread',
      detail:
        market.spread === null
          ? 'book com um lado só — não há preço de mercado, há uma ponta'
          : `spread ${market.spread.toFixed(3)} acima do teto de ${thresholds.maxSpread}`,
    };
  }

  if (fragments.length < thresholds.minFragments) {
    return {
      ok: false,
      reason: 'insufficient_context',
      detail: `${fragments.length} fragmentos, mínimo ${thresholds.minFragments} — contexto só de preço`,
    };
  }

  return { ok: true };
}

/** Rótulos curtos para citação. Números longos de id o modelo erra. */
export function toPromptFragments(fragments: readonly StoredFragment[]): PromptFragment[] {
  return fragments.map((fragment, index) => ({
    label: `F${index + 1}`,
    enricherId: fragment.enricherId,
    kind: fragment.kind,
    asOf: fragment.asOf,
    observedAt: fragment.observedAt,
    confidence: fragment.confidence,
    summary: fragment.summary,
    payload: fragment.payload,
  }));
}

// ---------------------------------------------------------------------------
// Leitura
// ---------------------------------------------------------------------------

async function loadCandidates(
  from: string,
  to: string,
): Promise<{ rows: AnalystCandidate[]; error: string | null }> {
  const { data, error } = await supabase
    .from('esports_matches')
    .select('id, vertical_id, match_slug, scheduled_at, best_of, stage, team_a_id, team_b_id')
    .gte('scheduled_at', from)
    .lte('scheduled_at', to)
    .order('scheduled_at', { ascending: true })
    .limit(200);

  if (error) return { rows: [], error: `leitura de esports_matches: ${error.message}` };

  return {
    rows: (data ?? []).map(row => ({
      matchId: row['id'] as string,
      verticalId: row['vertical_id'] as string,
      matchSlug: row['match_slug'] as string,
      scheduledAt: row['scheduled_at'] as string,
      bestOf: (row['best_of'] as number | null) ?? null,
      stage: (row['stage'] as string | null) ?? null,
      teamAId: (row['team_a_id'] as string | null) ?? null,
      teamBId: (row['team_b_id'] as string | null) ?? null,
    })),
    error: null,
  };
}

async function loadFragments(matchId: string, asOf: Date): Promise<StoredFragment[]> {
  const { data, error } = await supabase
    .from('context_fragments')
    .select('id, enricher_id, kind, as_of, observed_at, payload, summary, confidence')
    .eq('match_id', matchId)
    // O filtro que define point-in-time. `observed_at`, nunca `as_of`: fonte com
    // backfill grava hoje um fato de ontem, e filtrar pelo eixo errado
    // entregaria à análise algo que ninguém tinha naquele instante.
    .lte('observed_at', asOf.toISOString())
    .order('observed_at', { ascending: false })
    .limit(FRAGMENT_READ_LIMIT);

  if (error) {
    console.warn(`[${COMPONENT}] leitura de context_fragments falhou: ${error.message}`);
    return [];
  }

  return (data ?? []).map(row => ({
    id: Number(row['id']),
    enricherId: row['enricher_id'] as string,
    kind: row['kind'] as string,
    asOf: row['as_of'] as string,
    observedAt: row['observed_at'] as string,
    confidence: Number(row['confidence'] ?? 0),
    summary: (row['summary'] as string | null) ?? '',
    payload: row['payload'],
  }));
}

/**
 * O gasto do dia UTC corrente.
 *
 * Uma consulta por ciclo, não por análise: o acumulado da rodada é somado em
 * memória a partir daqui. Um ciclo com 10 chamadas pode estourar o teto por uma
 * fração de centavo por causa disso, e é o erro certo a aceitar — a alternativa
 * é uma consulta antes de cada chamada para proteger contra um excesso menor que
 * o custo de medi-lo.
 */
async function spentTodayUsd(): Promise<number> {
  const startOfDay = new Date();
  startOfDay.setUTCHours(0, 0, 0, 0);

  const { data, error } = await supabase
    .from('esports_analyses')
    .select('cost_usd')
    .gte('created_at', startOfDay.toISOString());

  if (error) {
    // Não dá para saber quanto já se gastou. Devolver 0 liberaria o orçamento
    // inteiro em cima de uma falha de leitura; devolver Infinity para o ciclo.
    console.error(`[${COMPONENT}] gasto do dia ilegível (${error.message}) — ciclo suspenso`);
    return Number.POSITIVE_INFINITY;
  }

  return (data ?? []).reduce((sum, row) => sum + Number(row['cost_usd'] ?? 0), 0);
}

async function loadDoneCheckpoints(matchIds: readonly string[]): Promise<Set<string>> {
  const done = new Set<string>();
  if (matchIds.length === 0) return done;

  const { data, error } = await supabase
    .from('esports_analyses')
    .select('match_id, checkpoint_minutes')
    .in('match_id', matchIds);

  if (error) {
    // Sem saber o que já foi feito, a única escolha segura é não fazer nada:
    // repetir um checkpoint custa dinheiro e a constraint única o rejeitaria
    // depois da chamada, ou seja, com o gasto já feito.
    console.error(`[${COMPONENT}] leitura de esports_analyses falhou: ${error.message}`);
    return new Set(['*']);
  }

  for (const row of data ?? []) {
    done.add(`${row['match_id'] as string}|${row['checkpoint_minutes'] as number}`);
  }
  return done;
}

async function loadTeamNames(ids: readonly string[]): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  const wanted = ids.filter((id): id is string => id !== null && id.length > 0);
  if (wanted.length === 0) return names;

  const { data, error } = await supabase
    .from('esports_teams')
    .select('id, display_name, polymarket_code')
    .in('id', wanted);

  if (error) return names;

  for (const row of data ?? []) {
    const label =
      ((row['display_name'] as string | null) ?? '').trim() ||
      (row['polymarket_code'] as string);
    names.set(row['id'] as string, label);
  }
  return names;
}

// ---------------------------------------------------------------------------
// Escrita
// ---------------------------------------------------------------------------

interface AnalysisRow {
  match_id: string;
  checkpoint_minutes: number;
  as_of: string;
  status: 'analyzed' | 'abstained' | 'unchanged';
  probability?: number | null;
  thesis?: string | null;
  confidence?: number | null;
  abstain_reason?: string | null;
  abstain_source?: 'gate' | 'model' | null;
  team_a_id: string | null;
  outcome_label: string | null;
  market_mid: number | null;
  market_liquidity: number | null;
  market_spread: number | null;
  fragment_fingerprint: string;
  fragment_count: number;
  model?: string | null;
  prompt_version: string;
  effort?: string | null;
  tokens_input?: number | null;
  tokens_output?: number | null;
  tokens_cache_read?: number | null;
  tokens_cache_write?: number | null;
  cost_usd?: number | null;
  latency_ms?: number | null;
}

/**
 * Grava a análise e, quando houver, as afirmações.
 *
 * Duas escritas e não uma transação: o PostgREST não expõe transação, e a
 * assimetria é aceitável nesta direção — análise sem claims é uma linha
 * incompleta que o eval identifica e descarta; claim sem análise seria órfã, e a
 * FK já a impede. Erro na segunda escrita é logado, não desfaz a primeira.
 */
async function persist(
  row: AnalysisRow,
  claims: ReadonlyArray<{ claim: string; fragment: StoredFragment }>,
  stats: AnalystStats,
): Promise<void> {
  const { data, error } = await supabase.from('esports_analyses').insert(row).select('id');

  if (error) {
    // 23505 = a constraint única. Outro caminho já gravou este checkpoint; não é
    // incidente, é a idempotência funcionando.
    if (error.code === '23505') return;
    stats.errors.push(`gravação de ${row.match_id}@${row.checkpoint_minutes}: ${error.message}`);
    return;
  }

  const analysisId = data?.[0]?.['id'] as string | undefined;
  if (analysisId === undefined || claims.length === 0) return;

  const { error: claimError } = await supabase.from('analysis_claims').insert(
    claims.map((entry, index) => ({
      analysis_id: analysisId,
      ordinal: index + 1,
      claim: entry.claim,
      fragment_id: entry.fragment.id,
      fragment_enricher_id: entry.fragment.enricherId,
      fragment_kind: entry.fragment.kind,
    })),
  );

  if (claimError) {
    stats.errors.push(`claims de ${analysisId}: ${claimError.message}`);
  }
}

// ---------------------------------------------------------------------------
// O ciclo
// ---------------------------------------------------------------------------

async function runCycle(): Promise<void> {
  const config = await getSystemConfig();

  if (config.esports_analyst_enabled !== true) {
    await logDisabled(COMPONENT, 'Analista desligado: esports_analyst_enabled = false');
    await beat(COMPONENT, 'success', 'desligado pela config');
    return;
  }

  const stats = emptyAnalystStats();

  // As duas guardas de configuração, antes de qualquer leitura. Modelo sem preço
  // conhecido desativaria o teto de gasto sem avisar; versão de prompt
  // inexistente gravaria linhas rotuladas com uma versão que não existe. Nos
  // dois casos o ciclo para e diz o que está errado.
  if (!knownModel(config.analyst_model)) {
    await failFast(`modelo sem preço conhecido: ${config.analyst_model}`);
    return;
  }
  if (getPrompt(config.analyst_prompt_version) === null) {
    await failFast(`versão de prompt inexistente: ${config.analyst_prompt_version}`);
    return;
  }

  const checkpoints = config.analyst_checkpoints_minutes;
  if (checkpoints.length === 0) {
    await beat(COMPONENT, 'success', 'nenhum checkpoint configurado');
    return;
  }

  const now = new Date();
  const minCp = Math.min(...checkpoints);
  const maxCp = Math.max(...checkpoints);
  const from = new Date(now.getTime() + minCp * 60_000 - CHECKPOINT_TOLERANCE_MS).toISOString();
  const to = new Date(now.getTime() + maxCp * 60_000).toISOString();

  const { rows, error } = await loadCandidates(from, to);
  if (error !== null) stats.errors.push(error);

  const done = await loadDoneCheckpoints(rows.map(r => r.matchId));
  if (done.has('*')) {
    stats.errors.push('estado de checkpoints ilegível — ciclo suspenso');
    await report(stats, checkpoints);
    return;
  }

  // (partida, checkpoint) devidos, na ordem de urgência.
  const pending: Array<{ candidate: AnalystCandidate; checkpoint: number }> = [];
  for (const candidate of rows) {
    for (const checkpoint of dueCheckpoints(
      now,
      candidate.scheduledAt,
      checkpoints,
      CHECKPOINT_TOLERANCE_MS,
    )) {
      if (!done.has(`${candidate.matchId}|${checkpoint}`)) {
        pending.push({ candidate, checkpoint });
      }
    }
  }

  stats.candidates = pending.length;
  stats.truncated = pending.length > MAX_PER_CYCLE;

  const budget = config.analyst_daily_budget_usd;
  let spent = await spentTodayUsd();

  for (const { candidate, checkpoint } of pending.slice(0, MAX_PER_CYCLE)) {
    // Parada DURA. Não há throttle nem "só mais uma": o teto atingido encerra o
    // gasto do dia, e o dia recomeça em UTC 00:00.
    if (spent >= budget) {
      stats.budgetStop = true;
      break;
    }

    const cost = await analyseOne(candidate, checkpoint, now, config, stats);
    spent += cost;
    stats.spentUsd += cost;

    await sleep(PAUSE_BETWEEN_CALLS_MS);
  }

  await report(stats, checkpoints);
}

/**
 * Uma partida, um checkpoint. Devolve quanto custou (0 quando não chamou).
 */
async function analyseOne(
  candidate: AnalystCandidate,
  checkpoint: number,
  now: Date,
  config: Awaited<ReturnType<typeof getSystemConfig>>,
  stats: AnalystStats,
): Promise<number> {
  const fragments = latestPerKind(await loadFragments(candidate.matchId, now));
  const market = marketFrom(fragments);
  const fingerprint = fingerprintFragments(
    fragments.map(f => ({ fragmentId: f.id, asOf: f.asOf })),
  );

  const base = {
    match_id: candidate.matchId,
    checkpoint_minutes: checkpoint,
    as_of: now.toISOString(),
    team_a_id: candidate.teamAId,
    outcome_label: market.outcomeLabel,
    market_mid: market.mid,
    market_liquidity: market.liquidity,
    market_spread: market.spread,
    fragment_fingerprint: fingerprint,
    fragment_count: fragments.length,
    prompt_version: config.analyst_prompt_version,
  };

  // --- o conjunto mudou? -----------------------------------------------------
  const { data: previous } = await supabase
    .from('esports_analyses')
    .select('fragment_fingerprint')
    .eq('match_id', candidate.matchId)
    .order('as_of', { ascending: false })
    .limit(1);

  if ((previous?.[0]?.['fragment_fingerprint'] as string | undefined) === fingerprint) {
    stats.unchanged++;
    await persist({ ...base, status: 'unchanged' }, [], stats);
    return 0;
  }

  // --- o mercado tem preço formado? -----------------------------------------
  const gate = gateDecision(fragments, market, {
    minLiquidityUsd: config.analyst_min_liquidity_usd,
    maxSpread: config.analyst_max_spread,
    minFragments: config.analyst_min_fragments,
  });

  if (!gate.ok) {
    stats.abstainedGate++;
    await persist(
      {
        ...base,
        status: 'abstained',
        abstain_reason: `${gate.reason}: ${gate.detail}`,
        abstain_source: 'gate',
      },
      [],
      stats,
    );
    return 0;
  }

  // --- a chamada ------------------------------------------------------------
  const promptFragments = toPromptFragments(fragments);
  const teamNames = await loadTeamNames([candidate.teamAId ?? '', candidate.teamBId ?? '']);
  const minutesToStart = Math.round(
    (new Date(candidate.scheduledAt).getTime() - now.getTime()) / 60_000,
  );

  let result: AnalysisResult;
  try {
    result = await runAnalysis({
      model: config.analyst_model,
      promptVersion: config.analyst_prompt_version,
      effort: config.analyst_effort,
      timeoutMs: config.analyst_timeout_ms,
      input: {
        matchSlug: candidate.matchSlug,
        verticalId: candidate.verticalId,
        teamA: market.outcomeLabel ?? teamNames.get(candidate.teamAId ?? '') ?? 'time A',
        teamB: teamNames.get(candidate.teamBId ?? '') ?? 'time B',
        bestOf: candidate.bestOf,
        stage: candidate.stage,
        league: null,
        scheduledAt: candidate.scheduledAt,
        asOf: now.toISOString(),
        minutesToStart,
        market: { mid: market.mid, liquidity: market.liquidity, spread: market.spread },
        fragments: promptFragments,
      },
    });
  } catch (err) {
    // Falha de validação é chamada paga e NÃO gravada. É o combinado: o gasto é
    // de centavos, a linha ruim contamina todo backtest que a leia depois. O
    // código da falha entra no log para a distribuição dele guiar o conserto —
    // `unknown_fragment` em série é problema de prompt, `truncated` é de
    // max_tokens, `api_error` não é nosso.
    stats.failed++;
    const code = err instanceof AnalystError ? err.code : 'unknown';
    stats.errors.push(`${candidate.matchSlug}@${checkpoint}: ${code} — ${String(err)}`);
    return 0;
  }

  const { output, usage, costUsd, latencyMs } = result;

  const telemetry = {
    model: config.analyst_model,
    effort: config.analyst_effort,
    tokens_input: usage.input,
    tokens_output: usage.output,
    tokens_cache_read: usage.cacheRead,
    tokens_cache_write: usage.cacheWrite,
    cost_usd: costUsd,
    latency_ms: latencyMs,
  };

  if (output.abstain) {
    stats.abstainedModel++;
    await persist(
      {
        ...base,
        ...telemetry,
        status: 'abstained',
        abstain_reason: output.abstainReason,
        abstain_source: 'model',
      },
      [],
      stats,
    );
    return costUsd ?? 0;
  }

  const byLabel = new Map(promptFragments.map((f, i) => [f.label, fragments[i] as StoredFragment]));
  const claims = output.claims
    .map(claim => ({ claim: claim.claim, fragment: byLabel.get(claim.fragment) }))
    .filter((entry): entry is { claim: string; fragment: StoredFragment } => entry.fragment !== undefined);

  stats.analyzed++;
  await persist(
    {
      ...base,
      ...telemetry,
      status: 'analyzed',
      probability: output.probability,
      thesis: output.thesis,
      confidence: output.confidence,
    },
    claims,
    stats,
  );

  return costUsd ?? 0;
}

// ---------------------------------------------------------------------------
// Relato
// ---------------------------------------------------------------------------

export function cycleStatus(stats: AnalystStats): 'success' | 'partial' {
  return stats.errors.length > 0 || stats.failed > 0 || stats.budgetStop ? 'partial' : 'success';
}

function summary(stats: AnalystStats): string {
  return (
    `${stats.candidates} devidos, ${stats.analyzed} analisadas, ` +
    `${stats.abstainedGate} abstenções de portão, ${stats.abstainedModel} do modelo, ` +
    `${stats.unchanged} sem mudança, ${stats.failed} falhas, ` +
    `US$ ${stats.spentUsd.toFixed(4)} no ciclo`
  );
}

async function report(stats: AnalystStats, checkpoints: readonly number[]): Promise<void> {
  const interesting =
    stats.analyzed > 0 ||
    stats.abstainedModel > 0 ||
    stats.failed > 0 ||
    stats.errors.length > 0 ||
    stats.budgetStop;

  if (interesting) {
    await logEvent({
      component: COMPONENT,
      status: cycleStatus(stats),
      message: `Analista: ${summary(stats)}`,
      metadata: {
        candidates: stats.candidates,
        analyzed: stats.analyzed,
        // Separados de propósito: a razão entre eles diz se o portão está
        // calibrado. Só abstenção de modelo significa portão frouxo — estamos
        // pagando para o modelo dizer o que uma condição já diria. Só de portão,
        // em volume, significa o contrário.
        abstained_gate: stats.abstainedGate,
        abstained_model: stats.abstainedModel,
        unchanged: stats.unchanged,
        failed: stats.failed,
        spent_usd: Number(stats.spentUsd.toFixed(6)),
        budget_stop: stats.budgetStop,
        truncated: stats.truncated,
        checkpoints,
        errors: stats.errors.slice(0, 5),
      },
    });
  }

  console.log(`[${COMPONENT}] ${summary(stats)}`);

  await beat(
    COMPONENT,
    cycleStatus(stats),
    stats.budgetStop
      ? 'teto de gasto do dia atingido'
      : `${stats.analyzed} analisadas, US$ ${stats.spentUsd.toFixed(4)}`,
  );
}

async function failFast(message: string): Promise<void> {
  await logEvent({
    component: COMPONENT,
    status: 'error',
    message: `Config inválida, ciclo não executado: ${message}`,
  });
  await beat(COMPONENT, 'error', message);
}

/** O ciclo de 5 min, com lock, takeover de ciclo travado e timeout. */
export async function runEsportsAnalyst(): Promise<void> {
  const lockToken = cycleLock.tryAcquire();

  if (!lockToken) {
    console.log(
      `[${COMPONENT}] ciclo anterior ainda rodando há ${Math.round((cycleLock.heldForMs() ?? 0) / 1000)}s — pulando`,
    );
    return;
  }

  if (lockToken.staleTakeoverMs !== null) {
    const stuckMinutes = Math.round(lockToken.staleTakeoverMs / 60000);
    console.warn(`[${COMPONENT}] ciclo anterior preso há ${stuckMinutes}min — assumindo`);
    await logEvent({
      component: COMPONENT,
      status: 'partial',
      message: `WARNING: ciclo anterior preso há ${stuckMinutes}min — assumido como morto`,
      metadata: { stuck_for_ms: lockToken.staleTakeoverMs },
    });
  }

  const cyclePromise = runCycle().finally(() => cycleLock.release(lockToken));

  const timeoutPromise = new Promise<void>((_, reject) =>
    setTimeout(() => reject(new Error(`cycle timeout ${CYCLE_TIMEOUT_MS}ms`)), CYCLE_TIMEOUT_MS),
  );

  try {
    await Promise.race([cyclePromise, timeoutPromise]);
  } catch (err) {
    await logEvent({
      component: COMPONENT,
      status: 'error',
      message: `Ciclo falhou: ${err instanceof Error ? err.message : String(err)}`,
      metadata: { error: String(err) },
    });
  }
}
