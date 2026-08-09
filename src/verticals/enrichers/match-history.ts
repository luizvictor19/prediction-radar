import { supabase } from '../../lib/supabase.js';
import { noteEnricherSkip, remainingMs } from '../enricher.js';
import type { ContextFragment, Enricher, EnricherContext } from '../enricher.js';

/**
 * `match-history` — o enricher que responde sobre a PARTIDA, e não sobre o
 * mercado.
 *
 * ## Por que ele existe
 *
 * O agente tinha três fragmentos e os três falavam do mercado: `odds`,
 * `liquidity` e `series_consistency`, todos de `market-history`, mais o texto da
 * própria Polymarket. O eval de 2026-08-09 (n=75, skill −0,099 contra o preço)
 * mostrou o resultado esperado de quem só tem isso: teses inteiras construídas
 * sobre movimento de preço, que é justamente o número contra o qual ele está
 * sendo medido. Um previsor que só lê o preço não pode ganhar do preço; no
 * melhor caso empata, e o custo do ruído o deixa abaixo.
 *
 * Este enricher traz o outro lado da pergunta — quem são os times, como eles
 * costumam terminar — e a fonte é o nosso próprio banco: `esports_matches`, com
 * 2.557 partidas e 1.968 já resolvidas. Nenhuma integração nova, nenhuma
 * credencial, nenhum limite de taxa.
 *
 * ## Os três fragmentos
 *
 *   `h2h`                — confrontos diretos anteriores, com desfecho e data
 *   `form`               — últimas N partidas de cada lado, com desfecho
 *   `market_calibration` — quando o mercado precificou ESTES times como
 *                          favoritos, com que frequência acertou
 *
 * O terceiro é o que nenhuma fonte externa vende. Liquipedia dá h2h e forma;
 * casa de aposta dá odds. Ninguém tem a série de preço da Polymarket casada com
 * o desfecho da mesma partida, porque isso só existe para quem coletou os dois.
 * Nós coletamos.
 *
 * ---------------------------------------------------------------------------
 * POINT-IN-TIME: `true`, e o filtro é uma linha
 * ---------------------------------------------------------------------------
 *
 * `resolved_at <= asOf`, e mais nada. O desfecho de uma partida é imutável e
 * datado: FaZe venceu NAVI no dia 14 de junho, e isso não muda nem é reescrito.
 * É o oposto exato do problema da Liquipedia, onde o dado também é datado mas a
 * wiki é editada retroativamente e não expõe QUANDO soube.
 *
 * Três detalhes que reforçam o filtro, e que valem estar escritos:
 *
 *   1. `resolved_at` é copiado de `events.resolved_at` do moneyline — o instante
 *      em que o MERCADO resolveu, que é depois do fim da partida. O filtro é
 *      portanto conservador nos dois sentidos que importam: nunca entrega um
 *      resultado antes de ele existir, e nem sequer antes de o mercado o ter
 *      reconhecido. Não há instante em que este enricher saiba algo que o preço
 *      da hora ainda não sabia.
 *
 *   2. A partida corrente é excluída por id (`neq`). Sem isso, um replay sobre
 *      uma partida já resolvida receberia o próprio gabarito dentro do h2h — o
 *      vazamento mais caro possível, e o mais fácil de não notar, porque a linha
 *      pareceria só mais um confronto direto.
 *
 *   3. O preço usado na calibração é sempre anterior ao início da partida
 *      passada, que por sua vez é anterior à resolução dela, que é anterior a
 *      `asOf`. A cadeia inteira fica atrás do instante perguntado.
 *
 * O que isto NÃO resolve, e não deve fingir resolver: um fragmento gravado hoje
 * tem `observed_at` de hoje, e replay de eval filtra por `observed_at`. Ser
 * point-in-time não faz este enricher melhorar as análises que já existem — faz
 * dele o único que pode rodar dentro de um replay sem contaminá-lo.
 *
 * ---------------------------------------------------------------------------
 * A COBERTURA É PARCIAL, E O TEXTO DIZ ISSO
 * ---------------------------------------------------------------------------
 *
 * `esports_matches` só conhece partida que teve mercado na Polymarket. "Últimas
 * 8 partidas" aqui significa "últimas 8 que nós vimos", não "últimas 8 que o
 * time jogou" — um time pode ter jogado uma fase de grupos inteira sem mercado
 * listado. Ler o nosso recorte como a agenda do time é o erro que este enricher
 * pode induzir, então a ressalva está DENTRO do `summary`, que é o que o LLM lê,
 * e não só neste comentário.
 */

export const MATCH_HISTORY_ID = 'match-history';

/**
 * Vale para toda vertical de esports: a fonte é o nosso próprio registro de
 * partidas, que não sabe de qual jogo é. Espelha `market-history` e o seed de
 * `verticals` na migration 20260806183705.
 */
const MATCH_HISTORY_VERTICALS = ['cs2', 'lol', 'dota2'];

/** Confrontos diretos que entram no fragmento. */
export const H2H_LIMIT = 8;

/** Partidas passadas por time no fragmento de forma. */
export const FORM_LIMIT = 8;

/**
 * Quanto o snapshot de fechamento pode estar antes do início da partida.
 *
 * A watchlist coleta entre 12s e 300s perto do início, então o caso normal é um
 * preço de minutos antes. Seis horas é o teto para a partida que saiu da
 * watchlist ou cujo mercado parou de ser coletado — e o payload grava o atraso
 * real de cada âncora, para quem lê nunca precisar confiar no rótulo.
 */
export const CLOSE_TOLERANCE_SECONDS = 6 * 3_600;

/**
 * A faixa que separa favorito de azarão, e por que ela não é 0,50.
 *
 * Chamar de "favorito" um time precificado a 0,51 e contar como erro do mercado
 * a derrota dele transformaria ruído em estatística: 0,51 é o mercado dizendo
 * que não sabe. A faixa de 0,45 a 0,55 vira `pickem`, contada à parte e fora da
 * conta de acerto do favorito.
 */
export const FAVORITE_THRESHOLD = 0.55;
export const UNDERDOG_THRESHOLD = 0.45;

/**
 * Abaixo disto a calibração não vira fragmento.
 *
 * Não é rigor estatístico — n=4 também não prova nada. É que uma linha dizendo
 * "o mercado acertou 1 de 1" entra no prompt com a mesma cara de uma medida, e o
 * modelo não tem como descontar o que não sabe que é ruído. Quatro é o piso em
 * que a frase "amostra pequena" no `summary` ainda tem o que qualificar.
 */
