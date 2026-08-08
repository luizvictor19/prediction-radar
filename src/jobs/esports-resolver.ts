import { getSystemConfig } from '../lib/config.js';
import { logEvent, logDisabled } from '../lib/logger.js';
import { beat } from '../lib/heartbeat.js';
import { CycleLock } from '../lib/cycle-lock.js';
import {
  resolveUnlinkedEvents,
  resetResolverCursor,
  resetLearnedRoles,
  combinedCounts,
  writtenCounts,
  emptyStats,
  type ResolveStats,
} from '../verticals/resolver.js';

/**
 * Agendamento do resolver de esports (spec 001, item 3).
 *
 * Duas entradas com cadências muito diferentes, e um lock só entre elas:
 *
 *   INCREMENTAL (10 min) — resolve o que ainda não tem link. Em regime, é só o
 *   mercado que a descoberta trouxe desde o último ciclo: o varredor percorre
 *   `events` em ordem de criação e, chegando ao fim, fica lá.
 *
 *   RECOMPUTE (semanal) — o estado B da spec. O caminho 2 casa o outcome
 *   comparando uma contração (`navi`) com um nome ('Natus Vincere'), e falha até
 *   que o registro de times conheça o nome. Quem preenche `display_name` é o
 *   caminho 1, quando o MESMO `polymarket_code` aparece num evento recente — ou
 *   seja, o histórico melhora sozinho conforme o presente é coletado. Este job é
 *   o que colhe essa melhora.
 *
 * ## Por que um lock só para os dois
 *
 * Não é conveniência: o cursor do varredor é estado de módulo, e o recompute o
 * zera para reatravessar tudo. Se os dois rodassem ao mesmo tempo, um moveria o
 * cursor debaixo do outro e as duas varreduras pulariam páginas. Compartilhar o
 * lock é requisito de correção.
 *
 * Daí também o `staleAfterMs` de 45 min: ele tem que ser maior que o ciclo
 * legítimo mais longo, senão o tick de 10 minutos tomaria o lock de um recompute
 * que está apenas demorando.
 */

const COMPONENT = 'esports_resolver';

/**
 * Ciclo incremental. Em regime não tem nada a fazer; depois de um deploy
 * reatravessa o histórico já linkado para reencontrar o fim da fila (~324
 * requisições, sem escrita nenhuma).
 */
const CYCLE_TIMEOUT_MS = 5 * 60_000;

/** O recompute toca o universo inteiro. Timeout na ordem de grandeza disso. */
const RECOMPUTE_TIMEOUT_MS = 30 * 60_000;

/** Eventos por chamada dentro do recompute. */
const RECOMPUTE_BATCH = 1000;

/** Teto de eventos por execução do recompute, contra laço patológico. */
const RECOMPUTE_MAX_EVENTS = 100_000;

/** Respiro entre lotes do recompute: é escrita em massa contra o mesmo Postgres. */
const RECOMPUTE_PAUSE_MS = 250;

const cycleLock = new CycleLock(45 * 60_000);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * O invólucro comum: lock, takeover de ciclo travado e timeout.
 *
 * Mesmo formato dos outros jobs. O que muda entre as duas entradas é só o
 * trabalho e o prazo.
 */
async function runGuarded(
  label: string,
  timeoutMs: number,
  work: () => Promise<void>,
): Promise<void> {
  const lockToken = cycleLock.tryAcquire();

  if (!lockToken) {
    // Sem log por tick: o caso normal de colisão é o incremental encontrando o
    // recompute semanal em andamento, e isso é o lock funcionando.
    console.log(
      `[${COMPONENT}] ${label}: ciclo anterior ainda rodando há ${Math.round((cycleLock.heldForMs() ?? 0) / 1000)}s — pulando`,
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
      metadata: { stuck_for_ms: lockToken.staleTakeoverMs, entrada: label },
    });
  }

  const cyclePromise = work().finally(() => cycleLock.release(lockToken));

  const timeoutPromise = new Promise<void>((_, reject) =>
    setTimeout(() => reject(new Error(`cycle timeout ${timeoutMs}ms`)), timeoutMs),
  );

  try {
    await Promise.race([cyclePromise, timeoutPromise]);
  } catch (err) {
    await logEvent({
      component: COMPONENT,
      status: 'error',
      message: `${label} falhou: ${err instanceof Error ? err.message : String(err)}`,
      metadata: { error: String(err), entrada: label },
    });
  }
}

