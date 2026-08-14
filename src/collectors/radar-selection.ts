import { extractEntities, jaccard, tokenize } from '../../scripts/lib/market-pairing.js';
import type { GammaMarket } from '../types/index.js';

/**
 * A REGRA do roster do radar — pura, sem rede e sem banco.
 *
 * ## O princípio, que decide quase tudo sozinho
 *
 *   Filtra na COLETA o que NÃO muda. Filtra na VIEW o que muda.
 *
 * Categoria de um mercado não muda. Preço muda o tempo todo — e filtrar por
 * preço faz o mercado sair do roster exatamente quando se move, que é o evento
 * que a frente existe para estudar. A versão anterior deste arquivo tinha faixa
 * de preço, piso de volume e teto por assunto como PORTA; os três saíram. O que
 * sobrou aqui é viabilidade (dá para ler preço?), propriedade estável
 * (categoria, prazo) e custo (o teto).
 *
 * O que era filtro e virou COLUNA: o grupo de assunto. Ele deixa de decidir
 * quem entra e passa a ser gravado em cada mercado — 22 mercados sobre o Irã são
 * uma observação na hora de medir e 22 oportunidades na hora de operar, e essa é
 * uma distinção que a view faz e o coletor não tem como fazer.
 *
 * O contexto que justifica a mudança inteira: o pipeline de esports foi
 * construído em cima de uma tese, a tese morreu, e nada daquilo serviu para
 * outra coisa. Série de preço bruta sobrevive à morte da tese; série filtrada
 * pela tese, não.
 *
 * Separado do coletor pelo mesmo motivo que `market-pairing` é separado da sonda
 * que busca: assim a regra é testável sem tocar a Gamma. Todo descarte é contado
 * por motivo — descarte silencioso é cobertura perdida sem ninguém saber.
 */

// ---------------------------------------------------------------------------
// Entrada
// ---------------------------------------------------------------------------

/**
 * O que a regra lê de um market. Subconjunto de `GammaMarket` porque o teste
 * precisa montar caso sem inventar os outros 80 campos da Gamma.
 */
export type RadarMarketInput = Pick<
  GammaMarket,
  'id' | 'slug' | 'question' | 'endDate' | 'closed' | 'active'
> &
  Partial<
    Pick<
      GammaMarket,
      | 'description'
      | 'outcomePrices'
      | 'liquidityNum'
      | 'liquidity'
      | 'volume24hr'
      | 'volume24hrClob'
      | 'bestBid'
      | 'bestAsk'
      | 'lastTradePrice'
      | 'acceptingOrders'
      | 'enableOrderBook'
      | 'feeType'
      | 'sportsMarketType'
      | 'gameStartTime'
      | 'clobTokenIds'
      | 'events'
    >
  > & {
    /**
     * A categoria pela qual este market entrou no universo — o nome do balde de
     * tags da config, não a tag específica. Propriedade estável, e por isso é
     * critério de coleta e vira coluna.
     */
    tema: string;
    /**
     * Este market já está com `radar_tracked` no banco — ou seja, já produziu
     * série protegida. Lido do banco a cada renovação, e a única coisa que ele
     * muda é o critério do livro (ver `triar`).
     */
    jaMarcado?: boolean;
  };

export interface RadarRules {
  /**
   * Prazo máximo, em dias. NÃO existe prazo mínimo, e a ausência é a decisão:
   * um piso de 7 dias tiraria do roster todo mercado na semana da resolução —
   * justamente quando a notícia decide o desfecho e o preço se mexe mais.
   * "Falta pouco" é propriedade que muda; teto de 180 dias é o que evita
   * fotografar mercado de 2028 por dois anos.
   */
  horizonMaxDays: number;
  /**
   * Piso de liquidez do DOWNLOAD, não critério de tese.
   *
   * A Gamma filtra por ele no servidor (`liquidity_num_min`), e sem algum piso o
   * universo baixado é o Polymarket inteiro. Ele é legítimo porque é a MESMA
   * régua do teto (ranking de liquidez): se o corte do teto cai muito acima
   * dele, ele não decide nada — só evita baixar dezenas de MB de mercado que o
   * ranking descartaria de qualquer jeito. Quem confere isso é o relatório do
   * `--dry-run`, que imprime a liquidez do último colocado.
   */
  minLiquidity: number;
  /**
   * Teto POR CATEGORIA, cortando os menores em liquidez dentro dela.
   *
   * Por categoria e não global, e isso saiu de medição, não de gosto. Com um
   * ranking global de liquidez sobre o universo de hoje (9.433 mercados
   * viáveis), um teto de 400 devolve: 208 de esporte, 92 de eleições, 48 de
   * macro, 18 do Brasil e **15 de IA e tecnologia**. O ranking global não é
   * neutro — ele é uma opinião sobre qual categoria importa, dita pelo tamanho
   * do livro médio de cada uma, e a opinião que ele expressa é o contrário da
   * lista de categorias. Aplicar a MESMA régua (menor liquidez sai) dentro de
   * cada categoria é o que mantém o teto sendo custo em vez de tese.
   */
  maxPorCategoria: number;
  /**
   * Backstop global. Não morde com a config de hoje (6 categorias × 100 = 600);
   * existe para o dia em que alguém acrescentar dez categorias na config e a
   * conta de armazenamento sair do orçamento sem ninguém ter decidido isso.
   */
  rosterMax: number;
}

