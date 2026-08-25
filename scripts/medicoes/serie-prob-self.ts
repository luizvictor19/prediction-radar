import 'dotenv/config';
import { supabase } from '../../src/lib/supabase.js';

/**
 * How far along the `my_bets.prob_self` series is, and whether its orientation
 * can be recovered.
 *
 *   npm run medir:serie
 *
 * READ ONLY. No INSERT, UPDATE, DELETE or DDL, no paid API call.
 *
 * It exists because the answer on 24/08/2026 was **zero** -- no row of
 * `my_bets` carried a probability at all -- and a zero written into an issue
 * ages into a claim nobody can check. This command is the recomputation.
 *
 * ## Two questions, and why they share one command
 *
 * §1 asks whether the series has started: how many probabilities exist, how
 * many of them sit on a market that already resolved, and how old the oldest
 * is. §2 asks whether a probability can be scored at all -- which requires
 * knowing WHICH SIDE it refers to, and `prob_self` does not say. The two travel
 * together because a count of unscorable rows is not a series, and reporting
 * the first number without the second is how a zero turns into false comfort.
 *
 * ## Cost in the database (read before running)
 *
 * `events` is the big table (~551k rows, 711 MB) and the PostgREST timeout is
 * 8s, so the discipline from `CLAUDE.md` applies: it is touched ONLY by primary
 * key, in chunks of `LOTE`, never by a filter that could reach a seq scan. The
 * id list comes from `my_bets` and `v_radar`, both small, so the number of
 * chunks is bounded by them and not by the size of `events`.
 *
 * `TETO_INESPERADO` is the brake on that promise: if `my_bets` ever returns far
 * more rows than this table has any reason to hold, the command stops and says
 * so instead of quietly fanning out into `events`.
 */

type Linha = Record<string, unknown>;

const PAGINA = 1000;
const LOTE = 200;

/**
 * Above this many rows in `my_bets`, stop before touching `events`.
 *
 * `my_bets` is the owner's own register -- 58 rows in 24/08/2026. A number in
 * the thousands would mean something changed that this command's cost argument
 * no longer covers, and the honest move is to stop rather than to fan out.
 */
const TETO_INESPERADO = 5000;

