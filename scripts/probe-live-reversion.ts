import 'dotenv/config';
import { supabase } from '../src/lib/supabase.js';

/**
 * Sonda: depois de um movimento abrupto de preço ao vivo, o mercado REVERTE ou
 * CONTINUA — e o preço fica MAIS ou MENOS confiável como previsão do desfecho?
 *
 * Existe por causa de uma suposição que o prompt do analista carrega hoje sem
 * nunca ter sido medida: "queda abrupta é ruído, prefiro o preço anterior". Se a
 * suposição estiver certa, a v3 do prompt deve mandar desconfiar do preço logo
 * depois de um movimento grande. Se estiver errada, a v3 deve mandar exatamente
 * o contrário — um movimento grande seria informação chegando, e o preço novo
 * valeria MAIS que o antigo. As duas leituras cabem no mesmo instinto e só o
 * número separa uma da outra, então este script reporta os dois lados sem torcer
 * por nenhum.
 *
 * SÓ LEITURA. Nenhum INSERT, UPDATE, DELETE ou DDL — é sonda, não job: não tem
 * cron, não grava resultado em lugar nenhum, e o que ela produz é texto para
 * alguém ler e decidir. Rodar sob demanda.
 *
 * ## Custo no banco (leia antes de rodar)
 *
 * `esports_snapshots` é particionada por dia e o único índice é
 * `idx_esports_snapshots_event_time (event_id, captured_at desc)`. Toda leitura
 * de série aqui é UMA consulta POR EVENTO, sempre com `event_id` E os dois lados
 * da faixa de `captured_at` — o piso não é redundante com o teto: sem ele o
 * planejador fica autorizado a varrer toda partição anterior ao teto. Nunca há
 * varredura de `esports_snapshots` sem `event_id`. Mesmo cuidado de
 * `market-history.anchorAt` e `match-history.closingPrice`.
 *
 * Rode `--dry-run` primeiro: ele para no passo do universo (tabelas pequenas) e
 * diz quantas partidas e quantos eventos a passada completa consultaria.
 *
 * ## Uso
 *
 *   npm run live:reversion -- --dry-run   # só dimensiona, não puxa série
 *   npm run live:reversion
 *   npm run live:reversion -- --threshold=0.05 --lookback=60
 *   npm run live:reversion -- --horizon=120,300
 *
 * O progresso vai para stderr e o relatório para stdout, então
 * `npm run live:reversion > reversion.txt` guarda o relatório limpo.
 */

const LABEL = 'probe-live-reversion';

// ---------------------------------------------------------------------------
// Constantes que NÃO são flag, e por que não são
// ---------------------------------------------------------------------------

const VERTICAL = 'cs2';

/**
 * O recorte de `scheduled_at`, fixo de propósito.
 *
 * `esports_snapshots` nasceu em 20260805142957; antes dessa data a série de
 * esports estava sendo gravada em `polymarket_snapshots`, que este script não lê.
 * Uma flag `--since` mais antiga não ampliaria a amostra, devolveria série vazia
 * com cara de "não tem dado" — pior que não ter a flag.
 */
const SERIES_START = '2026-08-05';

/**
 * Tolerância para casar um instante alvo com um snapshot.
 *
 * Sem interpolação linear entre os vizinhos, e essa é uma decisão de método, não
 * de preguiça: quando falta snapshot é justamente porque o coletor tropeçou ou o
 * mercado ficou sem book — momento correlacionado com o evento interessante.
 * Interpolar ali inventaria uma trajetória suave exatamente onde a trajetória
 * real foi um degrau. Sem snapshot na tolerância, o ponto é PULADO.
 */
const TOLERANCE_SECONDS = 30;

/** A série começa antes do horário marcado: é onde mora a deriva pré-jogo. */
const PRE_ROLL_MINUTES = 10;

/**
 * Teto da janela lida por partida, contado de `scheduled_at`.
 *
 * `resolved_at` é o carimbo de quando o RESOLVER escreveu o vencedor, não o
 * apito final — pode estar horas ou dias depois. Sem este teto, uma partida com
 * resolução atrasada viraria uma consulta cruzando dezenas de partições. Um BO5
 * de CS2 não passa de ~4h; 6h dá folga e mantém a leitura em poucas partições.
 * Quantas partidas bateram no teto é reportado, não escondido.
 */
const MAX_WINDOW_HOURS = 6;

/** `range()` do PostgREST; a série de uma partida cabe em uma ou duas páginas. */
const PAGE = 1000;

/** `in(...)` vira query string; lote grande estoura o limite de URL do PostgREST. */
const IN_CHUNK = 200;

/**
 * Abaixo disto, o balde não sustenta conclusão.
 *
 * A unidade é PARTIDA DISTINTA, não ponto. É a diferença que mais importa neste
 * script: 600 snapshots de uma partida não são 600 observações — o preço ao vivo
 * é uma trajetória, os pontos vizinhos são quase o mesmo número, e um balde
 * cheio de pontos de três partidas mede três partidas. Mesma função que
 * `MIN_N_FOR_SIGNAL` cumpre no eval (lá são 20 análises), pela mesma razão: uma
 * marca no relatório para impedir a leitura que este tipo de tabela mais convida.
 */
const MIN_MATCHES_FOR_SIGNAL = 15;

/** Preço tem 4 casas (`numeric(6,4)`); diferença abaixo disto é a mesma coisa. */
const EPS = 1e-6;

// ---------------------------------------------------------------------------
// Flags
// ---------------------------------------------------------------------------