export const DEFAULT_RADAR_RULES: RadarRules = {
  horizonMaxDays: 180,
  minLiquidity: 500,
  maxPorCategoria: 100,
  rosterMax: 800,
};

export interface RadarCandidate {
  market: RadarMarketInput;
  tema: string;
  /** Só para relatório e para o diagnóstico de espelho. Não é critério. */
  preco: number | null;
  liquidez: number;
  volume24h: number;
  /** `null` quando falta um dos lados do livro. Não é critério. */
  spread: number | null;
  /**
   * Quantos lados o livro da Gamma tinha na triagem: 2, 1 ou 0.
   *
   * Não é critério (só 0 fecha a porta, e nem para quem já está marcado) — é o
   * número que diz quanto do roster entrou por um lado só, que é a medida do
   * que a regra anterior estava jogando fora.
   */
  lados: 0 | 1 | 2;
  /** O evento pai, que é onde o espelho é procurado. */
  eventId: string;
  /** Identidade do grupo de assunto. `-1` antes de `agruparPorAssunto`. */
  grupoId: number;
  /** Rótulo do grupo, que vai para a COLUNA `radar_subject`. */
  assunto: string;
  /** Já marcado como `radar_tracked` numa renovação anterior. Ver `triar`. */
  jaMarcado: boolean;
}

// ---------------------------------------------------------------------------
// Filtro quantitativo
// ---------------------------------------------------------------------------

const DIA_MS = 24 * 60 * 60 * 1000;

/** `outcomePrices` vem como STRING de JSON, não como array. */
function parseJsonArray(raw: string | undefined): string[] {
  if (raw === undefined) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(v => String(v)) : [];
  } catch {
    return [];
  }
}

/**
 * Preço do YES publicado pela Gamma. NÃO é critério de entrada — só relatório e
 * o diagnóstico de espelho.
 *
 * A sanidade do preço continua vindo do LIVRO, e não daqui: a média de bid e ask
 * num livro sem nenhum dos dois dá 0,50 por aritmética, não por consenso. Foi
 * assim que a frente do XTracker quase fabricou edge.
 */
export function precoYes(m: RadarMarketInput): number | null {
  const precos = parseJsonArray(m.outcomePrices).map(Number);
  const p = precos[0];
  if (typeof p === 'number' && Number.isFinite(p) && p > 0 && p < 1) return p;
  const ultimo = m.lastTradePrice;
  return ultimo != null && ultimo > 0 && ultimo < 1 ? ultimo : null;
}

export function liquidezDe(m: Pick<GammaMarket, 'liquidityNum' | 'liquidity'>): number {
  const raw = m.liquidityNum ?? m.liquidity;
  const n = raw == null ? 0 : Number(raw);
  return Number.isFinite(n) ? n : 0;
}

