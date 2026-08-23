import 'dotenv/config';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { section, table } from './lib/probe-net.js';
import { getSystemConfig } from '../src/lib/config.js';
import { listDeepseekModels } from '../src/llm/deepseek.js';
import { providerFor } from '../src/llm/registry.js';
import {
  DigestError,
  descartesVazios,
  estimateOne,
  hashDescription,
  knownModel,
  pricedModels,
  runDigest,
  type Descartes,
  type DigestResult,
} from '../src/digest/digest.js';
import {
  buildDigestRows,
  jaDigerido,
  readDigested,
  readMarketsToDigest,
  type MarketToDigest,
} from '../src/digest/store.js';
import {
  getPrompt,
  promptVersions,
  SEVERIDADES,
  tiposDe,
} from '../src/digest/prompts.js';
import type { Ambiguidade, DigestOutput, Pegadinha } from '../src/digest/digest.js';

/**
 * A escada de adoção da digestão de regras.
 *
 * Três degraus, e o dono aprova entre eles:
 *
 *   1. 10 mercados, só `deepseek-v4-flash`
 *   2. 50 mercados, Flash e Claude lado a lado
 *   3. o resto, no vencedor
 *
 * Existe porque rodar os 673 de uma vez é a forma cara de descobrir que o prompt
 * estava errado. O custo de cada degrau é uma fração do anterior estar certo.
 *
 * **Este script NÃO grava no banco.** A migration existe e não foi aplicada; a
 * saída de cada degrau vai para markdown e JSON em `probes/digest/`. Quando a
 * tabela existir, o payload já está montado e conferido (`buildDigestRow`).
 *
 *   npm run digerir -- --dry-run
 *   npm run digerir -- --dry-run --degrau=2
 *   npm run digerir -- --degrau=1
 *   npm run digerir -- --degrau=3 --model=deepseek-v4-flash
 *
 * `--dry-run` é o default seguro em espírito, mas não em código: rodar sem ele é
 * gastar. O que protege o gasto é o TETO — a estimativa do `--dry-run` é
 * recalculada antes de qualquer chamada e a corrida recusa começar se ela não
 * couber em `digest_daily_budget_usd`.
 */

const LABEL = 'digerir-regras';
const OUT_DIR = 'probes/digest';

/**
 * Onde os artefatos de um degrau ficam.
 *
 * A v1 não leva sufixo — os arquivos dela já existem e já foram lidos, e mudar
 * o caminho de um artefato que alguém tem aberto é o tipo de conveniência que
 * custa mais do que economiza.
 *
 * A AMOSTRA entra no nome quando ela é ancorada, e isso é conserto de um
 * defeito real: o caminho era só (degrau, versão), então rodar a mesma versão de
 * prompt sobre duas amostras diferentes sobrescrevia a primeira em silêncio. É
 * exatamente o que a v4 precisou fazer — a amostra da v1 e a da v3 são
 * disjuntas (a v3 rodou com `--excluir-de=v1`), e os casos que motivaram a v4
 * estão todos na segunda. Sem o sufixo, conferir o critério de passagem
 * apagaria a rodada que já tinha passado.
 */
function caminhoBase(degrau: number, promptVersion: string, amostraDe: string | null): string {
  const sufixoAmostra = amostraDe === null ? '' : `-amostra-${amostraDe}`;
  return promptVersion === 'v1'
    ? join(OUT_DIR, `degrau-${degrau}${sufixoAmostra}`)
    : join(OUT_DIR, `degrau-${degrau}-${promptVersion}${sufixoAmostra}`);
}

/**
 * A semente da amostra.
 *
 * Fixa e no código, não no relógio: a amostra tem que ser a MESMA entre o
 * `--dry-run` e a corrida, e entre o degrau 1 e o degrau 2 — os 10 do degrau 1
 * são os 10 primeiros dos 50 do degrau 2, o que dá dois modelos sobre os mesmos
 * mercados que já foram lidos à mão. Semente do relógio quebraria as duas coisas
 * e ninguém notaria.
 */
const SEMENTE_PADRAO = 20260815;

/**
 * Chamadas simultâneas.
 *
 * 4 e não 1 porque 673 chamadas em série a ~15s cada são quase três horas; 4 e
 * não 20 porque o teto de gasto é conferido ANTES de despachar cada chamada, e
 * com N simultâneas o estouro possível é de até N-1 chamadas além do teto. Com
 * 4 e uma digestão custando frações de centavo, o excesso máximo é ruído; com 20
 * ainda seria, mas a chance de tomar 429 do fornecedor deixa de ser.
 */
const CONCORRENCIA = 4;

// ---------------------------------------------------------------------------
// Argumentos
// ---------------------------------------------------------------------------

interface Args {
  dryRun: boolean;
  degrau: 1 | 2 | 3;
  model: string | null;
  prompt: string | null;
  /** `[antiga, nova]` quando o modo é comparar duas versões já rodadas. */
  comparar: [string, string] | null;
  /**
   * Repetir EXATAMENTE os mercados de uma rodada anterior, pelo id.
   *
   * A semente fixa garante a mesma amostra sobre a MESMA população — e a
   * população cresce. Entre a rodada da v1 e a da v2 o roster do radar foi de
   * 744 para 752 mercados, e um Fisher-Yates sobre 752 não devolve os mesmos
   * dez primeiros que sobre 744. A semente sozinha não é reprodutibilidade
   * quando o conjunto de entrada se move debaixo dela.
   */
  amostraDe: string | null;
  /**
   * Versões cujos mercados NÃO podem entrar nesta amostra.
   *
   * Existe porque a régua do prompt cita casos reais, e casos reais vêm de
   * mercados que já foram digeridos. Na v2 os exemplos de PASSA e NÃO PASSA
   * saíram de 7 dos 10 mercados da própria amostra — o modelo leu as respostas
   * antes de responder, e aquela comparação valeu menos do que parecia. A
   * não-sobreposição vira garantia de código aqui, não conferência no olho.
   */
  excluirDe: string[];
  seed: number;
  limit: number | null;
}

function parseArgs(argv: readonly string[]): Args | { error: string } {
  const args: Args = {
    dryRun: false,
    degrau: 1,
    model: null,
    prompt: null,
    comparar: null,
    amostraDe: null,
    excluirDe: [],
    seed: SEMENTE_PADRAO,
    limit: null,
  };

  for (const arg of argv) {
    if (arg === '--dry-run') {
      args.dryRun = true;
      continue;
    }

    const match = /^--(degrau|model|prompt|comparar|amostra-de|excluir-de|seed|limit)=(.+)$/.exec(arg);
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
    if (key === 'amostra-de') {
      args.amostraDe = value;
      continue;
    }
    if (key === 'excluir-de') {
      args.excluirDe = value.split(',').map(v => v.trim()).filter(v => v !== '');
      continue;
    }
    if (key === 'comparar') {
      const partes = value.split(',').map(p => p.trim());
      const [a, b] = partes;
      if (partes.length !== 2 || a === undefined || b === undefined || a === '' || b === '') {
        return { error: '--comparar espera duas versões separadas por vírgula, ex: --comparar=v1,v2' };
      }
      args.comparar = [a, b];
      continue;
    }
    if (key === 'degrau') {
      if (value !== '1' && value !== '2' && value !== '3') {
        return { error: '--degrau só aceita 1, 2 ou 3' };
      }
      args.degrau = Number(value) as 1 | 2 | 3;
      continue;
    }

    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return { error: `--${key}=${value} não é um número positivo` };
    if (key === 'seed') args.seed = Math.trunc(n);
    else args.limit = Math.trunc(n);
  }

  return args;
}

// ---------------------------------------------------------------------------
// A amostra: aleatória, com semente fixa, reprodutível
// ---------------------------------------------------------------------------

