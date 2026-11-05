import 'dotenv/config';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { section, table } from '../lib/probe-net.js';
import { getSystemConfig } from '../../src/lib/config.js';
import type { CompletionResult, LlmClient } from '../../src/llm/client.js';
import { clientFor } from '../../src/llm/registry.js';
import {
  DigestError,
  estimateCostUsd,
  estimateOne,
  knownModel,
  runDigest,
  type DigestResult,
} from '../../src/digest/digest.js';
import {
  buildDigestRows,
  readMarketsToDigest,
  type MarketToDigest,
} from '../../src/digest/store.js';
import { CAUSAS } from './lib/digest-nulo.js';
import { paginar, type Ambiguidade, type Pegadinha } from './lib/digestao.js';
import {
  achadosDaLeitura,
  cobertura,
  consistencia,
  estimarCusto,
  nulosPorCausa,
  porcento,
  somarPorClasse,
  sortearTextos,
  uniao,
  type Achado,
  type LeituraDeepseek,
  type PorClasse,
  type TextoAmostrado,
} from './lib/haiku-vs-deepseek.js';

/**
 * Issue #58: can claude-haiku-5-5 replace deepseek-v4-flash in the rule digest?
 *
 *   npm run medir:haiku -- --dry-run     # the sample and the cost, nothing paid
 *   npm run medir:haiku                  # 200 calls on Haiku, then the report
 *   npm run medir:haiku -- --artefato-deepseek=probes/digest/degrau-3-v4.json
 *
 * Same 100 rule texts, same prompt v4, same validation (`runDigest`). The
 * DeepSeek side is NOT called: its baseline is the August v4 readings already
 * in `market_rule_digests`. Haiku reads each text twice.
 *
 * **Nothing is written to the database.** It reads `market_rule_digests`, its
 * two child tables, `market_rule_texts`, the radar markets (the same indexed
 * read `npm run digerir` does) and `system_config`. Haiku's digests go to
 * `probes/digest/haiku-vs-deepseek.json`, already in the row shape
 * `carregar-digest` would take, and are not loaded.
 *
 * The DeepSeek null digests are not in the database, which only holds what
 * passed. They live in the run artifacts; `--artefato-deepseek` points at one.
 */

const ROTULO = 'medir:haiku';
const MODELO = 'claude-haiku-5-5';
const BASE = 'deepseek-v4-flash';
const PROMPT = 'v4';
const N_TEXTOS = 100;
const LEITURAS = 2;
/** Fixed in code, so the dry run and the run draw the same 100 texts. */
const SEMENTE = 20261105;
/** Same as `npm run digerir`: the ceiling is checked before each dispatch. */
const CONCORRENCIA = 4;
const SAIDA = 'probes/digest/haiku-vs-deepseek';

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

interface Args {
  dryRun: boolean;
  artefatoDeepseek: string | null;
}

function lerArgs(argv: readonly string[]): Args | { erro: string } {
  const args: Args = { dryRun: false, artefatoDeepseek: null };
  for (const arg of argv) {
    if (arg === '--dry-run') {
      args.dryRun = true;
      continue;
    }
    const m = /^--artefato-deepseek=(.+)$/.exec(arg);
    if (m?.[1] === undefined) return { erro: `argumento desconhecido: ${arg}` };
    args.artefatoDeepseek = m[1];
  }
  return args;
}

// ---------------------------------------------------------------------------
// Reading the baseline
// ---------------------------------------------------------------------------

interface DigestRow {
  id: string;
  event_id: string;
  description_sha256: string;
  model: string;
  prompt_version: string;
  created_at: string;
  tokens_input: number | null;
  tokens_output: number | null;
  tokens_cache_read: number | null;
  tokens_cache_write: number | null;
  cost_usd: number | string | null;
}

interface Base {
  leituras: LeituraDeepseek[];
  combinacoes: Map<string, number>;
  textos: Map<string, string>;
  mercados: Map<string, MarketToDigest>;
  pegadinhas: Map<string, Omit<Pegadinha, 'digest_id'>[]>;
  ambiguidades: Map<string, Omit<Ambiguidade, 'digest_id'>[]>;
}

function agruparPorDigest<T extends { digest_id: string }>(
  linhas: readonly T[],
): Map<string, Omit<T, 'digest_id'>[]> {
  const out = new Map<string, Omit<T, 'digest_id'>[]>();
  for (const { digest_id, ...resto } of linhas) {
    const lista = out.get(digest_id);
    if (lista === undefined) out.set(digest_id, [resto]);
    else lista.push(resto);
  }
  return out;
}

