import {
  MIN_MATCHES_FOR_BUCKET,
  bucketGap,
  bucketVerdict,
  calibrationError,
  executionBar,
  reliabilityBuckets,
  typicalSpread,
  type ReliabilityBucket,
} from './metrics.js';
import {
  CHECKPOINTS,
  PRICE,
  SERIES_START,
  TOLERANCE_SECONDS,
  distinctMatches,
  splitByMatchTime,
  type AnchorlessCoverage,
  type LegacyCoverage,
  type MarketDataset,
  type MarketDiscardReason,
  type MarketPoint,
} from './market-dataset.js';

/**
 * O relatório da calibração do MERCADO. Nada de I/O aqui.
 *
 * A pergunta é uma só — o preço erra de forma sistemática em alguma faixa? — e
 * as seções são as três formas de essa resposta ser falsa mesmo parecendo
 * verdadeira:
 *
 *   1. a tabela pode estar apoiada em partidas de menos (cobertura + baldes),
 *   2. o gap pode ser real e não pagar a travessia do book (a barra),
 *   3. o gap pode existir só num pedaço do calendário (a divisão temporal).
 *
 * A terceira é a que separa achado de miragem, e por isso ela não é opcional
 * nem vem no fim como apêndice: com dez baldes e uma amostra pequena, encontrar
 * UM padrão forte é o que se espera do acaso, não o que refuta ele.
 */

// ---------------------------------------------------------------------------
// Formatação
// ---------------------------------------------------------------------------

function num(value: number | null, digits = 4): string {
  return value === null ? '—' : value.toFixed(digits);
}

function signed(value: number | null, digits = 3): string {
  if (value === null) return '—';
  return `${value >= 0 ? '+' : ''}${value.toFixed(digits)}`;
}

function table(
  headers: readonly string[],
  rows: ReadonlyArray<readonly string[]>,
  leftAlign: readonly number[] = [],
): string {
  if (rows.length === 0) return '  (vazio)';

  const left = new Set([0, ...leftAlign]);
  const widths = headers.map((header, i) =>
    Math.max(header.length, ...rows.map((row) => (row[i] ?? '').length)),
  );

  const line = (cells: readonly string[]): string =>
    '  ' +
    cells
      .map((cell, i) => (left.has(i) ? cell.padEnd(widths[i] ?? 0) : cell.padStart(widths[i] ?? 0)))
      .join('  ')
      .trimEnd();

  const rule = ('  ' + widths.map((w) => '-'.repeat(w)).join('  ')).trimEnd();

  return [line(headers), rule, ...rows.map(line)].join('\n');
}

function section(title: string): string {
  return `\n${title}\n${'='.repeat(title.length)}\n`;
}

function bucketLabel(bucket: ReliabilityBucket): string {
  return `${bucket.from.toFixed(1)}–${bucket.to.toFixed(1)}`;
}

function verdictLabel(bucket: ReliabilityBucket, bar: number | null): string {
  switch (bucketVerdict(bucket, bar)) {
    case 'nao_conclusivo':
      return 'não conclusivo';
    case 'sem_spread':
      return 'sem spread';
    case 'acima_da_barra':
      return 'CANDIDATO A EDGE';
    case 'abaixo_da_barra':
      return 'abaixo da barra';
  }
}

// ---------------------------------------------------------------------------
// Seções
// ---------------------------------------------------------------------------

