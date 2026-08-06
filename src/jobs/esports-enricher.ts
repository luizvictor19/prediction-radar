import { supabase } from '../lib/supabase.js';
import { getSystemConfig } from '../lib/config.js';
import { logEvent, logDisabled } from '../lib/logger.js';
import { beat } from '../lib/heartbeat.js';
import { CycleLock } from '../lib/cycle-lock.js';
import { fragmentsTableAvailable, runEnrichers, type ContextFragment } from '../verticals/enricher.js';
import { registerBuiltInEnrichers } from '../verticals/enrichers/index.js';
import { loadVerticals } from '../verticals/resolver.js';

/**
 * Agendamento do enriquecimento de esports (spec 001, item 5).
 *
 * Chama `runEnrichers` para as partidas próximas e é o único produtor de
 * `context_fragments`. Sem ele, os enrichers existem e nunca rodam — e como o
 * dataset de eval só pode ser montado a partir do instante em que se começou a
 * gravar, o custo de adiar este job é dado que não volta.
 *
 * ## Que partidas, e por quê essas
 *
 * Uma janela em torno de `esports_matches.scheduled_at`: 24h antes, 6h depois.
 * A escolha é sobre onde o fragmento tem valor, não sobre economia:
 *
 *   - Partida distante quase não move. O mercado nasce com liquidez de dezenas
 *     de dólares e a watchlist o relê a cada 5 min na faixa "longe" — um
 *     fragmento de T-5 dias e outro de T-4 dias dizem a mesma coisa.
 *   - 24h é a MAIOR janela que `market-history` mede. Entrar antes disso não
 *     acrescenta nenhuma medida nova, só repete as mesmas com menos série atrás.
 *   - Depois do início, a série ao vivo é a mais densa que existe e a
 *     consistência série x games só tem sentido ali. 6h cobre uma BO5 inteira
 *     mais a cauda até a resolução.
 *
 * Partida sem `scheduled_at` fica de fora: sem horário não existe "próxima".
 *
 * ## A cadência é de DECISÃO, não de tick
 *
 * `context_fragments` não é uma segunda cópia da série de preço — essa é
 * `esports_snapshots`, com resolução de 12s no ao vivo. O fragmento é a leitura
 * dela num instante de decisão. Por isso o tick do cron (5 min) não é a cadência
 * de gravação: quem decide é `esports_enricher_min_interval_minutes` (30 min por
 * padrão), e o tick só precisa ser mais rápido que ele. Mesmo desenho da
 * watchlist, onde o tick de 5s serve faixas de 12-300s.
 *
 * Esse parâmetro é o que governa o volume da tabela, e o volume é o que sustenta
 * a decisão de `context_fragments` não ser particionada. A conta está na
 * migration 20260806225235.
 */

const COMPONENT = 'esports_enricher';

/** Cron de 5 min. O prazo é folgado sobre o ciclo típico (~17 partidas). */
const CYCLE_TIMEOUT_MS = 4 * 60_000;

/**
 * Maior que o timeout, para o tick seguinte não tomar o lock de um ciclo que
 * está apenas demorando.
 */
const cycleLock = new CycleLock(15 * 60_000);

/**
 * Teto de partidas LIDAS por ciclo, antes do filtro de cadência.
 *
 * Distinto de `esports_enricher_batch_size`, que é o teto de partidas
 * ENRIQUECIDAS. A janela típica traz ~17; este número existe para que uma janela
 * mal configurada (ou uma vertical nova habilitada de uma vez) não vire uma
 * leitura sem teto.
 */
const CANDIDATE_CAP = 500;

/** Respiro entre partidas: são ~10 consultas cada, contra o mesmo Postgres. */
const PAUSE_BETWEEN_MATCHES_MS = 100;

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Tipos e decisão pura
// ---------------------------------------------------------------------------

export interface EnrichCandidate {
  matchId: string;
  verticalId: string;
  matchSlug: string | null;
  scheduledAt: string;
}