export const MIN_CALIBRATION_SAMPLE = 4;

/**
 * Teto de buscas de preço NÃO memoizadas por partida enriquecida.
 *
 * Cada busca é uma consulta a `esports_snapshots`. O conjunto de candidatas é no
 * máximo `2 * FORM_LIMIT + H2H_LIMIT`, e o teto existe para o caso frio — cache
 * vazio depois de um deploy, com todas as candidatas inéditas ao mesmo tempo.
 */
const MAX_PRICE_LOOKUPS = 24;

/** Folga para terminar a partida corrente antes do prazo do ciclo. */
const MIN_REMAINING_MS = 5_000;

// ---------------------------------------------------------------------------
// Tipos
// ---------------------------------------------------------------------------

export interface TeamRef {
  teamId: string;
  /** `display_name`, ou o código do slug quando o time veio do caminho 2. */
  name: string;
}

export interface PastMatch {
  matchId: string;
  matchSlug: string | null;
  teamAId: string | null;
  teamBId: string | null;
  winnerTeamId: string | null;
  /** Não é nulo por construção: o filtro é `resolved_at <= asOf`. */
  resolvedAt: string;
  scheduledAt: string | null;
  bestOf: number | null;
  stage: string | null;
  leagueTier: string | null;
  needsReview: boolean;
}

/**
 * O desfecho do ponto de vista de um time.
 *
 * `void` é estado de primeira classe e não "sem dado": o par
 * (`winner_team_id` nulo, `resolved_at` presente) significa que a partida
 * resolveu SEM vencedor, e a migration 20260807182110 registra que ler
 * `winner_team_id` sozinho confunde void com pendência. Void não conta vitória
 * nem derrota, e não entra na calibração — não há desfecho contra o qual medir
 * o preço.
 */
export type Verdict = 'win' | 'loss' | 'void';

export interface TeamRecord {
  wins: number;
  losses: number;
  voids: number;
}

export interface PricedObservation {
  matchId: string;
  matchSlug: string | null;
  teamId: string;
  /** Preço do TIME, no último snapshot antes do início da partida. */
  price: number;
  capturedAt: string;
  /** Distância entre o snapshot e o horário de início, em segundos. */
  lagSeconds: number;
  resolvedAt: string;
  /** Nunca `void`: sem desfecho não há o que calibrar. */
  verdict: 'win' | 'loss';
}

export type Band = 'favorite' | 'underdog' | 'pickem';

export interface Bucket {
  n: number;
  wins: number;
  /** Preço médio do time nas partidas deste balde. */
  avgPrice: number;
}

export interface Calibration {
  n: number;
  favorite: Bucket | null;
  underdog: Bucket | null;
  pickem: Bucket | null;
  /** Brier do MERCADO sobre estas partidas. Menor é melhor; 0,25 é a moeda. */
  brier: number | null;
}

// ---------------------------------------------------------------------------
// Funções puras — a leitura do desfecho e a aritmética, testáveis sem banco
// ---------------------------------------------------------------------------

/**
 * O desfecho de `match` para `teamId`.
 *
 * O `else` devolve `loss` com segurança porque quem chama já garantiu que o time
 * é um dos lados (o filtro da consulta) e o CHECK `esports_matches_winner_is_a_side`
 * garante que o vencedor também é. Vencedor presente que não é este time é, por
 * eliminação, o outro — e isso vale inclusive quando o id do outro lado é nulo,
 * que é o caso do histórico vindo só do slug.
 */
export function verdictFor(match: PastMatch, teamId: string): Verdict {
  if (match.winnerTeamId === null) return 'void';
  return match.winnerTeamId === teamId ? 'win' : 'loss';
}

export function tallyFor(matches: readonly PastMatch[], teamId: string): TeamRecord {
  const record: TeamRecord = { wins: 0, losses: 0, voids: 0 };

  for (const match of matches) {
    const verdict = verdictFor(match, teamId);
    if (verdict === 'win') record.wins++;
    else if (verdict === 'loss') record.losses++;
    else record.voids++;
  }

  return record;
}

export function bandOf(price: number): Band {
  if (price >= FAVORITE_THRESHOLD) return 'favorite';
  if (price <= UNDERDOG_THRESHOLD) return 'underdog';
  return 'pickem';
}

function bucketOf(observations: readonly PricedObservation[]): Bucket | null {
  if (observations.length === 0) return null;

  const wins = observations.filter((o) => o.verdict === 'win').length;
  const sum = observations.reduce((total, o) => total + o.price, 0);

  return { n: observations.length, wins, avgPrice: sum / observations.length };
}

/**
 * A calibração do mercado sobre um conjunto de observações.
 *
 * Uma observação é um par (partida passada, time), e o preço é o do TIME naquele
 * par. Um confronto direto entre os dois times desta partida aparece duas vezes,
 * uma por lado — e isso não enviesa o Brier, porque `(p − y)² = ((1−p) − (1−y))²`:
 * as duas entradas carregam exatamente o mesmo erro. O que muda é o peso, que
 * dobra, e é o comportamento desejado: um h2h é a evidência mais relevante que
 * existe sobre estes dois times.
 */
export function calibrate(observations: readonly PricedObservation[]): Calibration {
  const byBand = new Map<Band, PricedObservation[]>();

  for (const observation of observations) {
    const band = bandOf(observation.price);
    const list = byBand.get(band) ?? [];
    list.push(observation);
    byBand.set(band, list);
  }

  const brier =
    observations.length === 0
      ? null
      : observations.reduce((total, o) => {
          const outcome = o.verdict === 'win' ? 1 : 0;
          return total + (o.price - outcome) ** 2;
        }, 0) / observations.length;

  return {
    n: observations.length,
    favorite: bucketOf(byBand.get('favorite') ?? []),
    underdog: bucketOf(byBand.get('underdog') ?? []),
    pickem: bucketOf(byBand.get('pickem') ?? []),
    brier,
  };
}

// ---------------------------------------------------------------------------
// Formatação — texto estável, sem depender do ICU do runtime
// ---------------------------------------------------------------------------

function price(value: number): string {
  return value.toFixed(3);
}

