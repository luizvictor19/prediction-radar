import { supabase } from '../../lib/supabase.js';
import { getSystemConfig } from '../../lib/config.js';
import {
  fixtures,
  historicalOdds,
  marketOutcomeOf,
  isExpectedOutage,
  waitMsFor,
  readConfig,
  describeConfig,
  billableBudget,
  OddsPapiError,
  SPORT_ID_BY_VERTICAL,
  MAX_BOOKMAKERS_PER_CALL,
  FIXTURES_CACHE_SECONDS,
  type OddsEntry,
  type OddsPapiFixture,
  type ResponseSource,
} from '../../lib/oddspapi-api.js';
import { lastFragmentAsOf, noteEnricherSkip, remainingMs } from '../enricher.js';
import type { ContextFragment, Enricher, EnricherContext } from '../enricher.js';

/**
 * `oddspapi` — a linha das casas de aposta, para o agente comparar com o preço
 * do Polymarket.
 *
 * É a primeira fonte que traz um NÚMERO concorrente. `market-history` mede o
 * nosso próprio preço, `polymarket-context` é texto da própria Polymarket e
 * `liquipedia` traz fatos sem preço. Nenhum deles responde à única pergunta que
 * o eval realmente faz: o mercado está errado? Discordância entre a Pinnacle e o
 * Polymarket é a forma mais direta que temos dessa pergunta.
 *
 * Dois fragmentos, e os dois saem das medições da sonda (2026-08-08):
 *
 *   `bookmaker_odds`       — a linha de cada casa no instante do `asOf`, em
 *                            probabilidade comparável com o preço do Polymarket
 *   `bookmaker_suspension` — os blocos de `active = false` na janela, só quando
 *                            existem
 *
 * ---------------------------------------------------------------------------
 * O QUE FOI MEDIDO, E COMO CADA NÚMERO VIROU DESENHO
 * ---------------------------------------------------------------------------
 *
 * **`active = false` é suspensão real: 138/150 blocos reabrem em preço
 * diferente.** Então o `false` é INFORMAÇÃO e não ruído — a casa tirou a linha e
 * voltou com outra, o que é exatamente o momento em que ela discorda de si
 * mesma. O enricher preserva: não filtra entrada inativa, registra o estado no
 * instante do `asOf`, e emite o fragmento de suspensão quando há blocos.
 *
 * **Mas o PREÇO da linha suspensa não é cotação — e isso saiu do snapshot, não
 * da lista acima.** Em 64 dos 75 instantes com `active = false` na Pinnacle, os
 * dois outcomes trocam de preço entre si; na Stake, 0 de 16. Usar esse número
 * como linha produz o mercado ESPELHADO sempre que o `asOf` cai dentro de uma
 * suspensão. Então estado e preço vêm de lugares diferentes: o estado do último
 * registro, o preço da última entrada ativa. Ver `lineAtAsOf`, onde está a
 * evidência de qual das duas orientações é a certa.
 *
 * **Densidade desigual: Pinnacle 3.487 movimentos numa fixture, Stake 102,
 * bet365 zero apesar de entitulada.** Casa ausente é NORMAL e não pode virar
 * erro nem lacuna suspeita. Daí `coverage` no payload e no `summary`: quem lê
 * precisa saber que bet365 não aparecer não significa nada. Daí também a
 * bet365 ficar fora do default de `oddspapi_bookmakers` — pedir uma casa que
 * mede zero é gastar uma das três vagas da chamada.
 *
 * **`limit` só na Pinnacle (3487/3487); Stake devolve null em tudo.** O stake
 * máximo era metade do argumento a favor desta fonte — ele é o peso de confiança
 * da casa. Com uma casa só reportando, PONDERAR o consenso por `limit` faria um
 * número que parece agregado e é Pinnacle pura. O consenso aqui é mediana sem
 * peso, e o `limit` vai no payload por casa, onde é dado e não índice.
 *
 * **~50% dos blocos da Stake coincidem com os de outra casa.** Pode ser falha de
 * feed do fornecedor ou evento real da partida — as duas produzem o mesmo campo.
 * A sonda não decide, e o enricher também não: registra a coincidência por bloco
 * e deixa a leitura para o agente, que tem o contexto da partida que falta aqui.
 *
 * **A janela cobre ~19h — o dia da partida, não semanas de linha de abertura.**
 * Então nada aqui fala em "movimento desde a abertura". O payload carrega a
 * janela real coberta por casa, e o `summary` diz o intervalo. Quem quiser
 * abertura precisa de outra fonte, não de outra leitura desta.
 *
 * **Sete mercados, não um.** A Pinnacle devolve 7 mercados por fixture de CS2
 * (171, 173, 1725, 1737, 1747, 1749, 1751) e a Stake devolve 4. Só o `171` é
 * lido — é o moneyline, o mais denso (688+689 entradas) e o comparável com o
 * mercado do Polymarket. Misturar os sete daria uma "linha" que é a última
 * entrada de qualquer um deles, handicap de mapa incluído.
 *
 * **Não há nome em lugar nenhum da resposta.** 3.589 entradas, zero com nome de
 * outcome. A identidade dos lados é a ordem dos ids, e essa é a única suposição
 * do arquivo — declarada em `sideByOutcomeOrder` e no `side_source` do payload.
 *
 * ---------------------------------------------------------------------------
 * POINT-IN-TIME: `false`, POR AUSÊNCIA DE GARANTIA
 * ---------------------------------------------------------------------------
 *
 * E a distinção contra a Liquipedia é o ponto. Lá o `false` é por DEFEITO
 * CONHECIDO: a wiki é editada retroativamente, por desenho, e isso não muda.
 * Aqui não há defeito conhecido — há ausência de promessa. `/v4/historical-odds`
 * traz `createdAt` por entrada, o que faria a série ser point-in-time de
 * verdade; o que falta é saber se o que está gravado naquele carimbo continua o
 * mesmo daqui a duas semanas. A doc não promete e o Discord não respondeu.
 *
 * **A medição está pendente, e o snapshot já foi gravado** (`--snapshot` da
 * sonda). O critério exato que vira a flag está em `specs/001-esports-vertical.md`,
 * Parte D. Enquanto isso, `false` é a direção segura do erro: um `true` errado
 * faz o backtest ler uma série que não é a de então e acertar por engano; um
 * `false` errado só custa cobertura.
 *
 * Isto NÃO bloqueia o enricher. Ele coleta, grava e serve a análise em tempo
 * real normalmente. `false` o mantém fora de UMA coisa — o replay do eval.
 *
 * Ainda assim, tudo aqui respeita `asOf` internamente: a linha é a última
 * entrada com `createdAt <= asOf`, nunca a última entrada. Isso é o que torna a
 * virada da flag uma mudança de uma linha, e não uma reescrita.
 *
 * ---------------------------------------------------------------------------
 * O TIER GRATUITO É CORTESIA
 * ---------------------------------------------------------------------------
 *
 * 250 requisições billable por mês, sem contador observável, e um acesso que
 * pode sumir sem aviso. Três consequências, todas implementadas:
 *
 *   1. **A descoberta é memoizada em `esports_matches.external_ids`.** Uma
 *      partida custa no máximo UMA janela de `/v4/fixtures` na vida, e a janela
 *      serve todas as partidas do mesmo dia. Reaprender depois de um deploy
 *      custa zero.
 *
 *   2. **Nada aqui levanta exceção para o ciclo.** Corte de acesso, orçamento no
 *      fim, 429, timeout — todos viram aviso e lista vazia. O ciclo do enricher
 *      continua, e os outros três enrichers continuam produzindo.
 *
 *   3. **O dado coletado vive no banco.** O fragmento é auto-suficiente: preço,
 *      probabilidade já normalizada, janela coberta, cobertura por casa e método
 *      de casamento de lado, tudo no payload. Nenhuma leitura posterior — nem a
 *      do analista, nem a do eval — precisa falar com a OddsPapi. Se o tier
 *      sumir amanhã, o que já foi gravado continua valendo integralmente.
 */

export const ODDSPAPI_ID = 'oddspapi';

/**
 * Só `cs2`, e pelo mesmo motivo de `SPORT_ID_BY_VERTICAL`: os `sportId` de LoL e
 * Dota 2 estão anotados na sonda como "conferir com /v4/sports depois", e essa
 * conferência não aconteceu. Vertical entra aqui quando o id dela for medido.
 */
const ODDSPAPI_VERTICALS = Object.keys(SPORT_ID_BY_VERTICAL);

/**
 * Confiança do fragmento de linha.
 *
 * Acima da Liquipedia (0,7) porque é dado de mercado com dinheiro atrás, não
 * wiki editável: a Pinnacle move a linha porque alguém apostou. Abaixo de 1,0
 * porque chega por um agregador cuja imutabilidade não está verificada, e porque
 * a densidade medida mostra que a qualidade varia muito entre casas.
 */
export const ODDS_CONFIDENCE = 0.8;

/**
 * Confiança do fragmento de suspensão — mais baixa, e de propósito.
 *
 * O FATO (a casa marcou `active = false` neste intervalo) é certo. A LEITURA não
 * é: 138/150 blocos reabrem em preço diferente, o que sustenta "suspensão real",
 * mas ~50% dos blocos da Stake coincidem com outra casa, o que sustenta "falha
 * de feed" nos mesmos dados. Um fragmento que afirmasse a interpretação com a
 * confiança do fato estaria mentindo sobre o que se sabe.
 */
export const SUSPENSION_CONFIDENCE = 0.6;

/**
 * Quanto a última linha de uma casa pode estar atrás do `asOf` e ainda entrar no
 * consenso.
 *
 * Uma hora. Casa que não move há mais que isso não está discordando do
 * Polymarket — está desligada, e somar a linha velha dela ao consenso puxaria a
 * mediana para um preço que ninguém oferece. Ela continua no payload, com
 * `staleSeconds`: ausência de atualização é dado, só não é cotação.
 */
export const CONSENSUS_MAX_STALE_SECONDS = 3_600;

/** Blocos de `false` a esta distância contam como o mesmo evento entre casas. */
export const COINCIDENCE_TOLERANCE_MS = 60_000;

/**
 * Folga exigida além da espera do cooldown para entrar numa chamada.
 *
 * A espera é o custo conhecido; isto cobre o resto — a requisição em si, o
 * parsing de milhares de entradas e a escrita do fragmento. Entrar numa chamada
 * com o prazo justo produz exatamente o que o orçamento existe para evitar: a
 * espera cabe, a resposta não, e o ciclo estoura mesmo assim.
 */
export const CALL_HEADROOM_MS = 4_000;