export interface EnrichStats {
  /** Partidas na janela, antes do filtro de cadência. */
  candidates: number;
  /** Puladas por terem sido enriquecidas há menos que o intervalo mínimo. */
  skippedRecent: number;
  enriched: number;
  fragments: number;
  byEnricher: Record<string, number>;
  byKind: Record<string, number>;
  /** O teto cortou partidas elegíveis. Freio que se anuncia. */
  truncated: boolean;
  /** Teto de LEITURA batido: a janela traz mais do que este job olha por ciclo. */
  candidateCapHit: boolean;
  /** Migration 20260806211531 não aplicada — nada foi gravado. */
  tableMissing: boolean;
  errors: string[];
}

export function emptyEnrichStats(): EnrichStats {
  return {
    candidates: 0,
    skippedRecent: 0,
    enriched: 0,
    fragments: 0,
    byEnricher: {},
    byKind: {},
    truncated: false,
    candidateCapHit: false,
    tableMissing: false,
    errors: [],
  };
}

/** Os limites da janela, em ISO, prontos para o filtro do PostgREST. */
export function enrichmentWindow(
  now: Date,
  lookaheadMinutes: number,
  lookbehindMinutes: number,
): { from: string; to: string } {
  return {
    from: new Date(now.getTime() - Math.max(lookbehindMinutes, 0) * 60_000).toISOString(),
    to: new Date(now.getTime() + Math.max(lookaheadMinutes, 0) * 60_000).toISOString(),
  };
}

/**
 * Quais candidatas enriquecer agora.
 *
 * Duas regras, nesta ordem: cadência (não repetir a mesma partida antes do
 * intervalo) e teto. A ordem importa — aplicar o teto antes do filtro deixaria
 * um ciclo inteiro gasto em partidas que seriam puladas, e as elegíveis
 * esperariam o ciclo seguinte.
 *
 * As candidatas chegam ordenadas por `scheduled_at` crescente, então o teto corta
 * as MAIS DISTANTES no futuro primeiro. É a direção certa: a partida que começa
 * em 20h pode esperar 5 minutos, a que está ao vivo não.
 */
export function selectMatches(
  candidates: readonly EnrichCandidate[],
  lastAttemptAt: ReadonlyMap<string, number>,
  now: Date,
  minIntervalMs: number,
  batchSize: number,
): { selected: EnrichCandidate[]; skippedRecent: number; truncated: boolean } {
  const eligible: EnrichCandidate[] = [];
  let skippedRecent = 0;

  for (const candidate of candidates) {
    const last = lastAttemptAt.get(candidate.matchId);
    if (last !== undefined && now.getTime() - last < minIntervalMs) {
      skippedRecent++;
      continue;
    }
    eligible.push(candidate);
  }

  const cap = Math.max(batchSize, 1);
  return {
    selected: eligible.slice(0, cap),
    skippedRecent,
    truncated: eligible.length > cap,
  };
}

export function countFragments(stats: EnrichStats, fragments: readonly ContextFragment[]): void {
  stats.fragments += fragments.length;

  for (const fragment of fragments) {
    stats.byEnricher[fragment.enricherId] = (stats.byEnricher[fragment.enricherId] ?? 0) + 1;
    stats.byKind[fragment.kind] = (stats.byKind[fragment.kind] ?? 0) + 1;
  }
}

export function cycleStatus(stats: EnrichStats): 'success' | 'partial' {
  // `tableMissing` é `partial` e não `error` pelo mesmo motivo do resolver: é o
  // estado esperado entre o deploy do código e o apply da migration (H4/H5).
  return stats.errors.length > 0 || stats.tableMissing ? 'partial' : 'success';
}

function summary(stats: EnrichStats): string {
  const kinds = Object.entries(stats.byKind)
    .map(([kind, n]) => `${kind}=${n}`)
    .join(' ');

  return (
    `${stats.candidates} na janela, ${stats.enriched} enriquecidas ` +
    `(${stats.skippedRecent} recentes demais), ${stats.fragments} fragmentos` +
    (kinds.length > 0 ? ` [${kinds}]` : '')
  );
}