interface Args {
  /** Segundos para trás que definem o movimento `d`. */
  lookback: number;
  /** Segundos à frente, um por coluna nas tabelas de reversão. */
  horizons: number[];
  /** Tamanho mínimo do movimento considerado "abrupto". */
  threshold: number;
  dryRun: boolean;
}

const DEFAULTS: Args = {
  lookback: 120,
  horizons: [300, 900, 1800],
  threshold: 0.1,
  dryRun: false,
};

function parseArgs(argv: readonly string[]): Args | { error: string } {
  const args: Args = { ...DEFAULTS, horizons: [...DEFAULTS.horizons] };

  for (const arg of argv) {
    if (arg === '--dry-run') {
      args.dryRun = true;
      continue;
    }

    const match = /^--(lookback|horizon|threshold)=(.+)$/.exec(arg);
    if (match === null) return { error: `argumento desconhecido: ${arg}` };

    const [, key, raw = ''] = match;

    if (key === 'horizon') {
      const parts = raw.split(',').map((part) => Number(part.trim()));
      if (parts.length === 0 || parts.some((n) => !Number.isFinite(n) || n <= 0)) {
        return { error: `--horizon=${raw} precisa ser uma lista de segundos positivos` };
      }
      // Ordenado porque a coluna mais curta é a que decide o veredito, e ela tem
      // que ser a primeira da tabela mesmo que a flag venha fora de ordem.
      args.horizons = [...new Set(parts)].sort((a, b) => a - b);
      continue;
    }

    const value = Number(raw);
    if (!Number.isFinite(value) || value <= 0) {
      return { error: `--${key}=${raw} precisa ser um número positivo` };
    }

    if (key === 'lookback') {
      args.lookback = value;
      continue;
    }

    // Movimento maior que meio ponto de probabilidade não é balde, é a série
    // inteira de um lado só — o corte perderia sentido antes de mentir.
    if (value >= 0.5) return { error: `--threshold=${raw} precisa ser menor que 0.5` };
    args.threshold = value;
  }

  return args;
}

// ---------------------------------------------------------------------------
// Leitura
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;

interface PageResult {
  data: unknown;
  error: { message: string } | null;
}

async function paginate(page: (from: number, to: number) => PromiseLike<PageResult>): Promise<Row[]> {
  const rows: Row[] = [];

  for (let offset = 0; ; offset += PAGE) {
    const { data, error } = await page(offset, offset + PAGE - 1);
    if (error) throw new Error(error.message);

    const batch = (data ?? []) as Row[];
    rows.push(...batch);
    if (batch.length < PAGE) return rows;
  }
}

function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** `numeric` do Postgres chega como string; `Number(null)` seria um preço de 0. */
function asNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** Por que uma partida resolvida não entra na amostra. Toda saída é contada. */
type DiscardReason =
  /** Sem `team_a_id`: o CHECK do banco só exige que o vencedor seja A ou B, e com
   *  A nulo o desfecho "venceu o time A" sairia sempre 0 sem ninguém notar. */
  | 'sem_time_a'
  /** Sem `resolved_at`: não há teto para a janela da série. */
  | 'sem_resolved_at'
  /** Nenhum `market_match_links` com `market_role = 'moneyline'`. */
  | 'sem_moneyline'
  /** Estado B do resolver: `outcome_a_index` ainda nulo. */
  | 'sem_outcome_a_index'
  /** O `event_id` do link não está em `events`. */
  | 'evento_ausente'
  /** `outcomes.values[outcome_a_index]` não é uma string — não há rótulo. */
  | 'rotulo_nao_resolvido';
// Série vazia e série sem âncora também são descartes, mas só se descobrem
// lendo `esports_snapshots` — aparecem em COBERTURA, não aqui.

type DiscardCounts = Record<DiscardReason, number>;

function emptyDiscards(): DiscardCounts {
  return {
    sem_time_a: 0,
    sem_resolved_at: 0,
    sem_moneyline: 0,
    sem_outcome_a_index: 0,
    evento_ausente: 0,
    rotulo_nao_resolvido: 0,
  };
}

interface UniverseMatch {
  matchId: string;
  matchSlug: string;
  eventId: string;
  /** O rótulo do time A como aparece em `esports_snapshots.outcome`. */
  teamLabel: string;
  /** 1 = o time A venceu. É contra isto que o Brier do preço é medido. */
  outcome: 0 | 1;
  scheduledAt: Date;
  resolvedAt: Date;
  /** Piso e teto da janela de série. Os dois lados existem por causa da partição. */
  from: Date;
  to: Date;
  /** A janela bateu em `MAX_WINDOW_HOURS` — `resolved_at` estava muito longe. */
  windowCapped: boolean;
}

interface Universe {
  matches: UniverseMatch[];
  /** Partidas cs2 resolvidas lidas de `esports_matches`, antes de qualquer corte. */
  resolvedRead: number;
  discards: DiscardCounts;
  /** Partidas com mais de um moneyline — anomalia conhecida, ver `loadUniverse`. */
  duplicateMoneyline: number;
}

/**
 * O universo: partidas cs2 já resolvidas, com moneyline ligado e rótulo do lado A
 * resolvido. Três tabelas pequenas, três consultas — nada aqui toca a série.
 *
 * O rótulo do time A sai de `events.outcomes.values[outcome_a_index]` porque é
 * ELE que aparece em `esports_snapshots.outcome`: a série é gravada por rótulo,
 * não por índice, e markets irmãos aparecem com os outcomes em ordens diferentes.
 * Sem índice resolvido não se adivinha qual lado é o time A — adivinhar aqui
 * inverteria o sinal de `d` e de `fwd` ao mesmo tempo, produzindo uma tabela de
 * reversão perfeitamente coerente e completamente errada.
 */
