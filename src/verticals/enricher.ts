import { supabase } from '../lib/supabase.js';
import { batchInsert } from '../lib/batch-write.js';

/**
 * Registry de enrichers (spec 001, item 5 / Parte D).
 *
 * Este arquivo é só o contrato e o runner. Nenhum enricher mora aqui — eles
 * entram em `src/verticals/enrichers/` e se registram com `registerEnricher`.
 *
 * ## O que o contrato existe para impedir
 *
 * O produto final desta camada é um dataset de eval: dado um instante T, o que
 * nós sabíamos sobre uma partida naquele instante. Um eval montado sobre esse
 * dataset só vale se ele for incapaz de enxergar o futuro — e há exatamente dois
 * jeitos de o futuro vazar para dentro dele:
 *
 *   1. **Pelo eixo errado.** Filtrar o replay por `as_of` em vez de
 *      `observed_at`. Fonte que faz backfill grava hoje um fato com `as_of` de
 *      ontem; filtrar por `as_of` entrega esse fato a um T em que ninguém o
 *      tinha. Quem fecha isso é o banco: `observed_at` é carimbado por trigger,
 *      com o relógio do servidor, e nenhum código daqui o envia (ver `toRow`).
 *
 *   2. **Pela fonte errada.** Um enricher que só sabe responder "agora" —
 *      classificação atual, roster atual, odds atuais — respondendo a uma
 *      pergunta sobre um T do passado. A resposta vem contaminada por tudo que
 *      aconteceu depois, e não há como perceber isso olhando a linha gravada.
 *      Quem fecha isso é `supportsPointInTime`, e é a única coisa que separa um
 *      backtest de um número inventado. Trate como invariante, não como
 *      configuração.
 *
 * `ContextFragment` não tem campo `observedAt`, e a ausência é o desenho: o
 * enricher literalmente não tem como expressar quando nós observamos, então não
 * tem como errar nem forjar. Ele declara `asOf` — quando o fato era verdade —
 * e só.
 */

const COMPONENT = 'enricher';

// ---------------------------------------------------------------------------
// Contrato
// ---------------------------------------------------------------------------

export interface EnricherContext {
  verticalId: string;
  matchId: string;
  /**
   * OBRIGATÓRIO, e nenhum enricher pode assumir "agora" no lugar dele.
   *
   * Em produção `asOf` é o presente; em replay de eval é um instante do passado,
   * e é aí que a diferença aparece. Um enricher que ignore este campo e leia o
   * estado atual devolve, no replay, uma resposta que ninguém tinha naquele T.
   */
  asOf: Date;
}

export interface ContextFragment {
  enricherId: string;
  /** Família: 'roster' | 'map_pool' | 'h2h' | 'odds' | 'news' | ... */
  kind: string;
  /** Quando o FATO era verdade. Não é quando nós o coletamos. */
  asOf: Date;
  payload: unknown;
  /** 1-3 frases. É o que o LLM lê — o payload guarda o dado, isto guarda a leitura. */
  summary: string;
  /** [0, 1]. Texto gerado por LLM de terceiro entra <= 0.4. */
  confidence: number;
}

export interface Enricher {
  id: string;
  verticals: string[];

  /**
   * Validade do fragmento, em segundos.
   *
   * Declarado aqui e honrado por quem AGENDA, não pelo runner. Fazer o runner
   * respeitar TTL exigiria ler a tabela antes de cada execução e, pior,
   * suprimiria re-observações durante o replay — e re-observação não é
   * desperdício: "a fonte não mudou entre 14h e 18h" é um fato sobre a fonte, e
   * é justamente o tipo de linha que a série precisa ter.
   */
  ttlSeconds: number;

  /**
   * false = a fonte só devolve estado atual, sem histórico.
   *
   * Enricher com false NÃO pode participar de replay de eval, e `runEnrichers`
   * recusa executá-lo em dois casos: quando o chamador pede
   * `requirePointInTime`, e quando `asOf` está atrás de agora além da
   * tolerância — mesmo que o chamador não tenha pedido nada. A segunda recusa é
   * a que importa, porque protege de esquecimento: quem monta um replay e
   * esquece a flag continua não recebendo resposta contaminada.
   */
  supportsPointInTime: boolean;