/**
 * Status do ciclo — mesma lição do watchlist_collector: `partial` só quando algo
 * de fato falhou.
 *
 * `tablesMissing` é `partial` e não `error` porque é estado esperado entre o
 * deploy do código e o apply da migration (H4), não incidente.
 */
export function cycleStatus(stats: ResolveStats): 'success' | 'partial' {
  return stats.errors.length > 0 ||
    stats.writeFailedRows > 0 ||
    stats.tablesMissing ||
    // Prefixo coletado e não coberto é estado degradado, não normal: há mercado
    // entrando em `events` que ninguém vai linkar. Chamar isso de `success` foi
    // o que deixou os órfãos de `lol-` crescerem de 23 para 81 sem um aviso.
    //
    // `collectOnlyPrefixes` NÃO entra: tecnicamente é a mesma situação, e é a
    // estratégia em curso. Um `partial` permanente por um estado declarado seria
    // o mesmo ruído por outro caminho — e ruído constante é como se perde a
    // capacidade de notar o degradado de verdade. O volume continua no metadata.
    stats.uncoveredPrefixes.length > 0
    ? 'partial'
    : 'success';
}

function summary(stats: ResolveStats): string {
  const all = combinedCounts(stats);
  const written = writtenCounts(stats.written);

  return (
    `${stats.scanned} lidos, ${all.resolved} resolvidos ` +
    `(c1=${stats.byPath.eventTeams.resolved} c2=${stats.byPath.slugParse.resolved}), ` +
    `${written.matches} partidas e ${written.links} links distintos, ` +
    `${all.needsReview} para revisão, ${all.recomputable} recomputáveis`
  );
}

/**
 * `lol-=81, dota2-=12` — ou só os prefixos, quando a contagem não foi feita.
 *
 * Sem contagem não inventa zero: `orphans_by_prefix` só é medido de hora em hora
 * e pode faltar (migration 20260808002747 ainda não aplicada). Um zero aqui
 * seria lido como "parou de acumular", que é a leitura que este número não pode
 * dar errada.
 */
function brief(prefixes: readonly string[], counts: Record<string, number> | null): string {
  return prefixes
    .map((p) => {
      const n = counts?.[p];
      return n === undefined ? p : `${p}=${n}`;
    })
    .join(', ');
}

function metadataOf(stats: ResolveStats): Record<string, unknown> {
  const all = combinedCounts(stats);

  return {
    scanned: stats.scanned,
    already_linked: stats.alreadyLinked,
    malformed_slug: stats.malformedSlug,
    by_path: { event_teams: stats.byPath.eventTeams, slug_parse: stats.byPath.slugParse },
    // Entidades DISTINTAS, por chave natural — não operações de upsert.
    written: writtenCounts(stats.written),
    write_failed_rows: stats.writeFailedRows,
    learned_role_forms: stats.learnedRoleForms,
    // Estado A é a fila do /review. Se este número crescer sem parar, o critério
    // regrediu para o que produzia 21.169 pendências.
    needs_review: all.needsReview,
    // Estado B: o que o recompute semanal vai tentar de novo.
    recomputable: all.recomputable,
    // Estado C: papel sem regra. Cresce ⇒ família nova no mapa.
    role_unknown: all.role.unknown,
    reached_end: stats.reachedEnd,
    reswept_from_start: stats.resweptFromStart,
    // Não vazio = a descoberta coleta um prefixo que nenhuma vertical habilitada
    // resolve E que ninguém declarou. Órfão por esquecimento: o varredor não
    // erra, ele nem enxerga.
    uncovered_prefixes: stats.uncoveredPrefixes,
    // Mesma situação técnica, decisão oposta: coletado de propósito enquanto a
    // série temporal acumula (`system_config.collect_only_prefixes`). Fica no
    // metadata para o estado ser legível, não para ser alarme.
    collect_only_prefixes: stats.collectOnlyPrefixes,
    // O volume acumulando, prefixo a prefixo, para os DOIS conjuntos. É o número
    // que diz se habilitar uma vertical vale o trabalho — e ele só existe se for
    // registrado mesmo quando não há nada de errado. Medido de hora em hora;
    // `orphans_counted_at` diz de quando é.
    orphans_by_prefix: stats.orphansByPrefix,
    orphans_counted_at: stats.orphanCountsAt,
    tables_missing: stats.tablesMissing,
    errors: stats.errors.slice(0, 5),
  };
}