async function loadUniverse(): Promise<Universe> {
  const matchRows = await paginate((from, to) =>
    supabase
      .from('esports_matches')
      .select('id, match_slug, team_a_id, winner_team_id, scheduled_at, resolved_at')
      .eq('vertical_id', VERTICAL)
      .not('winner_team_id', 'is', null)
      .gt('scheduled_at', SERIES_START)
      .order('scheduled_at', { ascending: true })
      .range(from, to),
  );

  const discards = emptyDiscards();

  interface Candidate {
    matchId: string;
    matchSlug: string;
    outcome: 0 | 1;
    scheduledAt: Date;
    resolvedAt: Date;
  }

  const candidates = new Map<string, Candidate>();

  for (const row of matchRows) {
    const teamAId = asString(row['team_a_id']);
    const winnerId = asString(row['winner_team_id']);
    const scheduled = asString(row['scheduled_at']);
    const resolved = asString(row['resolved_at']);

    if (teamAId === null) {
      discards.sem_time_a += 1;
      continue;
    }
    if (resolved === null || scheduled === null) {
      discards.sem_resolved_at += 1;
      continue;
    }

    candidates.set(row['id'] as string, {
      matchId: row['id'] as string,
      matchSlug: asString(row['match_slug']) ?? '(sem slug)',
      outcome: winnerId === teamAId ? 1 : 0,
      scheduledAt: new Date(scheduled),
      resolvedAt: new Date(resolved),
    });
  }

  // --- o moneyline de cada partida ------------------------------------------

  interface Link {
    eventId: string;
    outcomeAIndex: number | null;
  }

  const linkByMatch = new Map<string, Link>();
  const seenTwice = new Set<string>();

  for (const chunk of chunks([...candidates.keys()], IN_CHUNK)) {
    const { data, error } = await supabase
      .from('market_match_links')
      .select('match_id, event_id, outcome_a_index')
      .in('match_id', chunk)
      .eq('market_role', 'moneyline');

    if (error) throw new Error(`leitura de market_match_links falhou: ${error.message}`);

    for (const row of (data ?? []) as Row[]) {
      const matchId = row['match_id'] as string;
      const eventId = row['event_id'] as string;
      const current = linkByMatch.get(matchId);

      // Mais de um moneyline para a mesma partida é anomalia conhecida. Escolha
      // determinística pelo menor `event_id`, igual a `match-history`: o número
      // do relatório não pode depender de qual linha o Postgres devolveu antes.
      if (current === undefined) {
        linkByMatch.set(matchId, { eventId, outcomeAIndex: asNumber(row['outcome_a_index']) });
        continue;
      }

      seenTwice.add(matchId);
      if (eventId < current.eventId) {
        linkByMatch.set(matchId, { eventId, outcomeAIndex: asNumber(row['outcome_a_index']) });
      }
    }
  }

  // --- o rótulo do lado A ----------------------------------------------------

  const eventIds = [...new Set([...linkByMatch.values()].map((link) => link.eventId))];
  const outcomesById = new Map<string, unknown[]>();

  for (const chunk of chunks(eventIds, IN_CHUNK)) {
    const { data, error } = await supabase.from('events').select('id, outcomes').in('id', chunk);
    if (error) throw new Error(`leitura de events falhou: ${error.message}`);

    for (const row of (data ?? []) as Row[]) {
      const values = (row['outcomes'] as Record<string, unknown> | null)?.['values'];
      if (Array.isArray(values)) outcomesById.set(row['id'] as string, values);
    }
  }

  const matches: UniverseMatch[] = [];
  const capMs = MAX_WINDOW_HOURS * 3600_000;

  for (const candidate of candidates.values()) {
    const link = linkByMatch.get(candidate.matchId);
    if (link === undefined) {
      discards.sem_moneyline += 1;
      continue;
    }
    if (link.outcomeAIndex === null) {
      discards.sem_outcome_a_index += 1;
      continue;
    }

    const values = outcomesById.get(link.eventId);
    if (values === undefined) {
      discards.evento_ausente += 1;
      continue;
    }

    const teamLabel = values[link.outcomeAIndex];
    if (typeof teamLabel !== 'string' || teamLabel.length === 0) {
      discards.rotulo_nao_resolvido += 1;
      continue;
    }

    const from = new Date(candidate.scheduledAt.getTime() - PRE_ROLL_MINUTES * 60_000);
    const ceiling = candidate.scheduledAt.getTime() + capMs;
    const windowCapped = candidate.resolvedAt.getTime() > ceiling;
    const to = new Date(windowCapped ? ceiling : candidate.resolvedAt.getTime());

    matches.push({
      matchId: candidate.matchId,
      matchSlug: candidate.matchSlug,
      eventId: link.eventId,
      teamLabel,
      outcome: candidate.outcome,
      scheduledAt: candidate.scheduledAt,
      resolvedAt: candidate.resolvedAt,
      from,
      to,
      windowCapped,
    });
  }

  return {
    matches,
    resolvedRead: matchRows.length,
    discards,
    duplicateMoneyline: seenTwice.size,
  };
}

interface Series {
  /** `captured_at` em ms, crescente. */
  times: number[];
  /** `mid_price` na mesma posição. Snapshot sem mid não entra. */
  mids: number[];
}

/**
 * A série de um evento dentro da janela da partida.
 *
 * Os DOIS lados da faixa em toda página, sempre com `event_id`: é o que mantém a
 * consulta em uma ou duas partições e dentro de
 * `idx_esports_snapshots_event_time`. Um `lte` sozinho autorizaria varredura de
 * todo o histórico anterior ao teto.
 */