export function volume24hDe(m: Pick<GammaMarket, 'volume24hr' | 'volume24hrClob'>): number {
  const raw = m.volume24hr ?? m.volume24hrClob;
  const n = raw == null ? 0 : Number(raw);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Prefixos de esports. A coleta deles foi desligada por decisão (Parte 1), e
 * esta é a única defesa que sobrou — nenhuma tag de esports está na lista de
 * categorias, então o caso é só o do mercado de CS2 que carrega uma tag de
 * tecnologia por acidente da Polymarket.
 *
 * Constante, e não `discovery_slug_prefixes`: aquela config é justamente a que a
 * migration de desligamento esvazia, e ler dela deixaria a defesa cair no mesmo
 * dia em que o esports sai.
 *
 * Não confundir com esporte de TEMPORADA (título, artilheiro, rebaixamento), que
 * ENTRA de propósito: ele é notícia com prazo longo, e o teto de 180 dias já
 * separa a maior parte do mercado de partida sem precisar de exceção.
 */
export const PREFIXOS_ESPORTS = ['cs2-', 'lol-', 'dota2-'] as const;

/**
 * Mercado de PARTIDA — jogo único, e não temporada.
 *
 * Fica de fora, e o filtro cabe na coleta sem violar o princípio porque
 * `sportsMarketType` é propriedade ESTÁVEL: um mercado é de partida ou não é, e
 * isso não muda na vida dele. É a taxonomia da própria Polymarket —
 * `moneyline`, `soccer_exact_score`, `spreads`, `totals`, `soccer_halftime_result`.
 *
 * Por que existe: o teto de 180 dias NÃO separa jogo de temporada, ao contrário
 * do que parecia. Jogo marcado para daqui a oito dias cai dentro da janela —
 * medido, 24 das 50 vagas de esporte eram jogo único (Brewers×Dodgers, O/U 7.5,
 * Spread). Jogo único é o oposto do que esta frente quer: resolve em três horas,
 * não reage a manchete, e a série dele morre no apito final. Fica temporada:
 * título, artilheiro, rebaixamento, Bola de Ouro, campeão de F1.
 *
 * ## `gameStartTime` NÃO serve, e essa é a lição desta rodada
 *
 * A primeira versão deste filtro também descartava quem tivesse `gameStartTime`,
 * pela suposição óbvia de que só jogo tem horário de início. Errado, e o
 * relatório de categorias pegou no primeiro uso: "Will WTI Crude Oil hit (LOW)
 * $60 in August?", com 181 mil de liquidez, saiu como mercado de partida.
 *
 * Medido em 2026-08-14, 300 markets por tag nas 12 tags do recorte:
 *
 *   `sportsMarketType`  170 em `sports`, ZERO em todas as outras onze.
 *   `gameStartTime`     os mesmos 170 em `sports`, MAIS 104 fora dela —
 *                       61 em `finance` (WTI Crude), 21 em `politics`,
 *                       19 em `geopolitics`, 2 em `economy`, 1 em `world`.
 *   nenhum market tem `sportsMarketType` sem `gameStartTime`.
 *
 * Ou seja: o campo do horário é usado pela Polymarket para qualquer mercado com
 * janela de observação, e o da taxonomia é exato. Um sinal redundante que erra
 * 104 vezes não é uma rede de segurança — é o filtro inteiro errando junto.
 */
export function ehMercadoDePartida(m: RadarMarketInput): boolean {
  return m.sportsMarketType != null && m.sportsMarketType !== '';
}

export type MotivoDescarte =
  | 'esports (coleta desligada)'
  | 'mercado de partida (jogo único)'
  | 'fechado ou inativo'
  | 'endDate ausente'
  | 'endDate vencido'
  | 'prazo acima do teto'
  | 'não aceita ordem / sem book'
  | 'livro vazio (nenhum dos dois lados)'
  | 'sem token de CLOB';

export type Triagem =
  | { ok: true; candidato: RadarCandidate }
  | { ok: false; motivo: MotivoDescarte };

/**
 * O market passa nos critérios de COLETA?
 *
 * São seis, e nenhum deles é opinião sobre o mercado:
 *
 *   1. aberto, ativo, não arquivado          viabilidade
 *   2. livro com PELO MENOS UM lado          sem nenhum não há preço para ler
 *   3. categoria                             (aplicada antes, pela tag baixada)
 *   4. resolve em até `horizonMaxDays`       evita fotografar 2028 por dois anos
 *   5. não é mercado de partida              jogo único resolve em 3h e não
 *                                            reage a manchete (ver `ehMercadoDePartida`)
 *   6. teto por ranking de liquidez          (aplicado depois, em `montarRoster`)
 *
 * ## Um lado basta, e exigir os dois era o erro caro
 *
 * A versão anterior exigia bid E ask. Medido em 2026-08-14, isso descartava
 * **274 mercados** — e os mais líquidos deles eram exatamente a tese em estado
 * puro: Eduardo Leite (1,8M de liquidez), Aldo Rebelo (1,6M) e Massa Jr. (1,6M)
 * na eleição brasileira, os 20 pilotos da F1, a lista inteira da eleição da
 * Califórnia. Azarão com venda e sem compra.
 *
 * O critério nasceu de um medo legítimo mas de OUTRO caso: livro VAZIO. Livro
 * vazio dá mid 0,50 por aritmética — média de dois nulos tratados como zero — e
 * isso já fabricou edge falso neste projeto (a frente do XTracker). Só que
 * azarão com um lado só não é livro vazio: ele tem preço real, negociado, e é
 * onde uma notícia move mais forte. O medo continua certo; o filtro estava no
 * lugar errado.
 *
 * O conserto de verdade não é aqui, é em `montarLinha`: **`mid_price` fica NULO
 * quando falta um lado.** Nunca 0,50, nunca o lado único repetido, nunca um
 * chute. Meio-preço vira conta da view, onde nulo é resposta legítima. Com essa
 * regra garantida lá, a porta aqui pode ser larga sem risco de número inventado.
 *
 * Fica de fora só quem não tem NENHUM lado — aí não há preço, e a linha nem
 * chega a ser montada (`montarLinha` devolve `null`).
 *
 * ## O livro invertido saiu da porta
 *
 * O critério antigo também barrava `ask <= bid`. Saiu pelo mesmo princípio que
 * tirou a faixa de preço: livro cruzado é propriedade que MUDA, dura segundos, e
 * descartar por ela tira o mercado do roster por 6h (a renovação) por causa de
 * um instante. Fica gravado como está — `spread` negativo é observação, e a view
 * decide o que fazer com ele.
 *
 * ## `jaMarcado`, o que sobrou dele
 *
 * Continua dispensando do critério 2, e agora o que ele dispensa é o piso do
 * livro VAZIO: quem já tem série protegida fica no roster mesmo com os dois
 * lados secos. Perto da resolução o livro seca de verdade, e tirar o mercado do
 * roster ali abriria buraco na série no trecho mais informativo. Não custa linha
 * falsa — sem livro, `montarLinha` não grava nada.
 */
export function triar(m: RadarMarketInput, rules: RadarRules, nowMs: number): Triagem {
  const no = (motivo: MotivoDescarte): Triagem => ({ ok: false, motivo });
  const jaMarcado = m.jaMarcado === true;

  if (PREFIXOS_ESPORTS.some(p => m.slug.startsWith(p))) return no('esports (coleta desligada)');
  if (ehMercadoDePartida(m)) return no('mercado de partida (jogo único)');
  if (m.closed || !m.active) return no('fechado ou inativo');

  if (!m.endDate) return no('endDate ausente');
  const fim = Date.parse(m.endDate);
  if (Number.isNaN(fim)) return no('endDate ausente');
  if (fim < nowMs) return no('endDate vencido');
  if (fim > nowMs + rules.horizonMaxDays * DIA_MS) return no('prazo acima do teto');

  // `!== false` e não `=== true`: resposta antiga da Gamma omite os dois campos,
  // e tratar ausência como "não aceita ordem" esvaziaria o roster em silêncio no
  // dia em que a API mudasse de forma.
  if (m.acceptingOrders === false || m.enableOrderBook === false) {
    return no('não aceita ordem / sem book');
  }

  const { bid, ask, lados } = ladosDoLivro(m);
  if (lados === 0 && !jaMarcado) return no('livro vazio (nenhum dos dois lados)');

  // Sem token não há livro para fotografar depois — o mercado entraria no roster
  // e produziria linha sem profundidade em todo ciclo.
  if (tokenYesDe(m) === null) return no('sem token de CLOB');

  return {
    ok: true,
    candidato: {
      market: m,
      tema: m.tema,
      preco: precoYes(m),
      liquidez: liquidezDe(m),
      volume24h: volume24hDe(m),
      // Mesma regra de `montarLinha`: sem os dois lados não há spread, e
      // inventar um seria a mesma aritmética que fabrica mid de 0,50.
      spread: bid !== null && ask !== null ? ask - bid : null,
      lados,
      eventId: m.events?.[0]?.id ?? m.id,
      grupoId: -1,
      assunto: '—',
      jaMarcado,
    },
  };
}

/**
 * Quais lados do livro a Gamma publica para este market.
 *
 * O que conta como lado AUSENTE, e por que cada limite está aqui:
 *
 *   bid  ausente quando `null`/`undefined` ou `<= 0`. A Gamma devolve `0` para
 *        "ninguém comprando", não omite o campo — tratar 0 como preço poria um
 *        mercado a zero na série.
 *   ask  ausente quando `null`/`undefined`, `<= 0` ou `>= 1`. O `>= 1` é o
 *        mesmo caso do outro lado: 1,00 é o preenchimento de "ninguém
 *        vendendo", não uma oferta.
 *
 * Não julga se o livro está cruzado — ver o comentário de `triar`.
 */
export function ladosDoLivro(m: Pick<RadarMarketInput, 'bestBid' | 'bestAsk'>): {
  bid: number | null;
  ask: number | null;
  lados: 0 | 1 | 2;
} {
  const bruto = (v: number | null | undefined): number | null =>
    v == null || !Number.isFinite(v) ? null : v;

  const b = bruto(m.bestBid);
  const a = bruto(m.bestAsk);
  const bid = b !== null && b > 0 ? b : null;
  const ask = a !== null && a > 0 && a < 1 ? a : null;

  return { bid, ask, lados: ((bid === null ? 0 : 1) + (ask === null ? 0 : 1)) as 0 | 1 | 2 };
}

/** O token do outcome 0 (YES no binário) — a chave do livro no CLOB. */
export function tokenYesDe(m: RadarMarketInput): string | null {
  const tokens = parseJsonArray(m.clobTokenIds);
  const t = tokens[0];
  return t !== undefined && t.length > 0 ? t : null;
}

// ---------------------------------------------------------------------------
// Espelhos — DIAGNÓSTICO, não filtro
// ---------------------------------------------------------------------------

/** Faixa em que a soma dos dois YES conta como espelho. */
export const ESPELHO_MIN = 0.97;
export const ESPELHO_MAX = 1.03;

export interface ParEspelho {
  a: RadarCandidate;
  b: RadarCandidate;
  soma: number;
}

/**
 * "BoJ sem mudança" a 0,27 e "BoJ +25 bps" a 0,72 somam 0,99: julgar os dois é
 * julgar um.
 *
 * Isso continua verdade, e continua sendo motivo para não contar os dois como
 * duas observações — mas na hora de MEDIR, não na hora de coletar. A soma dos
 * dois preços é propriedade que muda, e um par que soma 0,99 hoje pode somar
 * 0,94 amanhã; descartar por ela seria apagar a série de um mercado por causa do
 * preço do outro. Aqui o espelho vira CONTADOR, e quem descarta é a view.
 */
export function detectarEspelhos(cands: readonly RadarCandidate[]): ParEspelho[] {
  const porEvento = new Map<string, RadarCandidate[]>();
  for (const c of cands) {
    const lista = porEvento.get(c.eventId);
    if (lista === undefined) porEvento.set(c.eventId, [c]);
    else lista.push(c);
  }

  const pares: ParEspelho[] = [];
  for (const lista of porEvento.values()) {
    for (let i = 0; i < lista.length; i++) {
      for (let j = i + 1; j < lista.length; j++) {
        const a = lista[i] as RadarCandidate;
        const b = lista[j] as RadarCandidate;
        if (a.preco === null || b.preco === null) continue;
        const soma = a.preco + b.preco;
        if (soma >= ESPELHO_MIN && soma <= ESPELHO_MAX) pares.push({ a, b, soma });
      }
    }
  }
  return pares;
}

// ---------------------------------------------------------------------------
// Assunto — agora é COLUNA, não teto
// ---------------------------------------------------------------------------

const MESES = new Set([
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
]);

/**
 * Componentes de entidade de uma pergunta, para servirem de chave de assunto.
 *
 * `extractEntities` devolve nomes próprios inteiros — "us-iran final nuclear
 * deal" sai como UMA entidade. Para ligar mercados por assunto isso é grosso
 * demais: o mercado do bloqueio não repete a frase toda, ele diz "Iranian".
 * Quebrar em componentes é o que faz `iran` ser a chave compartilhada.
 *
 * Mês e número saem: ligariam "September 30" com "September 30" e agrupariam
 * metade do universo por prazo comum, que não é assunto nenhum.
 */
export function componentesDeAssunto(pergunta: string): Set<string> {
  const out = new Set<string>();
  for (const entidade of extractEntities(pergunta)) {
    for (const parte of entidade.split(/[\s-]+/)) {
      // Dois caracteres entram: `US` é componente, e sem ele "US-Iran Final
      // Nuclear Deal" compartilharia só `iran` com "US-Iran meeting". Sigla de
      // dois é sigla; o que protege contra ruído é a regra de duas chaves.
      if (parte.length < 2) continue;
      if (MESES.has(parte)) continue;
      if (/^[\d.,$%]+$/.test(parte)) continue;
      out.add(parte);
    }
  }
  return out;
}

/**
 * Gentílico: `russia`/`russian`, `iran`/`iranian`. Prefixo de no mínimo 4
 * caracteres, que é onde ele para de gerar falso positivo — abaixo disso
 * `new`/`news` já casaria. Não é stemmer e não pretende ser.
 */
function mesmaChave(a: string, b: string): boolean {
  if (a === b) return true;
  const [curta, longa] = a.length <= b.length ? [a, b] : [b, a];
  return curta.length >= 4 && longa.startsWith(curta);
}

/** Texto sozinho basta: mesmo limiar da camada 3 do gerador da spec 003. */
export const LIGACAO_JACCARD_FORTE = 0.4;
/**
 * Com uma entidade só, o texto precisa concordar um pouco. 0,25 é onde os dois
 * casos medidos se separam: "Iran charges Hormuz fees" e "Strait of Hormuz
 * traffic returns to normal" compartilham só `hormuz` e dão 0,30 — mesmo
 * assunto. "Russia capture Kostyantynivka" e "Bank of Russia key rate"
 * compartilham só `russia` e dão 0,18 — assuntos diferentes.
 */
export const LIGACAO_JACCARD_FRACO = 0.25;

export interface GrupoAssunto {
  rotulo: string;
  membros: number[];
}

/**
 * Agrupa por assunto: união de "compartilham entidade" com "são textualmente
 * parecidos", em union-find.
 *
 * O RESULTADO mudou de papel: era teto (3 por assunto) e agora é rótulo gravado
 * em `events.radar_subject`. A diferença importa porque muda o custo do erro. Um
 * agrupamento errado que barrava a coleta perdia série para sempre; um
 * agrupamento errado numa coluna é um `group by` que a view refaz — e o rótulo
 * heterogêneo (`*`) diz onde olhar.
 *
 * UMA entidade compartilhada é indício, não prova, e a primeira versão disto
 * tratava como prova: saiu um grupo "russia" com 13 mercados fundindo a guerra
 * na Ucrânia, a taxa do banco central russo e a eleição parlamentar. Nome de
 * país não é assunto, é dimensão. A causa é a pergunta em Title Case, onde
 * `extractEntities` devolve `region`, `wins`, `every` como se fossem nomes
 * próprios. Então a entidade só liga acompanhada: de uma SEGUNDA entidade, ou de
 * similaridade textual mínima.
 *
 * Custo: é O(n²) em pares. Com o teto do roster na casa das centenas são
 * ~10⁵ comparações de conjunto por renovação (a cada 6h), o que é irrelevante.
 * Com dezenas de milhares seria outra conversa, e é mais um motivo para o teto.
 */
export function agruparPorAssunto(cands: readonly RadarCandidate[]): GrupoAssunto[] {
  const n = cands.length;
  const chaves = cands.map(c => componentesDeAssunto(c.market.question));
  const tokens = cands.map(c => new Set(tokenize(c.market.question)));

  const pai = Array.from({ length: n }, (_, i) => i);
  const raiz = (i: number): number => {
    let r = i;
    while (pai[r] !== r) r = pai[r] as number;
    while (pai[i] !== r) [i, pai[i]] = [pai[i] as number, r];
    return r;
  };
  const unir = (a: number, b: number): void => {
    const [ra, rb] = [raiz(a), raiz(b)];
    if (ra !== rb) pai[rb] = ra;
  };

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const ci = chaves[i] as Set<string>;
      const cj = chaves[j] as Set<string>;

      let compartilhadas = 0;
      for (const a of ci) {
        for (const b of cj) {
          if (mesmaChave(a, b)) {
            compartilhadas += 1;
            break;
          }
        }
        if (compartilhadas >= 2) break;
      }

      const sim = jaccard(tokens[i] as Set<string>, tokens[j] as Set<string>);
      if (
        sim >= LIGACAO_JACCARD_FORTE ||
        compartilhadas >= 2 ||
        (compartilhadas === 1 && sim >= LIGACAO_JACCARD_FRACO)
      ) {
        unir(i, j);
      }
    }
  }

  const porRaiz = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const r = raiz(i);
    const lista = porRaiz.get(r);
    if (lista === undefined) porRaiz.set(r, [i]);
    else lista.push(i);
  }

  return [...porRaiz.values()].map(membros => {
    const contagem = new Map<string, number>();
    for (const i of membros) {
      for (const t of chaves[i] as Set<string>) contagem.set(t, (contagem.get(t) ?? 0) + 1);
    }
    const ranking = [...contagem.entries()]
      .filter(([, c]) => c > 1)
      .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
    const [melhor, segunda] = ranking;

    if (membros.length === 1) return { rotulo: '—', membros };
    if (melhor === undefined) return { rotulo: `grupo de ${membros.length}*`, membros };

    // O `*` marca grupo cuja chave dominante não está em todos os membros — é
    // onde o agrupamento juntou perguntas com a mesma FORMA e assunto diferente
    // ("Bank of Japan (...) September Meeting" e "Bank of Russia (...) September
    // Meeting"). Fica agrupado, e fica VISÍVEL que está.
    const heterogeneo = melhor[1] < membros.length;
    const rotulo =
      heterogeneo && segunda !== undefined
        ? `${melhor[0]}+${segunda[0]}*`
        : melhor[0] + (heterogeneo ? '*' : '');
    return { rotulo, membros };
  });
}

