/**
 * O gerador de candidatos da spec 003 — o portão que decide se o extrator cabe
 * no orçamento.
 *
 * Com N mercados os pares são N(N−1)/2. Com 2.000 abertos são 2 milhões, e não
 * existe orçamento que mande isso a um modelo. Este módulo reduz o universo a
 * GRUPOS de mercados plausivelmente relacionados, e o faz sem LLM nenhum: só
 * estrutura da API, regex e contagem de tokens.
 *
 * Duas decisões carregam o desenho inteiro:
 *
 * **A saída é grupo, não par.** Dar ao modelo 12 perguntas e pedir todas as
 * relações entre elas custa UMA chamada; par a par custaria 66. É a diferença
 * entre um extrator de dezenas de dólares e um de milhares.
 *
 * **Todo descarte é contado, por camada.** Descarte silencioso é cobertura
 * perdida sem ninguém saber — o mesmo defeito que quase fabricou edge na frente
 * do XTracker, onde 29% das linhas saíam por regra e teriam sumido caladas.
 * Aqui cada par que não vira candidato aparece em `PairingStats` com o nome da
 * camada que o recusou e o motivo.
 *
 * Puro e sem rede: recebe mercados já baixados, devolve grupos e contagem.
 * `scripts/probe-polymarket-universe.ts` é quem busca; este arquivo é quem
 * decide. A separação é o que permite testar o gerador sem tocar na Gamma.
 */

// ---------------------------------------------------------------------------
// Entrada
// ---------------------------------------------------------------------------

export interface PairingMarket {
  id: string;
  question: string;
  /**
   * Regras de resolução — o `description` da Gamma.
   *
   * Entra aqui porque é o que sustenta a `ressalvaDeResolucao` da spec e porque
   * é o termo que domina o tamanho do prompt: a pergunta tem dezenas de
   * caracteres, as regras têm centenas.
   */
  rules: string;
  eventId: string | null;
  seriesId: string | null;
  /**
   * Chave de neg-risk. Quando presente, a API já ESTÁ declarando que os
   * mercados que a compartilham são mutuamente exclusivos e exaustivos — ou
   * seja, a `particiona` sai de graça, sem modelo. Ver `needsModel`.
   */
  negRiskKey: string | null;
  tags: readonly string[];
  endDate: string | null;
  /** Já resolvido — o que torna o grupo verificável contra o desfecho. */
  resolved: boolean;
}

// ---------------------------------------------------------------------------
// Saída
// ---------------------------------------------------------------------------

export type PairingLayer = 1 | 2 | 3;

export interface CandidateGroup {
  layer: PairingLayer;
  /** Por que estes mercados estão juntos, em uma linha auditável. */
  reason: string;
  memberIds: readonly string[];
  /**
   * Falso quando a relação já vem declarada pela API e o modelo não acrescenta
   * nada — grupo de neg-risk puro, onde a `particiona` é fato do payload.
   * Estes grupos entram na cobertura e NÃO entram na conta de custo.
   */
  needsModel: boolean;
  resolvedCount: number;
  /**
   * Todos os membros já resolveram — o grupo vira caso de teste automático.
   *
   * É a mudança que dispensa a rotulagem humana da Parte E da spec: se `A
   * implica B` e ambos resolveram, uma resolução com A=SIM e B=NÃO refuta a
   * relação objetivamente, sem opinião de ninguém.
   */
  fullyResolved: boolean;
  /** Soma de caracteres de pergunta + regras dos membros. Alimenta o custo. */
  payloadChars: number;
}

export interface LayerStats {
  layer: PairingLayer;
  groups: number;
  /** Pares dentro dos grupos desta camada que nenhuma camada anterior cobria. */
  pairsNew: number;
  /** Pares que esta camada viu e já estavam cobertos — trabalho evitado. */
  pairsRedundant: number;
  /**
   * Pares que esta camada TINHA em mãos e jogou fora por teto de tamanho.
   *
   * A coluna que existe para que o descarte não seja silencioso: um balde de 40
   * mercados partido em quatro grupos de 10 perde 555 pares, e sem esta linha
   * ninguém saberia.
   */
  pairsDroppedToCap: number;
  /** Pares recusados pelo critério da camada (limiar, balde genérico demais). */
  pairsRejected: number;
  notes: string[];
}

