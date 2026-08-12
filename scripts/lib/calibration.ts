/**
 * A conta da fase 2 do XTracker, separada da rede que a alimenta.
 *
 * Aqui não há fetch, relógio nem aleatoriedade de verdade: dá para conferir cada
 * função com fixture na mão, e é o que `--self-test` faz. O desenho é copiado de
 * `src/eval/metrics.ts` e `src/eval/market-dataset.ts` — `ReliabilityBucket`, a
 * barra de meio spread, o corte temporal por ENTIDADE — e o que não deu para
 * reaproveitar direto está anotado onde diverge.
 */

import {
  MIN_MATCHES_FOR_BUCKET,
  type ReliabilityBucket,
  bucketGap,
} from '../../src/eval/metrics.js';

export { MIN_MATCHES_FOR_BUCKET, bucketGap };

// ---------------------------------------------------------------------------
// A linha
// ---------------------------------------------------------------------------

/** Uma faixa está VIVA num instante se a contagem ainda pode cair dentro dela. */
export type BinState =
  /** `to >= contagem acumulada`: ainda alcançável. */
  | 'viva'
  /**
   * `to < contagem acumulada`: aritmeticamente impossível, porque contagem só sobe.
   *
   * Não é "improvável": é zero. E é a distinção que decide a medida A inteira —
   * ver `LIVE_ONLY` abaixo.
   */
  | 'morta';

/**
 * Uma linha: (mercado, faixa, instante de observação).
 *
 * `marketSlug` é o slug do EVENTO, não o da faixa. É ele que entra em
 * `distinctMatches` e no corte temporal, porque a unidade de informação
 * independente é o evento: exatamente uma faixa dele resolve YES, então as 26
 * faixas de um mercado semanal são uma observação anticorrelacionada, não 26.
 */
export interface BinPoint {
  marketSlug: string;
  /** Herda o nome de `CalibratablePoint` para plugar em `src/eval/metrics.ts`. */
  matchSlug: string;
  seriesSlug: string;
  question: string;
  /** Fim da janela de contagem — o instante que resolve o mercado. */
  closeAt: string;
  /** Início da janela de contagem. */
  openAt: string;
  /** Quantas horas antes do fechamento a linha foi observada. */
  offsetHours: number;
  observedAt: string;
  from: number;
  to: number | null;
  /** O mid da série do CLOB no instante de observação. */
  price: number;
  /** Distância entre o instante pedido e o ponto de fato usado, em segundos. */
  priceLagSeconds: number;
  /** Contagem já acumulada no instante de observação. */
  countSoFar: number;
  /** Horas que faltavam para o fechamento. Igual a `offsetHours`; explícito por clareza. */
  hoursLeft: number;
  state: BinState;
  outcome: 0 | 1;
  /** Meio spread estimado para ESTE preço. `null` quando não há estimativa. */
  halfSpread: number | null;
}

/** O previsor da medida A: o preço da faixa. */
export const BIN_PRICE = (point: BinPoint): number | null => point.price;

/**
 * O preço de quem ATRAVESSA o book: mid + meio spread.
 *
 * `null` — e a linha sai da conta — quando não há estimativa de spread para esse
 * nível de preço. Preencher com zero transformaria "não sei o custo" em "o custo
 * é zero", que é exatamente a mentira que matou o C2.
 */
export const BIN_ASK = (point: BinPoint): number | null =>
  point.halfSpread === null ? null : Math.min(point.price + point.halfSpread, 1);

// ---------------------------------------------------------------------------
// Baldes com bordas irregulares
// ---------------------------------------------------------------------------

/**
 * As bordas da medida A, em unidades de probabilidade.
 *
 * `BucketGrid` de `src/eval/metrics.ts` é uniforme (piso, largura, quantidade) e
 * aqui não serve: a pergunta vive na cauda, onde 2¢ e 5¢ são baldes distintos e
 * 40–60¢ é um só. Uma grade de 10pp jogaria <2¢, 2–5¢ e 5–10¢ no mesmo balde e
 * apagaria justamente a resolução que a frente inteira existe para medir.
 */