// ---------------------------------------------------------------------------
// O teto — ranking de liquidez, e nada mais
// ---------------------------------------------------------------------------

export interface RosterResult {
  roster: RadarCandidate[];
  /** Todos os que passaram na triagem, já com assunto atribuído. */
  candidatos: RadarCandidate[];
  /** Motivo → quantos markets caíram por ele. */
  descartes: Record<string, number>;
  /** Cortados pelo teto por categoria (os menores em liquidez de cada uma). */
  cortadosPorTeto: number;
  /** Cortados pelo backstop global, depois do teto por categoria. */
  cortadosPeloBackstop: number;
  /** Por categoria: quantos passaram, quantos ficaram, e a liquidez do corte. */
  porCategoria: Record<
    string,
    { candidatos: number; roster: number; liquidezDoCorte: number | null; liquidezDoPrimeiroCortado: number | null }
  >;
  /** Liquidez do último que entrou, no roster inteiro. */
  liquidezDoCorte: number | null;
  /**
   * O maior em liquidez entre TODOS os cortados, por qualquer um dos dois tetos.
   * `null` quando nenhum mordeu. É o número que diz se o teto está caro: se ele
   * for alto, o teto está deixando de fora mercado que interessa.
   */
  liquidezDoPrimeiroCortado: number | null;
  /** Espelhos DETECTADOS entre os escolhidos. Diagnóstico: nada é descartado. */
  espelhos: ParEspelho[];
  /** Quantos assuntos distintos há no roster. */
  assuntos: number;
  /** Quantos ficaram no roster, por categoria. */
  porTema: Record<string, number>;
  /**
   * Quantos entraram com o livro de UM lado só — os que a regra anterior
   * descartava. É a medida direta do que o critério dos dois lados custava.
   */
  comUmLadoSo: number;
  /**
   * Quantos entraram com o livro VAZIO dos dois lados, e só por já estarem
   * marcados. Estes não produzem linha de snapshot enquanto o livro não voltar.
   */
  mantidosPorMarca: number;
  /**
   * Liquidez dos que entraram com um lado só, para o relatório: se eles forem
   * todos pequenos, o critério antigo não custava nada; se forem os maiores da
   * categoria, custava o que a medição de 2026-08-14 mostrou.
   */
  liquidezComUmLadoSo: { min: number; mediana: number; max: number } | null;
}

