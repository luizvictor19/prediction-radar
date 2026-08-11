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
  /**
   * `best_ask - best_bid` no `as_of`, em unidades de probabilidade. `null` = sem
   * os dois lados do book gravados.
   *
   * Não entra em nenhuma métrica de acerto: entra na LEITURA delas. O eval
   * compara contra o mid, e quem negocia atravessa o book — um gap de 0,01 num
   * mercado de spread 0,04 é acerto de medição e prejuízo de execução. É o
   * denominador da única pergunta que importa no fim: o erro é maior que meio
   * spread?
   */
  spread: number | null;
  /** 1 = o time A venceu. */
  outcome: 0 | 1;
}

/** De onde sai a previsão de um ponto — o agente, o mercado, ou a moeda. */
export type Forecaster = (point: EvalPoint) => number | null;

export const AGENT: Forecaster = (point) => point.probability;
export const MARKET: Forecaster = (point) => point.marketMid;
export const COIN: Forecaster = () => 0.5;

/**
 * Os limites do previsor com viés subtraído.
 *
 * Existem porque `p - viés` sai de [0,1] sempre que a previsão está mais perto
 * da borda do que o viés é grande — com viés de +0,07, tudo abaixo de 0,07 vira
 * probabilidade negativa. Travar em 0,01/0,99 e não em 0/1 porque zero absoluto
 * é uma afirmação que nenhum previsor honesto faz, e porque um único ponto
 * travado em 0 com desfecho 1 sozinho soma 1,0 ao numerador do Brier.
 */
export const CLAMP_LO = 0.01;
export const CLAMP_HI = 0.99;

/**
 * O agente com uma constante subtraída de toda previsão.
 *
 * É o transformador mais barato que existe — não toca prompt, não toca modelo,
 * não precisa de treino. Também é o mais CEGO: desloca a previsão de 0,50 tanto
 * quanto a de 0,95, quando o espaço em que o erro de um previsor costuma ser
 * constante é o logit e não a probabilidade. O sintoma de estar usando o
 * transformador errado é o contador de travamento — ver `countClamped`.
 *
 * Fábrica e não constante porque o deslocamento é ESTIMADO, e de onde ele foi
 * estimado é a diferença entre medir e se enganar: ver `debiasEvaluation`.
 */
export function debiasedAgent(offset: number): Forecaster {
  return (point) => {
    const p = point.probability;
    return Math.min(CLAMP_HI, Math.max(CLAMP_LO, p - offset));
  };
}

/**
 * Quantos pontos a subtração jogou para fora de [0,01; 0,99].
 *
 * Não é diagnóstico secundário: é o teste de que a subtração é o transformador
 * certo. Ponto travado teve o deslocamento aplicado PELA METADE (ou nem isso), o
 * que significa que o previsor corrigido não é o que a fórmula diz que é. Com
 * travamento em volume, a correção certa é deslocar em espaço logit, onde as
 * bordas são inalcançáveis por construção e nada precisa ser travado.
 */
export function countClamped(points: readonly EvalPoint[], offset: number): number {
  let clamped = 0;
  for (const point of points) {
    const raw = point.probability - offset;
    if (raw < CLAMP_LO || raw > CLAMP_HI) clamped += 1;
  }
  return clamped;
}

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

/**
 * O mínimo que uma linha precisa ter para entrar num reliability diagram.
 *
 * Existe para a mesma máquina de baldes servir a duas amostras diferentes sem
 * que uma tenha que se disfarçar da outra: a de ANÁLISES (`EvalPoint`, uma linha
 * por análise pontuável) e a de PREÇOS (`MarketPoint`, uma linha por partida ×
 * checkpoint, sem agente nenhum envolvido). Fabricar um `EvalPoint` com
 * `probability` e `promptVersion` inventados para reaproveitar esta função faria
 * as duas amostras mentirem — `matchSlug` e `outcome` é tudo de que a conta
 * precisa, e é só isso que se exige aqui.
 */
export interface CalibratablePoint {
  /** A unidade de informação independente. Ver `ReliabilityBucket.distinctMatches`. */
  matchSlug: string;
  outcome: 0 | 1;
}