/**
 * Cabe fazer esta chamada no que resta do ciclo?
 *
 * Devolve o motivo quando NÃO cabe, para virar recusa nomeada em vez de silêncio
 * — ou `null` quando cabe. Sem prazo (`deadline` ausente), sempre cabe: é o caso
 * do backfill, que pode demorar o que precisar.
 */
export function callFitsBudget(path: string, remaining: number, now = Date.now()): string | null {
  if (!Number.isFinite(remaining)) return null;

  const wait = waitMsFor(path, now);
  const needed = wait + CALL_HEADROOM_MS;
  if (needed <= remaining) return null;

  return (
    `orçamento de tempo do ciclo: ${path} exige ${Math.round(needed / 1000)}s ` +
    `(${Math.round(wait / 1000)}s de cooldown) e restam ${Math.round(remaining / 1000)}s`
  );
}

/**
 * O mercado lido, na taxonomia deles.
 *
 * `171` sai da medição: numa fixture de CS2 a Pinnacle devolveu 7 mercados e a
 * Stake 4, e `171` é o mais denso (688+689 entradas na Pinnacle) e o único
 * presente nas duas casas com esse peso — a assinatura do moneyline. Os outros
 * (173, 1725, 1737, 1747, 1749, 1751) são derivados.
 *
 * Fica em config porque é a taxonomia DELES e não foi documentada: `/v4/markets`
 * não foi sondado. Se o número mudar, muda um UPDATE, não um deploy — e o
 * `coverage.markets_seen` do payload é o que denuncia o dia em que ele mudar.
 */
export const DEFAULT_MARKET_ID = '171';

/** Quantos blocos de suspensão entram no payload, do mais recente para trás. */
const MAX_BLOCKS_IN_PAYLOAD = 20;

/**
 * Quanto tempo uma fixture não encontrada fica sem ser reprocurada.
 *
 * Cache negativo, e ele é o que protege o orçamento: sem isso, partida que a
 * OddsPapi não cobre — e são muitas, o CS2 de tier baixo não interessa a casa
 * nenhuma — gastaria uma janela billable a cada ciclo, para sempre.
 *
 * O carimbo só pode ser gravado a partir de resposta de REDE. Ver
 * `mergeFixtureIds`: com `FIXTURES_CACHE_SECONDS` em horas, os dois caches se
 * multiplicavam e um atraso de cadastro do lado deles virava mais de um dia de
 * silêncio nosso.
 */
const MISSING_RECHECK_HOURS = 24;

// ---------------------------------------------------------------------------
// Funções puras — testáveis sem banco e sem rede
// ---------------------------------------------------------------------------

/** lowercase, sem acento, sem pontuação. Mesmo normalizador da sonda. */
export function normalize(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

export type PriceFormat = 'decimal' | 'probability' | 'unknown';

/**
 * Odds decimal ou probabilidade?
 *
 * A sonda mediu preços como 1,8 e 2,05 — odds decimal. Mas isso não está
 * documentado, e inverter os dois é a única forma de este enricher produzir um
 * número catastroficamente errado com cara de certo: 1/0,55 = 1,82 é uma odd
 * perfeitamente plausível, e 1/1,82 = 0,55 é uma probabilidade perfeitamente
 * plausível. Não há como recuperar depois.
 *
 * O que separa os dois sem ambiguidade: odd decimal é SEMPRE > 1 (a odd 1,0
 * paga o que você apostou, e ninguém oferece menos). Probabilidade é sempre
 * <= 1. Uma amostra inteiramente > 1 é decimal; inteiramente <= 1 é
 * probabilidade; misturada é forma desconhecida, e aí o enricher não converte
 * nada.
 */
export function priceFormatOf(prices: readonly number[]): PriceFormat {
  const valid = prices.filter((p) => Number.isFinite(p) && p > 0);
  if (valid.length === 0) return 'unknown';
  if (valid.every((p) => p > 1)) return 'decimal';
  if (valid.every((p) => p <= 1)) return 'probability';
  return 'unknown';
}

/** A probabilidade implícita, ou `null` quando a forma não é conhecida. */
export function toProbability(price: number | null, format: PriceFormat): number | null {
  if (price === null || !Number.isFinite(price) || price <= 0) return null;
  if (format === 'decimal') return 1 / price;
  if (format === 'probability') return price;
  return null;
}

/**
 * As duas probabilidades sem a margem da casa.
 *
 * A soma das implícitas passa de 1 — a diferença é o overround, o lucro embutido
 * da casa. Comparar `1/odd` cru com o preço do Polymarket compara duas coisas
 * diferentes: um é probabilidade com margem, o outro é preço de mercado que já
 * é probabilidade. Normalizar para somar 1 é o que torna os dois comparáveis.
 *
 * `null` quando falta um dos lados: com um lado só não há como saber quanto da
 * probabilidade é margem, e um "justo" inventado a partir de metade da
 * informação é pior que nenhum.
 */
export function fairPair(
  impliedA: number | null,
  impliedB: number | null,
): { fairA: number; fairB: number; overround: number } | null {
  if (impliedA === null || impliedB === null) return null;

  const total = impliedA + impliedB;
  if (!Number.isFinite(total) || total <= 0) return null;

  return { fairA: impliedA / total, fairB: impliedB / total, overround: total - 1 };
}

export function median(values: readonly number[]): number | null {
  const sorted = [...values].filter(Number.isFinite).sort((a, b) => a - b);
  if (sorted.length === 0) return null;

  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle] as number;
  return ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2;
}