async function paginar(
  pagina: (de: number, ate: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>,
): Promise<Linha[]> {
  const linhas: Linha[] = [];
  for (let salto = 0; ; salto += PAGINA) {
    const { data, error } = await pagina(salto, salto + PAGINA - 1);
    if (error) throw new Error(error.message);
    const lote = (data ?? []) as Linha[];
    linhas.push(...lote);
    if (lote.length < PAGINA) return linhas;
  }
}

function lotes<T>(itens: readonly T[], tamanho: number): T[][] {
  const saida: T[][] = [];
  for (let i = 0; i < itens.length; i += tamanho) saida.push(itens.slice(i, i + tamanho));
  return saida;
}

/**
 * `events.outcomes` is jsonb `{ values: string[], prices: string[] }` -- an
 * OBJECT, not an array (`normalize.ts:126`).
 *
 * Testing `Array.isArray` on it returns false for every row and counts the
 * whole table as having no labels. That is not a hypothetical: it is how the
 * first pass of this measurement got 1023 of 1023 "sem outcomes" and nearly
 * put a fabricated finding into an issue. The array branch stays for rows
 * written before the shape settled.
 */
function rotulos(outcomes: unknown): string[] {
  if (outcomes === null || typeof outcomes !== 'object') return [];
  if (Array.isArray(outcomes)) return outcomes.map(String);
  const values = (outcomes as { values?: unknown }).values;
  return Array.isArray(values) ? values.map(String) : [];
}

function secao(titulo: string): string {
  return `\n${titulo}\n${'='.repeat(titulo.length)}`;
}

/** Fração sempre com o denominador visível. Zero sobre zero é `—`, não `0%`. */
function fracao(parte: number, todo: number): string {
  return todo === 0 ? '—' : `${((100 * parte) / todo).toFixed(1)}%`;
}

function contar(linhas: readonly Linha[], chave: (l: Linha) => string): Array<[string, number]> {
  const m = new Map<string, number>();
  for (const l of linhas) {
    const k = chave(l);
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  return [...m].sort((a, b) => b[1] - a[1]);
}

// ---------------------------------------------------------------------------
// §1 — a série
// ---------------------------------------------------------------------------

async function medirSerie(): Promise<void> {
  console.log(secao('1. A série de prob_self'));

  const todas = await paginar((de, ate) =>
    supabase.from('my_bets').select('id, prob_self', { count: undefined }).range(de, ate),
  );

  const comProb = await paginar((de, ate) =>
    supabase
      .from('my_bets')
      .select('id, event_id, prob_self, placed_at, estrategia, preco_mercado, preco_mercado_outcome')
      .not('prob_self', 'is', null)
      .order('placed_at', { ascending: true })
      .range(de, ate),
  );

  console.log(`\n  my_bets, total de linhas:        ${todas.length}`);
  console.log(
    `  com prob_self NÃO NULO:          ${comProb.length}  (${fracao(comProb.length, todas.length)})`,
  );
  console.log(`  com prob_self nulo:              ${todas.length - comProb.length}`);

  if (comProb.length === 0) {
    console.log(
      '\n  A SÉRIE ESTÁ EM ZERO. Não é "poucos dados": é nenhum. Sem uma linha com\n' +
        '  probabilidade não há Brier a calcular, e o que bloqueia não é código —\n' +
        '  é ninguém ter registrado. Ver a nota em CONTEXTO-RADAR.md.',
    );
    // A seção 2 sai mesmo assim, zerada. Pular a seção faria a numeração saltar
    // de 1 para 3, e uma seção que some quando a resposta é zero é a forma mais
    // fácil de um relatório fazer o zero parecer ausência de medição.
    console.log(secao('2. Quantas já são pontuáveis'));
    console.log('\n  PONTUÁVEIS:                      0  (—)');
    console.log('  Não há linha com probabilidade, logo não há o que resolver.');
    return;
  }

  if (comProb.length > TETO_INESPERADO) {
    console.log(
      `\n  PARANDO: ${comProb.length} linhas passa de ${TETO_INESPERADO}, o teto que o argumento de\n` +
        '  custo desta medição cobre. Rever o custo antes de consultar events.',
    );
    return;
  }

  console.log(`\n  mais antiga (placed_at):         ${String(comProb[0]?.['placed_at'])}`);
  console.log(`  mais nova   (placed_at):         ${String(comProb[comProb.length - 1]?.['placed_at'])}`);

  console.log('\n  por estrategia:');
  for (const [k, n] of contar(comProb, l => String(l['estrategia'] ?? '(nulo)'))) {
    console.log(`    ${k.padEnd(14)} ${String(n).padStart(5)}  (${fracao(n, comProb.length)})`);
  }

  const semEvento = comProb.filter(l => l['event_id'] === null).length;
  console.log(
    `\n  sem event_id (basket — nunca pontuável por resolução): ${semEvento}  (${fracao(semEvento, comProb.length)})`,
  );

  // Quantas carregam a linha de base contra a qual prob_self seria medida.
  const comBase = comProb.filter(l => l['preco_mercado'] !== null).length;
  console.log(`  com preco_mercado gravado:                             ${comBase}  (${fracao(comBase, comProb.length)})`);

  // ---- O desfecho, por PK ----
  const eventIds = [
    ...new Set(comProb.map(l => l['event_id']).filter((v): v is string => typeof v === 'string')),
  ];
  const eventos = new Map<string, Linha>();
  for (const lote of lotes(eventIds, LOTE)) {
    const { data, error } = await supabase
      .from('events')
      .select('id, status, resolved_outcome, outcomes')
      .in('id', lote);
    if (error) throw new Error(`leitura de events falhou: ${error.message}`);
    for (const l of (data ?? []) as Linha[]) eventos.set(String(l['id']), l);
  }

  let aberto = 0;
  let voidd = 0;
  let pontuavel = 0;
  let ausente = 0;
  const datasPontuaveis: string[] = [];

  for (const l of comProb) {
    const eid = l['event_id'];
    if (typeof eid !== 'string') continue;
    const ev = eventos.get(eid);
    if (ev === undefined) {
      ausente += 1;
      continue;
    }
    if (String(ev['status']) !== 'resolved') {
      aberto += 1;
      continue;
    }
    // Carimbo de resolvido SEM rótulo vencedor é void: nunca vai pontuar, e
    // contá-lo como pendência o deixaria para sempre parecendo que um dia
    // resolve. Mesma leitura de `verticals/match-outcome.ts`.
    if (ev['resolved_outcome'] === null || ev['resolved_outcome'] === undefined) {
      voidd += 1;
      continue;
    }
    pontuavel += 1;
    datasPontuaveis.push(String(l['placed_at']));
  }

  console.log(secao('2. Quantas já são pontuáveis'));
  console.log(`\n  com prob_self e event_id:        ${comProb.length - semEvento}`);
  console.log(`  evento ausente no banco:         ${ausente}`);
  console.log(`  mercado ainda em aberto:         ${aberto}`);
  console.log(`  mercado resolvido SEM rótulo (void): ${voidd}`);
  console.log(`  PONTUÁVEIS:                      ${pontuavel}  (${fracao(pontuavel, comProb.length)})`);

  if (pontuavel > 0) {
    datasPontuaveis.sort();
    console.log(`\n  pontuável mais antiga:           ${datasPontuaveis[0]}`);
    console.log(`  pontuável mais nova:             ${datasPontuaveis[datasPontuaveis.length - 1]}`);
  } else {
    console.log('\n  Nenhuma linha pontuável ainda.');
  }
}

// ---------------------------------------------------------------------------
// §2 — o lado
// ---------------------------------------------------------------------------

/**
 * Whether the side a probability refers to could be recovered by rule.
 *
 * `prob_self` does not record which outcome it is about; `preco_mercado` does,
 * in `preco_mercado_outcome`. The screen's implied side is the question's Yes,
 * the bot's is the leg's outcome. This measures how often the one rule that
 * could stand in -- "the last snapshot's side IS the question's Yes" -- holds
 * across the roster.
 *
 * A rate of 100% here is not permission to derive it. It is a property of
 * `radar-collector.ts`, which records only the index-0 label, and nothing in
 * the schema enforces it. The number is here so that a change in the collector
 * shows up as a change in this line instead of silently as a wrong Brier.
 */
async function medirLado(): Promise<void> {
  console.log(secao('3. O lado: a regra que se poderia usar, medida'));

  const radar = await paginar((de, ate) =>
    supabase.from('v_radar').select('id, outcome').range(de, ate),
  );

  const ids = radar.map(l => String(l['id']));
  const eventos = new Map<string, Linha>();
  for (const lote of lotes(ids, LOTE)) {
    const { data, error } = await supabase.from('events').select('id, outcomes').in('id', lote);
    if (error) throw new Error(`leitura de events falhou: ${error.message}`);
    for (const l of (data ?? []) as Linha[]) eventos.set(String(l['id']), l);
  }

  let semLista = 0;
  let yesNo = 0;
  let outroBinario = 0;
  let naoBinario = 0;
  let indice0 = 0;
  let indice1 = 0;
  let fora = 0;
  const excecoes: string[] = [];

  for (const l of radar) {
    const ls = rotulos(eventos.get(String(l['id']))?.['outcomes']);
    if (ls.length === 0) {
      semLista += 1;
      continue;
    }
    if (ls.length === 2) {
      const baixo = ls.map(s => s.toLowerCase());
      if (baixo[0] === 'yes' && baixo[1] === 'no') yesNo += 1;
      else {
        outroBinario += 1;
        if (excecoes.length < 8) excecoes.push(ls.join(' | '));
      }
    } else {
      naoBinario += 1;
      if (excecoes.length < 8) excecoes.push(`[${ls.length}] ${ls.slice(0, 3).join(' | ')}`);
    }

    const o = l['outcome'];
    if (typeof o !== 'string') continue;
    const i = ls.findIndex(s => s.toLowerCase() === o.toLowerCase());
    if (i === 0) indice0 += 1;
    else if (i === 1) indice1 += 1;
    else fora += 1;
  }

  console.log(`\n  v_radar: ${radar.length} mercados no roster, events lidos por PK: ${eventos.size}`);

  console.log('\n  formato de events.outcomes.values:');
  console.log(`    exatamente ["Yes","No"]:       ${yesNo}  (${fracao(yesNo, radar.length)})`);
  console.log(`    binário com outros rótulos:    ${outroBinario}`);
  console.log(`    não binário:                   ${naoBinario}`);
  console.log(`    lista ausente ou vazia:        ${semLista}`);
  if (excecoes.length > 0) {
    console.log('\n    as exceções (o vocabulário NÃO é garantido):');
    for (const e of excecoes) console.log(`      ${e}`);
  }

  console.log('\n  onde o lado do último snapshot cai na lista do evento:');
  console.log(`    índice 0 (o Yes da pergunta):  ${indice0}  (${fracao(indice0, radar.length)})`);
  console.log(`    índice 1 (o lado oposto):      ${indice1}`);
  console.log(`    fora da lista:                 ${fora}`);

  console.log(
    '\n  LEIA COM CUIDADO: 100% aqui NÃO autoriza derivar o lado em vez de gravá-lo.\n' +
      '  A taxa é propriedade de radar-collector.ts, que grava só o rótulo do índice 0\n' +
      '  — nada no schema obriga, e o bot não tem regra nenhuma: lá o lado é o outcome\n' +
      '  da leg, que pode ser No. A linha existe para uma mudança no coletor aparecer\n' +
      '  aqui em vez de aparecer como um Brier errado.',
  );
}

async function medir(): Promise<void> {
  console.log('SÉRIE DE prob_self — a medição, refeita agora');
  console.log('=============================================');
  console.log('Só SELECT. events é tocada apenas por chave primária, em lotes de ' + LOTE + '.');

  await medirSerie();
  await medirLado();
  console.log('');
}

medir().catch((err: unknown) => {
  console.error(`\nA medição falhou: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