async function loadSeries(match: UniverseMatch): Promise<Series> {
  const rows = await paginate((from, to) =>
    supabase
      .from('esports_snapshots')
      .select('captured_at, mid_price')
      .eq('event_id', match.eventId)
      .eq('outcome', match.teamLabel)
      .gte('captured_at', match.from.toISOString())
      .lte('captured_at', match.to.toISOString())
      .order('captured_at', { ascending: true })
      .range(from, to),
  );

  const times: number[] = [];
  const mids: number[] = [];

  for (const row of rows) {
    const mid = asNumber(row['mid_price']);
    const at = asString(row['captured_at']);
    if (mid === null || at === null) continue;

    const ms = new Date(at).getTime();
    if (!Number.isFinite(ms)) continue;

    // A ordenação vem do banco, mas duas linhas com o mesmo `captured_at` são
    // possíveis (a tabela não tem pkey declarada, por desenho). A busca binária
    // exige monotonicidade não-decrescente, e é isso que se garante aqui.
    const last = times[times.length - 1];
    if (last !== undefined && ms < last) continue;

    times.push(ms);
    mids.push(mid);
  }

  return { times, mids };
}

// ---------------------------------------------------------------------------
// Contas
// ---------------------------------------------------------------------------

/**
 * Índice do snapshot mais próximo de `target`, ou `null` em série vazia.
 *
 * Mais próximo dos DOIS lados, e não "o último antes de", que é a convenção de
 * `market-history.anchorAt`. Lá ela existe para o enricher não enxergar o
 * futuro; aqui a sonda já sabe o desfecho, e o vizinho posterior é a leitura
 * mais fiel do instante pedido.
 *
 * Empate exato de distância resolve para o snapshot POSTERIOR. É arbitrário — o
 * empate é simétrico por definição — mas precisa ser determinístico: o mesmo
 * ponto não pode cair em baldes diferentes entre duas rodadas.
 */
function nearestIndex(times: readonly number[], target: number): number | null {
  if (times.length === 0) return null;

  let lo = 0;
  let hi = times.length - 1;

  while (lo < hi) {
    const middle = (lo + hi) >> 1;
    const value = times[middle];
    if (value === undefined) return null;
    if (value < target) lo = middle + 1;
    else hi = middle;
  }

  const at = times[lo];
  if (at === undefined) return null;

  const before = lo > 0 ? times[lo - 1] : undefined;
  if (before === undefined) return lo;

  return Math.abs(at - target) <= Math.abs(before - target) ? lo : lo - 1;
}

/** O mid no instante `target`, ou `null` se o vizinho mais próximo estiver longe. */
function midAt(series: Series, target: number): number | null {
  const index = nearestIndex(series.times, target);
  if (index === null) return null;

  const at = series.times[index];
  const mid = series.mids[index];
  if (at === undefined || mid === undefined) return null;

  return Math.abs(at - target) <= TOLERANCE_SECONDS * 1000 ? mid : null;
}

/**
 * Balde de direção do movimento. `threshold` define o "grande"; metade dele
 * define a faixa de ruído em torno de zero.
 */
type MoveBucket = 'neg_grande' | 'neg' | 'zero' | 'pos' | 'pos_grande';

const MOVE_ORDER: readonly MoveBucket[] = ['neg_grande', 'neg', 'zero', 'pos', 'pos_grande'];

function moveBucket(d: number, threshold: number): MoveBucket {
  const half = threshold / 2;
  if (d <= -threshold) return 'neg_grande';
  if (d <= -half) return 'neg';
  if (d < half) return 'zero';
  if (d < threshold) return 'pos';
  return 'pos_grande';
}

function moveLabel(bucket: MoveBucket, threshold: number): string {
  const t = threshold.toFixed(3);
  const half = (threshold / 2).toFixed(3);
  switch (bucket) {
    case 'neg_grande':
      return `d <= -${t}`;
    case 'neg':
      return `-${t} < d <= -${half}`;
    case 'zero':
      return `|d| < ${half}`;
    case 'pos':
      return `+${half} <= d < +${t}`;
    case 'pos_grande':
      return `d >= +${t}`;
  }
}

/** Balde de MAGNITUDE do movimento — é o corte da pergunta da v3. */
type MagBucket = 'quieto' | 'medio' | 'grande' | 'enorme';

const MAG_ORDER: readonly MagBucket[] = ['quieto', 'medio', 'grande', 'enorme'];

function magBucket(d: number, threshold: number): MagBucket {
  const abs = Math.abs(d);
  if (abs < threshold / 2) return 'quieto';
  if (abs < threshold) return 'medio';
  if (abs < threshold * 2) return 'grande';
  return 'enorme';
}

function magLabel(bucket: MagBucket, threshold: number): string {
  const half = (threshold / 2).toFixed(3);
  const t = threshold.toFixed(3);
  const dbl = (threshold * 2).toFixed(3);
  switch (bucket) {
    case 'quieto':
      return `|d| < ${half}`;
    case 'medio':
      return `${half} <= |d| < ${t}`;
    case 'grande':
      return `${t} <= |d| < ${dbl}`;
    case 'enorme':
      return `|d| >= ${dbl}`;
  }
}

/**
 * Faixas de tempo restante até o fim da série.
 *
 * Existem por si (saída 3) e como CONTROLE da saída 2 — ver `renderReliability`.
 */
const TIME_BANDS: ReadonlyArray<{ key: string; maxSeconds: number }> = [
  { key: '< 5 min', maxSeconds: 300 },
  { key: '5-15 min', maxSeconds: 900 },
  { key: '15-30 min', maxSeconds: 1800 },
  { key: '30-60 min', maxSeconds: 3600 },
  { key: '> 60 min', maxSeconds: Number.POSITIVE_INFINITY },
];

