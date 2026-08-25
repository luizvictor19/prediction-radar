import 'dotenv/config';
import { supabase } from '../../src/lib/supabase.js';

/**
 * Whether `events.slug` can address a Polymarket page under `/event/<slug>`.
 *
 *   npx tsx scripts/medicoes/url-polymarket.ts
 *
 * READ ONLY. No INSERT, UPDATE, DELETE or DDL, no paid API call.
 *
 * It exists because the "Polymarket" link on the Regra screen opens "Page not
 * found", and the screen builds it as `/event/<events.slug>` while `src/bot`
 * builds `/event/<events.event_group_slug>` with `/market/<events.slug>` as the
 * fallback. Which of the two is right is not a matter of reading the column
 * name -- it is a matter of asking the API what each slug addresses.
 *
 * ## Cost in the database (read before running)
 *
 * `events` is the big table (~551k rows, 711 MB) and the PostgREST timeout is
 * 8s. The only filter is `radar_tracked`, which has the partial index
 * `idx_events_radar_tracked` (20260813210119_retencao_protege_radar.sql:64), so
 * the scanned set is the roster (~1k rows), not the table. No LIKE, no
 * unindexed column in the where.
 *
 * `.order('id')` is not cosmetic: without a total order, PostgREST's OFFSET
 * repeats and skips rows silently across pages.
 *
 * ## Two cuts of `status`, on purpose
 *
 * `v_radar` filters `radar_tracked and status = 'active'`, and "the 1,023
 * markets of the roster" may have been counted under either cut. Both are
 * printed so a mismatch between them is found BEFORE the numbers get compared,
 * not after.
 */

const PAGINA = 1000;
const TETO_INESPERADO = 20_000;
const GAMMA = 'https://gamma-api.polymarket.com';
const AMOSTRA_DIVERGENTES = Number(process.env['AMOSTRA_DIVERGENTES'] ?? 10);
const AMOSTRA_IGUAIS = Number(process.env['AMOSTRA_IGUAIS'] ?? 5);

interface Linha {
  id: string;
  slug: string | null;
  event_group_slug: string | null;
  status: string | null;
}

async function lerRoster(): Promise<Linha[]> {
  const linhas: Linha[] = [];

  for (let offset = 0; ; offset += PAGINA) {
    if (offset > TETO_INESPERADO) {
      throw new Error(
        `roster passou de ${TETO_INESPERADO} linhas — parando em vez de varrer events`,
      );
    }

    const { data, error } = await supabase
      .from('events')
      .select('id, slug, event_group_slug, status')
      .eq('radar_tracked', true)
      .order('id')
      .range(offset, offset + PAGINA - 1);

    if (error) throw new Error(`leitura de events falhou: ${error.message}`);
    if (!data || data.length === 0) break;

    linhas.push(...(data as unknown as Linha[]));
    if (data.length < PAGINA) break;
  }

  return linhas;
}

interface Contagem {
  total: number;
  comSlug: number;
  comGrupo: number;
  ambos: number;
  iguais: number;
  divergentes: number;
  semNenhum: number;
}

function contar(linhas: readonly Linha[]): Contagem {
  const ambos = linhas.filter(l => l.slug !== null && l.event_group_slug !== null);
  return {
    total: linhas.length,
    comSlug: linhas.filter(l => l.slug !== null).length,
    comGrupo: linhas.filter(l => l.event_group_slug !== null).length,
    ambos: ambos.length,
    iguais: ambos.filter(l => l.slug === l.event_group_slug).length,
    divergentes: ambos.filter(l => l.slug !== l.event_group_slug).length,
    semNenhum: linhas.filter(l => l.slug === null && l.event_group_slug === null).length,
  };
}

function imprimir(rotulo: string, c: Contagem): void {
  console.log(`\n## ${rotulo}`);
  console.log(`  roster                     ${c.total}`);
  console.log(`  com slug                   ${c.comSlug}`);
  console.log(`  com event_group_slug       ${c.comGrupo}`);
  console.log(`  ambos preenchidos          ${c.ambos}`);
  console.log(`    iguais                   ${c.iguais}`);
  console.log(`    divergentes              ${c.divergentes}`);
  console.log(`  sem nenhum dos dois        ${c.semNenhum}`);
}

/**
 * What the Gamma API says a slug IS.
 *
 * The column name proves nothing; this asks the source. `/events?slug=` answers
 * only for an event slug and `/markets?slug=` only for a market slug. A slug
 * that answers on both is a single-market event -- exactly the case where
 * guessing happens to work, which is why it has to be counted separately.
 */
