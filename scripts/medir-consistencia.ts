import { basename, join } from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { section, table } from './lib/probe-net.js';

/**
 * A consistência da digestão, medida de graça.
 *
 * O artefato de `probes/digest/*.json` traz o hash do texto da regra em cada
 * digestão. Mercados diferentes com o MESMO hash receberam a mesma regra, byte a
 * byte — e a saída do modelo para eles deveria ser a mesma. Onde não é, o que se
 * mede é instabilidade.
 *
 * **Nada é chamado e nada é gravado.** Só lê o `.json` (as digestões) e o `.md`
 * irmão (o slug e o texto íntegro da regra, que o `.json` não guarda). Custo:
 * zero. Por isso esta medida pode rodar quantas vezes quiser, inclusive antes de
 * decidir se vale pagar por uma passada nova.
 *
 *   npm run medir-consistencia
 *   npm run medir-consistencia -- --arquivo=probes/digest/degrau-3-v4.json
 *
 * ## A ressalva, que é parte da medida e não rodapé
 *
 * A chamada de digestão recebe `question`, `outcomes` e `slug` além da
 * `description`. Mercados do mesmo grupo têm a mesma REGRA e perguntas
 * diferentes — então parte da divergência é o modelo respondendo a um prompt de
 * fato diferente, não temperatura. O número aqui é TETO de instabilidade.
 *
 * O que a ressalva não cobre é a conferência de contradição interna lá embaixo:
 * ali se pergunta se os dois trechos citados existem no texto da regra, e o
 * texto é o mesmo para o grupo inteiro por construção. Essa parte não depende da
 * pergunta.
 */

const LABEL = 'medir-consistencia';
const OUT_DIR = 'probes/digest';
const ARQUIVO_PADRAO = 'probes/digest/degrau-3-v4.json';

interface Args {
  arquivo: string;
}

function parseArgs(argv: readonly string[]): Args | { error: string } {
  const args: Args = { arquivo: ARQUIVO_PADRAO };
  for (const arg of argv) {
    const match = /^--arquivo=(.+)$/.exec(arg);
    if (match === null || match[1] === undefined) return { error: `argumento desconhecido: ${arg}` };
    args.arquivo = match[1];
  }
  return args;
}

// ---------------------------------------------------------------------------
// O artefato
// ---------------------------------------------------------------------------

interface Pegadinha {
  severidade: string;
  trecho: string;
}

interface Ambiguidade {
  tipo: string;
  trecho: string;
  trecho_conflito: string | null;
  leitura_a: string;
  leitura_b: string;
}

interface Entrada {
  digest: {
    event_id: string;
    description_sha256: string;
    resolve_sim: string[];
  };
  pegadinhas: Pegadinha[];
  ambiguidades: Ambiguidade[];
}

function ehEntrada(entry: unknown): entry is Entrada {
  return typeof entry === 'object' && entry !== null && 'digest' in entry;
}

/**
 * O que o `.md` tem e o `.json` não: slug e o texto íntegro da regra.
 *
 * A regex casa o bloco inteiro de um mercado — o `<sub>` com slug e hash, e o
 * fence com a descrição. `[\s\S]*?` é preguiçoso de propósito: com `.*` ela
 * atravessaria para o mercado seguinte e colaria a regra errada no slug certo.
 */
interface BlocoMd {
  slug: string;
  hash12: string;
  caracteres: number;
  regra: string;
  sim: string;
}

const BLOCO =
  /<sub>`([^`]+)`[^`]*·\s*hash `([0-9a-f]+)`\s*·\s*(\d+) caracteres de regra<\/sub>\s*\n\n<details><summary>a regra, íntegra<\/summary>\s*\n\n```\n([\s\S]*?)\n```[\s\S]*?\*\*Resolve SIM:\*\*\s*\n\n- ([^\n]+)/g;

function lerMd(texto: string): BlocoMd[] {
  return [...texto.matchAll(BLOCO)].map(m => ({
    slug: m[1] ?? '',
    hash12: m[2] ?? '',
    caracteres: Number(m[3] ?? '0'),
    regra: m[4] ?? '',
    sim: (m[5] ?? '').trim(),
  }));
}

