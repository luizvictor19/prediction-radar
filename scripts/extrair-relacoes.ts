import 'dotenv/config';

import { num, section, table } from './lib/probe-net.js';
import { extrairRelacoes, estimarCustoUsd, ExtratorError } from '../src/relacoes/extrator.js';
import { obterPrompt, VERSAO_PADRAO, versoesDePrompt } from '../src/relacoes/prompts.js';
import { SEMENTE_PADRAO, ordenarFila, pendentes, type RegistroDeGrupo } from '../src/relacoes/fila.js';
import type { Relacao } from '../src/relacoes/taxonomia.js';
import type { Desfecho } from '../src/relacoes/desfecho.js';

/**
 * O runner do extrator (spec 003, fase 2).
 *
 * Roda SÓ no gabarito — os grupos inteiramente resolvidos que
 * `coletar-grupos-resolvidos.ts` congelou. O universo aberto tem 133.543
 * mercados e ~US$ 733, e a Parte C reprovou isso: gastar lá antes de saber se o
 * extrator acerta é gastar na ordem errada.
 *
 * ## O que este arquivo protege
 *
 * **O desfecho não entra no prompt.** O JSON do gabarito tem duas metades por
 * mercado — `paraPrompt` e `desfecho` — e só a primeira é lida aqui. É a
 * armadilha central da fase: desfecho vazado faz o modelo deduzir a relação do
 * resultado, e a precisão medida vira ficção.
 *
 * **A fila é sorteada com semente fixa.** "Rodar 100" são os 100 PRIMEIROS de
 * uma ordem sorteada, não 100 sorteados na hora, e a rodada seguinte continua de
 * onde esta parou. Sem isso a fatia mede o pedaço que calhou de vir primeiro, e
 * não a ferramenta (Parte E).
 *
 * **O teto de gasto PARA.** Não avisa e continua, como o
 * `analyst_daily_budget_usd` do analista.
 *
 * Nenhuma escrita no banco: o resultado é JSONL em `probes/relacoes/`.
 *
 * ## Uso
 *
 *   npm run relacoes:extrair -- --dry-run
 *   npm run relacoes:extrair -- --limite=100
 *   npm run relacoes:extrair -- --limite=300     # faz só os 200 que faltam
 *   npm run relacoes:extrair                     # faz o resto
 */

const LABEL = 'extrair-relacoes';

const ENTRADA = 'probes/relacoes/grupos-resolvidos.json';
const SAIDA = 'probes/relacoes/relacoes.jsonl';

/**
 * Onde o modelo, o esforço e o teto ficam.
 *
 * No código porque nesta fase não há tabela: a migration que cria
 * `relacoes_prompt_version`, `relacoes_model` e `relacoes_budget_usd` em
 * `system_config` está escrita e NÃO aplicada (H4). Quando ela for aplicada, o
 * runner passa a ler de lá e estes viram só o padrão de arranque.
 */
const MODELO_PADRAO = 'claude-sonnet-4-6';
const ESFORCO_PADRAO = 'medium';
const TIMEOUT_MS = 120_000;

/**
 * Teto padrão, conservador de propósito: US$ 5.
 *
 * A fase 1 estimou US$ 15,26 para o gabarito inteiro, e a estimativa pode estar
 * errada — ela foi feita para um prompt que ainda não existia. Um teto abaixo do
 * estimado força a primeira rodada a parar cedo e mostrar o custo REAL por
 * chamada antes de qualquer compromisso maior. Subir é uma flag; descobrir
 * depois que gastou 4x não tem desfazer.
 */
const TETO_PADRAO_USD = 5;

/** Pausa entre chamadas, como no job do analista. */
const PAUSA_MS = 400;

// ---------------------------------------------------------------------------
// Flags
// ---------------------------------------------------------------------------

interface Args {
  limite: number | null;
  tetoUsd: number;
  semente: string;
  modelo: string;
  esforco: string;
  versaoDePrompt: string;
  dryRun: boolean;
}

