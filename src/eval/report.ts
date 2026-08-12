import {
  AGENT,
  CLAMP_WARN_FRACTION,
  COIN,
  MARKET,
  MIN_BRIER_DELTA_FRACTION,
  MIN_MATCHES_FOR_BUCKET,
  MIN_N_FOR_SIGNAL,
  bias,
  brierScore,
  bucketVerdict,
  calibrationError,
  cut,
  debiasEvaluation,
  executionBar,
  liquidityBand,
  murphyDecomposition,
  pairedSample,
  reliabilityBuckets,
  skillScore,
  typicalSpread,
  type CutRow,
  type EvalPoint,
} from './metrics.js';
import type { EvalDataset } from './dataset.js';

/**
 * O relatório em texto. Nada de I/O aqui — recebe o dataset, devolve string.
 *
 * A ordem das seções é a ordem das perguntas, e ela importa: o agente bate o
 * mercado? Onde? Ele acredita no que diz? Ele inventa fato? O que ele recusou
 * responder? Uma seção só faz sentido depois da anterior, e por isso o relatório
 * não é uma tabela grande — é uma sequência.
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

function pct(value: number | null, digits = 1): string {
  return value === null ? '—' : `${(value * 100).toFixed(digits)}%`;
}

/**
 * Tabela de largura fixa. Números à direita, texto à esquerda.
 *
 * Alinhamento à direita nos números porque a leitura que interessa é comparar
 * casas decimais entre linhas, e coluna desalinhada obriga a ler dígito a dígito.
 * `leftAlign` diz quais colunas são texto; a 0 sempre é.
 */
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

  // `trimEnd` aqui também: a última coluna de alguns recortes é uma marca que
  // costuma vir vazia, e sem isso a régua sai com espaços pendurados.
  const rule = ('  ' + widths.map((w) => '-'.repeat(w)).join('  ')).trimEnd();

  return [line(headers), rule, ...rows.map(line)].join('\n');
}

function section(title: string): string {
  return `\n${title}\n${'='.repeat(title.length)}\n`;
}

function ranking(entries: ReadonlyArray<{ key: string; n: number }>, total: number): string {
  if (entries.length === 0) return '  (vazio)';
  return table(
    ['', 'n', '%'],
    entries.map((e) => [e.key, String(e.n), total === 0 ? '—' : pct(e.n / total)]),
  );
}

// ---------------------------------------------------------------------------
// Seções
// ---------------------------------------------------------------------------

function cutTable(rows: readonly CutRow[]): string {
  return table(
    ['recorte', 'n', 'agente', 'mercado', '50/50', 'skill', 'viés', ''],
    rows.map((row) => [
      row.label,
      String(row.n),
      num(row.agent),
      num(row.market),
      num(row.coin),
      signed(row.skillVsMarket),
      signed(row.bias),
      row.n < MIN_N_FOR_SIGNAL ? 'amostra curta' : '',
    ]),
    [7],
  );
}

