import 'dotenv/config';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { section, table } from './lib/probe-net.js';
import { filtrarDigeriveis, resumoDoDescarte } from './lib/fila-digestao.js';
import { vereditoDoNivelamento } from './lib/veredito-nivelamento.js';
import { supabase } from '../src/lib/supabase.js';
import { getSystemConfig } from '../src/lib/config.js';
import {
  DigestError,
  estimateOne,
  hashDescription,
  knownModel,
  runDigest,
  type DigestResult,
} from '../src/digest/digest.js';
import { getPrompt } from '../src/digest/prompts.js';
import {
  buildDigestRows,
  proximaLeitura,
  readDigested,
  readMarketsToDigest,
  type DigestedIndex,
  type MarketToDigest,
} from '../src/digest/store.js';

/**
 * Passo 2b: **toda regra distinta passa a ter no mínimo 3 leituras.**
 *
 * Não é uma versão nova da digestão. É a v4 exatamente como está, lida mais
 * vezes onde foi lida de menos. Mesmo modelo, mesmo prompt, mesma taxonomia,
 * mesmos limites. Uma variável muda — quantas vezes cada texto foi lido — e é
 * só por isso que o critério de sucesso lá embaixo significa alguma coisa.
 *
 *   npm run nivelar -- --dry-run     # a conta, sem chamar nada
 *   npm run nivelar                  # a corrida
 *   npm run nivelar -- --conferir    # as três invariantes, DEPOIS da carga
 *
 * ---------------------------------------------------------------------------
 * Por que
 * ---------------------------------------------------------------------------
 *
 * A lista de achados tem qualidade desigual, e a desigualdade não é do mundo:
 *
 *   - 191 textos de regra distintos entre as 728 digestões;
 *   - 112 foram lidos UMA vez (aparecem num mercado só); um foi lido 44 vezes;
 *   - nos textos lidos mais de uma vez, 52% dos achados apareceram em uma
 *     leitura só e apenas 9,9% em todas.
 *
 * Um mercado com 20 achados e outro com 3 parecem ter regulamentos de
 * periculosidade diferente. Pode ser só que um foi lido 44 vezes e o outro uma.
 * É a variação do INSTRUMENTO se disfarçando de variação do MUNDO — o mesmo
 * erro que este projeto já cometeu com os nomes de "ordenar por volume" e de
 * "livro vazio tem mid 0,50".
 *
 * O primeiro sábado de julgamento inicia o relógio de dois meses da calibração.
 * Ele não pode começar sobre uma lista torta.
 *
 * ---------------------------------------------------------------------------
 * A armadilha, que é o motivo de este script existir separado
 * ---------------------------------------------------------------------------
 *
 * A dedup da escada é por (evento, hash, modelo, versão). Uma segunda leitura
 * v4 do mesmo mercado cai EXATAMENTE nessa chave. Rodar o nivelamento pelo
 * caminho normal pularia tudo em silêncio e terminaria verde tendo feito nada —
 * a mesma família da migration que roda verde enquanto falha.
 *
 * Por isso:
 *
 *   - a fila daqui NÃO passa por `jaDigerido`. Ela é montada a partir da
 *     contagem por TEXTO, que é a pergunta certa: "este texto tem 3 leituras?".
 *   - `leitura_n` entra na linha e na chave do banco
 *     (`20260817163046_leitura_n_em_market_rule_digests.sql`);
 *   - sem essa coluna aplicada, este script RECUSA fazer chamada paga. Gastar
 *     para produzir dado que não pode ser carregado não é meio-sucesso.
 *
 * ---------------------------------------------------------------------------
 * O critério de sucesso, declarado ANTES de rodar
 * ---------------------------------------------------------------------------
 *
 * Sobre os textos que ganharam leitura, comparando o conjunto de achados
 * DISTINTOS antes e depois (mesma chave da `digest_achados_por_mercado`):
 *
 *   >= 30% a mais  → o diagnóstico de recall se confirma também nos textos
 *                    únicos. O nivelamento valeu.
 *   <  10% a mais  → o recall baixo era propriedade dos textos REPETIDOS, não
 *                    lei geral. Isso é um ACHADO, não um fracasso: o projeto
 *                    passa a saber que uma leitura basta para regra única.
 *   entre os dois  → inconclusivo, e reportado como inconclusivo.
 *
 * O script imprime o número e o veredito, e não escolhe o veredito depois de
 * ver o número.
 */

const LABEL = 'nivelar-leituras';
const ARTEFATO = 'probes/digest/nivelamento-v4';

/**
 * O mínimo de leituras por texto. 3 e não 2 porque com duas leituras um achado
 * que aparece numa e não na outra fica em 1/2 — empate, sem maioria. Com três,
 * 2/3 é maioria e 1/3 é a leitura solitária que a contagem já sabe descontar.
 */
const MINIMO_PADRAO = 3;

/**
 * O teto deste passo, em dólar. Independente e MAIS APERTADO que
 * `digest_daily_budget_usd` (5,00): o teto do dia protege o dia, este protege
 * ESTA operação. A projeção medida é de US$ 0,87 para 242 chamadas; 2,00 dá
 * folga de mais de 2× e ainda barra um laço que resolva rodar o universo.
 */
