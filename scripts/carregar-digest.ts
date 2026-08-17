import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import { section, table } from './lib/probe-net.js';
import { supabase } from '../src/lib/supabase.js';
import { readDigested, jaDigerido, type DigestedIndex } from '../src/digest/store.js';
import { tiposDe } from '../src/digest/prompts.js';
import { SEVERIDADES } from '../src/digest/prompts.js';

/**
 * A carga da digestão: o artefato de `probes/digest/*.json` vira linha nas três
 * tabelas.
 *
 * **Este é o único script do projeto que ESCREVE no banco**, e ele existe
 * porque o dono autorizou esta carga em particular. Por isso o desenho é o mais
 * desconfiado de todos:
 *
 *   - sem `--confirmar`, NADA é escrito. O default é dry-run, e o dry-run faz a
 *     validação inteira — se a carga fosse falhar por CHECK, ela falha aqui, de
 *     graça, antes de ter escrito metade.
 *   - a migration tem que estar aplicada. Tabela ausente PARA o script; não há
 *     modo "cria o que falta".
 *   - o que já está carregado é PULADO pela mesma chave que a unique usa
 *     (evento, hash do texto, modelo, versão). Rodar duas vezes não duplica, e
 *     rodar de novo depois de uma queda no meio continua de onde parou.
 *
 *   npm run carregar-digest -- --arquivo=probes/digest/degrau-3-v4.json
 *   npm run carregar-digest -- --arquivo=probes/digest/degrau-3-v4.json --confirmar
 *   npm run carregar-digest -- --verificar
 *
 * ## O que este script NÃO faz
 *
 * Não agrupa. As 21 contradições da passada v4 incluem seis que são o mesmo
 * defeito de texto, e as seis são gravadas INTEIRAS, uma linha cada, com as
 * leituras que o modelo escreveu para cada mercado. Quem agrupa é a view
 * `digest_contradicoes`. A carga grava fato; a view responde pergunta — e uma
 * view errada se corrige com CREATE OR REPLACE, enquanto um dado não gravado se
 * corrige pagando US$ 2,62 e cinco horas de novo.
 */

const LABEL = 'carregar-digest';
const ARQUIVO_PADRAO = 'probes/digest/degrau-3-v4.json';

/**
 * Tamanho do lote.
 *
 * 50 e não 728: o PostgREST tem prazo de 8s e cada digestão carrega listas de
 * texto. E 50 e não 1 porque 728 idas ao banco em série são minutos de latência
 * de rede para um trabalho que é de segundos.
 *
 * O lote também é a unidade de recuperação: pai e filhas do mesmo lote entram
 * juntos, e se algo estourar no meio o script para e diz exatamente quais
 * digestões ficaram sem filhas.
 */
const LOTE = 50;

interface Args {
  arquivo: string;
  confirmar: boolean;
  verificar: boolean;
}

function parseArgs(argv: readonly string[]): Args | { error: string } {
  const args: Args = { arquivo: ARQUIVO_PADRAO, confirmar: false, verificar: false };

  for (const arg of argv) {
    if (arg === '--confirmar') {
      args.confirmar = true;
      continue;
    }
    if (arg === '--verificar') {
      args.verificar = true;
      continue;
    }
    const match = /^--arquivo=(.+)$/.exec(arg);
    if (match === null || match[1] === undefined) return { error: `argumento desconhecido: ${arg}` };
    args.arquivo = match[1];
  }

  return args;
}

// ---------------------------------------------------------------------------
// O artefato
// ---------------------------------------------------------------------------

interface Entrada {
  digest: Record<string, unknown>;
  pegadinhas: Record<string, unknown>[];
  ambiguidades: Record<string, unknown>[];
}

interface Falha {
  event_id: string;
  falha: { code: string; message: string };
}

function ehFalha(entry: unknown): entry is Falha {
  return typeof entry === 'object' && entry !== null && 'falha' in entry;
}

function ehEntrada(entry: unknown): entry is Entrada {
  return typeof entry === 'object' && entry !== null && 'digest' in entry;
}

/**
 * A validação que roda ANTES de qualquer escrita.
 *
 * Cada item aqui é um CHECK da migration, reproduzido em código. Não é
 * duplicação por desconfiança do banco — é para a falha acontecer no dry-run,
 * onde ela custa nada, em vez de no meio da carga, onde ela deixa 300 linhas
 * dentro e 400 fora.
 */