function parseArgs(argv: readonly string[]): Args | { error: string } {
  const args: Args = {
    limite: null,
    tetoUsd: TETO_PADRAO_USD,
    semente: SEMENTE_PADRAO,
    modelo: MODELO_PADRAO,
    esforco: ESFORCO_PADRAO,
    versaoDePrompt: VERSAO_PADRAO,
    dryRun: false,
  };

  for (const arg of argv) {
    if (arg === '--dry-run') {
      args.dryRun = true;
      continue;
    }
    const m = /^--(limite|teto-usd|semente|modelo|esforco|prompt)=(.+)$/.exec(arg);
    if (m === null) return { error: `argumento desconhecido: ${arg}` };
    const [, chave, valor = ''] = m;

    if (chave === 'limite') {
      const n = Number(valor);
      if (!Number.isInteger(n) || n <= 0) return { error: `--limite=${valor} precisa ser inteiro > 0` };
      args.limite = n;
    } else if (chave === 'teto-usd') {
      const n = Number(valor);
      if (!Number.isFinite(n) || n <= 0) return { error: `--teto-usd=${valor} precisa ser > 0` };
      args.tetoUsd = n;
    } else if (chave === 'semente') args.semente = valor;
    else if (chave === 'modelo') args.modelo = valor;
    else if (chave === 'esforco') args.esforco = valor;
    else args.versaoDePrompt = valor;
  }

  return args;
}

// ---------------------------------------------------------------------------
// O gabarito em disco
// ---------------------------------------------------------------------------

interface MercadoDoGrupo {
  id: string;
  rotulo: string;
  paraPrompt: {
    pergunta: string;
    desfechoSim: string;
    desfechoNao: string;
    regras: string;
    fechamento: string | null;
    fonteDeResolucao: string | null;
  };
  desfecho: Desfecho;
}

interface GrupoResolvido {
  id: string;
  camada: number;
  motivo: string;
  mercados: MercadoDoGrupo[];
}

/** Uma linha do JSONL de saída. */
interface LinhaDeResultado {
  grupoId: string;
  status: 'ok' | 'falha';
  erro?: string;
  camada: number;
  membros: number;
  relacoes?: Relacao[];
  /** Telemetria por chamada, como em `esports_analyses`. */
  modelo: string;
  versaoDePrompt: string;
  esforco: string;
  tokensEntrada: number;
  tokensSaida: number;
  custoUsd: number | null;
  latenciaMs: number;
  rodadoEm: string;
}

async function lerGabarito(): Promise<GrupoResolvido[]> {
  const { readFile } = await import('node:fs/promises');
  const bruto = JSON.parse(await readFile(ENTRADA, 'utf8')) as { grupos: GrupoResolvido[] };
  return bruto.grupos;
}

async function lerResultados(): Promise<LinhaDeResultado[]> {
  const { readFile } = await import('node:fs/promises');
  try {
    const texto = await readFile(SAIDA, 'utf8');
    return texto
      .split('\n')
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as LinhaDeResultado);
  } catch {
    return [];
  }
}

/**
 * Append, uma linha por grupo, gravada ANTES da chamada seguinte.
 *
 * JSONL e não tabela porque tabela pede migration, migration pede H4, e a fase
 * ficaria bloqueada num humano para medir uma coisa que não escreve em produção.
 * Append e não reescrita porque queda no meio da rodada não pode perder o que já
 * foi pago — e é o que torna a retomada barata.
 */
async function gravar(linha: LinhaDeResultado): Promise<void> {
  const { mkdir, appendFile } = await import('node:fs/promises');
  const { dirname } = await import('node:path');
  await mkdir(dirname(SAIDA), { recursive: true });
  await appendFile(SAIDA, `${JSON.stringify(linha)}\n`, 'utf8');
}