/**
 * PRNG determinístico (mulberry32).
 *
 * `Math.random()` não serve: a amostra precisa ser a mesma na estimativa e na
 * corrida, e reproduzível daqui a um mês para conferir o que foi medido. Escolha
 * a dedo também não serve, e é o erro mais fácil de cometer sem perceber —
 * escolher os mercados "bons" mede o prompt no melhor caso e depois surpreende
 * no resto.
 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function embaralhar<T>(items: readonly T[], seed: number): T[] {
  const out = [...items];
  const rand = mulberry32(seed);
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const a = out[i];
    const b = out[j];
    if (a !== undefined && b !== undefined) {
      out[i] = b;
      out[j] = a;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Os degraus
// ---------------------------------------------------------------------------

interface Degrau {
  numero: 1 | 2 | 3;
  descricao: string;
  models: string[];
  /** Onde a fatia começa e termina, na lista já embaralhada. */
  inicio: number;
  fim: number | null;
}

function montarDegrau(args: Args, config: { digest_model: string }): Degrau {
  const escolhido = args.model ?? config.digest_model;

  switch (args.degrau) {
    case 1:
      return {
        numero: 1,
        descricao: '10 mercados, um modelo só — a leitura antes de qualquer escala',
        models: [args.model ?? 'deepseek-v4-flash'],
        inicio: 0,
        fim: args.limit ?? 10,
      };
    case 2:
      return {
        numero: 2,
        descricao: '50 mercados, dois modelos lado a lado — a comparação',
        // Os 10 do degrau 1 estão dentro destes 50, de propósito: são os que já
        // foram lidos à mão, e ver o segundo modelo sobre eles é a comparação
        // mais barata que existe.
        models: args.model !== null ? [args.model] : ['deepseek-v4-flash', 'claude-sonnet-5'],
        inicio: 0,
        fim: args.limit ?? 50,
      };
    case 3:
      return {
        numero: 3,
        // `inicio: 0`, e não 50. O 50 vinha de "os degraus 1 e 2 já rodaram,
        // pule o que eles fizeram" — uma dedup por OFFSET, que só está certa
        // enquanto os dois degraus anteriores tiverem rodado com este mesmo
        // modelo e esta mesma versão de prompt.
        //
        // A dedup de verdade já existe e é por CHAVE: (evento, hash do texto,
        // modelo, versão), em `jaDigerido`. Ela sabe o que o offset só supunha,
        // e sabe também o que o offset nunca soube — que a v4 não digeriu os
        // primeiros 50 só porque a v1 digeriu.
        //
        // Com a tabela ainda não aplicada, o offset 50 produziria 702 mercados
        // num relatório que diz cobrir o universo. Passar por 752 e deixar a
        // chave decidir custa uma comparação por mercado e não custa nada.
        descricao: 'o universo inteiro, no modelo escolhido (a dedup é por chave, não por offset)',
        models: [escolhido],
        inicio: 0,
        fim: args.limit,
      };
  }
}

// ---------------------------------------------------------------------------
// Execução
// ---------------------------------------------------------------------------

interface Tarefa {
  market: MarketToDigest;
  model: string;
}

interface Sucesso {
  ok: true;
  market: MarketToDigest;
  model: string;
  result: DigestResult;
}

interface Falha {
  ok: false;
  market: MarketToDigest;
  model: string;
  code: string;
  message: string;
}

type Saida = Sucesso | Falha;

interface Corrida {
  saidas: Saida[];
  gasto: number;
  /** Tarefas que nem chegaram a ser despachadas por causa do teto. */
  barradasPeloTeto: number;
}

/**
 * O laço, com teto de PARADA DURA.
 *
 * O teto é conferido antes de DESPACHAR cada chamada, não depois de somar: uma
 * conferência a posteriori já gastou. Com `CONCORRENCIA` chamadas em voo, o
 * excesso máximo é de até `CONCORRENCIA - 1` digestões além do teto — a mesma
 * semântica de porta pré-chamada do teto do analista, e a única honesta quando
 * há paralelismo.
 */
async function correr(
  tarefas: readonly Tarefa[],
  promptVersion: string,
  timeoutMs: number,
  tetoUsd: number,
  onProgress: (feito: number, total: number, gasto: number) => void,
): Promise<Corrida> {
  const saidas: Saida[] = [];
  let gasto = 0;
  let barradasPeloTeto = 0;
  let proxima = 0;
  let feito = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const i = proxima++;
      const tarefa = tarefas[i];
      if (tarefa === undefined) return;

      if (gasto >= tetoUsd) {
        barradasPeloTeto += 1;
        continue;
      }

      try {
        const result = await runDigest({
          model: tarefa.model,
          promptVersion,
          timeoutMs,
          input: tarefa.market.input,
        });
        gasto += result.costUsd ?? 0;
        saidas.push({ ok: true, market: tarefa.market, model: tarefa.model, result });
      } catch (err) {
        // Falha de chamada TAMBÉM gastou, quando o modelo chegou a gerar. Não dá
        // para saber quanto sem a resposta, e por isso a falha não entra no
        // `gasto` — o que ela faz é aparecer no relatório, para a divergência
        // entre o estimado e a fatura não ficar sem explicação.
        saidas.push({
          ok: false,
          market: tarefa.market,
          model: tarefa.model,
          code: err instanceof DigestError ? err.code : 'erro',
          message: err instanceof Error ? err.message : String(err),
        });
      }

      feito += 1;
      onProgress(feito, tarefas.length, gasto);
    }
  }

  await Promise.all(Array.from({ length: Math.min(CONCORRENCIA, tarefas.length) }, worker));
  return { saidas, gasto, barradasPeloTeto };
}

// ---------------------------------------------------------------------------
// Relatório
// ---------------------------------------------------------------------------

function usd(v: number): string {
  return `US$ ${v.toFixed(v < 0.01 ? 5 : 4)}`;
}

function mediana(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const meio = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[meio] ?? null;
  const a = sorted[meio - 1] ?? 0;
  const b = sorted[meio] ?? 0;
  return (a + b) / 2;
}

function lista(titulo: string, items: readonly string[]): string {
  if (items.length === 0) return `**${titulo}:** —\n`;
  return `**${titulo}:**\n\n${items.map(i => `- ${i}`).join('\n')}\n`;
}

/**
 * A severidade em destaque, e vazio dito em voz alta.
 *
 * "nenhuma" não é a mesma coisa que um travessão silencioso: lista vazia é
 * resposta desejada quando a regra é simples, e quem lê o relatório precisa
 * distinguir "o modelo não achou pegadinha" de "o campo sumiu".
 */
function listaPegadinhas(items: readonly Pegadinha[]): string {
  if (items.length === 0) return '**Pegadinhas:** nenhuma (a regra é direta)\n';

  const linhas = items.map(p => {
    const cabeca = p.severidade === null ? `- ${p.texto}` : `- \`${p.severidade}\` — ${p.texto}`;
    const detalhes = [
      p.trecho === null ? null : `  - trecho: *"${p.trecho}"*`,
      p.cenario === null ? null : `  - cenário: ${p.cenario}`,
    ].filter((l): l is string => l !== null);
    return [cabeca, ...detalhes].join('\n');
  });

  return `**Pegadinhas (${items.length}):**\n\n${linhas.join('\n')}\n`;
}

function listaAmbiguidades(items: readonly Ambiguidade[]): string {
  if (items.length === 0) return '**Ambiguidades:** nenhuma\n';

  const linhas = items.map(a => {
    if (a.tipo === null) return `- ${a.leituraA}`;
    return [
      `- \`${a.tipo}\` — trecho: *"${a.trecho ?? '—'}"*`,
      // A segunda passagem só existe em `contradicao_interna`, e ali ela é
      // metade do achado: a contradição não está em nenhum dos dois trechos, e
      // sim entre eles.
      a.trechoConflito === null ? null : `  - **em conflito com:** *"${a.trechoConflito}"*`,
      `  - **leitura A:** ${a.leituraA}`,
      `  - **leitura B:** ${a.leituraB ?? '—'}`,
    ]
      .filter((l): l is string => l !== null)
      .join('\n');
  });

  return `**Ambiguidades (${items.length}):**\n\n${linhas.join('\n')}\n`;
}

function renderOutput(o: DigestOutput, rodape: string): string {
  return [
    lista('Resolve SIM', o.resolveSim),
    lista('Resolve NÃO', o.resolveNao),
    `**Fonte:** ${o.fonte ?? '— (a regra não nomeia)'}\n`,
    `**Prazo:** ${o.prazo ?? '— (a regra não dá)'}\n`,
    lista('Anula se', o.anulaSe),
    listaPegadinhas(o.pegadinhas),
    listaAmbiguidades(o.ambiguidades),
    rodape,
  ].join('\n');
}

