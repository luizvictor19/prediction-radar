/**
 * Papel do mercado derivado do sufixo do slug (spec 001, Parte B).
 *
 * ## Quando isto vale, e só quando
 *
 * A fonte autoritativa é `events.sports_market_type`. Este módulo só entra onde
 * essa coluna é NULL: medido no dry-run de 2026-08-06, **14.506 eventos** —
 * praticamente todo o histórico anterior à coleta do campo.
 *
 * ## Duas fontes, nesta ordem, e nenhuma delas inventa vocabulário
 *
 *   1. MAPA ESTÁTICO. Famílias de sufixo cuja leitura é direta e cujo destino é
 *      um valor que o Polymarket usa (`round_over_under_game_2` etc.).
 *
 *   2. MAPA APRENDIDO. Para o resto, a resposta já está no banco: o MESMO
 *      formato de sufixo aparece em eventos recentes, onde `sports_market_type`
 *      está preenchido. Aprender daí é medir o vocabulário do provedor em vez de
 *      adivinhá-lo — foi assim que `gameN-odd-even-total-rounds` e
 *      `gameN-odd-even-total-kills` (2.523 markets) deixaram de precisar de um
 *      rótulo inventado por nós.
 *
 * O que nenhuma das duas cobre vira `UNKNOWN_ROLE`, que é obviamente
 * não-Polymarket, e vira linha no relatório de famílias — não pendência de
 * revisão. Sufixo desconhecido é pergunta sobre a FAMÍLIA, não sobre a linha:
 * uma regra nova resolve mil markets de uma vez, e mil confirmações no Telegram
 * não resolvem nenhuma.
 *
 * ## Por que a confiança continua baixa mesmo assim
 *
 * O vocabulário de sufixo é aberto e cresce sem aviso. A spec fixa o teto em 0.7
 * para qualquer papel inferido, e ele vale também para o aprendido: analogia
 * medida é melhor que palpite, mas não é a coluna.
 */

/** Teto da spec para qualquer papel inferido de sufixo. */
export const MAX_GUESS_CONFIDENCE = 0.7;

/**
 * O que se grava quando nem a coluna, nem o mapa estático, nem o aprendido
 * sabem. Não é um valor do Polymarket de propósito.
 */
export const UNKNOWN_ROLE = 'unknown';

export interface GuessedRole {
  role: string;
  confidence: number;
}

// ---------------------------------------------------------------------------
// Normalização de sufixo
// ---------------------------------------------------------------------------

/**
 * Substitui os códigos dos times do próprio slug por `{code}`.
 *
 * Sem isto, `game1-round-handicap-navi-5pt5` e `game1-round-handicap-vit-5pt5`
 * seriam famílias distintas — e foi exatamente o que aconteceu na primeira
 * medição: 36 entradas separadas que são uma regra só. Não é heurística: os
 * códigos vêm do mesmo slug, já decompostos pelo parser.
 */
function maskCodes(suffix: string, codes: readonly string[]): string {
  if (codes.length === 0) return suffix;

  const wanted = new Set(codes.filter(c => c.length > 0));
  return suffix
    .split('-')
    .map(segment => (wanted.has(segment) ? '{code}' : segment))
    .join('-');
}

/**
 * A FAMÍLIA do sufixo — para relatório. Todo número vira marcador:
 *
 *   game2-round-total-24pt5            →  gameN-round-total-X
 *   game1-round-handicap-navi-5pt5     →  gameN-round-handicap-{code}-X
 *
 * Agrupa o máximo, de propósito: a pergunta que ela responde é "quantas regras
 * faltam", não "quais markets".
 */
export function suffixFamily(suffix: string | null, codes: readonly string[] = []): string {
  if (suffix === null || suffix.trim().length === 0) return '(sem sufixo)';

  return maskCodes(suffix.trim().toLowerCase(), codes)
    .replace(/\d+pt\d+/g, 'X')
    .replace(/\d+/g, 'N');
}

/**
 * A CHAVE DE APRENDIZADO — para o mapa aprendido. Igual à família, exceto que o
 * número do game é preservado:
 *
 *   game2-round-total-24pt5  →  game2-round-total-X
 *
 * A diferença é o ponto todo: o papel do Polymarket carrega o número
 * (`round_over_under_game_2`), então colapsá-lo faria a família inteira
 * aparecer com dois papéis distintos e ser descartada por ambiguidade.
 */
export function roleLearnKey(suffix: string | null, codes: readonly string[] = []): string {
  if (suffix === null || suffix.trim().length === 0) return '(sem sufixo)';

  return maskCodes(suffix.trim().toLowerCase(), codes).replace(/\d+pt\d+/g, 'X');
}

// ---------------------------------------------------------------------------
// Mapa estático
// ---------------------------------------------------------------------------

/**
 * Sufixo composto: `game{N}-` na frente e o resto atrás.
 *
 * A versão anterior deste mapa ancorava `^game(\d+)$` nas duas pontas e por isso
 * enxergava só o moneyline de game. Todo mercado derivado POR GAME —
 * `game2-round-total-24pt5` e companhia — caía fora, e eram 10.789 markets, três
 * quartos de tudo que precisava de papel. O defeito não era falta de regra, era
 * a forma do mapa.
 */
