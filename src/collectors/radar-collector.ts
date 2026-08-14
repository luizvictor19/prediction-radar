import { supabase } from '../lib/supabase.js';
import { logEvent, logDisabled } from '../lib/logger.js';
import { beat } from '../lib/heartbeat.js';
import { getSystemConfig } from '../lib/config.js';
import { CycleLock } from '../lib/cycle-lock.js';
import { ColumnProbe } from '../lib/column-probe.js';
import { batchInsert, batchUpsert, dedupeByKey, EVENTS_CHUNK_SIZE } from '../lib/batch-write.js';
import { gammaToEvent } from '../lib/normalize.js';
import {
  fetchBooks,
  fetchMarketsByIds,
  fetchMarketsByTag,
  fetchTagIdBySlug,
  GammaHttpError,
  MAX_IDS_PER_REQUEST,
  MAX_TOKENS_PER_BOOK_REQUEST,
} from '../lib/polymarket-api.js';
import {
  bestLevels,
  montarLinha,
  liquidezDe,
  montarRoster,
  tokenYesDe,
  volume24hDe,
  type RadarCandidate,
  type RadarRules,
  type RadarSnapshotRow,
  type RosterResult,
} from './radar-selection.js';
import type { GammaMarket, SystemConfig } from '../types/index.js';

/**
 * O coletor do radar — coleta BURRA, tese na view.
 *
 * A frente troca prever por vigiar: o mercado precifica a manchete e resolve
 * pela regra, e a diferença entre as duas é onde se opera. Este componente não
 * sabe disso, e é o ponto. Ele coleta série de preço de tudo que é viável e
 * estável, e quem tem opinião é a camada que lê — porque tese morre. O pipeline
 * de esports foi construído inteiro em cima de uma, ela morreu, e nada daquilo
 * serviu para outra coisa.
 *
 * O critério inteiro está em `radar-selection.ts`, sob um princípio só:
 * **filtra na coleta o que NÃO muda, filtra na view o que muda.**
 *
 * ## Dois passos, cadências diferentes
 *
 * **Renovar o roster** (`radar_roster_interval_minutes`, 6h por padrão) — quem
 * passa nos critérios entra. É o passo caro (dezenas de chamadas); a janela de
 * prazo é de até 180 dias e ninguém entra nem sai dela em minutos.
 *
 * **Fotografar** (`radar_snapshot_interval_minutes`, 15 min por padrão) — o
 * preço de cada um do roster. A justificativa está em `INTERVALO_FOTO_PADRAO`.
 *
 * ## O que este coletor NÃO faz, de propósito
 *
 * - Não coleta esports. CS2, LoL e Dota saíram por decisão; nenhuma tag deles
 *   está na lista de categorias, e o prefixo de slug é a defesa que sobra.
 *   Esporte de TEMPORADA (título, artilheiro, rebaixamento) entra.
 * - Não desmarca `radar_tracked`. Ver `NUNCA_DESMARCAR`.
 * - Não resolve mercado: quem faz isso é o `resolved-detector`.
 * - Não decide o que é interessante. Preço, volume e assunto são colunas, não
 *   portas.
 */

const COMPONENT = 'radar_collector';

/**
 * O tick do cron. Não é a cadência de nada — quem decide são os dois intervalos
 * da config, e o tick só precisa ser mais rápido que o menor deles. Mesmo
 * desenho da watchlist e do enricher.
 */
const CYCLE_TIMEOUT_MS = 180_000;

/** Tick de 5 min: passado 15 o ciclo está travado, não lento. */
const STALE_AFTER_MS = 15 * 60 * 1000;

/**
 * Folga na checagem de vencimento, para o tick não virar aliasing: sem ela um
 * intervalo de 15 min alinhado a um tick de 5 seria atendido a cada 20.
 */
const TICK_TOLERANCE_MS = 30_000;

/**
 * Espaçamento entre requisições à Gamma e à CLOB. Cortesia com API pública e
 * gratuita, o mesmo valor das sondas (`scripts/lib/probe-net.ts`).
 */
const SPACING_MS = 250;

/**
 * Teto ABSOLUTO de páginas por tag. Quem decide o número de verdade é
 * `paginasPorTag`, a partir do teto da categoria; este é só a trava contra
 * config absurda — 20 páginas de 100 encostam no teto de offset 2000 da Gamma, e
 * pedir mais que isso é 422 garantido.
 */
const MAX_PAGES_POR_TAG = 20;

/**
 * `radar_tracked` NUNCA é desmarcado por este coletor, e isso é decisão, não
 * esquecimento.
 *
 * A marca não significa "está no roster agora" — significa "a série deste
 * mercado não pode ser apagada". Desmarcar quem saiu do roster devolveria a
 * série aos dois ramos da retenção, e o ramo `finalized` apaga TODO snapshot de
 * event resolvido SEM condição de idade. Ou seja: o mercado resolve, sai do
 * roster por isso mesmo, é desmarcado, e às 03:00 a série inteira dele vai
 * embora — inclusive a semana anterior ao desfecho, que é exatamente o trecho
 * que esta frente existe para acumular. É o defeito que o README registra como
 * dano permanente ("of 1,755 resolved matches probed for recoverable history,
 * zero have a usable price series").
 *
 * Quem está no roster AGORA é a lista em memória, recalculada a cada renovação.
 * O que a marca no banco controla é só a retenção.
 *
 * Consequência aceita e mensurável: o conjunto marcado só cresce. O log traz
 * `marcados_no_banco` a cada renovação — quando ele passar de alguns milhares,
 * o destino é partição, como foi para esports, e não desmarcar.
 */