function timeBand(remainingSeconds: number): string {
  for (const band of TIME_BANDS) {
    if (remainingSeconds < band.maxSeconds) return band.key;
  }
  return '> 60 min';
}

/** Acumulador de movimento: a saída 1. */
interface MoveStats {
  points: number;
  matches: Set<string>;
  sumD: number;
  sumFwd: number;
  /** Pontos em que `d` e `fwd` são os dois não-nulos — o denominador do % oposto. */
  comparable: number;
  opposite: number;
}

/** Acumulador de acerto: as saídas 2 e 3. Brier de `mid(t)` contra o desfecho. */
interface ScoreStats {
  points: number;
  matches: Set<string>;
  sumSq: number;
  sumMid: number;
  sumRemaining: number;
}

function emptyMove(): MoveStats {
  return { points: 0, matches: new Set(), sumD: 0, sumFwd: 0, comparable: 0, opposite: 0 };
}

function emptyScore(): ScoreStats {
  return { points: 0, matches: new Set(), sumSq: 0, sumMid: 0, sumRemaining: 0 };
}

function bump<T>(map: Map<string, T>, key: string, make: () => T): T {
  const current = map.get(key);
  if (current !== undefined) return current;
  const created = make();
  map.set(key, created);
  return created;
}

interface Analysis {
  /** chave `${bucket}|${horizonte}` */
  reversion: Map<string, MoveStats>;
  /** chave `${magBucket}` */
  reliability: Map<string, ScoreStats>;
  /** chave `${magBucket}|${faixa de tempo}` — a saída 2 controlada pelo relógio. */
  reliabilityByTime: Map<string, ScoreStats>;
  /** chave `${faixa de tempo}` */
  baseline: Map<string, ScoreStats>;
  snapshotsRead: number;
  /** Pontos usados como âncora (têm mid e desfecho). */
  anchors: number;
  /** Âncoras com `d` computável — a base das saídas 1 e 2. */
  anchorsWithHistory: number;
  /** Âncoras antes do `scheduled_at` da partida: pré-jogo, não ao vivo. */
  anchorsPreMatch: number;
  matchesWithSeries: number;
  /** Partida cujo evento não devolveu nenhum snapshot na janela. */
  matchesEmptySeries: number;
  /** Série existe, mas nenhum ponto dela tem passado dentro da tolerância. */
  matchesWithoutAnchor: number;
  matchesCapped: number;
  /** Segundos entre o último snapshot lido e `resolved_at`, por partida. */
  tailGaps: number[];
}

/**
 * A passada: uma partida por vez, uma consulta de série por partida.
 *
 * O "fim" contra o qual o tempo restante é medido é o ÚLTIMO SNAPSHOT da janela,
 * não `resolved_at`. `resolved_at` é quando o resolver escreveu, e o atraso dele
 * é operacional — usá-lo empurraria todo ponto para faixas de tempo restante
 * maiores e faria o preço parecer pior do que é perto do fim. O último snapshot
 * também não é o apito final (o coletor pode parar antes ou seguir depois), então
 * a distribuição da diferença entre os dois é reportada: é o que permite julgar
 * o quanto essa proxy vale.
 */
async function analyse(matches: readonly UniverseMatch[], args: Args): Promise<Analysis> {
  const out: Analysis = {
    reversion: new Map(),
    reliability: new Map(),
    reliabilityByTime: new Map(),
    baseline: new Map(),
    snapshotsRead: 0,
    anchors: 0,
    anchorsWithHistory: 0,
    anchorsPreMatch: 0,
    matchesWithSeries: 0,
    matchesEmptySeries: 0,
    matchesWithoutAnchor: 0,
    matchesCapped: 0,
    tailGaps: [],
  };

  const lookbackMs = args.lookback * 1000;
  let done = 0;

  for (const match of matches) {
    done += 1;
    if (done % 25 === 0 || done === matches.length) {
      console.error(`[${LABEL}] série ${done}/${matches.length}…`);
    }

    const series = await loadSeries(match);
    out.snapshotsRead += series.times.length;

    if (series.times.length === 0) {
      out.matchesEmptySeries += 1;
      continue;
    }

    out.matchesWithSeries += 1;
    if (match.windowCapped) out.matchesCapped += 1;

    const end = series.times[series.times.length - 1];
    if (end === undefined) continue;

    out.tailGaps.push((match.resolvedAt.getTime() - end) / 1000);

    let anchoredHere = false;

    for (let i = 0; i < series.times.length; i += 1) {
      const t = series.times[i];
      const mid = series.mids[i];
      if (t === undefined || mid === undefined) continue;

      out.anchors += 1;
      if (t < match.scheduledAt.getTime()) out.anchorsPreMatch += 1;

      const remaining = (end - t) / 1000;
      const band = timeBand(remaining);
      const squaredError = (mid - match.outcome) ** 2;

      // Saída 3: o baseline não depende de `d`, então usa TODA âncora. É por isso
      // que o n dela é maior que o das saídas 1 e 2 — denominadores diferentes,
      // de propósito.
      const baseline = bump(out.baseline, band, emptyScore);
      baseline.points += 1;
      baseline.matches.add(match.matchId);
      baseline.sumSq += squaredError;
      baseline.sumMid += mid;
      baseline.sumRemaining += remaining;

      const past = midAt(series, t - lookbackMs);
      if (past === null) continue;

      const d = mid - past;
      out.anchorsWithHistory += 1;
      anchoredHere = true;

      // Saída 2: o mesmo erro quadrático, agora cortado pelo tamanho do movimento
      // que acabou de acontecer — e também cruzado com o relógio, porque sem o
      // controle esta tabela responde à pergunta errada (ver `renderReliability`).
      const mag = magBucket(d, args.threshold);
      for (const [key, target] of [
        [mag, out.reliability],
        [`${mag}|${band}`, out.reliabilityByTime],
      ] as const) {
        const stats = bump(target, key, emptyScore);
        stats.points += 1;
        stats.matches.add(match.matchId);
        stats.sumSq += squaredError;
        stats.sumMid += mid;
        stats.sumRemaining += remaining;
      }

      // Saída 1: para onde o preço foi DEPOIS.
      const direction = moveBucket(d, args.threshold);
      for (const horizon of args.horizons) {
        const future = midAt(series, t + horizon * 1000);
        if (future === null) continue;

        const fwd = future - mid;
        const stats = bump(out.reversion, `${direction}|${horizon}`, emptyMove);
        stats.points += 1;
        stats.matches.add(match.matchId);
        stats.sumD += d;
        stats.sumFwd += fwd;

        // Sinal oposto só tem sentido quando os dois lados têm sinal. Ponto com
        // `d` ou `fwd` exatamente zero fica fora do denominador em vez de contar
        // como "não reverteu" — senão o balde `~zero`, que é quase todo empate,
        // apareceria como evidência forte de continuação.
        if (Math.abs(d) > EPS && Math.abs(fwd) > EPS) {
          stats.comparable += 1;
          if (Math.sign(fwd) !== Math.sign(d)) stats.opposite += 1;
        }
      }
    }

    if (!anchoredHere) out.matchesWithoutAnchor += 1;
  }

  return out;
}