function universeSection(data: MarketDataset): string {
  const { universe } = data;
  const discardRows = (Object.entries(universe.discards) as Array<[MarketDiscardReason, number]>)
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([reason, n]) => [reason, String(n)]);

  const lines = [
    section('1. UNIVERSO E COBERTURA — de onde vem cada linha'),
    'Uma linha por (partida, checkpoint). Sem agente: o previsor é o preço.',
    '',
    `  partidas cs2 resolvidas lidas:        ${universe.resolvedRead}`,
    `  partidas no universo (série >= ${SERIES_START}): ${universe.matches.length}`,
    `  partidas anteriores a ${SERIES_START}:     ${universe.legacy.length} (vão para a sonda histórica)`,
    `  consultas a esports_snapshots:        ${data.queries}`,
    `  snapshots lidos:                      ${data.snapshotsRead}`,
    '',
    '  descartes de partida (resolvida que não vira nenhuma linha):',
    table(['motivo', 'n'], discardRows),
  ];

  if (universe.duplicateMoneyline > 0) {
    lines.push(
      '',
      `  ${universe.duplicateMoneyline} partida(s) com mais de um moneyline — escolhido o menor event_id.`,
    );
  }

  const rowsByCheckpoint = new Map<number, MarketPoint[]>();
  for (const point of data.points) {
    const bucket = rowsByCheckpoint.get(point.checkpointMinutes);
    if (bucket === undefined) rowsByCheckpoint.set(point.checkpointMinutes, [point]);
    else bucket.push(point);
  }

  lines.push(
    '',
    `  Linhas por checkpoint. "descartada" = nenhum snapshot dentro de ${TOLERANCE_SECONDS}s do`,
    '  instante alvo. Não há interpolação: falta de snapshot é sintoma de coletor',
    '  tropeçando ou de mercado sem book, estados correlacionados com o que se mede,',
    '  e uma trajetória lisa inventada ali mentiria exatamente onde importa.',
    '',
    table(
      [
        'checkpoint',
        'linhas',
        'partidas',
        'sem snapshot',
        'sem mid',
        'janela truncada',
        'com spread',
      ],
      [...data.coverage.entries()]
        .sort((a, b) => b[0] - a[0])
        .map(([checkpoint, counts]) => {
          const rows = rowsByCheckpoint.get(checkpoint) ?? [];
          return [
            `T-${checkpoint}min`,
            String(rows.length),
            String(distinctMatches(rows)),
            String(counts.semSnapshotNaTolerancia),
            String(counts.semMid),
            String(counts.janelasTruncadas),
            String(rows.filter((p) => p.spread !== null).length),
          ];
        }),
    ),
    '',
    `  TOTAL: ${data.points.length} linha(s) sobre ${distinctMatches(data.points)} partida(s) distinta(s).`,
  );

  const offsets = data.points.map((p) => Math.abs(p.offsetSeconds)).sort((a, b) => a - b);
  const medianOffset =
    offsets.length === 0 ? null : (offsets[Math.floor(offsets.length / 2)] ?? null);
  lines.push(
    `  Distância mediana entre o alvo e o snapshot usado: ${medianOffset === null ? '—' : `${medianOffset.toFixed(0)}s`}` +
      ` (tolerância ${TOLERANCE_SECONDS}s).`,
  );

  // De onde veio o horário de cada partida. `esports_matches.scheduled_at` é
  // gravado A PARTIR de `events.game_start_time`, então o fallback lê a mesma
  // fonte e não um relógio diferente — mas se a amostra passar a depender dele,
  // isso tem que estar visível na página, não só no código.
  const recovered = new Set(
    data.universe.matches.filter((m) => m.anchorSource === 'game_start_time').map((m) => m.matchId),
  );
  lines.push(
    `  Âncora do checkpoint: ${data.universe.matches.length - recovered.size} partida(s) por esports_matches.scheduled_at, ` +
      `${recovered.size} recuperada(s) de events.game_start_time`,
    '  (a mesma fonte: o resolver grava uma a partir da outra, e a partida que',
    '  resolveu antes do carimbo chegar ficou com o campo nulo para sempre).',
  );

  return lines.join('\n');
}

/** A tabela de baldes. É a mesma máquina do eval do agente, apontada ao preço. */
function bucketTable(points: readonly MarketPoint[], bar: number | null): string {
  const buckets = reliabilityBuckets(points, PRICE);

  return table(
    ['balde de preço', 'n', 'partidas', 'previsto', 'observado', 'gap', ''],
    buckets.map((b) => [
      bucketLabel(b),
      String(b.n),
      String(b.distinctMatches),
      num(b.meanPredicted, 3),
      num(b.observedRate, 3),
      signed(bucketGap(b)),
      verdictLabel(b, bar),
    ]),
    [6],
  );
}