const NUNCA_DESMARCAR = true;

/**
 * 15 minutos entre fotos, e o número sai do uso, não de simetria com nada.
 *
 * O que se quer medir é reação a notícia: o preço salta, exagera, e volta em
 * horas ou dias. O julgamento é em lote, no fim de semana — não há decisão
 * dependendo do minuto, então cadência de segundos não compra nada. O que
 * compra é resolução suficiente para o retorno APARECER: um exagero que se
 * desfaz em 3h rende 12 pontos a 15 min, o bastante para distinguir "voltou"
 * de "andou de lado". A 1h seriam 3 pontos, e um salto que nasce e morre entre
 * duas fotos não deixa rastro nenhum.
 *
 * Do outro lado está o custo, e ele é permanente: a série do radar é isenta da
 * retenção. A 15 min, 150 mercados × 1 linha × 96 fotos/dia = ~14k linhas/dia,
 * ~430k/mês. A 1 min seriam 216k/dia — a tabela inteira de hoje (~96k linhas) a
 * cada 11 horas, para sempre.
 *
 * A cadência da watchlist de esports (12s ao vivo) não serve de referência: lá
 * ela é ancorada em hora de partida, que aqui não existe. Notícia não tem
 * horário publicado.
 */
export const INTERVALO_FOTO_PADRAO = 15;

const cycleLock = new CycleLock(STALE_AFTER_MS);

/**
 * `events.radar_tracked` só existe depois da migration 20260813210119, aplicada
 * à mão. Mandá-la no payload antes disso derrubaria o chunk inteiro do upsert.
 */
const radarTrackedProbe = new ColumnProbe('events', 'radar_tracked', 'radar');

/**
 * `events.radar_subject` e `events.radar_tema` vêm juntas, na migration do
 * coletor. Uma sonda só para as duas: elas nascem no mesmo apply, e sondar a
 * segunda seria pagar outra ida ao banco para responder a mesma pergunta.
 */
const radarSubjectProbe = new ColumnProbe('events', 'radar_subject', 'radar');

// ---------------------------------------------------------------------------
// Estado do processo
// ---------------------------------------------------------------------------

export interface RosterEntry {
  /** `events.id` — a chave da série. */
  eventId: string;
  polymarketId: string;
  /** Token do outcome 0, a chave do livro no CLOB. */
  tokenYes: string;
  /** Rótulo do outcome 0, para a coluna `outcome` do snapshot. */
  outcome: string;
  question: string;
  tema: string;
  assunto: string;
  endDate: string | null;
}

/**
 * O roster vive em MEMÓRIA, e um deploy o zera — de propósito.
 *
 * A alternativa seria uma coluna "está no roster" em `events`, e ela custaria
 * uma migration a mais para responder uma pergunta que o próprio critério já
 * responde em 30 chamadas. Processo que sobe recalcula: é o mesmo desenho da
 * marca d'água da descoberta, e o comportamento correto para um processo novo.
 */
let roster: RosterEntry[] = [];
let rosterBuiltAt = 0;
let lastPhotoAt = 0;

/** Ids de tag resolvidos a partir do slug. Tag não muda de id; cache eterno. */
const tagIdCache = new Map<string, string | null>();

/** Só para os testes: zera o estado entre casos. */
export function resetRadarState(): void {
  roster = [];
  rosterBuiltAt = 0;
  lastPhotoAt = 0;
  tagIdCache.clear();
}

// ---------------------------------------------------------------------------
// Rede: espaçada e contada
// ---------------------------------------------------------------------------

let lastCallAt = 0;

interface CallCounter {
  gamma: number;
  clob: number;
}

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

async function espacar(): Promise<void> {
  const wait = SPACING_MS - (Date.now() - lastCallAt);
  if (wait > 0) await sleep(wait);
  lastCallAt = Date.now();
}

async function chamar<T>(host: keyof CallCounter, calls: CallCounter, fn: () => Promise<T>): Promise<T> {
  await espacar();
  calls[host] += 1;
  try {
    return await fn();
  } finally {
    lastCallAt = Date.now();
  }
}

// ---------------------------------------------------------------------------
// A regra, lida da config
// ---------------------------------------------------------------------------

export function readRules(config: SystemConfig): RadarRules {
  return {
    horizonMaxDays: config.radar_horizon_max_days,
    minLiquidity: config.radar_min_liquidity,
    maxPorCategoria: config.radar_max_por_categoria,
    rosterMax: config.radar_roster_max,
  };
}

/**
 * Quantas páginas de 100 ler por tag.
 *
 * Não é chute: a paginação vem ordenada por liquidez decrescente e a ordem é
 * monotônica entre páginas (medido), então os N maiores de uma tag estão nas
 * primeiras ceil(N/100) páginas. Como uma tag nunca precisa entregar mais que o
 * teto da categoria dela, ler mais que isso não pode mudar o resultado.
 *
 * O `+1` é a folga da desduplicação: um mesmo market aparece em duas tags da
 * mesma categoria (um evento de IA também marcado como `tech`) e conta uma vez
 * só, então a página extra cobre o caso em que muita coisa se repete.
 */