function timeOf(iso: string | null): number | null {
  if (iso === null) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

/** O caminho sem o índice final: identifica a série a que a entrada pertence. */
export function seriesKeyOf(path: string): string {
  return path.replace(/\.\d+$/, '');
}

export type Side = 'a' | 'b';

/**
 * De que lado esta entrada fala, quando a entrada tem NOME.
 *
 * Caminho preferido, e hoje inalcançável: a resposta real de CS2 não traz nome
 * em nível nenhum (medido, 3.589 entradas, todas sem). Fica porque nome é
 * identidade e ordem é convenção — se um dia aparecer, ele ganha de
 * `sideByOutcomeOrder` sem mudar mais nada.
 *
 * Apelido reivindicado pelos dois lados não é lado: é config errada, e escolher
 * um seria adivinhar.
 */
export function sideOf(
  outcome: string | null,
  aliasesA: readonly string[],
  aliasesB: readonly string[],
): Side | null {
  if (outcome === null) return null;
  const key = normalize(outcome);
  if (key.length === 0) return null;

  const inA = aliasesA.some((alias) => normalize(alias) === key);
  const inB = aliasesB.some((alias) => normalize(alias) === key);

  if (inA && inB) return null;
  if (inA) return 'a';
  if (inB) return 'b';
  return null;
}

/**
 * O lado pela ORDEM dos ids de outcome dentro do mercado.
 *
 * ---------------------------------------------------------------------------
 * ISTO É UMA SUPOSIÇÃO, E É A ÚNICA DESTE ARQUIVO
 * ---------------------------------------------------------------------------
 *
 * O que está MEDIDO: cada mercado tem exatamente 2 outcomes, com ids
 * consecutivos (`171` -> `171`,`172`; `1747` -> `1747`,`1748`), e os mesmos ids
 * aparecem nas duas casas — é taxonomia global deles, não numeração por fixture.
 *
 * O que está SUPOSTO: que o outcome de id MENOR é o `participant1` da fixture, e
 * o maior é o `participant2`. Nada na resposta confirma isso, porque não há nome
 * nem referência a participante em lugar nenhum dela.
 *
 * Por que é aceitável mesmo assim, tendo eu recusado a queda por posição no
 * `sideOf`: lá a alternativa era o nome, que existia. Aqui não existe
 * alternativa — sem esta suposição a fonte inteira é inutilizável, porque
 * nenhuma linha pode ser atribuída a um time. A diferença entre suposição e
 * medida está declarada no payload (`side_source`) e no `summary`, então nada
 * a jusante a confunde com fato.
 *
 * Como confirmar, e é barato: a resposta de `/v4/fixtures` traz
 * `participant1Name`/`participant2Name`, e a sonda a imprime crua
 * (`npm run oddspapi:probe -- --fixture=<id>`). Basta uma partida com favorito
 * claro — se a odd do outcome menor for a do participant1 e o favorito bater, a
 * suposição vira medida e este comentário vira uma linha.
 *
 * A guarda: exatamente 2 outcomes, com ids consecutivos. Qualquer outra forma
 * devolve `null` e a casa fica sem lado, em vez de receber um lado inventado.
 */
export function sideByOutcomeOrder(
  outcomeIds: readonly string[],
  sideAIndex: 1 | 2,
): Map<string, Side> | null {
  if (outcomeIds.length !== 2) return null;

  const sorted = [...outcomeIds].sort((x, y) => Number(x) - Number(y));
  const [first, second] = sorted as [string, string];

  const nFirst = Number(first);
  const nSecond = Number(second);
  if (!Number.isFinite(nFirst) || !Number.isFinite(nSecond)) return null;
  if (nSecond - nFirst !== 1) return null;

  return new Map<string, Side>([
    [first, sideAIndex === 1 ? 'a' : 'b'],
    [second, sideAIndex === 1 ? 'b' : 'a'],
  ]);
}

export interface LineAtAsOf {
  /**
   * O preço, SEMPRE da última entrada ATIVA. Ver a nota sobre espelhamento.
   */
  readonly price: number | null;
  readonly limit: number | null;
  readonly priceAt: string | null;
  /** Idade do PREÇO. É esta que decide entrada no consenso. */
  readonly priceStaleSeconds: number | null;
  /** O estado no instante do `asOf`, do último registro qualquer. */
  readonly active: boolean | null;
  readonly at: string | null;
  readonly staleSeconds: number | null;
}

/**
 * A linha no instante do `asOf` — estado e preço, de fontes deliberadamente
 * diferentes.
 *
 * ---------------------------------------------------------------------------
 * O PREÇO DA LINHA SUSPENSA VEM ESPELHADO, E ISSO FOI MEDIDO
 * ---------------------------------------------------------------------------
 *
 * No snapshot real (fixture `id1705104272533134`, 2026-08-08): em **64 dos 75**
 * instantes com `active = false` na Pinnacle, os dois outcomes trocam de preço
 * em relação ao último par ativo. O outcome 171 fecha registrando 3,1 quando o
 * último preço ativo dele era 1,336 — e 3,1 é exatamente o preço do outcome 172.
 * Na Stake, 0 de 16: ela repete o preço anterior.
 *
 * Que a orientação CERTA é a das entradas ativas, e não a das suspensas, tem
 * confirmação independente: na abertura as duas casas concordam que o 171 é o
 * azarão (3,74 na Pinnacle, 3,1 na Stake) e no último par ativo as duas
 * concordam que ele virou favorito (1,336 e 1,5). Só as linhas suspensas da
 * Pinnacle discordam — de si mesmas e da Stake.
 *
 * Ler o preço da entrada suspensa produziria o MERCADO ESPELHADO exatamente
 * quando o `asOf` cai dentro de uma suspensão. É o mesmo erro catastrófico que
 * `sideByOutcomeOrder` existe para evitar, chegando por outra porta — e sem
 * sintoma nenhum, porque uma probabilidade invertida é uma probabilidade
 * plausível.
 *
 * Daí a separação:
 *
 *   `active`/`at`   — do ÚLTIMO registro qualquer. É o estado do mercado, e é
 *                     informação que o agente deve ver (medido: suspensão é
 *                     real, 138/150 blocos reabrem em outro preço).
 *   `price`/`limit` — da última entrada ATIVA. É a última cotação em que a casa
 *                     de fato se comprometeu.
 *
 * Não é filtrar o `false`: ele continua no fragmento, no estado e nos blocos de
 * suspensão. É não usar como cotação um número que foi medido como não sendo
 * cotação.
 *
 * Entrada sem carimbo é descartada dos dois lados: sem `createdAt` não há como
 * afirmar que ela existia no instante pedido, e incluí-la é o vazamento de
 * futuro que `enricher.ts` descreve.
 */
export function lineAtAsOf(entries: readonly OddsEntry[], asOf: Date): LineAtAsOf | null {
  const asOfMs = asOf.getTime();

  let last: OddsEntry | null = null;
  let lastMs = -Infinity;
  let lastActive: OddsEntry | null = null;
  let lastActiveMs = -Infinity;

  for (const entry of entries) {
    const ms = timeOf(entry.createdAt);
    if (ms === null || ms > asOfMs) continue;

    if (ms >= lastMs) {
      last = entry;
      lastMs = ms;
    }
    // `active === null` (campo ausente) conta como cotação: onde a casa não
    // reporta o estado, o preço é tudo o que ela dá, e recusá-lo apagaria a
    // fonte inteira. O espelhamento medido é do `false` explícito.
    if (entry.active !== false && ms >= lastActiveMs) {
      lastActive = entry;
      lastActiveMs = ms;
    }
  }

  if (last === null) return null;

  return {
    price: lastActive?.price ?? null,
    limit: lastActive?.limit ?? null,
    priceAt: lastActive?.createdAt ?? null,
    priceStaleSeconds: lastActive === null ? null : Math.round((asOfMs - lastActiveMs) / 1000),
    active: last.active,
    at: last.createdAt,
    staleSeconds: Math.round((asOfMs - lastMs) / 1000),
  };
}

export interface SuspensionBlock {
  readonly bookmaker: string;
  readonly series: string;
  readonly startAt: string | null;
  readonly endAt: string | null;
  readonly entries: number;
  /** `true` = há entrada ativa dos dois lados: o true→false→true completo. */
  readonly enclosed: boolean;
  readonly priceBefore: number | null;
  readonly priceAfter: number | null;
  readonly priceChanged: boolean;
}

/**
 * Os blocos de `active = false` de uma casa, série por série.
 *
 * Entradas com `active = null` são puladas: onde o campo não existe não há o que
 * medir, e preencher o buraco com um palpite fabricaria ou apagaria bloco.
 *
 * A separação por SÉRIE (caminho sem o índice) é o que impede o artefato: sem
 * ela, as entradas de todos os mercados e outcomes de uma casa virariam uma
 * sequência só, e a alternância medida seria o intercalamento de séries
 * distintas — comportamento da coleta, não da casa.
 */
export function suspensionBlocks(
  bookmaker: string,
  entries: readonly OddsEntry[],
  asOf: Date,
): SuspensionBlock[] {
  const asOfMs = asOf.getTime();
  const bySeries = new Map<string, OddsEntry[]>();

  for (const entry of entries) {
    if (entry.active === null) continue;
    const ms = timeOf(entry.createdAt);
    if (ms === null || ms > asOfMs) continue;

    const key = seriesKeyOf(entry.path);
    const bucket = bySeries.get(key);
    if (bucket === undefined) bySeries.set(key, [entry]);
    else bucket.push(entry);
  }

  const blocks: SuspensionBlock[] = [];

  for (const [series, rows] of bySeries) {
    const sorted = [...rows].sort(
      (a, b) => (timeOf(a.createdAt) ?? 0) - (timeOf(b.createdAt) ?? 0),
    );

    let i = 0;
    while (i < sorted.length) {
      if (sorted[i]?.active !== false) {
        i += 1;
        continue;
      }

      const start = i;
      while (i < sorted.length && sorted[i]?.active === false) i += 1;
      const end = i - 1;

      const before = start > 0 ? sorted[start - 1] : undefined;
      const after = i < sorted.length ? sorted[i] : undefined;
      const priceBefore = before?.price ?? null;
      const priceAfter = after?.price ?? null;

      blocks.push({
        bookmaker,
        series,
        startAt: sorted[start]?.createdAt ?? null,
        endAt: sorted[end]?.createdAt ?? null,
        entries: end - start + 1,
        enclosed: before !== undefined && after !== undefined,
        priceBefore,
        priceAfter,
        priceChanged: priceBefore !== null && priceAfter !== null && priceBefore !== priceAfter,
      });
    }
  }

  return blocks;
}

/** Dois blocos se sobrepõem, dada a tolerância. Bloco de instante único conta. */
export function blocksCoincide(
  a: SuspensionBlock,
  b: SuspensionBlock,
  toleranceMs = COINCIDENCE_TOLERANCE_MS,
): boolean {
  const aStart = timeOf(a.startAt);
  const aEnd = timeOf(a.endAt);
  const bStart = timeOf(b.startAt);
  const bEnd = timeOf(b.endAt);
  if (aStart === null || aEnd === null || bStart === null || bEnd === null) return false;

  return aStart - toleranceMs <= bEnd && bStart - toleranceMs <= aEnd;
}

/** As casas, além da própria, que suspenderam junto com este bloco. */
export function coincidentBookmakers(
  block: SuspensionBlock,
  all: readonly SuspensionBlock[],
  toleranceMs = COINCIDENCE_TOLERANCE_MS,
): string[] {
  const others = new Set<string>();
  for (const other of all) {
    if (other.bookmaker === block.bookmaker) continue;
    if (blocksCoincide(block, other, toleranceMs)) others.add(other.bookmaker);
  }
  return [...others].sort();
}

export interface BookLine {
  readonly bookmaker: string;
  /** Entradas da casa na resposta inteira — todos os mercados. */
  readonly entries: number;
  /** Entradas no mercado que está sendo lido. É a base da linha. */
  readonly entriesInMarket: number;
  /** Os mercados que esta casa cota. Medido: 7 na Pinnacle, 4 na Stake. */
  readonly marketsSeen: readonly string[];
  readonly a: LineAtAsOf | null;
  readonly b: LineAtAsOf | null;
  readonly impliedA: number | null;
  readonly impliedB: number | null;
  readonly fairA: number | null;
  readonly fairB: number | null;
  readonly overround: number | null;
  /** Entrou na mediana? `false` com o motivo é mais útil que sumir do payload. */
  readonly inConsensus: boolean;
  readonly excludedBecause: string | null;
  /** Janela realmente coberta por esta casa, até o `asOf`. */
  readonly from: string | null;
  readonly to: string | null;
}

export interface Coverage {
  readonly requested: readonly string[];
  readonly present: readonly string[];
  /** Pedidas e ausentes da resposta. Medido: é NORMAL, não lacuna. */
  readonly absent: readonly string[];
  /** Presentes mas sem lado identificável por nome. */
  readonly unmatched: readonly string[];
  /** As que reportam `limit`. Medido: só a Pinnacle. */
  readonly withLimit: readonly string[];
  /** Todos os mercados vistos na resposta. Denuncia se o mercado lido sumir. */
  readonly marketsSeen: readonly string[];
}

export interface SideResolution {
  readonly aliasesA: readonly string[];
  readonly aliasesB: readonly string[];
  /** Qual participante da fixture é o NOSSO time A. Vem do casamento por nome. */
  readonly sideAIndex: 1 | 2;
  /** O mercado a ler. Medido: `171` é o mais denso e o único presente nas duas casas. */
  readonly marketId: string;
}

/**
 * A linha de cada casa no instante do `asOf`, no mercado escolhido.
 *
 * ## Um mercado, não sete
 *
 * Medido: a Pinnacle devolve 7 mercados para uma fixture de CS2 (171, 173, 1725,
 * 1737, 1747, 1749, 1751), a Stake devolve 4. Misturar todos produziria uma
 * "linha" que é a última entrada de qualquer mercado — handicap de mapa,
 * total de rounds, vencedor do mapa 2 — comparada com o moneyline do
 * Polymarket. Comparação sem sentido, e sem sintoma.
 *
 * Então lê-se UM mercado, declarado em config, e o payload registra qual. Os
 * outros continuam contando para a suspensão, que é evento da casa e não da
 * linha.
 *
 * ## O formato do preço é decidido uma vez
 *
 * Sobre a amostra inteira, não por casa: casas cotando em formatos diferentes na
 * mesma resposta seria anomalia da fonte, e resolvê-la casa a casa a esconderia
 * em vez de expô-la.
 */
export function buildBookLines(
  perBook: ReadonlyMap<string, OddsEntry[]>,
  sides: SideResolution,
  asOf: Date,
): { lines: BookLine[]; format: PriceFormat; sideSource: 'name' | 'outcome_order' | 'none' } {
  const allPrices: number[] = [];
  for (const entries of perBook.values()) {
    for (const entry of entries) {
      if (entry.price !== null) allPrices.push(entry.price);
    }
  }
  const format = priceFormatOf(allPrices);

  const lines: BookLine[] = [];
  let sideSource: 'name' | 'outcome_order' | 'none' = 'none';

  for (const [bookmaker, entries] of perBook) {
    // Só o mercado pedido. Entrada fora dele não é lado nenhum aqui.
    const inMarket = entries.filter(
      (entry) => marketOutcomeOf(entry.path)?.marketId === sides.marketId,
    );

    const outcomeIds = [
      ...new Set(
        inMarket
          .map((entry) => marketOutcomeOf(entry.path)?.outcomeId)
          .filter((id): id is string => id !== undefined),
      ),
    ];
    const byOrder = sideByOutcomeOrder(outcomeIds, sides.sideAIndex);

    const sideA: OddsEntry[] = [];
    const sideB: OddsEntry[] = [];
    for (const entry of inMarket) {
      // Nome ganha de ordem sempre que existir — ver `sideByOutcomeOrder`.
      const byName = sideOf(entry.outcome, sides.aliasesA, sides.aliasesB);
      const outcomeId = marketOutcomeOf(entry.path)?.outcomeId;
      const side = byName ?? (outcomeId === undefined ? null : (byOrder?.get(outcomeId) ?? null));

      if (byName !== null) sideSource = 'name';
      else if (side !== null && sideSource !== 'name') sideSource = 'outcome_order';

      if (side === 'a') sideA.push(entry);
      else if (side === 'b') sideB.push(entry);
    }

    const a = lineAtAsOf(sideA, asOf);
    const b = lineAtAsOf(sideB, asOf);

    const impliedA = toProbability(a?.price ?? null, format);
    const impliedB = toProbability(b?.price ?? null, format);
    const fair = fairPair(impliedA, impliedB);

    const stamps = [...sideA, ...sideB]
      .map((e) => e.createdAt)
      .filter((s): s is string => s !== null && (timeOf(s) ?? Infinity) <= asOf.getTime())
      .sort();

    // Idade do PREÇO, não do último registro: uma casa que continua emitindo
    // linhas suspensas parece fresca e não está cotando nada.
    const stale = Math.max(a?.priceStaleSeconds ?? Infinity, b?.priceStaleSeconds ?? Infinity);
    const excludedBecause =
      fair === null
        ? entries.length === 0
          ? 'casa ausente da resposta'
          : inMarket.length === 0
            ? `casa não cota o mercado ${sides.marketId}`
            : a === null && b === null
              ? 'nenhum lado identificado — sem nome e sem par de outcomes consecutivos'
              : 'só um lado cotado — sem par não dá para tirar a margem'
        : stale > CONSENSUS_MAX_STALE_SECONDS
          ? `linha parada há ${Math.round(stale / 60)} min`
          : null;

    lines.push({
      bookmaker,
      entries: entries.length,
      entriesInMarket: inMarket.length,
      marketsSeen: [
        ...new Set(
          entries
            .map((e) => marketOutcomeOf(e.path)?.marketId)
            .filter((m): m is string => m !== undefined),
        ),
      ].sort((x, y) => Number(x) - Number(y)),
      a,
      b,
      impliedA,
      impliedB,
      fairA: fair?.fairA ?? null,
      fairB: fair?.fairB ?? null,
      overround: fair?.overround ?? null,
      inConsensus: excludedBecause === null,
      excludedBecause,
      from: stamps[0] ?? null,
      to: stamps[stamps.length - 1] ?? null,
    });
  }

  return { lines, format, sideSource };
}

export function coverageOf(requested: readonly string[], lines: readonly BookLine[]): Coverage {
  const present = lines.filter((l) => l.entries > 0).map((l) => l.bookmaker);
  const presentSet = new Set(present);

  return {
    requested: [...requested],
    present,
    absent: requested.filter((slug) => !presentSet.has(slug)),
    // Presente na resposta e sem lado atribuível. Distinto de `absent`: aqui a
    // casa cotou e nós é que não soubemos ler.
    unmatched: lines
      .filter((l) => l.entries > 0 && l.a === null && l.b === null)
      .map((l) => l.bookmaker),
    // Medido: só a Pinnacle, 3487/3487. É por isso que o consenso não pondera.
    withLimit: lines
      .filter((l) => l.a?.limit !== null && l.a?.limit !== undefined)
      .map((l) => l.bookmaker),
    marketsSeen: [...new Set(lines.flatMap((l) => l.marketsSeen))].sort(
      (x, y) => Number(x) - Number(y),
    ),
  };
}

/** A mediana das probabilidades justas das casas que entraram no consenso. */
export function consensusOf(lines: readonly BookLine[]): {
  fairA: number | null;
  fairB: number | null;
  books: number;
} {
  const inside = lines.filter((l) => l.inConsensus);
  const fairA = median(inside.map((l) => l.fairA).filter((v): v is number => v !== null));
  const fairB = median(inside.map((l) => l.fairB).filter((v): v is number => v !== null));

  return { fairA, fairB, books: inside.length };
}

function pct(value: number | null): string {
  return value === null ? '?' : `${(value * 100).toFixed(1)}%`;
}

function hoursBetween(from: string | null, to: string | null): number | null {
  const a = timeOf(from);
  const b = timeOf(to);
  if (a === null || b === null) return null;
  return Math.round(((b - a) / 3_600_000) * 10) / 10;
}

/**
 * O texto que o analista lê.
 *
 * Diz a janela coberta de propósito: são ~19h medidas, o dia da partida. Um
 * consumidor que leia "linha das casas" sem esse número assume linha de abertura
 * e conclui coisas sobre movimento que os dados não sustentam.
 */
export function buildOddsSummary(
  nameA: string,
  nameB: string,
  lines: readonly BookLine[],
  consensus: { fairA: number | null; fairB: number | null; books: number },
  coverage: Coverage,
  format: PriceFormat,
  sideSource: 'name' | 'outcome_order' | 'none' = 'none',
): string {
  const parts: string[] = [];

  const quoted = lines.filter((l) => l.fairA !== null);
  if (quoted.length === 0) {
    return (
      `Nenhuma casa cotou ${nameA} x ${nameB} de forma comparável ` +
      `(pedidas: ${coverage.requested.join(', ')}; presentes: ${coverage.present.join(', ') || 'nenhuma'}). ` +
      `Casa ausente é normal nesta fonte e não é sinal.`
    );
  }

  // Havia cotação em alguma casa, mas nenhuma sobreviveu ao filtro do consenso —
  // todas paradas, suspensas sem preço ativo, ou com um lado só.
  //
  // O texto tinha um bug aqui: a frase do consenso era montada de qualquer jeito
  // e saía `consenso (mediana de 0) ? para <time>`. Uma mediana de zero casas
  // não é um consenso fraco, é a AUSÊNCIA de consenso — e `?` no lugar de uma
  // probabilidade é a forma mais fácil de o agente ler ausência como número.
  // Quem produz o fragmento tem que dizer o que ele não tem.
  if (consensus.books === 0 || consensus.fairA === null) {
    parts.push(
      `SEM CONSENSO de casas para ${nameA} x ${nameB}: nenhuma das ${quoted.length} ` +
        `casa(s) com cotação tem linha ativa e recente o bastante para comparar com ` +
        `o preço do Polymarket. O que segue é o último preço de cada uma, com a idade — ` +
        `serve para ver que o mercado delas parou, não como estimativa.`,
    );
  } else {
    parts.push(
      `Casas de aposta em ${nameA} x ${nameB}: consenso (mediana de ${consensus.books}) ` +
        `${pct(consensus.fairA)} para ${nameA}, já sem a margem.`,
    );
  }

  const perBook = quoted
    .map(
      (l) =>
        `${l.bookmaker} ${pct(l.fairA)}` +
        (l.a?.active === false || l.b?.active === false ? ' (mercado suspenso agora)' : '') +
        (l.inConsensus ? '' : ` [fora do consenso: ${l.excludedBecause}]`),
    )
    .join('; ');
  parts.push(`Por casa: ${perBook}.`);

  if (quoted.some((l) => l.a?.active === false || l.b?.active === false)) {
    parts.push(
      `Onde diz suspenso, o preço citado é a última cotação ATIVA da casa, ` +
        `não o número da linha suspensa — esse vem trocado entre os dois lados na Pinnacle.`,
    );
  }

  if (sideSource === 'outcome_order') {
    parts.push(
      `Os lados foram atribuídos pela ordem dos ids de outcome: a resposta não ` +
        `traz nome de time. É a única suposição deste dado.`,
    );
  }

  const windows = quoted
    .map((l) => hoursBetween(l.from, l.to))
    .filter((h): h is number => h !== null);
  const widest = windows.length > 0 ? Math.max(...windows) : null;
  if (widest !== null) {
    parts.push(
      `A série cobre ~${widest}h até o instante avaliado — é o dia da partida, ` +
        `não linha de abertura de semanas atrás.`,
    );
  }

  if (coverage.absent.length > 0) {
    parts.push(`Sem dado: ${coverage.absent.join(', ')} — ausência é normal aqui, não sinal.`);
  }
  if (coverage.withLimit.length > 0) {
    parts.push(`Stake máximo reportado só por: ${coverage.withLimit.join(', ')}.`);
  }
  if (format === 'unknown') {
    parts.push(`ATENÇÃO: formato de preço não reconhecido — nenhuma conversão foi feita.`);
  }

  return parts.join(' ');
}

export function buildSuspensionSummary(
  nameA: string,
  nameB: string,
  blocks: readonly SuspensionBlock[],
  suspendedNow: readonly string[],
): string {
  const enclosed = blocks.filter((b) => b.enclosed);
  const changed = enclosed.filter((b) => b.priceChanged);
  const coincident = blocks.filter((b) => coincidentBookmakers(b, blocks).length > 0);

  const parts: string[] = [
    `Suspensões de mercado em ${nameA} x ${nameB}: ${blocks.length} bloco(s) de linha inativa ` +
      `até o instante avaliado, ${enclosed.length} já reabertos, ${changed.length} deles em preço diferente.`,
  ];

  if (suspendedNow.length > 0) {
    parts.push(`Suspensa AGORA em: ${suspendedNow.join(', ')}.`);
  }

  if (changed.length > 0) {
    parts.push(
      `Reabrir em outro preço é a casa tendo reprecificado enquanto estava fora — ` +
        `é discordância dela com ela mesma, e costuma marcar algo acontecendo na partida.`,
    );
  }

  if (coincident.length > 0) {
    parts.push(
      `${coincident.length} bloco(s) coincidem no tempo com outra casa. Isso tem duas ` +
        `leituras possíveis e os dados não separam: evento real da partida (todas reagem ` +
        `juntas) ou falha do feed do agregador (todas somem juntas).`,
    );
  }

  return parts.join(' ');
}

// ---------------------------------------------------------------------------
// Identidade: a nossa partida na fixture deles
// ---------------------------------------------------------------------------

interface MatchRow {
  id: string;
  vertical_id: string;
  scheduled_at: string | null;
  external_ids: Record<string, unknown> | null;
  /** Nome E código de cada lado: o código é o degrau de fallback do casador. */
  keyA: TeamKey;
  keyB: TeamKey;
}

export interface FixtureLink {
  readonly fixtureId: string;
  readonly aliasesA: readonly string[];
  readonly aliasesB: readonly string[];
  /**
   * Qual participante da fixture DELES é o nosso time A: 1 ou 2.
   *
   * Sai do casamento por nome, que é medida. É o que `sideByOutcomeOrder`
   * consome para transformar a ordem dos ids de outcome em lado — e é por isso
   * que ele fica gravado junto com os apelidos: sem ele, o cache não basta.
   */
  readonly sideAIndex: 1 | 2;
}

/**
 * O que `external_ids` já sabe sobre a fixture: encontrada, ausente recente, ou
 * nada.
 *
 * Mesma memoização que o enricher da Liquipedia faz com a página do time, e pelo
 * mesmo motivo elevado ao quadrado: lá o orçamento é de 60 por hora, aqui é de
 * 250 por MÊS. Sem cache negativo, uma partida que a OddsPapi não cobre custaria
 * uma janela billable a cada ciclo, para sempre.
 */
export function readCachedFixture(
  externalIds: Record<string, unknown> | null,
  now: Date,
): { kind: 'fixture'; link: FixtureLink } | { kind: 'missing' } | { kind: 'unknown' } {
  if (externalIds === null) return { kind: 'unknown' };

  const id = externalIds['oddspapi_fixture_id'];
  const aliasesA = externalIds['oddspapi_aliases_a'];
  const aliasesB = externalIds['oddspapi_aliases_b'];
  const sideAIndex = externalIds['oddspapi_side_a_index'];

  if (
    typeof id === 'string' &&
    id.trim().length > 0 &&
    Array.isArray(aliasesA) &&
    Array.isArray(aliasesB) &&
    (sideAIndex === 1 || sideAIndex === 2)
  ) {
    return {
      kind: 'fixture',
      link: {
        fixtureId: id.trim(),
        aliasesA: aliasesA.filter((v): v is string => typeof v === 'string'),
        aliasesB: aliasesB.filter((v): v is string => typeof v === 'string'),
        sideAIndex,
      },
    };
  }

  const checkedAt = externalIds['oddspapi_missing_at'];
  if (typeof checkedAt === 'string') {
    const ageHours = (now.getTime() - new Date(checkedAt).getTime()) / 3_600_000;
    if (Number.isFinite(ageHours) && ageHours < MISSING_RECHECK_HOURS) return { kind: 'missing' };
  }

  return { kind: 'unknown' };
}

/**
 * O resultado de uma busca de fixture, com a procedência quando deu em nada.
 *
 * O ramo `absent` EXIGE `source`, e é aí que o tipo faz o trabalho: não existe
 * como registrar uma ausência sem antes dizer se ela veio da rede ou de uma
 * lista em cache. Um booleano opcional no retorno de `fixtures()` seria
 * esquecível — este não é. É a razão de a procedência não morar numa variável
 * de módulo: `ultimaChamadaVeioDoCache` seria consultável de qualquer lugar,
 * inclusive dos lugares errados, e não obrigaria ninguém a nada.
 */
export type FixtureOutcome =
  | { readonly kind: 'found'; readonly link: FixtureLink & { tier?: MatchTier } }
  | { readonly kind: 'absent'; readonly source: ResponseSource };

/**
 * O que gravar em `external_ids` depois de uma busca — ou `null` para não gravar.
 *
 * ## A interação entre dois caches, que é o defeito que esta função conserta
 *
 * São dois, com prazos diferentes e propósitos diferentes:
 *
 *   - o cache de RESPOSTA de `/v4/fixtures` (`FIXTURES_CACHE_SECONDS`, 8h) — a
 *     lista de fixtures do dia;
 *   - o cache NEGATIVO por partida (`oddspapi_missing_at`, 24h) — "procurei, não
 *     achei, não procuro de novo hoje".
 *
 * Com a lista valendo 1h eles quase não se encostavam. Com 8h, sim: se a lista
 * em mãos tem 7h e a OddsPapi cadastrou a fixture nesse meio-tempo, a partida
 * não é encontrada, leva o carimbo, e o carimbo a tranca por mais 24h. Um atraso
 * de 8h deles vira 32h de silêncio nosso.
 *
 * E o pior nem é o atraso: o carimbo estaria REGISTRANDO COMO FATO SOBRE A
 * PARTIDA ("a OddsPapi não cobre isto") o que foi só uma lista desatualizada.
 * Resposta de cache não sustenta conclusão sobre ausência — ela é uma afirmação
 * sobre as últimas 8h, não sobre agora.
 *
 * ## Por que (a): não gravar nada, em vez de um carimbo curto de 1h
 *
 * As duas resolvem o defeito. (a) foi escolhida porque o custo dela é medível e
 * pequeno, e porque não inventa um terceiro prazo para alguém interpretar depois.
 *
 * Com (a), a partida é reavaliada a cada ciclo enquanto a lista em cache não
 * renovar — no pior caso 8h, ou ~96 ciclos no tick de 5 min. O que cada uma
 * dessas reavaliações custa:
 *
 *   - billable: ZERO. `call` lê o cache ANTES de tudo, e o cache hit não gasta
 *     orçamento, não dorme cooldown e não toca a rede.
 *   - tempo de ciclo: uma passada de `matchFixture` em memória sobre a lista do
 *     dia, por partida não casada (~26 delas). São comparações de string sobre
 *     dezenas de fixtures — ordem de milissegundos contra um ciclo de 4 min.
 *   - banco: MENOS que hoje. Devolvendo `null`, `rememberFixture` nem faz o
 *     UPDATE que hoje faz a cada não-encontrada.
 *
 * Cabe no orçamento de tempo do ciclo com folga de ordens de grandeza, então (b)
 * não se justifica. E (a) tem um ganho que (b) não tem: no ciclo em que a lista
 * finalmente renova pela rede, a partida é reavaliada imediatamente contra a
 * lista nova, em vez de esperar o prazo de um carimbo vencer.
 *
 * O laço é limitado: quando a lista renova e a fixture continua ausente, a
 * resposta é `network`, o carimbo de 24h é gravado, e a partida sai da roda.
 */
export function mergeFixtureIds(
  current: Record<string, unknown> | null,
  outcome: FixtureOutcome,
  now: Date,
): Record<string, unknown> | null {
  if (outcome.kind === 'absent') {
    if (outcome.source === 'cache') return null;
    return { ...(current ?? {}), oddspapi_missing_at: now.toISOString() };
  }

  const merged: Record<string, unknown> = { ...(current ?? {}) };
  merged['oddspapi_fixture_id'] = outcome.link.fixtureId;
  merged['oddspapi_aliases_a'] = [...outcome.link.aliasesA];
  merged['oddspapi_aliases_b'] = [...outcome.link.aliasesB];
  merged['oddspapi_side_a_index'] = outcome.link.sideAIndex;
  // O degrau que produziu o casamento. Alias confirmado é o que este bloco
  // inteiro é: da próxima vez o casador nem roda, e se o casamento se revelar
  // errado o degrau diz qual regra o produziu.
  if (outcome.link.tier !== undefined) merged['oddspapi_match_tier'] = outcome.link.tier;
  delete merged['oddspapi_missing_at'];

  return merged;
}

/**
 * Palavras que enfeitam o nome da organização e não distinguem time nenhum.
 *
 * Saem dos padrões medidos nas falhas: `DENDELE CS` / `Dendele`, `NIO` /
 * `Nio eSports`, `Kreazion` / `Team Kreazion`. São a mesma organização escrita
 * com mais ou menos enfeite.
 */
const DECORATIVE_TOKENS: ReadonlySet<string> = new Set([
  'esports',
  'esport',
  'gaming',
  'team',
  'club',
  'org',
  'cs',
  'cs2',
  'csgo',
  'gg',
  'the',
]);

/**
 * Palavras que NÃO podem ser removidas nem abreviadas: elas separam times
 * distintos da MESMA organização.
 *
 * É a proteção central deste casador, e ela vem do próprio dado medido: a lista
 * de falhas tem `Inner Circle Esports` e `Inner Circle Prospect`. Tratar as duas
 * como a mesma coisa ligaria a partida do time principal à linha do time B — um
 * erro sem sintoma, da mesma família do mercado espelhado.
 */
const DISTINGUISHING_TOKENS: ReadonlySet<string> = new Set([
  'academy',
  'prospect',
  'prospects',
  'junior',
  'juniors',
  'jr',
  'youth',
  'young',
  'female',
  'women',
  'fe',
  'b',
  'ii',
]);

function tokensOf(raw: string): string[] {
  return raw
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 0);
}