function validar(entradas: readonly Entrada[]): string[] {
  const problemas: string[] = [];

  for (const [i, e] of entradas.entries()) {
    const onde = `entrada ${i + 1} (event ${String(e.digest['event_id'])})`;
    const versao = String(e.digest['prompt_version']);
    const tipos = tiposDe(versao);

    const sim = e.digest['resolve_sim'];
    if (!Array.isArray(sim) || sim.length === 0) {
      problemas.push(`${onde}: resolve_sim vazio — viola market_rule_digests_tem_resolucao`);
    }

    const sha = e.digest['description_sha256'];
    if (typeof sha !== 'string' || !/^[0-9a-f]{64}$/.test(sha)) {
      problemas.push(`${onde}: description_sha256 não é hex de 64 — viola o CHECK do hash`);
    }

    for (const p of e.pegadinhas) {
      const sev = p['severidade'];
      if (sev !== null && (typeof sev !== 'string' || !(SEVERIDADES as readonly string[]).includes(sev))) {
        problemas.push(`${onde}: severidade fora da lista: ${JSON.stringify(sev)}`);
      }
      const cenario = p['cenario'];
      if (
        (sev === 'muda_resultado' || sev === 'muda_timing') &&
        (typeof cenario !== 'string' || cenario.trim().length === 0)
      ) {
        problemas.push(
          `${onde}: severidade forte sem cenário — viola digest_pegadinhas_cenario_sustenta_severidade`,
        );
      }
    }

    for (const a of e.ambiguidades) {
      const tipo = a['tipo'];
      if (tipo !== null && (typeof tipo !== 'string' || !tipos.includes(tipo))) {
        problemas.push(`${onde}: tipo fora da lista de ${versao}: ${JSON.stringify(tipo)}`);
      }
      // O CHECK dos dois lados: obrigatório na contradição, nulo em todo o resto.
      const conflito = a['trecho_conflito'];
      const temConflito = typeof conflito === 'string' && conflito.trim().length > 0;
      if (tipo === 'contradicao_interna' && !temConflito) {
        problemas.push(`${onde}: contradicao_interna sem trecho_conflito`);
      }
      if (tipo !== 'contradicao_interna' && conflito !== null && conflito !== undefined) {
        problemas.push(`${onde}: trecho_conflito em tipo ${String(tipo)} — a coluna exige null`);
      }
    }
  }

  return problemas;
}

function chaveDe(d: Record<string, unknown>): string {
  return [d['event_id'], d['description_sha256'], d['model'], d['prompt_version']].join('|');
}

// ---------------------------------------------------------------------------
// A escrita
// ---------------------------------------------------------------------------

interface Resultado {
  digests: number;
  pegadinhas: number;
  ambiguidades: number;
  /** Digestões cujo pai entrou e cujas filhas não — o estado que precisa reparo. */
  orfas: string[];
}

/**
 * Um lote: os pais, depois as filhas com o `digest_id` que o banco devolveu.
 *
 * O casamento entre pai devolvido e filhas é pela CHAVE de quatro colunas
 * (evento, hash, modelo, versão), e não pela ordem do array. A ordem que o
 * PostgREST devolve não é promessa de contrato, e casar por posição é o tipo de
 * suposição que funciona em teste e troca as filhas de lugar em produção.
 */