async function tipoNaGamma(slug: string): Promise<{ evento: boolean; mercado: boolean }> {
  const existe = async (rota: string): Promise<boolean> => {
    const resposta = await fetch(`${GAMMA}/${rota}?slug=${encodeURIComponent(slug)}`);
    if (!resposta.ok) return false;
    const corpo: unknown = await resposta.json();
    return Array.isArray(corpo) && corpo.length > 0;
  };

  const [evento, mercado] = await Promise.all([existe('events'), existe('markets')]);
  return { evento, mercado };
}

/**
 * What the API itself reports for a market slug: its parent event, and its own
 * question.
 *
 * The question is what makes it possible to tell a URL that OPENS from a URL
 * that opens THE RIGHT THING. `/event/<grupo>` answers 200 for every one of the
 * 956 divergent markets, and lands on a multi-outcome event listing twenty
 * other markets -- opening is not the same as arriving.
 */
async function mercadoNaGamma(slug: string): Promise<{ pai: string | null; pergunta: string | null }> {
  const resposta = await fetch(`${GAMMA}/markets?slug=${encodeURIComponent(slug)}`);
  if (!resposta.ok) return { pai: null, pergunta: null };
  const corpo = (await resposta.json()) as Array<{
    question?: string;
    events?: Array<{ slug?: string }>;
  }>;
  return {
    pai: corpo[0]?.events?.[0]?.slug ?? null,
    pergunta: corpo[0]?.question ?? null,
  };
}

/** The title every Polymarket page falls back to when the slug addresses nothing. */
const TITULO_GENERICO = /The World&#x27;s Largest Prediction Market|The World's Largest Prediction Market/;

/**
 * Whether a Polymarket page exists, and what it is called.
 *
 * ## Do NOT decide this by searching the response body
 *
 * The first version of this function looked for "page not found" in the HTML
 * and was WRONG. polymarket.com is a SPA, and that string ships inside the
 * shell bundle of EVERY page -- including pages that open perfectly. It matched
 * on all 15 markets of the sample, breaking and working alike, and would have
 * reported a fix as still broken.
 *
 * The signal is the status code: a missing slug answers 404, a real one 200.
 * `og:title` is the corroboration, and it is read for that reason and not to
 * search the body again -- a real page carries the market's own question, a
 * missing one carries the generic title above. The two agreeing is what makes
 * the 200 trustworthy; either one alone is a guess.
 */
async function abre(url: string): Promise<{ ok: boolean; titulo: string; texto: string }> {
  try {
    const resposta = await fetch(url, { redirect: 'follow' });
    const corpo = await resposta.text();
    const og = /<meta property="og:title" content="([^"]*)"/.exec(corpo)?.[1] ?? '';
    const generico = TITULO_GENERICO.test(og);
    const ok = resposta.ok && !generico;
    return {
      ok,
      titulo: og,
      texto: `HTTP ${resposta.status} — ${ok ? `abriu: "${og}"` : 'nao abriu'}`,
    };
  } catch (erro) {
    return { ok: false, titulo: '', texto: `falhou: ${(erro as Error).message}` };
  }
}