function pct(value: number): string {
  return `${Math.round(value * 100)}%`;
}

/** Só o dia. A hora de um resultado de meses atrás não informa nada. */
function day(iso: string): string {
  return iso.slice(0, 10);
}

function markOf(verdict: Verdict): string {
  return verdict === 'win' ? 'V' : verdict === 'loss' ? 'D' : '—';
}

/**
 * O nome do adversário de `teamId` em `match`.
 *
 * `null` quando o outro lado não tem identidade resolvida — o caminho 2 do
 * resolver deixa `team_b_id` nulo no histórico antigo. Preferimos "adversário
 * não identificado" a extrair um código do slug: o slug tem os dois códigos e
 * não diz qual é qual sem reimplementar o parser, e trocar os lados numa lista
 * de forma seria pior que omitir.
 */
function opponentName(
  match: PastMatch,
  teamId: string,
  names: ReadonlyMap<string, string>,
): string | null {
  const otherId = match.teamAId === teamId ? match.teamBId : match.teamAId;
  if (otherId === null) return null;
  return names.get(otherId) ?? null;
}

/** `V vs NAVI (07-14)` — a linha de uma partida na forma recente. */
function describeResult(
  match: PastMatch,
  teamId: string,
  names: ReadonlyMap<string, string>,
): string {
  const opponent = opponentName(match, teamId, names) ?? '?';
  return `${markOf(verdictFor(match, teamId))} vs ${opponent} (${day(match.resolvedAt).slice(5)})`;
}

// ---------------------------------------------------------------------------
// Fragmentos
// ---------------------------------------------------------------------------

/**
 * O `as_of` de um fragmento deste enricher: o desfecho mais recente que ele
 * inclui.
 *
 * É a definição da coluna aplicada ao caso: a afirmação "FaZe está 5V-3D" passou
 * a ser verdade no instante em que a oitava partida resolveu, e continua verdade
 * até a nona. Carimbar `asOf` do contexto (o "agora" do ciclo) diria que o fato
 * é de agora, e o replay leria uma contagem de junho como notícia de hoje.
 */
function latestResolvedAt(matches: readonly PastMatch[]): Date | null {
  let newest = Number.NEGATIVE_INFINITY;

  for (const match of matches) {
    const ms = new Date(match.resolvedAt).getTime();
    if (Number.isFinite(ms) && ms > newest) newest = ms;
  }

  return newest === Number.NEGATIVE_INFINITY ? null : new Date(newest);
}

/**
 * A ressalva de cobertura, repetida em todo `summary`.
 *
 * Curta de propósito, e no texto e não só no payload: o `summary` é o que entra
 * no prompt, e um consumidor que concatene summaries perde os campos
 * estruturados. Sem ela, "últimas 8 partidas" é lido como a agenda do time.
 */
const COVERAGE_NOTE = 'só partidas com mercado listado na Polymarket';

function payloadOf(matches: readonly PastMatch[], teamId: string): Record<string, unknown>[] {
  return matches.map((match) => ({
    match_id: match.matchId,
    match_slug: match.matchSlug,
    resolved_at: match.resolvedAt,
    scheduled_at: match.scheduledAt,
    result: verdictFor(match, teamId),
    winner_team_id: match.winnerTeamId,
    opponent_team_id: match.teamAId === teamId ? match.teamBId : match.teamAId,
    best_of: match.bestOf,
    stage: match.stage,
    league_tier: match.leagueTier,
    // Contradição conhecida no registro desta partida (ver 20260807182110).
    // Não a excluímos — a exclusão silenciosa mudaria a contagem sem dizer —
    // mas quem lê o payload vê qual linha é suspeita.
    needs_review: match.needsReview,
  }));
}

export function buildH2hFragment(input: {
  teamA: TeamRef;
  teamB: TeamRef;
  matches: readonly PastMatch[];
}): ContextFragment | null {
  const { teamA, teamB, matches } = input;
  if (matches.length === 0) return null;

  const asOf = latestResolvedAt(matches);
  if (asOf === null) return null;

  const record = tallyFor(matches, teamA.teamId);
  const last = matches[0] as PastMatch;
  const lastVerdict = verdictFor(last, teamA.teamId);

  const lastLine =
    lastVerdict === 'void'
      ? `Último encontro em ${day(last.resolvedAt)} resolveu sem vencedor.`
      : `Último encontro em ${day(last.resolvedAt)}: vitória de ` +
        `${lastVerdict === 'win' ? teamA.name : teamB.name}` +
        `${last.bestOf === null ? '' : ` (Bo${last.bestOf})`}` +
        `${last.stage === null ? '' : ` — ${last.stage}`}.`;

  return {
    enricherId: MATCH_HISTORY_ID,
    kind: 'h2h',
    asOf,
    payload: {
      team_a: { team_id: teamA.teamId, name: teamA.name },
      team_b: { team_id: teamB.teamId, name: teamB.name },
      record_for_team_a: record,
      matches: payloadOf(matches, teamA.teamId),
      source: 'esports_matches',
    },
    summary:
      `Confronto direto ${teamA.name} x ${teamB.name}: ${record.wins}-${record.losses} para ` +
      `${teamA.name} em ${matches.length} partida(s) resolvida(s) (${COVERAGE_NOTE})` +
      `${record.voids > 0 ? `, mais ${record.voids} sem vencedor` : ''}. ${lastLine}`,
    // Fatos exatos do nosso próprio registro, e não medida nem modelo. Abaixo de
    // 1,0 por duas razões nomeadas: a cobertura é parcial, e `winner_team_id` é
    // uma tradução de `events.resolved_outcome` que pode estar marcada para
    // revisão (o payload diz quais).
    confidence: 0.9,
  };
}

