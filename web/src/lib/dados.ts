import { montarIndice, type IndiceDeBoilerplate, type LinhaDeTrecho } from './boilerplate';
import { chaveDaLinha } from './concordancia';
// `entrada.ts` imports nothing and reads no environment: its limit is safe in
// the browser bundle, and the CI canary scan is what proves it.
import { MAXIMO_DE_IDS } from './servidor/entrada';
import type { TextoGuardado } from './regulamento';
import type {
  Contradicao,
  ContagemDigest,
  CorpusCru,
  LeituraRegra,
  Leg,
  LinhaAchados,
  MercadoRadar,
  Previsao,
} from './tipos';

/**
 * The screen's access to the database, from the browser.
 *
 * Since issue 85 there is no database client here. Each function calls one
 * route handler under `/api`, which runs the query on the server with the
 * service key (`servidor/consultas.ts`) after checking the session. The
 * exported names and types are the ones the screens already used, so the
 * screens did not change.
 */

export type { Leg, Previsao };

/**
 * One call to a route. A 401 means the session ended (expired, or the password
 * changed): the browser goes back to the login page. Any other failure carries
 * the server's message, which for a query is the database's own.
 */
async function pedir<T>(caminho: string, init?: RequestInit): Promise<T> {
  const r = await fetch(caminho, { ...init, credentials: 'same-origin', cache: 'no-store' });
  if (r.status === 401) {
    window.location.assign('/entrar');
    throw new Error('a sessão acabou: entre de novo');
  }
  const corpo: unknown = await r.json().catch(() => null);
  if (!r.ok) {
    const erro = (corpo as { erro?: unknown } | null)?.erro;
    throw new Error(typeof erro === 'string' ? erro : `HTTP ${r.status} em ${caminho}`);
  }
  return corpo as T;
}

function enviar<T>(caminho: string, dados: unknown): Promise<T> {
  return pedir<T>(caminho, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(dados),
  });
}

export function lerRadar(): Promise<MercadoRadar[]> {
  return pedir('/api/radar');
}

export function lerContagens(): Promise<ContagemDigest[]> {
  return pedir('/api/contagens');
}

export function lerAchados(eventId: string): Promise<LinhaAchados[]> {
  return pedir(`/api/mercados/${encodeURIComponent(eventId)}/achados`);
}

export function lerLeituras(eventId: string, sha: string): Promise<LeituraRegra[]> {
  return pedir(
    `/api/mercados/${encodeURIComponent(eventId)}/leituras?sha=${encodeURIComponent(sha)}`,
  );
}

/**
 * O índice de frequência do gate de boilerplate — item 5, seção 7.
 *
 * Três leituras sobre o corpus INTEIRO, porque a pergunta que o gate responde é
 * sobre o corpus: em que fração dos regulamentos lidos esta passagem aparece.
 * Uma consulta por mercado não conseguiria responder isso.
 *
 * ## Por que no cliente, e não numa view
 *
 * A chave de contagem é `chaveDoGate`, e ela chama `mascararParaGate` — troca de
 * mês e número que existe só para juntar `December 31, 2026, 11:59 PM ET` com
 * `June 30, 2027, 11:59 PM ET` na mesma contagem. Fazer isso em SQL criaria uma
 * SEGUNDA implementação da máscara, e as duas divergiriam: o relatório de
 * medição e a tela passariam a discordar sobre o que é padrão da casa, em
 * silêncio. É o mesmo defeito que a réplica da view e a `normalizarTrecho`
 * duplicada já custaram.
 *
 * O custo medido em 23/08/2026 não compra esse risco de volta: 1264 linhas em
 * `market_rule_digests`, 3980 em `digest_pegadinhas`, 3252 em
 * `digest_ambiguidades` — cerca de 8,5 mil linhas, ~10 idas ao servidor pela
 * paginação de 500. Uma vez por sessão.
 *
 * Since issue 85 the three reads run on the server (`/api/corpus`) and arrive
 * as one response; the index is still built here, from those rows, because it
 * holds `Map`s and JSON does not carry them.
 *
 * ## Uma promessa em voo, reaproveitada
 *
 * O cache é de MÓDULO e guarda a promessa, não o resultado: duas telas abertas
 * ao mesmo tempo compartilham a mesma requisição em vez de disparar seis. Em
 * erro a promessa é descartada, para a próxima tela poder tentar de novo em vez
 * de herdar a falha para sempre.
 */
let indiceEmVoo: Promise<CorpusDigerido> | null = null;

