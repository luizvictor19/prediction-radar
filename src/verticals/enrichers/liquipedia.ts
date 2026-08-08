import { supabase } from '../../lib/supabase.js';
import { getSystemConfig } from '../../lib/config.js';
import {
  query,
  and,
  or,
  eq,
  before,
  budget,
  describeConfig,
  readConfig,
  ATTRIBUTION,
  ATTRIBUTION_SUFFIX,
  LiquipediaError,
} from '../../lib/liquipedia-api.js';
import { lastFragmentAsOf, noteEnricherSkip } from '../enricher.js';
import type { ContextFragment, Enricher, EnricherContext } from '../enricher.js';

/**
 * `liquipedia` — a terceira fonte de contexto, e a primeira independente da
 * Polymarket.
 *
 * O primeiro eval (2026-08-07) mostrou o agente empatando com o preço: Brier
 * 0,1017 contra 0,1006 do mercado, n=12. Empate é o resultado esperado de quem
 * lê as mesmas coisas que o mercado — 58% das afirmações citavam
 * `polymarket-context`, que é texto gerado pela própria Polymarket e que o
 * mercado obviamente também tem. Este enricher existe para trazer o que o preço
 * ainda não precificou: quem entrou no time semana passada, como o confronto
 * direto costuma terminar, e em que formato esta partida é jogada.
 *
 * Quatro fragmentos, um por pergunta:
 *
 *   `roster`     — line-up ativo dos dois times, de `squadplayer`
 *   `h2h`        — confronto direto, de `match2` com os dois lados
 *   `form`       — últimas partidas de cada time, de `match2`
 *   `tournament` — formato, tier e datas da competição, de `tournament`
 *
 * ---------------------------------------------------------------------------
 * POINT-IN-TIME: `false`, E A RAZÃO NÃO É FALTA DE DATA
 * ---------------------------------------------------------------------------
 *
 * A tentação é declarar `true`. Os dados SÃO datados, e bem: `squadplayer` tem
 * `joindate` e `leavedate`, `match2` tem `date`. Dá para montar a consulta que
 * pergunta "quem estava no time em 3 de maio" e ela responde.
 *
 * O problema é outro, e é fatal para replay: **a wiki é editada
 * retroativamente, e a LPDB não expõe QUANDO o fato foi registrado.** Uma troca
 * de line-up ocorrida em 1º de maio pode ter entrado na wiki em 10 de maio; um
 * resultado entra depois da partida; uma correção de `joindate` entra meses
 * depois. Perguntar hoje "qual era o roster em 1º de maio" devolve a resposta
 * CORRIGIDA — que inclui coisas que ninguém sabia em 1º de maio. Não há campo
 * para detectar isso, então não há como recusar caso a caso.
 *
 * É exatamente o vazamento nº 1 descrito em `enricher.ts`: fonte que faz
 * backfill grava hoje um fato com `as_of` de ontem. Com uma diferença que piora
 * o caso: lá o vazamento é visível no eixo errado, aqui ele é invisível.
 *
 * Consequências, e elas precisam estar explícitas:
 *
 *   1. `runEnrichers` RECUSA este enricher quando `asOf` está no passado além
 *      da tolerância, mesmo sem ninguém pedir `requirePointInTime`. Nenhum
 *      replay de eval vai vê-lo. Isso não é configuração — é a guarda do
 *      contrato, e ela é bidirecional.
 *
 *   2. O valor dele acumula PARA A FRENTE, e só. Cada execução em produção grava
 *      um fragmento com `observed_at` carimbado pelo banco; uma análise feita
 *      depois disso o enxerga legitimamente, e o eval que pontuar essa análise
 *      também. O que este enricher nunca vai fazer é melhorar retroativamente as
 *      33 análises que já existem.
 *
 *   3. O `as_of` que ele declara é o instante da OBSERVAÇÃO, não a data do fato.
 *      Um roster com `joindate` de março observado hoje tem `as_of` de hoje:
 *      dizer março seria afirmar que nós sabíamos em março. As datas do fato vão
 *      no payload, onde são dado, não índice.
 *
 * O que mudaria a flag para `true` — e é caminho real, não consolo: a API
 * MediaWiki da Liquipedia (`action=query&prop=revisions&rvstart=...`) devolve a
 * página como ela ERA numa data, com o carimbo da revisão. Isso é "quando a
 * Liquipedia soube", que é o que falta. O custo é parsear wikitext e um limite
 * de 1 requisição a cada 2 segundos, e a decisão de pagar isso só faz sentido
 * depois de este enricher provar que o dado ajuda.
 *
 * ---------------------------------------------------------------------------
 * ATRIBUIÇÃO
 * ---------------------------------------------------------------------------
 *
 * CC BY-SA 3.0 exige atribuir a Liquipedia como fonte. Todo fragmento carrega
 * `source` no payload E a frase no fim do `summary` — no texto porque é o
 * `summary` que entra no prompt do analista, e um consumidor que concatene
 * summaries perde os campos estruturados.
 */