  /**
   * O runner não impõe timeout: quem conhece a fonte é o enricher, e é ele que
   * deve abortar. Uma chamada pendurada aqui segura o ciclo inteiro.
   */
  fetch(ctx: EnricherContext): Promise<ContextFragment[]>;
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

const registry = new Map<string, Enricher>();

/**
 * Registra um enricher. Falha alto e cedo — no import, antes de qualquer
 * escrita — porque tudo que ele valida é erro de programação, não de dado.
 *
 * O id duplicado é o caso que justifica o `throw` sozinho: `enricher_id` é a
 * chave de proveniência da tabela inteira, e dois enrichers com o mesmo id
 * misturariam duas fontes numa linha só, sem sintoma. Sobrescrever em silêncio
 * (o comportamento natural de um Map) seria a pior versão disso.
 */
export function registerEnricher(enricher: Enricher): void {
  const id = enricher.id.trim();

  if (id.length === 0) {
    throw new Error(`[${COMPONENT}] enricher sem id`);
  }
  if (registry.has(id)) {
    throw new Error(`[${COMPONENT}] enricher duplicado: ${id}`);
  }
  if (enricher.verticals.length === 0) {
    throw new Error(`[${COMPONENT}] ${id}: nenhuma vertical declarada`);
  }
  if (!Number.isFinite(enricher.ttlSeconds) || enricher.ttlSeconds < 0) {
    throw new Error(`[${COMPONENT}] ${id}: ttlSeconds inválido (${enricher.ttlSeconds})`);
  }
  // Exigido explicitamente em vez de tratado como falsy. Um enricher que esquece
  // a flag e é point-in-time de verdade cairia no lado seguro — mas ficaria de
  // fora de todo replay sem dizer por quê, e o sintoma seria um enricher que
  // parece não fazer nada. Barulho na hora do registro é mais barato.
  if (typeof enricher.supportsPointInTime !== 'boolean') {
    throw new Error(`[${COMPONENT}] ${id}: supportsPointInTime não declarado`);
  }

  registry.set(id, { ...enricher, id, verticals: [...enricher.verticals] });
}

/**
 * Os enrichers de uma vertical, em ordem estável de id.
 *
 * A ordem é ordenada e não de registro porque a de registro depende da ordem dos
 * imports — que muda sozinha com um refactor. Um consumidor que concatene os
 * `summary` num prompt veria o prompt mudar sem ninguém ter mudado nada.
 */
export function getEnrichers(verticalId: string): Enricher[] {
  return [...registry.values()]
    .filter((e) => e.verticals.includes(verticalId))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Só para teste: o registry é global ao processo. */
export function resetEnrichers(): void {
  registry.clear();
}

// ---------------------------------------------------------------------------
// Por que um enricher não produziu nada
// ---------------------------------------------------------------------------

/**
 * Contador de recusas por enricher e por motivo.
 *
 * Existe por um caso concreto: o enricher da OddsPapi entrou no ar registrado,
 * ligado, com credencial, e não gravou um fragmento sequer — sem uma linha de
 * log em lugar nenhum. Devolver `[]` é a resposta certa em meia dúzia de
 * situações legítimas (fonte não cobre a partida, cadência não venceu, time sem
 * nome), e o efeito colateral é que "não tenho o que dizer" ficou
 * indistinguível de "não existo". Um componente que pode sumir em silêncio
 * acabou sumindo em silêncio.
 *
 * ## Por que contador, e não log por partida
 *
 * O job roda a cada 5 min sobre dezenas de partidas. Uma linha por recusa seriam
 * centenas por hora dizendo a mesma coisa — e este projeto já teve `system_logs`
 * em 2,7M linhas. Contado e agregado, o ciclo inteiro cabe num campo do
 * metadata: `{oddspapi: {'sem fixture na OddsPapi': 37, 'time sem nome': 3}}`.
 *
 * O motivo é texto e não enum de propósito: quem escreve o enricher sabe
 * descrever a própria recusa melhor que uma taxonomia central, e este contador
 * não toma decisão nenhuma com base nele — só o mostra.
 */
const skipCounts = new Map<string, Map<string, number>>();

export function noteEnricherSkip(enricherId: string, reason: string): void {
  const byReason = skipCounts.get(enricherId) ?? new Map<string, number>();
  byReason.set(reason, (byReason.get(reason) ?? 0) + 1);
  skipCounts.set(enricherId, byReason);
}

/** Quantas recusas este enricher já registrou no ciclo. Só para o runner. */
function skipTotalOf(enricherId: string): number {
  let total = 0;
  for (const n of skipCounts.get(enricherId)?.values() ?? []) total += n;
  return total;
}

/**
 * Devolve o acumulado e ZERA.
 *
 * Drenar em vez de só ler é o que amarra a contagem a um ciclo: o número que o
 * job publica é sempre "neste ciclo", nunca um total desde o boot que cresce
 * para sempre e não diz quando parou.
 */
export function drainEnricherSkips(): Record<string, Record<string, number>> {
  const out: Record<string, Record<string, number>> = {};

  for (const [enricherId, byReason] of skipCounts) {
    out[enricherId] = Object.fromEntries(byReason);
  }

  skipCounts.clear();
  return out;
}

// ---------------------------------------------------------------------------
// As guardas, puras e testáveis sem banco
// ---------------------------------------------------------------------------

/**
 * Folga entre o relógio de quem chama e o instante real da execução.
 *
 * Não é precisão de replay, é ruído de agendamento: um ciclo que calcula
 * `asOf = new Date()` e só chega aqui alguns segundos depois não pode ser
 * confundido com um replay histórico. Cinco minutos é folgado o bastante para
 * uma fila lenta e curto o bastante para que nenhum replay de verdade caiba
 * dentro dele.
 */
export const DEFAULT_POINT_IN_TIME_TOLERANCE_MS = 5 * 60_000;

export interface RunEnrichersOptions {
  /**
   * Replay de eval. Pula todo enricher com `supportsPointInTime = false`,
   * inclusive quando `asOf` é agora.
   */
  requirePointInTime?: boolean;
  pointInTimeToleranceMs?: number;
}

/**
 * Por que este enricher não deve rodar para este `asOf` — ou `null` se deve.
 *
 * Devolve texto porque o motivo vai para o log: um enricher pulado em silêncio
 * é indistinguível de um enricher quebrado.
 */
export function enricherSkipReason(
  enricher: Pick<Enricher, 'id' | 'supportsPointInTime'>,
  asOf: Date,
  now: Date,
  opts: RunEnrichersOptions = {},
): string | null {
  const asOfMs = asOf.getTime();
  if (!Number.isFinite(asOfMs)) return 'asOf inválido';

  const tolerance = opts.pointInTimeToleranceMs ?? DEFAULT_POINT_IN_TIME_TOLERANCE_MS;
  const nowMs = now.getTime();

  // Vale para TODO enricher, inclusive os point-in-time: nenhuma fonte responde
  // sobre um instante que ainda não chegou. Um `asOf` no futuro é erro de quem
  // chama, e deixar passar produziria fragmento que o replay leria como
  // conhecimento antecipado.
  if (asOfMs > nowMs + tolerance) return 'asOf no futuro';

  if (enricher.supportsPointInTime) return null;

  if (opts.requirePointInTime === true) {
    return 'fonte sem point-in-time, e o chamador exige replay';
  }

  if (asOfMs < nowMs - tolerance) {
    const minutes = Math.round((nowMs - asOfMs) / 60_000);
    return `fonte sem point-in-time, e asOf está ${minutes} min no passado`;
  }

  return null;
}

/**
 * Por que este fragmento não pode ser gravado — ou `null` se pode.
 *
 * Validar aqui, e não deixar o Postgres recusar, é o que impede um enricher
 * defeituoso de derrubar os fragmentos dos outros: a escrita é em lote, e um
 * chunk é uma transação — uma linha inválida perde o lote inteiro (ver
 * `src/lib/batch-write.ts`).
 */
export function fragmentRejection(
  fragment: ContextFragment,
  now: Date,
  opts: RunEnrichersOptions = {},
): string | null {
  if (fragment.kind.trim().length === 0) return 'kind vazio';
  if (fragment.summary.trim().length === 0) return 'summary vazio';

  // `payload jsonb not null`: null ou undefined viram NULL no PostgREST e
  // derrubam o chunk. Fragmento sem payload também não teria o que ser auditado
  // depois contra o `summary`.
  if (fragment.payload === null || fragment.payload === undefined) return 'payload ausente';

  if (!Number.isFinite(fragment.confidence) || fragment.confidence < 0 || fragment.confidence > 1) {
    return `confidence fora de [0,1]: ${fragment.confidence}`;
  }

  const asOfMs = fragment.asOf.getTime();
  if (!Number.isFinite(asOfMs)) return 'asOf inválido';

  const tolerance = opts.pointInTimeToleranceMs ?? DEFAULT_POINT_IN_TIME_TOLERANCE_MS;
  if (asOfMs > now.getTime() + tolerance) return 'asOf no futuro';

  return null;
}

// ---------------------------------------------------------------------------
// Leitura do próprio registro
// ---------------------------------------------------------------------------

/**
 * O `as_of` do último fragmento gravado para este par (partida, enricher).
 *
 * Serve a um caso específico: fonte que publica o próprio carimbo de mudança —
 * `context_updated_at` da Polymarket é o exemplo. Quando esse carimbo não mudou,
 * o texto não mudou, e regravá-lo a cada ciclo produz linhas idênticas de 1-2 KB
 * que não acrescentam nada ao que a linha anterior já diz. Não é o caso de
 * `market-history`, onde cada execução traz preço novo — por isso a checagem é
 * do enricher que precisa dela, e não do runner.
 *
 * `null` quando não há fragmento, quando a tabela não existe, ou quando a
 * leitura falha. As três respostas levam ao mesmo lugar: gravar. Duplicar uma
 * linha é barato; perder uma observação por causa de um erro de leitura, não.
 */
export async function lastFragmentAsOf(matchId: string, enricherId: string): Promise<Date | null> {
  const { data, error } = await supabase
    .from('context_fragments')
    .select('as_of')
    .eq('match_id', matchId)
    .eq('enricher_id', enricherId)
    .order('observed_at', { ascending: false })
    .limit(1);

  if (error) return null;

  const raw = data?.[0]?.['as_of'];
  if (typeof raw !== 'string') return null;

  const parsed = new Date(raw);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

// ---------------------------------------------------------------------------
// Escrita
// ---------------------------------------------------------------------------

/**
 * A linha, sem `observed_at`.
 *
 * A ausência é o ponto: o banco carimba a coluna por trigger, com o relógio do
 * servidor, e o trigger sobrescreve o que vier do cliente. Não enviar é a
 * primeira camada — nenhum caminho deste processo consegue backdatear uma
 * observação nem por engano.
 *
 * `enricher_id` vem do registry e não de `fragment.enricherId`: proveniência é
 * propriedade de quem produziu, não de um campo que o produtor preenche. O
 * registry já garante que o id é único; o campo do fragmento, não.
 */
function toRow(
  matchId: string,
  enricherId: string,
  fragment: ContextFragment,
): Record<string, unknown> {
  return {
    match_id: matchId,
    enricher_id: enricherId,
    kind: fragment.kind.trim(),
    as_of: fragment.asOf.toISOString(),
    payload: fragment.payload,
    summary: fragment.summary.trim(),
    confidence: fragment.confidence,
  };
}

/**
 * A migration `20260806211531_context_fragments` é aplicada à mão (H4/H5) e o
 * deploy do código é automático — entre um e outro a tabela não existe. Mesmo
 * padrão de `esports-snapshots.ts` e do resolver.
 */
const PROBE_RETRY_MS = 10 * 60_000;
let tableAvailable: boolean | null = null;
let probedAt = 0;

export function resetFragmentsProbe(): void {
  tableAvailable = null;
  probedAt = 0;
}

/**
 * Exportada porque `runEnrichers` devolve `[]` tanto quando não há o que gravar
 * quanto quando a tabela não existe, e o job precisa distinguir as duas para
 * reportar `partial` com a mensagem certa em vez de "nada a fazer".
 */
export async function fragmentsTableAvailable(): Promise<boolean> {
  const now = Date.now();
  if (tableAvailable === true) return true;
  if (tableAvailable === false && now - probedAt < PROBE_RETRY_MS) return false;

  const { error } = await supabase.from('context_fragments').select('id').limit(1);
  probedAt = now;
  tableAvailable = !error;

  if (error) {
    console.warn(
      `[${COMPONENT}] context_fragments indisponível (${error.message}) — migration 20260806211531 não aplicada`,
    );
  }

  return tableAvailable;
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

/**
 * Roda os enrichers da vertical, grava os fragmentos e devolve o que foi gravado.
 *
 * Três decisões que valem estar explícitas, porque as três são silenciosas:
 *
 * **Sem tabela, não busca nada.** Se a migration não estiver aplicada, o runner
 * devolve `[]` sem chamar enricher nenhum. Buscar para depois descartar gastaria
 * chamada externa e limite de taxa por um resultado que evapora — e o único
 * consumidor deste runner hoje é o registro. Um chamador que receba `[]` com o
 * aviso no log percebe; um que receba fragmentos nunca saberia que nada foi
 * guardado.
 *
 * **O retorno é o que se sabe persistido, não o que foi buscado.** Falha de
 * escrita devolve `[]`. `batchInsert` reporta a faixa do chunk que caiu, não as
 * linhas, então em falha parcial não dá para dizer QUAIS passaram — e o retorno
 * prefere subestimar. Quem quiser o conteúdo real lê a tabela, que é a fonte de
 * verdade aqui.
 *
 * **Um enricher que explode não derruba os outros.** Cada `fetch` é isolado, e
 * cada fragmento é validado antes de entrar no lote.
 */
export async function runEnrichers(
  ctx: EnricherContext,
  opts: RunEnrichersOptions = {},
): Promise<ContextFragment[]> {
  const enrichers = getEnrichers(ctx.verticalId);
  if (enrichers.length === 0) return [];

  if (!(await fragmentsTableAvailable())) return [];

  const now = new Date();
  const fragments: ContextFragment[] = [];
  const rows: Record<string, unknown>[] = [];

  for (const enricher of enrichers) {
    const skip = enricherSkipReason(enricher, ctx.asOf, now, opts);
    if (skip !== null) {
      // Contado ALÉM do console: o `console.warn` vai para o stdout do processo,
      // que não é onde ninguém procura depois. O contador chega ao metadata do
      // ciclo, que é o registro que sobrevive.
      noteEnricherSkip(enricher.id, skip);
      console.warn(`[${COMPONENT}] ${enricher.id} pulado em ${ctx.matchId}: ${skip}`);
      continue;
    }

    // Marca d'água para não contar duas vezes: o enricher que já nomeou a
    // própria recusa não deve receber por cima o motivo genérico.
    const skipsBefore = skipTotalOf(enricher.id);

    let produced: ContextFragment[];
    try {
      produced = (await enricher.fetch(ctx)) ?? [];
    } catch (err) {
      noteEnricherSkip(enricher.id, 'exceção no fetch');
      console.error(`[${COMPONENT}] ${enricher.id} falhou em ${ctx.matchId}: ${String(err)}`);
      continue;
    }

    // Devolveu vazio e não disse por quê. Não é erro — pode ser a fonte não ter
    // o que dizer sobre esta partida — mas some do relatório se não for contado,
    // e some justamente o caso em que o enricher está quebrado. Enricher que
    // nomeia as próprias saídas nunca cai aqui; o que cair é candidato a
    // nomeá-las também.
    if (produced.length === 0 && skipTotalOf(enricher.id) === skipsBefore) {
      noteEnricherSkip(enricher.id, 'sem fragmentos, sem motivo declarado');
    }

    for (const fragment of produced) {
      const rejection = fragmentRejection(fragment, now, opts);
      if (rejection !== null) {
        console.warn(`[${COMPONENT}] ${enricher.id}: fragmento descartado (${rejection})`);
        continue;
      }

      // Não é motivo para descartar — o dado é bom, só a etiqueta está errada —
      // mas é bug do enricher e some se ninguém disser.
      if (fragment.enricherId !== enricher.id) {
        console.warn(
          `[${COMPONENT}] ${enricher.id}: fragmento diz enricherId=${fragment.enricherId}, gravando como ${enricher.id}`,
        );
      }

      fragments.push(fragment);
      rows.push(toRow(ctx.matchId, enricher.id, fragment));
    }
  }

  if (rows.length === 0) return [];

  const result = await batchInsert('context_fragments', rows, { label: COMPONENT });

  if (result.failedRows > 0) {
    console.error(
      `[${COMPONENT}] ${result.failedRows}/${rows.length} fragmentos não gravados em ${ctx.matchId}: ${result.errors.join(' | ')}`,
    );
    return [];
  }

  return fragments;
}