export function paginasPorTag(rules: RadarRules): number {
  return Math.min(MAX_PAGES_POR_TAG, Math.ceil(rules.maxPorCategoria / 100) + 1);
}

/**
 * Os temas da config, sem os que não têm tag utilizável.
 *
 * Tema vazio é config incompleta, não desligamento — o desligamento é a flag.
 * Sai com aviso para não virar um assunto que ninguém percebe que sumiu.
 */
export function readTemas(config: SystemConfig): Array<{ tema: string; tags: string[] }> {
  const bruto = config.radar_temas ?? {};
  const out: Array<{ tema: string; tags: string[] }> = [];

  for (const [tema, tags] of Object.entries(bruto)) {
    const limpas = Array.isArray(tags) ? tags.filter(t => typeof t === 'string' && t.length > 0) : [];
    if (limpas.length === 0) {
      console.warn(`[radar] tema "${tema}" sem tag — ignorado`);
      continue;
    }
    out.push({ tema, tags: limpas });
  }

  return out;
}

// ---------------------------------------------------------------------------
// Passo 1 — renovar o roster
// ---------------------------------------------------------------------------

export interface RenovacaoStats extends RosterResult {
  /** Markets baixados, antes de qualquer filtro. */
  universo: number;
  /**
   * Tags cuja leitura parou com página cheia E cuja menor liquidez lida ainda
   * está acima do corte da categoria — ou seja, existe mercado que caberia no
   * roster e não foi visto. Truncar por si só é o esperado (ver `paginasPorTag`);
   * o que este contador denuncia é o truncamento que MUDA o resultado.
   */
  tagsTruncadasAcimaDoCorte: string[];
  /** Tags da config que a Gamma não conhece. */
  tagsDesconhecidas: string[];
  chamadas: CallCounter;
  /** Erros de escrita no upsert de `events`. Vazio em `--dry-run`. */
  errosDeEscrita: string[];
  /** Quantos events estão marcados no banco. `null` quando a leitura falhou. */
  marcadosNoBanco: number | null;
}

interface Opcoes {
  /** Não escreve nada: nem `events`, nem snapshot. */
  dryRun: boolean;
  /** Imprime a lista inteira no console. */
  verbose: boolean;
}

const DIA_MS = 24 * 60 * 60 * 1000;

/**
 * Baixa o universo de uma tag: páginas de 100 até a lista acabar.
 *
 * Dois filtros são do servidor e um não é (medido em 2026-08-13):
 *
 *   `tag_id`             funciona. É o recorte de CATEGORIA.
 *   `end_date_min/max`   funcionam.
 *   `liquidity_num_min`  funciona. É piso de DOWNLOAD, não de tese.
 *   `volume_24hr_min`    NÃO funciona — aceito e ignorado. Não faz falta: o
 *                        piso de volume saiu da coleta nesta revisão.
 *
 * `end_date_min` é AGORA, e não "agora + N dias": não existe mais prazo mínimo,
 * e o que ele exclui é só o mercado já vencido que a Gamma ainda lista.
 */
interface LeituraDeTag {
  markets: GammaMarket[];
  /** A lista da tag acabou — não há mais o que ler. */
  acabou: boolean;
  /** Onde a próxima leitura desta tag continua. */
  proximaPagina: number;
  menorLiquidezLida: number | null;
}

async function baixarTag(
  tagId: string,
  rules: RadarRules,
  nowMs: number,
  calls: CallCounter,
  de: number,
  paginas: number,
): Promise<LeituraDeTag> {
  const markets: GammaMarket[] = [];
  const endDateMin = new Date(nowMs).toISOString();
  const endDateMax = new Date(nowMs + rules.horizonMaxDays * DIA_MS).toISOString();
  const ate = Math.min(de + paginas, MAX_PAGES_POR_TAG);

  for (let page = de; page < ate; page++) {
    let lote: GammaMarket[];
    try {
      lote = await chamar('gamma', calls, () =>
        fetchMarketsByTag({
          tagId,
          endDateMin,
          endDateMax,
          minLiquidity: rules.minLiquidity,
          limit: 100,
          offset: page * 100,
          orderByLiquidity: true,
        }),
      );
    } catch (err) {
      // 422 no teto de offset é fim de paginação, não falha (ver GammaHttpError).
      if (err instanceof GammaHttpError && err.status === 422) {
        return { markets, acabou: true, proximaPagina: page, menorLiquidezLida: menorLiquidez(markets) };
      }
      throw err;
    }

    markets.push(...lote);
    // Página curta é fim de lista.
    if (lote.length < 100) {
      return { markets, acabou: true, proximaPagina: page + 1, menorLiquidezLida: menorLiquidez(markets) };
    }
  }

  // Orçamento de páginas esgotado NÃO é fim de lista, e a diferença importa: se
  // as duas coisas fossem o mesmo `acabou`, uma tag que bateu no teto de offset
  // da Gamma sairia do diagnóstico de truncamento como se tivesse sido lida
  // inteira — exatamente o caso em que o roster está incompleto.
  return {
    markets,
    acabou: false,
    proximaPagina: ate,
    menorLiquidezLida: menorLiquidez(markets),
  };
}

function menorLiquidez(markets: readonly GammaMarket[]): number | null {
  let menor: number | null = null;
  for (const m of markets) {
    const liq = liquidezDe(m);
    if (menor === null || liq < menor) menor = liq;
  }
  return menor;
}