/**
 * O universo inteiro vira roster: triagem, teto por liquidez, assunto.
 *
 * A ORDEM importa e mudou. Antes: filtra por preço e volume, agrupa, corta 3 por
 * assunto. Agora: filtra só o que é viável e estável, ordena por liquidez, corta
 * no teto, e só então agrupa — porque o grupo virou coluna e o agrupamento é
 * O(n²), então rodá-lo antes do corte seria pagar pelo universo inteiro para
 * rotular o que vai ser descartado.
 *
 * O corte é por LIQUIDEZ e não por volume, e a diferença é a lição desta rodada:
 * o mercado quieto de hoje é o que explode amanhã com uma notícia, e cortá-lo
 * por volume perderia justamente as primeiras horas da reação — a renovação de
 * 6h só o traria de volta depois que o interessante já passou. Liquidez é ordem
 * parada no livro: ela diz que existe MERCADO ali, sem dizer nada sobre o que
 * aconteceu nas últimas 24h.
 */
export function montarRoster(
  universo: readonly RadarMarketInput[],
  rules: RadarRules,
  nowMs: number,
): RosterResult {
  const descartes: Record<string, number> = {};
  const aprovados: RadarCandidate[] = [];

  // Um mesmo market pode voltar por duas tags (um evento de IA também marcado
  // como `tech`). Sem esta desduplicação ele contaria duas vezes no teto e
  // renderia duas linhas de snapshot por ciclo, com o mesmo `event_id`.
  const vistos = new Set<string>();

  for (const m of universo) {
    if (vistos.has(m.id)) continue;
    vistos.add(m.id);

    const t = triar(m, rules, nowMs);
    if (!t.ok) {
      descartes[t.motivo] = (descartes[t.motivo] ?? 0) + 1;
      continue;
    }
    aprovados.push(t.candidato);
  }

  // Teto POR CATEGORIA, cortando os menores em liquidez dentro de cada uma.
  const porCategoria: RosterResult['porCategoria'] = {};
  const escolhidos: RadarCandidate[] = [];
  let cortadosPorTeto = 0;
  /** O maior em liquidez entre TODOS os cortados, por qualquer um dos dois tetos. */
  let maiorCortado: number | null = null;

  const categorias = new Map<string, RadarCandidate[]>();
  for (const c of aprovados) {
    const lista = categorias.get(c.tema);
    if (lista === undefined) categorias.set(c.tema, [c]);
    else lista.push(c);
  }

  for (const [tema, lista] of categorias) {
    const ordenada = [...lista].sort((a, b) => b.liquidez - a.liquidez);
    const dentro = ordenada.slice(0, rules.maxPorCategoria);
    const fora = ordenada.slice(rules.maxPorCategoria);
    cortadosPorTeto += fora.length;
    escolhidos.push(...dentro);
    const primeiroFora = fora[0];
    if (primeiroFora !== undefined && (maiorCortado === null || primeiroFora.liquidez > maiorCortado)) {
      maiorCortado = primeiroFora.liquidez;
    }

    porCategoria[tema] = {
      candidatos: lista.length,
      roster: dentro.length,
      liquidezDoCorte: dentro.length === 0 ? null : (dentro[dentro.length - 1] as RadarCandidate).liquidez,
      liquidezDoPrimeiroCortado: fora.length === 0 ? null : (fora[0] as RadarCandidate).liquidez,
    };
  }

  // Backstop global, pela mesma régua. Com a config de hoje ele não morde.
  const ordenados = escolhidos.sort((a, b) => b.liquidez - a.liquidez);
  const roster = ordenados.slice(0, rules.rosterMax);
  const cortados = ordenados.slice(rules.rosterMax);
  const primeiroDoBackstop = cortados[0];
  if (primeiroDoBackstop !== undefined && (maiorCortado === null || primeiroDoBackstop.liquidez > maiorCortado)) {
    maiorCortado = primeiroDoBackstop.liquidez;
  }

  const grupos = agruparPorAssunto(roster);
  grupos.forEach((g, gi) => {
    for (const i of g.membros) {
      const c = roster[i] as RadarCandidate;
      c.assunto = g.rotulo;
      c.grupoId = gi;
    }
  });

  const porTema: Record<string, number> = {};
  for (const c of roster) porTema[c.tema] = (porTema[c.tema] ?? 0) + 1;

  return {
    roster,
    candidatos: aprovados,
    descartes,
    cortadosPorTeto,
    cortadosPeloBackstop: cortados.length,
    porCategoria,
    liquidezDoCorte: roster.length === 0 ? null : (roster[roster.length - 1] as RadarCandidate).liquidez,
    liquidezDoPrimeiroCortado: maiorCortado,
    espelhos: detectarEspelhos(roster),
    assuntos: grupos.length,
    porTema,
    comUmLadoSo: roster.filter(c => c.lados === 1).length,
    mantidosPorMarca: roster.filter(c => c.lados === 0).length,
    liquidezComUmLadoSo: resumoDeLiquidez(roster.filter(c => c.lados === 1)),
  };
}