/** O nome sem enfeite de organização. `DENDELE CS` e `Dendele` viram o mesmo. */
export function canonicalTeamName(raw: string): string {
  const kept = tokensOf(raw).filter((t) => !DECORATIVE_TOKENS.has(t));
  // Nome feito só de enfeite (`Team`, `CS`) não vira string vazia: aí ele casaria
  // com qualquer outro nome vazio.
  return (kept.length > 0 ? kept : tokensOf(raw)).join('');
}

/** As palavras que separam times da mesma organização, presentes neste nome. */
export function distinguishingOf(raw: string): string[] {
  return tokensOf(raw)
    .filter((t) => DISTINGUISHING_TOKENS.has(t))
    .sort();
}

/** Iniciais das palavras que sobram depois do enfeite: `Inner Circle` -> `ic`. */
function acronymOf(raw: string): string {
  return tokensOf(raw)
    .filter((t) => !DECORATIVE_TOKENS.has(t))
    .map((t) => t[0] ?? '')
    .join('');
}

/** O curto aparece em ordem dentro do longo. `navi` ⊂ `natusvincere`. */
function isSubsequence(longer: string, shorter: string): boolean {
  if (shorter.length < 3 || shorter.length >= longer.length) return false;

  let i = 0;
  for (const ch of longer) {
    if (ch === shorter[i]) i += 1;
    if (i === shorter.length) return true;
  }
  return false;
}