export const PRICE_EDGES: readonly number[] = [0, 0.02, 0.05, 0.1, 0.2, 0.4, 0.6, 1];

export interface EdgeBucket extends ReliabilityBucket {
  /** Mercados (eventos) distintos. Alias explícito de `distinctMatches`. */
  distinctMarkets: number;
  /** Intervalo de 95% da taxa observada, por bootstrap agrupado por MERCADO. */
  ciLow: number;
  ciHigh: number;
}

/**
 * O reliability diagram sobre bordas irregulares.
 *
 * Mesma semântica de `reliabilityBuckets`: balde vazio sai da lista, previsão
 * fora da grade não é empurrada para dentro. O que muda é só a grade.
 */
export function edgeBuckets<T extends { matchSlug: string; outcome: 0 | 1 }>(
  points: readonly T[],
  forecast: (point: T) => number | null,
  edges: readonly number[] = PRICE_EDGES,
  seed = 20260812,
): EdgeBucket[] {
  const slots = Array.from({ length: Math.max(edges.length - 1, 0) }, () => ({
    n: 0,
    predicted: 0,
    observed: 0,
    matches: new Set<string>(),
    /** desfechos agrupados por mercado — a matéria-prima do bootstrap */
    byMarket: new Map<string, number[]>(),
  }));

  for (const point of points) {
    const p = forecast(point);
    if (p === null) continue;

    const index = bucketIndex(p, edges);
    if (index === null) continue;
    const slot = slots[index];
    if (slot === undefined) continue;

    slot.n += 1;
    slot.predicted += p;
    slot.observed += point.outcome;
    slot.matches.add(point.matchSlug);

    const bucketRows = slot.byMarket.get(point.matchSlug);
    if (bucketRows === undefined) slot.byMarket.set(point.matchSlug, [point.outcome]);
    else bucketRows.push(point.outcome);
  }

  const out: EdgeBucket[] = [];
  for (const [index, slot] of slots.entries()) {
    if (slot.n === 0) continue;
    const from = edges[index] ?? 0;
    const to = edges[index + 1] ?? 1;
    const { low, high } = clusterBootstrap(slot.byMarket, seed + index);

    out.push({
      from,
      to,
      n: slot.n,
      distinctMatches: slot.matches.size,
      distinctMarkets: slot.matches.size,
      meanPredicted: slot.predicted / slot.n,
      observedRate: slot.observed / slot.n,
      ciLow: low,
      ciHigh: high,
    });
  }

  return out;
}

/** O balde de um preço, ou `null` se ele cai fora da grade. O último inclui o teto. */
export function bucketIndex(p: number, edges: readonly number[]): number | null {
  const last = edges.length - 1;
  if (last < 1) return null;
  if (p < (edges[0] ?? 0)) return null;
  if (p > (edges[last] ?? 1)) return null;

  for (let i = 0; i + 1 < edges.length; i += 1) {
    const lo = edges[i] ?? 0;
    const hi = edges[i + 1] ?? 1;
    if (p >= lo && (p < hi || i === last - 1)) return i;
  }
  return null;
}

export function bucketLabel(bucket: { from: number; to: number }): string {
  const cents = (v: number): string => `${(v * 100).toFixed(v * 100 < 10 ? 0 : 0)}¢`;
  if (bucket.from === 0) return `<${cents(bucket.to)}`;
  if (bucket.to >= 1) return `>${cents(bucket.from)}`;
  return `${cents(bucket.from)}–${cents(bucket.to)}`;
}

// ---------------------------------------------------------------------------
// O intervalo, e por que ele é agrupado
// ---------------------------------------------------------------------------