function renderDigest(saida: Saida): string {
  if (!saida.ok) {
    return `> **FALHOU** (\`${saida.code}\`): ${saida.message}\n`;
  }

  return renderOutput(
    saida.result.output,
    `<sub>${saida.model} · ${saida.result.usage.input}+${saida.result.usage.output} tok · ` +
      `${usd(saida.result.costUsd ?? 0)} · ${saida.result.latencyMs} ms</sub>\n`,
  );
}

// ---------------------------------------------------------------------------
// As distribuições — o que a v2 existe para tornar contável
// ---------------------------------------------------------------------------

/**
 * A partir daqui, a lista fechada de tipos está incompleta e precisa crescer.
 *
 * A comparação é `>=` e não `>`, e a diferença apareceu na primeira rodada em
 * que a taxa bateu exatos 20,0%: com `>`, o relatório imprimia "abaixo de 20% —
 * a lista dá conta" no ponto exato do limiar. Um aviso que se cala no limiar é
 * pior que não ter aviso, porque ele afirma o contrário do que se queria saber.
 */
const TETO_OUTRO = 0.2;

/**
 * Abaixo de quantas digestões um percentual é ruído com cara de medida.
 *
 * Não é regra de bolso: é medição. A v3 rodou TRÊS VEZES com prompt idêntico
 * sobre os mesmos 10 mercados, e a taxa de `outro` deu 20,0%, 6,7% e 30,4%. A
 * variância entre rodadas iguais é maior que qualquer efeito que se queira medir
 * entre uma versão de prompt e outra — todo número de comparação produzido em
 * n=10 até aqui foi flutuação tratada como sinal.
 *
 * O que n=10 responde: roda sem quebrar, o JSON valida, o trecho bate no texto,
 * nada truncou. O que ele não responde: "ficou melhor". Esse aviso existe para o
 * relatório dizer isso sozinho, em vez de depender de quem lê lembrar.
 */
const N_MINIMO_PARA_COMPARAR = 100;

function avisoDeAmostra(mercadosValidos: number): string[] {
  if (mercadosValidos >= N_MINIMO_PARA_COMPARAR) return [];
  return [
    `> **n = ${mercadosValidos}: isto é smoke test, não comparação.** Os percentuais acima`,
    '> não sustentam "ficou melhor que a versão anterior" — a v3 rodou três vezes com',
    '> prompt idêntico nos mesmos 10 mercados e deu 20,0%, 6,7% e 30,4% de `outro`. A',
    `> variância entre rodadas iguais engole o efeito. Comparação de qualidade só em`,
    `> n ≥ ${N_MINIMO_PARA_COMPARAR}. O que este relatório responde é: rodou, validou, o trecho bate, nada truncou.`,
    '',
  ];
}

interface Distribuicoes {
  porSeveridade: Map<string, number>;
  porTipo: Map<string, number>;
  totalPegadinhas: number;
  totalAmbiguidades: number;
  mercadosComZeroPegadinhas: number;
  mercadosValidos: number;
  taxaOutro: number | null;
}

/**
 * A soma dos descartes da rodada. É a medida DIRETA do enchimento.
 *
 * Cada número responde uma coisa: quantas pegadinhas eram impressão sem
 * passagem da regra que as sustente, quantas eram a mesma observação dita duas
 * vezes, e quantas severidades fortes não tinham cenário para sustentá-las.
 */
function somarDescartes(saidas: readonly Saida[]): Descartes {
  const total = descartesVazios();
  for (const s of saidas) {
    if (!s.ok) continue;
    total.trechoInexistente += s.result.descartes.trechoInexistente;
    total.trechoRepetido += s.result.descartes.trechoRepetido;
    total.trechoCurto += s.result.descartes.trechoCurto;
    total.severidadeRebaixada += s.result.descartes.severidadeRebaixada;
    total.amostras.push(...s.result.descartes.amostras);
    total.contradicaoSemSegundoTrecho += s.result.descartes.contradicaoSemSegundoTrecho;
    total.contradicaoNaoAncorada += s.result.descartes.contradicaoNaoAncorada;
    total.amostrasAmbiguidade.push(...s.result.descartes.amostrasAmbiguidade);
  }
  return total;
}

/**
 * As contradições internas, separadas de tudo.
 *
 * Regra que se contradiz é a FORMA da disputa: não é mercado difícil de prever,
 * é mercado onde quem resolve vai ter que legislar — e isso se enxerga hoje, no
 * texto, sem esperar o evento. É o achado que vale dinheiro, e ele não pode sair
 * como mais uma linha de uma tabela de doze categorias.
 */
interface Contradicao {
  mercado: string;
  slug: string | null;
  polymarketId: string;
  tema: string | null;
  liquidez: number | null;
  url: string;
  trecho: string;
  trechoConflito: string;
  leituraA: string;
  leituraB: string;
}

/**
 * A URL do mercado na Polymarket.
 *
 * Pelo slug quando ele existe, porque é o que abre a página. Sem slug sobra o
 * id da plataforma, que não abre nada — e é por isso que ele sai marcado como
 * id e não como link: um link quebrado num relatório de 752 custa mais que a
 * ausência declarada.
 */
function urlPolymarket(slug: string | null, polymarketId: string): string {
  return slug === null ? `(sem slug — id ${polymarketId})` : `https://polymarket.com/event/${slug}`;
}

/**
 * Ordem: liquidez decrescente, e os sem liquidez conhecida NO FIM.
 *
 * `null` não vira 0. "Não sei a liquidez" e "liquidez zero" são coisas
 * diferentes, e tratar a primeira como a segunda enterraria no rodapé um
 * mercado grande cujo campo faltou na coleta — que é exatamente o mercado que
 * esta seção existe para mostrar primeiro.
 */
function ordenarPorLiquidez(items: readonly Contradicao[]): Contradicao[] {
  return [...items].sort((a, b) => {
    if (a.liquidez === null && b.liquidez === null) return 0;
    if (a.liquidez === null) return 1;
    if (b.liquidez === null) return -1;
    return b.liquidez - a.liquidez;
  });
}

/**
 * A seção que abre o relatório. Some quando não há contradição — e some inteira,
 * de propósito: um cabeçalho "Contradições internas: nenhuma" no topo de toda
 * rodada treina quem lê a pular o bloco, que é o oposto de destacar.
 */
function secaoContradicoes(items: readonly Contradicao[]): string[] {
  if (items.length === 0) return [];

  return [
    `## ⚠️ Contradições internas — ${items.length}`,
    '',
    'A regra afirma duas coisas incompatíveis. Nenhuma das duas leituras está',
    'errada, porque o texto sustenta as duas — quem resolve vai ter que escolher,',
    'e a escolha não está escrita. É o formato do caso de US$ 60 milhões.',
    '',
    '**Ordenado por liquidez, do maior para o menor.** Mercado sem liquidez',
    'conhecida vai para o fim da lista, e não para o meio como se fosse zero.',
    '',
    // O índice primeiro, para a lista ser varrível de cima sem rolar as duas
    // passagens de cada item. Numa passada de 752 esta seção pode ter dezenas
    // de entradas, e aí a tabela é o que se lê e o detalhe é o que se consulta.
    '| # | mercado | categoria | liquidez | link |',
    '| ---: | --- | --- | ---: | --- |',
    ...items.map(
      (c, i) =>
        `| ${i + 1} | ${c.slug ?? c.polymarketId} | ${c.tema ?? '—'} | ` +
        `${c.liquidez === null ? '—' : usd(c.liquidez)} | ` +
        `${c.slug === null ? c.url : `[abrir](${c.url})`} |`,
    ),
    '',
    ...items.flatMap((c, i) => [
      `### ${i + 1}. ${c.mercado}`,
      '',
      `<sub>\`${c.slug ?? c.polymarketId}\`` +
        (c.tema === null ? '' : ` · ${c.tema}`) +
        ` · liquidez ${c.liquidez === null ? '— (não coletada)' : usd(c.liquidez)}` +
        ` · ${c.url}</sub>`,
      '',
      `> ${c.trecho}`,
      '',
      'contra',
      '',
      `> ${c.trechoConflito}`,
      '',
      `- **leitura A:** ${c.leituraA}`,
      `- **leitura B:** ${c.leituraB}`,
      '',
    ]),
  ];
}

