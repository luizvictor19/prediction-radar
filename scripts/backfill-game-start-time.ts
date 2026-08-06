import 'dotenv/config';
import { supabase } from '../src/lib/supabase.js';
import { fetchMarketsByIds, MAX_IDS_PER_REQUEST } from '../src/lib/polymarket-api.js';
import { gammaGameStartTime } from '../src/lib/normalize.js';
import { getSystemConfig } from '../src/lib/config.js';
import { safeSlugPrefixes, slugPrefixFilter } from '../src/lib/slug-prefixes.js';

/**
 * Preenche `events.game_start_time` nas linhas que já estavam no banco quando a
 * migration 20260806015533 foi aplicada (spec 000, item 7).
 *
 * Por que um script e não o coletor: os collectors carimbam no upsert, mas
 * nenhum deles reescreve um market que já foi descoberto e ainda não resolveu —
 * a descoberta só volta ao que apareceu na janela de lookback. Sem este passo, o
 * roster inteiro que existia no dia do apply fica com a âncora nula, ou seja, na
 * faixa lenta até resolver. Os markets novos não passam por isso.
 *
 * Roda uma vez, depois do apply. É idempotente (só toca em quem está NULL), e o
 * `null_game_start_time` no log do watchlist_collector é como se confere o
 * resultado.
 *
 * Escopo: só o que a watchlist enxerga — esports ativo. Backfillar `events`
 * inteira seriam 700 MB de UPDATE por um valor que só existe para partida.
 */

const RATE_LIMIT_MS = 200;

interface EventRow {
  id: string;
  polymarket_id: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  const config = await getSystemConfig();
  const prefixes = safeSlugPrefixes(config.discovery_slug_prefixes ?? [], 'backfill-game-start');

  if (prefixes.length === 0) {
    console.error('[backfill-game-start] discovery_slug_prefixes vazio — nada a fazer');
    process.exit(1);
  }

  const { data, error } = await supabase
    .from('events')
    .select('id, polymarket_id')
    .eq('status', 'active')
    .is('game_start_time', null)
    .or(slugPrefixFilter(prefixes));

  if (error) {
    console.error(`[backfill-game-start] leitura falhou: ${error.message}`);
    process.exit(1);
  }

  const rows = (data ?? []) as EventRow[];
  console.log(`[backfill-game-start] ${rows.length} markets de esports ativos sem âncora`);

  const eventIdByPolymarketId = new Map(rows.map(row => [row.polymarket_id, row.id]));
  const ids = [...eventIdByPolymarketId.keys()];

  let updated = 0;
  let noAnchor = 0;
  let absent = 0;
  let errors = 0;

  for (let i = 0; i < ids.length; i += MAX_IDS_PER_REQUEST) {
    const chunk = ids.slice(i, i + MAX_IDS_PER_REQUEST);

    let markets;
    try {
      // Mesma armadilha do item 2b: o filtro `id=` aplica `closed=false`. Aqui
      // isso é o que se quer — market resolvido não precisa mais de cadência.
      markets = await fetchMarketsByIds(chunk, { closed: false });
    } catch (err) {
      errors += chunk.length;
      console.error(`[backfill-game-start] lote ${i}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }

    absent += chunk.length - markets.length;

    for (const market of markets) {
      const eventId = eventIdByPolymarketId.get(market.id);
      if (!eventId) continue;

      const gameStartTime = gammaGameStartTime(market);
      if (gameStartTime === null) {
        noAnchor++;
        continue;
      }

      const { error: updateError } = await supabase
        .from('events')
        .update({ game_start_time: gameStartTime })
        .eq('id', eventId);

      if (updateError) {
        errors++;
        console.error(`[backfill-game-start] update ${eventId}: ${updateError.message}`);
      } else {
        updated++;
      }
    }

    console.log(
      `[backfill-game-start] ${Math.min(i + chunk.length, ids.length)}/${ids.length} — ` +
        `updated=${updated} sem_ancora=${noAnchor} ausentes=${absent} erros=${errors}`,
    );

    await sleep(RATE_LIMIT_MS);
  }

  // `ausentes` são markets que sumiram do lote `closed=false`: resolveram e o
  // resolved-detector ainda não passou. Não é falha do backfill.
  console.log(
    `[backfill-game-start] Fim. total=${ids.length} updated=${updated} ` +
      `sem_ancora=${noAnchor} ausentes=${absent} erros=${errors}`,
  );
}

main().catch(err => {
  console.error('[backfill-game-start] Fatal:', err);
  process.exit(1);
});