export interface PairingStats {
  markets: number;
  /** C(N,2) — o universo bruto. */
  totalPairs: number;
  groups: number;
  groupsNeedingModel: number;
  pairsCovered: number;
  pairsDiscarded: number;
  byLayer: LayerStats[];
  /** Mercados que não entraram em grupo nenhum. */
  orphanMarkets: number;
  /** Distribuição de tamanho de grupo: tamanho → quantos grupos. */
  sizeHistogram: Array<[number, number]>;
  fullyResolvedGroups: number;
  /** Tokens automáticos tratados como vazios por frequência. Ver `autoStopDf`. */
  autoStopwords: string[];
}

export interface PairingResult {
  groups: CandidateGroup[];
  stats: PairingStats;
}

// ---------------------------------------------------------------------------
// Configuração
// ---------------------------------------------------------------------------

export interface PairingConfig {
  /**
   * Teto de membros por grupo.
   *
   * Doze, e o limite que manda NÃO é o contexto. Um mercado custa ~200 tokens
   * (pergunta + regras, medidos na Gamma), então doze são ~2.400 tokens de
   * carga — um oitavo do prompt v2 do analista, que já roda em produção. O que
   * manda é a carga de raciocínio: doze membros são 66 pares para o modelo
   * julgar numa passada, e pedir mais que isso troca custo por qualidade na
   * direção errada — e nesta spec precisão vale mais que cobertura.
   */
  maxGroupSize: number;
  /**
   * Teto duro de um grupo estrutural (camada 1).
   *
   * Grupo de camada 1 NÃO é partido no teto normal: a membresia dele é a própria
   * unidade semântica. Partir um evento neg-risk de 30 saídas em três grupos de
   * 10 destrói exatamente a `particiona` que ele existe para declarar. Acima
   * deste teto duro, aí sim trunca — e o que se perde é contado.
   */
  maxStructuralGroupSize: number;
  /** Baldes de entidade acima disso são reagrupados, não usados inteiros. */
  entityBucketCeiling: number;
  /** Limiar de Jaccard para virar aresta na camada 3. */
  textSimilarity: number;
  /**
   * Token presente em mais que esta fração das perguntas vira palavra vazia.
   *
   * Automático em vez de lista fixa porque o corpus manda: em Polymarket "will",
   * "market" e "resolve" são ruído, mas "goals" não é, e nenhuma lista de
   * palavras vazias em inglês sabe disso. A lista derivada entra em
   * `PairingStats.autoStopwords` para poder ser conferida.
   */
  autoStopDf: number;
  /**
   * Teto de frequência para um token servir de chave no índice invertido da
   * camada 3.
   *
   * Só pares que compartilham um token RARO são pontuados. Pares que não
   * compartilham nenhum têm Jaccard perto de zero por construção — e
   * `sampleUnscoredPairs` existe para conferir isso em vez de acreditar.
   */
  invertedIndexDfCeiling: number;
}

export const DEFAULT_PAIRING_CONFIG: PairingConfig = {
  maxGroupSize: 12,
  maxStructuralGroupSize: 60,
  entityBucketCeiling: 40,
  textSimilarity: 0.4,
  autoStopDf: 0.08,
  invertedIndexDfCeiling: 0.02,
};

// ---------------------------------------------------------------------------
// Texto: tokens e entidades
// ---------------------------------------------------------------------------

/**
 * Palavras vazias gramaticais.
 *
 * Curta de propósito. O peso do filtro está no corte por frequência
 * (`autoStopDf`); esta lista só cobre o que é vazio em qualquer corpus e
 * atrapalharia a extração de entidade por vir maiúsculo no começo da frase —
 * "Will", "Which", "Who".
 */
const GRAMMATICAL_STOPWORDS = new Set([
  'a', 'an', 'the', 'be', 'is', 'are', 'was', 'were', 'been', 'will', 'would',
  'shall', 'should', 'can', 'could', 'may', 'might', 'must', 'do', 'does',
  'did', 'have', 'has', 'had', 'of', 'in', 'on', 'at', 'to', 'for', 'from',
  'by', 'with', 'and', 'or', 'but', 'if', 'then', 'than', 'as', 'that', 'this',
  'these', 'those', 'it', 'its', 'there', 'any', 'all', 'no', 'not', 'more',
  'most', 'least', 'less', 'who', 'what', 'which', 'when', 'where', 'how',
  'before', 'after', 'during', 'between', 'up', 'down', 'out', 'over', 'under',
  'vs', 'v',
]);