// ---------------------------------------------------------------------------
// Estado de cadência
// ---------------------------------------------------------------------------

/**
 * Quando cada partida foi enriquecida pela última vez. Em MEMÓRIA, e é decisão.
 *
 * A alternativa seria derivar de `context_fragments` a cada ciclo — o que só
 * funcionaria pela metade: a partida cujos enrichers não produziram nada (sem
 * moneyline linkado, texto sem mudança) nunca teria fragmento, logo nunca
 * pareceria "recente", e seria retentada em todo tick para sempre. O que
 * interessa aqui é a última TENTATIVA, não a última gravação, e isso o banco não
 * registra.
 *
 * O preço de viver em memória: um deploy zera o mapa e a primeira passada
 * enriquece tudo da janela uma vez a mais. São ~17 partidas — mais barato que
 * uma tabela de cursor, e é a mesma escolha (com a mesma justificativa) que o
 * cursor do resolver faz.
 */
const lastAttemptAt = new Map<string, number>();

/** Entradas mais velhas que isto não podem mais influenciar decisão nenhuma. */
const ATTEMPT_MEMORY_MS = 24 * 60 * 60_000;

function pruneAttempts(now: number): void {
  for (const [matchId, at] of lastAttemptAt) {
    if (now - at > ATTEMPT_MEMORY_MS) lastAttemptAt.delete(matchId);
  }
}

/** Só para teste: o mapa é global ao processo. */
export function resetEnricherSchedule(): void {
  lastAttemptAt.clear();
}

/**
 * O registro dos enrichers embutidos, uma vez por processo.
 *
 * Feito aqui e não em `index.ts` para o job ser autossuficiente: um script de
 * backfill que importe só este módulo funciona sem lembrar de registrar nada.
 * `registerEnricher` levanta exceção em id duplicado, e a guarda abaixo é o que
 * mantém essa proteção valendo para o caso que ela existe para pegar — dois
 * enrichers diferentes com o mesmo id — em vez de disparar no segundo ciclo.
 */
let registered = false;

function ensureEnrichers(): void {
  if (registered) return;
  registerBuiltInEnrichers();
  registered = true;
}

// ---------------------------------------------------------------------------
// Leitura
// ---------------------------------------------------------------------------

async function loadCandidates(
  verticalIds: readonly string[],
  from: string,
  to: string,
): Promise<{ rows: EnrichCandidate[]; error: string | null }> {
  const { data, error } = await supabase
    .from('esports_matches')
    .select('id, vertical_id, match_slug, scheduled_at')
    .in('vertical_id', verticalIds)
    .gte('scheduled_at', from)
    .lte('scheduled_at', to)
    .order('scheduled_at', { ascending: true })
    .limit(CANDIDATE_CAP);

  if (error) return { rows: [], error: `leitura de esports_matches: ${error.message}` };

  return {
    rows: (data ?? []).map(row => ({
      matchId: row['id'] as string,
      verticalId: row['vertical_id'] as string,
      matchSlug: (row['match_slug'] as string | null) ?? null,
      scheduledAt: row['scheduled_at'] as string,
    })),
    error: null,
  };
}

// ---------------------------------------------------------------------------
// O ciclo
// ---------------------------------------------------------------------------

