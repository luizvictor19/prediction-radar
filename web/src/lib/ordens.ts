import type { MercadoNaLista } from './tipos';
import { somaDigest } from './regras';

/**
 * As ordens da lista — dados, não componente.
 *
 * Mora aqui e não em `Hoje.tsx` por duas razões. A de desenho: a constante é
 * dado sobre como ordenar, e não marcação; nada nela precisa de React. A
 * prática: `Hoje.test.ts` importava o componente só para alcançá-la, e com isso
 * o `npm test` da raiz passava a depender de `react`, que só está declarado em
 * `web/package.json`. Localmente funcionava porque `web/node_modules` existe;
 * num clone limpo o teste morria com `ERR_MODULE_NOT_FOUND`.
 *
 * REGRA INEGOCIÁVEL: ordenar por FATO, nunca por nota. Ver `Hoje.test.ts`, que
 * é quem trava isso.
 */

export type Ordem = 'prazo' | 'var24' | 'var7d' | 'contradicao' | 'liquidez';

/**
 * Uma opção do seletor de ordenação.
 *
 * `fato` não é decoração: é a coluna que esta ordem lê, declarada ao lado do
 * extrator para que uma opção nova tenha de dizer por qual FATO ordena. É o que
 * `Hoje.test.ts` verifica, e é a única defesa contra alguém acrescentar
 * "mais promissores" ao seletor sem ninguém reparar.
 */
export interface OpcaoDeOrdem {
  chave: Ordem;
  rotulo: string;
  /** A coluna lida. Nunca `prob_self`: a nota do dono não ordena a lista. */
  fato: string;
  dir: 'asc' | 'desc';
  valor: (m: MercadoNaLista) => number | null;
}

export const ORDENS: OpcaoDeOrdem[] = [
  {
    chave: 'prazo',
    rotulo: 'vence em breve',
    fato: 'dias_restantes',
    dir: 'asc',
    valor: m => m.dias_restantes,
  },
  {
    chave: 'var24',
    rotulo: 'maior variação em 24h',
    fato: 'var_24h',
    dir: 'desc',
    // Módulo: cair 11 pontos é o mesmo tamanho de movimento que subir 11, e a
    // direção é opinião sobre o que é bom.
    valor: m => (m.var_24h === null ? null : Math.abs(m.var_24h)),
  },
  {
    chave: 'var7d',
    rotulo: 'maior variação em 7d',
    fato: 'var_7d',
    dir: 'desc',
    valor: m => (m.var_7d === null ? null : Math.abs(m.var_7d)),
  },
  {
    chave: 'contradicao',
    rotulo: 'tem contradição interna',
    fato: 'contradicoes',
    dir: 'desc',
    valor: m => somaDigest(m, 'contradicoes'),
  },
  {
    chave: 'liquidez',
    rotulo: 'maior liquidez',
    fato: 'liquidez',
    dir: 'desc',
    valor: m => m.liquidez,
  },
];