/**
 * Recalcula o roster inteiro e o persiste como marca de proteção.
 *
 * Escrever em `events` aqui é normal — é o job em produção fazendo o trabalho
 * dele. O que não acontece é desmarcar (ver `NUNCA_DESMARCAR`).
 */
export async function renovarRoster(
  config: SystemConfig,
  nowMs: number,
  opts: Opcoes,
): Promise<{ entries: RosterEntry[]; stats: RenovacaoStats }> {
  const rules = readRules(config);
  const calls: CallCounter = { gamma: 0, clob: 0 };
  const tagsDesconhecidas: string[] = [];

  interface EstadoDaTag {
    tema: string;
    tagId: string;
    markets: GammaMarket[];
    acabou: boolean;
    proximaPagina: number;
    menorLiquidezLida: number | null;
  }
  const porTag = new Map<string, EstadoDaTag>();

  // Quem já está protegido. Serve a uma coisa só: dispensar do piso do livro
  // VAZIO quem já tem série (ver `triar`). Um `select` sobre o índice parcial
  // `idx_events_radar_tracked`, que indexa só as linhas `true`.
  const marcados = await lerMarcados();

  const passo = paginasPorTag(rules);

  for (const { tema, tags } of readTemas(config)) {
    for (const slug of tags) {
      let tagId = tagIdCache.get(slug);
      if (tagId === undefined) {
        tagId = await chamar('gamma', calls, () => fetchTagIdBySlug(slug));
        tagIdCache.set(slug, tagId);
      }
      if (tagId === null) {
        tagsDesconhecidas.push(slug);
        continue;
      }

      const leitura = await baixarTag(tagId, rules, nowMs, calls, 0, passo);
      porTag.set(slug, { tema, tagId, ...leitura });
    }
  }

  const montar = (): ReturnType<typeof montarRoster> => {
    const universo: Array<GammaMarket & { tema: string; jaMarcado: boolean }> = [];
    for (const estado of porTag.values()) {
      for (const m of estado.markets) {
        universo.push({ ...m, tema: estado.tema, jaMarcado: marcados.has(m.id) });
      }
    }
    return montarRoster(universo, rules, nowMs);
  };

  let resultado = montar();

  /**
   * A paginação se corrige sozinha.
   *
   * Ler as primeiras páginas de cada tag (em ordem de liquidez decrescente) SÓ
   * basta se a menor liquidez lida numa tag já estiver abaixo do corte da
   * categoria dela — aí o que ficou por ler não entraria de qualquer jeito.
   * Quando não está, existe mercado acima do corte que o coletor não viu, e o
   * roster daquela categoria não é o que a regra diz que é.
   *
   * Isso não é hipótese: na medição de 2026-08-13 a tag `politics` leu até
   * 81.654 com o corte da categoria em 51.199. Duas páginas por tag pareciam
   * suficientes porque uma tag nunca precisa entregar mais que o teto da
   * categoria — o que a conta ignorava é que desduplicação e triagem comem parte
   * do que foi lido, e sobra menos do que se leu.
   *
   * Então em vez de avisar e seguir com o roster errado, ele lê mais — só das
   * tags que precisam, e só até o corte. Cada rodada custa `passo` páginas por
   * tag faltante, e o laço para no teto de offset da Gamma.
   */
  const MAX_RODADAS = 6;
  for (let rodada = 0; rodada < MAX_RODADAS; rodada++) {
    const faltando = [...porTag.entries()].filter(([, e]) => {
      if (e.acabou) return false;
      // Teto de offset da Gamma: acima dele não há o que ler, e insistir seria
      // gastar chamada para receber 422. Estas caem no aviso do fim.
      if (e.proximaPagina >= MAX_PAGES_POR_TAG) return false;
      const corte = resultado.porCategoria[e.tema]?.liquidezDoCorte ?? null;
      return corte !== null && e.menorLiquidezLida !== null && e.menorLiquidezLida > corte;
    });
    if (faltando.length === 0) break;

    for (const [slug, estado] of faltando) {
      const leitura = await baixarTag(estado.tagId, rules, nowMs, calls, estado.proximaPagina, passo);
      porTag.set(slug, {
        ...estado,
        markets: [...estado.markets, ...leitura.markets],
        acabou: leitura.acabou,
        proximaPagina: leitura.proximaPagina,
        menorLiquidezLida: leitura.menorLiquidezLida ?? estado.menorLiquidezLida,
      });
    }
    resultado = montar();
  }

  // O que sobrou depois das rodadas extras: tag que bateu no teto de offset da
  // Gamma ainda acima do corte. Aqui não há mais o que fazer sem mudar a regra —
  // e o número precisa aparecer, porque o roster daquela categoria está
  // incompleto.
  const tagsTruncadasAcimaDoCorte: string[] = [];
  for (const [slug, estado] of porTag) {
    const corte = resultado.porCategoria[estado.tema]?.liquidezDoCorte ?? null;
    if (!estado.acabou && corte !== null && estado.menorLiquidezLida !== null && estado.menorLiquidezLida > corte) {
      tagsTruncadasAcimaDoCorte.push(
        `${slug} (leu até ${Math.round(estado.menorLiquidezLida)}, corte em ${Math.round(corte)})`,
      );
    }
  }

  const universo = [...porTag.values()].reduce((n, e) => n + e.markets.length, 0);

  const entries = opts.dryRun
    ? resultado.roster.map(c => paraEntrada(c, c.market.id))
    : await persistirRoster(resultado.roster);

  const errosDeEscrita = opts.dryRun ? [] : ultimosErrosDeEscrita;
  const marcadosNoBanco = opts.dryRun ? null : await contarMarcados();

  return {
    entries,
    stats: {
      ...resultado,
      universo,
      tagsTruncadasAcimaDoCorte,
      tagsDesconhecidas,
      chamadas: calls,
      errosDeEscrita,
      marcadosNoBanco,
    },
  };
}