async function lerBase(): Promise<Base> {
  const [digests, textos, pegadinhas, ambiguidades, mercados] = await Promise.all([
    paginar<DigestRow>(
      'market_rule_digests',
      'id, event_id, description_sha256, model, prompt_version, created_at, ' +
        'tokens_input, tokens_output, tokens_cache_read, tokens_cache_write, cost_usd',
      ['id'],
    ),
    paginar<{ description_sha256: string; description: string }>(
      'market_rule_texts',
      'description_sha256, description',
      ['description_sha256'],
    ),
    paginar<Pegadinha>('digest_pegadinhas', 'digest_id, texto, severidade, trecho, cenario', [
      'digest_id',
      'ordinal',
    ]),
    paginar<Ambiguidade>(
      'digest_ambiguidades',
      'digest_id, tipo, trecho, trecho_conflito, leitura_a, leitura_b',
      ['digest_id', 'ordinal'],
    ),
    readMarketsToDigest(),
  ]);

  const combinacoes = new Map<string, number>();
  for (const d of digests) {
    const k = `${d.model} ${d.prompt_version}`;
    combinacoes.set(k, (combinacoes.get(k) ?? 0) + 1);
  }

  const leituras = digests
    .filter((d) => d.model === BASE && d.prompt_version === PROMPT)
    .map((d) => ({
      id: d.id,
      eventId: d.event_id,
      sha: d.description_sha256,
      criadoEm: d.created_at,
      tokensEntrada:
        (d.tokens_input ?? 0) + (d.tokens_cache_read ?? 0) + (d.tokens_cache_write ?? 0),
      tokensSaida: d.tokens_output ?? 0,
      custoUsd: d.cost_usd === null ? null : Number(d.cost_usd),
    }));

  return {
    leituras,
    combinacoes,
    textos: new Map(textos.map((t) => [t.description_sha256, t.description])),
    mercados: new Map(mercados.map((m) => [m.eventId, m])),
    pegadinhas: agruparPorDigest(pegadinhas),
    ambiguidades: agruparPorDigest(ambiguidades),
  };
}

function achadosDeepseek(base: Base, digestId: string): Achado[] {
  return achadosDaLeitura(
    digestId,
    base.pegadinhas.get(digestId) ?? [],
    base.ambiguidades.get(digestId) ?? [],
  );
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

interface Chamada {
  sha: string;
  eventId: string;
  leitura: number;
  ok: boolean;
  codigo: string | null;
  mensagem: string | null;
  /** What came back from the API, before any validation. `null` on a transport error. */
  bruto: CompletionResult | null;
  custoUsd: number | null;
  latenciaMs: number;
  linhas: ReturnType<typeof buildDigestRows> | null;
}

interface Tarefa {
  texto: TextoAmostrado;
  mercado: MarketToDigest;
  leitura: number;
}

/**
 * A client that remembers what the API returned.
 *
 * `runDigest` throws on a refusal, a truncation or a failed validation, and the
 * usage of that call goes with the exception. Those calls were billed, so
 * without this the report would price only the digests that passed. The
 * wrapper keeps the raw text and the usage of every call.
 */
function clienteQueGuarda(base: LlmClient): {
  client: LlmClient;
  ultimo: () => CompletionResult | null;
} {
  let ultimo: CompletionResult | null = null;
  return {
    client: {
      async complete(request) {
        ultimo = await base.complete(request);
        return ultimo;
      },
    },
    ultimo: () => ultimo,
  };
}

async function correr(
  tarefas: readonly Tarefa[],
  base: LlmClient,
  textos: ReadonlyMap<string, string>,
  timeoutMs: number,
  tetoUsd: number,
): Promise<{ chamadas: Chamada[]; gasto: number; barradas: number }> {
  const chamadas: Chamada[] = [];
  let gasto = 0;
  let barradas = 0;
  let proxima = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const tarefa = tarefas[proxima++];
      if (tarefa === undefined) return;
      if (gasto >= tetoUsd) {
        barradas += 1;
        continue;
      }

      const description = textos.get(tarefa.texto.sha) as string;
      const input = { ...tarefa.mercado.input, description };
      const guarda = clienteQueGuarda(base);
      const inicio = Date.now();
      let result: DigestResult | null = null;
      let codigo: string | null = null;
      let mensagem: string | null = null;

      try {
        result = await runDigest({
          model: MODELO,
          promptVersion: PROMPT,
          timeoutMs,
          input,
          client: guarda.client,
        });
      } catch (err) {
        codigo = err instanceof DigestError ? err.code : 'erro';
        mensagem = err instanceof Error ? err.message : String(err);
      }

      const bruto = guarda.ultimo();
      const custoUsd = bruto === null ? null : estimateCostUsd(MODELO, bruto.usage);
      gasto += custoUsd ?? 0;
      chamadas.push({
        sha: tarefa.texto.sha,
        eventId: tarefa.mercado.eventId,
        leitura: tarefa.leitura,
        ok: result !== null,
        codigo,
        mensagem,
        bruto,
        custoUsd,
        latenciaMs: Date.now() - inicio,
        linhas:
          result === null
            ? null
            : buildDigestRows({ ...tarefa.mercado, input }, result, PROMPT, MODELO, tarefa.leitura),
      });

      if (chamadas.length % 10 === 0 || chamadas.length === tarefas.length) {
        console.log(`  ${chamadas.length}/${tarefas.length} chamadas  |  gasto: ${usd(gasto)}`);
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(CONCORRENCIA, tarefas.length) }, worker));
  return { chamadas, gasto, barradas };
}

