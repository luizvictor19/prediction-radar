import { estimateCostUsd, hashDescription } from '../../../src/digest/digest.js';
import { contemTrecho } from '../../../web/src/lib/dedup.js';
import { CAUSAS, causaDe } from './digest-nulo.js';
import { montarLinhas, type Ambiguidade, type Classe, type Pegadinha } from './digestao.js';

/**
 * Issue #58: claude-haiku-5-5 against deepseek-v4-flash on the same rule texts.
 *
 * Pure: no filesystem, no network, no database. The runner is
 * `scripts/medicoes/haiku-vs-deepseek.ts`; everything here is what the test can
 * hold still. The DeepSeek side is never called again: its baseline is the
 * August v4 readings already in `market_rule_digests`.
 */

// ---------------------------------------------------------------------------
// The DeepSeek readings, as the database holds them
// ---------------------------------------------------------------------------

export interface LeituraDeepseek {
  id: string;
  eventId: string;
  sha: string;
  criadoEm: string;
  /** Every prompt token the call was billed for: uncached, cache read and cache write. */
  tokensEntrada: number;
  tokensSaida: number;
  custoUsd: number | null;
}

/** Oldest first, ties by id: the same order on every run, so "the first two" is stable. */
function cronologica(a: LeituraDeepseek, b: LeituraDeepseek): number {
  return a.criadoEm.localeCompare(b.criadoEm) || a.id.localeCompare(b.id);
}

// ---------------------------------------------------------------------------
// The sample
// ---------------------------------------------------------------------------

export interface TextoAmostrado {
  sha: string;
  /** The market whose question, slug, end date and outcomes go into the Haiku prompt. */
  eventId: string;
  /** The two DeepSeek digests that form the two-reading baseline. */
  par: [string, string];
  /**
   * Both baseline readings came from the same market. When not, they saw the
   * same rule under different questions, and part of their disagreement is the
   * prompt and not the model (the caveat of `medir-consistencia`).
   */
  parMesmoMercado: boolean;
  /** All v4 DeepSeek readings of the text, not only the pair. */
  leiturasDeepseek: number;
}

export interface Sorteio {
  amostra: TextoAmostrado[];
  elegiveis: number;
  textos: number;
  /** Why texts did not qualify. Every count is printed, zero included. */
  fora: { semTexto: number; hashNaoBate: number; umaLeitura: number; foraDoRadar: number };
}

/**
 * The sample: `n` texts, drawn by hash with a fixed seed.
 *
 * The draw is a sort by `sha256("<seed>:<text hash>")`, not a PRNG walk over a
 * list. It depends only on the seed and on which texts qualify, never on the
 * order the database returned them, so `--dry-run` and the run see the same
 * texts even if pagination order changes in between.
 *
 * A text qualifies when (1) its stored text hashes back to its key, so Haiku
 * reads the exact bytes DeepSeek read; (2) it has at least two readings, so the
 * baseline has a pair; (3) at least one of its markets is still in the radar,
 * because the prompt also carries the market's question and the radar read is
 * the existing, indexed way to get it.
 */
export function sortearTextos(params: {
  leituras: readonly LeituraDeepseek[];
  textosGuardados: ReadonlyMap<string, string>;
  mercadosNoRadar: ReadonlySet<string>;
  semente: number;
  n: number;
}): Sorteio {
  const porTexto = new Map<string, LeituraDeepseek[]>();
  for (const l of params.leituras) {
    const lista = porTexto.get(l.sha);
    if (lista === undefined) porTexto.set(l.sha, [l]);
    else lista.push(l);
  }

  const fora = { semTexto: 0, hashNaoBate: 0, umaLeitura: 0, foraDoRadar: 0 };
  const elegiveis: TextoAmostrado[] = [];

  for (const [sha, leituras] of porTexto) {
    const texto = params.textosGuardados.get(sha);
    if (texto === undefined) {
      fora.semTexto += 1;
      continue;
    }
    if (hashDescription(texto) !== sha) {
      fora.hashNaoBate += 1;
      continue;
    }
    if (leituras.length < 2) {
      fora.umaLeitura += 1;
      continue;
    }

    const ordenadas = [...leituras].sort(cronologica);
    const escolhida = ordenadas.find((l) => params.mercadosNoRadar.has(l.eventId));
    if (escolhida === undefined) {
      fora.foraDoRadar += 1;
      continue;
    }

    // Prefer two readings of the market Haiku will read: that is the pair whose
    // prompts were identical, like Haiku's two calls will be.
    const doMercado = ordenadas.filter((l) => l.eventId === escolhida.eventId);
    const [a, b] = doMercado.length >= 2 ? doMercado : ordenadas;
    elegiveis.push({
      sha,
      eventId: escolhida.eventId,
      par: [(a as LeituraDeepseek).id, (b as LeituraDeepseek).id],
      parMesmoMercado: doMercado.length >= 2,
      leiturasDeepseek: leituras.length,
    });
  }

  const ordem = (sha: string): string => hashDescription(`${params.semente}:${sha}`);
  const sorteados = [...elegiveis].sort((x, y) => ordem(x.sha).localeCompare(ordem(y.sha)));

  return {
    amostra: sorteados.slice(0, params.n),
    elegiveis: elegiveis.length,
    textos: porTexto.size,
    fora,
  };
}

