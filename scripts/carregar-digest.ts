import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import { section, table } from './lib/probe-net.js';
import { supabase } from '../src/lib/supabase.js';
import { readDigested, jaCarregado, type DigestedIndex } from '../src/digest/store.js';
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
 *   npm run carregar-digest -- --verificar [--arquivo=CAMINHO]
 *
 * O `--verificar` confere o banco CONTRA o artefato, e por isso aceita
 * `--arquivo`: sem o número esperado de filhas, "esta regra não tinha pegadinha"
 * e "as pegadinhas dela não gravaram" são a mesma linha na tela.
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

/**
 * O índice da leitura de uma linha, com o default explícito.
 *
 * `?? 1` e não `String(...)`: os artefatos anteriores à `20260817163046` não
 * têm o campo, e `String(undefined)` daria a chave `...|undefined`, que não
 * casaria com a linha `leitura_n = 1` do banco. O resultado seria uma carga
 * que regrava tudo achando que nada estava lá.
 */
function leituraDe(d: Record<string, unknown>): number {
  const raw = d['leitura_n'];
  const n = raw === undefined || raw === null ? 1 : Number(raw);
  return Number.isFinite(n) && n >= 1 ? n : 1;
}

function chaveDe(d: Record<string, unknown>): string {
  return [d['event_id'], d['description_sha256'], d['model'], d['prompt_version'], leituraDe(d)].join(
    '|',
  );
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
 * O casamento entre pai devolvido e filhas é pela CHAVE de cinco colunas
 * (evento, hash, modelo, versão, leitura), e não pela ordem do array. A ordem
 * que o PostgREST devolve não é promessa de contrato, e casar por posição é o
 * tipo de suposição que funciona em teste e troca as filhas de lugar em
 * produção.
 *
 * `leitura_n` entrou na chave junto com a `20260817163046`. Sem ela, um lote de
 * nivelamento — que traz a leitura 2 e a 3 do MESMO (evento, hash, modelo,
 * versão) — teria duas linhas com a mesma chave, e as filhas da leitura 3
 * seriam penduradas no `digest_id` da leitura 2. Silenciosamente.
 */
async function carregarLote(lote: readonly Entrada[]): Promise<Resultado> {
  const { data, error } = await supabase
    .from('market_rule_digests')
    .insert(lote.map(e => e.digest))
    .select('id, event_id, description_sha256, model, prompt_version, leitura_n');

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
 * O reparo: conferir o que está no banco contra o que o artefato mandou gravar.
 *
 * Só existe porque supabase-js não abre transação. Uma queda entre o insert do
 * pai e o das filhas deixa um estado que a chave de deduplicação considera
 * "pronto" — e é a única forma de esta carga perder dado em silêncio.
 *
 * A versão anterior procurava pai sem filho, e por isso não sabia responder a
 * única pergunta que importa. `will-luis-diaz-win-the-2026-ballon-dor` saiu como
 * "sem filhas" na primeira conferência: o artefato traz zero pegadinhas e zero
 * ambiguidades para ele — regra de três parágrafos, o modelo não achou nada. É
 * vazio LEGÍTIMO. Uma digestão cujas quatro pegadinhas se perderam entre um
 * insert e o outro aparecia exatamente igual na mesma lista. "Não tinha filho" e
 * "o filho não gravou" só se distinguem contra o artefato, que é onde está o
 * número esperado — então é contra ele que se confere.
 *
 * O que a conferência classifica:
 *   - `ok`            — a contagem no banco é a do artefato (inclui 0 = 0).
 *   - `PERDA`         — o banco tem MENOS filhas que o artefato. É o defeito.
 *   - `sobra`         — o banco tem MAIS. Não é perda, mas é insert repetido.
 *   - `não conferível`— digestão no banco que não está neste artefato (veio de
 *                       outra passada). Não é acusação; é falta de referência.
 *   - `não carregada` — entrada do artefato que não chegou ao banco.
 */
interface Esperado {
  eventId: string;
  pegadinhas: number;
  ambiguidades: number;
}

/** Uma divergência entre banco e artefato, ainda sem slug — ele vem depois. */
interface Divergencia {
  digestId: string;
  eventId: string;
  pegadinhas: number;
  ambiguidades: number;
  esperaPegadinhas: number;
  esperaAmbiguidades: number;
}

function chaveDigest(k: {
  eventId: string;
  sha: string;
  model: string;
  promptVersion: string;
  leituraN: number;
}): string {
  return `${k.eventId}|${k.sha}|${k.model}|${k.promptVersion}|${k.leituraN}`;
}

/**
 * As filhas, contadas em memória e não com um `count` por digestão.
 *
 * 752 digestões vezes duas tabelas seriam 1504 idas ao banco em série para
 * somar números que cabem numa página cada. Paginado por `digest_id` — a coluna
 * do índice — e não por `id`, porque a ordem que importa aqui é a do
 * agrupamento.
 */
async function contarFilhas(tabela: string): Promise<Map<string, number>> {
  const contagem = new Map<string, number>();
  const PAGINA = 1000;

  for (let from = 0; ; from += PAGINA) {
    const { data, error } = await supabase
      .from(tabela)
      .select('digest_id')
      .order('digest_id')
      .range(from, from + PAGINA - 1);
    if (error !== null) throw new Error(`leitura de ${tabela} falhou: ${error.message}`);

    const rows = (data ?? []) as Array<{ digest_id: string }>;
    for (const r of rows) contagem.set(r.digest_id, (contagem.get(r.digest_id) ?? 0) + 1);
    if (rows.length < PAGINA) break;
  }

  return contagem;
}

/**
 * O slug dos eventos que o relatório vai imprimir.
 *
 * O artefato guarda `event_id`, não slug — e um UUID não diz que mercado é.
 * A busca é `where id in (...)`, chave primária, em pedaços de 50: dezenas de
 * linhas por índice único, não os 711 MB de `events`. E só roda para o que vai
 * ser impresso — nunca para as 752.
 */
async function slugsDe(ids: readonly string[]): Promise<Map<string, string>> {
  const slugs = new Map<string, string>();
  if (ids.length === 0) return slugs;

  for (let i = 0; i < ids.length; i += 50) {
    const { data, error } = await supabase
      .from('events')
      .select('id, slug')
      .in('id', ids.slice(i, i + 50));
    if (error !== null) throw new Error(`leitura de events falhou: ${error.message}`);
    for (const r of (data ?? []) as Array<{ id: string; slug: string | null }>) {
      if (r.slug !== null) slugs.set(r.id, r.slug);
    }
  }

  return slugs;
}

async function verificarContraArtefato(arquivo: string): Promise<void> {
  const raw = JSON.parse(await readFile(arquivo, 'utf8')) as unknown[];
  const entradas = raw.filter(ehEntrada);

  const esperado = new Map<string, Esperado>();
  for (const e of entradas) {
    const chave = chaveDigest({
      eventId: String(e.digest['event_id']),
      sha: String(e.digest['description_sha256']),
      model: String(e.digest['model']),
      promptVersion: String(e.digest['prompt_version']),
      leituraN: leituraDe(e.digest),
    });
    esperado.set(chave, {
      eventId: String(e.digest['event_id']),
      pegadinhas: e.pegadinhas.length,
      ambiguidades: e.ambiguidades.length,
    });
  }

  const digests: Array<Record<string, unknown>> = [];
  const PAGINA = 500;
  for (let from = 0; ; from += PAGINA) {
    const { data, error } = await supabase
      .from('market_rule_digests')
      .select('id, event_id, description_sha256, model, prompt_version, leitura_n')
      .order('id')
      .range(from, from + PAGINA - 1);
    if (error !== null) throw new Error(`leitura falhou: ${error.message}`);
    const rows = (data ?? []) as Array<Record<string, unknown>>;
    digests.push(...rows);
    if (rows.length < PAGINA) break;
  }

  const [nPegadinhas, nAmbiguidades] = await Promise.all([
    contarFilhas('digest_pegadinhas'),
    contarFilhas('digest_ambiguidades'),
  ]);

  const perdas: Divergencia[] = [];
  const sobras: Divergencia[] = [];
  const naoConferiveis: string[] = [];
  const vistas = new Set<string>();
  let ok = 0;
  let vaziosLegitimos = 0;

  for (const d of digests) {
    const id = String(d['id']);
    const chave = chaveDigest({
      eventId: String(d['event_id']),
      sha: String(d['description_sha256']),
      model: String(d['model']),
      promptVersion: String(d['prompt_version']),
      leituraN: leituraDe(d),
    });
    vistas.add(chave);

    const alvo = esperado.get(chave);
    if (alvo === undefined) {
      naoConferiveis.push(`${id}  event=${String(d['event_id'])}  ${String(d['prompt_version'])}`);
      continue;
    }

    const peg = nPegadinhas.get(id) ?? 0;
    const amb = nAmbiguidades.get(id) ?? 0;
    const div: Divergencia = {
      digestId: id,
      eventId: alvo.eventId,
      pegadinhas: peg,
      ambiguidades: amb,
      esperaPegadinhas: alvo.pegadinhas,
      esperaAmbiguidades: alvo.ambiguidades,
    };

    if (peg < alvo.pegadinhas || amb < alvo.ambiguidades) {
      perdas.push(div);
      continue;
    }
    if (peg > alvo.pegadinhas || amb > alvo.ambiguidades) {
      sobras.push(div);
      continue;
    }
    ok += 1;
    if (alvo.pegadinhas === 0 && alvo.ambiguidades === 0) vaziosLegitimos += 1;
  }

  const naoCarregadas = [...esperado.entries()].filter(([chave]) => !vistas.has(chave));

  console.log(section(`Conferência contra o artefato — ${arquivo}`));
  console.log(
    table(
      ['medida', 'valor'],
      [
        ['entradas no artefato', String(entradas.length)],
        ['digestões no banco', String(digests.length)],
        ['batem com o artefato', String(ok)],
        ['  das quais vazio legítimo', String(vaziosLegitimos)],
        ['PERDA (falta filha)', String(perdas.length)],
        ['sobra (filha a mais)', String(sobras.length)],
        ['não conferíveis (outro artefato)', String(naoConferiveis.length)],
        ['não carregadas', String(naoCarregadas.length)],
      ],
      [0],
    ),
  );

  const paraImprimir = naoCarregadas.slice(0, 40).map(([, alvo]) => alvo);
  const slugs = await slugsDe([
    ...new Set([...perdas, ...sobras, ...paraImprimir].map(x => x.eventId)),
  ]);
  const nome = (eventId: string): string => slugs.get(eventId) ?? `event=${eventId}`;
  const contagens = (d: Divergencia): string =>
    `pegadinhas ${d.pegadinhas}/${d.esperaPegadinhas}  ambiguidades ${d.ambiguidades}/${d.esperaAmbiguidades}`;

  if (perdas.length > 0) {
    console.log(section('PERDA — o banco tem menos filhas que o artefato'));
    console.log('  Estas precisam de reparo: a digestão está gravada, e a chave de dedup a');
    console.log('  considera pronta, então uma nova carga NÃO vai reinseri-las.');
    for (const p of perdas) console.log(`    ${nome(p.eventId)}  ${contagens(p)}  digest=${p.digestId}`);
  }

  if (sobras.length > 0) {
    console.log(section('Sobra — o banco tem mais filhas que o artefato'));
    for (const s of sobras) console.log(`    ${nome(s.eventId)}  ${contagens(s)}  digest=${s.digestId}`);
  }

  if (naoCarregadas.length > 0) {
    console.log(section('Não carregadas — estão no artefato, não estão no banco'));
    for (const alvo of paraImprimir) {
      console.log(`    ${nome(alvo.eventId)}  (${alvo.pegadinhas} peg, ${alvo.ambiguidades} amb)`);
    }
    if (naoCarregadas.length > 40) console.log(`    ... e mais ${naoCarregadas.length - 40}.`);
  }

  if (naoConferiveis.length > 0) {
    console.log(section('Não conferíveis — no banco, fora deste artefato'));
    console.log('  Vieram de outra passada. Rode com --arquivo= no artefato delas para conferir.');
    for (const n of naoConferiveis.slice(0, 40)) console.log(`    ${n}`);
    if (naoConferiveis.length > 40) console.log(`    ... e mais ${naoConferiveis.length - 40}.`);
  }

  if (perdas.length === 0 && naoCarregadas.length === 0) {
    console.log(`\n  Nada a reparar deste artefato.`);
  }
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
    await verificarContraArtefato(parsed.arquivo);
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

  // A ARMADILHA do passo 2b, fechada aqui.
  //
  // Um artefato de nivelamento traz a leitura 2 e a 3 do MESMO (evento, hash,
  // modelo, versão) — de propósito, é o que nivelar quer dizer. Com a coluna
  // ausente, o insert não tem onde gravar o índice, as duas linhas colidem na
  // unique antiga e a carga falha no meio, com parte gravada.
  //
  // Parar ANTES, com o motivo escrito, é a diferença entre um erro e um
  // incidente.
  const leiturasExtras = entradas.filter(e => leituraDe(e.digest) > 1).length;
  if (leiturasExtras > 0 && !digeridos.colunaLeituraN) {
    console.error(
      `\n[${LABEL}] o artefato tem ${leiturasExtras} leituras com leitura_n > 1 e a coluna\n` +
        '  market_rule_digests.leitura_n não existe no banco.\n' +
        '  Aplique a 20260817163046_leitura_n_em_market_rule_digests.sql antes de carregar.\n' +
        '  Nada foi gravado.',
    );
    process.exit(1);
    return;
  }

  // `jaCarregado` (chave de CINCO partes) e não `jaDigerido` (quatro).
  //
  // Com `jaDigerido`, toda leitura de nivelamento seria pulada — o texto já foi
  // digerido, a chave de quatro casa — e o script terminaria "com sucesso"
  // tendo gravado zero. É a mesma família da migration que roda verde enquanto
  // falha: o silêncio passando por resultado.
  const pendentes = entradas.filter(
    e =>
      !jaCarregado(
        digeridos,
        {
          eventId: String(e.digest['event_id']),
          descriptionSha256: String(e.digest['description_sha256']),
          model: String(e.digest['model']),
          promptVersion: String(e.digest['prompt_version']),
        },
        leituraDe(e.digest),
      ),
  );

  // Zero pendentes com leituras extras no artefato é resultado legítimo — é a
  // carga repetida do mesmo nivelamento. Fica DITO em vez de silencioso, porque
  // "0 gravadas" e "0 porque a chave não distingue" imprimem o mesmo número, e
  // só um deles é resultado.
  if (pendentes.length === 0 && leiturasExtras > 0) {
    console.log(
      `\n  as ${leiturasExtras} leituras extras deste artefato já estão no banco, cada uma com o\n` +
        '  seu leitura_n. Carga repetida, nada a gravar — e isto é a chave funcionando.',
    );
  }

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