/** Mínimo, mediana e máximo de liquidez. `null` para conjunto vazio. */
function resumoDeLiquidez(
  cands: readonly RadarCandidate[],
): { min: number; mediana: number; max: number } | null {
  if (cands.length === 0) return null;
  const ordenada = cands.map(c => c.liquidez).sort((a, b) => a - b);
  return {
    min: ordenada[0] as number,
    mediana: ordenada[Math.floor((ordenada.length - 1) / 2)] as number,
    max: ordenada[ordenada.length - 1] as number,
  };
}

// ---------------------------------------------------------------------------
// A foto
// ---------------------------------------------------------------------------

export interface NivelLivro {
  price: string;
  size: string;
}

export interface MelhoresNiveis {
  bid: number | null;
  ask: number | null;
  /** Dólares parados no melhor bid — `preço × tamanho`. */
  bidDepth: number | null;
  askDepth: number | null;
}

const SEM_LIVRO: MelhoresNiveis = { bid: null, ask: null, bidDepth: null, askDepth: null };

/**
 * O topo de cada lado do livro, e quantos dólares há nele.
 *
 * `bids` vem em ordem CRESCENTE e `asks` em DECRESCENTE — o melhor de cada lado
 * é o ÚLTIMO elemento, não o primeiro. Medido, e é o tipo de detalhe que
 * inverte um spread inteiro sem dar erro nenhum.
 *
 * Livro vazio devolve tudo `null` e NÃO um mid de 0,50: meio dólar por
 * aritmética de livro vazio já fabricou edge falso neste projeto.
 */