export const LIQUIPEDIA_ID = 'liquipedia';

/**
 * Wiki da Liquipedia por vertical.
 *
 * Não é derivável do id da vertical, do mesmo jeito que `provider_league` não é
 * derivável do prefixo do slug: CS2 mora na wiki `counterstrike`, não `cs2`.
 * Vertical que não estiver neste mapa simplesmente não é atendida — a lista de
 * `verticals` do enricher é montada a partir das chaves daqui.
 */
export const WIKI_BY_VERTICAL: Record<string, string> = {
  cs2: 'counterstrike',
  lol: 'leagueoflegends',
  dota2: 'dota2',
};

/**
 * Confiança dos fragmentos.
 *
 * Acima do teto de 0,4 de `polymarket-context` por três diferenças concretas:
 * não é texto gerado por LLM, é dado estruturado com fonte citável (a página), e
 * é verificável por qualquer um. Abaixo de 1,0 porque a wiki é editada pela
 * comunidade e pode estar desatualizada — sobretudo em time de tier baixo, que
 * é metade do nosso universo.
 */
export const CONFIDENCE = 0.7;

/** Quantas partidas passadas entram na forma recente de cada time. */
const FORM_LIMIT = 8;

/** Quantos confrontos diretos entram no h2h. */
const H2H_LIMIT = 10;

/** Jogadores lidos por consulta de squad (dois times, com folga para ex-membros). */
const SQUAD_LIMIT = 60;

/**
 * TTLs de cache, por natureza do dado.
 *
 * Os termos pedem cache "as long as possible", e as naturezas são diferentes:
 * identidade de time não muda, roster muda em semanas, torneio muda em dias,
 * resultado de partida muda em horas.
 */
const CACHE = {
  team: 7 * 24 * 3_600,
  squad: 12 * 3_600,
  match: 3_600,
  tournament: 24 * 3_600,
} as const;

/** Reserva: abaixo disso o enricher nem começa uma partida nova. */
const MIN_BUDGET_FOR_MATCH = 5;

// ---------------------------------------------------------------------------
// Resolução de identidade do time
// ---------------------------------------------------------------------------

/**
 * Como se acha um time da Liquipedia a partir do que nós temos.
 *
 * O que nós temos por time é `esports_teams.display_name` (de `teams[].name` da
 * Gamma: 'Natus Vincere', 'FaZe Clan') e `polymarket_code` ('navi', 'faze').
 *
 *   POR NOME — funciona, e é o único caminho. O `display_name` da Gamma é o nome
 *   canônico da organização, que é também o título da página na Liquipedia na
 *   grande maioria dos casos. A consulta é `[[name::X]] OR [[name::Y]]` no
 *   datapoint `team`, que devolve `pagename` — a chave de tudo o mais.
 *
 *   POR `pandascoreMatchId` — NÃO funciona, e isto foi investigado antes de
 *   escrever código. A Liquipedia não indexa identificadores do PandaScore: o
 *   `extradata` de `match2` é vocabulário livre por wiki e não tem campo de
 *   provedor externo padronizado. PandaScore é fornecedor comercial concorrente
 *   da própria LPDB; não há razão para a wiki carregar a chave dele, e não
 *   carrega. Quem depender disso não vai achar nada.
 *
 * Time sem `display_name` (o caminho 2 do resolver, que só conhece o código do
 * slug) não é resolvível aqui. Não se tenta adivinhar a página a partir de
 * 'navi': a Liquipedia tem redirecionamentos, mas errar a página é pior que não
 * ter fragmento — seria roster de outro time apresentado como fato.
 */
export interface TeamIdentity {
  teamId: string;
  displayName: string;
  /** Título da página na Liquipedia. `null` = procurado e não encontrado. */
  page: string | null;
}

/** Quanto tempo um "não existe na Liquipedia" vale antes de perguntar de novo. */
const MISSING_RECHECK_DAYS = 30;

interface TeamRow {
  id: string;
  display_name: string | null;
  external_ids: Record<string, unknown> | null;
}

