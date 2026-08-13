import 'dotenv/config';

import { SPACING_MS, callCounts, call, isRecord, section, table, totalCalls } from './lib/probe-net.js';
import { DEFAULT_PAIRING_CONFIG, generateCandidates } from './lib/market-pairing.js';
import type { PairingMarket } from './lib/market-pairing.js';
import { lerDesfecho, type Desfecho } from '../src/relacoes/desfecho.js';

/**
 * Congela o conjunto de grupos inteiramente resolvidos — o gabarito da fase 2.
 *
 * A fase 1 mediu que 762 dos 3.551 grupos são só de mercados já resolvidos, e é
 * neles que a precisão se mede sem rotulagem humana. Mas a sonda da fase 1 não
 * guardava os grupos: ela contava e jogava fora. Rodar o extrator sobre uma
 * amostragem refeita a cada execução tornaria a fila irreprodutível, e fila
 * irreprodutível não é amostra aleatória — é "os grupos que calharam de vir
 * hoje" (Parte E, Parte H).
 *
 * Então este script escreve UM arquivo, uma vez, e é dele que a fila nasce.
 *
 * ## O desfecho sai separado, e essa separação é a fase inteira
 *
 * O arquivo tem duas metades por mercado: `paraPrompt`, com pergunta, regras e
 * datas, e `desfecho`, com o resultado. Só a primeira chega ao modelo. Se o
 * desfecho vazasse, o agente deduziria a relação do resultado em vez de ler as
 * perguntas, e os 90% da Parte E seriam ficção. O teste com sentinela em
 * `src/relacoes/extrator.test.ts` guarda essa fronteira.
 *
 * SÓ LEITURA: não toca Supabase, não escreve tabela, não roda migration.
 * Nenhuma chamada à OddsPapi. Zero chamadas a modelo.
 *
 * ## Uso
 *
 *   npm run relacoes:coletar -- --dry-run
 *   npm run relacoes:coletar -- --paginas=12
 */

const LABEL = 'coletar-grupos';

const GAMMA = process.env['POLYMARKET_GAMMA_URL'] ?? 'https://gamma-api.polymarket.com';
const SAIDA = 'probes/relacoes/grupos-resolvidos.json';

/** `limit` satura em 100 e `offset` estoura em 2000 — medido na fase 1. */
const PAGINA = 100;
const TETO_DE_OFFSET = 2000;

interface Args {
  paginas: number;
  dryRun: boolean;
}

function parseArgs(argv: readonly string[]): Args | { error: string } {
  const args: Args = { paginas: 8, dryRun: false };
  for (const arg of argv) {
    if (arg === '--dry-run') {
      args.dryRun = true;
      continue;
    }
    const m = /^--paginas=(\d+)$/.exec(arg);
    if (m === null) return { error: `argumento desconhecido: ${arg}` };
    args.paginas = Math.min(Number(m[1]), TETO_DE_OFFSET / PAGINA);
  }
  return args;
}

// ---------------------------------------------------------------------------
// Gamma
// ---------------------------------------------------------------------------

interface GammaMarket {
  id: string;
  question: string;
  description: string;
  resolutionSource: string;
  outcomes: string;
  outcomePrices: string;
  endDate: string | null;
  closed: boolean;
}