/** Gerador determinístico. Bootstrap que muda de resposta entre rodadas não serve. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const BOOTSTRAP_DRAWS = 2000;

/**
 * O intervalo de 95% da taxa observada, reamostrando MERCADOS — não linhas.
 *
 * É a guarda 1 levada até a conclusão. Contar mercados distintos ao lado de `n`
 * avisa que as 26 faixas de um evento não são 26 evidências; um intervalo
 * calculado sobre as linhas continuaria mentindo, porque a fórmula binomial
 * pressupõe independência que aqui é falsa por construção — exatamente uma
 * faixa do evento resolve YES, então as faixas são anticorrelacionadas dentro
 * dele.
 *
 * Reamostrar o mercado inteiro (com todas as suas faixas do balde, juntas)
 * preserva essa correlação, e o intervalo que sai é largo do jeito honesto.
 */
export function clusterBootstrap(
  byMarket: ReadonlyMap<string, readonly number[]>,
  seed: number,
  draws = BOOTSTRAP_DRAWS,
): { low: number; high: number } {
  const clusters = [...byMarket.values()];
  if (clusters.length === 0) return { low: Number.NaN, high: Number.NaN };

  const random = mulberry32(seed);
  const rates: number[] = [];

  for (let draw = 0; draw < draws; draw += 1) {
    let hits = 0;
    let total = 0;
    for (let i = 0; i < clusters.length; i += 1) {
      const cluster = clusters[Math.floor(random() * clusters.length)];
      if (cluster === undefined) continue;
      for (const outcome of cluster) {
        hits += outcome;
        total += 1;
      }
    }
    if (total > 0) rates.push(hits / total);
  }

  if (rates.length === 0) return { low: Number.NaN, high: Number.NaN };
  rates.sort((a, b) => a - b);
  return {
    low: rates[Math.floor(rates.length * 0.025)] ?? Number.NaN,
    high: rates[Math.min(Math.floor(rates.length * 0.975), rates.length - 1)] ?? Number.NaN,
  };
}

// ---------------------------------------------------------------------------
// Guarda 2: o corte temporal, por MERCADO
// ---------------------------------------------------------------------------

/**
 * Metade mais antiga contra a mais recente, levando todas as faixas de cada
 * mercado juntas.
 *
 * Cópia de `splitByMatchTime` com a entidade trocada de partida para mercado. O
 * motivo é o mesmo e é mais forte aqui: as faixas de um evento dividem UM
 * desfecho, e deixá-las cair nos dois lados do corte colocaria a mesma evidência
 * dos dois lados da comparação que existe justamente para ser independente.
 *
 * Ordenado por fechamento. Empate exato vai para a metade recente.
 */
export function splitByMarketTime(points: readonly BinPoint[]): {
  older: BinPoint[];
  newer: BinPoint[];
} {
  const byMarket = new Map<string, string>();
  for (const point of points) byMarket.set(point.marketSlug, point.closeAt);

  const ordered = [...byMarket.entries()].sort(([idA, a], [idB, b]) =>
    a < b ? -1 : a > b ? 1 : idA < idB ? -1 : 1,
  );

  const half = Math.floor(ordered.length / 2);
  const olderIds = new Set(ordered.slice(0, half).map(([id]) => id));

  return {
    older: points.filter((point) => olderIds.has(point.marketSlug)),
    newer: points.filter((point) => !olderIds.has(point.marketSlug)),
  };
}

export function distinctMarkets(points: readonly { marketSlug: string }[]): number {
  return new Set(points.map((point) => point.marketSlug)).size;
}

/** `2026-08-11T...` → `2026-Q3`. A guarda 3 pede regime, e trimestre é o recorte. */
export function quarter(iso: string): string {
  const year = iso.slice(0, 4);
  const month = Number(iso.slice(5, 7));
  return `${year}-Q${Math.floor((month - 1) / 3) + 1}`;
}

// ---------------------------------------------------------------------------
// Medida B — a distribuição implícita
// ---------------------------------------------------------------------------

export interface Bin {
  from: number;
  to: number | null;
  price: number | null;
  state: BinState;
}