async function enabled(): Promise<boolean> {
  const config = await getSystemConfig();
  return config.esports_resolver_enabled !== false;
}

/** O ciclo de 10 min. */
export async function runEsportsResolver(): Promise<void> {
  await runGuarded('incremental', CYCLE_TIMEOUT_MS, async () => {
    if (!(await enabled())) {
      await logDisabled(COMPONENT, 'Resolver desligado: esports_resolver_enabled = false');
      // Desligado pela config é ciclo completo — mesmo contrato dos coletores.
      await beat(COMPONENT, 'success', 'desligado pela config');
      return;
    }

    const config = await getSystemConfig();
    const stats = await resolveUnlinkedEvents(config.esports_resolver_batch_size);

    if (stats.tablesMissing) {
      await logEvent({
        component: COMPONENT,
        status: 'partial',
        message:
          'tabelas de entidade não existem — migration 20260806183705_esports_entities não aplicada (spec 001, H4)',
      });
      await beat(COMPONENT, 'partial', 'migration 20260806183705 não aplicada');
      return;
    }

    const all = combinedCounts(stats);

    // Uma linha a cada 10 min dizendo "nada a fazer" seriam 144/dia de nada, e
    // este projeto já teve `system_logs` em 2,7M linhas. O batimento carimba
    // saúde; o log só entra quando há o que contar.
    const uncovered = stats.uncoveredPrefixes;

    // Prefixo não coberto entra no log só na passada do reciclo (uma por hora),
    // e não a cada tick: 144 linhas/dia repetindo a mesma frase é o padrão que
    // levou `system_logs` a 2,7M linhas. O batimento carrega o aviso a cada
    // ciclo, e batimento é upsert — não cresce.
    const worthLogging =
      all.resolved > 0 ||
      stats.errors.length > 0 ||
      stats.writeFailedRows > 0 ||
      (uncovered.length > 0 && stats.resweptFromStart);

    if (worthLogging) {
      await logEvent({
        component: COMPONENT,
        status: cycleStatus(stats),
        message:
          `Resolver: ${summary(stats)}` +
          (uncovered.length > 0
            ? `. ATENÇÃO: a descoberta coleta ${uncovered.join(', ')} e nenhuma vertical ` +
              `habilitada cobre esses prefixos — esses mercados nascem órfãos. ` +
              `Habilitar a vertical em \`verticals\`, tirar o prefixo de ` +
              `\`discovery_slug_prefixes\`, ou declará-lo em ` +
              `\`collect_only_prefixes\` se a coleta sem análise for intencional; ` +
              `as três são decisão do dono.`
            : ''),
        metadata: metadataOf(stats),
      });
    }

    console.log(`[${COMPONENT}] ${summary(stats)}`);

    // "nada novo" só quando é verdade. Com prefixo descoberto e não coberto, não
    // é: existe pendência, ela só não está no universo que o varredor consulta.
    //
    // O declarado entra como sufixo neutro, nunca como o motivo do batimento: o
    // status dele é `success`, e o número está ali para ser lido, não notado. O
    // batimento é upsert de uma linha — carregar isso a cada ciclo não cresce.
    const base =
      uncovered.length > 0
        ? `${brief(uncovered, stats.orphansByPrefix)} coletado(s) sem vertical habilitada ` +
          `e sem declaração — órfãos acumulando`
        : all.resolved > 0
          ? `${all.resolved} resolvidos, ${all.needsReview} para revisão`
          : `nada novo, ${stats.scanned} lidos`;

    const detail =
      stats.collectOnlyPrefixes.length > 0
        ? `${base}; coleta declarada: ${brief(stats.collectOnlyPrefixes, stats.orphansByPrefix)}`
        : base;

    await beat(COMPONENT, cycleStatus(stats), detail);
  });
}