/**
 * O casamento entre digestão e bloco do `.md`.
 *
 * Nem por hash (um hash cobre dezenas de mercados — é o que se está medindo),
 * nem por posição (o `.md` sai em outra ordem que o `.json`). A chave é hash +
 * primeira linha do "Resolve SIM", que é onde o nome da entidade aparece. Cada
 * casamento é consumido: dois mercados com saída literalmente igual não roubam o
 * slug um do outro — ficam sem slug, e o relatório diz quantos ficaram.
 */
function casar(entradas: readonly Entrada[], blocos: readonly BlocoMd[]): Map<string, BlocoMd> {
  const fila = new Map<string, BlocoMd[]>();
  for (const b of blocos) {
    const k = `${b.hash12}|${b.sim}`;
    const lista = fila.get(k);
    if (lista === undefined) fila.set(k, [b]);
    else lista.push(b);
  }

  const porEvento = new Map<string, BlocoMd>();
  for (const e of entradas) {
    const k = `${e.digest.description_sha256.slice(0, 12)}|${(e.digest.resolve_sim[0] ?? '').trim()}`;
    const lista = fila.get(k);
    const bloco = lista?.shift();
    if (bloco !== undefined) porEvento.set(e.digest.event_id, bloco);
  }
  return porEvento;
}

// ---------------------------------------------------------------------------
// A medida
// ---------------------------------------------------------------------------

interface Grupo {
  hash: string;
  membros: Entrada[];
  divPeg: boolean;
  divAmb: boolean;
  divTipos: boolean;
  divSev: boolean;
}

const uniq = (xs: readonly string[]): string[] => [...new Set(xs)].sort();
const uniqN = (xs: readonly number[]): number[] => [...new Set(xs)].sort((a, b) => a - b);

function agrupar(entradas: readonly Entrada[]): Map<string, Entrada[]> {
  const grupos = new Map<string, Entrada[]>();
  for (const e of entradas) {
    const h = e.digest.description_sha256;
    const lista = grupos.get(h);
    if (lista === undefined) grupos.set(h, [e]);
    else lista.push(e);
  }
  return grupos;
}

function analisar(grupos: Map<string, Entrada[]>): Grupo[] {
  return [...grupos.entries()]
    .filter(([, membros]) => membros.length >= 2)
    .map(([hash, membros]) => ({
      hash,
      membros,
      divPeg: uniqN(membros.map(m => m.pegadinhas.length)).length > 1,
      divAmb: uniqN(membros.map(m => m.ambiguidades.length)).length > 1,
      divTipos: uniq(membros.map(m => uniq(m.ambiguidades.map(a => a.tipo)).join('+'))).length > 1,
      divSev: uniq(membros.map(m => uniq(m.pegadinhas.map(p => p.severidade)).join('+'))).length > 1,
    }));
}

const divergiu = (g: Grupo): boolean => g.divPeg || g.divAmb || g.divTipos;

// ---------------------------------------------------------------------------
// Recall ou precisão: a conferência da contradição interna
// ---------------------------------------------------------------------------

/**
 * Nos grupos em que `contradicao_interna` apareceu em uns membros e não em
 * outros, a pergunta é qual dos dois lados errou.
 *
 * O teste: os dois trechos citados pelo membro que ACUSOU existem literalmente
 * no texto da regra? O texto é o mesmo para o grupo inteiro — é o critério do
 * agrupamento —, então "existe no texto de quem não acusou" e "existe no texto"
 * são a mesma pergunta. Se existem, quem não acusou tinha as duas passagens na
 * frente e não as ligou: falha de RECALL, e a lista das 21 contradições
 * continua válida, só incompleta. Se não existem, o modelo citou o que não
 * estava lá: falha de PRECISÃO, e a lista precisa ser reconferida inteira.
 *
 * A comparação normaliza espaço em branco porque o modelo reescreve quebra de
 * linha ao citar; NÃO normaliza aspas nem travessão, porque trocar `’` por `'`
 * já seria o modelo alterando o texto — e é exatamente isso que se quer detectar.
 * As duas contagens saem separadas.
 */
const norm = (s: string): string => s.replace(/\s+/g, ' ').trim();

type Achado = 'literal' | 'espacamento' | 'ausente';

