/**
 * Mede o idioma dos NOMES do código — arquivos, funções e tipos exportados —
 * quebrado por pasta.
 *
 * Existe porque a convenção de idioma do `CLAUDE.md` foi escrita em cima destes
 * números, e número sem comando que o refaça envelhece calado. `npm run
 * medir:idioma`.
 *
 * ## A armadilha que já custou uma medição errada
 *
 * Os dois dicionários do sistema são **UTF-8**. Lê-los como latin1 faz TODA
 * palavra acentuada falhar em silêncio — `contradição`, `frequência`,
 * `previsão`, `variação`, `preço` — enquanto as sem acento passam. O viés é de
 * uma direção só: subestima o português. A primeira rodada desta medição errou
 * exatamente assim, e por isso a leitura está fixada aqui com o encoding
 * explícito.
 *
 * ## Por que existem quatro baldes e não dois
 *
 * Forçar todo nome em "pt" ou "en" fabricaria precisão que a medição não tem:
 *
 * - `colisao` — o token está NOS DOIS dicionários. A wordlist inglesa carrega
 *   empréstimos (`mercado`, `dados`, `radar`, `total`, `base`), e no contexto
 *   deste código eles leem como português. Contá-los como inglês subestimaria;
 *   como português, exageraria.
 * - `jargao` — em nenhum dos dois: `supabase`, `polymarket`, `dedup`, `sha256`,
 *   e também palavras inventadas com cara de português (`Recolhivel`,
 *   `Veredicavel`), que dicionário nenhum tem.
 *
 * A distância entre `pt/total` e `pt/(pt+en)` é o tamanho da dúvida, e as duas
 * frações saem juntas por isso. Fração sem denominador é opinião — a mesma
 * regra que o gate de boilerplate aplica na tela.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, extname, join } from 'node:path';

const RAIZ = new URL('../..', import.meta.url).pathname;

/** As três camadas que a convenção separa. */
const PASTAS: Record<string, string> = {
  'src/': 'src',
  'scripts/': 'scripts',
  'web/': 'web/src',
};

const IGNORAR = new Set(['node_modules', 'dist', '.git']);

const DICIONARIOS = {
  pt: '/usr/share/dict/portuguese',
  en: '/usr/share/dict/american-english',
};

type Balde = 'pt' | 'en' | 'misto' | 'colisao' | 'jargao';

const semAcento = (s: string) => s.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();

function carregarDicionario(caminho: string): Set<string> {
  try {
    // UTF-8, explícito. Ver a armadilha no cabeçalho.
    return new Set(readFileSync(caminho, 'utf8').split('\n').map(semAcento).filter(Boolean));
  } catch {
    throw new Error(
      `Dicionário ausente: ${caminho}. Instale com ` +
        `\`sudo apt install wportuguese wamerican\` — sem os dois não há medição, ` +
        `e adivinhar o idioma de um nome é a impressão que este script existe para substituir.`,
    );
  }
}

function arquivosDe(dir: string, acc: string[] = []): string[] {
  for (const entrada of readdirSync(dir)) {
    if (IGNORAR.has(entrada)) continue;
    const caminho = join(dir, entrada);
    if (statSync(caminho).isDirectory()) arquivosDe(caminho, acc);
    else if (['.ts', '.tsx'].includes(extname(caminho))) acc.push(caminho);
  }
  return acc;
}

/** camelCase, kebab-case, snake_case e ponto, tudo em minúscula. */
function tokens(nome: string): string[] {
  return nome
    .split(/[-_.]|(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])/)
    .map(t => t.toLowerCase())
    .filter(Boolean);
}

/**
 * O inventário de UMA pasta: nome de arquivo, função exportada e tipo exportado.
 *
 * `export const X = (` entra como função; `export const X = 42` não — a
 * convenção fala de nomes de coisa, e uma constante de valor é outro debate.
 */