/** O rótulo do outcome 0. `Yes` no binário, que é o que este recorte coleta. */
function outcomeDe(market: GammaMarket): string {
  try {
    const outcomes = JSON.parse(market.outcomes) as unknown;
    const primeiro = Array.isArray(outcomes) ? outcomes[0] : null;
    return typeof primeiro === 'string' && primeiro.length > 0 ? primeiro : 'Yes';
  } catch {
    return 'Yes';
  }
}

function paraEntrada(c: RadarCandidate, eventId: string): RosterEntry {
  const market = c.market as GammaMarket & { tema: string };
  return {
    eventId,
    polymarketId: market.id,
    tokenYes: tokenYesDe(c.market) ?? '',
    outcome: outcomeDe(market),
    question: market.question,
    tema: c.tema,
    assunto: c.assunto,
    endDate: market.endDate ?? null,
  };
}

let ultimosErrosDeEscrita: string[] = [];

/**
 * A linha de `events` de um candidato.
 *
 * `sub_category` e `resolved_outcome` saem do payload pelo mesmo motivo da
 * descoberta: este coletor não tem o que dizer sobre nenhum dos dois, e
 * mandá-los como null apagaria no upsert o que o categorizador e o auto-resolver
 * escreveram.
 *
 * `radar_tema` e `radar_subject` são o que esta rodada acrescentou: os dois eram
 * filtro e viraram COLUNA. Nenhum dos dois é recuperável depois — a tag que
 * trouxe o mercado não fica em lugar nenhum, e o grupo de assunto depende do
 * conjunto que estava aberto naquele momento. Não gravar agora é não ter.
 */
function linhaDeEvento(c: RadarCandidate): Record<string, unknown> {
  const market = c.market as GammaMarket & { tema: string };
  const linha: Record<string, unknown> = {
    ...gammaToEvent(market, 'other', market.events?.[0] ?? null),
    radar_tracked: true,
    radar_tema: c.tema,
    radar_subject: c.assunto,
  };
  delete linha['sub_category'];
  delete linha['resolved_outcome'];
  return linha;
}

/**
 * Grava os markets do roster em `events` e devolve as entradas com o `id` do
 * banco — sem ele não há como escrever snapshot.
 */
async function persistirRoster(candidatos: readonly RadarCandidate[]): Promise<RosterEntry[]> {
  ultimosErrosDeEscrita = [];
  if (candidatos.length === 0) return [];

  const porPolymarketId = new Map<string, RadarCandidate>();
  const linhas: Array<Record<string, unknown>> = [];

  for (const c of candidatos) {
    porPolymarketId.set(c.market.id, c);
    linhas.push(linhaDeEvento(c));
  }

  // Duas sondas porque as duas colunas vêm de migrations diferentes:
  // `radar_tracked` da 20260813210119 (aplicada) e as duas do radar da migration
  // do coletor. Mandar coluna que não existe derruba o CHUNK inteiro do upsert.
  const payload = await radarSubjectProbe.strip(
    await radarTrackedProbe.strip(dedupeByKey(linhas, row => String(row['polymarket_id']))),
  );
  const semTema = payload.map(row => {
    const copia = { ...row };
    if (!('radar_subject' in copia)) delete copia['radar_tema'];
    return copia;
  });

  const result = await batchUpsert<{ id: string; polymarket_id: string }>('events', semTema, {
    onConflict: 'polymarket_id',
    chunkSize: EVENTS_CHUNK_SIZE,
    label: 'radar',
    select: 'id, polymarket_id',
  });

  ultimosErrosDeEscrita = result.errors;

  const entries: RosterEntry[] = [];
  for (const row of result.rows) {
    const c = porPolymarketId.get(row.polymarket_id);
    if (c !== undefined) entries.push(paraEntrada(c, row.id));
  }

  return entries;
}

/**
 * O payload do upsert cabe nas colunas de `events`?
 *
 * Existe para o `--dry-run`, e a razão é operacional: o `--dry-run` não escreve,
 * então o caminho de escrita só seria exercido pela primeira vez em produção,
 * com a flag ligada — e uma chave a mais no payload derruba o CHUNK INTEIRO do
 * upsert, não a linha. Comparar as chaves contra uma linha real custa um
 * `select ... limit 1` e responde a mesma pergunta antes.
 *
 * `null` quando a leitura falhou: aí não se sabe, e não saber não é o mesmo que
 * estar tudo certo.
 */
export async function conferirPayload(
  candidatos: readonly RadarCandidate[],
): Promise<{ colunasFaltando: string[] } | null> {
  if (candidatos.length === 0) return { colunasFaltando: [] };

  const { data, error } = await supabase.from('events').select('*').limit(1);
  const amostra = (data ?? [])[0] as Record<string, unknown> | undefined;
  if (error || amostra === undefined) return null;

  const colunas = new Set(Object.keys(amostra));
  const linha = linhaDeEvento(candidatos[0]!);
  return { colunasFaltando: Object.keys(linha).filter(k => !colunas.has(k)) };
}