function headline(points: readonly EvalPoint[]): string {
  const paired = pairedSample(points);
  const agent = brierScore(paired, AGENT);
  const market = brierScore(paired, MARKET);
  const coin = brierScore(paired, COIN);
  const agentAll = brierScore(points, AGENT);

  const lines = [
    section('1. Brier — o agente contra os baselines'),
    'Menor é melhor. 0,25 é a moeda. A comparação roda só sobre as análises que',
    'têm preço de mercado gravado, para os três previsores verem a mesma amostra.',
    '',
    table(
      ['previsor', 'n', 'Brier', 'skill vs mercado'],
      [
        ['agente', String(paired.length), num(agent), signed(skillScore(agent, market))],
        ['mercado (as_of)', String(paired.length), num(market), '—'],
        ['50/50', String(paired.length), num(coin), signed(skillScore(coin, market))],
      ],
    ),
  ];

  if (points.length !== paired.length) {
    lines.push(
      '',
      `  Fora da comparação por falta de market_mid: ${points.length - paired.length} de ${points.length} análises`,
      `  pontuáveis. Sobre as ${points.length}, o Brier do agente é ${num(agentAll)}.`,
      '  Se divergir muito do de cima, a amostra com preço não é representativa e o',
      '  resto do relatório merece desconfiança.',
    );
  }

  if (paired.length === 0) {
    lines.push('', '  Sem amostra pontuável com preço. Nada abaixo tem o que medir.');
    return lines.join('\n');
  }

  if (paired.length < MIN_N_FOR_SIGNAL) {
    lines.push(
      '',
      `  AMOSTRA CURTA (n = ${paired.length}, mínimo ${MIN_N_FOR_SIGNAL}). A diferença entre dois Brier`,
      '  aqui é ruído amostral. Os números existem para conferir o encanamento, não',
      '  para decidir se há edge.',
    );
  }

  const skill = skillScore(agent, market);
  if (skill !== null && paired.length >= MIN_N_FOR_SIGNAL) {
    lines.push(
      '',
      skill > 0
        ? `  O agente bate o preço em ${pct(skill)} do erro do mercado.`
        : '  O agente NÃO bate o preço. Sem isso não há edge, e o resto é diagnóstico',
    );
  }

  return lines.join('\n');
}

function cuts(points: readonly EvalPoint[]): string {
  return [
    section('2. Recortes — onde ele é bom e onde é ruim'),
    'Uma média única esconde os dois. Cada linha é uma amostra independente, com',
    'os três previsores sobre os mesmos pontos.',
    '',
    'Por checkpoint',
    cutTable(cut(points, (p) => `T-${p.checkpointMinutes}min`)),
    '',
    'Por modelo',
    cutTable(cut(points, (p) => p.model ?? '(sem modelo)')),
    '',
    'Por versão de prompt',
    cutTable(cut(points, (p) => p.promptVersion)),
    '',
    'Por faixa de liquidez',
    cutTable(cut(points, (p) => liquidityBand(p.liquidity))),
  ].join('\n');
}

function calibration(points: readonly EvalPoint[]): string {
  const buckets = reliabilityBuckets(points, AGENT);
  const murphy = murphyDecomposition(points, AGENT);
  const overallBias = bias(points, AGENT);

  const lines = [
    section('3. Calibração — ele acredita no que diz?'),
    'Das vezes que disse 70%, quantas aconteceram. Um agente pode ter Brier',
    'razoável e errar sempre para o mesmo lado; é isso que esta seção pega.',
    '',
    table(
      ['balde', 'n', 'previsto', 'observado', 'gap'],
      buckets.map((b) => [
        `${b.from.toFixed(1)}–${b.to.toFixed(1)}`,
        String(b.n),
        num(b.meanPredicted, 3),
        num(b.observedRate, 3),
        signed(b.meanPredicted - b.observedRate),
      ]),
    ),
    '',
    `  gap positivo  = disse mais do que aconteceu (excesso de confiança no time A)`,
    `  erro de calibração (ECE): ${num(calibrationError(buckets), 4)}`,
    `  viés global (média prevista − frequência observada): ${signed(overallBias)}`,
  ];

  if (murphy !== null) {
    lines.push(
      '',
      'Decomposição de Murphy — Brier = confiabilidade − resolução + incerteza',
      table(
        ['termo', 'valor', 'leitura'],
        [
          ['confiabilidade', num(murphy.reliability), 'menor é melhor'],
          ['resolução', num(murphy.resolution), 'maior é melhor'],
          ['incerteza', num(murphy.uncertainty), 'da amostra, não do agente'],
        ],
      ),
      '',
      '  Resolução perto de zero é o modo de falha silencioso: um agente que responde',
      '  ~0,5 sempre fica bem calibrado, tem Brier aceitável e não serve para nada.',
    );
  }

  const teamARate =
    points.length === 0 ? null : points.filter((p) => p.outcome === 1).length / points.length;
  lines.push(
    '',
    `  Frequência-base do time A na amostra: ${pct(teamARate)}. "Time A" é o lado que o`,
    '  resolver casou com outcome_a_index, não "o favorito" — mas se esta taxa estiver',
    '  longe de 50%, um viés na tabela acima pode ser composição da amostra e não do',
    '  agente. Conferir antes de chamar de otimismo.',
  );

  return lines.join('\n');
}

