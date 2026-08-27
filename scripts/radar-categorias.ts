import 'dotenv/config';
import { getSystemConfig } from '../src/lib/config.js';
import { readRules, readTemas } from '../src/collectors/radar-collector.js';
import {
  liquidezDe,
  montarRoster,
  triar,
  type RadarCandidate,
  type RadarMarketInput,
} from '../src/collectors/radar-selection.js';
import { fetchMarketsByTag, fetchTagIdBySlug } from '../src/lib/polymarket-api.js';
import type { GammaMarket } from '../src/types/index.js';

/**
 * Auditoria do mapeamento de CATEGORIA — a parte do coletor que ninguém conferiu.
 *
 * O coletor decide o que entra por tag da Gamma, e esse é o único critério de
 * coleta que depende de vocabulário de terceiro. Ele já deu sinal de que erra:
 * 20 mercados de esports chegaram pela tag de tecnologia.
 *
 * Duas perguntas, e a segunda é a que importa:
 *
 *   O que ENTROU em cada categoria, e por qual tag?
 *   O que ficou de FORA e estava perto de entrar?
 *
 * Coletar lixo é barato — a view esconde. Não coletar o que interessa é o erro
 * caro, porque histórico não se recupera: a API não devolve orderbook passado, e
 * o mercado que ninguém coletou em agosto não tem série em novembro.
 *
 * Por isso o relatório tem três seções de "fora", em ordem crescente de custo do
 * erro: o que o teto cortou (volta na próxima renovação se subir de liquidez), o
 * que a triagem descartou (nunca volta, mas foi por regra explícita), e o que
 * NENHUMA tag alcançou (nunca volta, e ninguém decidiu isso).
 *
 * Não escreve no banco e não é o coletor: monta o mesmo roster em memória, com a
 * mesma regra, e imprime. Uso:
 *
 *   npm run radar:categorias
 */

const LABEL = 'radar-categorias';
const OUT_FILE = 'probes/radar/categorias.md';
const GAMMA = process.env['POLYMARKET_GAMMA_URL'] ?? 'https://gamma-api.polymarket.com';

/** Cortesia com API pública: o mesmo espaçamento das sondas e do coletor. */
const SPACING_MS = 250;

/** Quantos ids de evento cabem numa chamada de `/events`. */
const TAG_BATCH = 20;

/** Quantos exemplos por seção. */
const N = 10;

/** Quantos mercados líquidos varrer FORA das tags, atrás de buraco no mapa. */
const PAGINAS_FORA = 6;

let lastCallAt = 0;
let chamadas = 0;

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

async function espacar(): Promise<void> {
  const wait = SPACING_MS - (Date.now() - lastCallAt);
  if (wait > 0) await sleep(wait);
  lastCallAt = Date.now();
  chamadas += 1;
}