function achar(trecho: string | null, regra: string): Achado {
  if (trecho === null || trecho.trim().length === 0) return 'ausente';
  if (regra.includes(trecho)) return 'literal';
  if (norm(regra).includes(norm(trecho))) return 'espacamento';
  return 'ausente';
}

interface Conferencia {
  hash: string;
  slugAcusador: string;
  tamanhoGrupo: number;
  acusaram: number;
  naoAcusaram: number;
  trecho: Achado;
  conflito: Achado;
  temConflito: boolean;
}

function conferirContradicoes(
  analise: readonly Grupo[],
  regraPorHash: Map<string, string>,
  md: Map<string, BlocoMd>,
): Conferencia[] {
  const fora: Conferencia[] = [];

  for (const g of analise) {
    const acusadores = g.membros.filter(m =>
      m.ambiguidades.some(a => a.tipo === 'contradicao_interna'),
    );
    // só os grupos DIVIDIDOS: uns acusaram, outros não
    if (acusadores.length === 0 || acusadores.length === g.membros.length) continue;

    // A regra vem por HASH, não pelo bloco daquele mercado: ela é idêntica para
    // o grupo inteiro por construção. Fazer a conferência depender do casamento
    // de slug perderia a acusação de todo mercado sem slug resolvido — e perdeu:
    // um grupo dividido inteiro sumia da conta por causa de um rótulo. O slug é
    // só etiqueta aqui, e etiqueta que falta não pode derrubar a medida.
    const regra = regraPorHash.get(g.hash.slice(0, 12));
    if (regra === undefined) continue;

    for (const acusador of acusadores) {
      for (const a of acusador.ambiguidades.filter(x => x.tipo === 'contradicao_interna')) {
        fora.push({
          hash: g.hash.slice(0, 12),
          slugAcusador: md.get(acusador.digest.event_id)?.slug ?? `event=${acusador.digest.event_id}`,
          tamanhoGrupo: g.membros.length,
          acusaram: acusadores.length,
          naoAcusaram: g.membros.length - acusadores.length,
          trecho: achar(a.trecho, regra),
          conflito: achar(a.trecho_conflito, regra),
          temConflito: a.trecho_conflito !== null && a.trecho_conflito.trim().length > 0,
        });
      }
    }
  }

  return fora;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

function pct(a: number, b: number): string {
  return b === 0 ? '—' : `${((a / b) * 100).toFixed(1)}%`;
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  if ('error' in parsed) {
    console.error(`[${LABEL}] ${parsed.error}`);
    console.error(`  uso: npm run medir-consistencia -- [--arquivo=CAMINHO]`);
    process.exit(1);
    return;
  }

  const caminhoMd = parsed.arquivo.replace(/\.json$/, '.md');
  const raw = JSON.parse(await readFile(parsed.arquivo, 'utf8')) as unknown[];
  const entradas = raw.filter(ehEntrada);
  const blocos = lerMd(await readFile(caminhoMd, 'utf8'));
  const md = casar(entradas, blocos);

  // O `.md` declara o tamanho da regra. Conferir contra o que a regex extraiu é
  // o que separa "a citação não está no texto" de "eu li o texto errado".
  const truncados = blocos.filter(b => b.regra.length !== b.caracteres);

  // A regra por hash, com a premissa do agrupamento conferida em vez de
  // assumida: se dois blocos com o mesmo hash tivessem texto diferente, o
  // agrupamento inteiro estaria errado e toda a medida abaixo seria ficção.
  const regraPorHash = new Map<string, string>();
  const colisoes: string[] = [];
  for (const b of blocos) {
    const anterior = regraPorHash.get(b.hash12);
    if (anterior === undefined) regraPorHash.set(b.hash12, b.regra);
    else if (anterior !== b.regra) colisoes.push(b.hash12);
  }
  if (colisoes.length > 0) {
    console.error(`[${LABEL}] hash com textos diferentes: ${uniq(colisoes).join(', ')}`);
    console.error('  o agrupamento por hash não vale para este artefato.');
    process.exit(1);
    return;
  }

  const grupos = agrupar(entradas);
  const analise = analisar(grupos);
  const divergentes = analise.filter(divergiu);
  const emGrupos = analise.reduce((n, g) => n + g.membros.length, 0);

  let naModa = 0;
  for (const g of analise) {
    const c = new Map<string, number>();
    for (const m of g.membros) {
      const k = `${m.pegadinhas.length}/${m.ambiguidades.length}`;
      c.set(k, (c.get(k) ?? 0) + 1);
    }
    naModa += Math.max(...c.values());
  }

  console.log(section(`Consistência da digestão — ${parsed.arquivo}`));
  console.log(
    table(
      ['medida', 'valor'],
      [
        ['digestões no artefato', String(entradas.length)],
        ['slug e regra casados', `${md.size} (${pct(md.size, entradas.length)})`],
        ['blocos do .md com regra truncada', String(truncados.length)],
        ['textos de regra distintos', String(grupos.size)],
        ['grupos com 2+ mercados', String(analise.length)],
        ['mercados nesses grupos', `${emGrupos} (${pct(emGrupos, entradas.length)})`],
        ['grupos com saída divergente', `${divergentes.length} (${pct(divergentes.length, analise.length)})`],
        ['  divergiu no nº de pegadinhas', String(analise.filter(g => g.divPeg).length)],
        ['  divergiu no nº de ambiguidades', String(analise.filter(g => g.divAmb).length)],
        ['  divergiu nos tipos de ambiguidade', String(analise.filter(g => g.divTipos).length)],
        ['  divergiu nas severidades', String(analise.filter(g => g.divSev).length)],
        ['mercados com a saída modal do grupo', `${naModa} (${pct(naModa, emGrupos)})`],
      ],
      [0],
    ),
  );

  // volatilidade por tipo
  const tipos = uniq(entradas.flatMap(e => e.ambiguidades.map(a => a.tipo)));
  const volat = tipos
    .map(t => {
      let todos = 0;
      let alguns = 0;
      for (const g of analise) {
        const com = g.membros.filter(m => m.ambiguidades.some(a => a.tipo === t)).length;
        if (com === g.membros.length) todos += 1;
        else if (com > 0) alguns += 1;
      }
      return { t, todos, alguns };
    })
    .sort((a, b) => b.alguns - a.alguns);

  console.log(section('Volatilidade por tipo de ambiguidade'));
  console.log('  "em alguns" = o tipo apareceu em parte dos mercados que receberam a MESMA regra.');
  console.log(
    table(
      ['tipo', 'em todos', 'em alguns'],
      volat.map(v => [v.t, String(v.todos), String(v.alguns)]),
      [0],
    ),
  );

  // a conferência
  const conf = conferirContradicoes(analise, regraPorHash, md);
  const gruposDivididos = new Set(conf.map(c => c.hash));
  const literalOuEspaco = (a: Achado): boolean => a === 'literal' || a === 'espacamento';
  const ambosNoTexto = conf.filter(
    c => literalOuEspaco(c.trecho) && (!c.temConflito || literalOuEspaco(c.conflito)),
  );
  const algumFora = conf.filter(c => !literalOuEspaco(c.trecho) || (c.temConflito && !literalOuEspaco(c.conflito)));

  console.log(section('Contradição interna: recall ou precisão?'));
  console.log('  Só os grupos DIVIDIDOS — uns membros acusaram contradição, outros não.');
  console.log('  O texto da regra é o mesmo para o grupo inteiro (é o critério do agrupamento),');
  console.log('  então "existe no texto de quem não acusou" = "existe no texto".');
  console.log(
    table(
      ['medida', 'valor'],
      [
        ['grupos divididos', String(gruposDivididos.size)],
        ['acusações conferidas', String(conf.length)],
        ['  com trecho_conflito citado', String(conf.filter(c => c.temConflito).length)],
        ['ambos os trechos no texto → RECALL', `${ambosNoTexto.length} (${pct(ambosNoTexto.length, conf.length)})`],
        ['    casamento literal', String(ambosNoTexto.filter(c => c.trecho === 'literal' && (!c.temConflito || c.conflito === 'literal')).length)],
        ['    só depois de normalizar espaço', String(ambosNoTexto.length - ambosNoTexto.filter(c => c.trecho === 'literal' && (!c.temConflito || c.conflito === 'literal')).length)],
        ['algum trecho fora do texto → PRECISÃO', `${algumFora.length} (${pct(algumFora.length, conf.length)})`],
      ],
      [0],
    ),
  );

  if (algumFora.length > 0) {
    console.log('\n  As acusações cujo trecho não está no texto:');
    for (const c of algumFora.slice(0, 20)) {
      console.log(
        `    ${c.slugAcusador}  hash ${c.hash}  trecho=${c.trecho} conflito=${c.temConflito ? c.conflito : '(não citado)'}`,
      );
    }
    if (algumFora.length > 20) console.log(`    ... e mais ${algumFora.length - 20}.`);
  }

  const destino = join(OUT_DIR, `consistencia-${basename(parsed.arquivo, '.json')}.md`);
  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(
    destino,
    render(parsed.arquivo, entradas.length, grupos.size, analise, divergentes, emGrupos, naModa, volat, conf, ambosNoTexto, algumFora, md),
    'utf8',
  );
  console.log(`\n  relatório: ${destino}`);
}

function render(
  arquivo: string,
  nEntradas: number,
  nTextos: number,
  analise: readonly Grupo[],
  divergentes: readonly Grupo[],
  emGrupos: number,
  naModa: number,
  volat: ReadonlyArray<{ t: string; todos: number; alguns: number }>,
  conf: readonly Conferencia[],
  ambosNoTexto: readonly Conferencia[],
  algumFora: readonly Conferencia[],
  md: Map<string, BlocoMd>,
): string {
  const linhas: string[] = [
    `# Consistência da digestão: \`${arquivo}\``,
    '',
    'Medida sem chamar modelo e sem tocar no banco: só o `.json` do artefato e o',
    '`.md` irmão. Mercados com o mesmo hash receberam a mesma regra, byte a byte.',
    '',
    '**Ressalva:** a digestão recebe `question` e `outcomes` além da `description`.',
    'Mercados do mesmo grupo têm a mesma REGRA e perguntas diferentes: parte da',
    'divergência é prompt diferente, não temperatura. Isto é TETO de instabilidade.',
    '',
    '| medida | valor |',
    '| --- | ---: |',
    `| digestões | ${nEntradas} |`,
    `| textos de regra distintos | ${nTextos} |`,
    `| grupos com 2+ mercados | ${analise.length} |`,
    `| mercados nesses grupos | ${emGrupos} (${pct(emGrupos, nEntradas)}) |`,
    `| grupos com saída divergente | ${divergentes.length} (${pct(divergentes.length, analise.length)}) |`,
    `| mercados com a saída modal do grupo | ${naModa} (${pct(naModa, emGrupos)}) |`,
    '',
    '## Volatilidade por tipo de ambiguidade',
    '',
    '| tipo | em todos os membros | em ALGUNS |',
    '| --- | ---: | ---: |',
    ...volat.map(v => `| \`${v.t}\` | ${v.todos} | ${v.alguns} |`),
    '',
    '## Contradição interna: recall ou precisão?',
    '',
    'Só os grupos divididos. Se os dois trechos citados existem no texto, quem não',
    'acusou tinha as passagens na frente e não as ligou: falha de recall, e a lista',
    'de contradições segue válida, só incompleta.',
    '',
    '| medida | valor |',
    '| --- | ---: |',
    `| acusações conferidas | ${conf.length} |`,
    `| ambos os trechos no texto → recall | ${ambosNoTexto.length} (${pct(ambosNoTexto.length, conf.length)}) |`,
    `| algum trecho fora do texto → precisão | ${algumFora.length} (${pct(algumFora.length, conf.length)}) |`,
    '',
    '## Os grupos divergentes, do maior para o menor',
    '',
  ];

  for (const g of [...divergentes].sort((a, b) => b.membros.length - a.membros.length)) {
    linhas.push(
      `### hash \`${g.hash.slice(0, 12)}\`: ${g.membros.length} mercados`,
      '',
      '| pegadinhas | ambiguidades | mercado |',
      '| ---: | ---: | --- |',
      ...g.membros.map(
        m =>
          `| ${m.pegadinhas.length} | ${m.ambiguidades.length} | ${md.get(m.digest.event_id)?.slug ?? m.digest.event_id} |`,
      ),
      '',
    );
  }

  return linhas.join('\n') + '\n';
}

main().catch((err: unknown) => {
  console.error(`[${LABEL}]`, err);
  process.exit(1);
});
