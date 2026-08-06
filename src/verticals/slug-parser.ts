/**
 * Parser de slug de mercado de esports (spec 001, item 2 / Parte B).
 *
 * ## O que este arquivo é, e o que deixou de ser
 *
 * Na versão anterior da spec o slug era a fonte primária de identidade. Não é
 * mais: a Gamma expõe `teams[]` em `/events`, com `abbreviation`, `name`, `id` e
 * `providerId`, e isso já está gravado em `events.event_metadata`. Onde esse
 * metadado existe, a identidade vem dele — exata, sem heurística.
 *
 * Sobram dois papéis, os dois necessários:
 *
 *   1. FALLBACK. `teams[]` só tem cobertura de 100% desde julho/2026, e re-fetch
 *      de evento antigo devolve HTTP 200 com `teams: []` — o histórico não será
 *      enriquecido por re-busca. Para ele, o slug é o único caminho de
 *      identidade que existe.
 *
 *   2. VALIDADOR. Onde os dois caminhos existem, eles têm que concordar:
 *      `events[0].slug` da Gamma bate com o `matchSlug` derivado aqui em 464/464
 *      medidos. Divergência não é empate a ser desfeito por preferência — é
 *      sinal de que uma das duas premissas quebrou, e vira `needs_review`.
 *
 * ## O que ele deliberadamente não faz
 *
 * Não determina o PAPEL do mercado. Isso é `events.sports_market_type`, que é
 * autoritativo e tem 30+ valores documentados pelo próprio Polymarket
 * (`moneyline`, `child_moneyline`, `map_handicap`, `round_over_under_game_2`,
 * `kill_over_under_game`, `first_blood_game`, `lol_penta_kill`, …). O
 * vocabulário de sufixo é aberto e cresce sem aviso — exemplos reais no banco:
 * `-game1`, `-total-games-2pt5`, `-map-handicap-away-1pt5`. Tentar enumerá-lo
 * seria manter um caminho paralelo, menos confiável, que divergiria em silêncio
 * do estruturado.
 *
 * Por isso `suffix` sai daqui CRU. Ele é guardado, não interpretado.
 */

export interface ParsedMarketSlug {
  verticalId: string;
  teamCodeA: string;
  teamCodeB: string;
  /** 'YYYY-MM-DD' */
  matchDate: string;
  /** '{jogo}-{codA}-{codB}-{data}' — a identidade da partida, chave de `esports_matches`. */
  matchSlug: string;
  /** Tudo depois da data. OPACO: nunca interpretado aqui. */
  suffix: string | null;
}

export interface VerticalSlugPrefix {
  verticalId: string;
  /** Com o hífen: 'cs2-'. */
  slugPrefix: string;
}

/**
 * A lista de hoje, igual ao seed da migration `20260806183705_esports_entities`.
 *
 * É piso, não teto: a tabela `verticals` é a autoridade, e o resolver deve
 * passar o que leu dela. O embutido existe porque o parser precisa funcionar
 * antes de a migration ser aplicada (ela é aplicada à mão, o deploy é
 * automático) e porque teste de parser não deve depender de banco.
 *
 * `enabled` NÃO aparece aqui de propósito. Parsear é identidade, não política:
 * um slug de `lol` continua sendo um slug de `lol` com a vertical desligada, e
 * quem decide se age sobre ele é o resolver. Filtrar aqui esconderia dado do
 * validador.
 */
export const DEFAULT_VERTICAL_PREFIXES: readonly VerticalSlugPrefix[] = [
  { verticalId: 'cs2', slugPrefix: 'cs2-' },
  { verticalId: 'lol', slugPrefix: 'lol-' },
  { verticalId: 'dota2', slugPrefix: 'dota2-' },
];

/**
 * Por que a recusa tem dois motivos, e não um `null` só.
 *
 * `not_esports` é o caso normal e mudo: `bitcoin-up-or-down-july-8` não é
 * assunto deste parser e não deve virar linha em fila nenhuma.
 *
 * `malformed` é slug que COMEÇA com prefixo conhecido e mesmo assim não
 * decompõe. Isso é anomalia: dos 464 markets medidos, 0 ficaram fora do padrão.
 * Tratar os dois como o mesmo `null` faria a anomalia desaparecer no mesmo
 * silêncio do bitcoin — e é exatamente ela que a spec manda mandar para revisão
 * em vez de adivinhar.
 */
export type SlugRejection = 'not_esports' | 'malformed';

