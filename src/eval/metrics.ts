/**
 * As contas do eval. Nenhuma leitura de banco, nenhuma formatação.
 *
 * Separado de `dataset.ts` e `report.ts` porque é a parte que precisa estar
 * certa: um Brier calculado errado não falha, ele mente com três casas decimais.
 * Aqui dentro tudo é função pura sobre uma lista de pontos, e o teste consegue
 * conferir cada uma contra um valor calculado à mão.
 */

/**
 * Um ponto da amostra: uma análise cujo desfecho já é conhecido.
 *
 * `probability` e `marketMid` estão os DOIS orientados ao time A — o mesmo time
 * A de `outcome`. Essa é a invariante da qual tudo depende: se um deles
 * estivesse orientado ao time B, o agente pareceria pessimamente calibrado e o
 * defeito seria de leitura, não do agente. Quem garante isso é `dataset.ts`,
 * que descarta a análise em vez de adivinhar quando o lado não fecha.
 */
export interface EvalPoint {
  analysisId: string;
  matchSlug: string;
  checkpointMinutes: number;
  asOf: string;
  model: string | null;
  promptVersion: string;
  /** P(time A vence), do agente. */
  probability: number;
  /** P(time A vence), do mercado no mesmo `as_of`. `null` = sem preço gravado. */
  marketMid: number | null;
  liquidity: number | null;
  /** 1 = o time A venceu. */
  outcome: 0 | 1;
}

/** De onde sai a previsão de um ponto — o agente, o mercado, ou a moeda. */
export type Forecaster = (point: EvalPoint) => number | null;

export const AGENT: Forecaster = (point) => point.probability;
export const MARKET: Forecaster = (point) => point.marketMid;
export const COIN: Forecaster = () => 0.5;

/**
 * Brier score: média de (p - y)². Zero é perfeito, 0,25 é a moeda, 1 é o pior
 * possível (convicção total no lado errado, toda vez).
 *
 * Devolve `null` para amostra vazia em vez de `NaN`. `NaN` se propaga em
 * silêncio por toda a tabela e vira "—" só no fim; `null` obriga quem chama a
 * decidir o que imprimir quando não há amostra.
 *
 * Pontos em que o previsor não tem opinião (`null`) ficam de FORA da conta. É
 * por isso que a comparação principal roda sobre a interseção — ver
 * `pairedSample`.
 */
export function brierScore(points: readonly EvalPoint[], forecast: Forecaster): number | null {
  let sum = 0;
  let n = 0;

  for (const point of points) {
    const p = forecast(point);
    if (p === null) continue;
    sum += (p - point.outcome) ** 2;
    n += 1;
  }

  return n === 0 ? null : sum / n;
}

/**
 * Quanto o previsor melhora sobre a referência, em fração do erro dela.
 *
 * Positivo = melhor que a referência. Contra o mercado, é a definição
 * operacional de edge: zero ou negativo significa que o agente não sabe nada que
 * o preço já não diga, e nesse caso o resto do relatório é curiosidade.
 */
export function skillScore(score: number | null, reference: number | null): number | null {
  if (score === null || reference === null || reference === 0) return null;
  return 1 - score / reference;
}

/**
 * A interseção onde os dois previsores opinam.
 *
 * Comparar o Brier do agente sobre 100 pontos com o do mercado sobre os 80 que
 * têm preço gravado não é comparação — são duas amostras diferentes, e a
 * diferença entre elas pode ser inteiramente composição. Toda comparação
 * agente × mercado neste eval roda sobre esta lista.
 */
export function pairedSample(points: readonly EvalPoint[]): EvalPoint[] {
  return points.filter((p) => p.marketMid !== null);
}

/**
 * Viés: média das previsões menos frequência observada.
 *
 * Positivo = o agente aposta no time A mais do que o time A vence. Como "time A"
 * é uma convenção fixa (o lado que o resolver casou com `outcome_a_index`, não
 * "o favorito"), um viés persistente aqui é achado de verdade e não artefato de
 * rotulagem — mas vale conferir se o time A tende a ser o favorito na amostra
 * antes de chamá-lo de otimismo.
 *
 * É a medida que o Brier esconde: um agente que soma +0,08 em toda previsão pode
 * ter Brier aceitável e estar errado na mesma direção sempre.
 */