export interface ImpliedMoments {
  /** Soma dos preços ANTES de normalizar. Deveria dar ~1. */
  priceSum: number;
  mean: number;
  sd: number;
  /** Faixas que entraram com preço. */
  priced: number;
  /** Faixas vivas SEM preço — se > 0 a distribuição está furada. */
  missing: number;
}

/**
 * Média e desvio da distribuição que os preços das faixas desenham.
 *
 * Duas convenções, e as duas mudam o número, então ficam explícitas:
 *
 * 1. **Representante da faixa** — o ponto médio. A faixa aberta do topo ("500+")
 *    não tem ponto médio, e recebe `from + largura da faixa anterior / 2`. É
 *    arbitrário; o peso dela é quase sempre < 1% e o efeito no desvio é pequeno,
 *    mas quem ler o número tem que saber que ele existe.
 * 2. **Normalização** — os preços são divididos pela soma antes de virar
 *    distribuição. Sem isso, um mercado neg-risk cuja soma dá 1,05 produziria um
 *    desvio inflado por 5% de massa fantasma. A soma CRUA é devolvida junto
 *    justamente para que ela seja lida, não escondida.
 *
 * Faixa morta entra com probabilidade zero — que é o valor verdadeiro dela — e
 * não como ausência.
 */
export function impliedMoments(bins: readonly Bin[]): ImpliedMoments | null {
  const missing = bins.filter((b) => b.state === 'viva' && b.price === null).length;

  const values: Array<{ x: number; p: number }> = [];
  let priceSum = 0;

  const sorted = [...bins].sort((a, b) => a.from - b.from);
  for (const [index, bin] of sorted.entries()) {
    const p = bin.state === 'morta' ? 0 : bin.price;
    if (p === null) continue;

    let x: number;
    if (bin.to !== null) {
      x = (bin.from + bin.to) / 2;
    } else {
      const previous = sorted[index - 1];
      const width =
        previous !== undefined && previous.to !== null ? previous.to - previous.from + 1 : 20;
      x = bin.from + width / 2;
    }

    values.push({ x, p });
    priceSum += p;
  }

  if (priceSum <= 0 || values.length === 0) return null;

  let mean = 0;
  for (const v of values) mean += v.x * (v.p / priceSum);

  let variance = 0;
  for (const v of values) variance += (v.p / priceSum) * (v.x - mean) ** 2;

  return { priceSum, mean, sd: Math.sqrt(variance), priced: values.length, missing };
}

/**
 * O z do desfecho contra a distribuição implícita: `(real − média) / desvio`.
 *
 * É o coração da medida B, e é ele — não a comparação de desvios brutos — que
 * responde "o mercado é estreito demais". Comparar o desvio implícito médio com
 * o desvio das contagens realizadas somaria coisas incomparáveis: a amostra tem
 * janelas de 48 h e de 7 dias, e uma deriva de 53 para 23 posts/dia por cima.
 * O desvio das contagens realizadas mistura tudo isso; o desvio implícito de um
 * mercado específico fala só daquela janela.
 *
 * O z normaliza cada mercado pela própria escala. Se o mercado estiver calibrado
 * em largura, o desvio-padrão dos z's é 1. Se der 1,4, o realizado é 40% mais
 * largo que o implícito — e 40% é o tamanho do erro, na unidade que interessa.
 */
export function zScore(actual: number, moments: ImpliedMoments): number | null {
  if (!Number.isFinite(moments.sd) || moments.sd <= 0) return null;
  return (actual - moments.mean) / moments.sd;
}

export function standardDeviation(values: readonly number[]): number | null {
  if (values.length < 2) return null;
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

export function mean(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((s, v) => s + v, 0) / values.length;
}

export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid] ?? null;
  return ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

// ---------------------------------------------------------------------------
// O que sobra depois das guardas
// ---------------------------------------------------------------------------