/**
 * Os `polymarket_id` já marcados como `radar_tracked`.
 *
 * Serve a um caso só: dispensar do piso do livro VAZIO quem já tem série
 * protegida (ver `triar`). A coleta hoje exige um lado, não dois — mas perto da
 * resolução o livro seca inteiro, e tirar do roster quem já está dentro abriria
 * buraco na série no trecho mais informativo.
 *
 * A query varre `idx_events_radar_tracked`, o índice PARCIAL da migration
 * 20260813210119: ele indexa só as linhas `true`, então o custo é proporcional
 * ao conjunto marcado (centenas), não às linhas de `events`. Conjunto vazio é o
 * estado normal antes do primeiro ciclo.
 *
 * Falha de leitura devolve conjunto vazio, e a consequência é branda e na
 * direção certa: o critério do livro volta a valer para todo mundo naquele
 * ciclo — ninguém entra por engano, no máximo alguém sai por um ciclo.
 */
async function lerMarcados(): Promise<Set<string>> {
  if (!(await radarTrackedProbe.isSupported())) return new Set();

  const { data, error } = await supabase
    .from('events')
    .select('polymarket_id')
    .eq('radar_tracked', true);

  if (error) {
    console.warn(`[radar] não deu para ler os marcados: ${error.message}`);
    return new Set();
  }

  return new Set((data ?? []).map(row => (row as { polymarket_id: string }).polymarket_id));
}

/**
 * Quantos events estão marcados para o radar.
 *
 * Contagem sobre `idx_events_radar_tracked`, o índice PARCIAL da migration
 * 20260813210119 — ele indexa só as linhas `true`, então isto lê dezenas de
 * entradas e não as 551k de `events`. É a medida de quanto a proteção
 * permanente já cresceu; ver `NUNCA_DESMARCAR`.
 */
async function contarMarcados(): Promise<number | null> {
  const { count, error } = await supabase
    .from('events')
    .select('id', { count: 'exact', head: true })
    .eq('radar_tracked', true);

  return error ? null : (count ?? 0);
}

// ---------------------------------------------------------------------------
// Passo 2 — fotografar
// ---------------------------------------------------------------------------

export interface FotoStats {
  /** Mercados pedidos à Gamma neste ciclo. */
  pedidos: number;
  /** Ausentes do lote `closed=false`: resolveram, ou saíram de listagem. */
  ausentes: number;
  /** Vieram com `closed=true` no lote de abertos — preço 0/1 sujaria a série. */
  fechados: number;
  /** Livros vazios dos dois lados: nada a registrar. */
  semLivro: number;
  /** Linhas gravadas (ou que seriam, em `--dry-run`). */
  linhas: number;
  chamadas: CallCounter;
  errosDeEscrita: string[];
  /** Amostra do que foi lido, para o `--dry-run` imprimir. */
  amostra: RadarSnapshotRow[];
}

export async function fotografar(entradas: readonly RosterEntry[], opts: Opcoes): Promise<FotoStats> {
  const calls: CallCounter = { gamma: 0, clob: 0 };
  const stats: FotoStats = {
    pedidos: entradas.length,
    ausentes: 0,
    fechados: 0,
    semLivro: 0,
    linhas: 0,
    chamadas: calls,
    errosDeEscrita: [],
    amostra: [],
  };

  if (entradas.length === 0) return stats;

  // 1. Gamma, por id: é de onde vem `volume_24h` e a confirmação de que o
  //    mercado ainda está aberto. 2 chamadas para um roster de 150.
  const porId = new Map<string, GammaMarket>();
  const ids = entradas.map(e => e.polymarketId);

  for (let i = 0; i < ids.length; i += MAX_IDS_PER_REQUEST) {
    const chunk = ids.slice(i, i + MAX_IDS_PER_REQUEST);
    try {
      const markets = await chamar('gamma', calls, () => fetchMarketsByIds(chunk, { closed: false }));
      for (const m of markets) porId.set(m.id, m);
    } catch (err) {
      // Um chunk que falha não derruba os outros: tratar falha de rede como
      // ausência seria inventar resolução onde só houve socket derrubado.
      console.error(`[radar] lote de ${chunk.length} ids falhou: ${String(err)}`);
    }
  }

  // 2. CLOB, por token: é de onde vem o livro — bid, ask e a PROFUNDIDADE, que
  //    a Gamma não publica. 3 chamadas para 150 mercados.
  const vivas = entradas.filter(e => {
    const m = porId.get(e.polymarketId);
    if (m === undefined) {
      stats.ausentes += 1;
      return false;
    }
    // O filtro `closed=false` deveria bastar, mas quem decide é o campo e não o
    // parâmetro: preço de mercado fechado é 0/1 e sujaria a série.
    if (m.closed) {
      stats.fechados += 1;
      return false;
    }
    return e.tokenYes.length > 0;
  });

  const linhas: RadarSnapshotRow[] = [];

  for (let i = 0; i < vivas.length; i += MAX_TOKENS_PER_BOOK_REQUEST) {
    const chunk = vivas.slice(i, i + MAX_TOKENS_PER_BOOK_REQUEST);
    let livros;
    try {
      livros = await chamar('clob', calls, () => fetchBooks(chunk.map(e => e.tokenYes)));
    } catch (err) {
      console.error(`[radar] lote de ${chunk.length} livros falhou: ${String(err)}`);
      continue;
    }

    // Carimbado por lote, no instante da resposta: um timestamp único no fim do
    // ciclo empilharia várias requisições no mesmo ponto da série.
    const capturedAt = new Date().toISOString();
    const porToken = new Map(livros.map(l => [l.asset_id, l]));

    for (const entrada of chunk) {
      const livro = porToken.get(entrada.tokenYes);
      const niveis = bestLevels(livro?.bids, livro?.asks);
      const market = porId.get(entrada.polymarketId);
      const linha = montarLinha(
        entrada.eventId,
        entrada.outcome,
        niveis,
        market === undefined ? null : volume24hDe(market),
        capturedAt,
      );
      if (linha === null) {
        stats.semLivro += 1;
        continue;
      }
      linhas.push(linha);
    }
  }

  stats.linhas = linhas.length;
  stats.amostra = linhas.slice(0, 5);

  if (!opts.dryRun && linhas.length > 0) {
    const result = await batchInsert('polymarket_snapshots', linhas, { label: 'radar' });
    stats.linhas = result.written;
    stats.errosDeEscrita = result.errors;
  }

  return stats;
}