// ---------------------------------------------------------------------------
// Relatório
// ---------------------------------------------------------------------------

function num(value: number | null, digits = 4): string {
  return value === null ? '—' : value.toFixed(digits);
}

function signed(value: number | null, digits = 4): string {
  if (value === null) return '—';
  return `${value >= 0 ? '+' : ''}${value.toFixed(digits)}`;
}

function pct(value: number | null, digits = 1): string {
  return value === null ? '—' : `${(value * 100).toFixed(digits)}%`;
}

/** Tabela de largura fixa; números à direita, texto à esquerda (igual ao eval). */
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

function brier(stats: ScoreStats | undefined): number | null {
  return stats === undefined || stats.points === 0 ? null : stats.sumSq / stats.points;
}

function shortMark(stats: { matches: Set<string> } | undefined): string {
  if (stats === undefined) return '';
  return stats.matches.size < MIN_MATCHES_FOR_SIGNAL ? 'amostra curta' : '';
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle] ?? null;
  const a = sorted[middle - 1];
  const b = sorted[middle];
  return a === undefined || b === undefined ? null : (a + b) / 2;
}

function renderUniverse(universe: Universe): string {
  const lines = [
    section('UNIVERSO'),
    `  vertical ${VERTICAL}, resolvidas, scheduled_at > ${SERIES_START}`,
    `  partidas lidas de esports_matches: ${universe.resolvedRead}`,
    `  partidas com série consultável:    ${universe.matches.length}`,
    `  eventos distintos a consultar:     ${new Set(universe.matches.map((m) => m.eventId)).size}`,
    '',
    '  descartes (partida resolvida que não vira amostra):',
    table(
      ['motivo', 'n'],
      (Object.entries(universe.discards) as Array<[DiscardReason, number]>)
        .filter(([, n]) => n > 0)
        .sort((a, b) => b[1] - a[1])
        .map(([reason, n]) => [reason, String(n)]),
    ),
  ];

  if (universe.duplicateMoneyline > 0) {
    lines.push(
      '',
      `  ${universe.duplicateMoneyline} partida(s) com mais de um moneyline — escolhido o menor event_id.`,
    );
  }

  return lines.join('\n');
}

function renderCoverage(analysis: Analysis, universe: Universe, args: Args): string {
  const gap = median(analysis.tailGaps);

  return [
    section('COBERTURA DA SÉRIE'),
    `  parâmetros: lookback=${args.lookback}s  horizontes=${args.horizons.join(',')}s  ` +
      `threshold=${args.threshold}  tolerância=${TOLERANCE_SECONDS}s`,
    '',
    `  snapshots lidos:                 ${analysis.snapshotsRead}`,
    `  partidas com série não-vazia:    ${analysis.matchesWithSeries} de ${universe.matches.length}`,
    `  partidas com série vazia:        ${analysis.matchesEmptySeries}` +
      ' (evento ligado, mas nada gravado na janela)',
    `  partidas sem nenhuma âncora:     ${analysis.matchesWithoutAnchor}` +
      ` (série curta demais para ${args.lookback}s de passado)`,
    `  âncoras (pontos com mid):        ${analysis.anchors}`,
    `  âncoras com passado (têm d):     ${analysis.anchorsWithHistory}`,
    `  âncoras antes do scheduled_at:   ${analysis.anchorsPreMatch}` +
      ` (a série começa ${PRE_ROLL_MINUTES} min antes do horário marcado)`,
    `  partidas com janela no teto:     ${analysis.matchesCapped} (resolved_at > scheduled_at + ${MAX_WINDOW_HOURS}h)`,
    '',
    `  mediana de resolved_at − último snapshot: ${gap === null ? '—' : `${(gap / 60).toFixed(1)} min`}`,
    '  É o tamanho do erro da proxy "fim da série = fim da partida", usada nas',
    '  saídas 2 e 3. Mediana alta significa que o coletor parou muito antes do',
    '  resolver escrever — e aí "tempo restante" mede menos do que parece.',
  ].join('\n');
}