function dormir(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// Estimativa, para o --dry-run
// ---------------------------------------------------------------------------

/** Caracteres por token. Heurística padrão para texto em inglês. */
const CHARS_POR_TOKEN = 4;

function estimarGrupo(grupo: GrupoResolvido, args: Args): { entrada: number; saida: number } {
  const construir = obterPrompt(args.versaoDePrompt);
  if (construir === null) return { entrada: 0, saida: 0 };

  // Monta o prompt DE VERDADE em vez de estimar por fórmula: o system prompt tem
  // tamanho fixo e conhecido, e contá-lo por chute foi como a fase 1 errou o
  // custo por chamada. Aqui não custa nada montar.
  const prompt = construir({
    grupoId: grupo.id,
    motivoDoGrupo: grupo.motivo,
    mercados: grupo.mercados.map((m) => ({ rotulo: m.rotulo, ...m.paraPrompt })),
  });

  const entrada = Math.ceil((prompt.system.length + prompt.user.length) / CHARS_POR_TOKEN);
  // Saída: o modelo emite só o que achar. 15% dos pares vira relação, ~55 tokens
  // cada, mais um piso de raciocínio. É a mesma hipótese da fase 1 — e o
  // relatório final compara com o medido, que é o ponto de rodar isto.
  const pares = (grupo.mercados.length * (grupo.mercados.length - 1)) / 2;
  const saida = Math.ceil(pares * 0.15 * 55) + 300;
  return { entrada, saida };
}

// ---------------------------------------------------------------------------
// Principal
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  if ('error' in parsed) {
    console.error(`[${LABEL}] ${parsed.error}`);
    process.exit(2);
  }
  const args = parsed;

  if (obterPrompt(args.versaoDePrompt) === null) {
    console.error(
      `[${LABEL}] versão de prompt desconhecida: ${args.versaoDePrompt} (registradas: ${versoesDePrompt().join(', ')})`,
    );
    process.exit(2);
  }

  const gabarito = await lerGabarito();
  const fila = ordenarFila(gabarito, args.semente);
  const jaFeitos = await lerResultados();
  const { pendentes: restantes, jaFeitos: quantosFeitos } = pendentes(
    fila,
    jaFeitos.map((r): RegistroDeGrupo => ({ grupoId: r.grupoId, status: r.status })),
  );

  const alvo = args.limite === null ? restantes : restantes.slice(0, Math.max(0, args.limite - quantosFeitos));

  const estimativas = alvo.map((g) => estimarGrupo(g, args));
  const tokensEntrada = estimativas.reduce((s, e) => s + e.entrada, 0);
  const tokensSaida = estimativas.reduce((s, e) => s + e.saida, 0);
  const custoEstimado =
    estimarCustoUsd(args.modelo, {
      input: tokensEntrada,
      output: tokensSaida,
      cacheRead: 0,
      cacheWrite: 0,
    }) ?? 0;

  const cabecalho = [
    section('EXTRATOR DE RELAÇÕES — spec 003, fase 2'),
    `  gabarito:            ${gabarito.length} grupos (${ENTRADA})`,
    `  fila:                embaralhada com semente "${args.semente}"`,
    `  já processados:      ${quantosFeitos}`,
    `  pendentes:           ${restantes.length}`,
    `  alvo desta rodada:   ${alvo.length}${args.limite === null ? '' : `  (--limite=${args.limite})`}`,
    '',
    `  modelo:              ${args.modelo}   esforço: ${args.esforco}   prompt: ${args.versaoDePrompt}`,
    `  teto de gasto:       US$ ${num(args.tetoUsd, 2)}   (parada DURA, não aviso)`,
    '',
    `  estimativa:          ${tokensEntrada.toLocaleString('pt-BR')} tok entrada + ${tokensSaida.toLocaleString('pt-BR')} tok saída`,
    `  custo estimado:      US$ ${num(custoEstimado, 2)}   (US$ ${num(alvo.length === 0 ? 0 : custoEstimado / alvo.length, 4)} por chamada)`,
    custoEstimado > args.tetoUsd
      ? `  ATENÇÃO: a estimativa PASSA do teto. A rodada vai parar no meio, por desenho.`
      : '  A estimativa cabe no teto.',
  ];

  if (args.dryRun) {
    console.log(
      [
        ...cabecalho,
        '',
        '  distribuição de tamanho do alvo:',
        table(
          ['membros', 'grupos', 'tok entrada (mediana)'],
          faixas(alvo, estimativas),
          [0],
        ),
        '',
        '  --dry-run: nenhuma chamada feita, nenhum centavo gasto.',
      ].join('\n'),
    );
    return;
  }

  // --- a rodada -------------------------------------------------------------

  console.log(cabecalho.join('\n'));
  console.error(`[${LABEL}] rodando ${alvo.length} grupos…`);

  let gasto = 0;
  let ok = 0;
  let falhas = 0;
  let paradaPorTeto = false;
  const errosPorCodigo = new Map<string, number>();
  let entradaReal = 0;
  let saidaReal = 0;
  let latenciaTotal = 0;

  for (const grupo of alvo) {
    // Parada DURA. Não há throttle nem "só mais uma": o teto atingido encerra a
    // rodada, e a próxima retoma exatamente daqui.
    if (gasto >= args.tetoUsd) {
      paradaPorTeto = true;
      break;
    }

    const rodadoEm = new Date().toISOString();
    const base = {
      grupoId: grupo.id,
      camada: grupo.camada,
      membros: grupo.mercados.length,
      modelo: args.modelo,
      versaoDePrompt: args.versaoDePrompt,
      esforco: args.esforco,
      rodadoEm,
    };

    try {
      const r = await extrairRelacoes({
        modelo: args.modelo,
        versaoDePrompt: args.versaoDePrompt,
        esforco: args.esforco,
        timeoutMs: TIMEOUT_MS,
        entrada: {
          grupoId: grupo.id,
          motivoDoGrupo: grupo.motivo,
          // A ÚNICA porta por onde o grupo entra no prompt. `m.desfecho` não é
          // lido aqui, e o teste com sentinela falha se ele passar a ser.
          mercados: grupo.mercados.map((m) => ({ rotulo: m.rotulo, ...m.paraPrompt })),
        },
      });

      gasto += r.custoUsd ?? 0;
      entradaReal += r.uso.input;
      saidaReal += r.uso.output;
      latenciaTotal += r.latenciaMs;
      ok++;

      await gravar({
        ...base,
        status: 'ok',
        relacoes: r.relacoes,
        tokensEntrada: r.uso.input,
        tokensSaida: r.uso.output,
        custoUsd: r.custoUsd,
        latenciaMs: r.latenciaMs,
      });
    } catch (err) {
      const codigo = err instanceof ExtratorError ? err.code : 'desconhecido';
      errosPorCodigo.set(codigo, (errosPorCodigo.get(codigo) ?? 0) + 1);
      falhas++;

      // A falha é GRAVADA, e por isso o grupo não volta na próxima rodada.
      // Retentar em silêncio um grupo que o modelo recusa gastaria em looping
      // sem ninguém ver; retentar é apagar a linha, com um humano no meio.
      await gravar({
        ...base,
        status: 'falha',
        erro: `${codigo}: ${err instanceof Error ? err.message : String(err)}`,
        tokensEntrada: 0,
        tokensSaida: 0,
        custoUsd: null,
        latenciaMs: 0,
      });
    }

    if ((ok + falhas) % 10 === 0) {
      console.error(`[${LABEL}] ${ok + falhas}/${alvo.length} — US$ ${gasto.toFixed(4)}`);
    }
    await dormir(PAUSA_MS);
  }

  const chamadas = ok + falhas;
  const custoPorChamada = ok === 0 ? 0 : gasto / ok;

  console.log(
    [
      section('RESULTADO DA RODADA'),
      `  chamadas:            ${chamadas}   (ok ${ok}, falha ${falhas})`,
      `  gasto REAL:          US$ ${num(gasto, 4)}`,
      `  custo por chamada:   US$ ${num(custoPorChamada, 4)}`,
      `  estimado por chamada: US$ ${num(alvo.length === 0 ? 0 : custoEstimado / alvo.length, 4)}`,
      `  divergência:         ${alvo.length === 0 || custoEstimado === 0 ? '—' : `${(((custoPorChamada * alvo.length) / custoEstimado - 1) * 100).toFixed(0)}%`}`,
      '',
      `  tokens entrada:      ${entradaReal.toLocaleString('pt-BR')}   (estimado ${tokensEntrada.toLocaleString('pt-BR')})`,
      `  tokens saída:        ${saidaReal.toLocaleString('pt-BR')}   (estimado ${tokensSaida.toLocaleString('pt-BR')})`,
      `  latência mediana:    ${ok === 0 ? '—' : `${Math.round(latenciaTotal / ok)} ms`}`,
      '',
      paradaPorTeto
        ? `  PAROU NO TETO de US$ ${num(args.tetoUsd, 2)}. A próxima rodada retoma daqui.`
        : '  A rodada terminou o alvo.',
      falhas > 0
        ? `\n  falhas por código:\n${[...errosPorCodigo.entries()].map(([c, n]) => `    ${c.padEnd(24)} ${n}`).join('\n')}`
        : '',
      '',
      `  gravado em ${SAIDA}. Medir com: npm run relacoes:medir`,
    ].join('\n'),
  );
}

function faixas(
  grupos: readonly GrupoResolvido[],
  estimativas: ReadonlyArray<{ entrada: number }>,
): string[][] {
  const buckets: Array<[string, (n: number) => boolean]> = [
    ['2-4', (n) => n <= 4],
    ['5-8', (n) => n >= 5 && n <= 8],
    ['9-12', (n) => n >= 9 && n <= 12],
    ['13-20', (n) => n >= 13 && n <= 20],
    ['21-40', (n) => n >= 21 && n <= 40],
    ['41+', (n) => n >= 41],
  ];

  return buckets
    .map(([rotulo, teste]) => {
      const indices = grupos
        .map((g, i) => (teste(g.mercados.length) ? i : -1))
        .filter((i) => i >= 0);
      if (indices.length === 0) return null;
      const toks = indices.map((i) => estimativas[i]?.entrada ?? 0).sort((a, b) => a - b);
      return [
        rotulo,
        String(indices.length),
        String(toks[Math.floor(toks.length / 2)] ?? 0),
      ];
    })
    .filter((r): r is string[] => r !== null);
}

main().catch((err: unknown) => {
  console.error(`[${LABEL}] falhou:`, err instanceof Error ? err.message : String(err));
  process.exit(1);
});
