import type { GammaMarket, GammaEvent, Event, MarketCategory } from '../types/index.js';
import { categorizeMarket } from '../collectors/categorizer.js';

/**
 * O evento pai do market.
 *
 * Dois caminhos de coleta, um normalizador. Por `/events` o pai chega explícito
 * e completo (com `teams` e `sport`); por `/markets` só existe o embed
 * `events[0]`, que não tem nenhum dos dois. Preferir o explícito e cair no
 * embed mantém os dois funcionando sem duplicar a normalização.
 */
function parentOf(market: GammaMarket, parentEvent?: GammaEvent | null): GammaEvent | null {
  return parentEvent ?? market.events?.[0] ?? null;
}

/**
 * O horário real da partida (spec 000, item 7).
 *
 * Três campos medidos na Gamma em 2026-08-06, sobre 171 markets de esports:
 *
 *   gameStartTime        171/171, mas no formato '2026-08-06 18:30:00+00'
 *   eventStartTime       111/171 — só o market da série costuma trazer
 *   events[0].startTime  171/171, em ISO
 *
 * Daí a ordem: o campo com cobertura total primeiro, o ISO como rede.
 *
 * A normalização não é cosmética. `'2026-08-06 18:30:00+00'` não é ISO-8601, e
 * o que a spec do JS garante fora de ISO é nada — cada motor decide. O V8 parseia,
 * mas gravar assim deixaria o valor voltar do banco num formato e da API noutro,
 * com a comparação de faixa dependendo de qual dos dois chegou primeiro.
 *
 * `parentEvent` existe porque o market aninhado em `/events` não tem `events[]`:
 * sem ele a terceira rede desapareceria justamente no caminho novo de coleta.
 */
export function gammaGameStartTime(
  market: GammaMarket,
  parentEvent?: GammaEvent | null,
): string | null {
  const parent = parentOf(market, parentEvent);
  const raw = market.gameStartTime ?? market.eventStartTime ?? parent?.startTime ?? null;
  if (!raw) return null;

  let ms = Date.parse(raw);
  if (Number.isNaN(ms)) {
    // Reescreve o formato da Gamma em ISO e tenta de novo: ' ' -> 'T' e o
    // offset curto ('+00') completado para '+00:00'.
    ms = Date.parse(raw.replace(' ', 'T').replace(/([+-]\d{2})$/, '$1:00'));
  }

  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

/**
 * O conteúdo da coluna `event_metadata`.
 *
 * A versão anterior lia `market.eventMetadata`, campo que não existe: medido em
 * 2026-08-06, 0 de 464 markets de esports o trazem na raiz. A coluna (migration
 * 003) esteve NULL para todo mundo desde que foi criada. O dado real está no
 * evento — `league`, `leagueTier`, `serie`, `tournament`, `pandascoreMatchId`,
 * `gridSeriesId` e o bloco `context_*` que a própria Polymarket gera.
 *
 * `teams` e `sport` entram com prefixo `polymarket_` de propósito. O vocabulário
 * de `eventMetadata` é camelCase e aberto — cresceu três vezes entre março e
 * agosto de 2026. Espalhar as duas chaves cruas deixaria uma colisão silenciosa
 * armada para o dia em que a Gamma publicar um `teams` próprio, e o perdedor
 * sumiria sem erro nenhum. Prefixo snake_case não colide com o que vem de lá.
 *
 * `polymarket_event_id` entra porque o id do evento não tem coluna própria e é
 * a chave para re-buscar o evento inteiro. `gameId` fica de fora: é o mesmo
 * número de `pandascoreMatchId` (medido, 464/464).
 *
 * `score`/`live`/`ended` também ficam de fora, e não por esquecimento: são
 * estado ao vivo, e esta coluna é sobrescrita a cada ciclo. Guardar série
 * temporal aqui seria guardar só o último valor. Se virar necessário, o destino
 * é uma tabela de série, não esta coluna.
 *
 * **Invariante:** quem escreve esta coluna precisa estar lendo de `/events`.
 * Um caminho que só enxergue o embed de `/markets` grava sem `polymarket_teams`
 * e apaga, no upsert, o que a descoberta escreveu. Por isso a varredura por
 * volume remove a chave do payload em vez de mandá-la incompleta.
 */
export function gammaEventMetadata(parent: GammaEvent | null): Record<string, unknown> | null {
  if (!parent) return null;

  const meta = parent.eventMetadata ?? null;
  const teams = parent.teams && parent.teams.length > 0 ? parent.teams : null;
  const sport = parent.sport ?? null;

  if (!meta && !teams && !sport) return null;

  const out: Record<string, unknown> = { ...(meta ?? {}) };
  if (teams) out['polymarket_teams'] = teams;
  if (sport) out['polymarket_sport'] = sport;
  out['polymarket_event_id'] = parent.id;
  return out;
}

export function gammaToEvent(
  market: GammaMarket,
  category: MarketCategory = 'other',
  parentEvent?: GammaEvent | null,
): Omit<Event, 'id' | 'created_at' | 'updated_at'> {
  const outcomeValues: string[] = JSON.parse(market.outcomes);
  const outcomePriceValues: string[] = JSON.parse(market.outcomePrices);
  const parent = parentOf(market, parentEvent);

  // feeType is the canonical Polymarket category (e.g. "politics_fees", "sports_fees_v2")
  const polymarketCategory = market.feeType ?? null;
  // feeSchedule.rate is the authoritative fee rate from the API
  const polymarketFeeRate = market.feeSchedule?.rate ?? null;

  // Internal categorizer becomes a flag only — true if market is AI/Tech-related
  const { category: internalCategory } = categorizeMarket(market);
  const isAiTech = internalCategory !== 'other';

  return {
    polymarket_id: market.id,
    slug: market.slug,
    title: market.question,
    category,
    sub_category: null,
    polymarket_category: polymarketCategory,
    polymarket_fee_rate: polymarketFeeRate,
    is_ai_tech: isAiTech,
    description: market.description,
    outcomes: { values: outcomeValues, prices: outcomePriceValues },
    volume_total: Number(market.volumeNum ?? market.volume ?? 0),
    volume_24h: Number(market.volume24hr ?? market.volume24hrClob ?? 0),
    liquidity: Number(market.liquidityNum ?? market.liquidity ?? 0),
    end_date: market.endDate,
    game_start_time: gammaGameStartTime(market, parent),
    status: market.closed ? 'resolved' : market.active ? 'active' : 'inactive',
    resolved_outcome: null,
    tracked: true,
    neg_risk_market_id: market.negRiskMarketID ?? null,
    // O market de esports vem sem `series` em `/markets` — medido, e é por isso
    // que estas três colunas estão NULL para esports desde sempre. O evento pai
    // tem a série (99/100), então coletar por `/events` passa a preenchê-las.
    series_id: market.series?.[0]?.id ?? parent?.series?.[0]?.id ?? null,
    series_slug: market.series?.[0]?.slug ?? parent?.series?.[0]?.slug ?? null,
    series_recurrence: market.series?.[0]?.recurrence ?? parent?.series?.[0]?.recurrence ?? null,
    event_group_slug: parent?.slug ?? null,
    event_metadata: gammaEventMetadata(parent),
    sports_market_type: market.sportsMarketType ?? null,
    line: market.line ?? null,
  };
}