// ---------------------------------------------------------------------------
// O ciclo
// ---------------------------------------------------------------------------

export interface CicloResult {
  renovacao: RenovacaoStats | null;
  foto: FotoStats | null;
  rosterSize: number;
}

function vencido(lastAt: number, nowMs: number, intervaloMinutos: number): boolean {
  if (lastAt === 0) return true;
  return nowMs - lastAt >= intervaloMinutos * 60_000 - TICK_TOLERANCE_MS;
}

export async function runRadarCycle(opts: Opcoes): Promise<CicloResult> {
  const nowMs = Date.now();
  const config = await getSystemConfig();

  let renovacao: RenovacaoStats | null = null;

  const intervaloRoster = Math.max(1, config.radar_roster_interval_minutes);
  const intervaloFoto = Math.max(1, config.radar_snapshot_interval_minutes);

  // O roster DESTE ciclo. Em `--dry-run` ele nunca vira estado do processo: as
  // entradas de um dry-run carregam o id da Gamma no lugar do `events.id` (não
  // houve upsert para devolver um), e deixá-las no lugar do roster real faria o
  // ciclo seguinte escrever snapshot com `event_id` inexistente.
  let doCiclo = roster;

  if (opts.dryRun || vencido(rosterBuiltAt, nowMs, intervaloRoster)) {
    const renovado = await renovarRoster(config, nowMs, opts);
    renovacao = renovado.stats;
    doCiclo = renovado.entries;

    if (!opts.dryRun) {
      // Roster vazio não substitui o anterior: uma queda da Gamma no meio da
      // renovação apagaria a lista e o ciclo seguinte pararia de fotografar sem
      // nada ter mudado no mundo.
      if (renovado.entries.length > 0 || roster.length === 0) roster = renovado.entries;
      else doCiclo = roster;
      rosterBuiltAt = Date.now();
    }
  }

  const foto =
    opts.dryRun || vencido(lastPhotoAt, nowMs, intervaloFoto)
      ? await fotografar(doCiclo, opts)
      : null;
  if (foto !== null && !opts.dryRun) lastPhotoAt = Date.now();

  return { renovacao, foto, rosterSize: doCiclo.length };
}

export async function collectRadar(): Promise<void> {
  const lockToken = cycleLock.tryAcquire();
  if (!lockToken) return;

  if (lockToken.staleTakeoverMs !== null) {
    const stuckMinutes = Math.round(lockToken.staleTakeoverMs / 60000);
    console.warn(`[radar] ciclo anterior travado por ${stuckMinutes}min — assumindo que morreu`);
    await logEvent({
      component: COMPONENT,
      status: 'partial',
      message: `WARNING: previous cycle stuck for ${stuckMinutes}min — assumed dead, starting a new one`,
      metadata: { stuck_for_ms: lockToken.staleTakeoverMs },
    });
  }

  const cyclePromise = _collect().finally(() => cycleLock.release(lockToken));
  const timeoutPromise = new Promise<void>((_, reject) =>
    setTimeout(() => reject(new Error(`cycle timeout ${CYCLE_TIMEOUT_MS}ms`)), CYCLE_TIMEOUT_MS),
  );

  try {
    await Promise.race([cyclePromise, timeoutPromise]);
  } catch (err) {
    await logEvent({
      component: COMPONENT,
      status: 'error',
      message: `Radar cycle failed: ${err instanceof Error ? err.message : String(err)}`,
      metadata: { error: String(err) },
    });
    await beat(COMPONENT, 'error', String(err).slice(0, 200));
  }
}