// ---------------------------------------------------------------------------
// Report helpers
// ---------------------------------------------------------------------------

function usd(v: number): string {
  return `US$ ${v.toFixed(v < 0.01 ? 5 : 4)}`;
}

function mediana(xs: readonly number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? ((s[m - 1] as number) + (s[m] as number)) / 2 : (s[m] as number);
}

function linhaPorClasse(nome: string, r: PorClasse): string[] {
  return [
    nome,
    `${porcento(r.total)} (${r.total.parte}/${r.total.todo})`,
    porcento(r.pegadinha),
    porcento(r.ambiguidade),
    porcento(r.contradicao),
  ];
}

const CABECALHO_CLASSE = ['medida', 'total', 'pegadinhas', 'ambiguidades', 'contradições'];

async function codigosDoArtefato(
  caminho: string,
): Promise<{ chamadas: number; codigos: string[] }> {
  const bruto = JSON.parse(await readFile(caminho, 'utf8')) as unknown[];
  const codigos: string[] = [];
  for (const entrada of bruto) {
    const falha = (entrada as { falha?: { code?: unknown } } | null)?.falha;
    if (typeof falha?.code === 'string') codigos.push(falha.code);
  }
  return { chamadas: bruto.length, codigos };
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = lerArgs(process.argv.slice(2));
  if ('erro' in args) {
    console.error(`[${ROTULO}] ${args.erro}`);
    console.error(`  uso: npm run medir:haiku -- [--dry-run] [--artefato-deepseek=CAMINHO]`);
    process.exit(1);
    return;
  }

  const cliente = clientFor(MODELO);
  if (!knownModel(MODELO) || cliente === null) {
    console.error(`[${ROTULO}] ${MODELO} sem preço ou sem fornecedor: não roda.`);
    process.exit(1);
    return;
  }

  const config = await getSystemConfig();
  const teto = config.digest_daily_budget_usd;
  const base = await lerBase();

  console.log(
    section(
      `Haiku 5.5 contra DeepSeek na digestão (${args.dryRun ? 'DRY RUN, nada é chamado' : 'CORRIDA REAL'})`,
    ),
  );
  console.log(
    table(
      ['modelo e prompt no banco', 'digestões'],
      [...base.combinacoes.entries()].sort().map(([k, v]) => [k, String(v)]),
      [0],
    ),
  );

  // ---- The sample ----
  const sorteio = sortearTextos({
    leituras: base.leituras,
    textosGuardados: base.textos,
    mercadosNoRadar: new Set(base.mercados.keys()),
    semente: SEMENTE,
    n: N_TEXTOS,
  });
  const { amostra } = sorteio;

  console.log(section('A amostra'));
  console.log(
    table(
      ['medida', 'valor'],
      [
        [`textos distintos lidos por ${BASE} ${PROMPT}`, String(sorteio.textos)],
        ['  fora: sem texto guardado', String(sorteio.fora.semTexto)],
        ['  fora: texto não bate com o hash', String(sorteio.fora.hashNaoBate)],
        ['  fora: uma leitura só', String(sorteio.fora.umaLeitura)],
        ['  fora: nenhum mercado no radar', String(sorteio.fora.foraDoRadar)],
        ['textos elegíveis', String(sorteio.elegiveis)],
        [`sorteados (semente ${SEMENTE})`, String(amostra.length)],
        [
          'par DeepSeek do mesmo mercado',
          `${amostra.filter((t) => t.parMesmoMercado).length} de ${amostra.length}`,
        ],
        [
          'leituras DeepSeek desses textos',
          String(amostra.reduce((s, t) => s + t.leiturasDeepseek, 0)),
        ],
      ],
      [0],
    ),
  );

  if (amostra.length < N_TEXTOS) {
    console.log(
      `\n  AVISO: só ${amostra.length} textos elegíveis, menos que os ${N_TEXTOS} pedidos.`,
    );
  }

  // ---- The DeepSeek baseline, free: it is already in the database ----
  const baseConsistencia = somarPorClasse(
    amostra.map((t) =>
      consistencia(achadosDeepseek(base, t.par[0]), achadosDeepseek(base, t.par[1])),
    ),
  );
  console.log(section('A base do DeepSeek nestes textos (do banco, sem chamada)'));
  console.log(
    table(
      CABECALHO_CLASSE,
      [linhaPorClasse('consistência entre as 2 leituras', baseConsistencia)],
      [0],
    ),
  );

  // ---- The bill, before anything is paid ----
  const estimativa = estimarCusto(MODELO, amostra, base.leituras, LEITURAS);
  const generica = amostra.reduce((s, t) => {
    const m = base.mercados.get(t.eventId) as MarketToDigest;
    const e = estimateOne(MODELO, PROMPT, {
      ...m.input,
      description: base.textos.get(t.sha) as string,
    });
    return s + (e?.usd ?? 0) * LEITURAS;
  }, 0);

  if (estimativa === null) {
    console.error(`[${ROTULO}] sem preço para ${MODELO}: não há como estimar.`);
    process.exit(1);
    return;
  }

  console.log(section('A conta, antes de gastar'));
  console.log(
    table(
      ['medida', 'valor'],
      [
        ['modelo', `${MODELO} (effort: padrão do modelo, medium)`],
        ['prompt', PROMPT],
        ['chamadas', `${estimativa.chamadas} (${amostra.length} textos x ${LEITURAS} leituras)`],
        ['tokens de entrada (média de agosto)', estimativa.tokensEntrada.toLocaleString('pt-BR')],
        ['tokens de saída (média de agosto)', estimativa.tokensSaida.toLocaleString('pt-BR')],
        ['custo estimado, tokens de agosto', usd(estimativa.usd)],
        ['custo estimado, régua genérica do digerir', usd(generica)],
        ['por digestão (tokens de agosto)', usd(estimativa.usd / Math.max(1, estimativa.chamadas))],
        ['teto do dia (digest_daily_budget_usd)', usd(teto)],
        ['cabe no teto', estimativa.usd <= teto && generica <= teto ? 'sim' : 'NÃO'],
      ],
      [0],
    ),
  );
  console.log(
    '\n  "tokens de agosto": a média de tokens cobrados nas leituras do DeepSeek de cada texto,\n' +
      '  no preço do Haiku 5.5 (US$ 0,10 entrada, US$ 0,50 saída por MTok), toda entrada como\n' +
      '  não cacheada. "régua genérica": 4 caracteres/token e 12.000 de saída, a do --dry-run do\n' +
      '  digerir. As duas são estimativa: o tokenizador do Claude é outro e o pensamento dele é\n' +
      '  cobrado como saída. A corrida mede o número real pelo usage.',
  );

  if (args.dryRun) {
    console.log(`\n[${ROTULO}] --dry-run: nenhuma chamada paga foi feita, nada foi gravado.`);
    return;
  }

  if (estimativa.usd > teto || generica > teto) {
    console.error(`[${ROTULO}] a estimativa estoura o teto do dia. Nenhuma chamada foi feita.`);
    process.exit(1);
    return;
  }

  // ---- The run ----
  const tarefas: Tarefa[] = amostra.flatMap((texto) =>
    Array.from({ length: LEITURAS }, (_, i) => ({
      texto,
      mercado: base.mercados.get(texto.eventId) as MarketToDigest,
      leitura: i + 1,
    })),
  );

  console.log(section('Rodando'));
  const corrida = await correr(tarefas, cliente, base.textos, config.digest_timeout_ms, teto);

  await mkdir('probes/digest', { recursive: true });
  await writeFile(`${SAIDA}.json`, JSON.stringify(corrida.chamadas, null, 2), 'utf8');

  // ---- The comparison ----
  const porTexto = new Map<string, Chamada[]>();
  for (const c of corrida.chamadas) {
    const lista = porTexto.get(c.sha);
    if (lista === undefined) porTexto.set(c.sha, [c]);
    else lista.push(c);
  }

  const achadosHaiku = (c: Chamada): Achado[] =>
    c.linhas === null
      ? []
      : achadosDaLeitura(
          `haiku:${c.sha}:${c.leitura}`,
          c.linhas.pegadinhas as Omit<Pegadinha, 'digest_id'>[],
          c.linhas.ambiguidades as Omit<Ambiguidade, 'digest_id'>[],
        );

  const consHaiku: PorClasse[] = [];
  const consBase: PorClasse[] = [];
  const haikuEmDeepseek: PorClasse[] = [];
  const deepseekEmHaiku: PorClasse[] = [];
  let textosComparados = 0;

  for (const t of amostra) {
    const validas = (porTexto.get(t.sha) ?? []).filter((c) => c.ok);
    if (validas.length < 2) continue;
    textosComparados += 1;
    const [h1, h2] = validas.map(achadosHaiku) as [Achado[], Achado[]];
    const d1 = achadosDeepseek(base, t.par[0]);
    const d2 = achadosDeepseek(base, t.par[1]);
    consHaiku.push(consistencia(h1, h2));
    consBase.push(consistencia(d1, d2));
    const h = uniao([h1, h2]);
    const d = uniao([d1, d2]);
    haikuEmDeepseek.push(cobertura(h, d));
    deepseekEmHaiku.push(cobertura(d, h));
  }

  const codigosHaiku = corrida.chamadas.filter((c) => !c.ok).map((c) => c.codigo ?? 'erro');
  const nulosHaiku = new Map(nulosPorCausa(codigosHaiku));
  const deepseekNulos =
    args.artefatoDeepseek === null ? null : await codigosDoArtefato(args.artefatoDeepseek);
  const nulosBase = deepseekNulos === null ? null : new Map(nulosPorCausa(deepseekNulos.codigos));

  const custosHaiku = corrida.chamadas.flatMap((c) => (c.custoUsd === null ? [] : [c.custoUsd]));
  const saidasHaiku = corrida.chamadas.flatMap((c) =>
    c.bruto === null ? [] : [c.bruto.usage.output],
  );
  const custosBase = amostra.flatMap((t) =>
    base.leituras
      .filter((l) => l.sha === t.sha && l.custoUsd !== null)
      .map((l) => l.custoUsd as number),
  );
  const saidasBase = amostra.flatMap((t) =>
    base.leituras.filter((l) => l.sha === t.sha).map((l) => l.tokensSaida),
  );

  const fmt = (v: number | null): string => (v === null ? '—' : usd(v));
  const n = (v: number | null): string =>
    v === null ? '—' : Math.round(v).toLocaleString('pt-BR');

  const relatorio = [
    `# Haiku 5.5 contra DeepSeek na digestão (issue #58)`,
    '',
    `- **rodou em:** ${new Date().toISOString()}`,
    `- **modelo:** \`${MODELO}\`, effort padrão (medium), prompt \`${PROMPT}\``,
    `- **base:** \`${BASE}\` \`${PROMPT}\`, leituras de agosto em \`market_rule_digests\`, sem chamada nova`,
    `- **amostra:** ${amostra.length} textos (semente ${SEMENTE}), ${LEITURAS} leituras cada`,
    `- **chamadas:** ${corrida.chamadas.length}, barradas pelo teto: ${corrida.barradas}`,
    `- **custo real:** ${usd(corrida.gasto)} (estimado: ${usd(estimativa.usd)} pelos tokens de agosto)`,
    `- **textos com as 2 leituras válidas:** ${textosComparados}`,
    `- **par DeepSeek do mesmo mercado:** ${amostra.filter((t) => t.parMesmoMercado).length} de ${amostra.length}`,
    '',
    '## Digestões nulas, por causa',
    '',
    nulosBase === null
      ? 'DeepSeek: sem artefato informado (`--artefato-deepseek`); o banco só guarda o que passou.'
      : `DeepSeek: ${deepseekNulos?.codigos.length} de ${deepseekNulos?.chamadas} chamadas em \`${args.artefatoDeepseek}\` (outra amostra, a rodada inteira).`,
    '',
    `| causa | ${MODELO} (${codigosHaiku.length} de ${corrida.chamadas.length}) | ${BASE} |`,
    '| --- | ---: | ---: |',
    ...[...nulosHaiku.keys()].map(
      (k) =>
        `| ${CAUSAS.find((c) => c.chave === k)?.titulo ?? k} | ${nulosHaiku.get(k) ?? 0} | ${nulosBase?.get(k) ?? '—'} |`,
    ),
    '',
    '## JSON válido contra o schema',
    '',
    `Saídas que não eram JSON ou não obedeceram ao contrato: ${codigosHaiku.filter((c) => ['not_json', 'schema', 'sem_resolve_sim', 'severidade_invalida', 'tipo_invalido'].includes(c)).length} de ${corrida.chamadas.length}.`,
    '',
    '## Consistência: achados que aparecem nas duas leituras',
    '',
    'Contado dos dois lados e somado por contagem. "Mesmo achado" é mesma classe e um trecho',
    'dentro do outro na borda de palavra (`contemTrecho`, a régua da tela); ambiguidade',
    'também precisa do mesmo tipo.',
    '',
    `| ${CABECALHO_CLASSE.join(' | ')} |`,
    '| --- | ---: | ---: | ---: | ---: |',
    `| ${linhaPorClasse(MODELO, somarPorClasse(consHaiku)).join(' | ')} |`,
    `| ${linhaPorClasse(`${BASE} (2 primeiras leituras)`, somarPorClasse(consBase)).join(' | ')} |`,
    '',
    '## Concordância entre os modelos',
    '',
    'União das 2 leituras de cada lado, nos mesmos textos.',
    '',
    `| ${CABECALHO_CLASSE.join(' | ')} |`,
    '| --- | ---: | ---: | ---: | ---: |',
    `| ${linhaPorClasse('achados do Haiku que o DeepSeek também achou', somarPorClasse(haikuEmDeepseek)).join(' | ')} |`,
    `| ${linhaPorClasse('achados do DeepSeek que o Haiku também achou', somarPorClasse(deepseekEmHaiku)).join(' | ')} |`,
    '',
    '## Custo por digestão',
    '',
    '| medida | ' + MODELO + ' | ' + BASE + ' |',
    '| --- | ---: | ---: |',
    `| custo mediano por chamada | ${fmt(mediana(custosHaiku))} | ${fmt(mediana(custosBase))} |`,
    `| custo médio por chamada | ${fmt(custosHaiku.length === 0 ? null : custosHaiku.reduce((a, b) => a + b, 0) / custosHaiku.length)} | ${fmt(custosBase.length === 0 ? null : custosBase.reduce((a, b) => a + b, 0) / custosBase.length)} |`,
    `| tokens de saída, mediana (pensamento incluído) | ${n(mediana(saidasHaiku))} | ${n(mediana(saidasBase))} |`,
    `| latência mediana | ${n(mediana(corrida.chamadas.map((c) => c.latenciaMs)))} ms | — |`,
    '',
    'O custo do Haiku vem do `usage` de cada chamada, inclusive das que falharam na',
    'validação: elas foram cobradas. O do DeepSeek é `cost_usd` das leituras de agosto',
    'desses mesmos textos (todas, não só o par).',
    '',
    `As saídas brutas e o \`usage\` de cada chamada estão em \`${SAIDA}.json\`.`,
    'Nada foi gravado no banco.',
    '',
  ].join('\n');

  await writeFile(`${SAIDA}.md`, relatorio, 'utf8');
  console.log(relatorio);
  console.log(section('Onde ficou'));
  console.log(`  ${SAIDA}.md    o relatório`);
  console.log(`  ${SAIDA}.json  cada chamada: saída bruta, usage, custo, linhas NÃO gravadas`);
}

main().catch((err: unknown) => {
  console.error(`[${ROTULO}] falhou:`, err instanceof Error ? err.message : String(err));
  process.exit(1);
});