function colherContradicoes(saidas: readonly Saida[]): Contradicao[] {
  const out: Contradicao[] = [];
  for (const s of saidas) {
    if (!s.ok) continue;
    for (const a of s.result.output.ambiguidades) {
      if (a.tipo !== 'contradicao_interna') continue;
      out.push({
        mercado: s.market.input.question,
        slug: s.market.input.slug,
        polymarketId: s.market.polymarketId,
        tema: s.market.tema,
        liquidez: s.market.liquidez,
        url: urlPolymarket(s.market.input.slug, s.market.polymarketId),
        trecho: a.trecho ?? '—',
        trechoConflito: a.trechoConflito ?? '—',
        leituraA: a.leituraA,
        leituraB: a.leituraB ?? '—',
      });
    }
  }
  return ordenarPorLiquidez(out);
}

function distribuir(outputs: readonly DigestOutput[]): Distribuicoes {
  const porSeveridade = new Map<string, number>();
  const porTipo = new Map<string, number>();
  let totalPegadinhas = 0;
  let totalAmbiguidades = 0;
  let zeros = 0;

  for (const o of outputs) {
    if (o.pegadinhas.length === 0) zeros += 1;
    for (const p of o.pegadinhas) {
      totalPegadinhas += 1;
      const chave = p.severidade ?? '(sem severidade — v1)';
      porSeveridade.set(chave, (porSeveridade.get(chave) ?? 0) + 1);
    }
    for (const a of o.ambiguidades) {
      totalAmbiguidades += 1;
      const chave = a.tipo ?? '(sem tipo — v1)';
      porTipo.set(chave, (porTipo.get(chave) ?? 0) + 1);
    }
  }

  const outro = porTipo.get('outro') ?? 0;
  return {
    porSeveridade,
    porTipo,
    totalPegadinhas,
    totalAmbiguidades,
    mercadosComZeroPegadinhas: zeros,
    mercadosValidos: outputs.length,
    taxaOutro: totalAmbiguidades > 0 ? outro / totalAmbiguidades : null,
  };
}

/**
 * A ordem é a da lista fechada, não a da contagem.
 *
 * Categoria com zero aparece, e é de propósito: um tipo que nunca sai é
 * informação sobre a lista (ou sobre o prompt), e uma tabela que só mostra o que
 * apareceu esconde exatamente isso.
 */
function markdownDistribuicao(
  titulo: string,
  contagem: Map<string, number>,
  chaves: readonly string[],
  total: number,
): string {
  const extras = [...contagem.keys()].filter(k => !chaves.includes(k)).sort();
  const linhas = [...chaves, ...extras]
    .map(k => {
      const n = contagem.get(k) ?? 0;
      return `| \`${k}\` | ${n} | ${total > 0 ? ((n / total) * 100).toFixed(1) + '%' : '—'} |`;
    })
    .join('\n');
  return `| ${titulo} | n | % |\n| --- | ---: | ---: |\n${linhas}`;
}

function tabelaDistribuicao(
  titulo: string,
  contagem: Map<string, number>,
  chaves: readonly string[],
  total: number,
): string {
  const extras = [...contagem.keys()].filter(k => !chaves.includes(k)).sort();
  const linhas = [...chaves, ...extras].map(k => {
    const n = contagem.get(k) ?? 0;
    return [k, String(n), total > 0 ? `${((n / total) * 100).toFixed(1)}%` : '—'];
  });
  return `${titulo}\n` + table(['categoria', 'n', '%'], linhas, [0]);
}

interface MetricaModelo {
  model: string;
  chamadas: number;
  validas: number;
  invalidas: number;
  custoTotal: number;
  latenciaMediana: number | null;
  pegadinhasMediana: number | null;
  ambiguidadesMediana: number | null;
}

function metricas(saidas: readonly Saida[], model: string): MetricaModelo {
  const doModelo = saidas.filter(s => s.model === model);
  const ok = doModelo.filter((s): s is Sucesso => s.ok);

  return {
    model,
    chamadas: doModelo.length,
    validas: ok.length,
    invalidas: doModelo.length - ok.length,
    custoTotal: ok.reduce((acc, s) => acc + (s.result.costUsd ?? 0), 0),
    latenciaMediana: mediana(ok.map(s => s.result.latencyMs)),
    pegadinhasMediana: mediana(ok.map(s => s.result.output.pegadinhas.length)),
    ambiguidadesMediana: mediana(ok.map(s => s.result.output.ambiguidades.length)),
  };
}

function tabelaMetricas(saidas: readonly Saida[], models: readonly string[]): string {
  const linhas = models.map(m => {
    const x = metricas(saidas, m);
    const porMercado = x.validas > 0 ? x.custoTotal / x.validas : 0;
    return [
      x.model,
      String(x.chamadas),
      String(x.invalidas),
      x.chamadas > 0 ? `${((x.invalidas / x.chamadas) * 100).toFixed(1)}%` : '—',
      usd(x.custoTotal),
      usd(porMercado),
      x.latenciaMediana === null ? '—' : `${Math.round(x.latenciaMediana)} ms`,
      x.pegadinhasMediana === null ? '—' : x.pegadinhasMediana.toFixed(1),
      x.ambiguidadesMediana === null ? '—' : x.ambiguidadesMediana.toFixed(1),
    ];
  });

  return table(
    [
      'modelo',
      'chamadas',
      'inválidas',
      'taxa',
      'custo total',
      'por mercado',
      'latência med.',
      'pegadinhas med.',
      'ambig. med.',
    ],
    linhas,
    [0],
  );
}

function markdownMetricas(saidas: readonly Saida[], models: readonly string[]): string {
  const head =
    '| modelo | chamadas | inválidas | taxa | custo total | por mercado | latência mediana | pegadinhas (mediana) | ambiguidades (mediana) |\n' +
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |\n';

  const linhas = models
    .map(m => {
      const x = metricas(saidas, m);
      const porMercado = x.validas > 0 ? x.custoTotal / x.validas : 0;
      return (
        `| \`${x.model}\` | ${x.chamadas} | ${x.invalidas} | ` +
        `${x.chamadas > 0 ? ((x.invalidas / x.chamadas) * 100).toFixed(1) + '%' : '—'} | ` +
        `${usd(x.custoTotal)} | ${usd(porMercado)} | ` +
        `${x.latenciaMediana === null ? '—' : Math.round(x.latenciaMediana) + ' ms'} | ` +
        `${x.pegadinhasMediana === null ? '—' : x.pegadinhasMediana.toFixed(1)} | ` +
        `${x.ambiguidadesMediana === null ? '—' : x.ambiguidadesMediana.toFixed(1)} |`
      );
    })
    .join('\n');

  return head + linhas + '\n';
}

/**
 * O markdown legível, um mercado por seção e os modelos lado a lado.
 *
 * Não há veredito aqui, e a ausência é decisão: as medidas objetivas (custo,
 * latência, taxa de inválida) saem na tabela e o texto de cada modelo sai
 * inteiro. Quem julga qual leitura é melhor é o dono — julgar por ele
 * transformaria a comparação num resumo da minha opinião sobre a comparação.
 */