/**
 * O que `external_ids` já sabe: página conhecida, ausência recente, ou nada.
 *
 * A memoização mora em `esports_teams.external_ids` e não em memória porque o
 * orçamento é de 60 requisições por HORA: um deploy que zerasse o cache
 * gastaria o orçamento inteiro reaprendendo o que já se sabia. A coluna existe
 * exatamente para isto — o comentário dela na migration 20260806183705 diz "Ids
 * de fontes que ainda nao temos (GRID, Liquipedia)".
 */
export function readCachedPage(
  externalIds: Record<string, unknown> | null,
  now: Date,
): { kind: 'page'; page: string } | { kind: 'missing' } | { kind: 'unknown' } {
  if (externalIds === null) return { kind: 'unknown' };

  const page = externalIds['liquipedia_page'];
  if (typeof page === 'string' && page.trim().length > 0) {
    return { kind: 'page', page: page.trim() };
  }

  const checkedAt = externalIds['liquipedia_missing_at'];
  if (typeof checkedAt === 'string') {
    const at = new Date(checkedAt);
    const ageDays = (now.getTime() - at.getTime()) / (24 * 3_600_000);
    if (Number.isFinite(ageDays) && ageDays < MISSING_RECHECK_DAYS) return { kind: 'missing' };
  }

  return { kind: 'unknown' };
}

/**
 * Grava o que se aprendeu sobre a identidade, mesclando com o que já havia.
 *
 * Escrita de enricher numa tabela de entidade é fora do padrão — o normal é
 * enricher só produzir fragmento — e a justificativa é o orçamento: sem isto,
 * cada partida gastaria uma das 50 requisições da hora para reaprender que
 * 'Natus Vincere' mora em 'Natus Vincere'. Falha aqui não interrompe nada: no
 * pior caso se pergunta de novo.
 */
async function rememberPage(
  teamId: string,
  current: Record<string, unknown> | null,
  page: string | null,
): Promise<void> {
  const merged: Record<string, unknown> = { ...(current ?? {}) };

  if (page === null) {
    merged['liquipedia_page'] = null;
    merged['liquipedia_missing_at'] = new Date().toISOString();
  } else {
    merged['liquipedia_page'] = page;
    delete merged['liquipedia_missing_at'];
  }

  const { error } = await supabase
    .from('esports_teams')
    .update({ external_ids: merged })
    .eq('id', teamId);

  if (error) {
    console.warn(`[${LIQUIPEDIA_ID}] não gravou liquipedia_page de ${teamId}: ${error.message}`);
  }
}

/** Casamento de nome, tolerante a caixa e espaço — e a nada mais. */
function sameName(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/**
 * A página de cada time, do cache ou da API.
 *
 * Uma consulta só para os dois times. O resultado — inclusive a ausência — vai
 * para `external_ids`.
 */
async function resolveTeams(
  wiki: string,
  teams: readonly TeamRow[],
  now: Date,
): Promise<TeamIdentity[]> {
  const identities: TeamIdentity[] = [];
  const toAsk: TeamRow[] = [];

  for (const team of teams) {
    const displayName = team.display_name?.trim() ?? '';
    if (displayName.length === 0) continue;

    const cached = readCachedPage(team.external_ids, now);
    if (cached.kind === 'page') {
      identities.push({ teamId: team.id, displayName, page: cached.page });
    } else if (cached.kind === 'missing') {
      identities.push({ teamId: team.id, displayName, page: null });
    } else {
      toAsk.push(team);
    }
  }

  if (toAsk.length === 0) return identities;

  const rows = await query({
    wiki,
    datapoint: 'team',
    conditions: or(...toAsk.map((t) => eq('name', t.display_name as string))),
    query: 'name,pagename',
    limit: 10,
    cacheSeconds: CACHE.team,
  });

  for (const team of toAsk) {
    const displayName = (team.display_name as string).trim();
    const hit = rows.find((row) => {
      const name = row['name'];
      return typeof name === 'string' && sameName(name, displayName);
    });

    const page = typeof hit?.['pagename'] === 'string' ? (hit['pagename'] as string) : null;
    identities.push({ teamId: team.id, displayName, page });
    await rememberPage(team.id, team.external_ids, page);
  }

  return identities;
}

// ---------------------------------------------------------------------------
// Leitura dos dados, pura a partir das linhas
// ---------------------------------------------------------------------------

function str(row: Record<string, unknown>, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = row[key];
    if (typeof value === 'string' && value.trim().length > 0) return value.trim();
    if (typeof value === 'number') return String(value);
  }
  return null;
}