export interface ReliabilityBucket {
  /** Piso do balde, inclusivo. */
  from: number;
  /** Teto do balde, exclusivo — menos no último, que inclui 1,0. */
  to: number;
  n: number;
  /**
   * Partidas DISTINTAS por trás dos `n` pontos.
   *
   * A unidade de informação independente é a partida, não a análise: os dois
   * checkpoints da mesma partida compartilham o mesmo desfecho, e contar os dois
   * como amostra separada infla `n` sem acrescentar evidência nenhuma. Um balde
   * com n = 30 sobre 12 partidas tem o poder estatístico de 12, não de 30.
   */
  distinctMatches: number;
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
export function reliabilityBuckets<T extends CalibratablePoint>(
  points: readonly T[],
  forecast: (point: T) => number | null,
): ReliabilityBucket[] {
  const sums = Array.from({ length: BUCKET_COUNT }, () => ({
    n: 0,
    predicted: 0,
    observed: 0,
    matches: new Set<string>(),
  }));

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
    bucket.matches.add(point.matchSlug);
  }

  const buckets: ReliabilityBucket[] = [];
  for (const [index, bucket] of sums.entries()) {
    if (bucket.n === 0) continue;
    buckets.push({
      from: index * BUCKET_WIDTH,
      to: (index + 1) * BUCKET_WIDTH,
      n: bucket.n,
      distinctMatches: bucket.matches.size,
      meanPredicted: bucket.predicted / bucket.n,
      observedRate: bucket.observed / bucket.n,
    });
  }

  return buckets;
}

/**
 * O spread típico da amostra, em unidades de probabilidade.
 *
 * MEDIANA e não média: a distribuição de spread tem cauda longa à direita (um
 * mercado esquecido com book de 0,40 existe e não é raro), e a média deixaria um
 * punhado deles definir a barra que todo balde tem que superar. A mediana
 * responde "quanto custa atravessar o book no mercado do meio", que é a pergunta.
 *
 * `null` quando nenhum ponto tem os dois lados do book gravados — e aí a barra
 * não existe e o relatório tem que dizer isso, não assumir um spread plausível.
 */
export function typicalSpread(points: ReadonlyArray<{ spread: number | null }>): number | null {
  const spreads = points
    .map((point) => point.spread)
    .filter((s): s is number => s !== null)
    .sort((a, b) => a - b);

  if (spreads.length === 0) return null;

  const mid = Math.floor(spreads.length / 2);
  if (spreads.length % 2 === 1) return spreads[mid] ?? null;
  return ((spreads[mid - 1] ?? 0) + (spreads[mid] ?? 0)) / 2;
}

/** Quanto o balde prometeu a mais do que entregou. Positivo = lado caro demais. */
export function bucketGap(bucket: ReliabilityBucket): number {
  return bucket.meanPredicted - bucket.observedRate;
}

/**
 * A barra que um gap tem que superar para valer dinheiro: MEIO spread.
 *
 * O eval mede contra o mid; quem opera atravessa o book e paga metade do spread
 * em cada ponta. Gap menor que isso existe, é real, e não paga a travessia.
 *
 * `null` quando a amostra não tem nenhum spread gravado — e aí não há barra, e
 * nenhum balde pode ser chamado de candidato a edge.
 */
export function executionBar(spread: number | null): number | null {
  return spread === null ? null : spread / 2;
}

export type BucketVerdict =
  /** Menos de `MIN_MATCHES_FOR_BUCKET` partidas distintas: não responde nada. */
  | 'nao_conclusivo'
  /** Não há spread na amostra, logo não há barra contra a qual comparar. */
  | 'sem_spread'
  | 'acima_da_barra'
  | 'abaixo_da_barra';

/**
 * O veredito de um balde, na ordem em que as perguntas se respondem.
 *
 * A ordem é a regra: amostra primeiro, barra depois. Um balde com gap enorme e
 * seis partidas não é "acima da barra com ressalva" — é uma linha que ainda não
 * tem o direito de responder, e chamá-la de candidato a edge com uma nota de
 * rodapé é exatamente como um eval limpo vira uma posição perdida.
 */