function renderRelatorio(
  degrau: Degrau,
  amostra: readonly MarketToDigest[],
  saidas: readonly Saida[],
  corrida: Corrida,
  estimado: number,
  seed: number,
  promptVersion: string,
): string {
  const porMercado = new Map<string, Saida[]>();
  for (const s of saidas) {
    const arr = porMercado.get(s.market.eventId) ?? [];
    arr.push(s);
    porMercado.set(s.market.eventId, arr);
  }

  const validos = saidas.filter((s): s is Sucesso => s.ok).map(s => s.result.output);
  const dist = distribuir(validos);
  const descartes = somarDescartes(saidas);
  const podado =
    descartes.trechoInexistente + descartes.trechoRepetido + descartes.trechoCurto;
  const podadasContradicao =
    descartes.contradicaoSemSegundoTrecho + descartes.contradicaoNaoAncorada;

  const cabecalho = [
    `# Digestão de regras — degrau ${degrau.numero}, prompt \`${promptVersion}\``,
    '',
    degrau.descricao,
    '',
    // The stamp comes first because it is what makes every number below
    // comparable to the next run's. The 6.6% of null digests sat in
    // `spec-tela-regra.md` §10 for a week with no date, and dating it
    // afterwards cost an mtime and a bracket of two commits -- a rate with no
    // date cannot be checked against a later one, which is how a rate doubles
    // without anyone seeing it.
    `- **rodou em:** ${new Date().toISOString()}`,
    `- **mercados:** ${amostra.length}`,
    `- **modelos:** ${degrau.models.map(m => `\`${m}\``).join(', ')}`,
    `- **prompt:** \`${promptVersion}\``,
    `- **chamadas:** ${saidas.length}`,
    `- **amostra:** aleatória, semente fixa \`${seed}\` (reprodutível: mesma semente, mesma lista)`,
    `- **custo estimado antes de rodar:** ${usd(estimado)}`,
    `- **custo real:** ${usd(corrida.gasto)}` +
      (estimado > 0
        ? ` (${corrida.gasto >= estimado ? '+' : ''}${(((corrida.gasto - estimado) / estimado) * 100).toFixed(1)}% sobre o estimado)`
        : ''),
    corrida.barradasPeloTeto > 0
      ? `- **BARRADAS PELO TETO:** ${corrida.barradasPeloTeto} chamadas não foram feitas`
      : null,
    '',
    ...secaoContradicoes(colherContradicoes(saidas)),
    '## Medidas',
    '',
    markdownMetricas(saidas, degrau.models),
    '',
    `**Pegadinhas:** ${dist.totalPegadinhas} em ${dist.mercadosValidos} digestões válidas — ` +
      `${dist.mercadosComZeroPegadinhas} mercado(s) vieram com ZERO, que é resposta desejada quando a regra é direta.`,
    '',
    ...(podado === 0 && descartes.severidadeRebaixada === 0
      ? []
      : [
          `**Podadas pela conferência:** ${podado} de ${podado + dist.totalPegadinhas} ` +
            `(${((podado / Math.max(1, podado + dist.totalPegadinhas)) * 100).toFixed(1)}%) — ` +
            `${descartes.trechoInexistente} por trecho inexistente, ` +
            `${descartes.trechoRepetido} por trecho repetido, ` +
            `${descartes.trechoCurto} por trecho curto demais. ` +
            `${descartes.severidadeRebaixada} severidade(s) rebaixada(s) para \`detalhe\` por falta de cenário.`,
          '',
          ...(descartes.amostras.length === 0
            ? []
            : [
                '<details><summary>o que foi podado</summary>',
                '',
                ...descartes.amostras.map(
                  a => `- \`${a.motivo}\` — ${a.texto}${a.trecho === '' ? '' : `  \n  trecho citado: *"${a.trecho}"*`}`,
                ),
                '',
                '</details>',
                '',
              ]),
        ]),
    // A poda das contradições sai separada da das pegadinhas, e não somada: a
    // diferença entre "o modelo não achou contradição" e "achou e não sustentou
    // com as duas passagens" é justamente o que se quer poder ler.
    ...(podadasContradicao === 0
      ? []
      : [
          `**Contradições podadas:** ${podadasContradicao} — ` +
            `${descartes.contradicaoSemSegundoTrecho} sem a segunda passagem, ` +
            `${descartes.contradicaoNaoAncorada} com trecho que não está na regra.`,
          '',
          '<details><summary>as contradições que não se sustentaram</summary>',
          '',
          ...descartes.amostrasAmbiguidade.map(
            a => `- \`${a.motivo}\` — ${a.texto}  \n  trechos citados: *"${a.trecho}"*`,
          ),
          '',
          '</details>',
          '',
        ]),
    markdownDistribuicao('severidade', dist.porSeveridade, SEVERIDADES, dist.totalPegadinhas),
    '',
    `**Ambiguidades:** ${dist.totalAmbiguidades}` +
      (dist.taxaOutro === null
        ? ''
        : ` — taxa de \`outro\`: **${(dist.taxaOutro * 100).toFixed(1)}%**` +
          (dist.taxaOutro >= TETO_OUTRO
            ? ' ⚠️ **no limiar de 20% ou acima: vá LER os `outro`, um a um.**'
            : ' (abaixo de 20%)')),
    '',
    markdownDistribuicao('tipo', dist.porTipo, tiposDe(promptVersion), dist.totalAmbiguidades),
    '',
    ...avisoDeAmostra(dist.mercadosValidos),
    'A comparação de QUALIDADE não está aqui de propósito: as medidas acima são as',
    'objetivas, e o texto de cada modelo sai inteiro abaixo. Quem julga é quem lê.',
    '',
    '## As digestões',
    '',
  ]
    .filter((l): l is string => l !== null)
    .join('\n');

  const corpo = amostra
    .map((market, i) => {
      const doMercado = porMercado.get(market.eventId) ?? [];
      const blocos = degrau.models
        .map(model => {
          const saida = doMercado.find(s => s.model === model);
          const titulo = degrau.models.length > 1 ? `#### \`${model}\`\n\n` : '';
          return titulo + (saida === undefined ? '> não rodou (teto de gasto)\n' : renderDigest(saida));
        })
        .join('\n');

      return [
        `### ${i + 1}. ${market.input.question}`,
        '',
        `<sub>\`${market.input.slug ?? market.polymarketId}\`` +
          (market.tema === null ? '' : ` · ${market.tema}`) +
          ` · hash \`${hashDescription(market.input.description).slice(0, 12)}\`` +
          ` · ${market.input.description.length} caracteres de regra</sub>`,
        '',
        '<details><summary>a regra, íntegra</summary>',
        '',
        '```',
        market.input.description,
        '```',
        '',
        '</details>',
        '',
        blocos,
      ].join('\n');
    })
    .join('\n---\n\n');

  return `${cabecalho}${corpo}\n`;
}

// ---------------------------------------------------------------------------
// Comparação entre versões de prompt
// ---------------------------------------------------------------------------

interface Artefato {
  version: string;
  /** Só as digestões VÁLIDAS, por `event_id`. */
  porMercado: Map<string, DigestOutput>;
  /**
   * TODOS os `event_id` que a rodada tentou, na ordem, inclusive os que
   * falharam.
   *
   * Separado de `porMercado` por uma razão que custou uma rodada para aparecer:
   * a primeira versão do artefato só gravava sucesso, e ancorar a amostra nele
   * devolvia 9 dos 10 mercados — faltando exatamente o que a trava tinha
   * recusado, que é o caso que a rodada seguinte existe para consertar. Um
   * registro que perde o fracasso não serve para medir o conserto do fracasso.
   */
  ids: string[];
}

/**
 * Lê um artefato JSON de rodada, de qualquer uma das duas formas que já existiram.
 *
 * A v1 gravou a linha de `market_rule_digests` plana, com `pegadinhas` e
 * `ambiguidades` como listas de string. A v2 grava `{digest, pegadinhas,
 * ambiguidades}` porque as duas viraram tabelas-filhas.
 *
 * Ler as duas aqui, e não converter o arquivo antigo, é decisão: o artefato da
 * v1 é o registro do que foi rodado ontem, e reescrevê-lo para caber no formato
 * de hoje apagaria a prova de qual formato produziu qual saída. Vinte linhas de
 * leitor custam menos que isso.
 */
