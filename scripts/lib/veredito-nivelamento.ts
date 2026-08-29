/**
 * The verdict of a levelling run, decided from counts alone.
 *
 * It lives here, apart from `nivelar-leituras.ts`, so it can be tested without
 * the network: that script talks to the database and the model on import. The
 * set building stays there, the decision is here, and the seam is the three
 * numbers the decision actually depends on.
 *
 * ## The two sample floors, and why there are two
 *
 * They guard different failures, and neither implies the other.
 *
 * `MINIMO_TEXTOS` is the independent-observation floor. The unit is the TEXT,
 * for the reason `ReliabilityBucket.distinctMatches` gives about matches: two
 * findings in one text share one reading and one regulation, so they are not
 * two observations. Twenty texts with a stable ratio still say nothing if they
 * are one text wearing twenty coats.
 *
 * `MINIMO_ACHADOS` is the denominator floor. `ganhoPct` divides by `antes`, so
 * with `antes = 1` a single new finding prints 100%. That is arithmetic, not
 * evidence, and it is the case the issue was opened about. A run can clear the
 * text floor and fail this one: twenty texts holding one finding each give
 * `antes = 20`, and one paraphrase per text doubles it.
 *
 * Measured on 29/08/2026, the 73 texts below the reading minimum carry 622
 * distinct findings, mean 8.52, range 3 to 38. So on today's corpus the
 * findings floor rarely binds on its own. It is here because nothing enforces
 * that distribution, and the degenerate shape is exactly the one that produced
 * the verdict this gate exists to stop.
 *
 * ## Two things this gate does NOT do, stated because both are easy to assume
 *
 * **The 20 is not measured.** It is borrowed from `MIN_N_FOR_SIGNAL` and
 * `MIN_MATCHES_FOR_BUCKET` in `src/eval/`, which is this repository's number
 * for "distinct units behind a percentage". What would earn a number here is
 * what `digerir-regras` did for its own 100: run the levelling twice over
 * identical input and read the spread between runs. Until that exists, 20 is a
 * floor chosen by analogy, and a verdict just above it deserves the same
 * suspicion as one just below.
 *
 * **It does not fix the monotonicity.** `depois` is a union with `velhas`, so
 * `ganhoPct` can never be negative: more readings can only add keys. And the
 * finding key tolerates spelling, not paraphrase, so a second reading that
 * quotes the same passage in other words mints a new key and lifts the ratio
 * without any recall having improved. A sample floor makes a biased estimator
 * confident on more data instead of less. That is issue #30, and this gate is
 * not its fix.
 */

export const MINIMO_TEXTOS_PARA_JULGAR = 20;
export const MINIMO_ACHADOS_PARA_JULGAR = 20;

/**
 * The verdict as a value, so callers can assert on it without reading prose.
 *
 * `amostra_curta` comes first for the reason `bucketVerdict` names: sample
 * first, bar afterwards. A run below the floor has not earned the right to
 * answer, and saying "confirms, with a caveat" is how a clean report becomes a
 * wrong decision.
 */
export type ClasseDoVeredito =
  | 'amostra_curta'
  | 'sem_base'
  | 'confirma'
  | 'achado_nao_fracasso'
  | 'inconclusivo';

export interface VereditoDoNivelamento {
  classe: ClasseDoVeredito;
  ganhoPct: number | null;
  frase: string;
}

/**
 * @param textos  distinct texts that received at least one new reading
 * @param antes   distinct findings across those texts before the run
 * @param depois  distinct findings across those texts after the union
 */
export function vereditoDoNivelamento(
  textos: number,
  antes: number,
  depois: number,
): VereditoDoNivelamento {
  // `null` and not 0 when there was nothing before: 0 -> 5 is not "a 0%
  // increase", and printing 0% would make the criterion say the opposite of
  // what happened.
  const ganhoPct = antes > 0 ? ((depois - antes) / antes) * 100 : null;

  // The order is the rule: sample first, bar afterwards.
  if (textos < MINIMO_TEXTOS_PARA_JULGAR || antes < MINIMO_ACHADOS_PARA_JULGAR) {
    return {
      classe: 'amostra_curta',
      ganhoPct,
      frase:
        `INCONCLUSIVO POR AMOSTRA: ${textos} textos (mínimo ${MINIMO_TEXTOS_PARA_JULGAR}) e ` +
        `${antes} achados distintos antes (mínimo ${MINIMO_ACHADOS_PARA_JULGAR}).\n` +
        '  Uma amostra abaixo do piso não responde "o nivelamento valeu": o percentual existe,\n' +
        '  mas com denominador pequeno ele é aritmética, e com poucos textos ele é um texto\n' +
        '  falando por todos. O número acima fica na tabela para ser olhado, não para concluir.',
    };
  }

  // Unreachable through its own condition, because `antes === 0` fails the
  // findings floor first. It stays because the compiler needs the null
  // narrowed, and because the two say different things if a floor is lowered.
  if (ganhoPct === null) {
    return {
      classe: 'sem_base',
      ganhoPct,
      frase:
        'INCONCLUSIVO: não havia achado nenhum antes nestes textos, então não há razão a calcular.',
    };
  }

  if (ganhoPct >= 30) {
    return {
      classe: 'confirma',
      ganhoPct,
      frase:
        'CONFIRMA: >= 30% de achados distintos a mais. O diagnóstico de recall vale também para os\n' +
        '  textos únicos, e o nivelamento valeu o que custou.',
    };
  }

  if (ganhoPct < 10) {
    return {
      classe: 'achado_nao_fracasso',
      ganhoPct,
      frase:
        'ACHADO, NÃO FRACASSO: < 10% a mais. O recall baixo era propriedade dos textos REPETIDOS,\n' +
        '  não uma lei geral: para regra única, uma leitura basta. O projeto passa a saber isso,\n' +
        '  e o custo de descobrir foi o desta rodada.',
    };
  }

  return {
    classe: 'inconclusivo',
    ganhoPct,
    frase:
      'INCONCLUSIVO: entre 10% e 30%. Não sustenta nem "o recall é geral" nem "uma leitura basta".',
  };
}
