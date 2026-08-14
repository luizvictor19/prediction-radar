/**
 * A leitura da probabilidade declarada no `/register`.
 *
 * A pergunta é em PORCENTAGEM ("72") e a coluna é em 0–1 ("0.720"), e a
 * conversão mora aqui, num só lugar, porque é exatamente o tipo de fator 100
 * que se espalha e depois discorda de si mesmo. `prob_self` precisa sair na
 * mesma escala de `mid_price` e de `kelly({ probability })` — se as duas pontas
 * da subtração não falarem a mesma unidade, o edge sai 100× errado e ainda por
 * cima parece um número.
 *
 * Por que a pergunta é em % e a coluna em 0–1: pessoa pensa em "72%", e banco
 * precisa da escala que a conta usa. Traduzir na borda é mais barato que
 * traduzir toda vez que alguém for medir.
 */

export type LeituraProb =
  | { ok: true; prob: number; pct: number }
  | { ok: false; motivo: string };

/**
 * Lê "72", "72%", "72,5" ou "72.5" e devolve a probabilidade em 0–1.
 *
 * ## O que é aceito, e o que não é
 *
 * Aceita 0 a 100 inclusive. 0 e 100 são afirmações legítimas — e o Brier pune
 * uma certeza errada com o máximo possível, que é o comportamento certo. Barrar
 * as pontas seria opinião sobre o que o dono pode achar.
 *
 * NÃO aceita a escala 0–1 disfarçada. Digitar "0.72" querendo 72% devolve
 * 0,72% — e o programa não tem como saber a diferença, porque 0,72% é um valor
 * perfeitamente possível num mercado de cauda. Adivinhar aqui ("se for menor
 * que 1, deve ser fração") criaria um mercado inteiro impossível de registrar.
 *
 * A defesa contra esse erro de digitação não é código: é o resumo de
 * confirmação, que mostra `Probabilidade: 0.7%` antes de gravar. Erro visível
 * na tela é melhor que regra esperta no parser.
 *
 * Vírgula decimal é aceita porque o teclado é brasileiro e "72,5" é o que sai.
 */
export function lerProbabilidade(raw: string): LeituraProb {
  const limpo = raw.trim().replace(/%$/, '').replace(',', '.').trim();

  if (limpo === '') return { ok: false, motivo: 'vazio' };

  // Regex e não só `parseFloat`: `parseFloat('72abc')` devolve 72 sem reclamar,
  // e "72 ou 73" viraria 72 em silêncio.
  if (!/^\d+(\.\d+)?$/.test(limpo)) {
    return { ok: false, motivo: 'não é um número em %' };
  }

  const pct = Number(limpo);
  if (!Number.isFinite(pct)) return { ok: false, motivo: 'não é um número em %' };
  if (pct < 0 || pct > 100) return { ok: false, motivo: 'fora de 0–100' };

  // Arredonda para 3 casas, o grão da coluna `numeric(4,3)`. Sem isso, 33,33%
  // viraria 0.3333 e o Postgres arredondaria na gravação — o valor gravado
  // discordaria do valor confirmado na tela.
  const prob = Math.round((pct / 100) * 1000) / 1000;

  return { ok: true, prob, pct };
}

/** O texto da probabilidade no resumo de confirmação. */
export function formatarProb(prob: number): string {
  return `${(prob * 100).toFixed(1)}% (${prob.toFixed(3)})`;
}