async function lerArtefato(path: string, version: string): Promise<Artefato> {
  const raw = JSON.parse(await readFile(path, 'utf8')) as unknown[];
  const porMercado = new Map<string, DigestOutput>();
  const ids: string[] = [];

  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue;
    const record = entry as Record<string, unknown>;

    // Forma nova: {digest, pegadinhas, ambiguidades}. Forma antiga: tudo plano.
    const digest = (record['digest'] ?? record) as Record<string, unknown>;
    const eventId = (digest['event_id'] ?? record['event_id']) as unknown;
    if (typeof eventId !== 'string') continue;
    ids.push(eventId);

    // Entrada de FALHA: o mercado foi tentado e não produziu digestão. Entra em
    // `ids` (a amostra o inclui) e fica fora de `porMercado` (não há o que ler).
    if (record['falha'] !== undefined) continue;

    const pegRaw = (record['pegadinhas'] ?? digest['pegadinhas'] ?? []) as unknown[];
    const ambRaw = (record['ambiguidades'] ?? digest['ambiguidades'] ?? []) as unknown[];

    porMercado.set(eventId, {
      resolveSim: (digest['resolve_sim'] as string[]) ?? [],
      resolveNao: (digest['resolve_nao'] as string[]) ?? [],
      fonte: (digest['fonte'] as string | null) ?? null,
      anulaSe: (digest['anula_se'] as string[]) ?? [],
      prazo: (digest['prazo'] as string | null) ?? null,
      pegadinhas: pegRaw.map(p =>
        typeof p === 'string'
          ? { texto: p, severidade: null, trecho: null, cenario: null }
          : {
              texto: String((p as Record<string, unknown>)['texto'] ?? ''),
              severidade: ((p as Record<string, unknown>)['severidade'] ??
                null) as Pegadinha['severidade'],
              trecho: ((p as Record<string, unknown>)['trecho'] ?? null) as string | null,
              cenario: ((p as Record<string, unknown>)['cenario'] ?? null) as string | null,
            },
      ),
      ambiguidades: ambRaw.map(a =>
        typeof a === 'string'
          ? { tipo: null, trecho: null, trechoConflito: null, leituraA: a, leituraB: null }
          : {
              tipo: ((a as Record<string, unknown>)['tipo'] ?? null) as Ambiguidade['tipo'],
              trecho: ((a as Record<string, unknown>)['trecho'] ?? null) as string | null,
              trechoConflito: ((a as Record<string, unknown>)['trecho_conflito'] ?? null) as
                | string
                | null,
              leituraA: String((a as Record<string, unknown>)['leitura_a'] ?? ''),
              leituraB: ((a as Record<string, unknown>)['leitura_b'] ?? null) as string | null,
            },
      ),
    });
  }

  return { version, porMercado, ids };
}

/**
 * A amostra ancorada nos ids de uma rodada anterior, na ordem daquele arquivo.
 *
 * É o que faz "os mesmos 10 mercados" ser verdade e não intenção. Mercado que
 * saiu do roster desde então some da lista, e o aviso diz quantos — melhor uma
 * comparação com nove mercados e o número na tela que dez em que um é outro.
 */
function ancorar(
  artefato: Artefato,
  todos: readonly MarketToDigest[],
): { amostra: MarketToDigest[]; sumiram: number } {
  const porId = new Map(todos.map(m => [m.eventId, m]));
  const amostra: MarketToDigest[] = [];
  let sumiram = 0;

  for (const eventId of artefato.ids) {
    const market = porId.get(eventId);
    if (market === undefined) sumiram += 1;
    else amostra.push(market);
  }

  return { amostra, sumiram };
}

/**
 * As duas versões da mesma regra, uma ao lado da outra.
 *
 * Sem veredito, e a ausência é decisão: quem julga qual versão lê melhor a regra
 * é quem escreveu a regra do negócio, não quem escreveu o script. O que sai aqui
 * são as duas saídas inteiras e as duas distribuições — o material da decisão,
 * não a decisão.
 */