export function buildFormFragment(input: {
  sides: ReadonlyArray<{ team: TeamRef; matches: readonly PastMatch[] }>;
  names: ReadonlyMap<string, string>;
}): ContextFragment | null {
  const sides = input.sides.filter((side) => side.matches.length > 0);
  if (sides.length === 0) return null;

  const asOf = latestResolvedAt(sides.flatMap((side) => [...side.matches]));
  if (asOf === null) return null;

  const parts = sides.map((side) => {
    const record = tallyFor(side.matches, side.team.teamId);
    // Três resultados no texto, a lista inteira no payload: o `summary` é lido
    // por inteiro em todo prompt, e uma lista de oito vira parede.
    const recent = side.matches
      .slice(0, 3)
      .map((match) => describeResult(match, side.team.teamId, input.names))
      .join(', ');

    return (
      `${side.team.name} ${record.wins}V-${record.losses}D` +
      `${record.voids > 0 ? ` (+${record.voids} sem vencedor)` : ''}` +
      ` nas últimas ${side.matches.length}: ${recent}`
    );
  });

  return {
    enricherId: MATCH_HISTORY_ID,
    kind: 'form',
    asOf,
    payload: {
      teams: sides.map((side) => ({
        team_id: side.team.teamId,
        name: side.team.name,
        record: tallyFor(side.matches, side.team.teamId),
        matches: payloadOf(side.matches, side.team.teamId),
      })),
      source: 'esports_matches',
    },
    summary: `Forma recente (${COVERAGE_NOTE}). ${parts.join('. ')}.`,
    confidence: 0.9,
  };
}

/** `favorito em 5 (preço médio 0,68), venceu 3` — um balde no texto. */
function describeBucket(label: string, bucket: Bucket): string {
  return (
    `${label} em ${bucket.n} (preço médio ${price(bucket.avgPrice)}), ` +
    `venceu ${bucket.wins} (${pct(bucket.wins / bucket.n)})`
  );
}

export function buildCalibrationFragment(input: {
  sides: ReadonlyArray<{ team: TeamRef; observations: readonly PricedObservation[] }>;
  /** Candidatas que não tinham preço de fechamento na série. */
  withoutPrice: number;
  /** O teto de buscas ou o prazo do ciclo cortou candidatas. */
  truncated: boolean;
}): ContextFragment | null {
  const pooled = input.sides.flatMap((side) => [...side.observations]);
  if (pooled.length < MIN_CALIBRATION_SAMPLE) return null;

  const asOf = (() => {
    let newest = Number.NEGATIVE_INFINITY;
    for (const observation of pooled) {
      const ms = new Date(observation.resolvedAt).getTime();
      if (Number.isFinite(ms) && ms > newest) newest = ms;
    }
    return newest === Number.NEGATIVE_INFINITY ? null : new Date(newest);
  })();
  if (asOf === null) return null;

  const overall = calibrate(pooled);

  const perTeam = input.sides.map((side) => ({
    team: side.team,
    calibration: calibrate(side.observations),
    observations: side.observations,
  }));

  const sentences = perTeam
    .filter((entry) => entry.calibration.n > 0)
    .map((entry) => {
      const { favorite, underdog, pickem } = entry.calibration;
      const bits = [
        favorite === null ? null : describeBucket('favorito', favorite),
        underdog === null ? null : describeBucket('azarão', underdog),
        pickem === null ? null : describeBucket('sem favorito claro', pickem),
      ].filter((bit): bit is string => bit !== null);

      return `${entry.team.name} foi ${bits.join('; ')}`;
    });

  return {
    enricherId: MATCH_HISTORY_ID,
    kind: 'market_calibration',
    asOf,
    payload: {
      // O que "preço" quer dizer aqui, gravado junto do número: sem isto o
      // payload não diz de que instante da partida passada o preço saiu.
      reference: 'último mid do moneyline da série antes do horário de início',
      favorite_threshold: FAVORITE_THRESHOLD,
      underdog_threshold: UNDERDOG_THRESHOLD,
      overall,
      teams: perTeam.map((entry) => ({
        team_id: entry.team.teamId,
        name: entry.team.name,
        calibration: entry.calibration,
        observations: entry.observations.map((o) => ({
          match_id: o.matchId,
          match_slug: o.matchSlug,
          price: o.price,
          band: bandOf(o.price),
          result: o.verdict,
          captured_at: o.capturedAt,
          // Quanto antes do início este preço foi observado. Quem lê decide se
          // um fechamento de 4h antes ainda é um fechamento.
          lag_seconds: o.lagSeconds,
          resolved_at: o.resolvedAt,
        })),
      })),
      // Candidatas descartadas por não haver série de preço antes do início.
      // Hoje é a maioria, e a razão não é falha: `esports_snapshots` só existe
      // desde 2026-08-05, então partida anterior a isso não tem fechamento
      // gravado em lugar nenhum — a retenção geral apagou o de
      // `polymarket_snapshots` poucas horas depois de cada resolução.
      without_price: input.withoutPrice,
      truncated: input.truncated,
      source: 'esports_snapshots + esports_matches',
    },
    summary:
      `Calibração do mercado sobre estes times, em ${overall.n} partida(s) passada(s) com ` +
      `preço de fechamento na nossa série (${COVERAGE_NOTE}). ${sentences.join('. ')}. ` +
      `Brier do mercado no conjunto: ${overall.brier === null ? 'n/d' : price(overall.brier)} ` +
      `(0,250 é moeda justa). Amostra pequena: use como referência sobre estes times, não como teste.`,
    // Insumos exatos — preço observado e desfecho registrado — mas o número é
    // uma taxa estimada sobre poucas partidas, e é isso que a confiança
    // descreve. Mesma escala de `market-history`: 0,8 quando os insumos
    // sustentam a leitura, 0,5 quando a leitura depende de uma amostra que mal
    // se sustenta.
    confidence: overall.n >= 10 ? 0.8 : 0.5,
  };
}

// ---------------------------------------------------------------------------
// Leitura
// ---------------------------------------------------------------------------

const COMPONENT = MATCH_HISTORY_ID;