function renderReversion(analysis: Analysis, args: Args): string {
  const lines = [
    section('1. REVERSÃO — depois do movimento, o preço volta ou continua?'),
    '  d = mid(t) − mid(t−lookback).  fwd = mid(t+h) − mid(t).',
    '  "% oposto" é a fração dos pontos em que fwd tem sinal CONTRÁRIO a d.',
    '  Acima de 50% sistemático nos baldes grandes = o mercado exagera e volta.',
  ];

  for (const horizon of args.horizons) {
    lines.push('', `  horizonte h = ${horizon}s (${(horizon / 60).toFixed(0)} min)`);
    lines.push(
      table(
        ['balde de d', 'pontos', 'partidas', 'd̄', 'fwd̄', '% oposto', ''],
        MOVE_ORDER.map((bucket) => {
          const stats = analysis.reversion.get(`${bucket}|${horizon}`);
          if (stats === undefined || stats.points === 0) {
            return [moveLabel(bucket, args.threshold), '0', '0', '—', '—', '—', 'sem amostra'];
          }
          return [
            moveLabel(bucket, args.threshold),
            String(stats.points),
            String(stats.matches.size),
            signed(stats.sumD / stats.points),
            signed(stats.sumFwd / stats.points),
            stats.comparable === 0 ? '—' : pct(stats.opposite / stats.comparable),
            shortMark(stats),
          ];
        }),
        [6],
      ),
    );
  }

  return lines.join('\n');
}

function renderReliability(analysis: Analysis, args: Args): string {
  const lines = [
    section('2. CONFIABILIDADE APÓS MOVIMENTO — é isto que decide a v3'),
    '  Brier de mid(t) contra o desfecho final, cortado pelo tamanho do movimento',
    '  que acabou de acontecer. Menor é melhor.',
    '',
    '  Brier SOBE com |d| grande  → o instinto do agente está certo: preço logo',
    '                               depois de movimento abrupto vale menos, e a v3',
    '                               deve mandar desconfiar dele.',
    '  Brier CAI com |d| grande   → o instinto está errado: o movimento é',
    '                               informação chegando, e a v3 deve mandar o',
    '                               contrário — confiar MAIS no preço novo.',
    '',
    table(
      ['balde de |d|', 'pontos', 'partidas', 'Brier', 'mid̄', 'restantē', ''],
      MAG_ORDER.map((bucket) => {
        const stats = analysis.reliability.get(bucket);
        if (stats === undefined || stats.points === 0) {
          return [magLabel(bucket, args.threshold), '0', '0', '—', '—', '—', 'sem amostra'];
        }
        return [
          magLabel(bucket, args.threshold),
          String(stats.points),
          String(stats.matches.size),
          num(brier(stats)),
          num(stats.sumMid / stats.points, 3),
          `${(stats.sumRemaining / stats.points / 60).toFixed(0)} min`,
          shortMark(stats),
        ];
      }),
      [6],
    ),
    '',
    '  A tabela acima SOZINHA não responde a pergunta, e a coluna "restantē" é a',
    '  razão: movimento grande acontece muito mais perto do fim, quando o preço já',
    '  colapsou para 0 ou 1 e acerta por motivo mecânico. Sem controlar o relógio,',
    '  "Brier melhora com |d| grande" pode ser inteiramente o relógio falando.',
    '  Abaixo, o mesmo corte DENTRO de cada faixa de tempo restante — é a leitura',
    '  que vale. Cada célula traz Brier e, entre parênteses, partidas distintas.',
    '',
    table(
      ['tempo restante', ...MAG_ORDER.map((bucket) => magLabel(bucket, args.threshold))],
      TIME_BANDS.map((band) => [
        band.key,
        ...MAG_ORDER.map((bucket) => {
          const stats = analysis.reliabilityByTime.get(`${bucket}|${band.key}`);
          const score = brier(stats);
          if (stats === undefined || score === null) return '—';
          return `${score.toFixed(3)} (${stats.matches.size})`;
        }),
      ]),
    ),
  ];

  return lines.join('\n');
}

function renderBaseline(analysis: Analysis): string {
  return [
    section('3. BASELINE — quanto o preço ao vivo já é bom sozinho'),
    '  Brier de mid(t) contra o desfecho, por tempo até o fim da série. É o teto',
    '  contra o qual qualquer agente ao vivo teria que competir: se um horizonte',
    '  já está em 0,05, não há espaço para um analista ganhar dinheiro ali.',
    '  0,25 é a moeda. Usa TODA âncora, inclusive as sem passado — por isso o n',
    '  aqui é maior que o das saídas 1 e 2.',
    '',
    table(
      ['tempo restante', 'pontos', 'partidas', 'Brier', 'mid̄', ''],
      TIME_BANDS.map((band) => {
        const stats = analysis.baseline.get(band.key);
        if (stats === undefined || stats.points === 0) {
          return [band.key, '0', '0', '—', '—', 'sem amostra'];
        }
        return [
          band.key,
          String(stats.points),
          String(stats.matches.size),
          num(brier(stats)),
          num(stats.sumMid / stats.points, 3),
          shortMark(stats),
        ];
      }),
      [5],
    ),
  ].join('\n');
}

/**
 * O veredito: qual das três saídas a amostra ATUAL sustenta.
 *
 * O critério é sempre partidas distintas, nunca pontos. Uma saída só passa
 * quando os baldes que a DECIDEM têm amostra — não basta a tabela estar cheia.
 */
