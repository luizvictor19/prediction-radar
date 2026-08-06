import { supabase } from '../../lib/supabase.js';
import { lastFragmentAsOf } from '../enricher.js';
import type { ContextFragment, Enricher, EnricherContext } from '../enricher.js';

/**
 * `polymarket-context` — o parágrafo que a própria Polymarket gera por partida
 * (spec 001, item 5 / Parte D).
 *
 * Traz roster, head-to-head, forma recente e contexto de grupo, com cobertura
 * medida de 98%, e o custo de integração é zero: o texto já está em
 * `events.event_metadata`, gravado pela descoberta desde 2026-08-06.
 *
 * ## A ressalva é a parte importante
 *
 * É texto gerado por LLM da Polymarket, sem garantia de fidelidade e sem fonte
 * citada. As regras da spec estão implementadas aqui e não só documentadas:
 *
 *   - entra com `confidence <= 0.4`;
 *   - **nunca é fonte factual única** — um número que só aparece aqui não vira
 *     input de decisão sem corroboração. O aviso viaja dentro do `summary`, e
 *     não só no campo `confidence`, porque um consumidor que concatene summaries
 *     num prompt perde o campo e fica só com o texto;
 *   - serve como baseline para comparar contra enricher de fonte primária (GRID,
 *     Liquipedia) quando existirem.
 *
 * ## Por que `supportsPointInTime = true` é honesto aqui
 *
 * Não é por `context_updated_at` existir. `events.event_metadata` é
 * SOBRESCRITO a cada ciclo de coleta — ler a coluna hoje devolve o texto atual,
 * não o que existia num T do passado. O que torna a flag verdadeira é a recusa
 * lá embaixo: quando `context_updated_at` é posterior a `asOf`, o enricher não
 * produz nada. Sem essa recusa, um replay receberia um parágrafo escrito depois
 * do instante que ele diz representar — exatamente o vazamento que a flag existe
 * para impedir.
 *
 * A consequência é assumida: num replay para um T antigo, a versão do texto que
 * existia naquele T já foi sobrescrita e não volta. O enricher devolve vazio em
 * vez de devolver a versão errada. Quem preenche esse buraco é a execução
 * contínua em produção — cada rodada grava a versão corrente, e é dela que o
 * replay lê depois, por `observed_at`.
 */

export const POLYMARKET_CONTEXT_ID = 'polymarket-context';

const POLYMARKET_CONTEXT_VERTICALS = ['cs2', 'lol', 'dota2'];

/** Teto da spec para texto gerado por LLM de terceiro, sem fonte citada. */
export const CONTEXT_CONFIDENCE_DATED = 0.4;

/**
 * Sem `context_updated_at` não dá para saber quando o texto foi escrito, só que
 * ele existe agora. A afirmação continua verdadeira, mas é mais fraca — e o
 * fragmento fica inelegível para qualquer replay que não seja o presente.
 */
export const CONTEXT_CONFIDENCE_UNDATED = 0.25;

/** Teto do `summary`. O texto inteiro vai no payload; aqui cabe a abertura. */
export const SUMMARY_MAX_CHARS = 400;

// ---------------------------------------------------------------------------
// Leitura do bloco, pura
// ---------------------------------------------------------------------------

export interface PolymarketContextBlock {
  description: string;
  /** Carimbo da PRÓPRIA Polymarket, não nosso. É o que data o texto. */
  updatedAt: string | null;
  /** A Polymarket marcando o próprio texto como desatualizado. */
  requiresRegen: boolean | null;
}

function readString(source: Record<string, unknown>, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  }
  return null;
}

function readBoolean(source: Record<string, unknown>, ...keys: string[]): boolean | null {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'boolean') return value;
    if (value === 'true') return true;
    if (value === 'false') return false;
  }
  return null;
}

/**
 * O bloco `context_*` de `event_metadata`, ou `null` se não houver texto.
 *
 * Aceita snake_case e camelCase. Não é zelo gratuito: o bloco `context_*` é o
 * único snake_case no meio de um `eventMetadata` camelCase (`league`,
 * `leagueTier`, `pandascoreMatchId`), o que sugere produtor diferente do resto —
 * e o vocabulário desse payload já mudou três vezes entre março e agosto de 2026.
 * Ler as duas formas custa uma linha e evita que o enricher morra em silêncio no
 * dia em que a chave for renomeada.
 */
export function readContextBlock(
  metadata: Record<string, unknown> | null,
): PolymarketContextBlock | null {
  if (metadata === null) return null;

  const description = readString(metadata, 'context_description', 'contextDescription');
  if (description === null) return null;

  return {
    description,
    updatedAt: readString(metadata, 'context_updated_at', 'contextUpdatedAt'),
    requiresRegen: readBoolean(metadata, 'context_requires_regen', 'contextRequiresRegen'),
  };
}