function calibrationSection(
  data: MarketDataset,
  bar: number | null,
  spread: number | null,
): string {
  const buckets = reliabilityBuckets(data.points, PRICE);
  const conclusive = buckets.filter((b) => b.distinctMatches >= MIN_MATCHES_FOR_BUCKET);
  const clearing = conclusive.filter((b) => bucketVerdict(b, bar) === 'acima_da_barra');

  const lines = [
    section('2. CALIBRAÇÃO DO MERCADO — o preço erra em alguma faixa?'),
    'Baldes de 10pp sobre o preço, os dois checkpoints juntos. "Das vezes que o',
    'mercado pediu 0,70, quantas o time A venceu."',
    '',
    bucketTable(data.points, bar),
    '',
    '  gap positivo  = o preço pedia mais do que aconteceu (lado caro demais)',
    '  gap negativo  = o preço pedia menos do que aconteceu (lado barato demais)',
    `  ECE do mercado: ${num(calibrationError(buckets), 4)}`,
    '',
    'A BARRA',
    '-------',
    '  O eval mede contra o MID; quem opera atravessa o book e paga o ask. A barra',
    '  não é "gap ≠ 0", é:',
    '',
    ...(bar === null
      ? [
          '    |gap| > ½ spread típico — e o spread típico NÃO EXISTE nesta amostra:',
          '    nenhuma linha tem os dois lados do book gravados. Sem esse número não há',
          '    barra, e nenhum balde pode ser chamado de candidato a edge.',
        ]
      : [`    |gap| > ${num(bar, 4)}  (½ de um spread típico de ${num(spread, 4)})`]),
    '',
    `  Baldes conclusivos (≥ ${MIN_MATCHES_FOR_BUCKET} partidas distintas): ${conclusive.length} de ${buckets.length}.`,
    `  Desses, acima da barra: ${clearing.length}.`,
  ];

  if (conclusive.length === 0) {
    lines.push(
      '',
      '  NENHUM balde é conclusivo. A contagem que vale é a de PARTIDAS distintas, não',
      '  a de linhas: os dois checkpoints da mesma partida dividem o mesmo desfecho e',
      '  não são duas evidências. O que há aqui é uma tabela que ainda não tem o',
      '  direito de responder à pergunta — e um gap grande num balde curto é o achado',
      '  mais fácil de encontrar e o mais fácil de perder dinheiro com.',
    );
  } else if (clearing.length === 0) {
    lines.push(
      '',
      '  Nenhum balde conclusivo supera meio spread. O preço pode estar torto, mas não',
      '  o bastante para pagar a travessia — não há edge mecânico declarável aqui.',
    );
  } else {
    lines.push(
      '',
      '  Há balde conclusivo acima da barra. Antes de chamar de edge: a direção tem que',
      '  se repetir em faixa vizinha (seção 2) E sobreviver à divisão temporal (seção 4).',
    );
  }

  return lines.join('\n');
}

function checkpointSection(data: MarketDataset, bar: number | null): string {
  const lines = [
    section('3. POR CHECKPOINT — o mercado erra QUANDO?'),
    'T-360 e T-60 separados. Se o viés existe num e não no outro, isso é informação',
    'sobre quando o preço erra — e o balde que junta os dois esconde exatamente essa',
    'informação, porque o mesmo desfecho entra duas vezes com preços diferentes.',
  ];

  for (const checkpoint of [...CHECKPOINTS].sort((a, b) => b - a)) {
    const points = data.points.filter((p) => p.checkpointMinutes === checkpoint);
    lines.push(
      '',
      `T-${checkpoint}min — ${points.length} linha(s), ${distinctMatches(points)} partida(s)`,
      bucketTable(points, bar),
    );
  }

  return lines.join('\n');
}