const GAME_PREFIX = /^game(\d+)(?:-(.*))?$/;

interface Rule {
  test: RegExp;
  /** `null` = a regra precisa do número do game e ele não veio. Não inventar. */
  role: (m: RegExpMatchArray, game: number | null) => string | null;
  confidence: number;
}

const RULES: Rule[] = [
  // Formas por game, medidas no dry-run de 2026-08-06.
  { test: /^round-total\b/, role: (_, g) => (g === null ? null : `round_over_under_game_${g}`), confidence: 0.6 },
  { test: /^round-handicap\b/, role: (_, g) => (g === null ? null : `round_handicap_game_${g}`), confidence: 0.6 },

  // Formas que já trazem o número no próprio sufixo.
  { test: /^round-over-under-game-(\d+)\b/, role: m => `round_over_under_game_${m[1]}`, confidence: 0.5 },
  { test: /^round-handicap-game-(\d+)\b/, role: m => `round_handicap_game_${m[1]}`, confidence: 0.5 },

  // Formas de série (valem com ou sem prefixo de game).
  { test: /^total-games?\b/, role: () => 'totals', confidence: 0.6 },
  { test: /^map-handicap\b/, role: () => 'map_handicap', confidence: 0.6 },
  { test: /^handicap\b/, role: () => 'map_handicap', confidence: 0.5 },
  { test: /^kill-over-under\b/, role: () => 'kill_over_under_game', confidence: 0.5 },
  { test: /^first-blood\b/, role: () => 'first_blood_game', confidence: 0.5 },
];

/**
 * O papel provável a partir do sufixo, pelo mapa estático.
 *
 * Sufixo ausente é o market da SÉRIE — a inferência mais forte que existe aqui,
 * e mesmo assim entra a 0.7.
 */
export function guessMarketRole(suffix: string | null): GuessedRole | null {
  if (suffix === null || suffix.trim().length === 0) {
    return { role: 'moneyline', confidence: MAX_GUESS_CONFIDENCE };
  }

  const normalized = suffix.trim().toLowerCase();

  const gameMatch = normalized.match(GAME_PREFIX);
  const game = gameMatch?.[1] !== undefined ? Number(gameMatch[1]) : null;
  const rest = gameMatch ? (gameMatch[2] ?? '') : normalized;

  // `game3` sozinho é a moneyline daquele game.
  if (game !== null && rest.length === 0) {
    return { role: 'child_moneyline', confidence: MAX_GUESS_CONFIDENCE };
  }

  for (const rule of RULES) {
    const match = rest.match(rule.test);
    if (!match) continue;

    const role = rule.role(match, game);
    if (role !== null) return { role, confidence: rule.confidence };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Mapa aprendido
// ---------------------------------------------------------------------------

/** `roleLearnKey` → `sports_market_type` observado. */
export type LearnedRoles = Record<string, string>;

export interface RoleObservation {
  learnKey: string;
  role: string;
}

/**
 * Aprende o papel de cada forma de sufixo a partir dos eventos que TÊM a coluna.
 *
 * Duas guardas, e as duas existem para o mapa nunca virar palpite com cara de
 * medição:
 *
 *   `minCount`  — uma observação isolada pode ser um market atípico. Abaixo do
 *                 piso, a forma não é aprendida.
 *   `minPurity` — se a mesma forma de sufixo aparece com dois papéis, ela não
 *                 determina papel. Não se escolhe o mais comum: descarta-se.
 *                 Ambiguidade medida é motivo para NÃO gravar, não para chutar.
 */
export function learnRoles(
  observations: readonly RoleObservation[],
  opts: { minCount?: number; minPurity?: number } = {},
): LearnedRoles {
  const minCount = opts.minCount ?? 5;
  const minPurity = opts.minPurity ?? 0.9;

  const byKey = new Map<string, Map<string, number>>();
  for (const obs of observations) {
    const roles = byKey.get(obs.learnKey) ?? new Map<string, number>();
    roles.set(obs.role, (roles.get(obs.role) ?? 0) + 1);
    byKey.set(obs.learnKey, roles);
  }

  const learned: LearnedRoles = {};

  for (const [key, roles] of byKey) {
    let total = 0;
    let bestRole: string | null = null;
    let bestCount = 0;

    for (const [role, count] of roles) {
      total += count;
      if (count > bestCount) {
        bestCount = count;
        bestRole = role;
      }
    }

    if (bestRole === null || total < minCount) continue;
    if (bestCount / total < minPurity) continue;

    learned[key] = bestRole;
  }

  return learned;
}

/** O papel aprendido para esta forma de sufixo, se houver. */
export function learnedMarketRole(
  learnKey: string,
  learned: LearnedRoles | undefined,
): GuessedRole | null {
  const role = learned?.[learnKey];
  return role === undefined ? null : { role, confidence: MAX_GUESS_CONFIDENCE };
}