export function tokenize(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.toLowerCase().split(/[^a-z0-9$%.'-]+/)) {
    const token = raw.replace(/^[.'-]+|[.'-]+$/g, '');
    if (token.length === 0) continue;
    if (GRAMMATICAL_STOPWORDS.has(token)) continue;
    out.push(token);
  }
  return out;
}

const MONTHS = new Set([
  'january', 'february', 'march', 'april', 'may', 'june', 'july', 'august',
  'september', 'october', 'november', 'december',
]);

/**
 * Entidades de uma pergunta: nomes próprios, tickers, números e datas.
 *
 * Regex e heurística, sem modelo — é a camada 2 e ela tem que ser grátis. O
 * critério de nome próprio é "sequência de tokens capitalizados", com a exceção
 * do primeiro token da frase: "Will Smith wins" e "Will Bitcoin hit 100k"
 * começam igual, e a segunda não tem nome próprio nenhum no começo. Descartar o
 * primeiro token quando ele é palavra gramatical resolve o caso comum sem
 * inventar um POS tagger.
 */
export function extractEntities(question: string): string[] {
  const found = new Set<string>();

  // Tickers com cifrão: $BTC, $NVDA.
  for (const m of question.matchAll(/\$[A-Za-z]{1,6}\b/g)) {
    found.add(m[0].slice(1).toLowerCase());
  }

  // Siglas em caixa alta: BTC, NFL, GDP, CS2. Duas letras no mínimo para não
  // pegar a inicial de um nome abreviado.
  for (const m of question.matchAll(/\b[A-Z]{2,6}[0-9]?\b/g)) {
    found.add(m[0].toLowerCase());
  }

  // Números, percentuais e valores. Normalizados sem separador de milhar para
  // que "100,000" e "100000" caiam no mesmo balde.
  for (const m of question.matchAll(/\b\d[\d,.]*\s*[%kmb]?\b/gi)) {
    const norm = m[0].replace(/[,\s]/g, '').toLowerCase().replace(/\.$/, '');
    if (norm.length > 0) found.add(norm);
  }

  // Nomes próprios: sequências capitalizadas.
  const words = question.split(/\s+/);
  let run: string[] = [];
  const flush = (): void => {
    if (run.length > 0) {
      found.add(run.join(' ').toLowerCase());
      run = [];
    }
  };

  for (let i = 0; i < words.length; i++) {
    const word = (words[i] ?? '').replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, '');
    const bare = word.toLowerCase();
    const capitalized = /^[A-Z]/.test(word) && word.length > 1;
    // O primeiro token capitalizado da frase só conta se não for gramatical.
    if (capitalized && !(i === 0 && GRAMMATICAL_STOPWORDS.has(bare))) {
      run.push(bare);
    } else {
      flush();
    }
  }
  flush();

  for (const month of MONTHS) {
    if (question.toLowerCase().includes(month)) found.add(month);
  }

  found.delete('');
  return [...found];
}

// ---------------------------------------------------------------------------
// Pares
// ---------------------------------------------------------------------------

/**
 * Teto de mercados por passada.
 *
 * `pairKey` empacota dois índices num inteiro de 32 bits, 16 para cada. Passar
 * de 65.536 mercados faria dois pares diferentes gerarem a mesma chave, e o
 * efeito seria silencioso: pares distintos contados como um só, cobertura
 * inflada, custo subestimado. Um erro alto é infinitamente melhor que isso.
 */
export const MAX_MARKETS = 65536;

function pairKey(a: number, b: number): number {
  // Índices, não ids: um inteiro por par cabe num Set sem alocar string.
  return a < b ? a * MAX_MARKETS + b : b * MAX_MARKETS + a;
}

function pairsIn(n: number): number {
  return n < 2 ? 0 : (n * (n - 1)) / 2;
}

// ---------------------------------------------------------------------------
// O gerador
// ---------------------------------------------------------------------------