const TETO_PADRAO = 2;

/** O mesmo de `digerir-regras`, e pelo mesmo motivo: o teto é conferido antes
 * de despachar, então N simultâneas podem estourar em até N-1 chamadas. */
const CONCORRENCIA = 4;

// ---------------------------------------------------------------------------
// Argumentos
// ---------------------------------------------------------------------------

interface Args {
  dryRun: boolean;
  conferir: boolean;
  minimo: number;
  teto: number;
  limit: number | null;
  model: string | null;
  prompt: string | null;
}

function parseArgs(argv: readonly string[]): Args | { error: string } {
  const args: Args = {
    dryRun: false,
    conferir: false,
    minimo: MINIMO_PADRAO,
    teto: TETO_PADRAO,
    limit: null,
    model: null,
    prompt: null,
  };

  for (const arg of argv) {
    if (arg === '--dry-run') {
      args.dryRun = true;
      continue;
    }
    if (arg === '--conferir') {
      args.conferir = true;
      continue;
    }

    const match = /^--(minimo|teto|limit|model|prompt)=(.+)$/.exec(arg);
    if (match === null) return { error: `argumento desconhecido: ${arg}` };
    const [, key, value = ''] = match;

    if (key === 'model') {
      args.model = value;
      continue;
    }
    if (key === 'prompt') {
      args.prompt = value;
      continue;
    }

    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return { error: `--${key}=${value} não é um número positivo` };

    if (key === 'minimo') args.minimo = Math.trunc(n);
    else if (key === 'teto') args.teto = n;
    else args.limit = Math.trunc(n);
  }

  return args;
}

interface Combinacao {
  model: string;
  promptVersion: string;
}

/**
 * Com o que reler, decidido pelas LINHAS e não pela config.
 *
 * `system_config` guarda o default do PRÓXIMO comando, não o registro do que
 * foi rodado. Em 17/08/2026 ela dizia `v1` enquanto as 728 digestões eram
 * `deepseek-v4-flash`/`v4` — a passada usou `--prompt=v4`. Um nivelamento que
 * lesse a config releria os textos da v4 em v1, e as leituras novas entrariam
 * sob o mesmo texto com outro prompt: o "antes e depois" passaria a comparar
 * duas variáveis de uma vez, que é justamente o que este passo existe para
 * evitar.
 *
 * Mais de uma combinação gravada não tem default seguro — o script para e
 * pede `--model=` e `--prompt=`. Escolher a maioria seria escolher em silêncio.
 */
function escolherCombinacao(
  index: DigestedIndex,
  args: Args,
): Combinacao | { error: string } {
  if (args.model !== null && args.prompt !== null) {
    return { model: args.model, promptVersion: args.prompt };
  }

  const combos = [...index.combinacoes.entries()].sort((a, b) => b[1] - a[1]);
  if (combos.length === 0) return { error: 'não há digestão nenhuma gravada — não há o que nivelar.' };

  if (combos.length > 1) {
    const lista = combos.map(([k, v]) => `    ${k.replace('|', '  ')}  (${v} linhas)`).join('\n');
    return {
      error:
        'há mais de uma combinação de modelo/versão no banco, e nivelar é RELER o que já foi lido:\n' +
        `${lista}\n` +
        '  Diga qual com --model=NOME --prompt=vN. Escolher a maioria seria escolher em silêncio.',
    };
  }

  const [combo] = combos;
  const [model = '', promptVersion = ''] = (combo?.[0] ?? '').split('|');
  return {
    model: args.model ?? model,
    promptVersion: args.prompt ?? promptVersion,
  };
}

function usd(v: number): string {
  return `US$ ${v.toFixed(v < 0.01 ? 5 : 4)}`;
}

function mediana(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const meio = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[meio] ?? null;
  return ((sorted[meio - 1] ?? 0) + (sorted[meio] ?? 0)) / 2;
}

// ---------------------------------------------------------------------------
// A chave do achado — a MESMA da digest_achados_por_mercado
// ---------------------------------------------------------------------------

/**
 * A normalização da conferência de trecho: minúscula e espaço colapsado.
 * Tolera grafia, não tolera paráfrase.
 */