/**
 * Como este lado casou, do mais forte para o mais fraco. `null` = não casou.
 *
 * O nível fica gravado em `external_ids` e no payload: um casamento fraco que
 * depois se revele errado precisa ser rastreável até a regra que o produziu.
 */
export type MatchTier = 'exact' | 'canonical' | 'code' | 'abbrev';

const TIER_ORDER: readonly MatchTier[] = ['exact', 'canonical', 'code', 'abbrev'];

export interface TeamKey {
  readonly displayName: string;
  /** A sigla que a Polymarket usa. Costuma bater com o `Abbr` deles. */
  readonly polymarketCode: string | null;
}

/**
 * Este lado da fixture é o nosso time?
 *
 * Cascata, e cada degrau abaixo do exato tem uma guarda própria — porque o erro
 * que ela pode cometer não é "não achou", é "achou o time errado da mesma
 * organização", que entra no fragmento com cara de certo.
 *
 *   `exact`     — nome normalizado igual. É o que já existia.
 *   `canonical` — igual depois de tirar o enfeite (`Esports`, `Team`, `CS`).
 *   `code`      — `polymarket_code` bate com alguma variante deles.
 *   `abbrev`    — sigla ou abreviação (`IC` para `Inner Circle`, `navi` para
 *                 `Natus Vincere`).
 *
 * A guarda que atravessa tudo: as palavras DISTINTIVAS (`Academy`, `Prospect`,
 * `Junior`, …) têm que ser as mesmas dos dois lados. E os dois degraus mais
 * fracos são RECUSADOS quando o nosso nome tem alguma delas — uma sigla não
 * consegue expressar "Prospect", então `INN` casaria igualmente bem com
 * `Inner Circle Esports` e com `Inner Circle Prospect`. Sem lado é melhor que
 * lado errado.
 */