/**
 * A divisão temporal.
 *
 * O relatório imprime as duas metades LADO A LADO por balde, e não duas tabelas
 * soltas, porque a leitura que decide é a comparação célula a célula: um viés
 * favorito-azarão real aparece com o MESMO SINAL nas duas colunas. Um que aparece
 * numa e some na outra é mineração de dados encontrando padrão em ruído, e com
 * dez baldes isso acontece por acaso com facilidade.
 */
function temporalSection(data: MarketDataset, bar: number | null): string {
  const { older, newer } = splitByMatchTime(data.points);
  const olderBuckets = new Map(reliabilityBuckets(older, PRICE).map((b) => [bucketLabel(b), b]));
  const newerBuckets = new Map(reliabilityBuckets(newer, PRICE).map((b) => [bucketLabel(b), b]));

  const labels = [...new Set([...olderBuckets.keys(), ...newerBuckets.keys()])].sort();

  const cell = (bucket: ReliabilityBucket | undefined): string[] =>
    bucket === undefined
      ? ['0', '0', '—']
      : [String(bucket.n), String(bucket.distinctMatches), signed(bucketGap(bucket))];

  const agree = labels.filter((label) => {
    const a = olderBuckets.get(label);
    const b = newerBuckets.get(label);
    if (a === undefined || b === undefined) return false;
    const ga = bucketGap(a);
    const gb = bucketGap(b);
    return ga !== 0 && gb !== 0 && Math.sign(ga) === Math.sign(gb);
  });

  const bothConclusive = labels.filter((label) => {
    const a = olderBuckets.get(label);
    const b = newerBuckets.get(label);
    return (
      a !== undefined &&
      b !== undefined &&
      a.distinctMatches >= MIN_MATCHES_FOR_BUCKET &&
      b.distinctMatches >= MIN_MATCHES_FOR_BUCKET
    );
  });

  const surviving = bothConclusive.filter((label) => {
    const a = olderBuckets.get(label);
    const b = newerBuckets.get(label);
    if (a === undefined || b === undefined || bar === null) return false;
    return (
      Math.sign(bucketGap(a)) === Math.sign(bucketGap(b)) &&
      Math.abs(bucketGap(a)) > bar &&
      Math.abs(bucketGap(b)) > bar
    );
  });

  const olderSpan = span(older);
  const newerSpan = span(newer);

  const lines = [
    section('4. DIVISÃO TEMPORAL — o viés sobrevive fora do pedaço em que foi visto?'),
    'Metade mais antiga contra metade mais recente, mesmos baldes. O corte é por',
    'PARTIDA (não por linha): nenhuma partida aparece nas duas metades, então os dois',
    'lados da comparação são de fato independentes.',
    '',
    `  metade antiga:  ${distinctMatches(older)} partida(s), ${older.length} linha(s)  ${olderSpan}`,
    `  metade recente: ${distinctMatches(newer)} partida(s), ${newer.length} linha(s)  ${newerSpan}`,
    '',
    table(
      [
        'balde de preço',
        'n (ant)',
        'part (ant)',
        'gap (ant)',
        'n (rec)',
        'part (rec)',
        'gap (rec)',
        'mesmo sinal',
      ],
      labels.map((label) => {
        const a = olderBuckets.get(label);
        const b = newerBuckets.get(label);
        return [label, ...cell(a), ...cell(b), agree.includes(label) ? 'sim' : 'não'];
      }),
      [7],
    ),
    '',
    `  Baldes com as duas metades conclusivas (≥ ${MIN_MATCHES_FOR_BUCKET} partidas de cada lado): ${bothConclusive.length}.`,
    `  Desses, com o mesmo sinal E acima da barra nas duas: ${surviving.length}.`,
  ];

  if (bothConclusive.length === 0) {
    lines.push(
      '',
      '  NENHUM balde tem as duas metades conclusivas — o teste não foi feito, ele foi',
      '  apenas impresso. A coluna "mesmo sinal" acima é sugestiva e não é evidência:',
      '  com poucas partidas por célula, dois sinais iguais saem de uma moeda em metade',
      '  das vezes. Enquanto esta linha existir, a resposta a "o viés sobrevive?" é',
      '  NÃO SEI, e não "sim".',
    );
  } else if (surviving.length === 0) {
    lines.push(
      '',
      '  Nenhum balde conclusivo dos dois lados mantém o gap acima da barra nas duas',
      '  metades. O que foi visto numa metade não se repetiu na outra — que é',
      '  exatamente o que ruído faz.',
    );
  } else {
    lines.push(
      '',
      '  Há balde que sobrevive à divisão: mesmo sinal e acima da barra nas duas',
      '  metades, com amostra dos dois lados. É o mais forte que esta tabela consegue',
      '  dizer — e ainda assim é uma regra a ser declarada a partir do PREÇO e testada',
      '  para frente, não uma posição a ser aberta com base no passado.',
    );
  }

  return lines.join('\n');
}