// ---------------------------------------------------------------------------
// A guarda de point-in-time
// ---------------------------------------------------------------------------

export type ContextAsOfSource = 'source' | 'observation';

export type ContextAsOf =
  | { kind: ContextAsOfSource; asOf: Date }
  | { kind: 'refuse'; reason: string };

/**
 * Qual `as_of` este texto pode legitimamente reivindicar — ou por que nenhum.
 *
 *   `source`      — o texto é datado e o carimbo é anterior a `asOf`. É o caso
 *                   normal, e o `as_of` do fragmento é o carimbo da fonte.
 *   `observation` — o texto não é datado, mas `asOf` é o presente. "Este texto
 *                   existe agora" é afirmação verdadeira e datável pelo próprio
 *                   instante da observação. Confiança menor, porque não dá para
 *                   dizer se ele tem uma hora ou três semanas.
 *   `refuse`      — os dois casos em que qualquer `as_of` seria invenção: texto
 *                   mais novo que o instante perguntado (vazamento direto), e
 *                   texto sem data num replay do passado.
 */
export function contextAsOf(
  block: PolymarketContextBlock,
  asOf: Date,
  now: Date,
  toleranceMs: number,
): ContextAsOf {
  if (block.updatedAt !== null) {
    const updated = new Date(block.updatedAt);
    if (!Number.isFinite(updated.getTime())) {
      return { kind: 'refuse', reason: `context_updated_at ilegível: ${block.updatedAt}` };
    }
    if (updated.getTime() > asOf.getTime() + toleranceMs) {
      return {
        kind: 'refuse',
        reason: `texto escrito em ${block.updatedAt}, depois do asOf pedido`,
      };
    }
    return { kind: 'source', asOf: updated };
  }

  if (Math.abs(asOf.getTime() - now.getTime()) > toleranceMs) {
    return { kind: 'refuse', reason: 'texto sem context_updated_at não serve a replay' };
  }

  return { kind: 'observation', asOf };
}

/**
 * Regravar este texto acrescenta alguma coisa?
 *
 * Com carimbo da fonte, a pergunta tem resposta exata: carimbo igual = texto
 * igual, e uma segunda linha idêntica de 1-2 KB não diz nada que a primeira já
 * não diga (o par `as_of`/`observed_at` da linha antiga já registra a idade dela
 * em qualquer T posterior). Sem carimbo, não há como comparar sem reler o texto
 * gravado, e aí o TTL do enricher é o critério — é para isso que ele existe.
 */
export function shouldSkipRewrite(
  lastAsOf: Date | null,
  candidate: Date,
  source: ContextAsOfSource,
  ttlSeconds: number,
): boolean {
  if (lastAsOf === null) return false;

  if (source === 'source') return lastAsOf.getTime() === candidate.getTime();

  return candidate.getTime() - lastAsOf.getTime() < ttlSeconds * 1000;
}

// ---------------------------------------------------------------------------
// O fragmento
// ---------------------------------------------------------------------------

/**
 * A abertura do texto, cortada em fronteira de frase quando dá.
 *
 * O `summary` é o que o LLM lê; o parágrafo inteiro fica no payload. Cortar no
 * meio de uma palavra produziria um trecho que parece truncado por erro — cortar
 * no fim de uma frase produz um resumo.
 */