function renderComparacao(
  amostra: readonly MarketToDigest[],
  a: Artefato,
  b: Artefato,
): string {
  const distA = distribuir([...a.porMercado.values()]);
  const distB = distribuir([...b.porMercado.values()]);

  const resumo = (nome: string, d: Distribuicoes): string =>
    `| \`${nome}\` | ${d.mercadosValidos} | ${d.totalPegadinhas} | ` +
    `${d.mercadosValidos > 0 ? (d.totalPegadinhas / d.mercadosValidos).toFixed(1) : '—'} | ` +
    `${d.mercadosComZeroPegadinhas} | ${d.totalAmbiguidades} | ` +
    `${d.taxaOutro === null ? '—' : (d.taxaOutro * 100).toFixed(1) + '%'} |`;

  const cabecalho = [
    `# Digestão de regras — \`${a.version}\` × \`${b.version}\`, mesmos mercados`,
    '',
    `Mesma amostra, mesma semente, mesmo modelo. A única variável é a versão do prompt.`,
    '',
    '| versão | digestões | pegadinhas | por mercado | mercados com zero | ambiguidades | taxa `outro` |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: |',
    resumo(a.version, distA),
    resumo(b.version, distB),
    '',
    `### Severidade das pegadinhas — \`${b.version}\``,
    '',
    markdownDistribuicao('severidade', distB.porSeveridade, SEVERIDADES, distB.totalPegadinhas),
    '',
    `### Tipo das ambiguidades — \`${b.version}\``,
    '',
    markdownDistribuicao('tipo', distB.porTipo, tiposDe(b.version), distB.totalAmbiguidades),
    '',
    'Qual versão lê melhor a regra não está decidido aqui. As duas saídas inteiras',
    'vêm abaixo, uma ao lado da outra, para quem lê decidir.',
    '',
    '---',
    '',
  ].join('\n');

  const corpo = amostra
    .map((market, i) => {
      const outA = a.porMercado.get(market.eventId);
      const outB = b.porMercado.get(market.eventId);

      return [
        `## ${i + 1}. ${market.input.question}`,
        '',
        `<sub>\`${market.input.slug ?? market.polymarketId}\`` +
          (market.tema === null ? '' : ` · ${market.tema}`) +
          ` · ${market.input.description.length} caracteres de regra</sub>`,
        '',
        '<details><summary>a regra, íntegra</summary>',
        '',
        '```',
        market.input.description,
        '```',
        '',
        '</details>',
        '',
        `### \`${a.version}\``,
        '',
        outA === undefined ? '> não há saída válida desta versão para este mercado\n' : renderOutput(outA, ''),
        '',
        `### \`${b.version}\``,
        '',
        outB === undefined ? '> não há saída válida desta versão para este mercado\n' : renderOutput(outB, ''),
      ].join('\n');
    })
    .join('\n---\n\n');

  return `${cabecalho}${corpo}\n`;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  if ('error' in parsed) {
    console.error(`[${LABEL}] ${parsed.error}`);
    console.error(
      `[${LABEL}] uso: npm run digerir -- [--dry-run] [--degrau=1|2|3] [--model=NOME] [--prompt=vN] [--seed=N] [--limit=N]\n` +
        `[${LABEL}]      npm run digerir -- --comparar=v1,v2 [--degrau=N]`,
    );
    process.exit(1);
    return;
  }

  const config = await getSystemConfig();
  const promptVersion = parsed.prompt ?? config.digest_prompt_version;
  const teto = config.digest_daily_budget_usd;

  if (getPrompt(promptVersion) === null) {
    console.error(
      `[${LABEL}] versão de prompt desconhecida: ${promptVersion} (conhecidas: ${promptVersions().join(', ')})`,
    );
    process.exit(1);
    return;
  }

  const todos = await readMarketsToDigest();
  const degrau = montarDegrau(parsed, config);
  const embaralhadosTodos = embaralhar(todos, parsed.seed);

  // ---- Modo comparação: não chama modelo nenhum, só lê o que já rodou ----
  if (parsed.comparar !== null) {
    const [va, vb] = parsed.comparar;
    const artefatoA = await lerArtefato(`${caminhoBase(degrau.numero, va, null)}.json`, va);
    const artefatoB = await lerArtefato(`${caminhoBase(degrau.numero, vb, null)}.json`, vb);
    // A ordem e o conjunto saem do artefato mais antigo, não de um sorteio novo:
    // a comparação é sobre os mercados que aquela rodada de fato viu.
    const { amostra: amostraCmp } = ancorar(artefatoA, todos);

    const destino = `${OUT_DIR}/degrau-${degrau.numero}-${va}-x-${vb}.md`;
    await mkdir(OUT_DIR, { recursive: true });
    await writeFile(destino, renderComparacao(amostraCmp, artefatoA, artefatoB), 'utf8');

    console.log(section(`Comparação ${va} × ${vb} — degrau ${degrau.numero}`));
    console.log(`  ${artefatoA.porMercado.size} digestões em ${va}, ${artefatoB.porMercado.size} em ${vb}`);
    console.log(`  nenhuma chamada foi feita: este modo só lê os artefatos em disco.`);
    console.log(`\n  ${destino}`);
    return;
  }

  console.log(
    section(`Digestão de regras — degrau ${degrau.numero} (${parsed.dryRun ? 'DRY RUN, nada é chamado' : 'CORRIDA REAL'})`),
  );
  console.log(`  ${degrau.descricao}`);
  console.log(`  mercados com regra no radar: ${todos.length}`);
  console.log(`  prompt: ${promptVersion}  |  teto do dia: ${usd(teto)}  |  timeout: ${config.digest_timeout_ms} ms`);

  // Modelo sem preço não roda — a conferência é aqui e não no meio do laço.
  for (const model of degrau.models) {
    if (!knownModel(model)) {
      console.error(
        `[${LABEL}] modelo sem preço conhecido: ${model}\n` +
          `  sem preço não há teto de gasto. Conhecidos: ${pricedModels().join(', ')}`,
      );
      process.exit(1);
      return;
    }
    if (providerFor(model) === null) {
      console.error(`[${LABEL}] nenhum fornecedor conhece ${model} — ver src/llm/registry.ts`);
      process.exit(1);
      return;
    }
  }

  const digeridos = await readDigested();
  console.log(
    `  já digerido: ${digeridos.tabelaExiste ? `${digeridos.keys.size} linhas` : 'tabela market_rule_digests não existe ainda (migration não aplicada)'}`,
  );

  // ---- A exclusão: garantia de código, não conferência no olho ----
  const excluidos = new Set<string>();
  for (const versao of parsed.excluirDe) {
    const artefato = await lerArtefato(`${caminhoBase(degrau.numero, versao, null)}.json`, versao);
    for (const id of artefato.ids) excluidos.add(id);
  }
  if (excluidos.size > 0) {
    console.log(
      `  excluindo ${excluidos.size} mercados já digeridos em ${parsed.excluirDe.join(', ')} — ` +
        'a régua do prompt cita casos reais e eles vêm dessas rodadas',
    );
  }

  let amostra: MarketToDigest[];
  if (parsed.amostraDe !== null) {
    const ancora = await lerArtefato(
      `${caminhoBase(degrau.numero, parsed.amostraDe, null)}.json`,
      parsed.amostraDe,
    );
    const ancorada = ancorar(ancora, todos);
    amostra = ancorada.amostra;
    console.log(
      `  amostra ANCORADA na rodada ${parsed.amostraDe}: ${amostra.length} mercados pelos mesmos ids` +
        (ancorada.sumiram > 0 ? `  (${ancorada.sumiram} saíram do roster desde então)` : ''),
    );
  } else {
    // A exclusão entra ANTES do corte da fatia, não depois: cortar primeiro e
    // filtrar depois devolveria menos mercados que o degrau pede, em silêncio.
    const elegiveis = embaralhadosTodos.filter(m => !excluidos.has(m.eventId));
    amostra = elegiveis.slice(degrau.inicio, degrau.fim ?? undefined);
  }

  // A garantia, conferida e não presumida: nenhum mercado da amostra está no
  // conjunto excluído. Se a asserção cair, a régua do prompt contém respostas
  // dos mercados que estão sendo medidos — e a medição não vale.
  const vazamento = amostra.filter(m => excluidos.has(m.eventId));
  if (vazamento.length > 0) {
    console.error(
      `[${LABEL}] ${vazamento.length} mercados da amostra estão no conjunto excluído. Parando.`,
    );
    process.exit(1);
    return;
  }

  // A fila: uma tarefa por (mercado, modelo), pulando o que já foi digerido com
  // ESTE texto e ESTE modelo. Descrição editada tem hash novo e não casa — volta
  // para a fila sozinha, que é o mecanismo inteiro de não envelhecer em silêncio.
  const tarefas: Tarefa[] = [];
  let jaFeitas = 0;
  for (const market of amostra) {
    for (const model of degrau.models) {
      const chave = {
        eventId: market.eventId,
        descriptionSha256: hashDescription(market.input.description),
        model,
        promptVersion,
      };
      if (jaDigerido(digeridos, chave)) {
        jaFeitas += 1;
        continue;
      }
      tarefas.push({ market, model });
    }
  }

  // ---- A conta que precede qualquer chamada paga ----
  let estimado = 0;
  let semEstimativa = 0;
  for (const tarefa of tarefas) {
    const e = estimateOne(tarefa.model, promptVersion, tarefa.market.input);
    if (e === null) semEstimativa += 1;
    else estimado += e.usd;
  }
  estimado = Math.round(estimado * 1_000_000) / 1_000_000;

  console.log(section('A conta, antes de gastar'));
  console.log(
    table(
      ['medida', 'valor'],
      [
        ['mercados na fatia', String(amostra.length)],
        ['modelos', degrau.models.join(' + ')],
        ['chamadas a fazer', String(tarefas.length)],
        ['puladas (já digeridas)', String(jaFeitas)],
        ['custo estimado', usd(estimado)],
        ['teto do dia', usd(teto)],
        ['cabe no teto', estimado <= teto ? 'sim' : 'NÃO'],
      ],
      [0],
    ),
  );
  if (semEstimativa > 0) {
    console.log(`\n  AVISO: ${semEstimativa} chamadas sem estimativa (modelo ou prompt desconhecido).`);
  }
  console.log(
    '\n  A estimativa usa 4 caracteres/token na entrada e 12.000 tokens de saída — este último\n' +
      '  medido na v3 do prompt (mediana de 12.247 em deepseek-v4-flash, raciocínio incluído).\n' +
      '  A entrada é superestimada de propósito: a conta ignora o cache de contexto, que na\n' +
      '  prática derruba os ~1.050 tokens do prompt para ~83. O número do Claude sai no degrau 2.',
  );

  // ---- A conferência do nome do modelo, de graça ----
  if (degrau.models.some(m => providerFor(m) === 'deepseek')) {
    try {
      const disponiveis = await listDeepseekModels();
      const faltando = degrau.models.filter(m => providerFor(m) === 'deepseek' && !disponiveis.includes(m));
      console.log(`\n  modelos que a conta DeepSeek enxerga: ${disponiveis.join(', ')}`);
      if (faltando.length > 0) {
        console.error(
          `\n[${LABEL}] a conta não enxerga: ${faltando.join(', ')}\n` +
            '  Nome errado devolveria 404 por chamada — um laço inteiro de erro. Parando aqui.',
        );
        process.exit(1);
        return;
      }
    } catch (err) {
      // Endpoint gratuito e não essencial: se ele não responde, o que se perde é
      // a conferência antecipada, não a corrida.
      console.log(
        `\n  AVISO: não deu para listar os modelos da DeepSeek (${err instanceof Error ? err.message : String(err)}).`,
      );
    }
  }

  if (parsed.dryRun) {
    console.log(
      `\n[${LABEL}] --dry-run: nenhuma chamada paga foi feita.` +
        (estimado <= teto
          ? `\n  A conta cabe no teto. Para rodar: npm run digerir -- --degrau=${degrau.numero}`
          : '\n  A conta NÃO cabe no teto — suba digest_daily_budget_usd ou reduza a fatia (--limit=N).'),
    );
    return;
  }

  if (estimado > teto) {
    console.error(
      `[${LABEL}] a estimativa (${usd(estimado)}) estoura o teto do dia (${usd(teto)}).\n` +
        '  Nenhuma chamada foi feita. Suba digest_daily_budget_usd ou reduza a fatia (--limit=N).',
    );
    process.exit(1);
    return;
  }

  if (tarefas.length === 0) {
    console.log(`\n[${LABEL}] nada a fazer: tudo nesta fatia já foi digerido com este modelo.`);
    return;
  }

  // ---- A corrida ----
  console.log(section('Rodando'));
  const corrida = await correr(
    tarefas,
    promptVersion,
    config.digest_timeout_ms,
    teto,
    (feito, total, gasto) => {
      if (feito % 5 === 0 || feito === total) {
        console.log(`  ${feito}/${total} chamadas  |  gasto até aqui: ${usd(gasto)}`);
      }
    },
  );

  console.log(section('Resultado'));
  console.log(tabelaMetricas(corrida.saidas, degrau.models));
  console.log(
    `\n  custo real: ${usd(corrida.gasto)}  |  estimado: ${usd(estimado)}` +
      (estimado > 0
        ? `  |  divergência: ${corrida.gasto >= estimado ? '+' : ''}${(((corrida.gasto - estimado) / estimado) * 100).toFixed(1)}%`
        : ''),
  );
  if (corrida.barradasPeloTeto > 0) {
    console.log(`  TETO ATINGIDO: ${corrida.barradasPeloTeto} chamadas não foram feitas.`);
  }

  const falhas = corrida.saidas.filter((s): s is Falha => !s.ok);
  if (falhas.length > 0) {
    console.log('\n  Saídas inválidas, por código:');
    const porCodigo = new Map<string, number>();
    for (const f of falhas) porCodigo.set(f.code, (porCodigo.get(f.code) ?? 0) + 1);
    console.log(
      table(
        ['código', 'n'],
        [...porCodigo.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => [k, String(v)]),
        [0],
      ),
    );
    console.log(`\n  Primeira: ${falhas[0]?.message ?? ''}`);
  }

  // ---- As distribuições, que é o que a v2 existe para tornar contável ----
  const validos = corrida.saidas.filter((s): s is Sucesso => s.ok).map(s => s.result.output);
  const dist = distribuir(validos);

  console.log(
    `\n  pegadinhas: ${dist.totalPegadinhas} em ${dist.mercadosValidos} digestões  |  ` +
      `mercados com ZERO: ${dist.mercadosComZeroPegadinhas}`,
  );
  console.log(
    tabelaDistribuicao('\n  Severidade das pegadinhas:', dist.porSeveridade, SEVERIDADES, dist.totalPegadinhas),
  );
  console.log(
    tabelaDistribuicao('\n  Tipo das ambiguidades:', dist.porTipo, tiposDe(promptVersion), dist.totalAmbiguidades),
  );
  if (dist.taxaOutro !== null) {
    const pct = (dist.taxaOutro * 100).toFixed(1);
    console.log(
      dist.taxaOutro >= TETO_OUTRO
        ? `\n  taxa de 'outro': ${pct}% — NO LIMIAR DE 20% OU ACIMA.\n` +
            "  Alarme, não veredito: vá LER os 'outro' um a um. Foi o que fechou a lista na v4."
        : `\n  taxa de 'outro': ${pct}% (abaixo de 20%)`,
    );
  }
  if (dist.mercadosValidos < N_MINIMO_PARA_COMPARAR) {
    console.log(
      `\n  n = ${dist.mercadosValidos}: smoke test, não comparação. Os percentuais acima não sustentam\n` +
        '  "ficou melhor" — a v3 deu 20,0%, 6,7% e 30,4% em três rodadas do MESMO prompt nos\n' +
        `  mesmos 10 mercados. Comparação de qualidade só em n >= ${N_MINIMO_PARA_COMPARAR}.`,
    );
  }

  // ---- O que a conferência podou: a medida direta do enchimento ----
  const descartes = somarDescartes(corrida.saidas);
  const totalPodado =
    descartes.trechoInexistente + descartes.trechoRepetido + descartes.trechoCurto;
  if (totalPodado > 0 || descartes.severidadeRebaixada > 0) {
    console.log(
      tabelaDistribuicao(
        '\n  Podado pela conferência (pegadinhas que não entraram):',
        new Map([
          ['trecho não está na regra', descartes.trechoInexistente],
          ['trecho repetido', descartes.trechoRepetido],
          ['trecho curto demais', descartes.trechoCurto],
        ]),
        ['trecho não está na regra', 'trecho repetido', 'trecho curto demais'],
        totalPodado + dist.totalPegadinhas,
      ),
    );
    console.log(
      `\n  ${totalPodado} de ${totalPodado + dist.totalPegadinhas} pegadinhas foram podadas ` +
        `(${(((totalPodado) / Math.max(1, totalPodado + dist.totalPegadinhas)) * 100).toFixed(1)}%)  |  ` +
        `severidades rebaixadas por falta de cenário: ${descartes.severidadeRebaixada}`,
    );
    for (const a of descartes.amostras.slice(0, 5)) {
      console.log(`    [${a.motivo}] ${a.texto.slice(0, 90)}`);
    }
  }

  const podadasContradicao =
    descartes.contradicaoSemSegundoTrecho + descartes.contradicaoNaoAncorada;
  if (podadasContradicao > 0) {
    console.log(
      `\n  contradições podadas: ${podadasContradicao}  |  ` +
        `sem a segunda passagem: ${descartes.contradicaoSemSegundoTrecho}  |  ` +
        `trecho fora da regra: ${descartes.contradicaoNaoAncorada}`,
    );
  }

  // ---- O achado que vale dinheiro, no terminal e no topo do relatório ----
  const contradicoes = colherContradicoes(corrida.saidas);
  if (contradicoes.length > 0) {
    console.log(
      `\n  CONTRADIÇÕES INTERNAS: ${contradicoes.length} — a regra afirma duas coisas incompatíveis.` +
        '\n  (por liquidez, maior primeiro; a lista completa com os dois trechos e a URL está no .md)',
    );
    // No terminal só as 10 maiores: numa passada de 752 a lista inteira rola
    // para fora da tela e o relatório é o lugar dela.
    for (const c of contradicoes.slice(0, 10)) {
      console.log(
        `    ${c.liquidez === null ? '(liquidez —)' : usd(c.liquidez).padStart(14)}  ${c.mercado.slice(0, 70)}`,
      );
      console.log(`      "${c.trecho.slice(0, 76)}"`);
      console.log(`      contra "${c.trechoConflito.slice(0, 76)}"`);
      console.log(`      ${c.url}`);
    }
    if (contradicoes.length > 10) {
      console.log(`    ... e mais ${contradicoes.length - 10} no relatório.`);
    }
  }

  // ---- Os arquivos ----
  const base = caminhoBase(degrau.numero, promptVersion, parsed.amostraDe);
  await mkdir(dirname(base), { recursive: true });

  const md = renderRelatorio(
    degrau,
    amostra,
    corrida.saidas,
    corrida,
    estimado,
    parsed.seed,
    promptVersion,
  );
  await writeFile(`${base}.md`, md, 'utf8');

  // The fourth table is `market_rule_texts`: the digested text travels with the
  // digest that produced it, so it is stored the moment it was read instead of
  // recovered from `events.description` later, which only works until Polymarket
  // edits the description (issue #9).
  //
  // O JSON carrega as LINHAS das quatro tabelas, montadas por `buildDigestRows`. O
  // script não grava — a migration não foi aplicada, e escrita é do dono. Quando
  // as tabelas existirem, o payload já está conferido.
  //
  // As FALHAS entram no mesmo arquivo, com `event_id` e sem linhas. Sem isso a
  // rodada seguinte não consegue repetir a amostra: ancorar num artefato que só
  // guarda sucesso perde exatamente os mercados que a nova versão existe para
  // consertar.
  const linhas = corrida.saidas.map(s =>
    s.ok
      ? buildDigestRows(s.market, s.result, promptVersion, s.model)
      : {
          event_id: s.market.eventId,
          model: s.model,
          prompt_version: promptVersion,
          falha: { code: s.code, message: s.message },
        },
  );
  await writeFile(`${base}.json`, JSON.stringify(linhas, null, 2), 'utf8');

  console.log(section('Onde ficou'));
  console.log(`  ${base}.md    — as digestões para ler`);
  console.log(`  ${base}.json  — as linhas das quatro tabelas, prontas e NÃO gravadas`);
}

main().catch((err: unknown) => {
  console.error(`[${LABEL}] falhou:`, err instanceof Error ? err.message : String(err));
  process.exit(1);
});
