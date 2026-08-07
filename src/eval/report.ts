import {
  AGENT,
  COIN,
  MARKET,
  MIN_N_FOR_SIGNAL,
  bias,
  brierScore,
  calibrationError,
  cut,
  liquidityBand,
  murphyDecomposition,
  pairedSample,
  reliabilityBuckets,
  skillScore,
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

function fidelity(data: EvalDataset): string {
  const { claims, failures } = data;

  const lines = [
    section('4. Fidelidade — ele inventa fato?'),
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
    section('5. Abstenções — fora da métrica, dentro do relatório'),
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
    section('6. Cobertura — o que ficou de fora, e por quê'),
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
    fidelity(data),
    abstentions(data),
    coverage(data),
    '',
  ].join('\n');
}
