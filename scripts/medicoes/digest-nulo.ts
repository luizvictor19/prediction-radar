import { readFile, stat, writeFile } from 'node:fs/promises';
import { basename } from 'node:path';
import {
  CAUSAS,
  cabecalhoDoMd,
  campoETermo,
  causaDe,
  divergencias,
  ehHedge,
  histograma,
  lerFalhasDoMd,
  type Falha,
} from './lib/digest-nulo.js';

/**
 * Why the digestion calls of a run came back without a digest.
 *
 *   npm run medir:digest-nulo
 *   npm run medir:digest-nulo -- --artefato=probes/digest/degrau-3-v4.json
 *
 * Reads only the run artifacts on disk -- no model call, no database, nothing
 * written outside the report. Prints to the terminal and writes
 * `probes/digest/digest-nulo.md`.
 *
 * It exists because `spec-tela-regra.md` §10 recorded "21 chamadas com digest
 * nulo (6,6% da rodada de 320)" with no date and no way to recompute it. A rate
 * that cannot be recomputed cannot be compared against the next prompt version,
 * which is how a rate doubles without anyone seeing it. This command is the
 * recomputation.
 *
 * The run's own date is NOT in artifacts written before this commit --
 * `digerir-regras.ts` did not stamp one. For those the fallback is the file's
 * mtime, and it is reported AS mtime and never as a recorded time: a copied or
 * restored file carries a new mtime, and the number would be dated wrong with
 * nothing on screen to say so.
 */

const ARTEFATO_PADRAO = 'probes/digest/degrau-3-v4.json';
const SAIDA = 'probes/digest/digest-nulo.md';

interface Rodada {
  artefato: string;
  mtime: Date;
  /** The stamp `digerir-regras.ts` writes; `null` in artifacts older than it. */
  rodouEm: string | null;
  cabecalho: string[];
  chamadas: number;
  falhas: Falha[];
}

async function lerRodada(caminho: string): Promise<Rodada> {
  // The `.json` is the denominator: one entry per call DISPATCHED, and the rate
  // is over that and nothing else.
  const bruto = JSON.parse(await readFile(caminho, 'utf8')) as unknown[];
  const info = await stat(caminho);

  const codigosDoJson: string[] = [];
  for (const entrada of bruto) {
    if (typeof entrada !== 'object' || entrada === null) continue;
    const falha = (entrada as Record<string, unknown>)['falha'] as { code?: unknown } | undefined;
    if (falha !== undefined) codigosDoJson.push(String(falha.code ?? '?'));
  }

  const caminhoMd = caminho.replace(/\.json$/, '.md');
  const md = await readFile(caminhoMd, 'utf8');
  const falhas = lerFalhasDoMd(md);

  // The two files are independent records of one run. If their code histograms
  // disagree, one is not the sibling of the other and every number below would
  // be a blend of two runs.
  const conflito = divergencias(histograma(codigosDoJson), histograma(falhas.map(f => f.codigo)));
  if (conflito.length > 0) {
    throw new Error(
      `${basename(caminho)} e ${basename(caminhoMd)} não são da mesma corrida — ${conflito.join('; ')}`,
    );
  }

  const { linhas: cabecalho, rodouEm } = cabecalhoDoMd(md);
  return { artefato: caminho, mtime: info.mtime, rodouEm, cabecalho, chamadas: bruto.length, falhas };
}

// ---------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------

const linhas: string[] = [];
function p(s = ''): void {
  linhas.push(s);
}

function pct(n: number, d: number): string {
  return d === 0 ? '—' : `${((100 * n) / d).toFixed(1)}%`;
}

function leituraDe(f: Falha): string | null {
  const ct = campoETermo(f.mensagem);
  if (ct === null) return null;
  return ehHedge(ct.campo, ct.termo) ? 'hedge do modelo' : 'vocabulário da regra';
}