function usd(v: number): string {
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 10_000) return `${(v / 1_000).toFixed(0)}k`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(1)}k`;
  return v.toFixed(0);
}

function celula(texto: string, max = 76): string {
  const limpo = texto.replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();
  return limpo.length > max ? `${limpo.slice(0, max - 1)}…` : limpo;
}

// ---------------------------------------------------------------------------
// Tags do evento — `/markets` não as embute
// ---------------------------------------------------------------------------

/**
 * As tags de cada evento, em lote de 20.
 *
 * É a única informação deste relatório que o coletor não tem: ele decide por
 * `tag_id` no servidor e nunca vê a lista de tags do que recebeu. Sem ela não dá
 * para responder "por qual tag este mercado entrou", que é a pergunta.
 */
async function buscarTags(eventIds: readonly string[]): Promise<Map<string, string[]>> {
  const mapa = new Map<string, string[]>();

  for (let i = 0; i < eventIds.length; i += TAG_BATCH) {
    const lote = eventIds.slice(i, i + TAG_BATCH);
    const query = [...lote.map(id => `id=${encodeURIComponent(id)}`), `limit=${TAG_BATCH}`].join('&');

    await espacar();
    const res = await fetch(`${GAMMA}/events?${query}`, { headers: { Accept: 'application/json' } });
    if (!res.ok) {
      console.error(`[${LABEL}] tags: HTTP ${res.status} no lote ${i}`);
      continue;
    }
    const corpo = (await res.json()) as unknown;
    if (!Array.isArray(corpo)) continue;

    for (const bruto of corpo) {
      if (typeof bruto !== 'object' || bruto === null) continue;
      const ev = bruto as { id?: unknown; tags?: unknown };
      const tags = Array.isArray(ev.tags)
        ? ev.tags
            .map(t => (typeof t === 'object' && t !== null ? String((t as { slug?: unknown }).slug ?? '') : ''))
            .filter(s => s !== '')
        : [];
      mapa.set(String(ev.id ?? ''), tags);
    }
  }

  return mapa;
}

function eventIdDe(m: RadarMarketInput): string {
  return m.events?.[0]?.id ?? '';
}

function tagsDe(m: RadarMarketInput, mapa: Map<string, string[]>): string {
  const tags = mapa.get(eventIdDe(m)) ?? [];
  return tags.length === 0 ? '—' : tags.join(', ');
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

interface Descartado {
  market: RadarMarketInput;
  motivo: string;
  liquidez: number;
}

async function main(): Promise<void> {
  const config = await getSystemConfig();
  const rules = readRules(config);
  const temas = readTemas(config);
  const agora = Date.now();
  const DIA = 24 * 60 * 60 * 1000;

  const endDateMin = new Date(agora).toISOString();
  const endDateMax = new Date(agora + rules.horizonMaxDays * DIA).toISOString();

  console.log(`[${LABEL}] baixando ${temas.length} categorias…`);

  // 1. O mesmo universo que o coletor baixa. Páginas fixas: este relatório não
  //    precisa da paginação que se corrige sozinha — ele precisa do que o
  //    coletor VÊ, e um extra por margem.
  const universo: Array<GammaMarket & { tema: string }> = [];
  const porTagOrigem = new Map<string, string>();

  for (const { tema, tags } of temas) {
    for (const slug of tags) {
      await espacar();
      const tagId = await fetchTagIdBySlug(slug);
      if (tagId === null) {
        console.error(`[${LABEL}] tag desconhecida: ${slug}`);
        continue;
      }

      for (let pagina = 0; pagina < 3; pagina++) {
        await espacar();
        const lote = await fetchMarketsByTag({
          tagId,
          endDateMin,
          endDateMax,
          minLiquidity: rules.minLiquidity,
          limit: 100,
          offset: pagina * 100,
          orderByLiquidity: true,
        });
        for (const m of lote) {
          if (!porTagOrigem.has(m.id)) porTagOrigem.set(m.id, slug);
          universo.push({ ...m, tema });
        }
        if (lote.length < 100) break;
      }
    }
  }

  // 2. A mesma regra do coletor, e os descartes por motivo — com o mercado
  //    inteiro, não só a contagem: aqui interessa QUEM caiu.
  const resultado = montarRoster(universo, rules, agora);

  const descartados: Descartado[] = [];
  const vistos = new Set<string>();
  for (const m of universo) {
    if (vistos.has(m.id)) continue;
    vistos.add(m.id);
    const t = triar(m, rules, agora);
    if (!t.ok) descartados.push({ market: m, motivo: t.motivo, liquidez: liquidezDe(m) });
  }

  // 3. O buraco no mapa: os mais líquidos da janela que NENHUMA tag alcançou.
  console.log(`[${LABEL}] varrendo o que está fora de todas as categorias…`);
  const forasteiros: GammaMarket[] = [];
  const conhecidos = new Set(universo.map(m => m.id));

  for (let pagina = 0; pagina < PAGINAS_FORA; pagina++) {
    await espacar();
    const query = new URLSearchParams({
      closed: 'false',
      active: 'true',
      archived: 'false',
      end_date_min: endDateMin,
      end_date_max: endDateMax,
      liquidity_num_min: String(rules.minLiquidity),
      limit: '100',
      offset: String(pagina * 100),
      order: 'liquidityNum',
      ascending: 'false',
    });
    const res = await fetch(`${GAMMA}/markets?${query.toString()}`, {
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) break;
    const lote = (await res.json()) as GammaMarket[];
    for (const m of lote) if (!conhecidos.has(m.id)) forasteiros.push(m);
    if (lote.length < 100) break;
  }

  // 4. As tags de tudo que vai ser impresso — e só disso. Buscar as tags do
  //    universo inteiro custaria centenas de chamadas para mostrar dezenas.
  const porCategoria = new Map<string, RadarCandidate[]>();
  for (const c of resultado.roster) {
    const lista = porCategoria.get(c.tema);
    if (lista === undefined) porCategoria.set(c.tema, [c]);
    else lista.push(c);
  }
  const cortadosPorCategoria = new Map<string, RadarCandidate[]>();
  for (const c of resultado.candidatos) {
    if (resultado.roster.includes(c)) continue;
    const lista = cortadosPorCategoria.get(c.tema);
    if (lista === undefined) cortadosPorCategoria.set(c.tema, [c]);
    else lista.push(c);
  }

  const paraImprimir = new Set<string>();
  const registrar = (m: RadarMarketInput): void => {
    const id = eventIdDe(m);
    if (id !== '') paraImprimir.add(id);
  };

  for (const [, lista] of porCategoria) for (const c of lista.slice(0, N)) registrar(c.market);
  for (const [, lista] of cortadosPorCategoria) {
    for (const c of [...lista].sort((a, b) => b.liquidez - a.liquidez).slice(0, N)) registrar(c.market);
  }
  for (const d of [...descartados].sort((a, b) => b.liquidez - a.liquidez).slice(0, N * 3)) {
    registrar(d.market);
  }
  for (const m of forasteiros.slice(0, N * 2)) registrar({ ...m, tema: '—' });

  console.log(`[${LABEL}] buscando tags de ${paraImprimir.size} eventos…`);
  const tags = await buscarTags([...paraImprimir]);

  // -------------------------------------------------------------------------
  // O relatório
  // -------------------------------------------------------------------------
  const linhas: string[] = [
    '# Radar: o mapeamento de categoria',
    '',
    `Lido em ${new Date(agora).toISOString()} por \`scripts/radar-categorias.ts\`. **Nada foi ` +
      'gravado.** Mesma regra do coletor, mesmo universo, rodada em memória.',
    '',
    'O que este arquivo existe para responder: o recorte por tag da Gamma está deixando de fora ' +
      'algo que interessa? Coletar lixo é barato: a view esconde. **Não coletar o que interessa ' +
      'é o erro caro**, porque a API não devolve orderbook histórico: o mercado que não foi ' +
      'coletado em agosto não tem série em novembro.',
    '',
    '## Como ler',
    '',
    '- **Entraram**: os mais líquidos de cada categoria, com as tags do evento. A tag que causou ' +
      'a classificação é a que aparece na coluna `via`.',
    '- **Perto de entrar**: os que o teto por categoria cortou, em ordem de liquidez. Estes ' +
      'voltam sozinhos se subirem de liquidez na próxima renovação.',
    '- **Descartados pela regra**: caíram na triagem. Não voltam, mas foi decisão explícita.',
    '- **Fora de todas as categorias**: a seção que importa. São os mercados mais líquidos da ' +
      'janela que NENHUMA tag do recorte alcançou. Se algo aqui interessa, o mapa está errado.',
    '',
    '## Resumo',
    '',
    '| categoria | tags | candidatos | no roster | liquidez do corte |',
    '| --- | --- | ---: | ---: | ---: |',
  ];

  for (const { tema, tags: slugs } of temas) {
    const stats = resultado.porCategoria[tema];
    linhas.push(
      `| ${tema} | \`${slugs.join('`, `')}\` | ${stats?.candidatos ?? 0} | ${stats?.roster ?? 0} | ` +
        `${stats?.liquidezDoCorte === null || stats === undefined ? '—' : usd(stats.liquidezDoCorte)} |`,
    );
  }

  linhas.push(
    '',
    `Universo baixado: ${universo.length} markets (${vistos.size} únicos). ` +
      `Passaram na regra: ${resultado.candidatos.length}. No roster: ${resultado.roster.length}.`,
    '',
    '### Descartes da regra, por motivo',
    '',
    '| motivo | markets |',
    '| --- | ---: |',
    ...Object.entries(resultado.descartes)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `| ${k} | ${v} |`),
    '',
  );

  for (const { tema, tags: slugs } of temas) {
    linhas.push(`## ${tema}`, '', `Tags: \`${slugs.join('`, `')}\``, '');

    const dentro = (porCategoria.get(tema) ?? []).slice(0, N);
    linhas.push(
      `### Entraram (${dentro.length})`,
      '',
      '| pergunta | liquidez | vol 24h | prazo | via | tags do evento |',
      '| --- | ---: | ---: | --- | --- | --- |',
    );
    for (const c of dentro) {
      linhas.push(
        `| ${celula(c.market.question)} | ${usd(c.liquidez)} | ${usd(c.volume24h)} | ` +
          `${(c.market.endDate ?? '—').slice(0, 10)} | \`${porTagOrigem.get(c.market.id) ?? '—'}\` | ` +
          `${celula(tagsDe(c.market, tags), 60)} |`,
      );
    }

    const perto = [...(cortadosPorCategoria.get(tema) ?? [])]
      .sort((a, b) => b.liquidez - a.liquidez)
      .slice(0, N);
    linhas.push(
      '',
      `### Perto de entrar: cortados pelo teto de ${rules.maxPorCategoria} (${perto.length})`,
      '',
      '| pergunta | liquidez | vol 24h | via | tags do evento |',
      '| --- | ---: | ---: | --- | --- |',
    );
    for (const c of perto) {
      linhas.push(
        `| ${celula(c.market.question)} | ${usd(c.liquidez)} | ${usd(c.volume24h)} | ` +
          `\`${porTagOrigem.get(c.market.id) ?? '—'}\` | ${celula(tagsDe(c.market, tags), 60)} |`,
      );
    }

    const caidos = descartados
      .filter(d => (d.market as { tema?: string }).tema === tema)
      .sort((a, b) => b.liquidez - a.liquidez)
      .slice(0, N);
    if (caidos.length > 0) {
      linhas.push(
        '',
        `### Descartados pela regra (${caidos.length} mais líquidos)`,
        '',
        '| pergunta | liquidez | motivo | tags do evento |',
        '| --- | ---: | --- | --- |',
      );
      for (const d of caidos) {
        linhas.push(
          `| ${celula(d.market.question)} | ${usd(d.liquidez)} | ${d.motivo} | ` +
            `${celula(tagsDe(d.market, tags), 50)} |`,
        );
      }
    }

    linhas.push('');
  }

  linhas.push(
    '## Fora de todas as categorias',
    '',
    `Os ${Math.min(N * 2, forasteiros.length)} mercados mais líquidos da janela de ` +
      `${rules.horizonMaxDays} dias que nenhuma tag do recorte alcançou. É aqui que um buraco no ` +
      'mapa aparece: se alguma destas linhas interessa, a categoria dela precisa de uma tag nova.',
    '',
    `Varridos ${PAGINAS_FORA * 100} mercados por liquidez decrescente; ${forasteiros.length} ` +
      'estavam fora do recorte.',
    '',
    '| pergunta | liquidez | prazo | tags do evento |',
    '| --- | ---: | --- | --- |',
  );

  for (const m of forasteiros.slice(0, N * 2)) {
    linhas.push(
      `| ${celula(m.question)} | ${usd(liquidezDe(m))} | ${(m.endDate ?? '—').slice(0, 10)} | ` +
        `${celula(tagsDe({ ...m, tema: '—' }, tags), 60)} |`,
    );
  }

  linhas.push('', `---`, '', `${chamadas} chamadas à Gamma.`, '');

  const { mkdir, writeFile } = await import('node:fs/promises');
  const { dirname } = await import('node:path');
  await mkdir(dirname(OUT_FILE), { recursive: true });
  await writeFile(OUT_FILE, linhas.join('\n'), 'utf8');

  console.log(`[${LABEL}] escrito: ${OUT_FILE} (${chamadas} chamadas)`);
}

await main();