export function generateCandidates(
  markets: readonly PairingMarket[],
  config: PairingConfig = DEFAULT_PAIRING_CONFIG,
): PairingResult {
  const n = markets.length;
  if (n > MAX_MARKETS) {
    throw new Error(
      `market-pairing: ${n} mercados passa do teto de ${MAX_MARKETS}; ` +
        'acima disso a chave de par colide e a cobertura sai inflada em silêncio. ' +
        'Rodar por fatias (por data ou por tag) e somar.',
    );
  }

  const covered = new Set<number>();
  const groups: CandidateGroup[] = [];
  const byLayer: LayerStats[] = [];

  /**
   * Pares de uma lista que ainda não estão cobertos.
   *
   * A contabilidade de perda no teto usa isto em vez de C(n,2) puro: um balde de
   * entidade partido ao meio "perde" pares que a camada 1 já cobriu pelo evento,
   * e contá-los como perda inflaria o prejuízo. Descarte silencioso é o defeito
   * a evitar, mas descarte inventado também engana.
   */
  const uncoveredPairs = (members: readonly number[]): number => {
    let count = 0;
    for (let i = 0; i < members.length; i++) {
      for (let j = i + 1; j < members.length; j++) {
        if (!covered.has(pairKey(members[i] as number, members[j] as number))) count++;
      }
    }
    return count;
  };

  /** Registra um grupo e contabiliza os pares que ele acrescenta. */
  const emit = (
    layer: PairingLayer,
    reason: string,
    members: readonly number[],
    needsModel: boolean,
    stats: LayerStats,
  ): void => {
    if (members.length < 2) return;

    let fresh = 0;
    let redundant = 0;
    for (let i = 0; i < members.length; i++) {
      for (let j = i + 1; j < members.length; j++) {
        const key = pairKey(members[i] as number, members[j] as number);
        if (covered.has(key)) redundant++;
        else {
          covered.add(key);
          fresh++;
        }
      }
    }

    // Grupo cujos pares já estavam TODOS cobertos não vira chamada: seria pagar
    // duas vezes pela mesma leitura.
    if (fresh === 0) {
      stats.pairsRedundant += redundant;
      return;
    }

    stats.pairsNew += fresh;
    stats.pairsRedundant += redundant;

    const rows = members.map((i) => markets[i] as PairingMarket);
    const resolvedCount = rows.filter((m) => m.resolved).length;

    groups.push({
      layer,
      reason,
      memberIds: rows.map((m) => m.id),
      needsModel,
      resolvedCount,
      fullyResolved: resolvedCount === rows.length,
      payloadChars: rows.reduce((s, m) => s + m.question.length + m.rules.length, 0),
    });
  };

  // --- camada 1: estrutura declarada pela API -------------------------------

  const l1: LayerStats = {
    layer: 1, groups: 0, pairsNew: 0, pairsRedundant: 0,
    pairsDroppedToCap: 0, pairsRejected: 0, notes: [],
  };

  const structural: Array<[string, string, (m: PairingMarket) => string | null]> = [
    ['neg-risk', 'mesmo neg-risk (mutuamente exclusivos por declaração da API)', (m) => m.negRiskKey],
    ['evento', 'mesmo evento', (m) => (m.negRiskKey === null ? m.eventId : null)],
    ['série', 'mesma série', (m) => m.seriesId],
  ];

  for (const [kind, reason, keyOf] of structural) {
    const buckets = new Map<string, number[]>();
    markets.forEach((m, i) => {
      const key = keyOf(m);
      if (key === null || key === '') return;
      const bucket = buckets.get(key);
      if (bucket === undefined) buckets.set(key, [i]);
      else bucket.push(i);
    });

    for (const [key, members] of buckets) {
      if (members.length < 2) continue;

      // Neg-risk puro não precisa de modelo: a `particiona` já está no payload.
      // O modelo só entraria para achar `implica`/`conjuncao` DENTRO da
      // partição, e a spec diz que a `particiona` é a relação menos valiosa —
      // pagar por ela seria comprar o que a API dá.
      const needsModel = kind !== 'neg-risk';

      let use = members;
      // Só grupo que vira PROMPT tem teto.
      //
      // Um grupo neg-risk não vira chamada nenhuma: ele é o registro de uma
      // partição que a API declarou, e a declaração vale para os 384 membros,
      // não para os 60 primeiros. Truncá-lo destruiria a relação mais bem
      // fundamentada do universo para economizar tokens que não seriam gastos.
      // Medido: com o teto valendo para todos, quatro eventos neg-risk sozinhos
      // jogavam fora meio milhão de pares — e o auditor de descarte pegava isso
      // como par de alta similaridade descartado, que foi como o defeito
      // apareceu.
      if (needsModel && members.length > config.maxStructuralGroupSize) {
        // Ordem estável: pela posição de entrada, para que duas execuções sobre
        // o mesmo universo cortem os mesmos membros.
        use = members.slice(0, config.maxStructuralGroupSize);
        l1.pairsDroppedToCap += uncoveredPairs(members) - uncoveredPairs(use);
        l1.notes.push(
          `${kind} ${key}: ${members.length} membros truncados para ${use.length}`,
        );
      }

      emit(1, `${reason} (${key})`, use, needsModel, l1);
    }
  }

  l1.groups = groups.length;
  byLayer.push(l1);

  // --- camada 2: entidades compartilhadas -----------------------------------

  const l2: LayerStats = {
    layer: 2, groups: 0, pairsNew: 0, pairsRedundant: 0,
    pairsDroppedToCap: 0, pairsRejected: 0, notes: [],
  };

  const entitiesOf = markets.map((m) => extractEntities(m.question));
  const entityDf = new Map<string, number>();
  for (const list of entitiesOf) {
    for (const e of list) entityDf.set(e, (entityDf.get(e) ?? 0) + 1);
  }

  // Cada mercado vai ao balde da sua entidade MAIS RARA.
  //
  // Agrupar por toda entidade compartilhada faria "trump" juntar trezentos
  // mercados sem relação nenhuma entre si. A entidade mais rara é a mais
  // informativa por definição, e usá-la como chave única dá baldes de tamanho
  // natural sem arbitrar teto. O preço é cobertura: um mercado só entra num
  // balde de camada 2. Ele é aceitável porque a camada 3 pega o resto por
  // texto, e porque perder relação custa zero e inventar relação custa dinheiro.
  const entityBuckets = new Map<string, number[]>();
  let withoutEntity = 0;

  markets.forEach((_, i) => {
    const list = entitiesOf[i] as string[];
    if (list.length === 0) {
      withoutEntity++;
      return;
    }
    // A mais rara ENTRE AS COMPARTILHADAS. Entidade única no corpus não agrupa
    // ninguém — é ruído de extração, um número ou um nome que só aparece ali —
    // e deixá-la ganhar o desempate expulsaria do balde um mercado que tinha
    // entidade compartilhada perfeitamente boa.
    let best = '';
    let bestDf = Infinity;
    for (const e of list) {
      const df = entityDf.get(e) ?? 0;
      if (df < 2) continue;
      if (df < bestDf || (df === bestDf && e < best)) {
        best = e;
        bestDf = df;
      }
    }
    if (best === '') {
      withoutEntity++;
      return;
    }
    const bucket = entityBuckets.get(best);
    if (bucket === undefined) entityBuckets.set(best, [i]);
    else bucket.push(i);
  });

  const l2Leftovers: number[] = [];

  for (const [entity, members] of entityBuckets) {
    if (members.length < 2) {
      l2Leftovers.push(...members);
      continue;
    }
    if (members.length > config.entityBucketCeiling) {
      // Balde genérico demais para virar grupo. Não some: desce para a camada
      // 3, que vai separá-lo por texto. O que se recusa aqui é o balde inteiro
      // como grupo, não os mercados.
      l2.pairsRejected += uncoveredPairs(members);
      l2.notes.push(`entidade "${entity}": ${members.length} membros, genérica demais — desce para a camada 3`);
      l2Leftovers.push(...members);
      continue;
    }
    if (members.length > config.maxGroupSize) {
      // Balde grande mas não genérico: parte em pedaços do tamanho do teto. Os
      // pares entre pedaços somem, e é isso que `pairsDroppedToCap` registra.
      const chunks: number[][] = [];
      for (let i = 0; i < members.length; i += config.maxGroupSize) {
        chunks.push(members.slice(i, i + config.maxGroupSize));
      }
      l2.pairsDroppedToCap +=
        uncoveredPairs(members) - chunks.reduce((s, c) => s + uncoveredPairs(c), 0);
      chunks.forEach((chunk, k) => {
        emit(2, `entidade "${entity}" (parte ${k + 1}/${chunks.length})`, chunk, true, l2);
      });
      continue;
    }
    emit(2, `entidade "${entity}"`, members, true, l2);
  }

  l2.groups = groups.length - l1.groups;
  l2.notes.push(`${withoutEntity} mercados sem entidade agrupável`);
  byLayer.push(l2);

  // --- camada 3: proximidade textual ----------------------------------------

  const l3: LayerStats = {
    layer: 3, groups: 0, pairsNew: 0, pairsRedundant: 0,
    pairsDroppedToCap: 0, pairsRejected: 0, notes: [],
  };

  const tokensOf = markets.map((m) => new Set(tokenize(m.question)));
  const tokenDf = new Map<string, number>();
  for (const set of tokensOf) {
    for (const t of set) tokenDf.set(t, (tokenDf.get(t) ?? 0) + 1);
  }

  const autoStop = new Set<string>();
  for (const [token, df] of tokenDf) {
    if (df / Math.max(1, n) > config.autoStopDf) autoStop.add(token);
  }

  const content = tokensOf.map((set) => {
    const kept = new Set<string>();
    for (const t of set) if (!autoStop.has(t)) kept.add(t);
    return kept;
  });

  // Índice invertido só sobre tokens raros. Pontuar todos os C(N,2) pares seria
  // possível, mas o índice é o que mantém a camada barata quando N cresce — e a
  // amostra de `sampleUnscoredPairs` é o que prova que o atalho não esconde
  // relação.
  const dfCeiling = Math.max(2, Math.floor(config.invertedIndexDfCeiling * n));
  const inverted = new Map<string, number[]>();
  content.forEach((set, i) => {
    for (const t of set) {
      const df = tokenDf.get(t) ?? 0;
      if (df < 2 || df > dfCeiling) continue;
      const posting = inverted.get(t);
      if (posting === undefined) inverted.set(t, [i]);
      else posting.push(i);
    }
  });

  const jaccard = (a: Set<string>, b: Set<string>): number => {
    if (a.size === 0 || b.size === 0) return 0;
    let hit = 0;
    const [small, big] = a.size <= b.size ? [a, b] : [b, a];
    for (const t of small) if (big.has(t)) hit++;
    return hit / (a.size + b.size - hit);
  };

  const scored = new Set<number>();
  const edges = new Map<number, number[]>();
  let edgeCount = 0;
  /** Pontuado, abaixo do limiar, e que nenhuma camada anterior já cobria. */
  let rejectedUncovered = 0;

  const addEdge = (a: number, b: number): void => {
    const ea = edges.get(a);
    if (ea === undefined) edges.set(a, [b]);
    else ea.push(b);
    const eb = edges.get(b);
    if (eb === undefined) edges.set(b, [a]);
    else eb.push(a);
    edgeCount++;
  };

  for (const posting of inverted.values()) {
    for (let i = 0; i < posting.length; i++) {
      for (let j = i + 1; j < posting.length; j++) {
        const a = posting[i] as number;
        const b = posting[j] as number;
        const key = pairKey(a, b);
        if (scored.has(key)) continue;
        scored.add(key);
        if (jaccard(content[a] as Set<string>, content[b] as Set<string>) >= config.textSimilarity) {
          addEdge(a, b);
        } else if (!covered.has(key)) {
          rejectedUncovered++;
        }
      }
    }
  }

  l3.pairsRejected = rejectedUncovered;
  l3.notes.push(
    `${scored.size} pares pontuados pelo índice invertido (df entre 2 e ${dfCeiling}); ` +
      `${scored.size - edgeCount - rejectedUncovered} deles já estavam cobertos`,
  );
  l3.notes.push(
    `${pairsIn(n) - scored.size} pares nunca pontuados por não compartilharem token raro — ` +
      'é o descarte que `sampleDiscardedPairs` audita',
  );

  // Componentes conexas do grafo de arestas, cortadas no teto de grupo.
  const seen = new Set<number>();
  for (const start of edges.keys()) {
    if (seen.has(start)) continue;
    const component: number[] = [];
    const queue = [start];
    seen.add(start);
    while (queue.length > 0) {
      const node = queue.pop() as number;
      component.push(node);
      for (const next of edges.get(node) ?? []) {
        if (seen.has(next)) continue;
        seen.add(next);
        queue.push(next);
      }
    }
    if (component.length < 2) continue;

    if (component.length <= config.maxGroupSize) {
      emit(3, `proximidade textual (componente de ${component.length})`, component, true, l3);
      continue;
    }

    component.sort((a, b) => a - b);
    const chunks: number[][] = [];
    for (let i = 0; i < component.length; i += config.maxGroupSize) {
      chunks.push(component.slice(i, i + config.maxGroupSize));
    }
    l3.pairsDroppedToCap +=
      uncoveredPairs(component) - chunks.reduce((s, c) => s + uncoveredPairs(c), 0);
    chunks.forEach((chunk, k) => {
      emit(3, `proximidade textual (componente de ${component.length}, parte ${k + 1}/${chunks.length})`, chunk, true, l3);
    });
  }

  l3.groups = groups.length - l1.groups - l2.groups;
  void l2Leftovers; // a camada 3 já roda sobre o universo inteiro, inclusive eles
  byLayer.push(l3);

  // --- consolidação ---------------------------------------------------------

  const inSomeGroup = new Set<string>();
  const sizes = new Map<number, number>();
  for (const g of groups) {
    for (const id of g.memberIds) inSomeGroup.add(id);
    sizes.set(g.memberIds.length, (sizes.get(g.memberIds.length) ?? 0) + 1);
  }

  const totalPairs = pairsIn(n);

  return {
    groups,
    stats: {
      markets: n,
      totalPairs,
      groups: groups.length,
      groupsNeedingModel: groups.filter((g) => g.needsModel).length,
      pairsCovered: covered.size,
      pairsDiscarded: totalPairs - covered.size,
      byLayer,
      orphanMarkets: n - inSomeGroup.size,
      sizeHistogram: [...sizes.entries()].sort((a, b) => a[0] - b[0]),
      fullyResolvedGroups: groups.filter((g) => g.fullyResolved).length,
      autoStopwords: [...autoStop].sort(),
    },
  };
}