export function bestLevels(
  bids: readonly NivelLivro[] | undefined,
  asks: readonly NivelLivro[] | undefined,
): MelhoresNiveis {
  const topoBid = bids?.[bids.length - 1];
  const topoAsk = asks?.[asks.length - 1];
  if (topoBid === undefined && topoAsk === undefined) return SEM_LIVRO;

  const lado = (nivel: NivelLivro | undefined): { preco: number | null; dolares: number | null } => {
    if (nivel === undefined) return { preco: null, dolares: null };
    const preco = Number(nivel.price);
    const tamanho = Number(nivel.size);
    if (!Number.isFinite(preco) || !Number.isFinite(tamanho)) return { preco: null, dolares: null };
    return { preco, dolares: preco * tamanho };
  };

  const b = lado(topoBid);
  const a = lado(topoAsk);

  return { bid: b.preco, ask: a.preco, bidDepth: b.dolares, askDepth: a.dolares };
}

export interface RadarSnapshotRow {
  event_id: string;
  outcome: string;
  best_bid: number | null;
  best_ask: number | null;
  mid_price: number | null;
  spread: number | null;
  bid_depth: number | null;
  ask_depth: number | null;
  volume_24h: number | null;
  captured_at: string;
}

/**
 * Uma linha de série por market, e não duas.
 *
 * Os outros coletores gravam o par YES/NO. Aqui não, e a razão é que esta série
 * é PERMANENTE: `radar_tracked` a isenta dos dois ramos da retenção, para
 * sempre. A linha do NO é `1 − YES` em todos os campos — informação zero,
 * armazenamento em dobro, num conjunto que nunca é podado. Quem quiser o outro
 * lado subtrai de 1, que é o que o próprio coletor faria para gravá-lo.
 *
 * `spread` é recalculado do livro e não copiado da Gamma: os dois números são a
 * mesma coisa lida em instantes diferentes, e o que interessa é o que casa com
 * o `best_bid`/`best_ask` da MESMA linha.
 *
 * ## A regra que não pode ser quebrada
 *
 * **`mid_price` e `spread` ficam NULOS quando falta um dos lados.** Nunca 0,50,
 * nunca o lado único repetido, nunca um chute. Desde que a coleta passou a
 * aceitar livro de um lado só, uma parte do roster chega aqui com metade do
 * livro — e é exatamente aí que a armadilha mora: a média de dois valores em que
 * um foi tratado como zero dá meio dólar por ARITMÉTICA, não por consenso, e
 * esse número já fabricou edge falso neste projeto (a frente do XTracker).
 *
 * Nulo não é dado faltando: é a resposta certa. Meio-preço com um lado só não
 * existe, e quem precisar de um preço para o mercado tem `best_bid` ou
 * `best_ask` na mesma linha, explícitos sobre qual ponta são. A conta é da view.
 *
 * O teste `mid_price NUNCA é preenchido com um lado ausente` existe para falhar
 * se alguém "melhorar" isto de volta.
 */
export function montarLinha(
  eventId: string,
  outcome: string,
  niveis: MelhoresNiveis,
  volume24h: number | null,
  capturedAt: string,
): RadarSnapshotRow | null {
  if (niveis.bid === null && niveis.ask === null) return null;

  // Os dois lados presentes, ou nada. Escrito uma vez e usado duas para que não
  // exista um caminho em que `mid` e `spread` discordem sobre o que é um livro.
  const completo = niveis.bid !== null && niveis.ask !== null;
  const mid = completo ? ((niveis.bid as number) + (niveis.ask as number)) / 2 : null;
  const spread = completo ? (niveis.ask as number) - (niveis.bid as number) : null;

  return {
    event_id: eventId,
    outcome,
    best_bid: niveis.bid,
    best_ask: niveis.ask,
    mid_price: mid,
    spread,
    bid_depth: niveis.bidDepth,
    ask_depth: niveis.askDepth,
    volume_24h: volume24h,
    captured_at: capturedAt,
  };
}