/** Um mercado-instante da medida B, na forma em que o snapshot o grava. */
export interface InstantRow {
  marketSlug: string;
  seriesSlug: string;
  closeAt: string;
  offsetHours: number;
  priceSum: number;
  impliedMean: number;
  impliedSd: number;
  actual: number;
  z: number;
}

export interface ZSummary {
  label: string;
  n: number;
  meanZ: number;
  ciLow: number;
  ciHigh: number;
  sdZ: number;
  priceSum: number;
}

/**
 * Média dos z com intervalo, para um recorte qualquer.
 *
 * Aqui o intervalo é o erro-padrão comum e NÃO o bootstrap agrupado da medida A,
 * porque a unidade já é o mercado-instante: cada linha é um mercado inteiro, e
 * não há agrupamento a corrigir. Usar o bootstrap seria cerimônia sem conteúdo.
 */
export function summarizeZ(label: string, rows: readonly InstantRow[]): ZSummary | null {
  if (rows.length < 2) return null;
  const zs = rows.map((r) => r.z);
  const m = mean(zs) ?? 0;
  const sd = standardDeviation(zs) ?? 0;
  const se = sd / Math.sqrt(rows.length);
  return {
    label,
    n: rows.length,
    meanZ: m,
    ciLow: m - 1.96 * se,
    ciHigh: m + 1.96 * se,
    sdZ: sd,
    priceSum: median(rows.map((r) => r.priceSum)) ?? Number.NaN,
  };
}

/**
 * O recorte série × instante, e depois a divisão temporal DO recorte mais forte.
 *
 * Existe porque um viés médio no conjunto todo pode ser um viés inteiro de um
 * canto só. Na primeira passada foi exatamente isso: o desvio da medida A no
 * balde 40–60¢ vinha todo de `elon-tweets-48h` observado em T-48h — que, nessa
 * série, é o instante em que a janela de contagem ABRE. Lá os preços somam 1,06
 * em vez de 1,01, e metade dos mercados tem duas faixas no mesmo balde de 50¢,
 * das quais no máximo uma pode ganhar.
 *
 * Sem este recorte, aquilo teria sido reportado como "o mercado erra o meio da
 * distribuição". Com ele, vira "o book na hora da listagem é grosso, e observar
 * ali mede a listagem, não o mercado".
 */
export function regimeRows(instants: readonly InstantRow[]): {
  bySeries: ZSummary[];
  strongest: ZSummary | null;
  strongestSplit: ZSummary[];
} {
  const keys = [...new Set(instants.map((i) => `${i.seriesSlug}|${i.offsetHours}`))].sort();

  const bySeries = keys.flatMap((key) => {
    const [series = '', offset = ''] = key.split('|');
    const rows = instants.filter((i) => `${i.seriesSlug}|${i.offsetHours}` === key);
    const summary = summarizeZ(`${series} @ T-${offset}h`, rows);
    return summary === null ? [] : [summary];
  });

  // O recorte mais forte é o de maior |média z| entre os que EXCLUEM zero: um z
  // médio grande com intervalo que cobre zero é ruído grande, não achado grande.
  /**
   * O recorte precisa de amostra ANTES de poder ser o mais forte.
   *
   * Sem este piso, um recorte de dois mercado-instantes ganha a disputa sempre
   * que os dois calharem de cair do mesmo lado: com n = 2 o erro-padrão é uma
   * ficção e o intervalo exclui zero por sorte. Foi o que aconteceu na primeira
   * rodada — `elon-tweet-daily @ T-48h`, n = 2, venceu um recorte de n = 91 e
   * levou a seção inteira para uma tabela vazia, porque metade de dois não dá
   * variância nenhuma para dividir.
   *
   * O piso é o mesmo `MIN_MATCHES_FOR_BUCKET` da medida A: a pergunta é a mesma
   * — quantas entidades independentes esta linha tem o direito de resumir.
   */
  const candidates = bySeries.filter(
    (s) => s.n >= MIN_MATCHES_FOR_BUCKET && (s.ciLow > 0 || s.ciHigh < 0),
  );
  const strongest =
    candidates.length === 0
      ? null
      : candidates.reduce((best, s) => (Math.abs(s.meanZ) > Math.abs(best.meanZ) ? s : best));

  const strongestSplit: ZSummary[] = [];
  if (strongest !== null) {
    const rows = instants
      .filter((i) => `${i.seriesSlug} @ T-${i.offsetHours}h` === strongest.label)
      .sort((a, b) => (a.closeAt < b.closeAt ? -1 : a.closeAt > b.closeAt ? 1 : 0));
    const half = Math.floor(rows.length / 2);
    const older = summarizeZ('metade antiga', rows.slice(0, half));
    const newer = summarizeZ('metade recente', rows.slice(half));
    if (older !== null) strongestSplit.push(older);
    if (newer !== null) strongestSplit.push(newer);
    for (const q of [...new Set(rows.map((r) => quarter(r.closeAt)))].sort()) {
      const summary = summarizeZ(
        q,
        rows.filter((r) => quarter(r.closeAt) === q),
      );
      if (summary !== null) strongestSplit.push(summary);
    }
  }

  return { bySeries, strongest, strongestSplit };
}