/**
 * Ids vão para dentro de string de filtro do PostgREST (`or=(...)`), e string
 * montada é string montada. Nada aqui vem do usuário — os ids saem do nosso
 * banco — mas a validação é barata e a alternativa é confiar em invariante que
 * mora em outro arquivo.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}

function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim().length > 0) {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function toPastMatch(row: Record<string, unknown>): PastMatch {
  return {
    matchId: row['id'] as string,
    matchSlug: (row['match_slug'] as string | null) ?? null,
    teamAId: (row['team_a_id'] as string | null) ?? null,
    teamBId: (row['team_b_id'] as string | null) ?? null,
    winnerTeamId: (row['winner_team_id'] as string | null) ?? null,
    resolvedAt: row['resolved_at'] as string,
    scheduledAt: (row['scheduled_at'] as string | null) ?? null,
    bestOf: asNumber(row['best_of']),
    stage: (row['stage'] as string | null) ?? null,
    leagueTier: (row['league_tier'] as string | null) ?? null,
    needsReview: row['needs_review'] === true,
  };
}

/**
 * Partidas resolvidas de um time, ou entre dois, antes de `asOf`.
 *
 * `resolved_at <= asOf` já exclui a partida não resolvida sem filtro adicional:
 * `null <= X` é NULL, e o PostgREST só devolve o que é verdadeiro. O que precisa
 * ser explícito é o `neq('id', exclude)` — a partida corrente, que num replay
 * sobre partida já resolvida entregaria o próprio gabarito.
 *
 * ## Sobre o plano desta consulta
 *
 * `esports_matches` não tem índice em `team_a_id`/`team_b_id`, por decisão
 * registrada na migration 20260806183705 ("quando o /review e o backtest
 * existirem, o índice se justifica pelo plano de query real, não por
 * antecipação"). Este é o primeiro consumidor, e ainda assim a consulta não é do
 * tipo que a regra de leitura pesada do CLAUDE.md protege: a tabela tem ~2,5k
 * linhas e algumas dezenas de MB, não os 711 MB de `events`, e o predicado é
 * igualdade em coluna de uuid. O índice vira decisão de medição depois de o
 * enricher rodar, com o plano real na mão.
 */
async function loadPastMatches(
  filter: string,
  exclude: string,
  asOf: Date,
  limit: number,
): Promise<PastMatch[] | null> {
  // A lista de colunas é literal, e não uma constante concatenada: o tipo do
  // `select` do supabase-js é inferido do literal, e uma string montada faz o
  // retorno virar `GenericStringError`.
  const { data, error } = await supabase
    .from('esports_matches')
    .select(
      'id, match_slug, team_a_id, team_b_id, winner_team_id, resolved_at, scheduled_at, best_of, stage, league_tier, needs_review',
    )
    .or(filter)
    .neq('id', exclude)
    .lte('resolved_at', asOf.toISOString())
    .order('resolved_at', { ascending: false })
    .limit(limit);

  // `null` e não `[]`: as duas respostas levariam a produzir nada, mas contam
  // histórias diferentes no relatório do ciclo. "Time sem partida passada" é o
  // caso normal de um time novo; "a leitura falhou" é defeito, e confundir os
  // dois é exatamente como o enricher da OddsPapi passou um dia mudo.
  if (error) {
    console.warn(`[${COMPONENT}] leitura de esports_matches falhou: ${error.message}`);
    return null;
  }

  return (data ?? []).map(toPastMatch);
}

async function loadTeamNames(ids: readonly string[]): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  const wanted = [...new Set(ids)].filter(isUuid);
  if (wanted.length === 0) return names;

  const { data, error } = await supabase
    .from('esports_teams')
    .select('id, display_name, polymarket_code')
    .in('id', wanted);

  if (error) {
    console.warn(`[${COMPONENT}] leitura de esports_teams falhou: ${error.message}`);
    return names;
  }

  for (const row of data ?? []) {
    const display = (row['display_name'] as string | null)?.trim();
    const code = (row['polymarket_code'] as string | null)?.trim();
    const name = display !== undefined && display.length > 0 ? display : (code ?? null);
    if (name !== null && name.length > 0) names.set(row['id'] as string, name);
  }

  return names;
}

// ---------------------------------------------------------------------------
// Preço de fechamento das partidas passadas
// ---------------------------------------------------------------------------

/**
 * Memo do preço de fechamento, por (partida passada, time).
 *
 * Vive no processo e não no banco porque o dado é imutável por construção: o
 * último snapshot antes de um horário de início que já passou não muda mais. É
 * a única memoização deste arquivo, e ela é o que separa "27 consultas por
 * partida enriquecida" de "seis": as mesmas partidas passadas reaparecem em todo
 * ciclo, para os mesmos dois times, a cada 30 minutos.
 *
 * A ausência TAMBÉM é memoizada, e com prazo — que é a diferença que importa.
 * Hoje a maioria das candidatas não tem preço (`esports_snapshots` só existe
 * desde 2026-08-05), então sem memoizar a ausência o cache não pouparia nada. E
 * com prazo porque a ausência não é imutável: o link do moneyline pode ser criado
 * depois pelo resolver, ou `outcome_a_index` ser preenchido pelo recompute
 * semanal, e aí o mesmo par passa a ter preço.
 */
const NEGATIVE_TTL_MS = 24 * 3_600_000;
const PRICE_CACHE_CAP = 5_000;

interface CacheEntry {
  observation: PricedObservation | null;
  at: number;
}

const priceCache = new Map<string, CacheEntry>();

/** Só para teste: o cache é global ao processo. */
export function resetPriceCache(): void {
  priceCache.clear();
}

function cacheKey(matchId: string, teamId: string): string {
  return `${matchId}|${teamId}`;
}

function readCache(matchId: string, teamId: string, now: number): CacheEntry | null {
  const entry = priceCache.get(cacheKey(matchId, teamId));
  if (entry === undefined) return null;
  if (entry.observation === null && now - entry.at > NEGATIVE_TTL_MS) return null;
  return entry;
}

function writeCache(matchId: string, teamId: string, observation: PricedObservation | null): void {
  // Descarte por ordem de inserção, e não LRU: a única coisa que a política
  // precisa garantir é que o mapa não cresce sem limite. Um erro de despejo
  // custa uma consulta a mais, não um número errado.
  if (priceCache.size >= PRICE_CACHE_CAP) {
    const oldest = priceCache.keys().next();
    if (!oldest.done) priceCache.delete(oldest.value);
  }

  priceCache.set(cacheKey(matchId, teamId), { observation, at: Date.now() });
}

interface MoneylineLink {
  eventId: string;
  /** Nunca nulo: `loadMoneylines` descarta o link sem índice resolvido. */
  outcomeAIndex: number;
}

type MoneylineByMatch = Map<string, { link: MoneylineLink; labels: string[] }>;