// ---------------------------------------------------------------------------
// Auditoria do descarte
// ---------------------------------------------------------------------------

export interface DiscardSample {
  sampled: number;
  /** Maior Jaccard encontrado entre pares que o gerador jogou fora. */
  maxSimilarity: number;
  /** Quantos passariam do limiar se tivessem sido pontuados. */
  aboveThreshold: number;
  /**
   * Dos que passariam, quantos são do MESMO evento.
   *
   * Separa as duas causas possíveis de um descarte ruim, que pedem correções
   * opostas: mesmo evento significa que um teto de tamanho cortou um grupo
   * estrutural — problema de teto. Eventos diferentes significa que o índice
   * invertido não achou token raro em comum — problema de limiar.
   */
  aboveThresholdSameEvent: number;
  /** Os piores casos, para leitura humana. */
  worst: Array<{ a: string; b: string; similarity: number; sameEvent: boolean }>;
}

/**
 * PRNG determinístico. `Math.random` tornaria o teste não reprodutível, e um
 * número de auditoria que muda a cada execução não serve de auditoria.
 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Confere o descarte em vez de confiar nele.
 *
 * Sorteia pares que NÃO viraram candidato e mede a similaridade real deles. Se
 * o descarte for são, o maior Jaccard da amostra fica bem abaixo do limiar. Se
 * vier alto, o gerador está jogando fora relação — e a resposta à pergunta
 * "você confia nesse descarte?" passa a ser não, com número.
 */