/**
 * Os limites em que a soma dos preços de um mercado-instante ainda é uma
 * distribuição — e fora dos quais a "medida A" não está medindo preço.
 *
 * A soma das faixas de um evento exaustivo e exclusivo é 1. O neg-risk empurra
 * isso para ~1,01–1,05 e tudo bem: é o overround, é conhecido, e vira candidato
 * próprio. O que NÃO é overround é uma soma de 1,75 — e ela existe, com mediana
 * 1,75 na metade recente de `elon-tweets-48h` observada na abertura da janela,
 * e máximo de 4,53.
 *
 * A causa é mecânica. Na hora em que o mercado é listado, boa parte das faixas
 * tem book vazio ou larguíssimo; o mid de um book vazio não é uma probabilidade
 * pequena, é (0 + 1) / 2 ou coisa próxima. Dez faixas nessa situação somam muito
 * mais que 1, e cada uma aparece na tabela como "faixa cotada a 50¢" quando
 * ninguém cotou nada.
 *
 * Foi exatamente isso que produziu o único balde "significativo" da primeira
 * leitura. Filtrando por esta faixa de soma, o balde 40–60¢ vai de gap +0,131
 * para −0,006 — de "o mercado erra o meio da distribuição" para calibrado.
 *
 * O teto é generoso de propósito: 1,20 deixa passar overround de 20%, que é
 * muito mais que o observado nos mercados de book cheio (mediana 1,01).
 */
export const PRICE_SUM_MIN = 0.9;
export const PRICE_SUM_MAX = 1.2;

/** A chave que liga uma linha ao seu mercado-instante. */
export function instantKey(row: { marketSlug: string; offsetHours: number }): string {
  return `${row.marketSlug}|${row.offsetHours}`;
}

/**
 * Só as linhas cujo mercado-instante tem preços somando perto de 1.
 *
 * Devolve também as que saíram, porque um filtro que remove um terço da amostra
 * em silêncio é pior que o viés que ele corrige.
 */
export function coherentPoints(
  points: readonly BinPoint[],
  instants: readonly InstantRow[],
  min = PRICE_SUM_MIN,
  max = PRICE_SUM_MAX,
): { kept: BinPoint[]; dropped: BinPoint[]; keptInstants: number; droppedInstants: number } {
  const ok = new Set<string>();
  let droppedInstants = 0;
  for (const instant of instants) {
    if (instant.priceSum >= min && instant.priceSum <= max) ok.add(instantKey(instant));
    else droppedInstants += 1;
  }

  const kept: BinPoint[] = [];
  const dropped: BinPoint[] = [];
  for (const point of points) {
    if (ok.has(instantKey(point))) kept.push(point);
    else dropped.push(point);
  }

  return { kept, dropped, keptInstants: ok.size, droppedInstants };
}