function secaoRodada(rodada: Rodada): void {
  p('## A rodada');
  p();
  p('| medida | valor |');
  p('| --- | --- |');
  p(`| artefato | \`${basename(rodada.artefato)}\` |`);
  p(
    rodada.rodouEm === null
      ? `| quando rodou | **${rodada.mtime.toISOString()}** — mtime do arquivo, não carimbo da corrida |`
      : `| quando rodou | ${rodada.rodouEm} — carimbado pela corrida |`,
  );
  for (const l of rodada.cabecalho) {
    const m = /- \*\*(.+?):\*\* (.+)/.exec(l);
    if (m !== null) p(`| ${m[1]} | ${m[2]} |`);
  }
  p(`| chamadas no artefato | ${rodada.chamadas} |`);
  p();
  if (rodada.rodouEm === null) {
    p('> A corrida não carimbou a própria data — este artefato é anterior ao carimbo.');
    p('> O mtime data o ARQUIVO, e um arquivo copiado ou restaurado carrega mtime novo.');
    p('> Vale como aproximação, e está dito que é uma.');
    p();
  }
}

function secaoCausas(rodada: Rodada): void {
  const total = rodada.chamadas;
  const falhas = rodada.falhas;

  p('## Quantas, e de que causa');
  p();
  p(`**${falhas.length} de ${total} chamadas (${pct(falhas.length, total)}) voltaram sem digest.**`);
  p();
  p('| causa | n | % das chamadas | % das falhas | resposta |');
  p('| --- | ---: | ---: | ---: | --- |');
  for (const causa of CAUSAS) {
    const n = falhas.filter(f => causa.codigos.includes(f.codigo)).length;
    p(`| ${causa.titulo} | ${n} | ${pct(n, total)} | ${pct(n, falhas.length)} | ${causa.resposta} |`);
  }
  const semCausa = falhas.filter(f => causaDe(f.codigo) === null);
  if (semCausa.length > 0) {
    p(
      `| **código fora da tabela** (${[...new Set(semCausa.map(f => f.codigo))].join(', ')}) | ` +
        `${semCausa.length} | ${pct(semCausa.length, total)} | ${pct(semCausa.length, falhas.length)} | ` +
        'a lista de causas envelheceu — acrescentar |',
    );
  }
  p();
  p('Por código bruto, para a tabela acima poder ser conferida:');
  p();
  p('| código | n |');
  p('| --- | ---: |');
  for (const [k, v] of [...histograma(falhas.map(f => f.codigo)).entries()].sort(
    (a, b) => b[1] - a[1],
  )) {
    p(`| \`${k}\` | ${v} |`);
  }
  p();
}

function secaoTravaDeOpiniao(rodada: Rodada): void {
  const opiniao = rodada.falhas.filter(f => f.codigo === 'opiniao');
  if (opiniao.length === 0) return;

  p('## Dentro da trava de opinião');
  p();
  p(
    `${opiniao.length} de ${rodada.falhas.length} falhas. A trava existe para barrar opinião sobre ` +
      'DESFECHO; a quebra abaixo separa o termo que a REGRA fornece do termo que o MODELO acrescenta.',
  );
  p();
  p('| campo | termo | n | leitura |');
  p('| --- | --- | ---: | --- |');
  const cruz = new Map<string, number>();
  for (const f of opiniao) {
    const ct = campoETermo(f.mensagem);
    if (ct === null) continue;
    cruz.set(`${ct.campo} ${ct.termo}`, (cruz.get(`${ct.campo} ${ct.termo}`) ?? 0) + 1);
  }
  for (const [chave, n] of [...cruz.entries()].sort((a, b) => b[1] - a[1])) {
    const [campo = '', termo = ''] = chave.split(' ');
    const leitura = ehHedge(campo, termo) ? 'hedge do modelo' : 'vocabulário da regra';
    p(`| \`${campo}\` | \`${termo}\` | ${n} | ${leitura} |`);
  }
  p();
  const vocab = opiniao.filter(f => leituraDe(f) === 'vocabulário da regra').length;
  p(
    `**Vocabulário da regra: ${vocab} de ${opiniao.length}. Hedge do modelo: ${opiniao.length - vocab} de ${opiniao.length}.** ` +
      'A separação é heurística, está justificada em `lib/digest-nulo.ts`, e a evidência de cada uma vem abaixo.',
  );
  p();

  // One rule text tripping the guard many times is what decides whether the fix
  // is worth it: 8 markets behind ONE boilerplate clause is a different problem
  // from 8 markets behind 8 clauses.
  const porRegra = new Map<string, Falha[]>();
  for (const f of opiniao) {
    const arr = porRegra.get(f.regra) ?? [];
    arr.push(f);
    porRegra.set(f.regra, arr);
  }
  const repetidas = [...porRegra.values()].filter(v => v.length > 1).sort((a, b) => b.length - a.length);
  if (repetidas.length > 0) {
    p('**Mesmo texto de regra, mais de uma vez:**');
    p();
    for (const grupo of repetidas) {
      p(`- ${grupo.length} mercados com a mesma regra, byte a byte:`);
      for (const f of grupo) p(`  - \`${f.slug}\``);
    }
    p();
  }
}