/**
 * A mesma máquina de calibração apontada para o PREÇO.
 *
 * Muda a pergunta inteira. A calibração do agente pergunta se ele acredita no
 * que diz; esta pergunta se o mercado erra de forma sistemática em alguma faixa
 * de preço — azarão caro demais, favorito barato demais. Se errar, o edge é
 * mecânico: não precisa de modelo, de agente, nem de fragmento. Precisa só da
 * faixa e de disciplina.
 *
 * Roda sobre a interseção porque um ponto sem `market_mid` não tem faixa de
 * preço a que pertencer.
 */
function marketCalibration(points: readonly EvalPoint[]): string {
  const paired = pairedSample(points);
  const buckets = reliabilityBuckets(paired, MARKET);
  const spread = typicalSpread(paired);
  const bar = executionBar(spread);

  const mark = (b: (typeof buckets)[number]): string => {
    switch (bucketVerdict(b, bar)) {
      case 'nao_conclusivo':
        return 'não conclusivo';
      case 'sem_spread':
        return 'sem spread';
      case 'acima_da_barra':
        return 'CANDIDATO A EDGE';
      case 'abaixo_da_barra':
        return 'abaixo da barra';
    }
  };

  const lines = [
    section('4. Calibração do MERCADO — no recorte que o agente vê'),
    'ATENÇÃO AO DENOMINADOR, ANTES DA TABELA:',
    '',
    '  Esta amostra é FILTRADA PELO PORTÃO. Só existe análise onde o portão deixou',
    '  passar — liquidez acima do piso, mercado dentro dos critérios —, então esta',
    '  tabela NÃO representa o mercado de CS2. Ela representa a fatia dele que o',
    '  agente de fato vê. Foi exatamente essa filtragem que produziu aqui gaps de até',
    '  0,169 que NÃO se reproduzem quando a mesma conta roda sobre todas as partidas.',
    '',
    '  A medida que vale para "o mercado erra em alguma faixa?" é outra:',
    '',
    '      npm run eval:market',
    '',
    '  Ela monta um dataset market-cêntrico — uma linha por (partida, checkpoint),',
    '  sem agente nenhum, sem portão — e cresce no ritmo do calendário e não no do',
    '  analista. Qualquer conclusão sobre o MERCADO sai de lá, não daqui.',
    '',
    '  O que esta seção mede é uma pergunta legítima e diferente: dentro do recorte',
    '  que o portão entrega ao agente, o preço está calibrado? É a pergunta certa',
    '  para decidir se o agente tem contra o que competir onde ele opera.',
    '',
    'Os mesmos baldes de 10pp, agora sobre o preço do mercado.',
    '',
    table(
      ['balde', 'n', 'partidas', 'previsto', 'observado', 'gap', ''],
      buckets.map((b) => [
        `${b.from.toFixed(1)}–${b.to.toFixed(1)}`,
        String(b.n),
        String(b.distinctMatches),
        num(b.meanPredicted, 3),
        num(b.observedRate, 3),
        signed(b.meanPredicted - b.observedRate),
        mark(b),
      ]),
      [6],
    ),
    '',
    `  gap positivo  = o preço pedia mais do que aconteceu (lado caro demais)`,
    `  gap negativo  = o preço pedia menos do que aconteceu (lado barato demais)`,
    `  erro de calibração do mercado (ECE): ${num(calibrationError(buckets), 4)}`,
    `  viés global do mercado (média prevista − frequência observada): ${signed(bias(paired, MARKET))}`,
  ];

  lines.push(
    '',
    'A LEITURA QUE IMPORTA',
    '---------------------',
    '  O eval compara contra o MID. Quem opera atravessa o book e paga o ask. Um gap',
    '  medido no mid só vira dinheiro se sobreviver à travessia, e a travessia custa',
    '  metade do spread em cada ponta. Logo a barra não é "gap ≠ 0": é',
    '',
    ...(bar === null
      ? [
          '    |gap| > ½ spread típico — e o spread típico NÃO EXISTE nesta amostra:',
          '    nenhum ponto tem os dois lados do book gravados. Sem esse número não há',
          '    barra, e nenhum balde acima pode ser chamado de candidato a edge.',
        ]
      : [`    |gap| > ${num(bar, 4)}  (½ de um spread típico de ${num(spread, 4)})`]),
    '',
    '  Gap CONSISTENTE e acima dessa barra é candidato a edge mecânico. Gap abaixo',
    '  dela é academicamente interessante e operacionalmente inútil: existe, é real,',
    '  e não paga a travessia do book. Não é um achado fraco — é um não-achado, e',
    '  tratá-lo como achado fraco é como um eval limpo vira uma posição perdida.',
    '',
    '  "Consistente" é a segunda exigência, e ela não sai desta tabela: um balde',
    '  isolado acima da barra entre dez baldes é o que se espera de ruído. O que',
    '  sustenta a leitura é gap na MESMA direção em faixas vizinhas — a assinatura do',
    '  favorito-azarão é gap negativo em cima e positivo embaixo, não um pico solto.',
  );

  const conclusive = buckets.filter((b) => b.distinctMatches >= MIN_MATCHES_FOR_BUCKET);
  const clearing = conclusive.filter((b) => bucketVerdict(b, bar) === 'acima_da_barra');

  lines.push(
    '',
    `  Baldes conclusivos (≥ ${MIN_MATCHES_FOR_BUCKET} partidas distintas): ${conclusive.length} de ${buckets.length}.`,
    `  Desses, acima da barra de meio spread: ${clearing.length}.`,
  );

  if (conclusive.length === 0) {
    lines.push(
      '',
      '  NENHUM balde é conclusivo. Toda linha acima está apoiada em menos de',
      `  ${MIN_MATCHES_FOR_BUCKET} partidas distintas, e a contagem que vale é a de partidas e não a de`,
      '  análises: dois checkpoints da mesma partida dividem o mesmo desfecho e não',
      '  são duas evidências. Não há candidato a edge nesta amostra — o que há é uma',
      '  tabela que ainda não tem o direito de responder à pergunta.',
    );
  } else if (clearing.length === 0) {
    lines.push(
      '',
      '  Nenhum balde conclusivo supera meio spread. O mercado pode estar torto, mas',
      '  não o bastante para pagar a travessia — não há edge mecânico declarável aqui.',
    );
  } else {
    lines.push(
      '',
      '  Há balde conclusivo acima da barra. Antes de chamar de edge: conferir se a',
      '  direção se repete em faixa vizinha, e que a regra seja declarável a partir do',
      '  PREÇO — que é observável antes do desfecho — e não do resultado.',
    );
  }

  return lines.join('\n');
}