// ---------------------------------------------------------------------------
// The estimate
// ---------------------------------------------------------------------------

export interface Estimativa {
  chamadas: number;
  tokensEntrada: number;
  tokensSaida: number;
  usd: number;
}

/**
 * What the run would cost, from August's real token counts of the same texts.
 *
 * Per text, the mean billed tokens of its DeepSeek readings, priced at the
 * model's rate and multiplied by the readings asked for. Every prompt token is
 * priced as uncached input: the Anthropic adapter sends no `cache_control`, so
 * Haiku will not read cache, and input is the cheap side anyway.
 *
 * It is a DeepSeek-shaped estimate of a Claude run, and says so: the two
 * tokenizers differ, and Claude bills its thinking as output. The run measures
 * the real number from `usage`.
 */
export function estimarCusto(
  modelo: string,
  amostra: readonly TextoAmostrado[],
  leituras: readonly LeituraDeepseek[],
  leiturasPorTexto: number,
): Estimativa | null {
  const porTexto = new Map<string, LeituraDeepseek[]>();
  for (const l of leituras) {
    const lista = porTexto.get(l.sha);
    if (lista === undefined) porTexto.set(l.sha, [l]);
    else lista.push(l);
  }

  let tokensEntrada = 0;
  let tokensSaida = 0;
  for (const t of amostra) {
    const ls = porTexto.get(t.sha) ?? [];
    if (ls.length === 0) continue;
    const media = (f: (l: LeituraDeepseek) => number): number =>
      ls.reduce((s, l) => s + f(l), 0) / ls.length;
    tokensEntrada += media((l) => l.tokensEntrada) * leiturasPorTexto;
    tokensSaida += media((l) => l.tokensSaida) * leiturasPorTexto;
  }

  const usd = estimateCostUsd(modelo, {
    input: tokensEntrada,
    output: tokensSaida,
    cacheRead: 0,
    cacheWrite: 0,
  });
  if (usd === null) return null;

  return {
    chamadas: amostra.length * leiturasPorTexto,
    tokensEntrada: Math.round(tokensEntrada),
    tokensSaida: Math.round(tokensSaida),
    usd,
  };
}

// ---------------------------------------------------------------------------
// Findings, and when two of them are the same
// ---------------------------------------------------------------------------

export interface Achado {
  classe: Classe;
  /** Severity for a trap, ambiguity type otherwise. */
  subtipo: string | null;
  chave: string;
  trecho: string;
  trechoConflito: string | null;
}

/**
 * One reading's findings, with the identity the screen and the view use.
 *
 * Goes through `montarLinhas` instead of rebuilding the key here: a second
 * definition of "the same finding" would measure a grouping the screen does
 * not use. Rows are in the shape of `digest_pegadinhas` and
 * `digest_ambiguidades`, which is also what `buildDigestRows` produces for a
 * Haiku result, so both models pass through the same function.
 */
export function achadosDaLeitura(
  digestId: string,
  pegadinhas: readonly Omit<Pegadinha, 'digest_id'>[],
  ambiguidades: readonly Omit<Ambiguidade, 'digest_id'>[],
): Achado[] {
  const linhas = montarLinhas({
    digests: [{ id: digestId, event_id: '', description_sha256: '', created_at: '' }],
    pegadinhas: pegadinhas.map((p) => ({ ...p, digest_id: digestId })),
    ambiguidades: ambiguidades.map((a) => ({ ...a, digest_id: digestId })),
    view: [],
    roster: [],
  });
  return linhas.map((l) => ({
    classe: l.classe,
    subtipo: l.subtipo,
    chave: l.chave,
    trecho: l.trecho,
    trechoConflito: l.trecho_conflito,
  }));
}

/** One passage inside the other, on word boundaries, either way round. */
function sobrepoe(a: string, b: string): boolean {
  return contemTrecho(a, b) || contemTrecho(b, a);
}