export function sideMatchTier(ours: TeamKey, theirVariants: readonly string[]): MatchTier | null {
  const nome = ours.displayName;
  if (nome.trim().length === 0 || theirVariants.length === 0) return null;

  const ourDistinct = distinguishingOf(nome).join(',');
  const compatible = (variant: string): boolean =>
    distinguishingOf(variant).join(',') === ourDistinct;

  const usable = theirVariants.filter(compatible);
  if (usable.length === 0) return null;

  const ourNorm = normalize(nome);
  if (usable.some((v) => normalize(v) === ourNorm)) return 'exact';

  const ourCanon = canonicalTeamName(nome);
  if (ourCanon.length > 0 && usable.some((v) => canonicalTeamName(v) === ourCanon)) {
    return 'canonical';
  }

  // Daqui para baixo a identidade é parcial. Nome com palavra distintiva não
  // passa: nenhuma sigla carrega "Prospect".
  if (ourDistinct.length > 0) return null;

  const code = ours.polymarketCode?.trim().toLowerCase() ?? '';
  if (code.length >= 2 && usable.some((v) => normalize(v) === normalize(code))) return 'code';

  const ourAcronym = acronymOf(nome);
  for (const variant of usable) {
    // Compara a forma CANÔNICA dos dois lados, não a normalizada crua: a sigla
    // deles costuma vir com o mesmo enfeite do nome longo (`IC eSports`), e
    // comparar `ic` com `icesports` falha por causa de uma palavra que já
    // decidimos ignorar.
    const theirCanon = canonicalTeamName(variant);
    if (theirCanon.length < 2) continue;

    if (ourAcronym.length >= 2 && theirCanon === ourAcronym) return 'abbrev';
    if (acronymOf(variant) === ourCanon && ourCanon.length >= 2) return 'abbrev';
    if (isSubsequence(ourCanon, theirCanon) || isSubsequence(theirCanon, ourCanon)) {
      return 'abbrev';
    }
  }

  return null;
}

/** O mais fraco dos dois — é ele que qualifica o par. */
function weakestTier(a: MatchTier, b: MatchTier): MatchTier {
  return TIER_ORDER.indexOf(a) >= TIER_ORDER.indexOf(b) ? a : b;
}

/**
 * A fixture deles que corresponde aos nossos dois times.
 *
 * Casamento por nome exato normalizado, contra as três variantes que eles dão
 * por lado (Name / ShortName / Abbr) — a mesma comparação que `--with-db` da
 * sonda mede. Exige os DOIS lados: um lado só casaria com qualquer partida do
 * time no dia, e a fixture errada produziria a linha de outra partida com cara
 * de certa.
 */
export function matchFixture(
  rows: readonly OddsPapiFixture[],
  teamA: TeamKey,
  teamB: TeamKey,
  /**
   * O horário da NOSSA partida, para desempatar.
   *
   * Os mesmos dois times se enfrentam mais de uma vez na janela com frequência —
   * fase de grupos e playoff, ou revanche no dia seguinte. Sem a data, as duas
   * fixtures empatam no mesmo degrau e o casador recusa as duas; foi o que o
   * relatório de cobertura pegou como "os dois exatos na mesma fixture e mesmo
   * assim não casou". A data é a informação que separa uma da outra, e nós
   * sempre a tivemos.
   */
  scheduledAt?: Date,
): (FixtureLink & { tier: MatchTier }) | null {
  if (teamA.displayName.trim().length === 0 || teamB.displayName.trim().length === 0) return null;

  const candidatos: (FixtureLink & { tier: MatchTier })[] = [];

  for (const fixture of rows) {
    const [side1 = [], side2 = []] = fixture.sides;

    // `sideAIndex` é o participante DELES que é o nosso time A — 1 quando o
    // nosso A casou com o `participant1`, 2 quando casou com o `participant2`.
    const a1 = sideMatchTier(teamA, side1);
    const b2 = sideMatchTier(teamB, side2);
    if (a1 !== null && b2 !== null) {
      candidatos.push({
        fixtureId: fixture.fixtureId,
        aliasesA: [...side1],
        aliasesB: [...side2],
        sideAIndex: 1,
        tier: weakestTier(a1, b2),
      });
      continue;
    }

    const a2 = sideMatchTier(teamA, side2);
    const b1 = sideMatchTier(teamB, side1);
    if (a2 !== null && b1 !== null) {
      candidatos.push({
        fixtureId: fixture.fixtureId,
        aliasesA: [...side2],
        aliasesB: [...side1],
        sideAIndex: 2,
        tier: weakestTier(a2, b1),
      });
    }
  }

  if (candidatos.length === 0) return null;

  // Primeiro o degrau: evidência mais forte ganha de mais fraca, sempre.
  candidatos.sort((x, y) => TIER_ORDER.indexOf(x.tier) - TIER_ORDER.indexOf(y.tier));
  const melhorDegrau = (candidatos[0] as { tier: MatchTier }).tier;
  const empatados = candidatos.filter((c) => c.tier === melhorDegrau);

  if (empatados.length === 1) return empatados[0] as FixtureLink & { tier: MatchTier };

  // Empate no degrau: desempata pela DATA, que é o que distingue duas partidas
  // dos mesmos dois times na mesma janela.
  const alvo = scheduledAt?.getTime();
  if (alvo !== undefined && Number.isFinite(alvo)) {
    const comDistancia = empatados
      .map((c) => {
        const fixture = rows.find((f) => f.fixtureId === c.fixtureId);
        const inicio = fixture?.startTime === null ? NaN : Date.parse(fixture?.startTime ?? '');
        return { c, distancia: Number.isFinite(inicio) ? Math.abs(inicio - alvo) : Infinity };
      })
      .sort((x, y) => x.distancia - y.distancia);

    const primeiro = comDistancia[0];
    const segundo = comDistancia[1];

    // Só decide se a mais próxima é ESTRITAMENTE mais próxima. Duas fixtures à
    // mesma distância (ou as duas sem horário) continuam sendo adivinhação.
    if (
      primeiro !== undefined &&
      Number.isFinite(primeiro.distancia) &&
      (segundo === undefined || segundo.distancia > primeiro.distancia)
    ) {
      return primeiro.c;
    }
  }

  // Sem data para desempatar, recusa. Escolher uma seria adivinhar qual partida
  // o nosso mercado está precificando — e o preço da outra entraria no fragmento
  // com cara de certo.
  return null;
}

/**
 * Tamanho do bloco de descoberta, em dias.
 *
 * Todas as partidas cujo `scheduled_at` cai no mesmo bloco produzem a MESMA
 * janela, e portanto a mesma chave de cache de `/v4/fixtures`. É isso que a
 * constante compra, e é a terceira e última peça do orçamento.
 */
export const DISCOVERY_BLOCK_DAYS = 7;

/**
 * Folga de cada lado do bloco.
 *
 * Existe porque a data da fixture na OddsPapi pode diferir em um dia da nossa
 * `scheduled_at` — fuso, e partida de madrugada UTC. Sem a folga, a partida na
 * BORDA do bloco não encontraria a própria fixture, e a perda seria silenciosa:
 * viraria "a OddsPapi não cobre" em vez de "eu procurei no intervalo errado".
 *
 * ## Por que ela quase não existiu na borda de cima
 *
 * `npm run oddspapi:probe -- --truncation` mediu, em 11/08/2026, a semântica da
 * faixa, que não é documentada: **`from` inclusivo, `to` EXCLUSIVO**. A janela
 * pedida `2026-08-10..2026-08-12` devolveu 6 fixtures, todas de 10 e 11 — e a
 * janela maior que a contém mostrou que existiam 16 em 12/08. Nenhuma veio.
 *
 * Enquanto `discoveryWindow` calculava o fim como se a faixa fosse inclusiva,
 * esta folga só existia no COMEÇO: o bloco vinha inteiro, mas a partida do
 * último dia dele com fixture um dia à frente por fuso não era encontrada. O
 * `to` já compensa a exclusividade — ver `discoveryWindow`.
 */
export const DISCOVERY_PAD_DAYS = 1;

/**
 * A janela de descoberta: o BLOCO alinhado que contém a partida, com folga.
 *
 * ## Por que bloco alinhado, e não o dia da partida
 *
 * A janela antiga era `D-1..D+1`, derivada da data da PARTIDA. Duas partidas em
 * dias diferentes davam duas chaves de cache diferentes — e, com o lookahead do
 * enricher alcançando o dia seguinte, duas janelas em voo era o caso NORMAL:
 *
 *     2 janelas × 3 chamadas/dia (`FIXTURES_CACHE_SECONDS` = 8h) = 6/dia
 *     contra 4,3/dia disponíveis
 *
 * E as duas se sobrepunham quase inteiras: 10–12/08 e 11–13/08 são duas
 * requisições pagas pelo quase mesmo conjunto de fixtures.
 *
 * Com bloco de 7 dias há UMA janela ativa quase sempre, e duas só no dia em que
 * o bloco vira — um dia em sete:
 *
 *     (6 dias × 1 janela + 1 dia × 2 janelas) / 7 = 8/7 ≈ 1,14 janelas/dia
 *     1,14 × 3 chamadas/dia ≈ 3,4/dia
 *
 * O 1,14 é MODELO, não medida — ver a nota em `FIXTURES_CACHE_SECONDS`.
 *
 * ## A fronteira vem da ÉPOCA, não de "hoje"
 *
 * `floor(diaDaÉpoca / 7)` ancora o bloco num marco fixo (quinta-feira, porque
 * 1970-01-01 foi quinta). Ancorar em "hoje" seria o mesmo defeito de sempre
 * disfarçado: a fronteira andaria um dia por dia, toda partida mudaria de janela
 * à meia-noite, e o cache de 8h seria invalidado diariamente por construção — a
 * mudança inteira perderia o efeito sem nada parecer errado.
 *
 * ## O intervalo consultado, e por que o `to` leva um dia a mais
 *
 * MEDIDO (11/08/2026, `--truncation`): a faixa da API é `[from, to)` — `from`
 * inclusivo, `to` EXCLUSIVO. Não é documentado; foi medido pedindo
 * `2026-08-10..2026-08-12` e recebendo só 10 e 11, com a janela maior provando
 * que existiam 16 fixtures em 12/08.
 *
 * Por isso o fim é `blocoInício + DISCOVERY_BLOCK_DAYS + DISCOVERY_PAD_DAYS`, e
 * não um dia menos: o último dia que se QUER coberto é `blocoInício + 7` (o dia
 * de folga depois do último dia do bloco, que é `blocoInício + 6`), e para que
 * ele entre numa faixa de fim exclusivo o `to` tem que ser `blocoInício + 8`.
 * Sem esse dia, a folga do fim não existia — o bloco vinha inteiro, mas a
 * partida do último dia dele com fixture um dia à frente por fuso não era
 * encontrada, que é exatamente o caso que `DISCOVERY_PAD_DAYS` existe para
 * cobrir.
 *
 * Datas cobertas: `blocoInício - 1` até `blocoInício + 7`, nove ao todo.
 * `to - from` = 9 dias, e o limite medido é "must be under 10 days apart" —
 * segue abaixo, com um dia de margem. O orçamento não muda: mesmo número de
 * chaves de cache, mesma contagem de chamadas.
 *
 * ## Se ainda ficar apertado
 *
 * O dial a girar é o TTL (`FIXTURES_CACHE_SECONDS`), NÃO o bloco. Bloco maior
 * esbarra no teto de 10 dias da API em duas semanas, e cada dia a mais aumenta a
 * lista devolvida — que é justamente o que o aviso de truncamento em
 * `describeTruncationRisk` existe para vigiar. TTL é um número sem teto rígido e
 * com efeito linear e imediato no orçamento.
 */