export type SlugParse =
  | { ok: true; parsed: ParsedMarketSlug }
  | { ok: false; reason: SlugRejection };

const DATE_TOKENS = 3;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Data de calendário de verdade, não só três grupos de dígitos.
 *
 * `2026-02-30` casa com o regex e não existe. Aceitá-la significaria confirmar
 * uma decomposição que só pode estar desalinhada — o parser teria "achado" uma
 * data onde havia outra coisa. Recusar é a direção certa do erro: vira
 * `malformed`, e alguém olha.
 */
function isRealDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1) return false;
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return day <= daysInMonth;
}

/**
 * Decompõe pela esquerda e para na data.
 *
 * A ordem importa e é a da spec:
 *
 *   1. prefixo contra `verticals.slug_prefix`;
 *   2. os dois segmentos seguintes são os códigos dos times;
 *   3. os três seguintes têm que formar `YYYY-MM-DD`;
 *   4. `matchSlug` é tudo até a data, inclusive;
 *   5. o resto é `suffix`, cru.
 *
 * O passo 3 é o que ancora tudo: sem ele não há como saber onde o código do
 * time acaba, porque código pode começar com dígito (`9z`, `1win`) e conter
 * dígito no meio ou no fim (`ts7`, `fal2`, `ast10`, `big5`, `aur1`, `hle1`,
 * `mouzn`, `g1`, `imp11`). O que nenhum contém é `-` — e é só disso que a
 * decomposição por token precisa.
 *
 * Prefixo mais longo primeiro: se um dia existirem `cs2-` e `cs2-legacy-`, o
 * genérico venceria pela ordem de declaração e roubaria o específico.
 */
export function inspectMarketSlug(
  slug: string,
  verticals: readonly VerticalSlugPrefix[] = DEFAULT_VERTICAL_PREFIXES,
): SlugParse {
  // Slug do Polymarket é minúsculo. Normalizar aqui evita que uma variação de
  // caixa vire "não é esports" no passo 1 — e, pior, que o mesmo jogo produza
  // dois `match_slug` diferentes, que é chave de tabela.
  const normalized = slug.trim().toLowerCase();

  const candidates = [...verticals].sort((a, b) => b.slugPrefix.length - a.slugPrefix.length);
  const vertical = candidates.find(v => normalized.startsWith(v.slugPrefix));

  if (vertical === undefined) return { ok: false, reason: 'not_esports' };

  const tokens = normalized.slice(vertical.slugPrefix.length).split('-');

  // 2 códigos + 3 tokens de data. Menos que isso não tem onde a data caber.
  if (tokens.length < 2 + DATE_TOKENS) return { ok: false, reason: 'malformed' };

  const [teamCodeA, teamCodeB] = tokens as [string, string, ...string[]];
  // `cs2--g2-...` produz token vazio: é slug fora do padrão, não time sem nome.
  if (teamCodeA.length === 0 || teamCodeB.length === 0) return { ok: false, reason: 'malformed' };

  const matchDate = tokens.slice(2, 2 + DATE_TOKENS).join('-');
  if (!ISO_DATE_RE.test(matchDate)) return { ok: false, reason: 'malformed' };

  const [year, month, day] = matchDate.split('-').map(Number) as [number, number, number];
  if (!isRealDate(year, month, day)) return { ok: false, reason: 'malformed' };

  const head = tokens.slice(0, 2 + DATE_TOKENS).join('-');
  const tail = tokens.slice(2 + DATE_TOKENS).join('-');

  return {
    ok: true,
    parsed: {
      verticalId: vertical.verticalId,
      teamCodeA,
      teamCodeB,
      matchDate,
      matchSlug: `${vertical.slugPrefix}${head}`,
      // String vazia viraria sufixo "existente e vazio" no banco. `null` é o que
      // a spec pede para o market da série, que não tem sufixo nenhum.
      suffix: tail.length > 0 ? tail : null,
    },
  };
}

/**
 * A assinatura da spec. Use `inspectMarketSlug` quando o motivo da recusa
 * importar — no resolver ele importa, porque `malformed` é o que abastece a
 * fila de revisão e `not_esports` é para ignorar em silêncio.
 */
export function parseMarketSlug(
  slug: string,
  verticals: readonly VerticalSlugPrefix[] = DEFAULT_VERTICAL_PREFIXES,
): ParsedMarketSlug | null {
  const result = inspectMarketSlug(slug, verticals);
  return result.ok ? result.parsed : null;
}