/**
 * A correção mais barata que existe, e a validação que decide se ela é real.
 *
 * O relatório imprime o fora-da-amostra como número principal e o
 * dentro-da-amostra rotulado, nessa ordem e nunca lado a lado sem rótulo, porque
 * a única leitura errada que esta seção pode induzir é comparar os dois.
 */
function debias(points: readonly EvalPoint[]): string {
  const paired = pairedSample(points);
  const ev = debiasEvaluation(paired);

  const lines = [
    section('5. AGENT_DEBIASED — o viés sobrevive fora da amostra?'),
    'Viés é a coisa mais barata de corrigir: subtrair uma constante, sem tocar em',
    'prompt nem em modelo. Também é a mais fácil de fingir — estimar o deslocamento',
    'e cobrá-lo na mesma amostra melhora o Brier POR CONSTRUÇÃO. Por isso o número',
    'principal aqui é o da segunda metade do calendário, com o deslocamento',
    'estimado só na primeira.',
    '',
    'ANTES DE TUDO: o mercado tem o mesmo viés?',
    '------------------------------------------',
    table(
      ['previsor', 'viés (1ª metade)', 'viés (amostra toda)'],
      [
        ['agente', signed(ev.agentBiasTrain), signed(ev.agentBiasFull)],
        ['mercado', signed(ev.marketBiasTrain), signed(ev.marketBiasFull)],
      ],
    ),
    '',
    '  Se os dois erram na mesma direção e na mesma ordem de grandeza, o que ambos',
    '  estão medindo é a COMPOSIÇÃO da amostra — a frequência com que o lado',
    '  convencionado "time A" venceu —, e não um defeito do agente. Corrigir só o',
    '  agente nesse caso é sintonizar ruído de amostragem: o número melhora, e o que',
    '  ele mede é o quanto o time A ganhou neste pedaço de calendário.',
  ];

  const agentB = ev.agentBiasFull;
  const marketB = ev.marketBiasFull;
  if (agentB !== null && marketB !== null) {
    const sameDirection = agentB * marketB > 0;
    const ratio = Math.abs(marketB) / Math.max(Math.abs(agentB), 1e-9);
    lines.push(
      '',
      sameDirection && ratio >= 0.5
        ? '  VEREDITO: o mercado tem viés parecido, mesma direção e mesma ordem de\n' +
            '  grandeza. A leitura que se sustenta é COMPOSIÇÃO DA AMOSTRA, não otimismo do\n' +
            '  agente — e esta seção inteira vira ruído sintonizado. Ver o número abaixo\n' +
            '  como confirmação disso, não como correção que valha aplicar.'
        : sameDirection
          ? '  VEREDITO: mesma direção, mas o viés do mercado é bem menor. Parte do viés do\n' +
            '  agente é composição da amostra; o excedente sobre o do mercado é o que pode\n' +
            '  ser dele. Corrigir pelo viés TOTAL corrige as duas coisas de uma vez.'
          : '  VEREDITO: os dois vieses apontam em direções opostas. O do agente não é\n' +
            '  composição da amostra — o mercado viu a mesma amostra e errou para o outro\n' +
            '  lado. Aqui a correção mede algo do agente.',
    );
  }

  if (ev.offset === null || ev.outOfSample.n === 0) {
    lines.push(
      '',
      '  Amostra pequena demais para dividir em duas metades. Sem fora-da-amostra não',
      '  há o que reportar: o dentro-da-amostra sozinho não é evidência de nada.',
    );
    return lines.join('\n');
  }

  const oos = ev.outOfSample;
  const ins = ev.inSample;

  lines.push(
    '',
    'O NÚMERO PRINCIPAL — fora da amostra',
    '------------------------------------',
    `  Deslocamento estimado na 1ª metade (n = ${ev.inSample.n - oos.n}): ${signed(ev.offset)}`,
    `  Cobrado na 2ª metade (n = ${oos.n}), que não participou da estimativa.`,
    '',
    table(
      ['previsor', 'n', 'Brier', 'skill vs mercado'],
      [
        ['agente (cru)', String(oos.n), num(oos.agent), signed(skillScore(oos.agent, oos.market))],
        [
          'agente (viés subtraído)',
          String(oos.n),
          num(oos.debiased),
          signed(skillScore(oos.debiased, oos.market)),
        ],
        ['mercado (as_of)', String(oos.n), num(oos.market), '—'],
        ['50/50', String(oos.n), num(oos.coin), signed(skillScore(oos.coin, oos.market))],
      ],
    ),
  );

  if (oos.agent !== null && oos.debiased !== null) {
    const delta = oos.agent - oos.debiased;
    // Em fração do erro do agente cru: 0,0006 sobre um Brier de 0,20 é 0,3%, e é
    // essa razão — não o sinal — que diz se a correção move alguma coisa.
    const relative = oos.agent === 0 ? 0 : Math.abs(delta) / oos.agent;

    lines.push(
      '',
      delta > 0
        ? `  A correção MELHORA o Brier fora da amostra em ${num(delta, 4)} (${pct(relative)} do erro do`
        : `  A correção PIORA o Brier fora da amostra em ${num(-delta, 4)} (${pct(relative)} do erro do`,
      '  agente cru).',
    );

    if (relative < MIN_BRIER_DELTA_FRACTION) {
      lines.push(
        '',
        `  EFEITO DESPREZÍVEL. Menos de ${pct(MIN_BRIER_DELTA_FRACTION, 0)} do erro. O sinal do delta é positivo e não`,
        '  significa nada operacionalmente: uma correção deste tamanho não muda decisão',
        '  de aposta nenhuma, e trocaria de sinal com um punhado de partidas a mais. O',
        '  que se conclui daqui é que NÃO HÁ viés a corrigir com esta amostra — não que',
        '  a correção funciona pouco.',
      );
    } else if (delta > 0) {
      lines.push(
        '',
        '  O viés sobrevive à troca de período — é propriedade do agente e não do',
        '  calendário em que foi medido. Sujeito ao veredito do mercado, acima: se o',
        '  mercado erra igual, o que sobreviveu é a composição da amostra, não o agente.',
      );
    } else {
      lines.push(
        '',
        '  O viés medido na 1ª metade não valia na 2ª: era do pedaço de calendário e não',
        '  do agente. Aplicar esta correção em produção degradaria a previsão.',
      );
    }
  }

  if (oos.n < MIN_N_FOR_SIGNAL) {
    lines.push(
      '',
      `  AMOSTRA CURTA (n = ${oos.n}, mínimo ${MIN_N_FOR_SIGNAL}). A diferença acima é ruído amostral.`,
      '  O sinal do delta não decide nada com esta metade.',
    );
  }

  const versions = (entries: ReadonlyArray<{ key: string; n: number }>): string =>
    entries.length === 0 ? '—' : entries.map((e) => `${e.key}×${e.n}`).join(', ');

  lines.push(
    '',
    `  Versão de prompt na 1ª metade: ${versions(ev.composition.train)}`,
    `  Versão de prompt na 2ª metade: ${versions(ev.composition.test)}`,
  );

  if (ev.composition.unseenInTrain.length > 0) {
    lines.push(
      '',
      `  CONFUNDIMENTO: ${ev.composition.unseenInTrain.join(', ')} não aparece na 1ª metade.`,
      '  Versão de prompt muda com o tempo, e o corte por data separou as versões junto',
      '  com o calendário. O deslocamento foi estimado num prompt e cobrado noutro, então',
      '  a 2ª metade não responde "o viés sobrevive ao tempo" — responde "o viés de uma',
      '  versão vale para a outra", que é outra pergunta. Para a pergunta original, rodar',
      '  o eval com --since/--until dentro de uma única versão.',
    );
  }

  lines.push(
    '',
    ev.straddlingMatches === 0
      ? '  SEM VAZAMENTO: 0 partida(s) nas duas metades. O corte é da lista de PARTIDAS\n' +
          '  ordenadas por as_of, com todas as análises de cada uma indo junto — os dois\n' +
          '  checkpoints compartilham o mesmo desfecho e não podem ficar em lados opostos.\n' +
          '  A confirmação é impressa toda rodada porque vazamento que não é medido volta.'
      : `  VAZAMENTO: ${ev.straddlingMatches} partida(s) aparecem nas DUAS metades. Não deveria ser possível\n` +
          '  com o corte por partida — se este número for diferente de zero, o defeito é no\n' +
          '  corte e o "fora da amostra" acima não é fora da amostra.',
  );

  const clampedPct = oos.n === 0 ? 0 : oos.clamped / oos.n;
  lines.push(
    '',
    'TRAVAMENTO — a subtração é o transformador certo?',
    '-------------------------------------------------',
    `  p_corrigido = p − viés, travado em [0,01; 0,99], com viés = ${signed(ev.offset)}.`,
    `  Pontos travados fora da amostra: ${oos.clamped} de ${oos.n} (${pct(clampedPct)}).`,
    `  Pontos travados na amostra toda: ${ins.clamped} de ${ins.n}.`,
  );

  lines.push(
    '',
    clampedPct > CLAMP_WARN_FRACTION
      ? '  TRAVAMENTO ALTO. A subtração é o transformador ERRADO para esta amostra: em\n' +
          '  mais de um décimo dos pontos o deslocamento foi aplicado pela metade ou nem\n' +
          '  isso, então o previsor acima não é o que a fórmula diz que é. O certo é\n' +
          '  deslocar em espaço LOGIT — logit(p) − k —, onde as bordas são inalcançáveis\n' +
          '  por construção, nada precisa ser travado, e o deslocamento vale igual no meio\n' +
          '  e nas pontas. Registrado aqui em vez de escondido porque o travamento é\n' +
          '  exatamente o sintoma que denuncia isso, e ele some da vista se só o Brier for\n' +
          '  impresso.'
      : '  Travamento baixo. A subtração se comporta como a fórmula diz nesta amostra —\n' +
          '  a correção é o que está escrito nela. Se o travamento subir em amostras\n' +
          '  futuras, a correção certa passa a ser deslocamento em espaço logit.',
  );

  lines.push(
    '',
    'REFERÊNCIA — dentro da amostra (OVERFIT, NÃO COMPARÁVEL)',
    '-------------------------------------------------------',
    `  Deslocamento estimado e cobrado nos MESMOS ${ins.n} pontos: ${signed(ev.agentBiasFull)}`,
    '',
    table(
      ['previsor', 'n', 'Brier'],
      [
        ['agente (cru)', String(ins.n), num(ins.agent)],
        ['agente (viés subtraído)', String(ins.n), num(ins.debiased)],
      ],
    ),
    '',
    '  Este número NÃO é comparável com o de cima e não sustenta decisão nenhuma.',
    '  Subtrair a média da própria amostra é o minimizador exato daquele termo do',
    '  Brier naquele conjunto — a melhora é garantida por álgebra, não por acerto, e',
    '  apareceria igual em dados aleatórios. Existe aqui só como TETO: é o melhor que',
    '  a correção poderia parecer se o viés fosse perfeitamente estável. A distância',
    '  entre ele e o fora-da-amostra é o quanto dessa aparência era ilusão.',
  );

  return lines.join('\n');
}