export function discoveryWindow(scheduledAt: Date): { from: string; to: string } {
  const DAY = 86_400_000;

  const epochDay = Math.floor(scheduledAt.getTime() / DAY);
  const blockStart = Math.floor(epochDay / DISCOVERY_BLOCK_DAYS) * DISCOVERY_BLOCK_DAYS;

  const fromDay = blockStart - DISCOVERY_PAD_DAYS;
  // Sem o `- 1` que o intervalo inclusivo pediria: o `to` é exclusivo (medido),
  // então este é o primeiro dia FORA, e o último coberto é o de folga.
  const toDay = blockStart + DISCOVERY_BLOCK_DAYS + DISCOVERY_PAD_DAYS;

  return {
    from: new Date(fromDay * DAY).toISOString().slice(0, 10),
    to: new Date(toDay * DAY).toISOString().slice(0, 10),
  };
}

// ---------------------------------------------------------------------------
// Leitura e escrita no nosso banco
// ---------------------------------------------------------------------------

async function loadMatch(
  matchId: string,
): Promise<{ row: MatchRow; nameA: string; nameB: string } | null> {
  const { data, error } = await supabase
    .from('esports_matches')
    .select('id, vertical_id, scheduled_at, external_ids, team_a_id, team_b_id')
    .eq('id', matchId)
    .maybeSingle();

  if (error || data === null) {
    if (error) console.warn(`[${ODDSPAPI_ID}] leitura de esports_matches falhou: ${error.message}`);
    return null;
  }

  const ids = [data['team_a_id'], data['team_b_id']].filter(
    (id): id is string => typeof id === 'string',
  );
  if (ids.length !== 2) return null;

  const { data: teams, error: teamError } = await supabase
    .from('esports_teams')
    .select('id, display_name, polymarket_code')
    .in('id', ids);

  if (teamError) {
    console.warn(`[${ODDSPAPI_ID}] leitura de esports_teams falhou: ${teamError.message}`);
    return null;
  }

  const byId = new Map((teams ?? []).map((row) => [row['id'] as string, row]));
  const nameA = byId.get(ids[0] as string)?.['display_name'];
  const nameB = byId.get(ids[1] as string)?.['display_name'];

  // Sem `display_name` não há casamento por nome possível — é o caminho 2 do
  // resolver, que conhece o código mas não o nome. Nada a fazer aqui, e nada a
  // gastar do orçamento tentando.
  if (typeof nameA !== 'string' || typeof nameB !== 'string') return null;

  const codeOf = (id: string): string | null => {
    const raw = byId.get(id)?.['polymarket_code'];
    return typeof raw === 'string' && raw.trim().length > 0 ? raw.trim() : null;
  };

  return {
    row: {
      id: data['id'] as string,
      vertical_id: data['vertical_id'] as string,
      scheduled_at: (data['scheduled_at'] as string | null) ?? null,
      external_ids: (data['external_ids'] as Record<string, unknown> | null) ?? null,
      keyA: { displayName: nameA, polymarketCode: codeOf(ids[0] as string) },
      keyB: { displayName: nameB, polymarketCode: codeOf(ids[1] as string) },
    },
    nameA,
    nameB,
  };
}

/**
 * Grava o que se aprendeu sobre a fixture, mesclando com o que já havia.
 *
 * Enricher escrevendo em tabela de entidade é fora do padrão, e a justificativa
 * é a mesma do enricher da Liquipedia: sem isto, cada ciclo gastaria orçamento
 * para reaprender o que já se sabia. Falha aqui não interrompe nada — no pior
 * caso se procura de novo no ciclo seguinte.
 */
async function rememberFixture(
  matchId: string,
  current: Record<string, unknown> | null,
  outcome: FixtureOutcome,
): Promise<void> {
  const merged = mergeFixtureIds(current, outcome, new Date());

  // `null` = ausência apurada em lista de cache. Não há o que gravar: não se
  // aprendeu nada sobre a partida, só sobre a idade da lista.
  if (merged === null) return;

  const { error } = await supabase
    .from('esports_matches')
    .update({ external_ids: merged })
    .eq('id', matchId);

  if (error) {
    console.warn(`[${ODDSPAPI_ID}] não gravou oddspapi_fixture_id de ${matchId}: ${error.message}`);
  }
}

// ---------------------------------------------------------------------------
// O ciclo
// ---------------------------------------------------------------------------

/** Uma mensagem igual por hora. O job chama isto dezenas de vezes por ciclo. */
const warnedAt = new Map<string, number>();

function warnOnce(message: string): void {
  const now = Date.now();
  const last = warnedAt.get(message);
  if (last !== undefined && now - last < 3_600_000) return;

  warnedAt.set(message, now);
  console.warn(message);
}

export function resetOddsPapiEnricherWarnings(): void {
  warnedAt.clear();
}

async function resolveFixture(
  row: MatchRow,
  nameA: string,
  nameB: string,
  // `asOf`, e NÃO `now`. O nome é a correção: este instante é o começo do ciclo,
  // não o presente, e usá-lo como relógio de cooldown foi um bug de alta
  // gravidade — ver `callFitsBudget`.
  asOf: Date,
  remaining: number,
): Promise<FixtureLink | null> {
  const cached = readCachedFixture(row.external_ids, asOf);
  if (cached.kind === 'fixture') return cached.link;
  if (cached.kind === 'missing') {
    // Distinto de "procurei agora e não achei": este é o cache negativo de 24h
    // falando. Confundir os dois esconderia o pior caso — uma primeira passada
    // que falhou para todas as partidas e calou o enricher por um dia inteiro.
    noteEnricherSkip(ODDSPAPI_ID, 'cache negativo: procurada nas últimas 24h e não encontrada');
    return null;
  }

  const sportId = SPORT_ID_BY_VERTICAL[row.vertical_id];
  if (sportId === undefined) return null;

  // Sem horário não há janela — e varrer sem janela custaria o orçamento inteiro.
  if (row.scheduled_at === null) {
    noteEnricherSkip(ODDSPAPI_ID, 'partida sem scheduled_at');
    return null;
  }
  const scheduled = new Date(row.scheduled_at);
  if (!Number.isFinite(scheduled.getTime())) return null;

  const { from, to } = discoveryWindow(scheduled);

  // A descoberta é a chamada mais cara em consequência: gasta do orçamento
  // MENSAL. Entrar nela sem tempo para terminar gastaria a requisição e jogaria
  // fora a resposta.
  // Relógio REAL, não `asOf`. Passar `asOf` aqui fazia `waitMsFor` calcular
  // `cooldown - (asOf - últimaChamada)`: com a última chamada no presente e
  // `asOf` no começo do ciclo, a subtração fica negativa e a "espera" cresce
  // exatamente o tempo já decorrido. O log mostrou `exige 133s (129s de
  // cooldown)` para um endpoint cujo cooldown é 2,5s — eram os 129s que o ciclo
  // levava até ali. Efeito: passados os primeiros segundos de cada ciclo, TODA
  // descoberta era recusada, e as 26 partidas sem fixture nunca eram procuradas.
  const noBudget = callFitsBudget('/v4/fixtures', remaining);
  if (noBudget !== null) {
    noteEnricherSkip(ODDSPAPI_ID, noBudget);
    return null;
  }

  const response = await fixtures({ sportId, from, to });
  const link = matchFixture(response.value, row.keyA, row.keyB, scheduled);

  await rememberFixture(
    row.id,
    row.external_ids,
    link === null ? { kind: 'absent', source: response.source } : { kind: 'found', link },
  );

  if (link === null) {
    // As duas ausências são coisas diferentes e o log as separa: uma é
    // conclusão sobre a partida, a outra é conclusão sobre a lista que tínhamos
    // em mãos. Sem a distinção aqui, uma lista velha e uma partida realmente
    // descoberta pela OddsPapi produzem a mesma linha de log.
    console.log(
      response.source === 'network'
        ? `[${ODDSPAPI_ID}] ${nameA} x ${nameB} sem fixture na OddsPapi (${from}..${to}) — ` +
            `não reprocura por ${MISSING_RECHECK_HOURS}h`
        : `[${ODDSPAPI_ID}] ${nameA} x ${nameB} sem fixture na lista em cache (${from}..${to}) — ` +
            `sem carimbo; reavalia a cada ciclo até a lista renovar ` +
            `(no máximo ${FIXTURES_CACHE_SECONDS / 3_600}h), sem custo billable`,
    );
  } else if (link.tier !== 'exact') {
    // Casamento abaixo do exato é o que a correção de cobertura passou a
    // permitir. Fica no log e em `external_ids` para ser auditável: se um dia
    // um fragmento apontar para a partida errada, o degrau que o produziu é a
    // primeira coisa a olhar.
    console.log(
      `[${ODDSPAPI_ID}] ${nameA} x ${nameB} casou por '${link.tier}' com ` +
        `${link.aliasesA.join('/')} x ${link.aliasesB.join('/')}`,
    );
  }

  return link;
}