function n(s: string): string {
  return s.trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * A chave de um achado, replicando `digest_achados_por_mercado` em TypeScript.
 *
 * Duplicação consciente, e o mesmo argumento de `conferir-views.ts`: a regra
 * mora em SQL, SQL aqui não tem teste, e uma view errada não quebra — devolve
 * número. Duas implementações que concordam não provam que a regra está certa;
 * duas que discordam provam que uma está errada. Se o critério de sucesso for
 * calculado pelo mesmo código da view, ele não é segunda opinião nenhuma.
 *
 * O prefixo por classe, o `tipo` dentro da chave da ambiguidade e a ausência da
 * `severidade` na da pegadinha são decisões da view, documentadas lá.
 */
function chaveAchado(a: {
  classe: 'pegadinha' | 'ambiguidade' | 'contradicao';
  tipo: string | null;
  trecho: string;
  trechoConflito: string | null;
}): string {
  if (a.classe === 'pegadinha') return `pegadinha||${n(a.trecho)}`;
  if (a.classe === 'ambiguidade') return `ambiguidade||${a.tipo ?? ''}||${n(a.trecho)}`;
  const [x, y] = [n(a.trecho), n(a.trechoConflito ?? '')].sort();
  return `contradicao||${x}||${y}`;
}

/** Os achados ancorados de uma saída do modelo, já com a chave. */
function chavesDaSaida(result: DigestResult): string[] {
  const chaves: string[] = [];

  for (const p of result.output.pegadinhas) {
    if (p.trecho === null || p.trecho.trim() === '') continue;
    chaves.push(chaveAchado({ classe: 'pegadinha', tipo: null, trecho: p.trecho, trechoConflito: null }));
  }
  for (const a of result.output.ambiguidades) {
    if (a.trecho === null || a.trecho.trim() === '') continue;
    if (a.tipo === 'contradicao_interna') {
      if (a.trechoConflito === null || a.trechoConflito.trim() === '') continue;
      chaves.push(
        chaveAchado({
          classe: 'contradicao',
          tipo: a.tipo,
          trecho: a.trecho,
          trechoConflito: a.trechoConflito,
        }),
      );
    } else {
      chaves.push(
        chaveAchado({ classe: 'ambiguidade', tipo: a.tipo, trecho: a.trecho, trechoConflito: null }),
      );
    }
  }

  return chaves;
}

// ---------------------------------------------------------------------------
// O estado de hoje: achados distintos por TEXTO, lidos do banco
// ---------------------------------------------------------------------------

const PAGINA = 1000;

/**
 * Paginação, com a coluna de ordem explícita.
 *
 * `id` não serve para tudo: as VIEWS não têm essa coluna, e `.order('id')`
 * numa delas devolve erro do PostgREST em vez de linhas. Ordem estável é
 * requisito da paginação — sem ela, o banco não promete que a página 2 continua
 * de onde a 1 parou.
 *
 * `pagina` menor existe para a `digest_achados_por_mercado`: cada linha carrega
 * o jsonb de achados do mercado inteiro, e 728 delas de uma vez é uma resposta
 * de megabytes contra um prazo de 8 segundos.
 */
async function paginar(
  tabela: string,
  colunas: string,
  ordem = 'id',
  pagina = PAGINA,
): Promise<Array<Record<string, unknown>>> {
  const out: Array<Record<string, unknown>> = [];
  for (let de = 0; ; de += pagina) {
    const { data, error } = await supabase
      .from(tabela)
      .select(colunas)
      .order(ordem)
      .range(de, de + pagina - 1);
    if (error !== null) throw new Error(`leitura de ${tabela} falhou: ${error.message}`);
    const linhas = (data ?? []) as unknown as Array<Record<string, unknown>>;
    out.push(...linhas);
    if (linhas.length < pagina) break;
  }
  return out;
}

/**
 * Os achados distintos que cada texto já tem.
 *
 * Lê as três tabelas da digestão inteiras — são 728 + 2.187 + 1.798 linhas, e
 * nenhuma delas é grande. Nada de `events` aqui: o `event_id` não é usado,
 * porque a unidade do nivelamento é o TEXTO e não o mercado.
 */
async function achadosPorTexto(): Promise<Map<string, Set<string>>> {
  const digests = await paginar('market_rule_digests', 'id, description_sha256');
  const shaDe = new Map<string, string>();
  for (const d of digests) shaDe.set(String(d['id']), String(d['description_sha256']));

  const porTexto = new Map<string, Set<string>>();
  const guardar = (digestId: string, chave: string): void => {
    const sha = shaDe.get(digestId);
    if (sha === undefined) return;
    if (!porTexto.has(sha)) porTexto.set(sha, new Set());
    porTexto.get(sha)?.add(chave);
  };

  for (const p of await paginar('digest_pegadinhas', 'id, digest_id, trecho')) {
    const trecho = p['trecho'];
    if (typeof trecho !== 'string' || trecho.trim() === '') continue;
    guardar(
      String(p['digest_id']),
      chaveAchado({ classe: 'pegadinha', tipo: null, trecho, trechoConflito: null }),
    );
  }

  for (const a of await paginar('digest_ambiguidades', 'id, digest_id, tipo, trecho, trecho_conflito')) {
    const trecho = a['trecho'];
    if (typeof trecho !== 'string' || trecho.trim() === '') continue;
    const tipo = a['tipo'] === null || a['tipo'] === undefined ? null : String(a['tipo']);
    const conflito = a['trecho_conflito'];

    if (tipo === 'contradicao_interna') {
      if (typeof conflito !== 'string' || conflito.trim() === '') continue;
      guardar(
        String(a['digest_id']),
        chaveAchado({ classe: 'contradicao', tipo, trecho, trechoConflito: conflito }),
      );
    } else {
      guardar(
        String(a['digest_id']),
        chaveAchado({ classe: 'ambiguidade', tipo, trecho, trechoConflito: null }),
      );
    }
  }

  return porTexto;
}

// ---------------------------------------------------------------------------
// O plano
// ---------------------------------------------------------------------------

interface Tarefa {
  market: MarketToDigest;
  sha: string;
  leituraN: number;
  /** Quantas leituras o texto tinha antes desta rodada. Vai para o relatório. */
  leiturasAntes: number;
}

interface Plano {
  tarefas: Tarefa[];
  /** Textos abaixo do mínimo cujo mercado saiu do roster — não dá para reler. */
  orfaos: Array<{ sha: string; leituras: number }>;
  textosAbaixo: number;
  textosNoAlvo: number;
}

/**
 * Uma tarefa por leitura faltante.
 *
 * A escolha do mercado, quando o texto está em vários: RODÍZIO. Um texto em 5
 * mercados que precisasse de 2 leituras poderia mandar as duas pelo mesmo
 * mercado — a regra é a mesma, o hash é o mesmo. Alternar é de graça e paga uma
 * coisa: a chamada leva `question` e `outcomes` além da `description`, então
 * duas leituras por mercados diferentes variam o prompt de um jeito que a
 * medição de consistência já sabe descontar (é a ressalva registrada em
 * `medir-consistencia.ts`). Mandar sempre pelo mesmo mercado esconderia essa
 * variação em vez de amostrá-la.
 *
 * Texto num mercado só: repete o mesmo. Leitura repetida do mesmo insumo é
 * exatamente o que se quer medir ali.
 */
function planejar(
  index: DigestedIndex,
  mercadosPorSha: Map<string, MarketToDigest[]>,
  model: string,
  promptVersion: string,
  minimo: number,
  limit: number | null,
): Plano {
  const tarefas: Tarefa[] = [];
  const orfaos: Array<{ sha: string; leituras: number }> = [];
  let textosAbaixo = 0;
  let textosNoAlvo = 0;

  // O universo é o dos textos JÁ DIGERIDOS, e não o do roster: nivelar é
  // consertar a desigualdade do que foi lido. Texto que nunca foi digerido é
  // trabalho da escada, não deste passo.
  const shas = [...index.leiturasPorTexto.keys()].sort();

  // O contador local existe porque `proximaLeitura` lê o BANCO, e o banco não
  // muda durante o planejamento. Sem ele, as duas leituras que faltam num texto
  // sairiam as duas como `leitura_n = 2` e colidiriam entre si na carga.
  const proximaLocal = new Map<string, number>();

  for (const sha of shas) {
    const leituras = index.leiturasPorTexto.get(sha) ?? 0;
    if (leituras >= minimo) {
      textosNoAlvo += 1;
      continue;
    }
    textosAbaixo += 1;

    const candidatos = mercadosPorSha.get(sha) ?? [];
    if (candidatos.length === 0) {
      // O texto foi digerido e o mercado saiu do roster (ou a descrição dele
      // mudou, e o hash de hoje é outro). Não há por onde reenviar o texto:
      // a chamada precisa de um mercado. Some da fila, mas não do relatório.
      orfaos.push({ sha, leituras });
      continue;
    }

    for (let i = 0; i < minimo - leituras; i += 1) {
      const market = candidatos[i % candidatos.length];
      if (market === undefined) continue;

      const chave = { eventId: market.eventId, descriptionSha256: sha, model, promptVersion };
      const local = `${market.eventId}|${sha}`;
      const leituraN = Math.max(proximaLeitura(index, chave), proximaLocal.get(local) ?? 1);
      proximaLocal.set(local, leituraN + 1);

      tarefas.push({ market, sha, leituraN, leiturasAntes: leituras });
    }
  }

  return {
    tarefas: limit === null ? tarefas : tarefas.slice(0, limit),
    orfaos,
    textosAbaixo,
    textosNoAlvo,
  };
}

// ---------------------------------------------------------------------------
// A corrida
// ---------------------------------------------------------------------------

interface Sucesso {
  ok: true;
  tarefa: Tarefa;
  result: DigestResult;
}

interface Falha {
  ok: false;
  tarefa: Tarefa;
  code: string;
  message: string;
}

type Saida = Sucesso | Falha;

/**
 * O laço, com teto de PARADA DURA conferido antes de DESPACHAR.
 *
 * Conferir depois de somar já gastou. Com `CONCORRENCIA` chamadas em voo o
 * excesso possível é de até `CONCORRENCIA - 1` digestões além do teto — a mesma
 * semântica de porta pré-chamada do teto do analista, e a única honesta quando
 * há paralelismo.
 *
 * Sem retry, pelo motivo de sempre: retry multiplica o prazo pelo número de
 * tentativas dentro de um laço de centenas de chamadas. Aqui custa ainda menos
 * do que na escada — uma leitura que falha deixa o texto com 2 em vez de 3, e a
 * próxima passada do nivelamento a pega, porque a contagem por texto é o que
 * monta a fila.
 */
async function correr(
  tarefas: readonly Tarefa[],
  model: string,
  promptVersion: string,
  timeoutMs: number,
  tetoUsd: number,
  onProgress: (feito: number, total: number, gasto: number) => void,
): Promise<{ saidas: Saida[]; gasto: number; barradas: number }> {
  const saidas: Saida[] = [];
  let gasto = 0;
  let barradas = 0;
  let proxima = 0;
  let feito = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const i = proxima++;
      const tarefa = tarefas[i];
      if (tarefa === undefined) return;

      if (gasto >= tetoUsd) {
        barradas += 1;
        continue;
      }

      try {
        const result = await runDigest({
          model,
          promptVersion,
          timeoutMs,
          input: tarefa.market.input,
        });
        gasto += result.costUsd ?? 0;
        saidas.push({ ok: true, tarefa, result });
      } catch (err) {
        saidas.push({
          ok: false,
          tarefa,
          code: err instanceof DigestError ? err.code : 'erro',
          message: err instanceof Error ? err.message : String(err),
        });
      }

      feito += 1;
      onProgress(feito, tarefas.length, gasto);
    }
  }

  await Promise.all(Array.from({ length: Math.min(CONCORRENCIA, tarefas.length) }, worker));
  return { saidas, gasto, barradas };
}