export function sampleDiscardedPairs(
  markets: readonly PairingMarket[],
  result: PairingResult,
  sampleSize = 2000,
  seed = 20260812,
  config: PairingConfig = DEFAULT_PAIRING_CONFIG,
): DiscardSample {
  const n = markets.length;
  if (n < 2) {
    return { sampled: 0, maxSimilarity: 0, aboveThreshold: 0, aboveThresholdSameEvent: 0, worst: [] };
  }

  const coveredKeys = new Set<number>();
  const idIndex = new Map<string, number>();
  markets.forEach((m, i) => idIndex.set(m.id, i));
  for (const g of result.groups) {
    const idx = g.memberIds.map((id) => idIndex.get(id) as number);
    for (let i = 0; i < idx.length; i++) {
      for (let j = i + 1; j < idx.length; j++) {
        coveredKeys.add(pairKey(idx[i] as number, idx[j] as number));
      }
    }
  }

  const tokensOf = markets.map((m) => new Set(tokenize(m.question)));
  const rand = mulberry32(seed);
  const worst: DiscardSample['worst'] = [];
  let sampled = 0;
  let maxSimilarity = 0;
  let aboveThreshold = 0;
  let aboveThresholdSameEvent = 0;

  // Teto de tentativas: quando quase tudo está coberto, sortear par descartado
  // vira agulha em palheiro e o laço não pode ficar preso.
  for (let attempt = 0; attempt < sampleSize * 40 && sampled < sampleSize; attempt++) {
    const a = Math.floor(rand() * n);
    const b = Math.floor(rand() * n);
    if (a === b) continue;
    if (coveredKeys.has(pairKey(a, b))) continue;

    const ta = tokensOf[a] as Set<string>;
    const tb = tokensOf[b] as Set<string>;
    let hit = 0;
    for (const t of ta) if (tb.has(t)) hit++;
    const sim = ta.size + tb.size - hit === 0 ? 0 : hit / (ta.size + tb.size - hit);

    const ma = markets[a] as PairingMarket;
    const mb = markets[b] as PairingMarket;
    const sameEvent = ma.eventId !== null && ma.eventId === mb.eventId;

    sampled++;
    if (sim > maxSimilarity) maxSimilarity = sim;
    if (sim >= config.textSimilarity) {
      aboveThreshold++;
      if (sameEvent) aboveThresholdSameEvent++;
    }
    worst.push({ a: ma.question, b: mb.question, similarity: sim, sameEvent });
    worst.sort((x, y) => y.similarity - x.similarity);
    if (worst.length > 5) worst.length = 5;
  }

  return { sampled, maxSimilarity, aboveThreshold, aboveThresholdSameEvent, worst };
}