async function carregarLote(lote: readonly Entrada[]): Promise<Resultado> {
  const { data, error } = await supabase
    .from('market_rule_digests')
    .insert(lote.map(e => e.digest))
    .select('id, event_id, description_sha256, model, prompt_version');

  if (error !== null) throw new Error(`insert em market_rule_digests falhou: ${error.message}`);

  const porChave = new Map<string, string>();
  for (const row of (data ?? []) as Array<Record<string, unknown>>) {
    porChave.set(chaveDe(row), String(row['id']));
  }

  const pegadinhas: Record<string, unknown>[] = [];
  const ambiguidades: Record<string, unknown>[] = [];
  const orfas: string[] = [];

  for (const e of lote) {
    const id = porChave.get(chaveDe(e.digest));
    if (id === undefined) {
      orfas.push(String(e.digest['event_id']));
      continue;
    }
    for (const p of e.pegadinhas) pegadinhas.push({ ...p, digest_id: id });
    for (const a of e.ambiguidades) ambiguidades.push({ ...a, digest_id: id });
  }

  if (pegadinhas.length > 0) {
    const { error: err } = await supabase.from('digest_pegadinhas').insert(pegadinhas);
    if (err !== null) {
      throw new Error(
        `insert em digest_pegadinhas falhou: ${err.message}\n` +
          `  ATENÇÃO: ${data?.length ?? 0} digestões do lote já entraram e estão SEM filhas.\n` +
          `  Rode com --verificar para listá-las.`,
      );
    }
  }

  if (ambiguidades.length > 0) {
    const { error: err } = await supabase.from('digest_ambiguidades').insert(ambiguidades);
    if (err !== null) {
      throw new Error(
        `insert em digest_ambiguidades falhou: ${err.message}\n` +
          `  ATENÇÃO: ${data?.length ?? 0} digestões do lote já entraram, com pegadinhas e sem ambiguidades.\n` +
          `  Rode com --verificar para listá-las.`,
      );
    }
  }

  return {
    digests: data?.length ?? 0,
    pegadinhas: pegadinhas.length,
    ambiguidades: ambiguidades.length,
    orfas,
  };
}

/**
 * O reparo: digestões gravadas que ficaram sem nenhuma filha.
 *
 * Só existe porque supabase-js não abre transação. Uma queda entre o insert do
 * pai e o das filhas deixa um estado que a chave de deduplicação considera
 * "pronto" — e é a única forma de esta carga perder dado em silêncio.
 */