/**
 * Two findings are the same when they are of the same kind and quote the same
 * passage, allowing one quote to contain the other.
 *
 * The exact key alone would call "by 11:59 PM ET" and "by 11:59 PM ET on
 * December 31" two findings, and two models rarely cut a quote at the same
 * word. Containment on word boundaries is the screen's own absorption test
 * (`contemTrecho`). An ambiguity must also keep its type: the same passage read
 * as `fonte_vaga` and as `momento_ambiguo` is two claims. A contradiction
 * matches when its two passages match in either order.
 */
export function mesmoAchado(a: Achado, b: Achado): boolean {
  if (a.classe !== b.classe) return false;
  if (a.chave === b.chave) return true;
  if (a.classe === 'ambiguidade') return a.subtipo === b.subtipo && sobrepoe(a.trecho, b.trecho);
  if (a.classe === 'contradicao') {
    const x = a.trechoConflito ?? '';
    const y = b.trechoConflito ?? '';
    return (
      (sobrepoe(a.trecho, b.trecho) && sobrepoe(x, y)) ||
      (sobrepoe(a.trecho, y) && sobrepoe(x, b.trecho))
    );
  }
  return sobrepoe(a.trecho, b.trecho);
}

function encontrado(achado: Achado, em: readonly Achado[]): boolean {
  return em.some((outro) => mesmoAchado(achado, outro));
}

/** The findings of several readings, each distinct finding once. */
export function uniao(leituras: ReadonlyArray<readonly Achado[]>): Achado[] {
  const out: Achado[] = [];
  for (const leitura of leituras) {
    for (const a of leitura) if (!encontrado(a, out)) out.push(a);
  }
  return out;
}

// ---------------------------------------------------------------------------
// The two measures
// ---------------------------------------------------------------------------

/** A ratio kept as its two counts, so pooling sums counts and not percentages. */
export interface Razao {
  parte: number;
  todo: number;
}

const ZERO: Razao = { parte: 0, todo: 0 };

function somar(a: Razao, b: Razao): Razao {
  return { parte: a.parte + b.parte, todo: a.todo + b.todo };
}

export function porcento(r: Razao): string {
  return r.todo === 0 ? '—' : `${((r.parte / r.todo) * 100).toFixed(1)}%`;
}

export type PorClasse = Record<Classe | 'total', Razao>;

function vazioPorClasse(): PorClasse {
  return { pegadinha: ZERO, ambiguidade: ZERO, contradicao: ZERO, total: ZERO };
}

function acumular(acc: PorClasse, classe: Classe, r: Razao): PorClasse {
  return { ...acc, [classe]: somar(acc[classe], r), total: somar(acc.total, r) };
}

/**
 * Self-consistency of one pair of readings: the share of their findings that
 * the other reading also has.
 *
 * Counted from both sides, (A found in B + B found in A) / (|A| + |B|), so the
 * pair has one number whichever reading is called first. Pooled by summing the
 * counts across texts, never by averaging per-text percentages: a text with
 * one finding would weigh as much as a text with thirty.
 */
export function consistencia(a: readonly Achado[], b: readonly Achado[]): PorClasse {
  let acc = vazioPorClasse();
  for (const x of a) acc = acumular(acc, x.classe, { parte: encontrado(x, b) ? 1 : 0, todo: 1 });
  for (const y of b) acc = acumular(acc, y.classe, { parte: encontrado(y, a) ? 1 : 0, todo: 1 });
  return acc;
}

/** The share of `de`'s findings that `em` also has. Asymmetric by design. */
export function cobertura(de: readonly Achado[], em: readonly Achado[]): PorClasse {
  let acc = vazioPorClasse();
  for (const x of de) acc = acumular(acc, x.classe, { parte: encontrado(x, em) ? 1 : 0, todo: 1 });
  return acc;
}

export function somarPorClasse(itens: readonly PorClasse[]): PorClasse {
  return itens.reduce(
    (acc, r) => ({
      pegadinha: somar(acc.pegadinha, r.pegadinha),
      ambiguidade: somar(acc.ambiguidade, r.ambiguidade),
      contradicao: somar(acc.contradicao, r.contradicao),
      total: somar(acc.total, r.total),
    }),
    vazioPorClasse(),
  );
}

// ---------------------------------------------------------------------------
// Null digests
// ---------------------------------------------------------------------------

/**
 * Failure codes grouped by the cause of issue #7, every cause listed.
 *
 * A code no cause knows is kept under its own name instead of dropped: a new
 * failure mode is exactly what a new model is likely to bring.
 */
export function nulosPorCausa(codigos: readonly string[]): Array<[string, number]> {
  const contagem = new Map<string, number>(CAUSAS.map((c) => [c.chave, 0]));
  for (const codigo of codigos) {
    const chave = causaDe(codigo)?.chave ?? `desconhecido:${codigo}`;
    contagem.set(chave, (contagem.get(chave) ?? 0) + 1);
  }
  return [...contagem.entries()];
}