async function fetchOddsPapi(ctx: EnricherContext): Promise<ContextFragment[]> {
  // Cada saída daqui para baixo é NOMEADA. Todas devolvem `[]`, e sem o nome as
  // seis viram o mesmo silêncio — que foi exatamente como este enricher passou
  // um dia no ar sem gravar nada e sem ninguém conseguir dizer por quê.
  if (SPORT_ID_BY_VERTICAL[ctx.verticalId] === undefined) {
    noteEnricherSkip(ODDSPAPI_ID, `vertical ${ctx.verticalId} sem sportId medido`);
    return [];
  }

  const config = await getSystemConfig();
  if (config.esports_enricher_oddspapi_enabled !== true) {
    // Inclui o caso em que a migration 20260808060011 não foi aplicada: sem a
    // coluna, o fallback de `config.ts` devolve `false` e isto é indistinguível
    // de desligado à mão. Daí o motivo dizer as duas coisas.
    noteEnricherSkip(
      ODDSPAPI_ID,
      'esports_enricher_oddspapi_enabled != true (desligado, ou coluna inexistente)',
    );
    return [];
  }

  if (readConfig() === null) {
    warnOnce(`[${ODDSPAPI_ID}] desligado por falta de credencial (${describeConfig()})`);
    noteEnricherSkip(ODDSPAPI_ID, 'ODDSPAPI_API_KEY ausente no ambiente');
    return [];
  }

  // O TTL é do enricher e é checado aqui porque o runner não checa TTL nenhum
  // (decisão documentada em `enricher.ts`).
  const lastAsOf = await lastFragmentAsOf(ctx.matchId, ODDSPAPI_ID);
  if (
    lastAsOf !== null &&
    ctx.asOf.getTime() - lastAsOf.getTime() < oddspapiEnricher.ttlSeconds * 1000
  ) {
    noteEnricherSkip(ODDSPAPI_ID, 'TTL de 30 min ainda não venceu');
    return [];
  }

  const loaded = await loadMatch(ctx.matchId);
  if (loaded === null) {
    // A causa concreta mais provável: `esports_teams.display_name` nulo, que é o
    // estado normal do caminho 2 do resolver (código sem nome). Sem nome não há
    // casamento com a fixture deles, e não há nada a tentar.
    noteEnricherSkip(ODDSPAPI_ID, 'partida sem os dois times com display_name');
    return [];
  }

  const { row, nameA, nameB } = loaded;

  const link = await resolveFixture(row, nameA, nameB, ctx.asOf, remainingMs(ctx));

  if (link === null) {
    noteEnricherSkip(ODDSPAPI_ID, 'sem fixture correspondente na OddsPapi');
    return [];
  }

  const requested = safeBookmakers(config.oddspapi_bookmakers);
  if (requested.length === 0) {
    warnOnce(`[${ODDSPAPI_ID}] oddspapi_bookmakers vazio — nada a pedir`);
    noteEnricherSkip(ODDSPAPI_ID, 'oddspapi_bookmakers vazio');
    return [];
  }

  // O gargalo medido: 5,5s de cooldown por chamada, uma chamada por partida,
  // 40 partidas — 220s de espera num ciclo de 240s. Desistir aqui é a diferença
  // entre esta partida não ter fragmento e o ciclo inteiro não fechar.
  const noTime = callFitsBudget('/v4/historical-odds', remainingMs(ctx));
  if (noTime !== null) {
    noteEnricherSkip(ODDSPAPI_ID, noTime);
    return [];
  }

  const perBook = await historicalOdds({ fixtureId: link.fixtureId, bookmakers: requested });

  const marketId = (config.oddspapi_market_id ?? DEFAULT_MARKET_ID).trim();
  const { lines, format, sideSource } = buildBookLines(
    perBook,
    {
      aliasesA: link.aliasesA,
      aliasesB: link.aliasesB,
      sideAIndex: link.sideAIndex,
      marketId,
    },
    ctx.asOf,
  );
  const coverage = coverageOf(requested, lines);
  const consensus = consensusOf(lines);

  const fragments: ContextFragment[] = [];

  // --- a linha ------------------------------------------------------------
  //
  // Só sai fragmento se ALGUMA casa cotou de forma comparável. Um fragmento que
  // diz "ninguém cotou" a cada 30 min é ruído puro, e o job já registra a
  // ausência no log.
  if (!lines.some((l) => l.fairA !== null)) {
    // A resposta veio e nenhuma casa deu par cotável. O motivo por casa está em
    // `excludedBecause`; aqui fica o agregado, que é o que denuncia o dia em que
    // o `marketId` ou a orientação dos outcomes mudar do lado deles.
    noteEnricherSkip(ODDSPAPI_ID, `nenhuma casa cotou o mercado ${marketId} de forma comparável`);
  }

  if (lines.some((l) => l.fairA !== null)) {
    fragments.push({
      enricherId: ODDSPAPI_ID,
      kind: 'bookmaker_odds',
      // O `asOf` do runner, não o carimbo da última entrada: o fragmento afirma
      // "esta era a linha neste instante", e o carimbo real de cada casa está no
      // payload, com `staleSeconds` ao lado. Declarar o carimbo da casa faria o
      // fragmento afirmar sobre um instante em que ninguém perguntou.
      asOf: ctx.asOf,
      payload: {
        source: 'oddspapi',
        fixture_id: link.fixtureId,
        market_id: marketId,
        price_format: format,
        sides: { a: nameA, b: nameB },
        // A única SUPOSIÇÃO deste fragmento, declarada para não ser confundida
        // com medida: `outcome_order` significa que o lado saiu da ordem dos ids
        // de outcome, porque a resposta não traz nome. Ver `sideByOutcomeOrder`.
        side_source: sideSource,
        consensus: {
          fair_a: consensus.fairA,
          fair_b: consensus.fairB,
          books: consensus.books,
          // Sem peso, e o motivo é medição: `limit` só vem na Pinnacle, então
          // ponderar por ele faria um número que parece agregado e é Pinnacle pura.
          method: 'median_unweighted',
        },
        books: lines,
        coverage,
      },
      summary: buildOddsSummary(nameA, nameB, lines, consensus, coverage, format, sideSource),
      confidence: ODDS_CONFIDENCE,
    });
  }

  // --- as suspensões ------------------------------------------------------
  const blocks: SuspensionBlock[] = [];
  for (const [bookmaker, entries] of perBook) {
    blocks.push(...suspensionBlocks(bookmaker, entries, ctx.asOf));
  }

  if (blocks.length > 0) {
    const recent = [...blocks]
      .sort((a, b) => (Date.parse(b.startAt ?? '') || 0) - (Date.parse(a.startAt ?? '') || 0))
      .slice(0, MAX_BLOCKS_IN_PAYLOAD);

    const suspendedNow = lines
      .filter((l) => l.a?.active === false || l.b?.active === false)
      .map((l) => l.bookmaker);

    fragments.push({
      enricherId: ODDSPAPI_ID,
      kind: 'bookmaker_suspension',
      asOf: ctx.asOf,
      payload: {
        source: 'oddspapi',
        fixture_id: link.fixtureId,
        total_blocks: blocks.length,
        enclosed: blocks.filter((b) => b.enclosed).length,
        with_price_change: blocks.filter((b) => b.priceChanged).length,
        suspended_now: suspendedNow,
        blocks: recent.map((b) => ({
          ...b,
          coincides_with: coincidentBookmakers(b, blocks),
        })),
        truncated: blocks.length > recent.length,
      },
      summary: buildSuspensionSummary(nameA, nameB, blocks, suspendedNow),
      confidence: SUSPENSION_CONFIDENCE,
    });
  }

  return fragments;
}

/**
 * As casas pedidas, filtradas pelo léxico de slug e pelo teto de 3 da API.
 *
 * O filtro repete o guard do cliente de propósito: aqui ele DESCARTA a casa
 * inválida e segue com as outras, enquanto lá ele levanta. Uma entrada torta na
 * config não pode custar o fragmento inteiro.
 */
export function safeBookmakers(slugs: readonly string[] | null | undefined): string[] {
  return (slugs ?? [])
    .map((s) => s.trim())
    .filter((s) => /^[a-zA-Z0-9_.-]+$/.test(s))
    .slice(0, MAX_BOOKMAKERS_PER_CALL);
}

/**
 * O `fetch` que o runner chama.
 *
 * Nenhum estado esperado da fonte sobe daqui: credencial ausente, orçamento no
 * fim, tier cortado e 429 viram aviso por hora e lista vazia. O tier gratuito é
 * cortesia e some sem avisar — tratar isso como incidente encheria o log de uma
 * coisa que não é defeito nosso e não tem ação.
 *
 * O resto (`http`, `timeout`, `shape`) vira aviso por partida, com o id: aí é
 * anomalia e alguém deve olhar. Nada disso interrompe o ciclo — o runner já
 * isola cada enricher, e esta camada existe para que o isolamento não precise
 * ser acionado pelo caso NORMAL.
 */
async function fetchGuarded(ctx: EnricherContext): Promise<ContextFragment[]> {
  try {
    return await fetchOddsPapi(ctx);
  } catch (err) {
    if (err instanceof OddsPapiError) {
      if (isExpectedOutage(err)) {
        noteEnricherSkip(ODDSPAPI_ID, `fonte indisponível: ${err.kind}`);
        warnOnce(
          `[${ODDSPAPI_ID}] ${err.kind}: ${err.message}` +
            (err.kind === 'budget_exhausted'
              ? ` (estimativa deste processo: ${billableBudget.remaining()} restantes)`
              : ''),
        );
        return [];
      }
      // O status entra no motivo: 429, 404 e 500 pedem tratamentos diferentes
      // (recuar, desistir da partida, tentar de novo) e sem o código eles são
      // indistinguíveis no contador.
      noteEnricherSkip(
        ODDSPAPI_ID,
        `erro da fonte: ${err.kind}${err.status === undefined ? '' : ` ${err.status}`}`,
      );
      console.warn(`[${ODDSPAPI_ID}] ${ctx.matchId}: ${err.kind} — ${err.message}`);
      return [];
    }
    throw err;
  }
}

export const oddspapiEnricher: Enricher = {
  id: ODDSPAPI_ID,
  verticals: ODDSPAPI_VERTICALS,
  /**
   * 30 minutos.
   *
   * Bem mais curto que os 6h da Liquipedia, e a diferença é a natureza do dado:
   * roster muda em semanas, linha de aposta muda em minutos. É a mesma cadência
   * de decisão do job (`esports_enricher_min_interval_minutes`), o que na prática
   * significa "um fragmento por passada" — que é o que se quer de uma série.
   *
   * Não custa orçamento: `/v4/historical-odds` é declarado livre, e o que ele
   * gasta é o cooldown de 5,5s. A descoberta, essa sim billable, já está
   * memoizada quando este TTL importa.
   */
  ttlSeconds: 30 * 60,
  /** Ver a seção POINT-IN-TIME no topo. Ausência de garantia, medição pendente. */
  supportsPointInTime: false,
  fetch: fetchGuarded,
};