/** Data do LPDB (`YYYY-MM-DD` ou ISO) como Date, ou `null`. */
export function parseDate(raw: string | null): Date | null {
  if (raw === null) return null;
  // A LPDB usa `0000-00-00` para "sem data", que o Date lê como inválido em
  // alguns motores e como ano zero em outros. Tratar explicitamente.
  if (/^0{4}-0{2}-0{2}/.test(raw)) return null;

  const parsed = new Date(raw.includes('T') ? raw : `${raw}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

export interface SquadMember {
  id: string;
  name: string | null;
  role: string | null;
  joinDate: Date | null;
  leaveDate: Date | null;
}

/**
 * Quem estava no time no instante pedido.
 *
 * `joindate <= asOf` e (`leavedate` vazia ou `> asOf`). A filtragem é feita aqui
 * e não na condição da consulta por uma razão de orçamento: uma consulta serve
 * os dois times e fica em cache por 12h, e refiltrar em memória é de graça.
 *
 * Vale repetir o que está no topo do arquivo: isto NÃO torna o enricher
 * point-in-time. Reconstruir o roster de uma data passada com o conhecimento de
 * hoje é diferente de saber o que se sabia naquela data.
 */
export function activeSquad(
  rows: readonly Record<string, unknown>[],
  page: string,
  asOf: Date,
): SquadMember[] {
  const members: SquadMember[] = [];

  for (const row of rows) {
    const rowPage = str(row, 'pagename', 'teampagename');
    if (rowPage === null || rowPage.replace(/_/g, ' ') !== page.replace(/_/g, ' ')) continue;

    const joinDate = parseDate(str(row, 'joindate'));
    const leaveDate = parseDate(str(row, 'leavedate'));

    if (joinDate !== null && joinDate.getTime() > asOf.getTime()) continue;
    if (leaveDate !== null && leaveDate.getTime() <= asOf.getTime()) continue;

    const id = str(row, 'id', 'link', 'name');
    if (id === null) continue;

    members.push({
      id,
      name: str(row, 'name'),
      role: str(row, 'role', 'position'),
      joinDate,
      leaveDate,
    });
  }

  return members;
}

export interface MatchRecord {
  date: Date | null;
  opponents: string[];
  winner: string | null;
  tournament: string | null;
  parentPage: string | null;
  bestOf: number | null;
  scores: number[];
}

/** Os nomes dos dois lados de uma linha de `match2`, na ordem em que vierem. */
function readOpponents(row: Record<string, unknown>): { names: string[]; scores: number[] } {
  const raw = row['match2opponents'];
  if (!Array.isArray(raw)) return { names: [], scores: [] };

  const names: string[] = [];
  const scores: number[] = [];

  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue;
    const opponent = entry as Record<string, unknown>;

    const name = str(opponent, 'name', 'template', 'id');
    if (name !== null) names.push(name);

    const score = opponent['score'];
    scores.push(typeof score === 'number' ? score : Number(score ?? Number.NaN));
  }

  return { names, scores };
}

export function readMatch(row: Record<string, unknown>): MatchRecord {
  const { names, scores } = readOpponents(row);
  const winnerIndex = Number(str(row, 'winner') ?? Number.NaN);
  const bestOf = Number(str(row, 'bestof') ?? Number.NaN);

  return {
    date: parseDate(str(row, 'date')),
    opponents: names,
    // `winner` do LPDB é o ÍNDICE do lado vencedor, base 1. Fora da faixa
    // significa empate, cancelamento ou partida ainda não jogada.
    winner:
      Number.isInteger(winnerIndex) && winnerIndex >= 1 && winnerIndex <= names.length
        ? (names[winnerIndex - 1] as string)
        : null,
    tournament: str(row, 'tournament', 'tickername'),
    parentPage: str(row, 'parent', 'pagename'),
    bestOf: Number.isInteger(bestOf) && bestOf > 0 ? bestOf : null,
    scores: scores.filter(Number.isFinite),
  };
}

/** Vitórias e derrotas de um time numa lista de partidas já jogadas. */
export function tally(
  matches: readonly MatchRecord[],
  page: string,
): { wins: number; losses: number; other: number } {
  let wins = 0;
  let losses = 0;
  let other = 0;

  for (const match of matches) {
    if (match.winner === null) {
      other++;
    } else if (sameName(match.winner, page)) {
      wins++;
    } else {
      losses++;
    }
  }

  return { wins, losses, other };
}

// ---------------------------------------------------------------------------
// Fragmentos
// ---------------------------------------------------------------------------

function pageUrl(wiki: string, page: string): string {
  return `https://liquipedia.net/${wiki}/${encodeURIComponent(page.replace(/ /g, '_'))}`;
}

function fragment(
  kind: string,
  asOf: Date,
  summary: string,
  payload: Record<string, unknown>,
): ContextFragment {
  return {
    enricherId: LIQUIPEDIA_ID,
    kind,
    asOf,
    payload: { ...payload, source: ATTRIBUTION },
    summary: `${summary} ${ATTRIBUTION_SUFFIX}`,
    confidence: CONFIDENCE,
  };
}

function describeMember(member: SquadMember): string {
  const role = member.role === null ? '' : ` (${member.role})`;
  return `${member.name ?? member.id}${role}`;
}

/** Entrou nos últimos 60 dias — o pedaço do roster que o mercado pode não ter precificado. */
const RECENT_JOIN_DAYS = 60;

export function buildRosterFragment(
  wiki: string,
  sides: ReadonlyArray<{ identity: TeamIdentity; squad: SquadMember[] }>,
  asOf: Date,
): ContextFragment | null {
  const withSquad = sides.filter((s) => s.squad.length > 0);
  if (withSquad.length === 0) return null;

  const parts: string[] = [];
  const recent: string[] = [];

  for (const side of withSquad) {
    parts.push(`${side.identity.displayName}: ${side.squad.map(describeMember).join(', ')}`);

    for (const member of side.squad) {
      if (member.joinDate === null) continue;
      const days = (asOf.getTime() - member.joinDate.getTime()) / 86_400_000;
      if (days >= 0 && days <= RECENT_JOIN_DAYS) {
        const day = member.joinDate.toISOString().slice(0, 10);
        recent.push(`${member.name ?? member.id} entrou no ${side.identity.displayName} em ${day}`);
      }
    }
  }

  const novelty =
    recent.length > 0
      ? ` Mudança recente de line-up: ${recent.join('; ')}.`
      : ' Nenhuma entrada nos últimos 60 dias.';

  return fragment('roster', asOf, `Line-up ativo. ${parts.join('. ')}.${novelty}`, {
    teams: withSquad.map((side) => ({
      team_id: side.identity.teamId,
      display_name: side.identity.displayName,
      liquipedia_page: side.identity.page,
      url: side.identity.page === null ? null : pageUrl(wiki, side.identity.page),
      players: side.squad.map((m) => ({
        id: m.id,
        name: m.name,
        role: m.role,
        join_date: m.joinDate?.toISOString() ?? null,
        leave_date: m.leaveDate?.toISOString() ?? null,
      })),
    })),
    // O filtro que produziu a lista, gravado junto: sem ele o payload não diz
    // a que instante o line-up se refere.
    active_at: asOf.toISOString(),
  });
}

export function buildH2hFragment(
  wiki: string,
  a: TeamIdentity,
  b: TeamIdentity,
  matches: readonly MatchRecord[],
  asOf: Date,
): ContextFragment | null {
  if (matches.length === 0 || a.page === null || b.page === null) return null;

  const counts = tally(matches, a.page);
  const last = matches[0] as MatchRecord;
  const lastLine =
    last.date === null
      ? ''
      : ` Último encontro em ${last.date.toISOString().slice(0, 10)}` +
        `${last.winner === null ? '' : `, vitória de ${last.winner}`}` +
        `${last.tournament === null ? '' : ` (${last.tournament})`}.`;

  return fragment(
    'h2h',
    asOf,
    `Confronto direto ${a.displayName} x ${b.displayName} em ${matches.length} partidas registradas: ` +
      `${counts.wins}-${counts.losses} para ${a.displayName}` +
      `${counts.other > 0 ? ` (${counts.other} sem vencedor registrado)` : ''}.${lastLine}`,
    {
      team_a: { team_id: a.teamId, display_name: a.displayName, liquipedia_page: a.page },
      team_b: { team_id: b.teamId, display_name: b.displayName, liquipedia_page: b.page },
      record_for_team_a: counts,
      matches: matches.map((m) => ({
        date: m.date?.toISOString() ?? null,
        opponents: m.opponents,
        winner: m.winner,
        scores: m.scores,
        best_of: m.bestOf,
        tournament: m.tournament,
      })),
      url: pageUrl(wiki, a.page),
    },
  );
}

export function buildFormFragment(
  wiki: string,
  identity: TeamIdentity,
  matches: readonly MatchRecord[],
  asOf: Date,
): ContextFragment | null {
  if (matches.length === 0 || identity.page === null) return null;

  const counts = tally(matches, identity.page);
  const opponents = matches
    .slice(0, 5)
    .map((m) => {
      const other = m.opponents.find((name) => !sameName(name, identity.page as string));
      const mark =
        m.winner === null ? '?' : sameName(m.winner, identity.page as string) ? 'V' : 'D';
      return `${mark} vs ${other ?? '?'}`;
    })
    .join(', ');

  return fragment(
    'form',
    asOf,
    `Forma recente de ${identity.displayName}: ${counts.wins}V-${counts.losses}D nas últimas ` +
      `${matches.length} partidas. Mais recentes: ${opponents}.`,
    {
      team_id: identity.teamId,
      display_name: identity.displayName,
      liquipedia_page: identity.page,
      record: counts,
      matches: matches.map((m) => ({
        date: m.date?.toISOString() ?? null,
        opponents: m.opponents,
        winner: m.winner,
        scores: m.scores,
        best_of: m.bestOf,
        tournament: m.tournament,
      })),
      url: pageUrl(wiki, identity.page),
    },
  );
}

export function buildTournamentFragment(
  wiki: string,
  row: Record<string, unknown>,
  upcomingBestOf: number | null,
  asOf: Date,
): ContextFragment | null {
  const name = str(row, 'name', 'pagename');
  if (name === null) return null;

  const tier = str(row, 'liquipediatier', 'tier');
  const type = str(row, 'type');
  const mode = str(row, 'mode');
  const prize = str(row, 'prizepool');
  const location = str(row, 'location');
  const start = str(row, 'startdate');
  const end = str(row, 'enddate');
  const page = str(row, 'pagename') ?? name;

  const bits = [
    tier === null ? null : `tier ${tier}`,
    type === null ? null : type,
    mode === null ? null : mode,
    location === null ? null : `em ${location}`,
    prize === null ? null : `premiação ${prize}`,
    start === null ? null : `de ${start}${end === null ? '' : ` a ${end}`}`,
    upcomingBestOf === null ? null : `partida em Bo${upcomingBestOf}`,
  ].filter((bit): bit is string => bit !== null);

  return fragment('tournament', asOf, `Torneio ${name}: ${bits.join(', ')}.`, {
    name,
    liquipedia_page: page,
    tier,
    type,
    mode,
    prize_pool: prize,
    location,
    start_date: start,
    end_date: end,
    best_of: upcomingBestOf,
    url: pageUrl(wiki, page),
  });
}

// ---------------------------------------------------------------------------
// Busca
// ---------------------------------------------------------------------------

const MATCH_FIELDS = 'date,winner,bestof,tournament,parent,pagename,match2opponents';

async function loadTeamRows(
  matchId: string,
): Promise<{ rows: TeamRow[]; verticalId: string } | null> {
  const { data: match, error } = await supabase
    .from('esports_matches')
    .select('vertical_id, team_a_id, team_b_id')
    .eq('id', matchId)
    .maybeSingle();

  if (error || match === null) {
    if (error)
      console.warn(`[${LIQUIPEDIA_ID}] leitura de esports_matches falhou: ${error.message}`);
    return null;
  }

  const ids = [match['team_a_id'], match['team_b_id']].filter(
    (id): id is string => typeof id === 'string',
  );
  if (ids.length !== 2) return null;

  const { data: teams, error: teamError } = await supabase
    .from('esports_teams')
    .select('id, display_name, external_ids')
    .in('id', ids);

  if (teamError) {
    console.warn(`[${LIQUIPEDIA_ID}] leitura de esports_teams falhou: ${teamError.message}`);
    return null;
  }

  // A ordem importa: o lado A é o lado a que a probabilidade do analista se
  // refere, e o h2h é contado do ponto de vista dele.
  const byId = new Map((teams ?? []).map((row) => [row['id'] as string, row as TeamRow]));
  const ordered = ids.map((id) => byId.get(id)).filter((row): row is TeamRow => row !== undefined);

  return ordered.length === 2
    ? { rows: ordered, verticalId: match['vertical_id'] as string }
    : null;
}

/**
 * O ciclo de uma partida.
 *
 * Cinco consultas no pior caso, e o pior caso é raro porque a identidade do time
 * fica memoizada em `external_ids`:
 *
 *   1. `team`       — só quando a página ainda não é conhecida
 *   2. `squadplayer`— os dois times de uma vez
 *   3. `match2`     — confronto direto, SEM filtro de data: a mesma resposta
 *                     serve o h2h (partidas passadas) e o Bo da partida que vem
 *   4. `match2`     — forma do time A
 *   5. `match2`     — forma do time B
 *   6. `tournament` — só quando a consulta 3 revelou a página do torneio
 *
 * As três de `match2` poderiam virar uma com `OR`, e não viram de propósito: com
 * `limit` compartilhado, um time que jogou muito recentemente empurraria o outro
 * inteiro para fora do resultado, e o fragmento sairia enviesado sem sintoma.
 */
async function fetchLiquipedia(ctx: EnricherContext): Promise<ContextFragment[]> {
  // Toda saída daqui para baixo é NOMEADA, pelo mesmo motivo do enricher da
  // OddsPapi: este aqui saía mudo 40 vezes por ciclo, e "sem credencial" ficava
  // indistinguível de "não tenho o que dizer sobre esta partida".
  const wiki = WIKI_BY_VERTICAL[ctx.verticalId];
  if (wiki === undefined) {
    noteEnricherSkip(LIQUIPEDIA_ID, `vertical ${ctx.verticalId} sem wiki mapeada`);
    return [];
  }

  const config = await getSystemConfig();
  if (config.esports_enricher_liquipedia_enabled !== true) {
    noteEnricherSkip(
      LIQUIPEDIA_ID,
      'esports_enricher_liquipedia_enabled != true (desligado, ou coluna inexistente)',
    );
    return [];
  }

  if (readConfig() === null) {
    // Uma vez por ciclo, não por partida: o job chama isto para dezenas de
    // partidas e a mensagem é a mesma.
    warnOnce(`[${LIQUIPEDIA_ID}] desligado por falta de credencial (${describeConfig()})`);
    noteEnricherSkip(LIQUIPEDIA_ID, `credencial ausente (${describeConfig()})`);
    return [];
  }

  // Entrar numa partida sem orçamento para terminá-la produz fragmento pela
  // metade — roster sem forma, h2h sem torneio — e gasta o que sobrou sem
  // completar nada.
  if (budget.remaining() < MIN_BUDGET_FOR_MATCH) {
    console.warn(
      `[${LIQUIPEDIA_ID}] ${ctx.matchId} pulada: restam ${budget.remaining()} requisições na hora`,
    );
    noteEnricherSkip(LIQUIPEDIA_ID, 'orçamento de 60 req/h no fim');
    return [];
  }

  // O TTL é do enricher e é checado aqui porque o runner não checa TTL nenhum
  // (decisão documentada em `enricher.ts`). Sem isto, uma partida na janela
  // seria reconsultada a cada 30 min e o orçamento acabaria em duas horas.
  const lastAsOf = await lastFragmentAsOf(ctx.matchId, LIQUIPEDIA_ID);
  if (
    lastAsOf !== null &&
    ctx.asOf.getTime() - lastAsOf.getTime() < liquipediaEnricher.ttlSeconds * 1000
  ) {
    noteEnricherSkip(LIQUIPEDIA_ID, 'TTL de 6h ainda não venceu');
    return [];
  }

  const loaded = await loadTeamRows(ctx.matchId);
  if (loaded === null) {
    noteEnricherSkip(LIQUIPEDIA_ID, 'partida sem os dois times resolvidos');
    return [];
  }

  const asOf = ctx.asOf;
  const fragments: ContextFragment[] = [];

  const identities = await resolveTeams(wiki, loaded.rows, asOf);
  const [a, b] = identities;
  if (a === undefined || b === undefined) {
    // `resolveTeams` descarta time sem `display_name` — o caminho 2 do resolver.
    noteEnricherSkip(LIQUIPEDIA_ID, 'time sem display_name para consultar a wiki');
    return [];
  }

  const pages = identities.filter((i): i is TeamIdentity & { page: string } => i.page !== null);
  if (pages.length === 0) {
    noteEnricherSkip(LIQUIPEDIA_ID, 'nenhum dos times tem página na Liquipedia');
    return [];
  }

  // --- roster -------------------------------------------------------------
  const squadRows = await query({
    wiki,
    datapoint: 'squadplayer',
    conditions: or(...pages.map((i) => eq('pagename', i.page))),
    query: 'pagename,id,name,link,role,position,joindate,leavedate',
    limit: SQUAD_LIMIT,
    cacheSeconds: CACHE.squad,
  });

  const roster = buildRosterFragment(
    wiki,
    pages.map((identity) => ({ identity, squad: activeSquad(squadRows, identity.page, asOf) })),
    asOf,
  );
  if (roster !== null) fragments.push(roster);

  // --- h2h e o Bo da partida que vem --------------------------------------
  let upcomingBestOf: number | null = null;
  let tournamentPage: string | null = null;

  if (a.page !== null && b.page !== null) {
    const h2hRows = await query({
      wiki,
      datapoint: 'match2',
      conditions: and(eq('opponent', a.page), eq('opponent', b.page)),
      query: MATCH_FIELDS,
      limit: H2H_LIMIT + 3,
      order: 'date DESC',
      cacheSeconds: CACHE.match,
    });

    const all = h2hRows.map(readMatch);
    const past = all
      .filter((m) => m.date !== null && m.date.getTime() < asOf.getTime())
      .slice(0, H2H_LIMIT);

    // A partida que vem é a que ainda não aconteceu — dela interessa o formato,
    // não o resultado, que não existe.
    const upcoming = all.filter((m) => m.date !== null && m.date.getTime() >= asOf.getTime()).pop();

    upcomingBestOf = upcoming?.bestOf ?? null;
    tournamentPage = upcoming?.parentPage ?? past[0]?.parentPage ?? null;

    const h2h = buildH2hFragment(wiki, a, b, past, asOf);
    if (h2h !== null) fragments.push(h2h);
  }

  // --- forma de cada lado --------------------------------------------------
  for (const identity of pages) {
    const rows = await query({
      wiki,
      datapoint: 'match2',
      conditions: and(eq('opponent', identity.page), before('date', asOf)),
      query: MATCH_FIELDS,
      limit: FORM_LIMIT,
      order: 'date DESC',
      cacheSeconds: CACHE.match,
    });

    const form = buildFormFragment(wiki, identity, rows.map(readMatch), asOf);
    if (form !== null) fragments.push(form);
  }

  // --- torneio -------------------------------------------------------------
  if (tournamentPage !== null) {
    const rows = await query({
      wiki,
      datapoint: 'tournament',
      conditions: eq('pagename', tournamentPage),
      query: 'name,pagename,liquipediatier,type,mode,prizepool,location,startdate,enddate',
      limit: 1,
      cacheSeconds: CACHE.tournament,
    });

    const first = rows[0];
    if (first !== undefined) {
      const tournament = buildTournamentFragment(wiki, first, upcomingBestOf, asOf);
      if (tournament !== null) fragments.push(tournament);
    }
  }

  return fragments;
}

/**
 * O `fetch` que o runner chama.
 *
 * `LiquipediaError` de configuração ou orçamento NÃO é falha do ciclo: é o
 * componente respeitando os próprios limites. Vira aviso e vazio. O resto sobe,
 * porque o runner já isola cada enricher e loga.
 */
async function fetchGuarded(ctx: EnricherContext): Promise<ContextFragment[]> {
  try {
    return await fetchLiquipedia(ctx);
  } catch (err) {
    if (err instanceof LiquipediaError) {
      if (err.kind === 'rate_limited' || err.kind === 'not_configured') {
        warnOnce(`[${LIQUIPEDIA_ID}] ${err.message}`);
        noteEnricherSkip(LIQUIPEDIA_ID, `fonte indisponível: ${err.kind}`);
        return [];
      }
      noteEnricherSkip(LIQUIPEDIA_ID, `erro da fonte: ${err.kind}`);
      console.warn(`[${LIQUIPEDIA_ID}] ${ctx.matchId}: ${err.kind} — ${err.message}`);
      return [];
    }
    throw err;
  }
}

/** Uma mensagem igual por hora. O job chama isto dezenas de vezes por ciclo. */
const warnedAt = new Map<string, number>();

function warnOnce(message: string): void {
  const now = Date.now();
  const last = warnedAt.get(message);
  if (last !== undefined && now - last < 3_600_000) return;

  warnedAt.set(message, now);
  console.warn(message);
}

export const liquipediaEnricher: Enricher = {
  id: LIQUIPEDIA_ID,
  verticals: Object.keys(WIKI_BY_VERTICAL),
  /**
   * Seis horas.
   *
   * Roster e formato de torneio mudam em semanas; forma recente muda quando um
   * jogo termina. Seis horas é o ponto em que o dado ainda vale e o orçamento de
   * 50 requisições/hora sobrevive: com ~5 requisições por partida, cabem ~60
   * partidas por período de TTL.
   */
  ttlSeconds: 6 * 3_600,
  /** Ver a seção POINT-IN-TIME no topo. Não é preguiça, é a wiki ser retroativa. */
  supportsPointInTime: false,
  fetch: fetchGuarded,
};