// ---------------------------------------------------------------------------
// O critério de sucesso
// ---------------------------------------------------------------------------

interface Veredito {
  antes: number;
  depois: number;
  ganhoPct: number | null;
  textos: number;
  ganhoPorTextoMediana: number | null;
  textosQueGanharam: number;
  frase: string;
}

function julgar(
  antesPorTexto: Map<string, Set<string>>,
  saidas: readonly Saida[],
): Veredito {
  const novasPorTexto = new Map<string, Set<string>>();
  for (const s of saidas) {
    if (!s.ok) continue;
    if (!novasPorTexto.has(s.tarefa.sha)) novasPorTexto.set(s.tarefa.sha, new Set());
    for (const c of chavesDaSaida(s.result)) novasPorTexto.get(s.tarefa.sha)?.add(c);
  }

  let antes = 0;
  let depois = 0;
  let ganharam = 0;
  const ganhos: number[] = [];

  for (const [sha, novas] of novasPorTexto) {
    const velhas = antesPorTexto.get(sha) ?? new Set<string>();
    const uniao = new Set([...velhas, ...novas]);
    antes += velhas.size;
    depois += uniao.size;
    const ganho = uniao.size - velhas.size;
    ganhos.push(ganho);
    if (ganho > 0) ganharam += 1;
  }

  // A decisão mora em `scripts/lib/veredito-nivelamento.ts`, que não toca rede
  // e por isso tem teste. Aqui ficam os conjuntos; lá fica o critério.
  const decidido = vereditoDoNivelamento(novasPorTexto.size, antes, depois);
  const ganhoPct = decidido.ganhoPct;
  const frase = decidido.frase;

  return {
    antes,
    depois,
    ganhoPct,
    textos: novasPorTexto.size,
    ganhoPorTextoMediana: mediana(ganhos),
    textosQueGanharam: ganharam,
    frase,
  };
}

