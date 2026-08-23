/**
 * O estado vazio de uma seção da tela de Regra — item 5, seção 5.
 *
 * Quatro situações, quatro frases diferentes, e **nenhuma delas é a ausência da
 * seção**. Some a seção e a ausência lê como "o sistema não olhou isto", que é
 * justamente o que ela não deveria comunicar quando olhou e não achou nada.
 *
 * A distinção que sustenta o tipo inteiro: **"lido e limpo" é informação
 * diferente de "não lido"**. Ela já existe no banco, no `somaDigest` devolvendo
 * `null` em vez de `0`, e a tela tem que honrar em vez de achatar as duas num
 * "nenhum" só.
 */
export type EstadoVazio =
  /** Ninguém leu este texto. Não se afirma limpeza nenhuma. */
  | { tipo: 'sem-leitura' }
  /** Lido, e o que existe veio de mercados irmãos — está no bloco recolhido. */
  | { tipo: 'so-herdados'; herdados: number }
  /** Lido e limpo, com o número de leituras que sustentam a afirmação. */
  | { tipo: 'limpo'; leituras: number };

/**
 * Qual estado vazio esta seção mostra, ou `null` quando ela tem conteúdo.
 *
 * A ordem das perguntas é a regra:
 *
 * 1. **Tem acusado?** Então não há estado vazio — a seção se mostra sozinha.
 * 2. **Foi lido?** Sem leitura, nada se afirma. Herdado NÃO conta como leitura:
 *    ele existe precisamente porque este mercado não foi lido, então usá-lo para
 *    dizer "lido e limpo" inverteria o significado dele.
 * 3. **Herdou alguma?** Então a seção diz QUANTAS e aponta o bloco recolhido.
 *    Dizer "nenhuma" aqui seria falso sobre o que a própria tela está exibindo
 *    logo abaixo — a afirmação velha que o `caa73b9` foi consertar.
 * 4. Sobrou lido e limpo, e o número de leituras vai junto: é o que separa uma
 *    limpeza medida de uma limpeza suposta.
 */
export function estadoVazio(p: {
  leituras: number;
  acusados: number;
  herdados: number;
}): EstadoVazio | null {
  if (p.acusados > 0) return null;
  if (p.leituras === 0) return { tipo: 'sem-leitura' };
  if (p.herdados > 0) return { tipo: 'so-herdados', herdados: p.herdados };
  return { tipo: 'limpo', leituras: p.leituras };
}
