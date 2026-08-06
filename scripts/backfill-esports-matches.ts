import 'dotenv/config';
import {
  resolveUnlinkedEvents,
  resetResolverCursor,
  resetLearnedRoles,
  emptyStats,
  combinedCounts,
  writtenCounts,
  type ResolveStats,
  type PathCounts,
} from '../src/verticals/resolver.js';

/**
 * Backfill da resolução mercado → partida (spec 001, item 3).
 *
 * Varre `events` do mais antigo para o mais novo, resolve cada market de esports
 * pelo caminho que o dado permitir e grava times, ligas, edições, partidas e
 * links. É idempotente: rodar duas vezes reescreve exatamente as mesmas linhas,
 * porque toda escrita é upsert por chave natural.
 *
 * ## Ordem recomendada
 *
 *   1. `--dry-run` ANTES de aplicar a migration. Não escreve nada e não precisa
 *      das tabelas de entidade — só lê `events`. O que ele imprime é a resposta
 *      da primeira query de verificação pendente da spec: quanto do universo cai
 *      no caminho exato e quanto cai no fallback.
 *   2. o dono aplica a migration `20260806183705_esports_entities` (H4);
 *   3. a rodada real, sem flag.
 *
 * ## O que esperar do resultado
 *
 * As duas metas da spec são separadas de propósito, porque misturá-las esconderia
 * regressão no caminho novo atrás do ruído do histórico:
 *
 *   eventos COM `polymarket_teams`  → >= 99% linkados, sem revisão
 *   eventos SEM (histórico)         → >= 90% linkados, revisão esperada
 *
 * A fila do `/review` (estado A) tem que nascer PEQUENA. A primeira versão
 * marcava todo o caminho 2 e produziu 21.169 linhas — fila que ninguém quita é
 * fila que esconde as pendências reais. Hoje só entra nela o que exige humano:
 * conflito entre slug e `teams[]`, casamento ambíguo, `teams[]` sem `ordering`,
 * e outcome não casado no caminho 1.
 *
 * O resto tem destino próprio:
 *
 *   estado B — outcome não casado no caminho 2. A causa é comparar `navi` com
 *   'Natus Vincere'. Some sozinho quando o registro de times ganha o nome pelo
 *   caminho 1; `--recompute` é o que reprocessa esses links.
 *
 *   estado C — sufixo sem papel, agregado por família no fim do relatório. Vira
 *   regra nova no mapa, não confirmação linha a linha.
 *
 * Uso:
 *   npm run backfill:esports-matches -- --dry-run
 *   npm run backfill:esports-matches -- --limit=2000
 *   npm run backfill:esports-matches
 *   npm run backfill:esports-matches -- --recompute    # depois, para o estado B
 */

const LABEL = 'backfill-esports';

/** Eventos por chamada ao resolver. Cada chamada é ~10 round-trips no PostgREST. */
const BATCH_SIZE = 1000;

function flag(name: string): string | null {
  const hit = process.argv.slice(2).find(arg => arg === `--${name}` || arg.startsWith(`--${name}=`));
  if (hit === undefined) return null;
  const [, value] = hit.split('=');
  return value ?? '';
}

function mergePath(total: PathCounts, page: PathCounts): void {
  total.resolved += page.resolved;
  total.outcome.matched += page.outcome.matched;
  total.outcome.noTeamSide += page.outcome.noTeamSide;
  total.outcome.unmatched += page.outcome.unmatched;
  total.outcome.ambiguous += page.outcome.ambiguous;
  total.role.column += page.role.column;
  total.role.guess += page.role.guess;
  total.role.learned += page.role.learned;
  total.role.unknown += page.role.unknown;
  total.needsReview += page.needsReview;
  total.recomputable += page.recomputable;
  total.missingBestOf += page.missingBestOf;
}