// ---------------------------------------------------------------------------
// A aritmética que libera ou mata a fase 2
// ---------------------------------------------------------------------------

export interface ExtractorCostModel {
  model: string;
  /** US$ por milhão de tokens. Espelha `MODEL_PRICING` em `src/verticals/analyst.ts`. */
  inputPerMTok: number;
  outputPerMTok: number;
  /** Prompt fixo: taxonomia fechada, regra de rótulo, formato de saída. */
  systemTokens: number;
  /** Caracteres por token. Heurística padrão para texto em inglês. */
  charsPerToken: number;
  /** Tokens de estrutura por membro do grupo: rótulo, preço, data, separadores. */
  overheadTokensPerMember: number;
  /** Tokens de saída por relação emitida. */
  outputTokensPerRelation: number;
  /** Fração dos pares de um grupo que vira relação emitida. */
  relationRatePerPair: number;
}

/**
 * Preço e forma da chamada, ancorados no que já foi medido.
 *
 * `esports_analyses` tem 178 análises em `claude-sonnet-4-6`, esforço medium: a
 * v1 do prompt gastou 3.423 tokens de entrada e 319 de saída, US$ 0,0151 por
 * chamada; a v2, 8.714 e 359, US$ 0,0315. Os dois batem com US$ 3/MTok de
 * entrada e US$ 15/MTok de saída, que é o preço do sonnet na tabela do
 * analista. É esse preço que roda aqui — não uma média por chamada, porque o
 * prompt do extrator tem tamanho próprio e a média do analista não sabe disso.
 */