export function bias(points: readonly EvalPoint[], forecast: Forecaster): number | null {
  let predicted = 0;
  let observed = 0;
  let n = 0;

  for (const point of points) {
    const p = forecast(point);
    if (p === null) continue;
    predicted += p;
    observed += point.outcome;
    n += 1;
  }

  return n === 0 ? null : predicted / n - observed / n;
}

// ---------------------------------------------------------------------------
// Calibração
// ---------------------------------------------------------------------------

export interface ReliabilityBucket {
  /** Piso do balde, inclusivo. */
  from: number;
  /** Teto do balde, exclusivo — menos no último, que inclui 1,0. */
  to: number;
  n: number;
  /** Média do que foi previsto dentro do balde. */
  meanPredicted: number;
  /** Fração que de fato aconteceu. É o "das vezes que disse 70%, quantas deram". */
  observedRate: number;
}

const BUCKET_WIDTH = 0.1;
const BUCKET_COUNT = 10;

/**
 * O reliability diagram em forma de tabela.
 *
 * Baldes de 10pp, fixos. Fixos e não por quantil porque a pergunta é sobre a
 * escala declarada — "quando ele diz 70%" é um intervalo de probabilidade, não
 * um decil da amostra. Baldes por quantil responderiam outra coisa e mudariam de
 * significado a cada rodada do eval.
 *
 * Baldes vazios saem da lista: imprimir dez linhas das quais sete dizem `n=0`
 * dá aparência de cobertura que a amostra não tem.
 */
export function reliabilityBuckets(
  points: readonly EvalPoint[],
  forecast: Forecaster = AGENT,
): ReliabilityBucket[] {
  const sums = Array.from({ length: BUCKET_COUNT }, () => ({ n: 0, predicted: 0, observed: 0 }));

  for (const point of points) {
    const p = forecast(point);
    if (p === null) continue;

    // `min` prende p = 1,0 no último balde. Sem isso ele cairia no índice 10,
    // que não existe, e o ponto sumiria da calibração sem erro nenhum.
    const index = Math.min(Math.floor(p / BUCKET_WIDTH), BUCKET_COUNT - 1);
    const bucket = sums[index];
    if (bucket === undefined) continue;

    bucket.n += 1;
    bucket.predicted += p;
    bucket.observed += point.outcome;
  }

  const buckets: ReliabilityBucket[] = [];
  for (const [index, bucket] of sums.entries()) {
    if (bucket.n === 0) continue;
    buckets.push({
      from: index * BUCKET_WIDTH,
      to: (index + 1) * BUCKET_WIDTH,
      n: bucket.n,
      meanPredicted: bucket.predicted / bucket.n,
      observedRate: bucket.observed / bucket.n,
    });
  }

  return buckets;
}

/**
 * Erro de calibração esperado: distância média entre o que se disse e o que
 * aconteceu, ponderada pelo tamanho do balde.
 *
 * É o reliability diagram resumido em um número. Serve para comparar versões de
 * prompt; não substitui olhar a tabela, porque um ECE baixo pode esconder um
 * balde pequeno e muito errado.
 */
export function calibrationError(buckets: readonly ReliabilityBucket[]): number | null {
  const n = buckets.reduce((total, b) => total + b.n, 0);
  if (n === 0) return null;

  const weighted = buckets.reduce(
    (total, b) => total + b.n * Math.abs(b.meanPredicted - b.observedRate),
    0,
  );

  return weighted / n;
}

export interface MurphyDecomposition {
  /** Erro de calibração ao quadrado. MENOR é melhor. */
  reliability: number;
  /** O quanto o previsor separa casos que acontecem dos que não. MAIOR é melhor. */
  resolution: number;
  /** Dificuldade intrínseca da amostra. Não depende do previsor. */
  uncertainty: number;
}

