import { bordaDePalavra } from './dedup';

/**
 * Destaque dentro do regulamento — etapa 3 do item 5.
 *
 * A coluna direita mostra o regulamento inteiro com a passagem de cada achado
 * marcada DENTRO dele, em vez de recortada. Esse é o ponto do desenho: recorte
 * fora de contexto é exatamente como a manchete engana, e mostrar a cláusula
 * onde ela vive é o antídoto.
 *
 * Puro: recebe o texto e os pedidos, devolve os segmentos e quem não pôde ser
 * localizado. Não sabe o que é React.
 */

/** O tom do destaque. `forte` muda o resultado, `clara` é padrão da casa. */
export type Marca = 'forte' | 'clara';

export type PedidoDeDestaque = {
  id: string;
  trecho: string | null;
  marca: Marca;
};

/**
 * Um pedaço do regulamento, já resolvido: ou tem uma marca, ou não tem.
 *
 * `ids` lista TODOS os achados que cobrem o pedaço, mesmo os que perderam o tom
 * para um mais forte. A marca escolhe a cor; ela não apaga quem mais estava ali.
 */
export type Segmento = {
  texto: string;
  marca: Marca | null;
  ids: string[];
};

/**
 * A âncora de cada achado: em que segmento o clique deve parar.
 *
 * O PRIMEIRO segmento de cada achado, porque sobreposição reparte um trecho em
 * vários e rolar até o segundo pedaço pararia no meio da frase.
 *
 * Devolve `índice → LISTA de ids`, e a lista é o ponto. Dois achados que citam a
 * mesma passagem — comum, e a razão de a segmentação existir — começam no mesmo
 * segmento. Um `Map<índice, id>` guardaria só um deles, e o outro perderia a
 * âncora em silêncio: o clique não encontraria elemento e não rolaria a lugar
 * nenhum, sem nada na tela dizendo por quê.
 */
export function ancorasDeSegmentos(segmentos: readonly Segmento[]): Map<number, string[]> {
  const primeiro = new Map<string, number>();
  for (const [i, s] of segmentos.entries())
    for (const id of s.ids) if (!primeiro.has(id)) primeiro.set(id, i);

  const porIndice = new Map<number, string[]>();
  for (const [id, i] of primeiro) {
    const lista = porIndice.get(i);
    if (lista === undefined) porIndice.set(i, [id]);
    else lista.push(id);
  }
  return porIndice;
}