async function runCycle(): Promise<void> {
  const config = await getSystemConfig();

  if (config.esports_enricher_enabled === false) {
    await logDisabled(COMPONENT, 'Enricher desligado: esports_enricher_enabled = false');
    // Desligado pela config é ciclo completo — mesmo contrato dos coletores.
    await beat(COMPONENT, 'success', 'desligado pela config');
    return;
  }

  const stats = emptyEnrichStats();

  // A sonda antes de qualquer leitura: sem a tabela, `runEnrichers` devolveria
  // `[]` para toda partida e o ciclo gastaria dezenas de consultas para
  // descobrir isso uma vez por partida em vez de uma vez por ciclo.
  if (!(await fragmentsTableAvailable())) {
    stats.tableMissing = true;
    await logEvent({
      component: COMPONENT,
      status: 'partial',
      message:
        'context_fragments não existe — migration 20260806211531_context_fragments não aplicada (spec 001, H5)',
    });
    await beat(COMPONENT, 'partial', 'migration 20260806211531 não aplicada');
    return;
  }

  ensureEnrichers();

  const verticals = await loadVerticals();
  const enabled = (verticals ?? []).filter(v => v.enabled).map(v => v.verticalId);

  if (enabled.length === 0) {
    // Sem vertical habilitada não há o que enriquecer, e isso é configuração
    // válida (H7) — não é falha de ciclo.
    await beat(COMPONENT, 'success', 'nenhuma vertical habilitada');
    return;
  }

  const now = new Date();
  pruneAttempts(now.getTime());

  const { from, to } = enrichmentWindow(
    now,
    config.esports_enricher_lookahead_minutes,
    config.esports_enricher_lookbehind_minutes,
  );

  const { rows, error } = await loadCandidates(enabled, from, to);
  if (error !== null) stats.errors.push(error);

  stats.candidates = rows.length;
  stats.candidateCapHit = rows.length >= CANDIDATE_CAP;

  const { selected, skippedRecent, truncated } = selectMatches(
    rows,
    lastAttemptAt,
    now,
    config.esports_enricher_min_interval_minutes * 60_000,
    config.esports_enricher_batch_size,
  );

  stats.skippedRecent = skippedRecent;
  stats.truncated = truncated;

  for (const candidate of selected) {
    // Marca a TENTATIVA, e antes de tentar. Uma partida cujo enricher explode não
    // pode ser retentada a cada 5 minutos — o erro é logado por `runEnrichers`, e
    // repetir a falha em ciclo só a esconderia dentro do próprio ruído.
    lastAttemptAt.set(candidate.matchId, now.getTime());

    try {
      const fragments = await runEnrichers({
        verticalId: candidate.verticalId,
        matchId: candidate.matchId,
        // `asOf` é o presente: este é o caminho de produção, o que ACUMULA a
        // série. Replay de eval não passa por aqui — ele lê `context_fragments`
        // filtrando por `observed_at`, que é o que este job está gravando.
        asOf: now,
      });

      stats.enriched++;
      countFragments(stats, fragments);
    } catch (err) {
      stats.errors.push(
        `${candidate.matchSlug ?? candidate.matchId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    await sleep(PAUSE_BETWEEN_MATCHES_MS);
  }

  // Uma linha a cada 5 min dizendo "nada a fazer" seriam 288/dia de nada, e este
  // projeto já teve `system_logs` em 2,7M linhas. O batimento carimba saúde; o
  // log entra quando há o que contar.
  if (stats.fragments > 0 || stats.errors.length > 0 || stats.truncated) {
    await logEvent({
      component: COMPONENT,
      status: cycleStatus(stats),
      message: `Enricher: ${summary(stats)}`,
      metadata: {
        candidates: stats.candidates,
        enriched: stats.enriched,
        skipped_recent: stats.skippedRecent,
        fragments: stats.fragments,
        by_enricher: stats.byEnricher,
        by_kind: stats.byKind,
        // Freio que se anuncia: o teto cortou partidas elegíveis deste ciclo.
        truncated: stats.truncated,
        // A janela traz mais partidas do que o job lê por ciclo — sinal de
        // janela mal dimensionada, não de carga normal.
        candidate_cap_hit: stats.candidateCapHit,
        window: { from, to },
        errors: stats.errors.slice(0, 5),
      },
    });
  }

  console.log(`[${COMPONENT}] ${summary(stats)}`);

  await beat(
    COMPONENT,
    cycleStatus(stats),
    stats.fragments > 0
      ? `${stats.fragments} fragmentos em ${stats.enriched} partidas`
      : `nada a gravar, ${stats.candidates} na janela`,
  );
}

/**
 * O ciclo de 5 min, com lock, takeover de ciclo travado e timeout.
 *
 * Mesmo invólucro dos outros jobs.
 */
export async function runEsportsEnricher(): Promise<void> {
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