/**
 * Decomposição de Murphy: `Brier = confiabilidade - resolução + incerteza`.
 *
 * Existe porque "Brier alto" tem duas causas opostas e o conserto de uma piora a
 * outra. Confiabilidade ruim é agente descalibrado — diz 80% quando é 60% —, e
 * se conserta com prompt ou pós-processamento. Resolução baixa é agente que não
 * separa nada: responde ~0,5 sempre, fica bem calibrado e é inútil. Um agente
 * que só cospe a frequência-base tem confiabilidade perfeita e resolução zero.
 *
 * Os baldes têm que ser os mesmos da tabela de calibração, ou a identidade não
 * fecha.
 */
export function murphyDecomposition(
  points: readonly EvalPoint[],
  forecast: Forecaster = AGENT,
): MurphyDecomposition | null {
  const buckets = reliabilityBuckets(points, forecast);
  const n = buckets.reduce((total, b) => total + b.n, 0);
  if (n === 0) return null;

  const baseRate = buckets.reduce((total, b) => total + b.observedRate * b.n, 0) / n;

  const reliability =
    buckets.reduce((total, b) => total + b.n * (b.meanPredicted - b.observedRate) ** 2, 0) / n;

  const resolution =
    buckets.reduce((total, b) => total + b.n * (b.observedRate - baseRate) ** 2, 0) / n;

  return { reliability, resolution, uncertainty: baseRate * (1 - baseRate) };
}

// ---------------------------------------------------------------------------
// Recortes
// ---------------------------------------------------------------------------

/**
 * Faixas de liquidez, em US$.
 *
 * O primeiro corte é o piso do portão (`analyst_min_liquidity_usd`, hoje 5000).
 * Análise abaixo dele só existe se a config já foi outra — e é exatamente por
 * isso que a faixa aparece: se o agente for ruim só lá embaixo, o piso está
 * certo e a evidência é esta linha.
 */
const LIQUIDITY_BANDS: ReadonlyArray<{ label: string; min: number }> = [
  { label: '>= 100k', min: 100_000 },
  { label: '20k-100k', min: 20_000 },
  { label: '5k-20k', min: 5_000 },
  { label: '< 5k', min: 0 },
];

export function liquidityBand(liquidity: number | null): string {
  if (liquidity === null) return 'sem liquidez';
  return LIQUIDITY_BANDS.find((band) => liquidity >= band.min)?.label ?? '< 5k';
}

/**
 * Agrupa preservando a ordem de primeira aparição de cada chave.
 *
 * Ordem estável importa: duas rodadas do eval sobre a mesma amostra têm que
 * imprimir as linhas na mesma ordem, ou o diff entre relatórios vira ruído.
 */
export function groupBy<T>(items: readonly T[], key: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();

  for (const item of items) {
    const k = key(item);
    const bucket = groups.get(k);
    if (bucket === undefined) groups.set(k, [item]);
    else bucket.push(item);
  }

  return groups;
}

export interface CutRow {
  label: string;
  n: number;
  agent: number | null;
  market: number | null;
  coin: number | null;
  /** Skill do agente contra o mercado, na mesma amostra. */
  skillVsMarket: number | null;
  bias: number | null;
}

/**
 * Uma linha de tabela por grupo, com os três previsores sobre a MESMA amostra.
 *
 * A amostra de cada linha é a interseção do grupo — só os pontos com preço
 * gravado. Um grupo inteiro sem preço vira linha com `n = 0`, que é informação
 * (o recorte existe e não dá para avaliar) e não deve ser omitido.
 */
export function cut(points: readonly EvalPoint[], key: (point: EvalPoint) => string): CutRow[] {
  const rows: CutRow[] = [];

  for (const [label, group] of groupBy(points, key)) {
    const paired = pairedSample(group);
    const agent = brierScore(paired, AGENT);
    const market = brierScore(paired, MARKET);

    rows.push({
      label,
      n: paired.length,
      agent,
      market,
      coin: brierScore(paired, COIN),
      skillVsMarket: skillScore(agent, market),
      bias: bias(paired, AGENT),
    });
  }

  return rows.sort((a, b) => b.n - a.n);
}

/**
 * Abaixo disto, a diferença entre dois Brier é ruído amostral.
 *
 * Não é um teste de significância — é uma marca no relatório para impedir a
 * leitura que este eval mais convida: ver "skill +0,3" em cima de 4 partidas e
 * concluir que o agente tem edge.
 */
export const MIN_N_FOR_SIGNAL = 20;
