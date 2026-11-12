/**
 * Text measures for grouping Polymarket markets by subject: `tokenize`,
 * `jaccard` and `extractEntities`, plus the similarity threshold in
 * `DEFAULT_PAIRING_CONFIG`.
 *
 * Two readers: `src/collectors/radar-selection.ts` (production) and
 * `scripts/montar-lista-radar.ts`. Both must use the same measure, or two
 * thresholds named 0.4 stop meaning the same thing.
 *
 * Pure and offline: no network, no database. It was born as the candidate
 * generator of spec 003 (hypothesis 6, dead). The generator and its cost model
 * were removed in issue 72; what is left is what the radar still reads.
 */

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
  'a',
  'an',
  'the',
  'be',
  'is',
  'are',
  'was',
  'were',
  'been',
  'will',
  'would',
  'shall',
  'should',
  'can',
  'could',
  'may',
  'might',
  'must',
  'do',
  'does',
  'did',
  'have',
  'has',
  'had',
  'of',
  'in',
  'on',
  'at',
  'to',
  'for',
  'from',
  'by',
  'with',
  'and',
  'or',
  'but',
  'if',
  'then',
  'than',
  'as',
  'that',
  'this',
  'these',
  'those',
  'it',
  'its',
  'there',
  'any',
  'all',
  'no',
  'not',
  'more',
  'most',
  'least',
  'less',
  'who',
  'what',
  'which',
  'when',
  'where',
  'how',
  'before',
  'after',
  'during',
  'between',
  'up',
  'down',
  'out',
  'over',
  'under',
  'vs',
  'v',
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
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
]);

/**
 * Sobreposição de Jaccard entre dois conjuntos de tokens.
 *
 * Estava embutida em `generateCandidates` e saiu para o escopo do módulo quando
 * `montar-lista-radar.ts` precisou da MESMA medida para agrupar mercados por
 * assunto. Duas implementações de "quão parecidos são estes dois textos" é como
 * se acaba com dois limiares que se chamam 0,4 e não significam a mesma coisa.
 */
export function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let hit = 0;
  const [small, big] = a.size <= b.size ? [a, b] : [b, a];
  for (const t of small) if (big.has(t)) hit++;
  return hit / (a.size + b.size - hit);
}

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