async function main(): Promise<void> {
  const todas = await lerRoster();
  const ativas = todas.filter(l => l.status === 'active');

  console.log('# Cobertura de slug no roster');
  imprimir('radar_tracked — sem filtro de status', contar(todas));
  imprimir("radar_tracked and status = 'active' — o recorte de v_radar", contar(ativas));

  const porStatus = new Map<string, number>();
  for (const l of todas) {
    const s = l.status ?? '(null)';
    porStatus.set(s, (porStatus.get(s) ?? 0) + 1);
  }
  console.log('\n  status no roster inteiro:');
  for (const [s, n] of [...porStatus].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${s.padEnd(12)} ${n}`);
  }

  // A amostra sai do recorte de v_radar, que e o que a tela le.
  const ambos = ativas.filter(l => l.slug !== null && l.event_group_slug !== null);
  const divergentes = ambos.filter(l => l.slug !== l.event_group_slug);
  const iguais = ambos.filter(l => l.slug === l.event_group_slug);

  // Os divergentes sao o caso que se suspeita quebrado; os iguais entram porque
  // e onde o palpite acerta, e uma correcao que nao distingue os dois quebraria
  // justamente esse.
  const amostra = [...divergentes.slice(0, AMOSTRA_DIVERGENTES), ...iguais.slice(0, AMOSTRA_IGUAIS)];

  console.log('\n# Amostra: as quatro formas de URL em cada slug');

  // As quatro candidatas, e o que cada uma responde por.
  //   tela    o que web/src/lib/formato.ts monta hoje
  //   grupo   o que src/bot/handlers/signals.ts monta hoje
  //   completa  /event/<grupo>/<mercado>, a forma que a doc descreve para
  //             mercado dentro de evento multi-resultado
  //   fallback  o segundo ramo de src/bot, nunca exercido porque
  //             event_group_slug esta em 100% das linhas
  const placar = {
    tela: 0, telaIguais: 0, telaDivergentes: 0,
    grupo: 0, completa: 0, completaNoMercadoCerto: 0, fallback: 0,
  };

  for (const linha of amostra) {
    const slug = linha.slug as string;
    const grupo = linha.event_group_slug as string;
    const igual = slug === grupo;

    const [tipo, mercado] = await Promise.all([tipoNaGamma(slug), mercadoNaGamma(slug)]);

    const urls = {
      tela: `https://polymarket.com/event/${slug}`,
      grupo: `https://polymarket.com/event/${grupo}`,
      completa: `https://polymarket.com/event/${grupo}/${slug}`,
      fallback: `https://polymarket.com/market/${slug}`,
    };
    const [tela, grupoR, completa, fallback] = await Promise.all([
      abre(urls.tela), abre(urls.grupo), abre(urls.completa), abre(urls.fallback),
    ]);

    if (tela.ok) {
      placar.tela++;
      if (igual) placar.telaIguais++;
      else placar.telaDivergentes++;
    }
    if (grupoR.ok) placar.grupo++;
    if (completa.ok) placar.completa++;
    if (fallback.ok) placar.fallback++;

    // Abrir nao basta: a pergunta do mercado tem que estar no titulo, senao a
    // URL caiu na lista do evento em vez do mercado que a regra descreve.
    const chegou = completa.ok && mercado.pergunta !== null
      && normalizar(completa.titulo) === normalizar(mercado.pergunta);
    if (chegou) placar.completaNoMercadoCerto++;

    console.log(`\n  ${linha.id}  [${igual ? 'iguais' : 'divergentes'}]`);
    console.log(`    events.slug               ${slug}`);
    console.log(`      Gamma: e evento?        ${tipo.evento}`);
    console.log(`      Gamma: e mercado?       ${tipo.mercado}`);
    console.log(`      pergunta do mercado     ${mercado.pergunta ?? '(nenhuma)'}`);
    console.log(`    events.event_group_slug   ${grupo}`);
    console.log(`      bate com o pai da API?  ${mercado.pai === grupo ? 'sim' : `NAO (API diz ${mercado.pai ?? 'nenhum'})`}`);
    console.log(`    tela      /event/<slug>            ${tela.texto}`);
    console.log(`    bot       /event/<grupo>           ${grupoR.texto}`);
    console.log(`    completa  /event/<grupo>/<slug>    ${completa.texto}`);
    console.log(`      chegou no mercado certo?         ${chegou ? 'sim' : 'NAO'}`);
    console.log(`    fallback  /market/<slug>           ${fallback.texto}`);
  }

  const nDiv = Math.min(AMOSTRA_DIVERGENTES, divergentes.length);
  const nIgu = Math.min(AMOSTRA_IGUAIS, iguais.length);
  console.log(`\n# Placar da amostra (${amostra.length} mercados: ${nDiv} divergentes, ${nIgu} iguais)`);
  console.log(`  tela      /event/<slug>          abriu ${placar.tela}/${amostra.length}`);
  console.log(`              dos divergentes            ${placar.telaDivergentes}/${nDiv}`);
  console.log(`              dos iguais                 ${placar.telaIguais}/${nIgu}`);
  console.log(`  bot       /event/<grupo>         abriu ${placar.grupo}/${amostra.length}`);
  console.log(`  completa  /event/<grupo>/<slug>  abriu ${placar.completa}/${amostra.length}`);
  console.log(`              e no mercado certo         ${placar.completaNoMercadoCerto}/${amostra.length}`);
  console.log(`  fallback  /market/<slug>         abriu ${placar.fallback}/${amostra.length}`);
}

/** Titles come HTML-escaped; comparing them raw would fail on every apostrophe. */
function normalizar(texto: string): string {
  return texto
    .replace(/&#x27;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .trim()
    .toLowerCase();
}

main().catch(erro => {
  console.error(`medicao falhou: ${(erro as Error).message}`);
  process.exit(1);
});