/**
 * O moneyline da série de cada partida passada, e o rótulo de cada lado.
 *
 * Duas consultas em lote para o conjunto inteiro de candidatas, e não duas por
 * partida.
 *
 * Só `market_role = 'moneyline'`. Um link com papel `unknown` e sufixo vazio
 * também é, quase certamente, o moneyline da série — e aceitá-lo ampliaria a
 * cobertura justamente no histórico antigo, que é onde ela falta. Fica de fora
 * mesmo assim, pela mesma razão que `market-history` só aceita o papel
 * declarado: um market derivado tomado por moneyline não produz erro visível,
 * produz uma calibração errada com cara de certa. É a alavanca óbvia se a
 * cobertura travar, e ela pede medição antes, não palpite.
 */
async function loadMoneylines(matchIds: readonly string[]): Promise<MoneylineByMatch> {
  const out: MoneylineByMatch = new Map();
  if (matchIds.length === 0) return out;

  const { data: links, error } = await supabase
    .from('market_match_links')
    .select('event_id, match_id, outcome_a_index')
    .in('match_id', matchIds)
    .eq('market_role', 'moneyline');

  if (error) {
    console.warn(`[${COMPONENT}] leitura de market_match_links falhou: ${error.message}`);
    return out;
  }

  const byMatch = new Map<string, MoneylineLink>();
  for (const row of links ?? []) {
    const matchId = row['match_id'] as string;
    const eventId = row['event_id'] as string;
    const index = asNumber(row['outcome_a_index']);
    if (index === null) continue;

    // Mais de um moneyline para a mesma partida é possível e é anomalia
    // conhecida (ver 20260807182110). Escolha determinística pelo menor
    // `event_id`: o número não pode depender de qual linha o Postgres devolveu
    // primeiro, ou o mesmo fragmento mudaria de valor entre dois ciclos.
    const current = byMatch.get(matchId);
    if (current === undefined || eventId < current.eventId) {
      byMatch.set(matchId, { eventId, outcomeAIndex: index });
    }
  }

  if (byMatch.size === 0) return out;

  const { data: events, error: eventError } = await supabase
    .from('events')
    .select('id, outcomes')
    .in(
      'id',
      [...byMatch.values()].map((link) => link.eventId),
    );

  if (eventError) {
    console.warn(`[${COMPONENT}] leitura de events falhou: ${eventError.message}`);
    return out;
  }

  const outcomesById = new Map<string, string[]>();
  for (const row of events ?? []) {
    const values = (row['outcomes'] as Record<string, unknown> | null)?.['values'];
    // Só binário. O rótulo do lado B é "o outro índice", e essa frase só tem
    // sentido com exatamente dois — num mercado de três resultados não há como
    // saber qual deles é o time B sem mais informação.
    if (!Array.isArray(values) || values.length !== 2) continue;
    if (!values.every((v): v is string => typeof v === 'string')) continue;
    outcomesById.set(row['id'] as string, values);
  }

  for (const [matchId, link] of byMatch) {
    const labels = outcomesById.get(link.eventId);
    if (labels !== undefined) out.set(matchId, { link, labels });
  }

  return out;
}

/**
 * O último snapshot de um outcome antes de `at`.
 *
 * Os dois lados do intervalo, e não só o `lte`: `esports_snapshots` é
 * particionada por dia, e `captured_at <= T` sozinho autoriza o planejador a
 * varrer toda partição anterior a T. Com o piso, a consulta toca uma ou duas
 * partições e usa `idx_esports_snapshots_event_time` dentro delas. Mesmo cuidado
 * de `market-history.anchorAt`.
 */
async function closingPrice(
  eventId: string,
  outcome: string,
  at: Date,
): Promise<{ mid: number; capturedAt: string } | null> {
  const floor = new Date(at.getTime() - CLOSE_TOLERANCE_SECONDS * 1000);

  const { data, error } = await supabase
    .from('esports_snapshots')
    .select('captured_at, mid_price')
    .eq('event_id', eventId)
    .eq('outcome', outcome)
    .lte('captured_at', at.toISOString())
    .gte('captured_at', floor.toISOString())
    .order('captured_at', { ascending: false })
    .limit(1);

  if (error) {
    console.warn(`[${COMPONENT}] leitura de esports_snapshots falhou: ${error.message}`);
    return null;
  }

  const row = data?.[0];
  if (!row) return null;

  const mid = asNumber(row['mid_price']);
  if (mid === null) return null;

  return { mid, capturedAt: row['captured_at'] as string };
}

/**
 * O rótulo de `teamId` no moneyline de `match`.
 *
 * `outcome_a_index` é o índice do time A DAQUELA partida — medido por market,
 * porque markets irmãos aparecem com os outcomes em ordens diferentes. O time B
 * é o outro índice, o que só fecha em mercado binário (garantido por
 * `loadMoneylines`).
 */
export function labelFor(
  match: PastMatch,
  teamId: string,
  outcomeAIndex: number,
  labels: readonly string[],
): string | null {
  if (labels.length !== 2) return null;
  if (outcomeAIndex !== 0 && outcomeAIndex !== 1) return null;

  if (match.teamAId === teamId) return labels[outcomeAIndex] ?? null;
  if (match.teamBId === teamId) return labels[1 - outcomeAIndex] ?? null;

  return null;
}

interface PriceCandidate {
  match: PastMatch;
  teamId: string;
}

/**
 * As observações de preço × desfecho, com teto de consultas e respeito ao prazo.
 *
 * Candidata sem `scheduled_at` fica de fora: sem horário de início não existe
 * "antes do início", e usar `resolved_at` como âncora pegaria preço DE DENTRO da
 * partida — que já embute o placar e não é o que o mercado precificava ao abrir.
 */
