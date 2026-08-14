import 'dotenv/config';
import { supabase } from '../src/lib/supabase.js';
import { section, table } from './lib/probe-net.js';
import {
  JANELA_MS,
  TOLERANCIA_MS,
  lerJanelas,
  type Foto,
  type Janela,
} from './lib/janela-radar.js';

/**
 * Confere a `v_radar` contra a série crua, recalculando as janelas em TypeScript.
 *
 * Por que existe: a lógica de janela temporal mora em SQL, dentro de uma view.
 * SQL não tem teste unitário aqui, e uma view errada não quebra — ela devolve
 * número. Este script é a segunda opinião: lê os snapshots crus e refaz a conta
 * por um caminho que não compartilha uma linha de código com o Postgres
 * (`scripts/lib/janela-radar.ts`, que tem teste sem rede).
 *
 * Duas implementações que concordam não provam que a regra está certa. Mas duas
 * que DISCORDAM provam que uma está errada, e isso é o que se quer descobrir
 * antes de a tela existir.
 *
 * Roda depois do apply da `20260814142958_views_do_radar.sql`.
 *
 *   npm run radar:conferir            # amostra de 40 mercados
 *   npm run radar:conferir -- --todos # o roster inteiro
 */

const AMOSTRA_PADRAO = 40;

/** Quanto da série precisa ser lida: a janela mais longa mais a tolerância. */
const FUNDO_MS = JANELA_MS.d7 + TOLERANCIA_MS.d7;

/** Limite de linhas por página do PostgREST. */
const PAGINA = 1000;

interface LinhaRadar {
  id: string;
  pergunta: string;
  outcome: string | null;
  mid_price: number | null;
  preco_em: string | null;
  var_1h: number | null;
  var_1h_base: string | null;
  var_24h: number | null;
  var_24h_base: string | null;
  var_7d: number | null;
  var_7d_base: string | null;
}

/** Tolerância de comparação: `numeric(5,4)` no banco, float em JS. */
const EPSILON = 1e-9;

function iguais(a: number | null, b: number | null): boolean {
  if (a === null && b === null) return true;
  if (a === null || b === null) return false;
  return Math.abs(a - b) < EPSILON;
}

