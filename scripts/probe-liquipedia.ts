import 'dotenv/config';
import {
  query,
  and,
  eq,
  or,
  budget,
  describeConfig,
  readConfig,
  HOURLY_LIMIT,
  PROCESS_HOURLY_LIMIT,
  LiquipediaError,
} from '../src/lib/liquipedia-api.js';

/**
 * Sonda da LiquipediaDB API v3 — a PRIMEIRA requisição real que este projeto faz.
 *
 * Existe porque o cliente em `src/lib/liquipedia-api.ts` foi escrito contra a
 * documentação pública e contra clientes da comunidade, e não contra a API: o
 * documento oficial (api.liquipedia.net/documentation) exige chave para ser
 * lido. O parsing lá é defensivo por causa disso, e este script é o que troca
 * suposição por medida. Rode-o antes de ligar
 * `esports_enricher_liquipedia_enabled`.
 *
 * O que ele imprime é a resposta CRUA de cada datapoint, para conferir três
 * coisas que o enricher assume:
 *
 *   1. a envelopagem (`{ result: [...] }` ou lista crua);
 *   2. os nomes dos campos (`pagename`, `joindate`, `match2opponents`, `winner`);
 *   3. se `[[opponent::A]] AND [[opponent::B]]` de fato casa partida entre os dois.
 *
 * ## Antes de rodar
 *
 * Duas variáveis de ambiente, e os termos de uso exigem as duas:
 *
 *   LIQUIPEDIA_API_KEY=...
 *   LIQUIPEDIA_USER_AGENT="prediction-radar/0.1 (https://seu-site; seu@email)"
 *
 * O User-Agent tem que identificar o projeto E ter contato — os termos dizem
 * que agente genérico "is likely to be blocked". Não há default aqui de
 * propósito: um default seria genérico por definição.
 *
 * ## Orçamento
 *
 * Este processo tem contador próprio, separado do processo do job. Os termos
 * dão 60 requisições por hora no TOTAL, e o job se limita a 50 justamente para
 * deixar 10 para isto. Uma passada completa da sonda gasta 4.
 *
 * Uso:
 *   npm run liquipedia:probe -- --team-a="Natus Vincere" --team-b="FaZe Clan"
 *   npm run liquipedia:probe -- --wiki=counterstrike --team-a="G2 Esports" --team-b="Vitality"
 */

const LABEL = 'probe-liquipedia';

function flag(name: string): string | null {
  const hit = process.argv.slice(2).find(arg => arg === `--${name}` || arg.startsWith(`--${name}=`));
  if (hit === undefined) return null;
  const [, value] = hit.split('=');
  return value ?? '';
}

function show(title: string, rows: readonly Record<string, unknown>[]): void {
  console.log(`\n[${LABEL}] ===== ${title} =====`);
  const keys = Object.keys(rows[0] ?? {}).join(', ');
  console.log(`  ${rows.length} linha(s). Chaves da primeira: ${keys.length > 0 ? keys : '(nenhuma)'}`);
  console.log(JSON.stringify(rows.slice(0, 3), null, 2));
}

async function step(
  title: string,
  run: () => Promise<Record<string, unknown>[]>,
): Promise<Record<string, unknown>[]> {
  try {
    const rows = await run();
    show(title, rows);
    return rows;
  } catch (err) {
    if (err instanceof LiquipediaError) {
      console.error(`\n[${LABEL}] ${title} FALHOU: ${err.kind} — ${err.message}`);
      if (err.kind === 'rate_limited') process.exit(1);
      return [];
    }
    throw err;
  }
}

async function main(): Promise<void> {
  if (readConfig() === null) {
    console.error(
      `[${LABEL}] credenciais ausentes (${describeConfig()}).\n` +
        `[${LABEL}] Os termos da Liquipedia exigem User-Agent identificável com contato:\n` +
        `[${LABEL}]   LIQUIPEDIA_USER_AGENT="prediction-radar/0.1 (https://seu-site; seu@email)"\n` +
        `[${LABEL}] A chave da LPDB não é self-service: é pedida em https://api.liquipedia.net\n` +
        `[${LABEL}] e o acesso NÃO é concedido a projeto relacionado a apostas — leia isso antes de pedir.`,
    );
    process.exit(1);
  }

  const wiki = flag('wiki') ?? 'counterstrike';
  const teamA = flag('team-a');
  const teamB = flag('team-b');

  if (teamA === null || teamB === null || teamA.length === 0 || teamB.length === 0) {
    console.error(`[${LABEL}] uso: --team-a="Natus Vincere" --team-b="FaZe Clan" [--wiki=counterstrike]`);
    process.exit(1);
  }

  console.log(
    `[${LABEL}] wiki=${wiki} A=${JSON.stringify(teamA)} B=${JSON.stringify(teamB)}\n` +
      `[${LABEL}] limite dos termos: ${HOURLY_LIMIT}/h. Teto do job: ${PROCESS_HOURLY_LIMIT}/h. ` +
      `Esta sonda gasta 4.`,
  );

  const teams = await step('team (resolução de identidade)', () =>
    query({
      wiki,
      datapoint: 'team',
      conditions: or(eq('name', teamA), eq('name', teamB)),
      query: 'name,pagename',
      limit: 10,
      cacheSeconds: 0,
    }),
  );

  const pageOf = (name: string): string => {
    const hit = teams.find(
      row => typeof row['name'] === 'string' && (row['name'] as string).toLowerCase() === name.toLowerCase(),
    );
    const page = typeof hit?.['pagename'] === 'string' ? (hit['pagename'] as string) : null;
    if (page === null) {
      console.warn(`[${LABEL}] "${name}" não resolveu para uma página — usando o nome como página.`);
    }
    return page ?? name;
  };

  const pageA = pageOf(teamA);
  const pageB = pageOf(teamB);

  await step('squadplayer (roster, com joindate/leavedate)', () =>
    query({
      wiki,
      datapoint: 'squadplayer',
      conditions: or(eq('pagename', pageA), eq('pagename', pageB)),
      query: 'pagename,id,name,link,role,position,joindate,leavedate',
      limit: 20,
      cacheSeconds: 0,
    }),
  );

  await step('match2 (confronto direto — conferir se o AND de dois opponent casa)', () =>
    query({
      wiki,
      datapoint: 'match2',
      conditions: and(eq('opponent', pageA), eq('opponent', pageB)),
      query: 'date,winner,bestof,tournament,parent,pagename,match2opponents',
      limit: 5,
      order: 'date DESC',
      cacheSeconds: 0,
    }),
  );

  await step('match2 (forma recente do lado A)', () =>
    query({
      wiki,
      datapoint: 'match2',
      conditions: eq('opponent', pageA),
      query: 'date,winner,bestof,tournament,parent,pagename,match2opponents',
      limit: 5,
      order: 'date DESC',
      cacheSeconds: 0,
    }),
  );

  console.log(
    `\n[${LABEL}] fim. Restam ${budget.remaining()} requisições no contador DESTE processo.\n` +
      `[${LABEL}] Confira acima: envelopagem, nomes de campo e se o h2h voltou partida entre os dois.\n` +
      `[${LABEL}] Divergência em qualquer um dos três é ajuste em src/lib/liquipedia-api.ts ou\n` +
      `[${LABEL}] src/verticals/enrichers/liquipedia.ts ANTES de ligar a config.`,
  );
}

main().catch(err => {
  console.error(`[${LABEL}] Fatal:`, err);
  process.exit(1);
});
