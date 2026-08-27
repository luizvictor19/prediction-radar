import 'dotenv/config';

import { num, section, table } from './lib/probe-net.js';
import { conferirRelacao, type Desfecho, type Veredito } from '../src/relacoes/desfecho.js';
import { TIPOS_DE_RELACAO, type Relacao, type TipoRelacao } from '../src/relacoes/taxonomia.js';

/**
 * O harness de precisão (spec 003, Parte E).
 *
 * Confere cada relação proposta contra o DESFECHO dos mercados do grupo. Não há
 * opinião envolvida: ou a restrição da Parte B foi violada ou não foi.
 *
 * ## O número que decide a spec é a taxa de REFUTAÇÃO, e não a de compatíveis
 *
 * `compativel` não é `correta`. Duas perguntas sem relação nenhuma cujos
 * desfechos calharam de não se contradizer aparecem como compatíveis — e o
 * gabarito automático não tem como distinguir. Reportar "97% compatíveis" como
 * se fosse precisão seria o mesmo erro que a Parte H declara sobre extrapolar de
 * uma sonda para a produção.
 *
 * Então este relatório dá três números onde um relatório descuidado daria um:
 * refutação (objetiva), não testável (quanto do gabarito ficou em branco) e a
 * amostra humana (o que o automático não alcança).
 *
 * ## E o viés da amostra está declarado antes do resultado
 *
 * Mercado resolvido é mais velho e de tema encerrado. A precisão daqui é TETO
 * OTIMISTA, não expectativa — se nem aqui passa de 90%, no aberto não passa.
 *
 * SÓ LEITURA: nenhuma chamada a modelo, nenhuma escrita no banco.
 *
 * ## Uso
 *
 *   npm run relacoes:medir
 *   npm run relacoes:medir -- --amostra=30 --semente=rotulagem-1
 */

const LABEL = 'medir-relacoes';

const GABARITO = 'probes/relacoes/grupos-resolvidos.json';
const RESULTADOS = 'probes/relacoes/relacoes.jsonl';
const CSV_ROTULAGEM = 'probes/relacoes/amostra-para-rotular.md';

interface Args {
  amostra: number;
  semente: string;
}

function parseArgs(argv: readonly string[]): Args | { error: string } {
  const args: Args = { amostra: 30, semente: 'rotulagem-1' };
  for (const arg of argv) {
    const m = /^--(amostra|semente)=(.+)$/.exec(arg);
    if (m === null) return { error: `argumento desconhecido: ${arg}` };
    if (m[1] === 'amostra') {
      const n = Number(m[2]);
      if (!Number.isInteger(n) || n < 0) return { error: `--amostra=${m[2]} precisa ser inteiro >= 0` };
      args.amostra = n;
    } else args.semente = m[2] as string;
  }
  return args;
}

// ---------------------------------------------------------------------------
// Entrada
// ---------------------------------------------------------------------------

interface MercadoDoGrupo {
  id: string;
  rotulo: string;
  paraPrompt: { pergunta: string; desfechoSim: string; desfechoNao: string };
  desfecho: Desfecho;
}

interface GrupoResolvido {
  id: string;
  camada: number;
  motivo: string;
  mercados: MercadoDoGrupo[];
}

interface LinhaDeResultado {
  grupoId: string;
  status: 'ok' | 'falha';
  erro?: string;
  camada: number;
  membros: number;
  relacoes?: Relacao[];
  modelo: string;
  versaoDePrompt: string;
  esforco: string;
  tokensEntrada: number;
  tokensSaida: number;
  custoUsd: number | null;
  latenciaMs: number;
}

// ---------------------------------------------------------------------------
// Estatística
// ---------------------------------------------------------------------------

/**
 * Intervalo de Wilson a 95%.
 *
 * E não o normal de livro-texto: com 4 refutações em 300 o intervalo normal
 * desce abaixo de zero e sugere certeza que não existe. O de Wilson se comporta
 * nas pontas, que é exatamente onde esta medição vai cair se o extrator for bom.
 */
function wilson(acertos: number, total: number): [number, number] {
  if (total === 0) return [0, 1];
  const z = 1.959964;
  const p = acertos / total;
  const d = 1 + (z * z) / total;
  const centro = p + (z * z) / (2 * total);
  const margem = z * Math.sqrt((p * (1 - p)) / total + (z * z) / (4 * total * total));
  return [Math.max(0, (centro - margem) / d), Math.min(1, (centro + margem) / d)];
}