async function priceCandidates(
  candidates: readonly PriceCandidate[],
  ctx: EnricherContext,
): Promise<{ observations: PricedObservation[]; withoutPrice: number; truncated: boolean }> {
  const observations: PricedObservation[] = [];
  let withoutPrice = 0;
  let truncated = false;
  let lookups = 0;

  const now = Date.now();
  const pending: PriceCandidate[] = [];

  // Primeiro o cache, para o teto de consultas e o prazo só valerem sobre o que
  // realmente precisa ir ao banco.
  for (const candidate of candidates) {
    const cached = readCache(candidate.match.matchId, candidate.teamId, now);
    if (cached === null) {
      pending.push(candidate);
    } else if (cached.observation === null) {
      withoutPrice++;
    } else {
      observations.push(cached.observation);
    }
  }

  const moneylines: MoneylineByMatch =
    pending.length > 0 ? await loadMoneylines(pending.map((c) => c.match.matchId)) : new Map();

  for (const candidate of pending) {
    if (lookups >= MAX_PRICE_LOOKUPS || remainingMs(ctx) < MIN_REMAINING_MS) {
      truncated = true;
      break;
    }

    const { match, teamId } = candidate;
    const verdict = verdictFor(match, teamId);
    const moneyline = moneylines.get(match.matchId);

    if (verdict === 'void' || match.scheduledAt === null || moneyline === undefined) {
      withoutPrice++;
      // Sem link ou sem horário é ausência que pode mudar (o resolver preenche
      // depois); void não muda nunca, mas cai no mesmo caminho porque o cache
      // negativo expira sozinho e o custo de reavaliar é zero consultas.
      writeCache(match.matchId, teamId, null);
      continue;
    }

    const label = labelFor(match, teamId, moneyline.link.outcomeAIndex, moneyline.labels);
    if (label === null) {
      withoutPrice++;
      writeCache(match.matchId, teamId, null);
      continue;
    }

    lookups++;
    const start = new Date(match.scheduledAt);
    const closing = await closingPrice(moneyline.link.eventId, label, start);

    if (closing === null) {
      withoutPrice++;
      writeCache(match.matchId, teamId, null);
      continue;
    }

    const observation: PricedObservation = {
      matchId: match.matchId,
      matchSlug: match.matchSlug,
      teamId,
      price: closing.mid,
      capturedAt: closing.capturedAt,
      lagSeconds: Math.round((start.getTime() - new Date(closing.capturedAt).getTime()) / 1000),
      resolvedAt: match.resolvedAt,
      verdict,
    };

    observations.push(observation);
    writeCache(match.matchId, teamId, observation);
  }

  return { observations, withoutPrice, truncated };
}

// ---------------------------------------------------------------------------
// Cadência própria
// ---------------------------------------------------------------------------

/**
 * O último fragmento de um `kind`, nos dois eixos.
 *
 * Existe em vez de `lastFragmentAsOf` do runner porque aqui os dois eixos são
 * perguntas diferentes e as duas precisam de resposta:
 *
 *   `as_of`      — o desfecho mais recente que o fragmento anterior já continha.
 *                  Igual ao de agora significa que NADA resolveu no intervalo, e
 *                  regravar produziria uma linha idêntica.
 *   `observed_at`— quando olhamos. É o que impede a supressão de virar
 *                  permanente (ver `shouldSkip`).
 *
 * `lastFragmentAsOf` devolve só o primeiro, e sem filtro de `kind` — que aqui
 * seria ambíguo, porque os três fragmentos deste enricher são gravados no mesmo
 * lote e têm `as_of` diferentes entre si.
 */
async function lastFragment(
  matchId: string,
  kind: string,
): Promise<{ asOf: Date; observedAt: Date } | null> {
  const { data, error } = await supabase
    .from('context_fragments')
    .select('as_of, observed_at')
    .eq('match_id', matchId)
    .eq('enricher_id', MATCH_HISTORY_ID)
    .eq('kind', kind)
    .order('observed_at', { ascending: false })
    .limit(1);

  if (error) return null;

  const row = data?.[0];
  const asOf = new Date(row?.['as_of'] as string);
  const observedAt = new Date(row?.['observed_at'] as string);

  if (!Number.isFinite(asOf.getTime()) || !Number.isFinite(observedAt.getTime())) return null;

  return { asOf, observedAt };
}

/**
 * Vale a pena regravar?
 *
 * A resposta é não quando as duas condições valem: o conteúdo não mudou (nenhuma
 * partida resolveu desde a última gravação) E a última observação ainda é
 * recente. As duas, e não só a primeira, e a razão é concreta:
 *
 * O analista lê `context_fragments` por partida com `limit 200`, ordenado por
 * `observed_at` desc. Com quatro enrichers produzindo a cada 30 min, 200 linhas
 * cobrem cerca de meio dia — e uma partida fica 30h na janela de enriquecimento.
 * Um fragmento gravado uma vez e nunca mais empurrado para frente sai da leitura
 * do analista exatamente perto do início da partida, que é quando ele mais
 * importa. Reobservar a cada TTL é o que o mantém dentro da janela.
 *
 * A comparação de conteúdo é por `as_of` e não por relógio de parede porque
 * `as_of` aqui É o carimbo de mudança da fonte: ele só anda quando uma partida
 * nova resolve. Mesmo desenho do `context_updated_at` em `polymarket-context`.
 */
export function shouldSkip(
  previous: { asOf: Date; observedAt: Date } | null,
  stamp: Date,
  now: Date,
  ttlSeconds: number,
): boolean {
  if (previous === null) return false;
  if (previous.asOf.getTime() !== stamp.getTime()) return false;

  return now.getTime() - previous.observedAt.getTime() < ttlSeconds * 1000;
}

// ---------------------------------------------------------------------------
// O ciclo de uma partida
// ---------------------------------------------------------------------------

/**
 * Seis consultas no caso comum, e é a conta que justifica a ordem do código:
 *
 *   1. `esports_matches` — a partida corrente, para saber quem joga
 *   2. `esports_matches` — forma do time A
 *   3. `esports_matches` — forma do time B
 *   4. `context_fragments` — o carimbo da última gravação (a guarda de cadência)
 *   5. `esports_matches` — confronto direto
 *   6. `esports_teams` — nomes (os dois lados mais os adversários da forma)
 *
 * Mais `market_match_links`, `events` e uma por `esports_snapshots` na calibração
 * — todas memoizadas depois da primeira vez, porque preço de partida encerrada
 * não muda.
 *
 * A guarda de cadência é a 4ª e não a 1ª de propósito: ela compara o carimbo
 * gravado com o carimbo de AGORA, e o carimbo de agora só existe depois de as
 * consultas 2 e 3 responderem. Três consultas é o preço de não regravar linha
 * idêntica, e é pago só até o TTL vencer.
 *
 * As duas consultas de forma são separadas, e não uma com `OR` dos dois times:
 * com `limit` compartilhado, o time que jogou mais recentemente empurraria o
 * outro inteiro para fora do resultado, e a forma sairia enviesada sem sintoma.
 * Mesma razão pela qual o enricher da Liquipedia não junta as dele.
 */