function renderVerdict(analysis: Analysis, args: Args): string {
  const matchesOf = (stats: { matches: Set<string> } | undefined): number => stats?.matches.size ?? 0;
  const shortest = args.horizons[0];

  const sustained: string[] = [];
  const not: string[] = [];

  // Saída 1: decidem os dois extremos, no horizonte mais curto (é onde há mais
  // amostra; se nem ali fecha, nos longos fecha menos ainda).
  const negBig = matchesOf(analysis.reversion.get(`neg_grande|${shortest ?? 0}`));
  const posBig = matchesOf(analysis.reversion.get(`pos_grande|${shortest ?? 0}`));
  if (negBig >= MIN_MATCHES_FOR_SIGNAL && posBig >= MIN_MATCHES_FOR_SIGNAL) {
    sustained.push('reversão');
  } else {
    not.push(
      `reversão (baldes grandes com ${negBig} e ${posBig} partidas em h=${shortest ?? 0}s, ` +
        `mínimo ${MIN_MATCHES_FOR_SIGNAL})`,
    );
  }

  // Saída 2: precisa dos extremos de |d| E de pelo menos uma faixa de tempo em
  // que os dois extremos coexistam — sem isso o corte não está controlado pelo
  // relógio e a conclusão não é sobre movimento, é sobre minuto de jogo.
  const quiet = matchesOf(analysis.reliability.get('quieto'));

  // União, não soma: a mesma partida quase sempre aparece nos dois baldes de
  // movimento grande, e somar os tamanhos contaria ela duas vezes — inflando
  // justamente o número que decide se há amostra.
  const loud = new Set([
    ...(analysis.reliability.get('grande')?.matches ?? []),
    ...(analysis.reliability.get('enorme')?.matches ?? []),
  ]).size;
  const controlled = TIME_BANDS.filter(
    (band) =>
      matchesOf(analysis.reliabilityByTime.get(`quieto|${band.key}`)) >= MIN_MATCHES_FOR_SIGNAL &&
      (matchesOf(analysis.reliabilityByTime.get(`grande|${band.key}`)) >= MIN_MATCHES_FOR_SIGNAL ||
        matchesOf(analysis.reliabilityByTime.get(`enorme|${band.key}`)) >= MIN_MATCHES_FOR_SIGNAL),
  ).length;

  if (quiet >= MIN_MATCHES_FOR_SIGNAL && loud >= MIN_MATCHES_FOR_SIGNAL && controlled > 0) {
    sustained.push(`confiabilidade (${controlled} faixa(s) de tempo com controle)`);
  } else if (quiet < MIN_MATCHES_FOR_SIGNAL || loud < MIN_MATCHES_FOR_SIGNAL) {
    not.push(`confiabilidade (|d| quieto com ${quiet} partidas, |d| grande com ${loud})`);
  } else {
    not.push('confiabilidade (nenhuma faixa de tempo tem os dois extremos de |d| — sem controle pelo relógio)');
  }

  // Saída 3: passa quando toda faixa de tempo com dado tem amostra.
  const thin = TIME_BANDS.filter((band) => {
    const stats = analysis.baseline.get(band.key);
    return stats !== undefined && stats.matches.size < MIN_MATCHES_FOR_SIGNAL;
  }).map((band) => band.key);

  const populated = TIME_BANDS.filter((band) => analysis.baseline.get(band.key) !== undefined).length;
  if (populated > 0 && thin.length === 0) sustained.push('baseline');
  else if (populated === 0) not.push('baseline (sem amostra)');
  else not.push(`baseline (faixas curtas: ${thin.join(', ')})`);

  return [
    section('VEREDITO'),
    `  SUSTENTA: ${sustained.length === 0 ? '(nenhuma)' : sustained.join(', ')}.` +
      `  NÃO SUSTENTA: ${not.length === 0 ? '(nenhuma)' : not.join('; ')}.`,
    '',
    `  Critério: ${MIN_MATCHES_FOR_SIGNAL} partidas distintas por balde decisivo.`,
    '  Balde marcado "amostra curta" nas tabelas acima está abaixo disso — os',
    '  pontos dentro de uma mesma partida são quase o mesmo número, então é',
    '  partida distinta que conta como observação, não snapshot.',
  ].join('\n');
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if ('error' in args) {
    console.error(`[${LABEL}] ${args.error}`);
    console.error(
      `[${LABEL}] uso: npm run live:reversion -- [--dry-run] [--lookback=120] ` +
        `[--horizon=300,900,1800] [--threshold=0.10]`,
    );
    process.exit(1);
    return;
  }

  console.error(`[${LABEL}] lendo universo (esports_matches + market_match_links + events)…`);
  const universe = await loadUniverse();

  console.log(renderUniverse(universe));

  if (args.dryRun) {
    const events = new Set(universe.matches.map((m) => m.eventId)).size;
    console.log(
      [
        section('DRY RUN'),
        `  A passada completa faria ${events} consulta(s) a esports_snapshots —`,
        '  uma por evento, com event_id e os dois lados de captured_at, dentro de',
        `  uma janela de no máximo ${MAX_WINDOW_HOURS}h por partida.`,
        '  Nenhuma série foi lida. Rode sem --dry-run para medir.',
      ].join('\n'),
    );
    return;
  }

  if (universe.matches.length === 0) {
    console.log('\nNenhuma partida consultável — não há o que medir.');
    return;
  }

  const analysis = await analyse(universe.matches, args);

  console.log(renderCoverage(analysis, universe, args));
  console.log(renderReversion(analysis, args));
  console.log(renderReliability(analysis, args));
  console.log(renderBaseline(analysis));
  console.log(renderVerdict(analysis, args));
}

main().catch((err: unknown) => {
  console.error(`[${LABEL}] falhou:`, err instanceof Error ? err.message : String(err));
  process.exit(1);
});