function span(points: readonly MarketPoint[]): string {
  if (points.length === 0) return '';
  const dates = points.map((p) => p.scheduledAt).sort();
  return `(${(dates[0] ?? '').slice(0, 10)} a ${(dates[dates.length - 1] ?? '').slice(0, 10)})`;
}

/**
 * A sonda que dimensiona tudo, em duas partes — porque o histórico falha por
 * dois motivos diferentes e só um deles é o que se esperava.
 *
 * O esperado era retenção: a série de evento resolvido apagada sem condição de
 * idade (migration 20260806032316). O outro é mais banal e maior — partida
 * resolvida sem horário nenhum, nem em `esports_matches.scheduled_at` nem em
 * `events.game_start_time`. Sem horário não há "T-360": não é falta de preço, é
 * falta da pergunta. As duas partes são medidas separadamente porque o conserto
 * de uma não é o conserto da outra.
 */
function legacySection(
  legacy: LegacyCoverage | null,
  anchorless: AnchorlessCoverage | null,
): string {
  const lines = [section('5. SONDA HISTÓRICA — existe preço recuperável de antes de 05/08?')];

  if (legacy === null && anchorless === null) {
    lines.push(
      '  NÃO MEDIDA nesta rodada (--legacy-limit=0). O universo desta análise segue',
      '  sendo só o pós-05/08 — e essa é uma escolha de execução, não uma resposta.',
    );
    return lines.join('\n');
  }

  lines.push(
    'Se o histórico for recuperável, o universo é de milhares de partidas e a',
    'conclusão chega hoje; se não, é o pós-05/08 crescendo no ritmo do calendário,',
    'e a conclusão chega em semanas. Medido, não suposto.',
  );

  if (legacy !== null) {
    lines.push(
      '',
      `A) partidas COM horário e anteriores a ${SERIES_START}`,
      `  candidatas (moneyline + rótulo resolvido):              ${legacy.candidates}`,
      `  sondadas:                                              ${legacy.probed}`,
      `  com ALGUMA série em polymarket_snapshots:              ${legacy.comSeriePolymarket}`,
      `  com ALGUMA série em esports_snapshots:                 ${legacy.comSerieEsports}`,
      `  com preço em pelo menos um checkpoint (na tolerância): ${legacy.comCheckpoint}`,
      `  linhas que o dataset ganharia:                         ${legacy.linhasRecuperaveis}`,
      `  consultas gastas:                                      ${legacy.queries}`,
    );

    if (legacy.probed < legacy.candidates) {
      lines.push(
        `  AMOSTRA: só ${legacy.probed} de ${legacy.candidates} sondadas — fração, não contagem.`,
      );
    }
  }

  if (anchorless !== null) {
    lines.push(
      '',
      'B) partidas resolvidas SEM horário em lugar nenhum',
      '  Não entram no dataset por falta de âncora, não por falta de preço. A sonda',
      '  pergunta se sobrou série do mercado delas — é o que separa "falta um backfill',
      '  de horário" de "não há o que recuperar".',
      '',
      `  candidatas:                              ${anchorless.candidates}`,
      `  sondadas:                                ${anchorless.probed}`,
      `  com ALGUMA linha em polymarket_snapshots: ${anchorless.comSeriePolymarket}`,
      `  com ALGUMA linha em esports_snapshots:    ${anchorless.comSerieEsports}`,
      `  captura mais recente encontrada:          ${anchorless.ultimaCaptura ?? '(nenhuma)'}`,
      `  consultas gastas:                         ${anchorless.queries}`,
    );

    if (anchorless.probed < anchorless.candidates) {
      lines.push(
        `  AMOSTRA: só ${anchorless.probed} de ${anchorless.candidates} sondadas — fração, não contagem.`,
      );
    }
  }

  // Duas coisas diferentes, e confundi-las é o erro que esta seção existe para
  // evitar: linha RECUPERÁVEL é série mais âncora; série sem âncora não vira
  // linha nenhuma sem um backfill de horário que ninguém fez ainda.
  const recoverable = legacy?.comCheckpoint ?? 0;
  const seriesWithoutAnchor =
    (anchorless?.comSeriePolymarket ?? 0) + (anchorless?.comSerieEsports ?? 0);
  const anySeries =
    recoverable +
    seriesWithoutAnchor +
    (legacy?.comSeriePolymarket ?? 0) +
    (legacy?.comSerieEsports ?? 0);

  if (recoverable === 0 && seriesWithoutAnchor > 0) {
    lines.push(
      '',
      `  NADA recuperável como linha, e não por pouco: ${seriesWithoutAnchor} partida(s) ainda têm alguma`,
      '  série, mas NENHUMA delas tem horário — sem âncora não existe "T-360min" a pedir,',
      `  e a captura mais recente delas (${anchorless?.ultimaCaptura?.slice(0, 10) ?? '—'}) é da própria virada da tabela nova,`,
      '  não do histórico. Para essas partidas entrarem faltaria um backfill de horário,',
      '  e o que ele traria são as poucas dezenas acima, não as milhares.',
      '',
      '  Em polymarket_snapshots, onde o histórico realmente morava: zero. É o',
      '  comportamento esperado da retenção antiga, que apagava a série de evento',
      '  resolvido sem nenhuma condição de idade (migration 20260806032316) — a série',
      '  pré-partida e o rótulo morriam juntos, horas depois do jogo.',
      '',
      '  O universo desta análise é o pós-05/08 e só cresce com o calendário.',
    );
  } else if (anySeries === 0) {
    lines.push(
      '',
      '  NADA recuperável, nos dois grupos. É o comportamento esperado da retenção',
      '  antiga, que apagava a série de evento resolvido sem nenhuma condição de idade',
      '  (migration 20260806032316): a série pré-partida e o rótulo morriam juntos,',
      '  horas depois do jogo. O universo desta análise é o pós-05/08 e só cresce com o',
      '  calendário — nenhum backfill traz de volta o que não está no banco.',
    );
  } else {
    lines.push(
      '',
      '  Há série recuperável. Antes de incorporar, duas conferências: se a partida tem',
      '  horário (sem ele a série existe e não há checkpoint a pedir), e se o preço de',
      '  polymarket_snapshots é comparável ao de esports_snapshots no mesmo mercado —',
      '  cadência diferente muda quanto a tolerância seleciona, e uma amostra montada',
      '  com duas cadências mede as duas épocas, não o mercado.',
    );
  }

  return lines.join('\n');
}