export function bucketVerdict(bucket: ReliabilityBucket, bar: number | null): BucketVerdict {
  if (bucket.distinctMatches < MIN_MATCHES_FOR_BUCKET) return 'nao_conclusivo';
  if (bar === null) return 'sem_spread';
  return Math.abs(bucketGap(bucket)) > bar ? 'acima_da_barra' : 'abaixo_da_barra';
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

/**
 * Abaixo disto, um balde de calibração não conclui nada.
 *
 * Contado em PARTIDAS distintas e não em análises, pelo motivo em
 * `ReliabilityBucket.distinctMatches`: `n` de análises é inflável por
 * checkpoint, e um balde com 40 análises de 9 partidas não tem 40 desfechos
 * independentes — tem 9.
 */
export const MIN_MATCHES_FOR_BUCKET = 20;

// ---------------------------------------------------------------------------
// Correção de viés, e a validação que a torna checável
// ---------------------------------------------------------------------------

/**
 * Corte da amostra pela metade no tempo.
 *
 * Ordenado por `as_of` — o instante da análise, não o da partida — porque a
 * pergunta é se um viés medido no passado ainda vale no futuro, e é `as_of` que
 * define o que era passado no momento de estimar.
 *
 * O corte é por CONTAGEM (metade dos pontos), não por data no meio do intervalo:
 * a taxa de análises por dia varia muito com o calendário de partidas, e um
 * corte no meio do calendário deixaria as duas metades com tamanhos muito
 * diferentes. Empate exato de `as_of` na fronteira cai para o teste; é no máximo
 * um ponto e não muda estimativa nenhuma.
 */
export function splitByDate(points: readonly EvalPoint[]): {
  train: EvalPoint[];
  test: EvalPoint[];
} {
  const sorted = [...points].sort((a, b) => (a.asOf < b.asOf ? -1 : a.asOf > b.asOf ? 1 : 0));
  const half = Math.floor(sorted.length / 2);
  return { train: sorted.slice(0, half), test: sorted.slice(half) };
}

export interface DebiasArm {
  n: number;
  agent: number | null;
  debiased: number | null;
  market: number | null;
  coin: number | null;
  /** Pontos cuja subtração saiu de [0,01; 0,99] e foram travados. */
  clamped: number;
}

export interface DebiasEvaluation {
  /** O deslocamento estimado na PRIMEIRA metade. É o que a validação usa. */
  offset: number | null;
  /** Viés do agente na primeira metade — o mesmo número que `offset`. */
  agentBiasTrain: number | null;
  /**
   * Viés do MERCADO na primeira metade.
   *
   * A checagem que pode invalidar a correção inteira. Se o mercado erra na mesma
   * direção e na mesma ordem de grandeza, o que os dois estão medindo é a
   * composição da amostra — a frequência com que o lado convencionado "time A"
   * venceu —, e subtrair isso só do agente é sintonizar ruído de amostragem.
   */
  marketBiasTrain: number | null;
  agentBiasFull: number | null;
  marketBiasFull: number | null;
  /** O número principal: estimado na primeira metade, medido na segunda. */
  outOfSample: DebiasArm;
  /**
   * Estimado e aplicado na MESMA amostra. Existe só como referência do teto —
   * não é comparável com o de cima e não sustenta decisão nenhuma.
   */
  inSample: DebiasArm;
  /**
   * Partidas que aparecem nas DUAS metades.
   *
   * Vazamento residual do corte por data: dois checkpoints da mesma partida têm
   * `as_of` diferentes e podem cair em lados opostos, e aí o desfecho que o teste
   * deveria não conhecer já ajudou a estimar o deslocamento. Não invalida a
   * medição enquanto for pequeno, mas tem que ser IMPRESSO — fora-da-amostra com
   * vazamento não contado é dentro-da-amostra com outro nome.
   */
  straddlingMatches: number;
  /**
   * Composição por versão de prompt de cada metade.
   *
   * O corte por data é o certo para a pergunta e tem um efeito colateral que só
   * aparece olhando: versão de prompt também muda com o tempo. Quando uma versão
   * está inteira de um lado do corte, o deslocamento foi estimado num prompt e
   * cobrado noutro, e o que a segunda metade mede deixa de ser "o viés
   * sobrevive ao tempo" para virar "o viés de v1 vale para v2" — que é outra
   * pergunta, com outra resposta. Impresso sempre, porque é invisível no Brier.
   */
  composition: {
    train: Array<{ key: string; n: number }>;
    test: Array<{ key: string; n: number }>;
    /** Versões que aparecem no teste e não no treino. Vazio = corte limpo. */
    unseenInTrain: string[];
  };
}

function byVersion(points: readonly EvalPoint[]): Array<{ key: string; n: number }> {
  const counts = new Map<string, number>();
  for (const point of points) counts.set(point.promptVersion, (counts.get(point.promptVersion) ?? 0) + 1);
  return [...counts].map(([key, n]) => ({ key, n })).sort((a, b) => b.n - a.n);
}

function arm(points: readonly EvalPoint[], offset: number | null): DebiasArm {
  return {
    n: points.length,
    agent: brierScore(points, AGENT),
    debiased: offset === null ? null : brierScore(points, debiasedAgent(offset)),
    market: brierScore(points, MARKET),
    coin: brierScore(points, COIN),
    clamped: offset === null ? 0 : countClamped(points, offset),
  };
}

/**
 * A correção de viés com a validação que a torna uma medição e não um enfeite.
 *
 * Estimar o deslocamento e aplicá-lo na mesma amostra melhora o Brier por
 * construção — a subtração da média é o minimizador exato daquele termo naquele
 * conjunto. O número resultante é bonito, é reprodutível, e não prevê nada. Por
 * isso o principal aqui é a segunda metade: deslocamento estimado num período,
 * cobrado noutro, que é a única forma de o viés provar que é propriedade do
 * agente e não do pedaço de calendário em que foi medido.
 */
export function debiasEvaluation(points: readonly EvalPoint[]): DebiasEvaluation {
  const { train, test } = splitByDate(points);

  const offset = bias(train, AGENT);
  const offsetFull = bias(points, AGENT);

  const trainVersions = new Set(train.map((p) => p.promptVersion));
  const trainMatches = new Set(train.map((p) => p.matchSlug));
  const straddling = new Set(test.filter((p) => trainMatches.has(p.matchSlug)).map((p) => p.matchSlug));

  return {
    offset,
    agentBiasTrain: offset,
    marketBiasTrain: bias(train, MARKET),
    agentBiasFull: offsetFull,
    marketBiasFull: bias(points, MARKET),
    outOfSample: arm(test, offset),
    inSample: arm(points, offsetFull),
    straddlingMatches: straddling.size,
    composition: {
      train: byVersion(train),
      test: byVersion(test),
      unseenInTrain: [...new Set(test.map((p) => p.promptVersion))].filter(
        (v) => !trainVersions.has(v),
      ),
    },
  };
}

/**
 * Acima desta fração de pontos travados, a subtração é o transformador errado.
 *
 * Não é um limiar teórico: é o ponto em que "previsor com viés subtraído" deixa
 * de descrever o que o código faz para uma parte visível da amostra.
 */
export const CLAMP_WARN_FRACTION = 0.1;

/**
 * Abaixo desta fração do erro do previsor cru, a correção não move nada.
 *
 * O sinal do delta do Brier é fácil de ler como veredito — "melhorou, logo o
 * viés é real" — quando a melhora é da quarta casa decimal. Um por cento do erro
 * é o piso do que sobreviveria a qualquer perturbação da amostra; abaixo disso o
 * relatório tem que dizer que o número é positivo E irrelevante, porque as duas
 * coisas são verdade ao mesmo tempo e omitir a segunda é o que transforma uma
 * medição correta numa decisão errada.
 */
export const MIN_BRIER_DELTA_FRACTION = 0.01;