export const DEFAULT_COST_MODEL: ExtractorCostModel = {
  model: 'claude-sonnet-4-6',
  inputPerMTok: 3,
  outputPerMTok: 15,
  systemTokens: 900,
  charsPerToken: 4,
  overheadTokensPerMember: 25,
  outputTokensPerRelation: 55,
  relationRatePerPair: 0.15,
};

export interface CostEstimate {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  usd: number;
}

export function estimateExtractorCost(
  groups: readonly CandidateGroup[],
  model: ExtractorCostModel = DEFAULT_COST_MODEL,
  /**
   * Pessimista: o modelo emite um veredito para CADA par, inclusive `nenhuma`.
   * É o teto do custo de saída, e vale calcular porque a escolha entre "emita
   * só o que achar" e "emita um veredito por par" é uma linha do prompt e muda
   * a conta.
   */
  verdictPerPair = false,
): CostEstimate {
  let inputTokens = 0;
  let outputTokens = 0;
  let calls = 0;

  for (const g of groups) {
    if (!g.needsModel) continue;
    calls++;
    const size = g.memberIds.length;
    inputTokens +=
      model.systemTokens +
      Math.ceil(g.payloadChars / model.charsPerToken) +
      size * model.overheadTokensPerMember;

    const pairs = pairsIn(size);
    const relations = verdictPerPair ? pairs : pairs * model.relationRatePerPair;
    outputTokens += Math.ceil(relations * model.outputTokensPerRelation) + 60;
  }

  const usd =
    (inputTokens * model.inputPerMTok) / 1_000_000 +
    (outputTokens * model.outputPerMTok) / 1_000_000;

  return { calls, inputTokens, outputTokens, usd: Math.round(usd * 10000) / 10000 };
}