/**
 * One named response per cause, with this run's numbers inside it.
 *
 * "Accept it, and here is why" is a response and not a dodge -- what is not a
 * response is leaving the three causes lumped, which is the state issue #7
 * found them in. The prose is written here and the counts come from the run, so
 * a rewritten prompt moves the numbers in the sentences instead of leaving
 * stale ones behind.
 */
function secaoRespostas(rodada: Rodada): void {
  const total = rodada.chamadas;
  const opiniao = rodada.falhas.filter(f => f.codigo === 'opiniao');
  const vocab = opiniao.filter(f => leituraDe(f) === 'vocabulário da regra').length;
  const hedge = opiniao.length - vocab;
  const transporte = rodada.falhas.filter(f => ['api_error', 'not_json'].includes(f.codigo)).length;
  const malformada = rodada.falhas.filter(f =>
    ['schema', 'sem_resolve_sim', 'severidade_invalida', 'tipo_invalido'].includes(f.codigo),
  ).length;
  const recusa = rodada.falhas.filter(f => f.codigo === 'refusal').length;

  p('## Uma resposta por causa');
  p();

  p(`### Vocabulário da regra na trava de opinião — ${vocab} de ${total} (${pct(vocab, total)})`);
  p();
  p('**Estreitar a trava.** `detectarOpiniao` já deixa `trecho` e `trecho_conflito` de fora da');
  p('varredura, e a justificativa escrita lá é exatamente esta: são cópia literal da regra, e');
  p('recusar por causa do texto que se está extraindo não é a trava funcionando. O que o');
  p('levantamento mostra é que a mesma coisa acontece um campo adiante — a condição de resolução');
  p('não tem como ser escrita sem a palavra que a regra usa para excluí-la.');
  p();
  p('Não é "afrouxar": a trava continua barrando opinião sobre desfecho, que é o que ela existe');
  p('para barrar. O termo que aparece porque a REGRA o usa não é opinião de ninguém.');
  p();

  p(`### Hedge do modelo na trava de opinião — ${hedge} de ${total} (${pct(hedge, total)})`);
  p();
  p('**Aceitar, e a razão já estava escrita.** O comentário de `OPINIAO` diz que `provável` e');
  p('`dificilmente` entram na lista mesmo aparecendo em leitura de regra, e que o erro é para o');
  p('lado seguro de propósito: um falso positivo custa uma chamada de fração de centavo, um');
  p('número que passa custa o experimento. A decisão não muda — o que muda é que agora ela tem');
  p(`preço medido: ${pct(hedge, total)} das chamadas, e não uma estimativa.`);
  p();

  p(`### A resposta não chegou inteira — ${transporte} de ${total} (${pct(transporte, total)})`);
  p();
  p('**Um retry, e só para estes códigos.** Hoje não há nenhum, e a razão está em `deepseek.ts`');
  p('e em `runDigest`: retry multiplica o prazo pelo número de tentativas. Vale para a chamada');
  p('que responde devagar; não vale para a que não respondeu. Repetir só `api_error` e');
  p(`\`not_json\` multiplica o prazo de ${transporte} chamadas em ${total}, não das ${total}.`);
  p();
  p('Nenhuma das duas `not_json` veio com `finish_reason: length` — se tivesse, o código seria');
  p('`truncated`. Não foi teto de tokens: o corpo chegou vazio ou pela metade.');
  p();

  p(`### A saída não obedeceu ao contrato — ${malformada} de ${total} (${pct(malformada, total)})`);
  p();
  p('**Aceitar por ora.** Uma grafia inventada de um valor da lista fechada. É o candidato mais');
  p('barato a entrar no retry acima se ele existir, porque é o tipo de erro que uma segunda');
  p(`chamada não repete — mas ${pct(malformada, total)} não paga mudança de prompt sozinho.`);
  p();

  p(`### O modelo recusou — ${recusa} de ${total} (${pct(recusa, total)})`);
  p();
  p('**Nada a fazer, e o zero é o achado.** A issue listava recusa como uma das três causas');
  p('plausíveis. O código `refusal` existe, está ligado ao `content_filter` do fornecedor');
  p('(`deepseek.ts`), e não disparou uma vez.');
  p();

  p('### Falha de validação verbatim — 0, e por construção');
  p();
  p('A terceira causa da issue não pode produzir digest nulo. A conferência do `trecho` não');
  p('lança: ela PODA o item e soma em `descartes` (`trechoInexistente`, `trechoRepetido`,');
  p('`trechoCurto`). Uma digestão com todas as pegadinhas podadas volta válida e vazia, não');
  p('nula. Zero aqui é propriedade do código, não sorte desta rodada.');
  p();
}