/**
 * O recompute semanal — estado B.
 *
 * Reprocessa quem já tem link, do começo. É a única forma de o histórico colher
 * os `display_name` que o caminho 1 acrescentou desde a última passada.
 *
 * Varre tudo em vez de só os candidatos (`outcome_a_index IS NULL AND
 * resolution_method = 'slug_parse'`) porque a diferença de custo é pequena — a
 * maior parte do universo É caminho 2 — e a varredura completa ainda pega o
 * evento cujo `event_metadata` foi enriquecido depois. Se um dia o volume
 * incomodar, o recorte por candidato é a otimização óbvia.
 */
export async function runEsportsResolverRecompute(): Promise<void> {
  await runGuarded('recompute', RECOMPUTE_TIMEOUT_MS, async () => {
    if (!(await enabled())) {
      await logDisabled(COMPONENT, 'Recompute desligado: esports_resolver_enabled = false');
      return;
    }

    // Do começo, e com o mapa de papéis reconstruído: uma passada semanal é
    // exatamente quando vale reaprender o vocabulário.
    resetResolverCursor();
    resetLearnedRoles();

    const total = emptyStats();
    let batches = 0;

    for (;;) {
      const remaining = RECOMPUTE_MAX_EVENTS - total.scanned;
      if (remaining <= 0) break;

      const page = await resolveUnlinkedEvents(Math.min(RECOMPUTE_BATCH, remaining), {
        recompute: true,
        maxScan: Math.min(RECOMPUTE_BATCH, remaining),
      });

      if (page.tablesMissing) {
        total.tablesMissing = true;
        break;
      }

      mergeInto(total, page);
      batches++;

      if (page.reachedEnd || page.scanned === 0) break;
      await sleep(RECOMPUTE_PAUSE_MS);
    }

    if (total.tablesMissing) {
      await logEvent({
        component: COMPONENT,
        status: 'partial',
        message: 'recompute abortado: tabelas de entidade não existem',
      });
      return;
    }

    const all = combinedCounts(total);

    await logEvent({
      component: COMPONENT,
      status: cycleStatus(total),
      message:
        `Recompute semanal em ${batches} lotes: ${summary(total)}. ` +
        `Restam ${all.recomputable} sem casar.`,
      metadata: { ...metadataOf(total), batches },
    });

    console.log(`[${COMPONENT}] recompute: ${summary(total)}`);
  });
}

/** Soma o que veio de um lote no acumulado da execução. */
function mergeInto(total: ResolveStats, page: ResolveStats): void {
  total.scanned += page.scanned;
  total.alreadyLinked += page.alreadyLinked;
  total.notEsports += page.notEsports;
  total.verticalDisabled += page.verticalDisabled;
  total.malformedSlug += page.malformedSlug;
  total.writeFailedRows += page.writeFailedRows;
  total.learnedRoleForms = page.learnedRoleForms;
  total.reachedEnd = page.reachedEnd;
  total.uncoveredPrefixes = page.uncoveredPrefixes;
  total.collectOnlyPrefixes = page.collectOnlyPrefixes;
  total.orphansByPrefix = page.orphansByPrefix;
  total.orphanCountsAt = page.orphanCountsAt;
  total.resweptFromStart = total.resweptFromStart || page.resweptFromStart;

  for (const path of ['eventTeams', 'slugParse'] as const) {
    const a = total.byPath[path];
    const b = page.byPath[path];
    a.resolved += b.resolved;
    a.outcome.matched += b.outcome.matched;
    a.outcome.noTeamSide += b.outcome.noTeamSide;
    a.outcome.unmatched += b.outcome.unmatched;
    a.outcome.ambiguous += b.outcome.ambiguous;
    a.role.column += b.role.column;
    a.role.guess += b.role.guess;
    a.role.learned += b.role.learned;
    a.role.unknown += b.role.unknown;
    a.needsReview += b.needsReview;
    a.recomputable += b.recomputable;
    a.missingBestOf += b.missingBestOf;
  }

  // União, não soma: a mesma partida é reenviada em toda página que tenha outro
  // market dela.
  for (const key of Object.keys(total.written) as Array<keyof typeof total.written>) {
    for (const value of page.written[key]) total.written[key].add(value);
  }

  if (total.errors.length < 50) {
    total.errors.push(...page.errors.slice(0, 50 - total.errors.length));
  }
}
