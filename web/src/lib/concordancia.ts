import { normalizarTrecho } from './dedup';
import type { Achado } from './tipos';

/**
 * A junção entre o achado da view e as leituras que o apontaram — etapa 6.
 *
 * `digest_achados_por_mercado` entrega `vezes_encontrado`, que é um NÚMERO, e
 * união de leituras não se calcula com números — `min(soma, leituras_do_texto)`
 * erra em 5,3% das fusões e sempre para cima. A dedup da seção 4 precisa do
 * CONJUNTO de `digest_id`, e ele só existe nas tabelas-filhas.
 *
 * ## Por que a chave não é o `achado_id`
 *
 * Ele é um md5 do Postgres, e reproduzi-lo em JS depende da collation usada no
 * `least`/`greatest` das contradições. O projeto já recusou esse caminho uma vez
 * (`scripts/medicoes/lib/digestao.ts`), e pelo mesmo motivo: é um jeito novo de
 * divergir, sem ninguém cobrando a divergência.
 *
 * A chave é a IDENTIDADE do achado, e as mesmas três funções a constroem dos
 * dois lados. Um lado que a construísse sozinho seria a segunda implementação
 * que este arquivo existe para não ter.
 *
 * ## Os achados continuam vindo da view
 *
 * Isto ANEXA; não reconstrói. Remontar os achados a partir das tabelas-filhas
 * significaria reimplementar a propagação por hash no navegador — uma segunda
 * réplica da view, e sem o `conferirContraView` cobrando como o script de
 * medição tem.
 */

/** O que a junção lê de um achado da view. */
type Identificavel = {
  classe: Achado['classe'];
  subtipos: string[] | null;
  trecho: string | null;
  trecho_conflito: string | null;
};

/**
 * A chave de identidade de UMA linha-filha, dentro de UM texto de regra.
 *
 * O `sha` é o primeiro argumento e não um prefixo que quem chama acrescenta:
 * duas passagens iguais em regulamentos diferentes são achados diferentes, e uma
 * chave sem o texto uniria as leituras dos dois. Sendo parâmetro, não há como
 * esquecer dele num dos lados da junção — que foi exatamente o defeito que a
 * primeira versão deste arquivo teve.
 *
 * As três classes se identificam diferente, e a diferença é a mesma que a view
 * usa:
 *
 * - **pegadinha** — só a passagem. A severidade fica FORA: duas leituras que
 *   discordam do peso da mesma passagem acharam um defeito, não dois, e a view
 *   as junta num achado só. Com a severidade na chave, metade das leituras não
 *   casaria e a concordância exibida cairia pela metade.
 * - **ambiguidade** — tipo E passagem. `fuso_ausente` e `data_ambigua` sobre a
 *   mesma passagem são dois defeitos dela.
 * - **contradição** — as DUAS passagens, ordenadas entre si. Sem ordenar,
 *   `A||B` e `B||A` seriam achados diferentes conforme a ordem em que o modelo
 *   as escreveu.
 *
 * `null` quando a linha não tem âncora suficiente para ser identificada.
 */
export function chaveDaLinha(
  sha: string,
  classe: Achado['classe'],
  tipo: string | null,
  trecho: string | null,
  trechoConflito: string | null,
): string | null {
  if (trecho === null || trecho.trim() === '') return null;
  const t = normalizarTrecho(trecho);

  if (classe === 'contradicao') {
    if (trechoConflito === null || trechoConflito.trim() === '') return null;
    const c = normalizarTrecho(trechoConflito);
    const [menor, maior] = t <= c ? [t, c] : [c, t];
    return `${sha}||${menor}||${maior}`;
  }

  if (classe === 'pegadinha') return `${sha}||pegadinha||${t}`;
  return `${sha}||ambiguidade||${tipo ?? ''}||${t}`;
}

/**
 * As chaves que um achado da VIEW pode ocupar.
 *
 * Plural por causa da ambiguidade: a view agrega `subtipos` das leituras, e cada
 * subtipo é uma identidade própria. Uma chave por subtipo, e a união das
 * leituras das duas — porque a leitura que citou a passagem como `fuso_ausente`
 * e a que citou como `data_ambigua` encontraram o mesmo defeito.
 *
 * Para pegadinha e contradição é sempre uma só: a severidade não identifica, e
 * a contradição não tem subtipo que conte.
 */
export function chavesDoAchado(sha: string, a: Identificavel): string[] {
  if (a.classe !== 'ambiguidade') {
    const k = chaveDaLinha(sha, a.classe, null, a.trecho, a.trecho_conflito);
    return k === null ? [] : [k];
  }

  const subtipos = (a.subtipos ?? []).length === 0 ? [null] : (a.subtipos as string[]);
  const chaves = subtipos
    .map(s => chaveDaLinha(sha, 'ambiguidade', s, a.trecho, a.trecho_conflito))
    .filter((k): k is string => k !== null);
  return [...new Set(chaves)];
}

/**
 * Anexa a cada achado o conjunto de leituras que o apontou.
 *
 * **O que não casa é DEVOLVIDO, nunca zerado.** Um conjunto vazio em silêncio
 * daria concordância `0/n` a um achado que a view afirma ter sido encontrado, e
 * a tela mostraria esse zero como se fosse medição. Concordância é o número mais
 * sensível desta tela: ela ordena a coluna esquerda, escolhe o veredito e decide
 * de qual achado a prosa da fusão sai.
 *
 * Quem chama reporta `semLeituras` — uma taxa de anexação abaixo de 100% é
 * defeito de junção, não característica dos dados.
 *
 * Não modifica a entrada.
 */
export function anexarLeituras<T extends Identificavel>(
  sha: string,
  achados: readonly T[],
  porChave: ReadonlyMap<string, Set<string>>,
): { comLeituras: (T & { leituras: string[] })[]; semLeituras: T[] } {
  const comLeituras: (T & { leituras: string[] })[] = [];
  const semLeituras: T[] = [];

  for (const a of achados) {
    const leituras = new Set<string>();
    for (const k of chavesDoAchado(sha, a)) for (const l of porChave.get(k) ?? []) leituras.add(l);

    if (leituras.size === 0) semLeituras.push(a);
    else comLeituras.push({ ...a, leituras: [...leituras] });
  }

  return { comLeituras, semLeituras };
}