// ---------------------------------------------------------------------------
// --conferir: as três invariantes, DEPOIS da carga
// ---------------------------------------------------------------------------

/**
 * As invariantes que o nivelamento não pode quebrar, conferidas contra a view.
 *
 * Sai com código 1 na primeira que falhar. "Falhar alto" é o requisito: uma
 * view que devolve número errado não quebra sozinha, e este é o único lugar
 * onde a quebra vira erro de processo.
 */
async function conferir(): Promise<number> {
  console.log(section('Conferindo digest_achados_por_mercado depois da carga'));
  const problemas: string[] = [];

  const linhas = await paginar(
    'digest_achados_por_mercado',
    'event_id, description_sha256, leituras_do_texto, achados_total, contradicoes, achados',
    'event_id',
    200,
  ).catch((err: unknown) => {
    throw new Error(
      `a view digest_achados_por_mercado não respondeu (${err instanceof Error ? err.message : String(err)}). ` +
        'A 20260817040920 foi aplicada?',
    );
  });

  // 1. leituras_do_texto tem que bater com a contagem crua da tabela.
  const digests = await paginar('market_rule_digests', 'id, description_sha256');
  const cru = new Map<string, number>();
  for (const d of digests) {
    const sha = String(d['description_sha256']);
    cru.set(sha, (cru.get(sha) ?? 0) + 1);
  }
  let divergentes = 0;
  let abaixoDoMinimo = 0;
  for (const l of linhas) {
    const sha = String(l['description_sha256']);
    const naView = Number(l['leituras_do_texto']);
    if (naView !== (cru.get(sha) ?? 0)) divergentes += 1;
    if (naView < MINIMO_PADRAO) abaixoDoMinimo += 1;
  }
  if (divergentes > 0) {
    problemas.push(`leituras_do_texto diverge da contagem crua em ${divergentes} linhas`);
  }
  console.log(
    `  leituras_do_texto x contagem crua:  ${divergentes === 0 ? 'OK' : `${divergentes} DIVERGENTES`}` +
      `  |  linhas ainda abaixo de ${MINIMO_PADRAO} leituras: ${abaixoDoMinimo}`,
  );

  // 2. vezes_encontrado nunca pode passar de leituras_do_texto. Se passar, a
  //    contagem está somando a mesma leitura duas vezes — e a coluna que existe
  //    para descontar a leitura solitária passaria a inflá-la.
  let excedentes = 0;
  for (const l of linhas) {
    const teto = Number(l['leituras_do_texto']);
    for (const a of (l['achados'] ?? []) as Array<Record<string, unknown>>) {
      if (Number(a['vezes_encontrado']) > teto) excedentes += 1;
    }
  }
  if (excedentes > 0) problemas.push(`${excedentes} achados com vezes_encontrado > leituras_do_texto`);
  console.log(`  vezes_encontrado <= leituras_do_texto:  ${excedentes === 0 ? 'OK' : `${excedentes} VIOLAÇÕES`}`);

  // 3. as contradições das duas views têm que continuar batendo.
  const contradicoesAqui = linhas.reduce((soma, l) => soma + Number(l['contradicoes']), 0);
  const defeitos = await paginar(
    'digest_contradicoes',
    'defeito_id, mercados_atingidos',
    'defeito_id',
  );
  const contradicoesLa = defeitos.reduce((soma, d) => soma + Number(d['mercados_atingidos']), 0);
  if (contradicoesAqui !== contradicoesLa) {
    problemas.push(
      `contradições não batem: ${contradicoesAqui} em digest_achados_por_mercado x ${contradicoesLa} em digest_contradicoes`,
    );
  }
  console.log(
    `  contradições nas duas views:  ${contradicoesAqui === contradicoesLa ? `OK (${contradicoesAqui})` : `${contradicoesAqui} x ${contradicoesLa} DIVERGEM`}`,
  );

  if (problemas.length > 0) {
    console.error(`\n[${LABEL}] ${problemas.length} invariante(s) quebrada(s):`);
    for (const p of problemas) console.error(`  - ${p}`);
    return 1;
  }
  console.log('\n  as três invariantes valem.');
  return 0;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  if ('error' in parsed) {
    console.error(`[${LABEL}] ${parsed.error}`);
    console.error(
      `[${LABEL}] uso: npm run nivelar -- [--dry-run] [--minimo=3] [--teto=2] [--limit=N]\n` +
        `[${LABEL}]      npm run nivelar -- --conferir`,
    );
    process.exit(1);
    return;
  }

  if (parsed.conferir) {
    process.exit(await conferir());
    return;
  }

  const config = await getSystemConfig();

  console.log(
    section(`Nivelamento de leituras — mínimo ${parsed.minimo} por texto ` +
      `(${parsed.dryRun ? 'DRY RUN, nada é chamado' : 'CORRIDA REAL'})`),
  );

  const index = await readDigested();
  if (!index.tabelaExiste) {
    console.error(`\n[${LABEL}] market_rule_digests não existe. Não há o que nivelar.`);
    process.exit(1);
    return;
  }

  const combo = escolherCombinacao(index, parsed);
  if ('error' in combo) {
    console.error(`\n[${LABEL}] ${combo.error}`);
    process.exit(1);
    return;
  }
  const { model, promptVersion } = combo;

  console.log(`  modelo: ${model}  |  prompt: ${promptVersion}  |  timeout: ${config.digest_timeout_ms} ms`);
  console.log('  a mesma versão exatamente como está — prompt, taxonomia, severidade e trava intocados.');

  // A divergência com a config é DITA, não corrigida e não escondida. Ela é
  // esperada — a config guarda o default do próximo comando, e a passada v4
  // rodou com `--prompt=v4` sem mexer nela.
  if (model !== config.digest_model || promptVersion !== config.digest_prompt_version) {
    console.log(
      `\n  NOTA: system_config diz ${config.digest_model}/${config.digest_prompt_version}, e as linhas gravadas\n` +
        `  dizem ${model}/${promptVersion}. Vale o que está nas LINHAS: nivelar é reler o que já foi lido, e\n` +
        '  reler com outro prompt mudaria duas variáveis de uma vez. A config não foi tocada.',
    );
  }

  if (!knownModel(model)) {
    console.error(`\n[${LABEL}] modelo sem preço conhecido: ${model}. Sem preço não há teto, e sem teto não roda.`);
    process.exit(1);
    return;
  }
  if (getPrompt(promptVersion) === null) {
    console.error(`\n[${LABEL}] versão de prompt desconhecida: ${promptVersion}.`);
    process.exit(1);
    return;
  }

  // O nivelamento também paga modelo, então ele também não relê regra de
  // mercado já decidido (issue #4). O descarte é contado e impresso: um texto
  // pode ficar órfão por causa dele, e a mensagem de órfãos abaixo diz isso.
  const { digeriveis: mercados, descartados } = filtrarDigeriveis(await readMarketsToDigest());
  const resumoDescarte = resumoDoDescarte(descartados);
  if (resumoDescarte !== '') console.log(`\n  ${resumoDescarte}`);

  const mercadosPorSha = new Map<string, MarketToDigest[]>();
  for (const m of mercados) {
    const sha = hashDescription(m.input.description);
    if (!mercadosPorSha.has(sha)) mercadosPorSha.set(sha, []);
    mercadosPorSha.get(sha)?.push(m);
  }

  const plano = planejar(index, mercadosPorSha, model, promptVersion, parsed.minimo, parsed.limit);

  console.log(section('O plano'));
  console.log(
    table(
      ['medida', 'valor'],
      [
        ['textos de regra distintos', String(index.leiturasPorTexto.size)],
        [`já com ${parsed.minimo}+ leituras`, String(plano.textosNoAlvo)],
        ['abaixo do mínimo', String(plano.textosAbaixo)],
        ['sem mercado no roster (órfãos)', String(plano.orfaos.length)],
        ['chamadas a fazer', String(plano.tarefas.length)],
      ],
      [0],
    ),
  );

  if (plano.orfaos.length > 0) {
    console.log(
      `\n  ${plano.orfaos.length} textos abaixo do mínimo NÃO podem ser nivelados: o mercado que os\n` +
        '  carregava saiu do roster do radar, já tem desfecho (e por isso não volta à fila),\n' +
        '  ou teve a descrição editada (e o hash de hoje é outro).\n' +
        '  A chamada precisa de um mercado; sem ele não há o que reenviar. Ficam como estão.',
    );
  }

  // ---- A conta, antes de qualquer chamada paga ----
  let estimado = 0;
  let semEstimativa = 0;
  for (const t of plano.tarefas) {
    const e = estimateOne(model, promptVersion, t.market.input);
    if (e === null) semEstimativa += 1;
    else estimado += e.usd;
  }
  estimado = Math.round(estimado * 1_000_000) / 1_000_000;

  // O teto efetivo é o MENOR entre o deste passo e o do dia. Os dois protegem
  // coisas diferentes e não faz sentido escolher: o do dia protege a fatura, o
  // do passo protege esta operação de virar uma passada completa por engano.
  const tetoEfetivo = Math.min(parsed.teto, config.digest_daily_budget_usd);

  console.log(
    table(
      ['medida', 'valor'],
      [
        ['custo estimado', usd(estimado)],
        ['teto deste passo', usd(parsed.teto)],
        ['teto do dia (config)', usd(config.digest_daily_budget_usd)],
        ['teto efetivo', usd(tetoEfetivo)],
        ['cabe no teto', estimado <= tetoEfetivo ? 'sim' : 'NÃO'],
      ],
      [0],
    ),
  );
  if (semEstimativa > 0) {
    console.log(`\n  AVISO: ${semEstimativa} chamadas sem estimativa (modelo ou prompt desconhecido).`);
  }
  console.log(
    '\n  A estimativa é a mesma de `digerir`: 4 caracteres/token na entrada e 12.000 de saída.\n' +
      '  O custo REAL medido nas 728 digestões já gravadas é de US$ 0,003602 por leitura (mediana\n' +
      '  US$ 0,003530, máximo US$ 0,008955) — é contra esse número que a divergência no fim deve ser lida.',
  );

  // ---- A trava da armadilha ----
  //
  // Sem `leitura_n` no banco, a leitura 2 colide com a 1 na unique e a carga
  // falha no meio. Gastar antes disso é comprar dado que não pode entrar.
  if (!index.colunaLeituraN) {
    const recado =
      `\n[${LABEL}] a coluna market_rule_digests.leitura_n NÃO existe.\n` +
      '  Sem ela a chave do banco continua sendo a de 4 partes, e a segunda leitura de um texto\n' +
      '  COLIDE com a primeira. O nivelamento produziria dado impossível de carregar.\n' +
      '  Aplique a 20260817163046_leitura_n_em_market_rule_digests.sql — quem aplica é o dono.';
    if (parsed.dryRun) {
      console.log(`${recado}\n  (o --dry-run segue: a conta acima não depende da coluna.)`);
    } else {
      console.error(recado);
      console.error('  Nenhuma chamada foi feita. Abortando em vez de gastar.');
      process.exit(1);
      return;
    }
  }

  if (parsed.dryRun) {
    const horas = (plano.tarefas.length / CONCORRENCIA) * 103 / 3600;
    console.log(
      `\n[${LABEL}] --dry-run: nenhuma chamada paga foi feita.\n` +
        `  Duração estimada: ~${horas.toFixed(1)} h (${plano.tarefas.length} chamadas, ${CONCORRENCIA} em paralelo,\n` +
        '  latência mediana medida de 103 s por leitura). Rodar destacado.',
    );
    return;
  }

  if (estimado > tetoEfetivo) {
    console.error(
      `\n[${LABEL}] a estimativa (${usd(estimado)}) estoura o teto efetivo (${usd(tetoEfetivo)}).\n` +
        '  Nenhuma chamada foi feita. Reduza com --limit=N ou suba --teto.',
    );
    process.exit(1);
    return;
  }

  if (plano.tarefas.length === 0) {
    console.log(`\n[${LABEL}] nada a fazer: todo texto digerido já tem ${parsed.minimo} leituras.`);
    return;
  }

  // ---- A corrida ----
  console.log(section('Rodando'));
  const inicio = Date.now();
  const corrida = await correr(
    plano.tarefas,
    model,
    promptVersion,
    config.digest_timeout_ms,
    tetoEfetivo,
    (feito, total, gasto) => {
      if (feito % 10 === 0 || feito === total) {
        console.log(`  ${feito}/${total} chamadas  |  gasto: ${usd(gasto)}  |  ${new Date().toISOString()}`);
      }
    },
  );

  const sucessos = corrida.saidas.filter((s): s is Sucesso => s.ok);
  const falhas = corrida.saidas.filter((s): s is Falha => !s.ok);

  console.log(section('Resultado'));
  console.log(
    table(
      ['medida', 'valor'],
      [
        ['chamadas feitas', String(corrida.saidas.length)],
        ['válidas', String(sucessos.length)],
        ['inválidas', String(falhas.length)],
        ['barradas pelo teto', String(corrida.barradas)],
        ['custo real', usd(corrida.gasto)],
        ['custo estimado', usd(estimado)],
        [
          'divergência',
          estimado > 0
            ? `${corrida.gasto >= estimado ? '+' : ''}${(((corrida.gasto - estimado) / estimado) * 100).toFixed(1)}%`
            : '—',
        ],
        [
          'latência mediana',
          `${mediana(sucessos.map(s => s.result.latencyMs))?.toFixed(0) ?? '—'} ms`,
        ],
        ['duração total', `${((Date.now() - inicio) / 60000).toFixed(1)} min`],
      ],
      [0],
    ),
  );

  if (falhas.length > 0) {
    const porCodigo = new Map<string, number>();
    for (const f of falhas) porCodigo.set(f.code, (porCodigo.get(f.code) ?? 0) + 1);
    console.log('\n  Inválidas, por código:');
    console.log(
      table(
        ['código', 'n'],
        [...porCodigo.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => [k, String(v)]),
        [0],
      ),
    );
    // A trava de opinião é separada de propósito: ela não é falha do modelo nem
    // da rede, é a saída sendo RECUSADA por conter opinião sobre desfecho. Um
    // pico dela é sinal sobre o prompt, e some se for somado com `api_error`.
    const opiniao = porCodigo.get('opiniao') ?? 0;
    console.log(
      `\n  trava de opinião: ${opiniao} de ${falhas.length} inválidas` +
        (opiniao > 0 ? ' — saída recusada por opinar sobre desfecho, não erro de chamada.' : ''),
    );
    console.log(`  primeira mensagem: ${falhas[0]?.message.slice(0, 160) ?? ''}`);
  }

  // ---- O critério, aplicado ao número que acabou de sair ----
  const antesPorTexto = await achadosPorTexto();
  const veredito = julgar(antesPorTexto, corrida.saidas);

  console.log(section('O critério de sucesso, declarado antes de rodar'));
  console.log(
    table(
      ['medida', 'valor'],
      [
        ['textos que ganharam leitura', String(veredito.textos)],
        ['achados distintos ANTES', String(veredito.antes)],
        ['achados distintos DEPOIS', String(veredito.depois)],
        ['ganho', veredito.ganhoPct === null ? '—' : `${veredito.ganhoPct.toFixed(1)}%`],
        ['ganho por texto (mediana)', veredito.ganhoPorTextoMediana?.toFixed(1) ?? '—'],
        ['textos que ganharam ao menos 1', String(veredito.textosQueGanharam)],
      ],
      [0],
    ),
  );
  console.log(`\n  ${veredito.frase}`);

  // ---- O artefato ----
  //
  // The fourth table is `market_rule_texts`, carrying the rule text (issue #9).
  //
  // As linhas das quatro tabelas, montadas e NÃO gravadas — escrita é do dono.
  // `leitura_n` vai em cada uma: é o que faz a carga distinguir esta leitura da
  // que já estava lá, e sem ele o artefato seria impossível de carregar.
  await mkdir(dirname(ARTEFATO), { recursive: true });
  const linhas = corrida.saidas.map(s =>
    s.ok
      ? buildDigestRows(s.tarefa.market, s.result, promptVersion, model, s.tarefa.leituraN)
      : {
          event_id: s.tarefa.market.eventId,
          description_sha256: s.tarefa.sha,
          model,
          prompt_version: promptVersion,
          leitura_n: s.tarefa.leituraN,
          falha: { code: s.code, message: s.message },
        },
  );
  await writeFile(`${ARTEFATO}.json`, JSON.stringify(linhas, null, 2), 'utf8');

  console.log(section('Onde ficou'));
  console.log(`  ${ARTEFATO}.json  — as linhas das quatro tabelas, com leitura_n, NÃO gravadas`);
  console.log('\n  Para carregar (o dono, depois de aplicar a 20260817163046):');
  console.log(`    npm run carregar-digest -- --arquivo=${ARTEFATO}.json`);
  console.log('    npm run nivelar -- --conferir');
}

main().catch((err: unknown) => {
  console.error(`[${LABEL}] falhou:`, err instanceof Error ? err.message : String(err));
  process.exit(1);
});