export function firstSentences(text: string, maxChars = SUMMARY_MAX_CHARS): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length <= maxChars) return clean;

  const cut = clean.slice(0, maxChars);
  const sentenceEnd = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
  if (sentenceEnd > maxChars / 2) return cut.slice(0, sentenceEnd + 1);

  const space = cut.lastIndexOf(' ');
  return `${(space > 0 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

export interface ContextFragmentInput {
  eventId: string;
  slug: string | null;
  block: PolymarketContextBlock;
  asOf: Date;
  asOfSource: ContextAsOfSource;
}

export function buildContextFragment(input: ContextFragmentInput): ContextFragment {
  const { block } = input;

  return {
    enricherId: POLYMARKET_CONTEXT_ID,
    kind: 'news',
    asOf: input.asOf,
    payload: {
      event_id: input.eventId,
      slug: input.slug,
      description: block.description,
      context_updated_at: block.updatedAt,
      // Gravado, e deliberadamente NÃO usado para rebaixar `confidence`. A spec
      // quer medir depois se texto marcado como stale tem qualidade pior;
      // precificá-lo agora responderia a pergunta com a suposição em vez de com
      // o dado, e o eval nunca poderia contradizê-la.
      context_requires_regen: block.requiresRegen,
      as_of_source: input.asOfSource,
      length_chars: block.description.length,
    },
    // O aviso vai no texto, não só na confiança: um consumidor que junte
    // summaries num prompt perde os campos e fica com as frases.
    summary:
      `Contexto da Polymarket (texto gerado por LLM, sem fonte citada — não usar como fato isolado): ` +
      firstSentences(block.description),
    confidence:
      input.asOfSource === 'source' ? CONTEXT_CONFIDENCE_DATED : CONTEXT_CONFIDENCE_UNDATED,
  };
}

// ---------------------------------------------------------------------------
// Leitura
// ---------------------------------------------------------------------------

const COMPONENT = POLYMARKET_CONTEXT_ID;

/**
 * Tolerância de relógio, igual à do runner.
 *
 * Redeclarada em vez de importada porque aqui ela responde a outra pergunta — se
 * o carimbo da Polymarket cabe dentro do `asOf` — e amarrá-la à do runner faria
 * um ajuste de agendamento mexer, sem querer, no critério de vazamento.
 */
const CLOCK_TOLERANCE_MS = 5 * 60_000;

interface CandidateEvent {
  eventId: string;
  slug: string | null;
  role: string;
  block: PolymarketContextBlock;
}

async function loadCandidates(matchId: string): Promise<CandidateEvent[]> {
  const { data: links, error: linkError } = await supabase
    .from('market_match_links')
    .select('event_id, market_role')
    .eq('match_id', matchId);

  if (linkError) {
    console.warn(`[${COMPONENT}] leitura de market_match_links falhou: ${linkError.message}`);
    return [];
  }

  const rows = links ?? [];
  if (rows.length === 0) return [];

  const { data: events, error: eventError } = await supabase
    .from('events')
    .select('id, slug, event_metadata')
    .in(
      'id',
      rows.map(r => r['event_id'] as string),
    );

  if (eventError) {
    console.warn(`[${COMPONENT}] leitura de events falhou: ${eventError.message}`);
    return [];
  }

  const roleById = new Map(
    rows.map(r => [r['event_id'] as string, (r['market_role'] as string | null) ?? ''] as const),
  );

  const candidates: CandidateEvent[] = [];
  for (const event of events ?? []) {
    const block = readContextBlock(
      (event['event_metadata'] as Record<string, unknown> | null) ?? null,
    );
    if (block === null) continue;

    const eventId = event['id'] as string;
    candidates.push({
      eventId,
      slug: (event['slug'] as string | null) ?? null,
      role: roleById.get(eventId) ?? '',
      block,
    });
  }

  return candidates;
}

async function fetchPolymarketContext(ctx: EnricherContext): Promise<ContextFragment[]> {
  const candidates = await loadCandidates(ctx.matchId);
  if (candidates.length === 0) return [];

  // O bloco `context_*` é do EVENTO da Gamma, então todos os markets da partida
  // carregam o mesmo texto. Preferir o moneyline é só escolher a linha mais
  // estável para citar como origem — não muda o conteúdo.
  const chosen = candidates.find(c => c.role === 'moneyline') ?? (candidates[0] as CandidateEvent);

  const now = new Date();
  const dating = contextAsOf(chosen.block, ctx.asOf, now, CLOCK_TOLERANCE_MS);

  if (dating.kind === 'refuse') {
    console.warn(`[${COMPONENT}] ${ctx.matchId} sem fragmento: ${dating.reason}`);
    return [];
  }

  const lastAsOf = await lastFragmentAsOf(ctx.matchId, POLYMARKET_CONTEXT_ID);
  if (shouldSkipRewrite(lastAsOf, dating.asOf, dating.kind, polymarketContextEnricher.ttlSeconds)) {
    return [];
  }

  return [
    buildContextFragment({
      eventId: chosen.eventId,
      slug: chosen.slug,
      block: chosen.block,
      asOf: dating.asOf,
      asOfSource: dating.kind,
    }),
  ];
}

export const polymarketContextEnricher: Enricher = {
  id: POLYMARKET_CONTEXT_ID,
  verticals: POLYMARKET_CONTEXT_VERTICALS,
  /**
   * Uma hora. O texto muda em escala de horas ou dias, não de minutos, e o
   * `shouldSkipRewrite` já evita a regravação idêntica quando há carimbo — o TTL
   * é o critério do caso sem carimbo.
   */
  ttlSeconds: 3_600,
  supportsPointInTime: true,
  fetch: fetchPolymarketContext,
};