/** Escapa o que é metacaractere de regex, para o trecho valer como literal. */
function escapar(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * O padrão de busca de um trecho: literal, com o espaço em branco frouxo.
 *
 * O `trecho` chega do modelo numa linha só e o regulamento tem quebra de linha
 * no meio da frase. `indexOf` cru não acha, e o achado viraria "não localizado"
 * por engano — uma falha inventada onde não houve nenhuma. Qualquer corrida de
 * espaço no trecho casa com qualquer corrida de espaço no texto.
 *
 * O resto é literal, e a busca é sensível à caixa DE PROPÓSITO. Afrouxar a
 * caixa acharia mais trechos e erraria em silêncio; não achar é visível, porque
 * o não localizado aparece na tela. Entre um destaque errado invisível e uma
 * falha de localização visível, esta função escolhe a segunda.
 */
function padraoDe(trecho: string): RegExp {
  return new RegExp(trecho.trim().split(/\s+/).map(escapar).join('\\s+'), 'g');
}

type Intervalo = { ini: number; fim: number; id: string; marca: Marca };

/**
 * Onde cada trecho aparece no regulamento, e quem não apareceu.
 *
 * ## Todas as ocorrências, não só a primeira
 *
 * Um mesmo `11:59 PM ET` pode aparecer duas vezes no mesmo regulamento. Marcar
 * só a primeira deixaria a segunda, idêntica, sem marca logo ao lado — e isso se
 * lê como defeito da tela, não como decisão.
 *
 * ## Borda de palavra
 *
 * Mesma razão de `contemTrecho` na dedup, e o MESMO predicado importado de lá:
 * sem a borda, `et` casa dentro de `market` e a coluna fica pintada de ruído.
 */
function localizar<T extends PedidoDeDestaque>(
  regulamento: string,
  pedidos: readonly T[],
): { intervalos: Intervalo[]; naoLocalizados: T[] } {
  const intervalos: Intervalo[] = [];
  const naoLocalizados: T[] = [];

  for (const p of pedidos) {
    if (p.trecho === null || p.trecho.trim() === '') {
      naoLocalizados.push(p);
      continue;
    }

    const padrao = padraoDe(p.trecho);
    let achou = false;
    for (let m = padrao.exec(regulamento); m !== null; m = padrao.exec(regulamento)) {
      const ini = m.index;
      const fim = ini + m[0].length;
      if (!bordaDePalavra(regulamento, ini - 1) || !bordaDePalavra(regulamento, fim)) continue;
      intervalos.push({ ini, fim, id: p.id, marca: p.marca });
      achou = true;
    }

    if (!achou) naoLocalizados.push(p);
  }

  return { intervalos, naoLocalizados };
}

/**
 * O regulamento repartido em segmentos, com quem não coube fora.
 *
 * ## Sobreposição vira segmentação, e o tom forte vence
 *
 * A dedup do item 2 funde sobreposição dentro do mesmo tipo, mas nada impede que
 * uma armadilha `muda_resultado` e um trecho de boilerplate se sobreponham — é o
 * caso comum, aliás: a data com fuso é as duas coisas.
 *
 * `<mark>` não aninha em HTML, então isto NÃO devolve intervalos aninhados para
 * o componente achatar por conta própria. Devolve uma sequência plana: cada
 * fronteira de intervalo abre um segmento novo, e no pedaço compartilhado vence
 * `forte`. "Isto muda o resultado" é a informação que não pode ser encoberta por
 * "isto é padrão de todo regulamento" — a segunda é contexto, a primeira é o
 * motivo de a tela existir.
 *
 * ## Nada some
 *
 * `naoLocalizados` é a razão de esta função devolver duas coisas. Sem ela, a
 * coluna mostraria menos destaques do que a esquerda mostra achados, e ninguém
 * contaria os dois lados para perceber. Quem chama tem que exibir a marca de
 * "trecho não localizado no texto" — o achado continua na tela, dizendo que a
 * âncora dele não bateu.
 *
 * A concatenação dos segmentos é o regulamento, caractere por caractere. É P1: o
 * regulamento é a maior citação da tela e não se reescreve para caber.
 */
export function destacar<T extends PedidoDeDestaque>(
  regulamento: string,
  pedidos: readonly T[],
): { segmentos: Segmento[]; naoLocalizados: T[] } {
  const { intervalos, naoLocalizados } = localizar(regulamento, pedidos);

  if (regulamento === '') return { segmentos: [], naoLocalizados };
  if (intervalos.length === 0) {
    return { segmentos: [{ texto: regulamento, marca: null, ids: [] }], naoLocalizados };
  }

  // Cada ponta de intervalo é uma fronteira. Entre duas fronteiras vizinhas a
  // cobertura é constante, que é o que torna o resultado plano por construção.
  const fronteiras = [...new Set([0, regulamento.length, ...intervalos.flatMap(i => [i.ini, i.fim])])]
    .filter(i => i >= 0 && i <= regulamento.length)
    .sort((a, b) => a - b);

  const segmentos: Segmento[] = [];
  for (let k = 0; k + 1 < fronteiras.length; k++) {
    const ini = fronteiras[k] as number;
    const fim = fronteiras[k + 1] as number;
    if (fim <= ini) continue;

    const cobrindo = intervalos.filter(i => i.ini <= ini && i.fim >= fim);
    segmentos.push({
      texto: regulamento.slice(ini, fim),
      marca: cobrindo.length === 0 ? null : cobrindo.some(i => i.marca === 'forte') ? 'forte' : 'clara',
      ids: [...new Set(cobrindo.map(i => i.id))].sort(),
    });
  }

  return { segmentos, naoLocalizados };
}