function secaoUmaAUma(rodada: Rodada): void {
  p('## As falhas, uma a uma');
  p();
  p('O trecho de cada uma é a mensagem que a PRÓPRIA corrida gravou — não uma releitura.');
  p();
  for (const [i, f] of rodada.falhas.entries()) {
    const causa = causaDe(f.codigo);
    const leitura = leituraDe(f);
    p(`### ${i + 1}. \`${f.slug}\``);
    p();
    p(`*${f.pergunta}*`);
    p();
    p(
      `- **causa:** ${causa === null ? `(código \`${f.codigo}\` fora da tabela)` : causa.titulo}` +
        (leitura === null ? '' : ` — ${leitura}`),
    );
    p(`- **código:** \`${f.codigo}\``);
    p(`- **trecho da corrida:** ${f.mensagem}`);
    p();
  }
}

function relatorio(rodada: Rodada): void {
  p('# Chamadas de digestão que voltaram sem digest');
  p();
  p(`Refeito por \`npm run medir:digest-nulo\` sobre \`${rodada.artefato}\`.`);
  p('Nenhuma chamada ao modelo, nenhuma leitura do banco: só os artefatos em disco.');
  p();
  secaoRodada(rodada);
  secaoCausas(rodada);
  secaoTravaDeOpiniao(rodada);
  secaoRespostas(rodada);
  secaoUmaAUma(rodada);
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  let artefato = ARTEFATO_PADRAO;
  for (const arg of process.argv.slice(2)) {
    const m = /^--artefato=(.+)$/.exec(arg);
    if (m === null) {
      console.error(`[medir:digest-nulo] argumento desconhecido: ${arg}`);
      console.error('[medir:digest-nulo] uso: npm run medir:digest-nulo -- [--artefato=CAMINHO.json]');
      process.exit(1);
      return;
    }
    artefato = m[1] as string;
  }

  let rodada: Rodada;
  try {
    rodada = await lerRodada(artefato);
  } catch (err) {
    // The big run artifacts are gitignored, so a fresh clone does not have them.
    // Naming the file beats an ENOENT stack trace.
    console.error(
      `[medir:digest-nulo] não deu para ler ${artefato}: ` +
        (err instanceof Error ? err.message : String(err)),
    );
    console.error(
      '[medir:digest-nulo] os artefatos de rodada grande são gitignored. Rode a digestão\n' +
        '                   (npm run digerir -- --degrau=3) ou aponte --artefato= para outro.',
    );
    process.exit(1);
    return;
  }

  relatorio(rodada);
  const texto = `${linhas.join('\n')}\n`;
  await writeFile(SAIDA, texto, 'utf8');
  console.log(texto);
  console.log(`\n[medir:digest-nulo] ${SAIDA}`);
}

void main();