function merge(total: ResolveStats, page: ResolveStats): void {
  total.scanned += page.scanned;
  total.alreadyLinked += page.alreadyLinked;
  total.notEsports += page.notEsports;
  total.verticalDisabled += page.verticalDisabled;
  total.malformedSlug += page.malformedSlug;
  mergePath(total.byPath.eventTeams, page.byPath.eventTeams);
  mergePath(total.byPath.slugParse, page.byPath.slugParse);
  total.learnedRoleForms = page.learnedRoleForms;

  for (const [family, seen] of Object.entries(page.samples.unknownSuffixFamilies)) {
    const known = total.samples.unknownSuffixFamilies[family];
    if (known) known.count += seen.count;
    else total.samples.unknownSuffixFamilies[family] = { ...seen };
  }

  for (const sample of page.samples.unmatched) {
    if (total.samples.unmatched.length < 20) total.samples.unmatched.push(sample);
  }

  // União, não soma: a mesma partida aparece em várias páginas — uma por market
  // dela — e somar foi exatamente o que reportou 4.139 partidas onde há 2.557.
  for (const key of Object.keys(total.written) as Array<keyof typeof total.written>) {
    for (const value of page.written[key]) total.written[key].add(value);
  }

  total.writeFailedRows += page.writeFailedRows;
  // Teto no acumulado: 14k eventos com o banco fora do ar encheriam a memória de
  // string de erro antes de alguém ler a primeira.
  if (total.errors.length < 50) {
    total.errors.push(...page.errors.slice(0, 50 - total.errors.length));
  }
  total.reachedEnd = page.reachedEnd;
}

function pct(part: number, whole: number): string {
  return whole === 0 ? '—' : `${((part / whole) * 100).toFixed(1)}%`;
}