interface GammaEvent {
  id: string;
  title: string;
  negRisk?: boolean;
  enableNegRisk?: boolean;
  series?: Array<{ id: string }>;
  markets?: GammaMarket[];
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function listaJson(bruto: string): string[] {
  try {
    const p: unknown = JSON.parse(bruto);
    return Array.isArray(p) ? p.map((x) => String(x)) : [];
  } catch {
    return [];
  }
}

let bytes = 0;

async function paginaResolvida(offset: number, ateAData: string): Promise<GammaEvent[]> {
  // Por `endDate` decrescente e com teto na data de hoje: a Gamma tem eventos
  // FECHADOS com `endDate` em 2029, e ordenar sem limitar traria justamente os
  // que ainda não resolveram.
  const params = new URLSearchParams({
    limit: String(PAGINA),
    closed: 'true',
    order: 'endDate',
    ascending: 'false',
    end_date_max: ateAData,
    offset: String(offset),
  });
  const res = await call(`${GAMMA}/events?${params.toString()}`, 'gamma');
  bytes += res.bytes;
  if (res.status !== 200) throw new Error(`Gamma HTTP ${res.status} em offset=${offset}`);
  const corpo = res.body;
  if (Array.isArray(corpo)) return corpo as GammaEvent[];
  if (isRecord(corpo) && Array.isArray(corpo['events'])) return corpo['events'] as GammaEvent[];
  return [];
}

// ---------------------------------------------------------------------------
// O formato de saída
// ---------------------------------------------------------------------------

/** O que o modelo pode ver. Espelha `MercadoParaPrompt`, sem o rótulo. */
interface MercadoParaPrompt {
  pergunta: string;
  desfechoSim: string;
  desfechoNao: string;
  regras: string;
  fechamento: string | null;
  fonteDeResolucao: string | null;
}

interface MercadoDoGrupo {
  id: string;
  /** O rótulo estável do mercado dentro do grupo: `M1`, `M2`, ... */
  rotulo: string;
  paraPrompt: MercadoParaPrompt;
  /** O gabarito. NUNCA entra no prompt. */
  desfecho: Desfecho;
}

interface GrupoResolvido {
  id: string;
  camada: number;
  motivo: string;
  mercados: MercadoDoGrupo[];
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

  const hoje = new Date().toISOString().slice(0, 10);
  const ateAData = `${hoje}T23:59:59Z`;

  console.error(`[${LABEL}] paginando eventos resolvidos…`);
  const eventos: GammaEvent[] = [];
  for (let offset = 0, p = 0; p < args.paginas && offset < TETO_DE_OFFSET; offset += PAGINA, p++) {
    const pagina = await paginaResolvida(offset, ateAData);
    if (pagina.length === 0) break;
    eventos.push(...pagina);
  }

  // Um mercado só entra se o desfecho for LEGÍVEL. Mercado sem desfecho legível
  // num grupo torna todas as relações que o citam não testáveis — deixá-lo
  // dentro só encheria a coluna de "não testável" com lacuna de dados em vez de
  // com vacuidade lógica, que são coisas diferentes e o relatório precisa
  // separar.
  const pareamento: PairingMarket[] = [];
  const porId = new Map<string, { m: GammaMarket; e: GammaEvent; desfecho: Desfecho }>();
  let semDesfecho = 0;
  let naoResolvido = 0;

  for (const evento of eventos) {
    for (const mercado of evento.markets ?? []) {
      if (mercado.closed !== true) {
        naoResolvido++;
        continue;
      }
      const desfecho = lerDesfecho(
        listaJson(str(mercado.outcomes)),
        listaJson(str(mercado.outcomePrices)),
      );
      if (desfecho === null) {
        semDesfecho++;
        continue;
      }
      porId.set(mercado.id, { m: mercado, e: evento, desfecho });
      pareamento.push({
        id: mercado.id,
        question: str(mercado.question),
        rules: str(mercado.description),
        eventId: evento.id,
        seriesId: evento.series?.[0]?.id ?? null,
        negRiskKey:
          evento.negRisk === true || evento.enableNegRisk === true ? `event:${evento.id}` : null,
        tags: [],
        endDate: mercado.endDate,
        resolved: true,
      });
    }
  }

  const { groups, stats } = generateCandidates(pareamento, DEFAULT_PAIRING_CONFIG);

  // Só grupos que precisam de modelo. Grupo neg-risk já vem com a `particiona`
  // declarada pela API — pagar por ele seria comprar o que a Gamma dá de graça,
  // e a Parte H diz que a `particiona` é a relação menos valiosa.
  const candidatos = groups.filter((g) => g.needsModel && g.fullyResolved);