/** As quatro linhas. É o que sobra quando o relatório inteiro é resumido. */
function verdictSection(
  data: MarketDataset,
  legacy: LegacyCoverage | null,
  anchorless: AnchorlessCoverage | null,
  bar: number | null,
): string {
  const totalDiscarded = [...data.coverage.values()].reduce(
    (sum, c) => sum + c.semSnapshotNaTolerancia + c.semMid,
    0,
  );

  const perCheckpoint = [...CHECKPOINTS]
    .sort((a, b) => b - a)
    .map((checkpoint) => {
      const points = data.points.filter((p) => p.checkpointMinutes === checkpoint);
      const conclusive = reliabilityBuckets(points, PRICE).filter(
        (b) => b.distinctMatches >= MIN_MATCHES_FOR_BUCKET,
      ).length;
      return `T-${checkpoint}: ${conclusive}`;
    })
    .join('  ');

  const { older, newer } = splitByMatchTime(data.points);
  const olderBuckets = new Map(reliabilityBuckets(older, PRICE).map((b) => [bucketLabel(b), b]));
  const newerBuckets = reliabilityBuckets(newer, PRICE);

  // Testável é o balde com amostra dos DOIS lados. A distinção decide a redação
  // da linha 3: zero sobreviventes entre dez testáveis é "não sobrevive"; zero
  // entre zero testáveis é "não sei", e imprimir os dois casos com o mesmo "0"
  // seria transformar falta de amostra em resultado negativo.
  const testable = newerBuckets.filter((b) => {
    const a = olderBuckets.get(bucketLabel(b));
    return (
      a !== undefined &&
      a.distinctMatches >= MIN_MATCHES_FOR_BUCKET &&
      b.distinctMatches >= MIN_MATCHES_FOR_BUCKET
    );
  });

  const survivors = testable.filter((b) => {
    const a = olderBuckets.get(bucketLabel(b));
    if (a === undefined || bar === null) return false;
    return (
      Math.sign(bucketGap(a)) === Math.sign(bucketGap(b)) &&
      Math.abs(bucketGap(a)) > bar &&
      Math.abs(bucketGap(b)) > bar
    );
  }).length;

  return [
    section('RESPOSTA EM QUATRO LINHAS'),
    `  1. universo: ${data.universe.matches.length} partida(s), ${data.points.length} linha(s); ` +
      `${totalDiscarded} descartada(s) por falta de snapshot na tolerância.`,
    `  2. baldes com ≥ ${MIN_MATCHES_FOR_BUCKET} partidas distintas, por checkpoint: ${perCheckpoint}.`,
    `  3. divisão temporal: ${
      testable.length === 0
        ? 'NÃO SEI — nenhum balde tem ≥ ' +
          `${MIN_MATCHES_FOR_BUCKET} partidas nas DUAS metades, então o teste não pôde ser feito.`
        : `${survivors} de ${testable.length} balde(s) testável(is) mantêm sinal e barra nas duas metades.`
    }`,
    `  4. preço recuperável antes de ${SERIES_START}: ` +
      (legacy === null && anchorless === null
        ? 'não medido nesta rodada.'
        : `${legacy?.comCheckpoint ?? 0} partida(s) com horário e preço em checkpoint ` +
          `(de ${legacy?.probed ?? 0} sondadas); e ${anchorless?.comSeriePolymarket ?? 0} + ` +
          `${anchorless?.comSerieEsports ?? 0} partida(s) sem horário com alguma série ` +
          `(de ${anchorless?.probed ?? 0} sondadas).`),
  ].join('\n');
}

// ---------------------------------------------------------------------------

export function renderMarketReport(
  data: MarketDataset,
  legacy: LegacyCoverage | null,
  anchorless: AnchorlessCoverage | null = null,
): string {
  const spread = typicalSpread(data.points);
  const bar = executionBar(spread);

  return [
    'CALIBRAÇÃO DO MERCADO — CS2',
    '===========================',
    'Dataset market-cêntrico: uma linha por (partida, checkpoint). Nenhum agente',
    'participa desta amostra — o que está sendo pontuado é o PREÇO contra o desfecho.',
    universeSection(data),
    calibrationSection(data, bar, spread),
    checkpointSection(data, bar),
    temporalSection(data, bar),
    legacySection(legacy, anchorless),
    verdictSection(data, legacy, anchorless, bar),
    '',
  ].join('\n');
}