/**
 * As duas coisas que a MESMA leitura do corpus produz.
 *
 * O gate agrupa pela chave MASCARADA — data e número viram marca, para juntar
 * as variantes do mesmo boilerplate. A fusão agrupa pela chave LITERAL, porque
 * mascarar ali fundiria dois prazos diferentes do mesmo regulamento. Chaves
 * diferentes, mesmas linhas: ler duas vezes seria pagar dobrado pelo mesmo
 * tráfego.
 */
export type CorpusDigerido = {
  indice: IndiceDeBoilerplate;
  /** Chave de identidade → os `digest_id` que apontaram aquele achado. */
  leiturasPorChave: Map<string, Set<string>>;
};

export function lerCorpusDigerido(): Promise<CorpusDigerido> {
  if (indiceEmVoo === null) {
    indiceEmVoo = carregarIndice().catch((e) => {
      indiceEmVoo = null;
      throw e;
    });
  }
  return indiceEmVoo;
}

async function carregarIndice(): Promise<CorpusDigerido> {
  const { digests, pegadinhas, ambiguidades } = await pedir<CorpusCru>('/api/corpus');

  const shaPorDigest = new Map(digests.map((d) => [d.id, d.description_sha256]));

  const linhas: LinhaDeTrecho[] = [];
  const leiturasPorChave = new Map<string, Set<string>>();

  for (const [tabela, filhas] of [
    ['pegadinha', pegadinhas],
    ['ambiguidade', ambiguidades],
  ] as const) {
    for (const f of filhas) {
      const sha = shaPorDigest.get(f.digest_id);
      // Filha sem digest é impossível pela FK; se aparecer, sumir em silêncio
      // encolheria o denominador e inflaria toda fração.
      if (sha === undefined) continue;

      // A contradição interna mora em `digest_ambiguidades`, marcada no `tipo`.
      // `digest_contradicoes` é outra coisa: o defeito agregado por TEXTO, que
      // a tela lê à parte para mostrar o alcance.
      const classe = f.tipo === 'contradicao_interna' ? 'contradicao' : tabela;

      linhas.push({ sha, classe, tipo: f.tipo, trecho: f.trecho });

      // A chave da FUSÃO é a literal, e o `sha` é o primeiro argumento dela:
      // fundir através de textos diferentes juntaria passagens de dois
      // regulamentos.
      const k = chaveDaLinha(sha, classe, f.tipo, f.trecho, f.trecho_conflito ?? null);
      if (k === null) continue;
      let set = leiturasPorChave.get(k);
      if (set === undefined) {
        set = new Set();
        leiturasPorChave.set(k, set);
      }
      set.add(f.digest_id);
    }
  }

  // O denominador é TODO texto lido, inclusive o que não produziu achado
  // nenhum: um texto lido e limpo é uma chance que a passagem teve de aparecer
  // e não apareceu.
  return { indice: montarIndice(linhas, [...shaPorDigest.values()]), leiturasPorChave };
}

/**
 * O alcance de cada contradição: em quantos mercados aquele defeito de texto
 * aparece. The ids go in batches, so a market with more findings than one
 * request takes still gets every one.
 */
export async function lerContradicoes(defeitoIds: string[]): Promise<Contradicao[]> {
  const lotes: string[][] = [];
  for (let i = 0; i < defeitoIds.length; i += MAXIMO_DE_IDS) {
    lotes.push(defeitoIds.slice(i, i + MAXIMO_DE_IDS));
  }
  const respostas = await Promise.all(
    lotes.map((ids) =>
      pedir<Contradicao[]>(`/api/contradicoes?ids=${ids.map(encodeURIComponent).join(',')}`),
    ),
  );
  return respostas.flat();
}

/** The market's CURRENT description; see `lerTextoDaRegra` in `servidor/consultas.ts`. */
export async function lerTextoDaRegra(eventId: string): Promise<string | null> {
  const r = await pedir<{ texto: string | null }>(
    `/api/mercados/${encodeURIComponent(eventId)}/texto`,
  );
  return r.texto;
}

/** The rule text stored under a hash -- `market_rule_texts`, issue #9. */
export function lerTextoGuardado(sha: string): Promise<TextoGuardado> {
  return pedir(`/api/textos/${encodeURIComponent(sha)}`);
}

/**
 * Grava a previsão: uma linha de `my_bets` SEM leg. The row is built on the
 * server, from a whitelist (`servidor/entrada.ts`); `placed_at` stays the
 * database's `now()`.
 */
export async function gravarPrevisao(p: Previsao): Promise<string> {
  return (await enviar<{ id: string }>('/api/previsoes', p)).id;
}

/** A operação, depois. `shares` is computed on the server. */
export async function gravarLeg(l: Leg): Promise<void> {
  await enviar('/api/legs', l);
}