function fidelity(data: EvalDataset): string {
  const { claims, failures } = data;

  const lines = [
    section('6. Fidelidade — ele inventa fato?'),
    'Dimensão separada da calibração: dá para acertar a probabilidade e sustentar a',
    'tese em coisa que não existe.',
    '',
    table(
      ['', 'n'],
      [
        ['afirmações gravadas', String(claims.total)],
        ['com fragmento vivo', String(claims.withFragment)],
        ['fragmento podado pela retenção', String(claims.fragmentPruned)],
        ['análises analyzed sem nenhuma afirmação', String(claims.analyzedWithoutClaims)],
        ['análises analyzed no período', String(claims.analyzedTotal)],
      ],
    ),
    '',
    '  LEIA COM CUIDADO: "fragmento podado" NÃO é citação inventada. Toda claim que',
    '  chegou à tabela citava um fragmento real — o agente valida cada rótulo contra',
    '  o que entrou no prompt e DESCARTA a análise inteira quando um não confere.',
    '  Logo a taxa de citação inventada é estruturalmente zero aqui, e o número que',
    '  interessa está no contador de falhas do job, abaixo.',
    '',
    'Análises pagas e descartadas na validação (de system_logs)',
    table(
      ['', 'n'],
      [
        ['total descartado (exato)', String(failures.totalFailed)],
        ['ciclos com alguma falha', String(failures.sampledCycles)],
        ['ciclos com amostra truncada', String(failures.truncatedCycles)],
      ],
    ),
    '',
    'Por código de falha (LIMITE INFERIOR)',
    ranking(failures.byCode, failures.totalFailed),
    '',
    '  O job grava só as 5 primeiras mensagens de erro por ciclo, então a distribuição',
    `  por código é limite inferior sempre que "ciclos com amostra truncada" > 0`,
    `  (hoje: ${failures.truncatedCycles}). unknown_fragment nesta lista É a citação inventada.`,
    '',
    'Afirmações por enricher citado',
    ranking(claims.byEnricher, claims.total),
    '',
    '  A pergunta inversa: enricher que nunca aparece aqui produz fragmento que o',
    '  agente lê e não usa — custo de coleta sem retorno na tese.',
    '',
    'Afirmações por tipo de fragmento',
    ranking(claims.byKind, claims.total),
  ];

  return lines.join('\n');
}