function num(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Lê a série crua dos mercados pedidos, paginando.
 *
 * Filtra por `outcome` junto com `event_id` porque a view ancora no rótulo da
 * última foto — misturar rótulos aqui compararia duas séries diferentes e
 * acusaria divergência que não existe.
 */
async function lerSerie(
  ids: string[],
  outcomePorId: Map<string, string | null>,
  desde: string,
): Promise<Map<string, Foto[]>> {
  const porMercado = new Map<string, Foto[]>();
  let descartadasPorRotulo = 0;

  for (let i = 0; i < ids.length; i += 25) {
    const lote = ids.slice(i, i + 25);
    let offset = 0;

    for (;;) {
      const { data, error } = await supabase
        .from('polymarket_snapshots')
        .select('event_id, outcome, mid_price, best_bid, best_ask, captured_at')
        .in('event_id', lote)
        .gte('captured_at', desde)
        .order('captured_at', { ascending: false })
        .range(offset, offset + PAGINA - 1);

      if (error) throw new Error(`serie crua: ${error.message}`);
      if (!data || data.length === 0) break;

      for (const linha of data) {
        const id = linha.event_id as string;
        if (outcomePorId.get(id) !== linha.outcome) {
          descartadasPorRotulo += 1;
          continue;
        }
        const lista = porMercado.get(id) ?? [];
        lista.push({
          capturedAt: Date.parse(linha.captured_at as string),
          mid: num(linha.mid_price),
          bid: num(linha.best_bid),
          ask: num(linha.best_ask),
        });
        porMercado.set(id, lista);
      }

      if (data.length < PAGINA) break;
      offset += PAGINA;
    }
  }

  if (descartadasPorRotulo > 0) {
    console.log(
      `  (${descartadasPorRotulo} linhas descartadas por rótulo diferente do da última foto)`,
    );
  }

  return porMercado;
}

async function main(): Promise<void> {
  const todos = process.argv.includes('--todos');

  console.log(section('v_radar — cobertura'));

  const { data: radar, error } = await supabase
    .from('v_radar')
    .select('id, pergunta, outcome, mid_price, preco_em, var_1h, var_1h_base, var_24h, var_24h_base, var_7d, var_7d_base')
    .order('id');

  if (error) {
    console.error(`Não consegui ler v_radar: ${error.message}`);
    console.error('As migrations 20260814142958_views_do_radar.sql e');
    console.error('20260814151752_variacao_sem_mid_e_lado_oposto.sql já foram aplicadas?');
    process.exitCode = 1;
    return;
  }

  const linhas = (radar ?? []) as unknown as LinhaRadar[];
  if (linhas.length === 0) {
    console.log('v_radar está vazia. Nada a conferir.');
    return;
  }

  const conta = (p: (l: LinhaRadar) => boolean): number => linhas.filter(p).length;

  console.log(table(
    ['medida', 'mercados', '% do roster'],
    [
      ['no roster', String(linhas.length), '100.0'],
      ...(
        [
          ['sem foto nenhuma', (l: LinhaRadar) => l.preco_em === null],
          ['sem mid agora (livro de um lado)', (l: LinhaRadar) => num(l.mid_price) === null],
          ['com variação 1h', (l: LinhaRadar) => num(l.var_1h) !== null],
          ['  ...base mid', (l: LinhaRadar) => l.var_1h_base === 'mid'],
          ['  ...base ask', (l: LinhaRadar) => l.var_1h_base === 'ask'],
          ['  ...base bid', (l: LinhaRadar) => l.var_1h_base === 'bid'],
          ['com variação 24h', (l: LinhaRadar) => num(l.var_24h) !== null],
          ['com variação 7d', (l: LinhaRadar) => num(l.var_7d) !== null],
        ] as const
      ).map(([rotulo, p]) => {
        const n = conta(p);
        return [rotulo, String(n), ((100 * n) / linhas.length).toFixed(1)];
      }),
    ],
  ));

  console.log(
    `\nTolerâncias em uso: 1h ±${TOLERANCIA_MS.h1 / 60_000} min · ` +
      `24h ±${TOLERANCIA_MS.h24 / 3_600_000} h · ` +
      `7d ±${TOLERANCIA_MS.d7 / 3_600_000} h`,
  );

  // -------------------------------------------------------------------------
  console.log(section('v_radar — conferência contra a série crua'));

  const alvo = todos ? linhas : linhas.slice(0, AMOSTRA_PADRAO);
  console.log(
    todos
      ? `Conferindo o roster inteiro (${alvo.length} mercados).`
      : `Conferindo ${alvo.length} de ${linhas.length} mercados. Use --todos para o roster inteiro.`,
  );

  const outcomePorId = new Map(alvo.map(l => [l.id, l.outcome]));
  const desde = new Date(Date.now() - FUNDO_MS - 60_000).toISOString();
  const serie = await lerSerie(
    alvo.map(l => l.id),
    outcomePorId,
    desde,
  );

  const divergencias: string[][] = [];
  let conferidos = 0;

  for (const l of alvo) {
    const fotos = serie.get(l.id) ?? [];
    const recalc = lerJanelas(fotos);
    conferidos += 1;

    const paresJanela: Array<[Janela, number | null, string | null]> = [
      ['h1', num(l.var_1h), l.var_1h_base],
      ['h24', num(l.var_24h), l.var_24h_base],
      ['d7', num(l.var_7d), l.var_7d_base],
    ];

    if (!iguais(num(l.mid_price), recalc.agora?.mid ?? null)) {
      divergencias.push([
        l.pergunta.slice(0, 40),
        'mid agora',
        String(num(l.mid_price)),
        String(recalc.agora?.mid ?? null),
      ]);
    }

    for (const [janela, daView, baseDaView] of paresJanela) {
      const meu = recalc.variacoes[janela];

      // A base primeiro: uma variação certa calculada sobre a base errada é o
      // caso que este script existe para pegar.
      if (baseDaView !== (meu.base ?? null)) {
        divergencias.push([
          l.pergunta.slice(0, 40),
          `base ${janela}`,
          String(baseDaView),
          String(meu.base),
        ]);
        continue;
      }

      const valor = meu.variacao === null ? null : Math.round(meu.variacao * 1e4) / 1e4;
      if (!iguais(daView, valor)) {
        divergencias.push([
          l.pergunta.slice(0, 40),
          `var ${janela}`,
          String(daView),
          String(valor),
        ]);
      }
    }
  }

  if (divergencias.length === 0) {
    console.log(`\n✅ ${conferidos} mercados conferidos, nenhuma divergência.`);
  } else {
    console.log(`\n❌ ${divergencias.length} divergências em ${conferidos} mercados:`);
    console.log(table(['mercado', 'campo', 'view', 'recalculado'], divergencias.slice(0, 30)));
    if (divergencias.length > 30) {
      console.log(`  (${divergencias.length - 30} divergências não mostradas)`);
    }
    process.exitCode = 1;
  }

  // -------------------------------------------------------------------------
  console.log(section('v_minhas_posicoes'));

  const { data: pos, error: posErr } = await supabase
    .from('v_minhas_posicoes')
    .select('pergunta, outcome, stake_usd, preco_agora, pnl_nao_realizado, preco_origem, bid_depth, motivo_sem_preco');

  if (posErr) {
    console.error(`Não consegui ler v_minhas_posicoes: ${posErr.message}`);
    process.exitCode = 1;
    return;
  }

  const legs = pos ?? [];
  if (legs.length === 0) {
    console.log('Nenhuma leg aberta.');
    return;
  }

  const semPreco = legs.filter(l => num(l.preco_agora) === null);
  console.log(`${legs.length} legs abertas, ${semPreco.length} sem preço de mercado.`);

  const derivadas = legs.filter(l => String(l.preco_origem ?? '').startsWith('derivado'));
  if (derivadas.length > 0) {
    // Profundidade em linha derivada seria número inventado: o livro do outro
    // token é outro livro. Se aparecer, é defeito da view.
    const comProfundidade = derivadas.filter(l => num(l.bid_depth) !== null).length;
    console.log(
      `${derivadas.length} legs com preço DERIVADO do lado oposto` +
        (comProfundidade > 0
          ? ` — ❌ ${comProfundidade} delas vieram com profundidade, que não é derivável`
          : ' — profundidade nula em todas, como esperado'),
    );
    if (comProfundidade > 0) process.exitCode = 1;
  }

  if (semPreco.length > 0) {
    // O ponto do `motivo_sem_preco`: "sem preço" sem motivo é só silêncio.
    const porMotivo = new Map<string, number>();
    for (const l of semPreco) {
      const m = (l.motivo_sem_preco as string | null) ?? '(sem motivo registrado)';
      porMotivo.set(m, (porMotivo.get(m) ?? 0) + 1);
    }
    console.log(
      table(
        ['motivo', 'legs'],
        [...porMotivo.entries()].map(([m, n]) => [m, String(n)]),
      ),
    );
  }
}

main().catch(err => {
  console.error(err);
  process.exitCode = 1;
});