async function main(): Promise<void> {
  const dryRun = flag('dry-run') !== null;
  const recompute = flag('recompute') !== null;
  const limitArg = flag('limit');
  const limit = limitArg !== null && limitArg.length > 0 ? Number(limitArg) : Infinity;

  if (Number.isNaN(limit) || limit <= 0) {
    console.error(`[${LABEL}] --limit inválido: ${String(limitArg)}`);
    process.exit(1);
  }

  console.log(
    `[${LABEL}] iniciando${dryRun ? ' EM DRY-RUN (nada será escrito)' : ''}` +
      `${recompute ? ' EM RECOMPUTE (reprocessa quem já tem link)' : ''}` +
      `${Number.isFinite(limit) ? `, teto de ${limit} eventos` : ''}`,
  );

  resetResolverCursor();
  // O mapa aprendido é cacheado por processo. Zerar aqui garante que uma
  // rodada nova o reconstrua a partir do estado atual da coluna.
  resetLearnedRoles();

  const total = emptyStats();
  let batches = 0;

  for (;;) {
    const remaining = Number.isFinite(limit) ? limit - total.scanned : Infinity;
    if (remaining <= 0) break;

    // As amostras só no dry-run: são acumuladores em memória, e o objetivo delas
    // é diagnóstico antes da escrita.
    // `--limit` do script é teto de eventos LIDOS — é um ensaio, e o que se
    // quer limitar é o quanto ele toca. Por isso vai nos dois parâmetros.
    const page = await resolveUnlinkedEvents(Math.min(BATCH_SIZE, remaining), {
      dryRun,
      collectSamples: dryRun,
      recompute,
      maxScan: remaining,
    });

    if (page.tablesMissing) {
      console.error(
        `[${LABEL}] as tabelas de entidade não existem — a migration ` +
          `20260806183705_esports_entities ainda não foi aplicada (spec 001, H4).\n` +
          `[${LABEL}] rode com --dry-run para medir a distribuição sem elas.`,
      );
      process.exit(1);
    }

    merge(total, page);
    batches++;

    console.log(
      `[${LABEL}] lote ${batches}: ${total.scanned} eventos varridos — ` +
        `exato=${total.byPath.eventTeams.resolved} slug=${total.byPath.slugParse.resolved} ` +
        `já_linkado=${total.alreadyLinked} ` +
        `revisão=${total.byPath.eventTeams.needsReview + total.byPath.slugParse.needsReview}`,
    );

    if (page.errors.length > 0) {
      for (const err of page.errors.slice(0, 3)) console.error(`[${LABEL}]   erro: ${err}`);
    }

    if (page.reachedEnd) break;
    // Página inteira sem nada planejado nem escrito é sintoma de laço parado —
    // o cursor avança sempre, então isto só acontece se o resolver não estiver
    // consumindo. Melhor abortar que girar sobre 14k eventos.
    if (page.scanned === 0) break;
  }

  const all = combinedCounts(total);
  const one = total.byPath.eventTeams;
  const two = total.byPath.slugParse;
  const written = writtenCounts(total.written);

  // A razão que explica a inflação do relatório antigo, e que por si só é um
  // número útil: a spec mediu ~6,8 markets por partida.
  const marketsPerMatch =
    written.matches === 0
      ? ''
      : `\n    markets/partida ...... ${(written.links / written.matches).toFixed(1)}`;

  /** Uma linha com o total e a quebra pelos dois caminhos. */
  const line = (
    label: string,
    pick: (p: PathCounts) => number,
    nota = '',
  ): string => {
    const t = pick(all);
    return (
      `  ${label.padEnd(24, '.')} ${String(t).padStart(6)} (${pct(t, all.resolved).padStart(6)})` +
      `   c1=${String(pick(one)).padStart(5)} c2=${String(pick(two)).padStart(6)}${nota}`
    );
  };

  console.log(`
[${LABEL}] ================= RESUMO =================
  varridos ............... ${total.scanned}
  já linkados (pulados) .. ${total.alreadyLinked}
  não-esports ............ ${total.notEsports}
  vertical desligada ..... ${total.verticalDisabled}
  slug fora do padrão .... ${total.malformedSlug}   <- sem match_slug, não vira linha nenhuma

  RESOLVIDOS ............. ${all.resolved}
    caminho 1 (teams[]) .. ${one.resolved} (${pct(one.resolved, all.resolved)})
    caminho 2 (slug) ..... ${two.resolved} (${pct(two.resolved, all.resolved)})

  Cada linha abaixo: TOTAL (% dos resolvidos)   c1=caminho 1  c2=caminho 2

  outcome_a_index
${line('casado', p => p.outcome.matched)}
${line('sem lado de time', p => p.outcome.noTeamSide, '   <- correto')}
${line('não casou', p => p.outcome.unmatched, '   <- c1 anomalia / c2 recomputável')}
${line('ambíguo', p => p.outcome.ambiguous, '   <- humano')}

  papel do mercado          (${total.learnedRoleForms} formas aprendidas da coluna)
${line('da coluna', p => p.role.column)}
${line('inferido (estático)', p => p.role.guess)}
${line('inferido (aprendido)', p => p.role.learned)}
${line('desconhecido', p => p.role.unknown, '   <- estado C')}

${line('sem best_of', p => p.missingBestOf)}
      \`score\` não é gravado em event_metadata — ver bestOfFromScore.

  os três estados
${line('A: revisão humana', p => p.needsReview, '   <- a fila do /review')}
${line('B: recomputável', p => p.recomputable, '   <- --recompute resolve')}
      C: papel desconhecido, agregado por família no fim deste relatório.

  entidades DISTINTAS tocadas${dryRun ? ' (DRY-RUN: nada foi escrito)' : ''}
    times ................ ${written.teams}
    ligas ................ ${written.leagues}
    edições .............. ${written.tournaments}
    partidas ............. ${written.matches}
    links ................ ${written.links}${marketsPerMatch}
      Chave natural distinta, não operações de upsert: a mesma partida é
      reenviada em cada página que tenha outro market dela, e metade das
      escritas é ON CONFLICT DO NOTHING. Com \`linhas perdidas\` em zero, estes
      números são o que existe no banco.

  linhas perdidas ........ ${total.writeFailedRows}
  erros .................. ${total.errors.length}
  varredura completa ..... ${total.reachedEnd ? 'sim' : 'não (teto atingido)'}
==========================================`);

  const families = Object.entries(total.samples.unknownSuffixFamilies).sort(
    (a, b) => b[1].count - a[1].count,
  );

  if (families.length > 0) {
    const mapped = families.slice(0, 40).reduce((acc, [, v]) => acc + v.count, 0);

    console.log(`
[${LABEL}] ===== SUFIXOS SEM PAPEL: TOP 40 FAMÍLIAS =====
  ${families.length} famílias distintas, ${all.role.unknown} markets no total.
  As 40 abaixo cobrem ${mapped} (${pct(mapped, all.role.unknown)}) deles.
  Números normalizados: N = inteiro, X = decimal do tipo 2pt5.
`);

    for (const [family, seen] of families.slice(0, 40)) {
      console.log(
        `  ${String(seen.count).padStart(6)}  ${family.padEnd(44)}  ex: ${seen.example}`,
      );
    }
  }

  if (total.samples.unmatched.length > 0) {
    console.log(`
[${LABEL}] ===== OUTCOME NÃO CASADO: AMOSTRA =====
  O rótulo é o que se tentou casar: nome do time no caminho 1, código no 2.
`);

    for (const sample of total.samples.unmatched) {
      console.log(`  [${sample.path}] ${sample.slug}`);
      console.log(`      rótulos:  ${sample.labelA}  |  ${sample.labelB}`);
      console.log(`      outcomes: ${JSON.stringify(sample.outcomes)}`);
    }
  }

  for (const err of total.errors.slice(0, 10)) console.error(`[${LABEL}] erro: ${err}`);

  if (total.errors.length > 0) process.exit(1);
}

main().catch(err => {
  console.error(`[${LABEL}] Fatal:`, err);
  process.exit(1);
});