async function fetchMatchHistory(ctx: EnricherContext): Promise<ContextFragment[]> {
  const { data: match, error } = await supabase
    .from('esports_matches')
    .select('team_a_id, team_b_id')
    .eq('id', ctx.matchId)
    .maybeSingle();

  if (error !== null) {
    noteEnricherSkip(MATCH_HISTORY_ID, `leitura da partida falhou: ${error.message}`);
    return [];
  }

  const teamAId = match?.['team_a_id'];
  const teamBId = match?.['team_b_id'];

  if (!isUuid(teamAId) || !isUuid(teamBId) || !isUuid(ctx.matchId)) {
    // O caminho 2 do resolver cria partida a partir do slug, sem identidade de
    // time. Sem os dois lados não há h2h, não há forma e não há calibração.
    noteEnricherSkip(MATCH_HISTORY_ID, 'partida sem os dois times resolvidos');
    return [];
  }

  const formA = await loadPastMatches(
    `team_a_id.eq.${teamAId},team_b_id.eq.${teamAId}`,
    ctx.matchId,
    ctx.asOf,
    FORM_LIMIT,
  );
  const formB = await loadPastMatches(
    `team_a_id.eq.${teamBId},team_b_id.eq.${teamBId}`,
    ctx.matchId,
    ctx.asOf,
    FORM_LIMIT,
  );

  if (formA === null || formB === null) {
    noteEnricherSkip(MATCH_HISTORY_ID, 'leitura das partidas passadas falhou');
    return [];
  }

  const stamp = latestResolvedAt([...formA, ...formB]);
  if (stamp === null) {
    noteEnricherSkip(MATCH_HISTORY_ID, 'nenhuma partida passada resolvida para estes times');
    return [];
  }

  const previous = await lastFragment(ctx.matchId, 'form');
  if (shouldSkip(previous, stamp, new Date(), matchHistoryEnricher.ttlSeconds)) {
    noteEnricherSkip(MATCH_HISTORY_ID, 'nada resolveu desde o último fragmento e o TTL não venceu');
    return [];
  }

  // Falha aqui NÃO derruba a partida: forma e calibração já estão de pé, e um
  // h2h ausente é o caso normal de dois times que nunca se encontraram.
  const h2h =
    (await loadPastMatches(
      `and(team_a_id.eq.${teamAId},team_b_id.eq.${teamBId}),` +
        `and(team_a_id.eq.${teamBId},team_b_id.eq.${teamAId})`,
      ctx.matchId,
      ctx.asOf,
      H2H_LIMIT,
    )) ?? [];

  // Os dois lados mais os adversários que aparecem na forma: uma consulta só.
  const names = await loadTeamNames([
    teamAId,
    teamBId,
    ...[...formA, ...formB].flatMap((m) => [m.teamAId, m.teamBId]).filter(isUuid),
  ]);

  const teamA: TeamRef = { teamId: teamAId, name: names.get(teamAId) ?? 'time A' };
  const teamB: TeamRef = { teamId: teamBId, name: names.get(teamBId) ?? 'time B' };

  const fragments: ContextFragment[] = [];

  const h2hFragment = buildH2hFragment({ teamA, teamB, matches: h2h });
  if (h2hFragment !== null) fragments.push(h2hFragment);

  const formFragment = buildFormFragment({
    sides: [
      { team: teamA, matches: formA },
      { team: teamB, matches: formB },
    ],
    names,
  });
  if (formFragment !== null) fragments.push(formFragment);

  // --- calibração ----------------------------------------------------------
  //
  // O conjunto de candidatas é o mesmo já lido: forma de cada lado mais o h2h,
  // deduplicado por (partida, time). Nenhuma consulta a mais em
  // `esports_matches` — só as de preço, que o cache absorve.
  const seen = new Set<string>();
  const candidates: PriceCandidate[] = [];

  for (const [teamId, matches] of [
    [teamAId, [...formA, ...h2h]],
    [teamBId, [...formB, ...h2h]],
  ] as ReadonlyArray<[string, PastMatch[]]>) {
    for (const past of matches) {
      const key = `${past.matchId}|${teamId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      candidates.push({ match: past, teamId });
    }
  }

  const { observations, withoutPrice, truncated } = await priceCandidates(candidates, ctx);

  const calibration = buildCalibrationFragment({
    sides: [
      { team: teamA, observations: observations.filter((o) => o.teamId === teamAId) },
      { team: teamB, observations: observations.filter((o) => o.teamId === teamBId) },
    ],
    withoutPrice,
    truncated,
  });

  if (calibration !== null) {
    fragments.push(calibration);
  } else if (observations.length < MIN_CALIBRATION_SAMPLE) {
    // Nomeada, e não silenciosa: hoje esta é a saída esperada da maioria das
    // partidas, e sem contá-la a calibração parece quebrada em vez de jovem.
    // `esports_snapshots` começou em 2026-08-05 — o denominador cresce sozinho,
    // um dia por dia.
    noteEnricherSkip(
      MATCH_HISTORY_ID,
      `calibração sem amostra (${observations.length} de ${candidates.length} candidatas com preço)`,
    );
  }

  return fragments;
}

export const matchHistoryEnricher: Enricher = {
  id: MATCH_HISTORY_ID,
  verticals: MATCH_HISTORY_VERTICALS,
  /**
   * Seis horas.
   *
   * O conteúdo só muda quando uma partida dos dois times resolve, o que acontece
   * em dias e não em minutos — ao contrário do preço, onde cada leitura é
   * informação nova. Seis horas é o intervalo em que a reobservação ainda mantém
   * o fragmento dentro das 200 linhas que o analista lê (ver `shouldSkip`) sem
   * encher a tabela de cópias da mesma contagem.
   *
   * Diferente dos outros enrichers, este TTL é honrado pelo próprio `fetch`, e
   * não só declarado: o runner não checa TTL nenhum, por decisão registrada em
   * `enricher.ts`, e o argumento de lá — reobservar é barato e "a fonte não
   * mudou" é um fato sobre a fonte — não se aplica a uma fonte que é o nosso
   * próprio banco. "Nada resolveu desde ontem" é derivável a qualquer momento,
   * não é observação perecível.
   */
  ttlSeconds: 6 * 3_600,
  /** Ver a seção POINT-IN-TIME no topo. `resolved_at <= asOf`, e é só isso. */
  supportsPointInTime: true,
  fetch: fetchMatchHistory,
};