  const saida: GrupoResolvido[] = candidatos.map((g, i) => ({
    id: `g${String(i + 1).padStart(4, '0')}-${g.layer}`,
    camada: g.layer,
    motivo: g.reason,
    mercados: g.memberIds.map((id, k) => {
      const item = porId.get(id) as { m: GammaMarket; e: GammaEvent; desfecho: Desfecho };
      const saidas = listaJson(str(item.m.outcomes));
      return {
        id,
        rotulo: `M${k + 1}`,
        paraPrompt: {
          pergunta: str(item.m.question),
          desfechoSim: saidas[0] ?? 'Yes',
          desfechoNao: saidas[1] ?? 'No',
          regras: str(item.m.description),
          fechamento: item.m.endDate,
          fonteDeResolucao: str(item.m.resolutionSource).trim() || null,
        },
        desfecho: item.desfecho,
      };
    }),
  }));

  const tamanhos = saida.map((g) => g.mercados.length);
  const total = tamanhos.reduce((s, n) => s + n, 0);
  const porCamada = new Map<number, number>();
  for (const g of saida) porCamada.set(g.camada, (porCamada.get(g.camada) ?? 0) + 1);

  const out: string[] = [
    section('COLETA DO GABARITO — grupos inteiramente resolvidos'),
    `  eventos resolvidos lidos:            ${eventos.length}`,
    `  mercados com desfecho legível:       ${pareamento.length}`,
    `  descartados sem desfecho legível:    ${semDesfecho}   (["0","0"], multi-saída, ou preço estranho)`,
    `  descartados por não estarem fechados: ${naoResolvido}`,
    '',
    `  grupos gerados:                      ${stats.groups}`,
    `  ... que precisam de modelo:          ${stats.groupsNeedingModel}`,
    `  ... e inteiramente resolvidos:       ${saida.length}   <- o gabarito`,
    '',
    `  mercados no gabarito:                ${total}`,
    `  tamanho de grupo:                    min ${Math.min(...tamanhos)}  mediana ${mediana(tamanhos)}  max ${Math.max(...tamanhos)}`,
    `  pares dentro dos grupos:             ${tamanhos.reduce((s, n) => s + (n * (n - 1)) / 2, 0)}`,
    '',
    '  por camada do gerador:',
    table(
      ['camada', 'grupos'],
      [...porCamada.entries()].sort((a, b) => a[0] - b[0]).map(([c, n]) => [String(c), String(n)]),
      [0],
    ),
  ];

  if (args.dryRun) {
    out.push('', `  --dry-run: NÃO gravei ${SAIDA}.`);
  } else {
    const { mkdir, writeFile } = await import('node:fs/promises');
    const { dirname } = await import('node:path');
    await mkdir(dirname(SAIDA), { recursive: true });
    await writeFile(
      SAIDA,
      `${JSON.stringify(
        { coletadoEm: new Date().toISOString(), ateAData, grupos: saida },
        null,
        2,
      )}\n`,
      'utf8',
    );
    out.push('', `  gravado: ${SAIDA}`);
  }

  out.push(
    section('CUSTO DA PASSADA'),
    ...callCounts().map(([host, n]) => `  ${host.padEnd(16)} ${n} requisição(ões)`),
    `  ${'TOTAL'.padEnd(16)} ${totalCalls()}   (espaçadas em ${SPACING_MS} ms, ${(bytes / 1048576).toFixed(1)} MB)`,
    '',
    '  Zero chamadas a modelo. Nenhuma escrita no banco. Nenhuma OddsPapi.',
  );

  console.log(out.join('\n'));
}

function mediana(valores: readonly number[]): number {
  if (valores.length === 0) return 0;
  const s = [...valores].sort((a, b) => a - b);
  const meio = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? ((s[meio - 1] as number) + (s[meio] as number)) / 2 : (s[meio] as number);
}

main().catch((err: unknown) => {
  console.error(`[${LABEL}] falhou:`, err instanceof Error ? err.message : String(err));
  process.exit(1);
});
