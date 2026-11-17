import { filtrarDigeriveis, type Descarte, type MercadoFiltravel } from '../../src/digest/queue.js';

// `filtrarDigeriveis` and its types lived here until issue 93. They now live in
// `src/digest/queue.ts`, so the scheduled run filters with the SAME function;
// the reasoning below about who filters still holds.
export {
  filtrarDigeriveis,
  SEM_STATUS,
  type Descarte,
  type MercadoFiltravel,
} from '../../src/digest/queue.js';

/**
 * Quem entra na fila que PAGA modelo, e quem fica de fora.
 *
 * O filtro mora aqui e não em `readMarketsToDigest` porque a função tem três
 * consumidores com propósitos diferentes e só um deles deve filtrar:
 *
 * - `digerir-regras.ts`, montando a fila da corrida: filtra (issue #4);
 * - `nivelar-leituras.ts`, procurando UM mercado que carregue cada texto abaixo
 *   do mínimo de leituras: filtra, pelo mesmo motivo;
 * - `digerir-regras.ts` nos modos `--comparar` e `--amostra-de`: NÃO filtra. Os
 *   dois ancoram num artefato antigo e respondem sobre os mercados que aquela
 *   rodada viu. Encolher o conjunto ali mudaria o denominador de um relatório
 *   retrospectivo em silêncio.
 *
 * Este módulo não importa o cliente do banco, e é por isso que ele tem teste
 * sem rede: `src/digest/store.ts` conecta ao Supabase no import.
 */

/**
 * A fila da corrida: fora os excluídos por artefato, fora os que já têm
 * desfecho.
 *
 * A ordem importa e é a de sempre: os dois filtros entram ANTES do corte da
 * fatia do degrau. Cortar primeiro e filtrar depois devolveria menos mercados
 * que o degrau pede, em silêncio.
 *
 * Recebe a lista JÁ embaralhada. Filtrar depois do sorteio e não antes mantém a
 * permutação estável: o embaralhamento é Fisher-Yates com semente fixa sobre a
 * lista inteira, então mudar o COMPRIMENTO da entrada mudaria a ordem de todo
 * mundo, e o cabeçalho de todo artefato promete "mesma semente, mesma lista".
 */
export function montarElegiveis<T extends MercadoFiltravel>(
  embaralhados: readonly T[],
  excluidos: ReadonlySet<string>,
): Descarte<T> {
  return filtrarDigeriveis(embaralhados.filter((m) => !excluidos.has(m.eventId)));
}

/** Uma linha para o log da corrida. Vazio quando nada saiu. */
export function resumoDoDescarte(descartados: ReadonlyMap<string, number>): string {
  if (descartados.size === 0) return '';
  const total = [...descartados.values()].reduce((s, n) => s + n, 0);
  const porStatus = [...descartados]
    .sort((a, b) => b[1] - a[1])
    .map(([status, n]) => `${status}: ${n}`)
    .join(', ');
  return `${total} mercados fora da fila por já terem desfecho (${porStatus})`;
}