function inventario(dir: string) {
  const arquivos = new Set<string>();
  const funcoes = new Set<string>();
  const tipos = new Set<string>();

  for (const caminho of arquivosDe(dir)) {
    arquivos.add(basename(caminho).replace(/\.(test|d)?\.?tsx?$/, '').replace(/\.test$/, ''));
    // Comentário fora ANTES de procurar identificador. Sem isto o extrator lê a
    // própria documentação: um `export const X = (` citado dentro de um bloco
    // `/** */` entrava na contagem como se fosse função — foi o que este
    // arquivo fez consigo mesmo na primeira rodada. Linha `//` só quando começa
    // a linha, para não decepar `https://` dentro de string.
    const fonte = readFileSync(caminho, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    for (const m of fonte.matchAll(/export\s+(?:async\s+)?function\s+([A-Za-z0-9_]+)/g))
      funcoes.add(m[1] as string);
    for (const m of fonte.matchAll(
      /export\s+const\s+([A-Za-z0-9_]+)\s*(?::[^=\n]+)?=\s*(?:async\s*)?(?:<[^>]*>\s*)?\(/g,
    ))
      funcoes.add(m[1] as string);
    for (const m of fonte.matchAll(/export\s+(?:type|interface|enum)\s+([A-Za-z0-9_]+)/g))
      tipos.add(m[1] as string);
  }

  return { arquivos: [...arquivos], funcoes: [...funcoes], tipos: [...tipos] };
}

function medir() {
  const PT = carregarDicionario(DICIONARIOS.pt);
  const EN = carregarDicionario(DICIONARIOS.en);

  const doToken = (t: string) => {
    const pt = PT.has(t);
    const en = EN.has(t);
    if (pt && !en) return 'pt';
    if (en && !pt) return 'en';
    return pt && en ? 'ambos' : 'nenhum';
  };

  const doNome = (nome: string): Balde => {
    const ls = tokens(nome).map(doToken);
    if (ls.includes('pt') && ls.includes('en')) return 'misto';
    if (ls.includes('pt')) return 'pt';
    if (ls.includes('en')) return 'en';
    return ls.includes('ambos') ? 'colisao' : 'jargao';
  };

  const p = (s: unknown, n: number) => String(s).padStart(n);
  console.log('pasta    tipo       total     pt     en  misto colisao jargao   pt/total  pt/(pt+en)');

  const agregado: Record<string, Record<Balde | 'total', number>> = {};

  for (const [rotulo, sub] of Object.entries(PASTAS)) {
    const inv = inventario(join(RAIZ, sub));
    agregado[rotulo] = { pt: 0, en: 0, misto: 0, colisao: 0, jargao: 0, total: 0 };

    for (const [tipo, lista] of Object.entries(inv)) {
      const c: Record<Balde, number> = { pt: 0, en: 0, misto: 0, colisao: 0, jargao: 0 };
      for (const nome of lista) c[doNome(nome)]++;

      const total = lista.length;
      const a = agregado[rotulo] as Record<Balde | 'total', number>;
      for (const k of Object.keys(c) as Balde[]) a[k] += c[k];
      a.total += total;

      console.log(
        rotulo.padEnd(9) + tipo.padEnd(10) + p(total, 6) + p(c.pt, 7) + p(c.en, 7) +
          p(c.misto, 7) + p(c.colisao, 8) + p(c.jargao, 7) +
          p(fracao(c.pt, total), 11) + p(fracao(c.pt, c.pt + c.en), 12),
      );
    }
  }

  console.log('');
  for (const [rotulo, a] of Object.entries(agregado))
    console.log(
      rotulo.padEnd(9) + 'AGREGADO  ' + p(a.total, 6) + p(a.pt, 7) + p(a.en, 7) + p(a.misto, 7) +
        p(a.colisao, 8) + p(a.jargao, 7) +
        p(fracao(a.pt, a.total), 11) + p(fracao(a.pt, a.pt + a.en), 12),
    );

  console.log(
    '\nAs duas frações saem juntas de propósito: `pt/total` conta colisão e jargão\n' +
      'como não-português, `pt/(pt+en)` os ignora. A verdade está entre as duas, e a\n' +
      'distância entre elas é o tamanho da dúvida naquela pasta.',
  );
}

/** Fração sempre com o denominador visível. Zero sobre zero é `—`, não `0%`. */
function fracao(parte: number, todo: number): string {
  return todo === 0 ? '—' : `${((100 * parte) / todo).toFixed(1)}%`;
}

medir();
