import 'dotenv/config';
import { section, table } from './lib/probe-net.js';
import { getSystemConfig } from '../src/lib/config.js';
import {
  conferirPayload,
  INTERVALO_FOTO_PADRAO,
  readRules,
  readTemas,
  runRadarCycle,
} from '../src/collectors/radar-collector.js';

/**
 * O `--dry-run` do coletor do radar: monta o roster, lê os livros, imprime o
 * que gravaria — e não grava nada.
 *
 * Existe porque o custo de um ciclo e o conteúdo do roster são as duas coisas
 * que precisam ser conferidas ANTES de ligar a flag, e conferir depois seria
 * conferir com linha já escrita numa série que a retenção não apaga.
 *
 * Sem `--dry-run` ele roda um ciclo de VERDADE, com escrita — é o caminho para
 * testar o componente à mão sem esperar o cron. O default é o seguro.
 *
 *   npm run radar:coletor -- --dry-run
 *   npm run radar:coletor -- --dry-run --lista     # imprime o roster inteiro
 */

const LABEL = 'radar-coletor';

function usd(v: number): string {
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 10_000) return `${(v / 1_000).toFixed(0)}k`;
  // Uma casa abaixo de 10k: sem ela o piso de 1.500 aparecia como "2k" no
  // cabeçalho, e um relatório que arredonda o próprio critério não serve de
  // conferência.
  if (v >= 1_000) return `${(v / 1_000).toFixed(1)}k`;
  return v.toFixed(0);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes('--dry-run');
  const lista = argv.includes('--lista');

  const desconhecido = argv.find(a => !['--dry-run', '--lista'].includes(a));
  if (desconhecido !== undefined) {
    console.error(`[${LABEL}] argumento desconhecido: ${desconhecido}`);
    process.exit(1);
  }

  const config = await getSystemConfig();
  const rules = readRules(config);
  const temas = readTemas(config);

  console.log(section(`Radar — coletor (${dryRun ? 'DRY RUN, nada é gravado' : 'CICLO REAL'})`));
  console.log(`  flag radar_collector_enabled: ${config.radar_collector_enabled}`);
  console.log(
    `  coleta: aberto e ativo, livro com PELO MENOS UM lado, resolve em até ${rules.horizonMaxDays}d ` +
      `(sem prazo mínimo), não é mercado de partida,\n` +
      `  teto de ${rules.maxPorCategoria} por categoria cortando os menores em liquidez, ` +
      `backstop global de ${rules.rosterMax}`,
  );
  console.log(
    `  NÃO filtra: preço, volume, tamanho da descrição, assunto — isso é where na view.\n` +
      `  piso de download: liquidez ≥ ${usd(rules.minLiquidity)} (custo, não critério — conferir contra a liquidez do corte)`,
  );
  console.log(
    `  cadência: foto a cada ${config.radar_snapshot_interval_minutes} min ` +
      `(padrão ${INTERVALO_FOTO_PADRAO}), roster a cada ${config.radar_roster_interval_minutes} min`,
  );
  console.log(`  temas: ${temas.map(t => `${t.tema} [${t.tags.join(', ')}]`).join('  |  ')}\n`);

  if (!dryRun && !config.radar_collector_enabled) {
    console.error(
      `[${LABEL}] a flag está desligada — um ciclo real aqui escreveria mesmo assim.\n` +
        '  Rode com --dry-run, ou ligue a flag antes.',
    );
    process.exit(1);
  }

  const { renovacao, foto, rosterSize } = await runRadarCycle({ dryRun, verbose: lista });

  if (renovacao !== null) {
    console.log(section('1. Roster'));
    console.log(`  universo baixado: ${renovacao.universo} markets`);
    console.log(
      table(
        ['motivo da queda', 'markets'],
        Object.entries(renovacao.descartes)
          .sort((a, b) => b[1] - a[1])
          .map(([k, v]) => [k, String(v)]),
        [0],
      ),
    );
    console.log(
      '\n  O piso de liquidez do DOWNLOAD não aparece na tabela acima porque é aplicado pelo\n' +
        '  servidor da Gamma (`liquidity_num_min`): quem não passa nele não chega a ser baixado.',
    );
    console.log(
      `\n  passaram nos critérios: ${renovacao.candidatos.length}` +
        ` → cortados pelo teto de ${rules.maxPorCategoria}/categoria: ${renovacao.cortadosPorTeto}` +
        ` → cortados pelo backstop de ${rules.rosterMax}: ${renovacao.cortadosPeloBackstop}`,
    );
    console.log(
      `  liquidez do último que entrou: ${renovacao.liquidezDoCorte === null ? '—' : usd(renovacao.liquidezDoCorte)}` +
        `  |  do primeiro cortado: ${renovacao.liquidezDoPrimeiroCortado === null ? '— (nenhum teto mordeu)' : usd(renovacao.liquidezDoPrimeiroCortado)}` +
        `  |  piso de download: ${usd(rules.minLiquidity)}`,
    );
    console.log(
      `  assuntos distintos no roster: ${renovacao.assuntos}` +
        `  |  espelhos detectados (não descartados): ${renovacao.espelhos.length}`,
    );
    // O número desta rodada: quanto do roster entrou com meio livro. Eram 274
    // descartes antes, e os mais líquidos deles eram os azarões da eleição
    // brasileira — a tese em estado puro. Se a liquidez deles for alta, o
    // critério antigo custava caro; a mediana diz isso de uma vez.
    const liq = renovacao.liquidezComUmLadoSo;
    console.log(
      `  com o livro de UM lado só: ${renovacao.comUmLadoSo}` +
        (liq === null
          ? ''
          : ` (liquidez ${usd(liq.min)} / mediana ${usd(liq.mediana)} / ${usd(liq.max)})`) +
        `  |  mantidos por marca, livro vazio: ${renovacao.mantidosPorMarca}`,
    );
    console.log(`  roster final: ${rosterSize}\n`);

    // Por categoria: é aqui que se vê se o teto está apertado ou folgado em cada
    // uma. Categoria em que o teto não morde tem a coleta decidida pelo PISO DE
    // DOWNLOAD, e não pelo teto — a coluna do primeiro cortado mostra qual é o caso.
    console.log(
      table(
        ['categoria', 'candidatos', 'no roster', 'liq. do corte', 'liq. do 1º cortado'],
        Object.entries(renovacao.porCategoria)
          .sort((a, b) => b[1].roster - a[1].roster)
          .map(([k, v]) => [
            k,
            String(v.candidatos),
            String(v.roster),
            v.liquidezDoCorte === null ? '—' : usd(v.liquidezDoCorte),
            v.liquidezDoPrimeiroCortado === null ? '— (não mordeu)' : usd(v.liquidezDoPrimeiroCortado),
          ]),
        [0, 4],
      ),
    );

    // Os maiores grupos de assunto. Não é mais teto — é a COLUNA que a view vai
    // usar para não contar 22 mercados sobre o Irã como 22 observações. O `*` no
    // rótulo marca o grupo em que o agrupamento juntou perguntas de mesma FORMA
    // e assunto possivelmente diferente (ver `agruparPorAssunto`).
    const porGrupo = new Map<number, { rotulo: string; n: number }>();
    for (const c of renovacao.roster) {
      const g = porGrupo.get(c.grupoId) ?? { rotulo: c.assunto, n: 0 };
      g.n += 1;
      porGrupo.set(c.grupoId, g);
    }
    const grandes = [...porGrupo.values()].filter(g => g.n > 1).sort((a, b) => b.n - a.n);

    if (grandes.length > 0) {
      console.log(
        `\n  Grupos de assunto com mais de um mercado (vai para a coluna radar_subject,\n` +
          '  nenhum é descartado — quem agrupa na hora de medir é a view):',
      );
      console.log(
        table(
          ['assunto', 'mercados'],
          grandes.slice(0, 15).map(g => [g.rotulo, String(g.n)]),
          [0],
        ),
      );
    }

    if (renovacao.espelhos.length > 0) {
      console.log(
        '\n  Espelhos detectados (YES somando 0,97–1,03 no mesmo evento). Os DOIS são coletados:\n' +
          '  a soma é propriedade que muda, e descartar por ela apagaria a série de um por causa\n' +
          '  do preço do outro. Quem colapsa o par é a view.',
      );
      console.log(
        table(
          ['mercado A', 'mercado B', 'soma'],
          renovacao.espelhos
            .slice(0, 10)
            .map(p => [
              p.a.market.question.slice(0, 46),
              p.b.market.question.slice(0, 46),
              p.soma.toFixed(2),
            ]),
          [0, 1],
        ),
      );
    }

    if (renovacao.tagsTruncadasAcimaDoCorte.length > 0) {
      console.log(
        '\n  AVISO: nestas tags sobrou mercado ACIMA do corte da categoria sem ser lido —\n' +
          '  o roster daquela categoria não é o que a regra diz que é. Aumentar as páginas por tag:\n' +
          `    ${renovacao.tagsTruncadasAcimaDoCorte.join('\n    ')}`,
      );
    }
    if (renovacao.tagsDesconhecidas.length > 0) {
      console.log(`\n  AVISO: tags que a Gamma não conhece: ${renovacao.tagsDesconhecidas.join(', ')}`);
    }
    if (renovacao.marcadosNoBanco !== null) {
      console.log(`\n  events com radar_tracked no banco: ${renovacao.marcadosNoBanco}`);
    }

    // O `--dry-run` não escreve, então o caminho do upsert só seria exercido em
    // produção. Isto confere as chaves contra uma linha real de `events`.
    const conferencia = await conferirPayload(renovacao.roster);
    console.log(
      conferencia === null
        ? '\n  payload de `events`: NÃO CONFERIDO (não deu para ler uma linha de amostra)'
        : conferencia.colunasFaltando.length === 0
          ? '\n  payload de `events`: todas as chaves existem como coluna'
          : `\n  payload de \`events\`: CHAVES SEM COLUNA — ${conferencia.colunasFaltando.join(', ')}\n` +
            '  Uma chave a mais derruba o chunk inteiro do upsert. Corrigir antes de ligar a flag.',
    );
  }

  if (lista && renovacao !== null) {
    console.log(section('2. Os mercados'));
    console.log(
      table(
        ['#', 'tema', 'assunto', 'vol 24h', 'preço', 'liquidez', 'prazo', 'pergunta'],
        renovacao.roster.map((c, i) => [
          String(i + 1),
          c.tema,
          c.assunto,
          usd(c.volume24h),
          c.preco === null ? '—' : c.preco.toFixed(2),
          usd(c.liquidez),
          (c.market.endDate ?? '—').slice(0, 10),
          c.market.question.slice(0, 70),
        ]),
        [0, 1, 2, 6, 7],
      ),
    );
  }

  if (foto !== null) {
    console.log(section('3. A foto'));
    console.log(
      table(
        ['medida', 'valor'],
        [
          ['mercados pedidos', String(foto.pedidos)],
          ['ausentes do lote de abertos', String(foto.ausentes)],
          ['fechados no lote de abertos', String(foto.fechados)],
          ['sem livro nos dois lados', String(foto.semLivro)],
          [dryRun ? 'linhas que seriam gravadas' : 'linhas gravadas', String(foto.linhas)],
        ],
        [0],
      ),
    );

    if (foto.amostra.length > 0) {
      console.log('\n  Amostra do que vai para `polymarket_snapshots`:');
      console.log(
        table(
          ['outcome', 'bid', 'ask', 'mid', 'spread', 'bid $', 'ask $', 'vol 24h'],
          foto.amostra.map(r => [
            r.outcome,
            r.best_bid?.toFixed(3) ?? '—',
            r.best_ask?.toFixed(3) ?? '—',
            r.mid_price?.toFixed(3) ?? '—',
            r.spread?.toFixed(3) ?? '—',
            r.bid_depth === null ? '—' : usd(r.bid_depth),
            r.ask_depth === null ? '—' : usd(r.ask_depth),
            r.volume_24h === null ? '—' : usd(r.volume_24h),
          ]),
          [0],
        ),
      );
    }
  }

  const gamma = (renovacao?.chamadas.gamma ?? 0) + (foto?.chamadas.gamma ?? 0);
  const clob = (renovacao?.chamadas.clob ?? 0) + (foto?.chamadas.clob ?? 0);

  console.log(section('Custo'));
  console.log(
    table(
      ['host', 'chamadas neste ciclo'],
      [
        ['gamma (renovação)', String(renovacao?.chamadas.gamma ?? 0)],
        ['gamma (foto)', String(foto?.chamadas.gamma ?? 0)],
        ['clob (foto)', String(foto?.chamadas.clob ?? 0)],
        ['total', String(gamma + clob)],
      ],
      [0],
    ),
  );
  console.log(
    `\n  Um ciclo que SÓ fotografa custa ${foto?.chamadas.gamma ?? 0} + ${foto?.chamadas.clob ?? 0} = ` +
      `${(foto?.chamadas.gamma ?? 0) + (foto?.chamadas.clob ?? 0)} chamadas.`,
  );
}

await main();