function abstentions(data: EvalDataset): string {
  const total = data.abstentions.reduce((sum, row) => sum + row.n, 0);
  const bySource = new Map<string, number>();
  for (const row of data.abstentions) {
    bySource.set(row.source, (bySource.get(row.source) ?? 0) + row.n);
  }

  return [
    section('7. Abstenções — fora da métrica, dentro do relatório'),
    'Não entram no Brier (não há probabilidade para pontuar). Estão aqui porque são',
    'o dado que permite calibrar os limiares do portão com evidência.',
    '',
    table(
      ['origem', 'n', '%'],
      [...bySource].map(([source, n]) => [source, String(n), total === 0 ? '—' : pct(n / total)]),
    ),
    '',
    '  gate  = recusado antes da chamada, sem gastar token',
    '  model = o próprio modelo se absteve, e a chamada foi paga',
    '  Só abstenção de modelo em volume = portão frouxo (pagando para o modelo dizer',
    '  o que uma condição já diria). Só de portão = o inverso, limiar apertado demais.',
    '',
    'Por motivo',
    table(
      ['origem', 'motivo', 'n'],
      data.abstentions.map((row) => [row.source, truncate(row.reason, 68), String(row.n)]),
      [1],
    ),
    '',
    `  Análises sem mudança de fragmento (nenhuma chamada feita): ${data.unchanged}`,
  ].join('\n');
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function coverage(data: EvalDataset): string {
  const { excluded } = data;
  const rows: Array<[string, number]> = [
    ['sem probabilidade (abstida ou sem mudança)', excluded.sem_probabilidade],
    ['partida ainda sem desfecho', excluded.sem_desfecho],
    ['partida void (resolveu sem vencedor)', excluded.partida_void],
    ['análise sem team_a_id', excluded.analise_sem_lado],
    ['lado incoerente com a partida', excluded.lado_incoerente],
    ['fora do filtro de vertical', excluded.fora_do_filtro],
    ['partida ausente', excluded.partida_ausente],
  ];

  return [
    section('8. Cobertura — o que ficou de fora, e por quê'),
    'Amostra que encolhe em silêncio é como um eval mente. Toda análise lida aparece',
    'aqui ou na métrica.',
    '',
    table(
      ['', 'n'],
      [
        ['análises lidas', String(data.analysesRead)],
        ['na amostra pontuável', String(data.points.length)],
        ...rows.map(([label, n]): [string, string] => [`excluída: ${label}`, String(n)]),
      ],
    ),
    '',
    excluded.lado_incoerente > 0
      ? '  ATENÇÃO: "lado incoerente" não é dado faltando — é a análise apontando para um\n' +
        '  time que não é mais lado da partida. Investigar antes de confiar no resto:\n' +
        '  provavelmente o recompute do resolver trocou os lados depois da análise.'
      : '  Nenhuma incoerência de lado. A orientação das probabilidades está fechando.',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// O relatório
// ---------------------------------------------------------------------------

export function renderReport(data: EvalDataset): string {
  const { window } = data;
  const scope = [
    window.since ? `desde ${window.since}` : 'desde o começo',
    window.until ? `até ${window.until}` : 'até agora',
    window.vertical ? `vertical ${window.vertical}` : 'todas as verticais',
  ].join(', ');

  const header = [
    'EVAL DO AGENTE ANALISTA',
    '=======================',
    `Escopo: ${scope}`,
    `Análises lidas: ${data.analysesRead} — pontuáveis: ${data.points.length}`,
  ].join('\n');

  return [
    header,
    headline(data.points),
    cuts(data.points),
    calibration(data.points),
    marketCalibration(data.points),
    debias(data.points),
    fidelity(data),
    abstentions(data),
    coverage(data),
    '',
  ].join('\n');
}