function pct(parte: number, todo: number): string {
  return todo === 0 ? '—' : `${((100 * parte) / todo).toFixed(1)}%`;
}

/** PRNG determinístico: a amostra de rotulagem tem que ser reprodutível. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function semente32(texto: string): number {
  let h = 2166136261;
  for (let i = 0; i < texto.length; i++) {
    h ^= texto.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// ---------------------------------------------------------------------------
// Principal
// ---------------------------------------------------------------------------

interface Conferida {
  grupoId: string;
  camada: number;
  membros: number;
  relacao: Relacao;
  veredito: Veredito;
  motivo: string;
  perguntas: string[];
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  if ('error' in parsed) {
    console.error(`[${LABEL}] ${parsed.error}`);
    process.exit(2);
  }
  const args = parsed;

  const { readFile } = await import('node:fs/promises');
  const gabarito = (JSON.parse(await readFile(GABARITO, 'utf8')) as { grupos: GrupoResolvido[] })
    .grupos;
  const porGrupo = new Map(gabarito.map((g) => [g.id, g]));

  const linhas = (await readFile(RESULTADOS, 'utf8'))
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as LinhaDeResultado);

  const ok = linhas.filter((l) => l.status === 'ok');
  const falhas = linhas.filter((l) => l.status === 'falha');

  // --- 1. o que a rodada custou --------------------------------------------

  const custo = ok.reduce((s, l) => s + (l.custoUsd ?? 0), 0);
  const entrada = ok.reduce((s, l) => s + l.tokensEntrada, 0);
  const saida = ok.reduce((s, l) => s + l.tokensSaida, 0);
  const semRelacao = ok.filter((l) => (l.relacoes ?? []).length === 0).length;

  const out: string[] = [
    section('MEDIÇÃO DE RELAÇÕES — spec 003, fase 2'),
    `  grupos com resultado:  ${linhas.length}   (ok ${ok.length}, falha ${falhas.length})`,
    `  gasto:                 US$ ${num(custo, 4)}`,
    `  custo por chamada:     US$ ${num(ok.length === 0 ? 0 : custo / ok.length, 4)}`,
    `  tokens:                ${entrada.toLocaleString('pt-BR')} entrada / ${saida.toLocaleString('pt-BR')} saída`,
    `  modelo:                ${[...new Set(ok.map((l) => l.modelo))].join(', ')}`,
    `  prompt:                ${[...new Set(ok.map((l) => l.versaoDePrompt))].join(', ')}   esforço: ${[...new Set(ok.map((l) => l.esforco))].join(', ')}`,
  ];

  if (falhas.length > 0) {
    const porCodigo = new Map<string, number>();
    for (const f of falhas) {
      const codigo = (f.erro ?? 'desconhecido').split(':')[0] as string;
      porCodigo.set(codigo, (porCodigo.get(codigo) ?? 0) + 1);
    }
    out.push(
      '',
      '  falhas por código (chamada paga e não gravada):',
      table(
        ['código', 'grupos'],
        [...porCodigo.entries()].sort((a, b) => b[1] - a[1]).map(([c, n]) => [c, String(n)]),
        [0],
      ),
    );
  }

  // --- 2. o que foi proposto ------------------------------------------------

  const conferidas: Conferida[] = [];
  for (const linha of ok) {
    const grupo = porGrupo.get(linha.grupoId);
    if (grupo === undefined) continue;
    const desfechos = new Map(grupo.mercados.map((m) => [m.rotulo, m.desfecho]));
    const pergunta = new Map(grupo.mercados.map((m) => [m.rotulo, m.paraPrompt.pergunta]));

    for (const relacao of linha.relacoes ?? []) {
      const c = conferirRelacao(relacao, desfechos);
      conferidas.push({
        grupoId: linha.grupoId,
        camada: linha.camada,
        membros: linha.membros,
        relacao,
        veredito: c.veredito,
        motivo: c.motivo,
        perguntas: relacao.mercados.map((r) => pergunta.get(r) ?? r),
      });
    }
  }

  const porTipo = new Map<TipoRelacao, Conferida[]>();
  for (const c of conferidas) {
    const lista = porTipo.get(c.relacao.tipo);
    if (lista === undefined) porTipo.set(c.relacao.tipo, [c]);
    else lista.push(c);
  }

  out.push(
    section('2. O QUE O EXTRATOR PROPÔS'),
    `  relações propostas:    ${conferidas.length}`,
    `  grupos sem relação:    ${semRelacao}/${ok.length}  (${pct(semRelacao, ok.length)})  <- a abstenção, que a Parte D incentiva`,
    `  relações por grupo:    ${num(ok.length === 0 ? 0 : conferidas.length / ok.length, 2)} em média`,
    '',
    table(
      ['tipo', 'n', 'do total', 'confiança mediana'],
      TIPOS_DE_RELACAO.map((t) => {
        const lista = porTipo.get(t) ?? [];
        const confs = lista.map((c) => c.relacao.confianca).sort((a, b) => a - b);
        return [
          t,
          String(lista.length),
          pct(lista.length, conferidas.length),
          confs.length === 0 ? '—' : num(confs[Math.floor(confs.length / 2)] ?? 0, 2),
        ];
      }),
      [0],
    ),
    '',
    `  com ressalva de resolução: ${conferidas.filter((c) => c.relacao.ressalvaDeResolucao !== null).length}/${conferidas.length}  (${pct(conferidas.filter((c) => c.relacao.ressalvaDeResolucao !== null).length, conferidas.length)})`,
  );

  // --- 3. a taxa de refutação ----------------------------------------------

  const refutadas = conferidas.filter((c) => c.veredito === 'refutada');
  const compativeis = conferidas.filter((c) => c.veredito === 'compativel');
  const naoTestaveis = conferidas.filter((c) => c.veredito === 'nao_testavel');
  const testadas = refutadas.length + compativeis.length;
  const taxa = testadas === 0 ? 0 : refutadas.length / testadas;
  const [lo, hi] = wilson(refutadas.length, testadas);

  out.push(
    section('3. TAXA DE REFUTAÇÃO — o número que decide a spec'),
    `  relações testáveis:    ${testadas}   (refutadas ${refutadas.length}, compatíveis ${compativeis.length})`,
    `  não testáveis:         ${naoTestaveis.length}  (${pct(naoTestaveis.length, conferidas.length)} do proposto)`,
    '',
    `  TAXA DE REFUTAÇÃO:     ${pct(refutadas.length, testadas)}   IC95% [${pct(lo, 1)}, ${pct(hi, 1)}]`,
    `  critério de morte:     refutação acima de 10% (precisão abaixo de 90%)`,
    '',
    testadas === 0
      ? '  SEM VEREDITO: nenhuma relação foi testável. O gabarito não respondeu, e a\n' +
        '  decisão passa inteira para a amostra humana.'
      : hi < 0.1
        ? `  PASSA com folga: o teto do intervalo (${pct(hi, 1)}) está abaixo dos 10%.`
        : taxa < 0.1
          ? `  PASSA na estimativa pontual, mas o intervalo vai até ${pct(hi, 1)} — n pequeno demais\n` +
            '  para o critério de morte se sustentar. Rodar mais grupos antes de concluir.'
          : `  NÃO PASSA: a refutação de ${pct(refutadas.length, testadas)} está acima dos 10% que o critério tolera.`,
    '',
    '  LEMBRETE, e ele vale mais que o número acima: `compatível` NÃO é `correta`.',
    '  Duas perguntas sem relação nenhuma cujos desfechos calharam de não se',
    '  contradizer entram como compatíveis. A taxa de refutação é um piso para o',
    '  erro, nunca uma medida de acerto — o que separa compatível de correta é a',
    '  amostra humana da seção 6.',
    '',
    '  E o viés declarado antes do resultado (Parte H): mercado resolvido é mais',
    '  velho e de tema encerrado. Isto é TETO OTIMISTA, não expectativa do aberto.',
  );

  // --- 4. por tipo ----------------------------------------------------------

  out.push(
    section('4. POR TIPO DE RELAÇÃO'),
    '  Errar `implica` e errar `conjuncao` são defeitos diferentes.',
    '',
    table(
      ['tipo', 'propostas', 'testáveis', 'refutadas', 'taxa', 'IC95%', 'não testável'],
      TIPOS_DE_RELACAO.map((t) => {
        const lista = porTipo.get(t) ?? [];
        const r = lista.filter((c) => c.veredito === 'refutada').length;
        const cp = lista.filter((c) => c.veredito === 'compativel').length;
        const nt = lista.filter((c) => c.veredito === 'nao_testavel').length;
        const [a, b] = wilson(r, r + cp);
        return [
          t,
          String(lista.length),
          String(r + cp),
          String(r),
          r + cp === 0 ? '—' : pct(r, r + cp),
          r + cp === 0 ? '—' : `[${pct(a, 1)}, ${pct(b, 1)}]`,
          pct(nt, lista.length),
        ];
      }).filter((linha) => linha[1] !== '0'),
      [0],
    ),
    '',
    '  `equivale`, `particiona` e `conjuncao` são SEMPRE testáveis quando os',
    '  desfechos são legíveis. `implica` e `exclui` têm caso vácuo — antecedente',
    '  que não disparou —, e é daí que vem a maior parte do "não testável".',
  );

  // --- 5. por faixa de confiança -------------------------------------------

  const faixas: Array<[string, (c: number) => boolean]> = [
    ['< 0,60', (c) => c < 0.6],
    ['0,60–0,79', (c) => c >= 0.6 && c < 0.8],
    ['0,80–0,89', (c) => c >= 0.8 && c < 0.9],
    ['0,90–0,94', (c) => c >= 0.9 && c < 0.95],
    ['>= 0,95', (c) => c >= 0.95],
  ];

  const linhasFaixa = faixas
    .map(([rotulo, teste]) => {
      const lista = conferidas.filter((c) => teste(c.relacao.confianca));
      const r = lista.filter((c) => c.veredito === 'refutada').length;
      const cp = lista.filter((c) => c.veredito === 'compativel').length;
      const [a, b] = wilson(r, r + cp);
      return [
        rotulo,
        String(lista.length),
        String(r + cp),
        String(r),
        r + cp === 0 ? '—' : pct(r, r + cp),
        r + cp === 0 ? '—' : `[${pct(a, 1)}, ${pct(b, 1)}]`,
      ];
    })
    .filter((linha) => linha[1] !== '0');

  // A confiança separa se as faixas altas refutam menos que as baixas. Comparar
  // a metade de cima com a de baixo em vez de olhar cinco linhas: com n pequeno
  // cada faixa isolada não sustenta conclusão nenhuma.
  const altas = conferidas.filter((c) => c.relacao.confianca >= 0.9);
  const baixas = conferidas.filter((c) => c.relacao.confianca < 0.9);
  const taxaDe = (lista: readonly Conferida[]): { taxa: number; n: number } => {
    const r = lista.filter((c) => c.veredito === 'refutada').length;
    const cp = lista.filter((c) => c.veredito === 'compativel').length;
    return { taxa: r + cp === 0 ? 0 : r / (r + cp), n: r + cp };
  };
  const a90 = taxaDe(altas);
  const b90 = taxaDe(baixas);

  out.push(
    section('5. POR FAIXA DE CONFIANÇA'),
    '  Se a confiança não separa refutada de compatível, o campo é decoração e sai.',
    '',
    table(['faixa', 'propostas', 'testáveis', 'refutadas', 'taxa', 'IC95%'], linhasFaixa, [0]),
    '',
    `  confiança >= 0,90: ${pct(a90.taxa, 1)} de refutação em ${a90.n} testáveis`,
    `  confiança <  0,90: ${pct(b90.taxa, 1)} de refutação em ${b90.n} testáveis`,
    a90.n === 0 || b90.n === 0
      ? '  SEM VEREDITO sobre a confiança: uma das metades está vazia. O modelo não usou\n' +
        '  a faixa toda, e isso por si é um achado — uma confiança que só assume um valor\n' +
        '  não pode separar nada.'
      : b90.taxa > a90.taxa
        ? '  A confiança SEPARA na direção certa: a metade de cima refuta menos.'
        : '  A confiança NÃO separa: a metade de cima refuta o mesmo ou mais que a de baixo.\n' +
          '  Pelo critério da Parte E, o campo é decoração e deve sair.',
  );

  // --- 6. por tamanho de grupo ---------------------------------------------

  const tamanhos: Array<[string, (n: number) => boolean]> = [
    ['2-4', (n) => n <= 4],
    ['5-8', (n) => n >= 5 && n <= 8],
    ['9-12', (n) => n >= 9 && n <= 12],
    ['13+', (n) => n >= 13],
  ];

  out.push(
    section('6. POR TAMANHO DE GRUPO'),
    '  A fase 1 fixou o teto de 12 membros por carga de raciocínio, e por assunção:',
    '  66 pares numa passada. Grupos estruturais grandes passaram do teto e foram',
    '  rodados inteiros de propósito — para a assunção virar medida.',
    '',
    table(
      ['membros', 'grupos', 'propostas', 'testáveis', 'refutadas', 'taxa'],
      tamanhos
        .map(([rotulo, teste]) => {
          const grupos = ok.filter((l) => teste(l.membros));
          const lista = conferidas.filter((c) => teste(c.membros));
          const r = lista.filter((c) => c.veredito === 'refutada').length;
          const cp = lista.filter((c) => c.veredito === 'compativel').length;
          return [
            rotulo,
            String(grupos.length),
            String(lista.length),
            String(r + cp),
            String(r),
            r + cp === 0 ? '—' : pct(r, r + cp),
          ];
        })
        .filter((linha) => linha[1] !== '0'),
      [0],
    ),
  );

  // --- 7. as refutadas, uma a uma ------------------------------------------

  if (refutadas.length > 0) {
    out.push(
      section('7. AS REFUTADAS — o desfecho violou a restrição'),
      ...refutadas.slice(0, 15).flatMap((c) => [
        `  [${c.grupoId}] ${c.relacao.tipo} ${c.relacao.mercados.join(' → ')}  (confiança ${num(c.relacao.confianca, 2)})`,
        ...c.perguntas.map((p, i) => `      ${c.relacao.mercados[i]}: ${p.slice(0, 84)}`),
        `      motivo: ${c.motivo}`,
        `      justificativa do modelo: ${c.relacao.justificativa.slice(0, 150)}`,
        '',
      ]),
      refutadas.length > 15 ? `  ... e mais ${refutadas.length - 15}.` : '',
    );
  }

  // --- 8. a amostra humana --------------------------------------------------

  const rand = mulberry32(semente32(args.semente));
  const sorteadas = [...compativeis]
    .map((c) => ({ c, k: rand() }))
    .sort((a, b) => a.k - b.k)
    .slice(0, args.amostra)
    .map((x) => x.c);

  if (sorteadas.length > 0) {
    const md = [
      '# Amostra para rotulagem humana: spec 003, fase 2 (H1)',
      '',
      `Sorteadas ao acaso (semente \`${args.semente}\`) entre as **compatíveis**, não entre as mais`,
      'confiantes: medir só o topo mediria o topo, não a ferramenta (Parte H).',
      '',
      'Compatível significa que o desfecho não contradisse a relação, o que NÃO é o mesmo',
      'que a relação existir. Este arquivo é justamente o que separa as duas coisas.',
      '',
      'Para cada linha, marque **certa**, **errada** ou **ambígua** na coluna `rótulo`.',
      'Ambígua é resposta válida, e a taxa de ambíguas é um número a reportar: se for alta,',
      'a taxonomia está mal desenhada, não o agente.',
      '',
      '| # | tipo | perguntas | justificativa | ressalva | confiança | rótulo |',
      '| --- | --- | --- | --- | --- | --- | --- |',
      ...sorteadas.map((c, i) => {
        const perguntas = c.relacao.mercados
          .map((r, k) => `${r}: ${(c.perguntas[k] ?? '').replace(/\|/g, '\\|')}`)
          .join('<br>');
        return `| ${i + 1} | \`${c.relacao.tipo}\` | ${perguntas} | ${c.relacao.justificativa.replace(/\|/g, '\\|')} | ${c.relacao.ressalvaDeResolucao?.replace(/\|/g, '\\|') ?? '—'} | ${num(c.relacao.confianca, 2)} | |`;
      }),
    ].join('\n');

    const { mkdir, writeFile } = await import('node:fs/promises');
    const { dirname } = await import('node:path');
    await mkdir(dirname(CSV_ROTULAGEM), { recursive: true });
    await writeFile(CSV_ROTULAGEM, `${md}\n`, 'utf8');
  }

  out.push(
    section('8. A AMOSTRA HUMANA — H1, e é o produto da spec'),
    `  sorteadas: ${sorteadas.length} relações COMPATÍVEIS, ao acaso, semente "${args.semente}"`,
    `  gravado em: ${CSV_ROTULAGEM}`,
    '',
    '  São as compatíveis, e não as refutadas, porque as refutadas já têm veredito',
    '  objetivo. O que precisa de olho humano é justamente o que o desfecho deixou',
    '  passar — a relação que não foi contradita pode simplesmente não existir.',
    '',
    '  Não rotulei nada: é H1, é trabalho humano, e é o que fecha a Parte I.',
  );

  console.log(out.join('\n'));
}

main().catch((err: unknown) => {
  console.error(`[${LABEL}] falhou:`, err instanceof Error ? err.message : String(err));
  process.exit(1);
});