async function _collect(): Promise<void> {
  const startedAt = Date.now();
  const config = await getSystemConfig();

  if (!config.radar_collector_enabled) {
    await logDisabled(COMPONENT, 'Radar disabled: radar_collector_enabled is false');
    // Desligado pela config é ciclo completo, não falha — mesmo contrato da
    // descoberta e da watchlist.
    await beat(COMPONENT, 'success', 'desligado por config');
    return;
  }

  // Sem a coluna de proteção, coletar é PIOR que não coletar: as linhas seriam
  // escritas e a retenção as apagaria na execução das 03:00 — 24h de série por
  // dia, para sempre, com custo de chamada e de escrita e sem nada acumulado no
  // fim. Os outros componentes seguem degradados quando falta uma coluna; este
  // para, porque aqui a degradação não é "sem a âncora", é "sem o dado".
  if (!(await radarTrackedProbe.isSupported())) {
    await logDisabled(
      COMPONENT,
      'Radar parado: events.radar_tracked não existe — sem ela a série seria apagada pela retenção em 24h. Aplicar a migration 20260813210119.',
    );
    await beat(COMPONENT, 'partial', 'sem events.radar_tracked — nada coletado');
    return;
  }

  const { renovacao, foto, rosterSize } = await runRadarCycle({ dryRun: false, verbose: false });
  if (renovacao === null && foto === null) {
    await beat(COMPONENT, 'success', `nada vencido, ${rosterSize} no roster`);
    return;
  }

  const chamadas =
    (renovacao?.chamadas.gamma ?? 0) +
    (renovacao?.chamadas.clob ?? 0) +
    (foto?.chamadas.gamma ?? 0) +
    (foto?.chamadas.clob ?? 0);

  const erros = [...(renovacao?.errosDeEscrita ?? []), ...(foto?.errosDeEscrita ?? [])];
  const avisos = [
    ...(renovacao?.tagsTruncadasAcimaDoCorte ?? []),
    ...(renovacao?.tagsDesconhecidas ?? []),
  ];
  const status = erros.length > 0 ? 'error' : avisos.length > 0 ? 'partial' : 'success';

  const durationMs = Date.now() - startedAt;

  await logEvent({
    component: COMPONENT,
    status,
    message:
      `Radar: ${rosterSize} no roster, ${foto?.linhas ?? 0} snapshots em ${chamadas} chamadas ` +
      `(${durationMs}ms)` +
      (renovacao === null ? '' : ` — roster renovado de ${renovacao.universo} markets`) +
      (erros.length > 0 ? ` — ERRO: ${erros[0] ?? ''}` : ''),
    metadata: {
      duration_ms: durationMs,
      roster_size: rosterSize,
      // Só na renovação. `null` no ciclo que só fotografou.
      roster_por_tema: renovacao?.porTema ?? null,
      roster_universo: renovacao?.universo ?? null,
      roster_aprovados: renovacao?.candidatos.length ?? null,
      roster_descartes: renovacao?.descartes ?? null,
      // Diagnóstico: espelho não descarta mais ninguém, quem descarta é a view.
      roster_espelhos: renovacao?.espelhos.length ?? null,
      roster_assuntos: renovacao?.assuntos ?? null,
      // > 0 = o teto mordeu. Coleta que cresce sozinha aparece na fatura.
      roster_cortados_por_teto: renovacao?.cortadosPorTeto ?? null,
      // As duas liquidezes que dizem se o teto está no lugar certo: a do último
      // que entrou e a do primeiro que ficou de fora. Se a segunda for alta, o
      // teto está cortando mercado que interessa.
      roster_liquidez_do_corte: renovacao?.liquidezDoCorte ?? null,
      roster_liquidez_do_primeiro_cortado: renovacao?.liquidezDoPrimeiroCortado ?? null,
      // Entraram com o livro de UM lado só — o que a regra anterior descartava.
      // Estes gravam linha com `mid_price` NULO, e isso é a resposta certa.
      roster_com_um_lado_so: renovacao?.comUmLadoSo ?? null,
      // Entraram com o livro VAZIO, por já estarem protegidos. Estes não geram
      // linha nenhuma enquanto o livro não voltar.
      roster_mantidos_por_marca: renovacao?.mantidosPorMarca ?? null,
      // Cresce para sempre por desenho — ver NUNCA_DESMARCAR.
      marcados_no_banco: renovacao?.marcadosNoBanco ?? null,
      // Tag em que sobrou mercado acima do corte sem ser lido: o roster daquela
      // categoria não é o que a regra diz que é.
      tags_truncadas_acima_do_corte: renovacao?.tagsTruncadasAcimaDoCorte.length
        ? renovacao.tagsTruncadasAcimaDoCorte
        : null,
      tags_desconhecidas: renovacao?.tagsDesconhecidas.length ? renovacao.tagsDesconhecidas : null,
      snapshots: foto?.linhas ?? 0,
      // Sumiu do lote de abertos: resolveu, ou saiu de listagem.
      ausentes: foto?.ausentes ?? null,
      fechados_no_lote_aberto: foto?.fechados ?? null,
      sem_livro: foto?.semLivro ?? null,
      chamadas_gamma: (renovacao?.chamadas.gamma ?? 0) + (foto?.chamadas.gamma ?? 0),
      chamadas_clob: (renovacao?.chamadas.clob ?? 0) + (foto?.chamadas.clob ?? 0),
      write_errors: erros.length > 0 ? erros.slice(0, 5) : null,
      nunca_desmarca: NUNCA_DESMARCAR,
    },
  });

  await beat(
    COMPONENT,
    status === 'error' ? 'error' : status === 'partial' ? 'partial' : 'success',
    `${rosterSize} no roster, ${foto?.linhas ?? 0} snapshots, ${chamadas} chamadas`,
  );

  console.log(
    `[radar] ${rosterSize} no roster / ${foto?.linhas ?? 0} snapshots / ${chamadas} chamadas (${durationMs}ms)`,
  );
}