async function verificarOrfas(): Promise<void> {
  const { data: digests, error } = await supabase
    .from('market_rule_digests')
    .select('id, event_id, prompt_version')
    .limit(2000);
  if (error !== null) throw new Error(`leitura falhou: ${error.message}`);

  const linhas = (digests ?? []) as Array<Record<string, unknown>>;
  const semFilhas: string[] = [];

  for (const d of linhas) {
    const id = String(d['id']);
    const [{ count: nPeg }, { count: nAmb }] = await Promise.all([
      supabase.from('digest_pegadinhas').select('id', { count: 'exact', head: true }).eq('digest_id', id),
      supabase.from('digest_ambiguidades').select('id', { count: 'exact', head: true }).eq('digest_id', id),
    ]);
    if ((nPeg ?? 0) === 0 && (nAmb ?? 0) === 0) semFilhas.push(`${id}  event=${String(d['event_id'])}`);
  }

  console.log(section('Digestões sem nenhuma filha'));
  if (semFilhas.length === 0) {
    console.log(`  nenhuma — as ${linhas.length} digestões têm pegadinha ou ambiguidade.`);
    console.log('  (zero dos dois é possível de verdade: regra simples existe. Confira no relatório');
    console.log('   antes de apagar qualquer coisa.)');
    return;
  }
  console.log(`  ${semFilhas.length} de ${linhas.length}:`);
  for (const s of semFilhas) console.log(`    ${s}`);
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  if ('error' in parsed) {
    console.error(`[${LABEL}] ${parsed.error}`);
    console.error(`  uso: npm run carregar-digest -- [--arquivo=CAMINHO] [--confirmar] [--verificar]`);
    process.exit(1);
    return;
  }

  if (parsed.verificar) {
    await verificarOrfas();
    return;
  }

  const raw = JSON.parse(await readFile(parsed.arquivo, 'utf8')) as unknown[];
  const entradas = raw.filter(ehEntrada);
  const falhas = raw.filter(ehFalha);

  console.log(section(`Carga da digestão — ${parsed.arquivo}`));
  console.log(`  entradas no arquivo: ${raw.length}`);
  console.log(`  digestões válidas:   ${entradas.length}`);
  console.log(`  falhas (não entram): ${falhas.length}`);

  // A validação vem ANTES da checagem de tabela, e a ordem é o ponto: o dry-run
  // existe para conferir a carga contra os CHECKs de graça, e o momento em que
  // isso vale é ANTES do `db push` — quando ainda dá para consertar sem ter
  // metade das linhas dentro. Validar só depois da tabela existir seria oferecer
  // o ensaio depois da estreia.
  const problemasTodos = validar(entradas);
  if (problemasTodos.length > 0) {
    console.error(`\n[${LABEL}] a carga NÃO vai rodar — ${problemasTodos.length} problema(s):`);
    for (const p of problemasTodos.slice(0, 20)) console.error(`  ${p}`);
    if (problemasTodos.length > 20) console.error(`  ... e mais ${problemasTodos.length - 20}.`);
    process.exit(1);
    return;
  }
  console.log(`  validação:           as ${entradas.length} passam nos CHECKs das três tabelas`);

  // A tabela tem que existir. Sem ela, `readDigested` devolve tabelaExiste=false
  // e uma carga que "não pulou nada" seria indistinguível de uma que não pode
  // rodar — que é exatamente o erro que se quer impossível aqui.
  const digeridos: DigestedIndex = await readDigested();
  if (!digeridos.tabelaExiste) {
    console.error(
      `\n[${LABEL}] market_rule_digests não existe. Rode o \`supabase db push\` primeiro.\n` +
        '  Este script não aplica migration — quem aplica é o dono.',
    );
    process.exit(1);
    return;
  }
  console.log(`  já no banco:         ${digeridos.keys.size} digestões`);

  const pendentes = entradas.filter(
    e =>
      !jaDigerido(digeridos, {
        eventId: String(e.digest['event_id']),
        descriptionSha256: String(e.digest['description_sha256']),
        model: String(e.digest['model']),
        promptVersion: String(e.digest['prompt_version']),
      }),
  );

  const problemas = validar(pendentes);
  console.log(
    table(
      ['medida', 'valor'],
      [
        ['digestões a gravar', String(pendentes.length)],
        ['já gravadas (puladas)', String(entradas.length - pendentes.length)],
        ['pegadinhas a gravar', String(pendentes.reduce((n, e) => n + e.pegadinhas.length, 0))],
        ['ambiguidades a gravar', String(pendentes.reduce((n, e) => n + e.ambiguidades.length, 0))],
        [
          'contradições a gravar',
          String(
            pendentes.reduce(
              (n, e) => n + e.ambiguidades.filter(a => a['tipo'] === 'contradicao_interna').length,
              0,
            ),
          ),
        ],
        ['problemas de validação', String(problemas.length)],
      ],
      [0],
    ),
  );

  if (problemas.length > 0) {
    console.error(`\n[${LABEL}] a carga NÃO vai rodar — ${problemas.length} problema(s):`);
    for (const p of problemas.slice(0, 20)) console.error(`  ${p}`);
    if (problemas.length > 20) console.error(`  ... e mais ${problemas.length - 20}.`);
    process.exit(1);
    return;
  }

  if (pendentes.length === 0) {
    console.log('\n  nada a fazer: tudo deste arquivo já está no banco.');
    return;
  }

  if (!parsed.confirmar) {
    console.log(
      `\n[${LABEL}] DRY RUN: nada foi escrito. A validação passou nas ${pendentes.length} digestões.\n` +
        `  Para gravar: npm run carregar-digest -- --arquivo=${parsed.arquivo} --confirmar`,
    );
    return;
  }

  console.log(section('Gravando'));
  const total: Resultado = { digests: 0, pegadinhas: 0, ambiguidades: 0, orfas: [] };

  for (let i = 0; i < pendentes.length; i += LOTE) {
    const lote = pendentes.slice(i, i + LOTE);
    const r = await carregarLote(lote);
    total.digests += r.digests;
    total.pegadinhas += r.pegadinhas;
    total.ambiguidades += r.ambiguidades;
    total.orfas.push(...r.orfas);
    console.log(`  ${total.digests}/${pendentes.length} digestões  |  ${total.pegadinhas} pegadinhas  |  ${total.ambiguidades} ambiguidades`);
  }

  console.log(section('Gravado'));
  console.log(
    table(
      ['tabela', 'linhas'],
      [
        ['market_rule_digests', String(total.digests)],
        ['digest_pegadinhas', String(total.pegadinhas)],
        ['digest_ambiguidades', String(total.ambiguidades)],
      ],
      [0],
    ),
  );

  if (total.orfas.length > 0) {
    console.error(`\n  ${total.orfas.length} digestão(ões) não casaram com a linha devolvida e ficaram SEM filhas:`);
    for (const o of total.orfas) console.error(`    ${o}`);
  }

  console.log('\n  A view do agrupamento:');
  console.log('    select defeito_id, mercados_atingidos, liquidez_total, left(trecho, 60)');
  console.log('      from public.digest_contradicoes;');
}

await main();
