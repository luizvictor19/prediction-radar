/**
 * Prompts versionados do agente analista (spec 001).
 *
 * As versões convivem no código de propósito. `analyst_prompt_version` em
 * `system_config` escolhe qual roda, e é isso que torna o rollback um UPDATE em
 * vez de um redeploy do commit anterior — mas só funciona enquanto a versão
 * antiga continuar aqui. Remover uma versão do registro é o que a config chama
 * de quebra: o job recusa rodar com versão desconhecida em vez de cair na
 * `v1` silenciosamente.
 */

// ---------------------------------------------------------------------------
// O que o modelo recebe
// ---------------------------------------------------------------------------

export interface PromptFragment {
  /** Rótulo curto usado na citação: `F1`, `F2`, ... */
  label: string;
  enricherId: string;
  kind: string;
  asOf: string;
  observedAt: string;
  confidence: number;
  summary: string;
  payload: unknown;
}

export interface PromptInput {
  matchSlug: string;
  verticalId: string;
  /** O lado a que a probabilidade se refere. */
  teamA: string;
  teamB: string;
  bestOf: number | null;
  stage: string | null;
  league: string | null;
  scheduledAt: string | null;
  /** Instante da análise. Tudo abaixo foi observado até aqui, e nada depois. */
  asOf: string;
  /** Minutos até o início. Negativo = a partida já começou. */
  minutesToStart: number | null;
  market: { mid: number | null; liquidity: number | null; spread: number | null };
  fragments: readonly PromptFragment[];
}

export interface BuiltPrompt {
  system: string;
  user: string;
}

export type PromptBuilder = (input: PromptInput) => BuiltPrompt;

// ---------------------------------------------------------------------------
// O schema de saída
// ---------------------------------------------------------------------------

/**
 * Schema da resposta, aplicado via `output_config.format` (structured outputs).
 *
 * A API garante a FORMA — chaves presentes, tipos certos, nada a mais. O que
 * ela não garante é FAIXA: restrições numéricas (`minimum`, `maximum`) não são
 * suportadas em structured outputs e o SDK as remove do schema antes de enviar.
 * Por isso `probability` fora de [0,1] só é pego por `parseAnalysis`, e por isso
 * aquela validação não é redundante com esta.
 */
export const ANALYSIS_SCHEMA = {
  type: 'object',
  properties: {
    abstain: {
      type: 'boolean',
      description:
        'true quando o contexto não sustenta uma probabilidade honesta. Abster-se é uma resposta válida, não uma falha.',
    },
    abstain_reason: {
      type: ['string', 'null'],
      description: 'Uma frase dizendo o que falta. Obrigatório quando abstain = true.',
    },
    probability: {
      type: ['number', 'null'],
      description:
        'P(time A vence a série), entre 0 e 1. null quando abstain = true.',
    },
    confidence: {
      type: ['number', 'null'],
      description:
        'Confiança na própria probabilidade, entre 0 e 1. null quando abstain = true.',
    },
    thesis: {
      type: ['string', 'null'],
      description: '2 a 4 frases. null quando abstain = true.',
    },
    claims: {
      type: 'array',
      description:
        'Uma entrada por afirmação factual da tese, com o rótulo do fragmento que a sustenta.',
      items: {
        type: 'object',
        properties: {
          claim: {
            type: 'string',
            description: 'A afirmação, como ela aparece na tese.',
          },
          fragment: {
            type: 'string',
            description: 'O rótulo do fragmento que a sustenta: F1, F2, ...',
          },
        },
        required: ['claim', 'fragment'],
        additionalProperties: false,
      },
    },
  },
  required: ['abstain', 'abstain_reason', 'probability', 'confidence', 'thesis', 'claims'],
  additionalProperties: false,
} as const;

// ---------------------------------------------------------------------------
// v1
// ---------------------------------------------------------------------------

/**
 * O system prompt.
 *
 * Escrito para um modelo que já é calibrado e já verifica o próprio trabalho —
 * sem "seja rigoroso", sem "confira antes de responder", sem "pense passo a
 * passo". Instrução de auto-verificação, nos modelos atuais, produz
 * sobre-verificação e mais token, não mais acerto.
 *
 * O que sobra é o que só quem escreveu o sistema sabe: o que é um fragmento, por
 * que o preço de mercado é adversário e não referência, e qual é a régua de
 * abstenção.
 */
const V1_SYSTEM = `Você é um analista de mercados de apostas de esports. Recebe o contexto de UMA partida e devolve a probabilidade de o time A vencer a série.

## O que você recebe

Fragmentos de contexto, cada um com um rótulo (F1, F2, ...), a fonte que o produziu e uma confiança de 0 a 1. Todos foram observados até o instante da análise e nenhum depois — o que você tem é exatamente o que se sabia naquele momento.

Confiança baixa (≤ 0.4) marca fonte fraca. O fragmento do enricher \`polymarket-context\` é texto gerado por LLM da própria Polymarket, sem fonte citada: use como sinal de contexto, nunca como fato isolado. Um número que só aparece ali não sustenta uma tese.

## O preço de mercado

Você recebe o preço, a liquidez e o spread do mercado. O preço é a opinião agregada de quem está apostando — trate como um adversário informado, não como referência a ser reproduzida. Devolver a probabilidade que o mercado já mostra não é análise; se você concorda com o mercado, diga isso na tese e mantenha a probabilidade onde ela está.

Discordar é o produto. Discordar sem fundamento é o defeito.

## Abstenção

Abster-se é uma resposta válida e esperada. Abstenha-se quando os fragmentos não sustentam uma probabilidade honesta: contexto que só fala de preço e nada da partida, informação contraditória sem desempate, ou fonte fraca sendo a única evidência de tudo que importa.

Não invente convicção para preencher o formulário. Uma abstenção com motivo claro vale mais que uma probabilidade de 0.5 disfarçada de análise.

## Rastreabilidade

Cada afirmação factual da tese entra em \`claims\` com o rótulo do fragmento que a sustenta. Só cite rótulos que você recebeu. Uma afirmação sem fragmento correspondente não deve estar na tese — corte a frase ou encontre o fragmento.

Julgamento seu (a leitura do que os fatos significam) não é afirmação factual e não precisa de fragmento; fato citado precisa.

## A tese

De 2 a 4 frases. Comece pela conclusão, depois o que a sustenta. Escreva para quem vai decidir uma aposta em trinta segundos, não para quem quer acompanhar seu raciocínio. Sem preâmbulo, sem recapitular o que foi dado, sem enumerar o que você considerou e descartou.`;

function formatFragment(fragment: PromptFragment): string {
  return [
    `[${fragment.label}] ${fragment.enricherId} / ${fragment.kind}`,
    `  o fato vale para: ${fragment.asOf} | observado em: ${fragment.observedAt} | confiança: ${fragment.confidence}`,
    `  ${fragment.summary}`,
    `  dados: ${JSON.stringify(fragment.payload)}`,
  ].join('\n');
}

function formatMarket(market: PromptInput['market']): string {
  const parts: string[] = [];
  parts.push(
    market.mid !== null
      ? `preço do time A: ${market.mid.toFixed(3)}`
      : 'preço do time A: indisponível',
  );
  if (market.liquidity !== null) parts.push(`liquidez: US$ ${Math.round(market.liquidity)}`);
  if (market.spread !== null) parts.push(`spread: ${market.spread.toFixed(3)}`);
  return parts.join(' | ');
}

function timing(input: PromptInput): string {
  if (input.minutesToStart === null) return 'horário de início desconhecido';
  if (input.minutesToStart >= 0) return `faltam ${input.minutesToStart} min para o início`;
  return `a partida começou há ${Math.abs(input.minutesToStart)} min`;
}

const v1: PromptBuilder = input => {
  const header = [
    `Partida: ${input.matchSlug} (${input.verticalId})`,
    `Time A: ${input.teamA}`,
    `Time B: ${input.teamB}`,
    input.league !== null ? `Competição: ${input.league}` : null,
    input.stage !== null ? `Fase: ${input.stage}` : null,
    input.bestOf !== null ? `Formato: BO${input.bestOf}` : null,
    input.scheduledAt !== null ? `Início: ${input.scheduledAt} (${timing(input)})` : null,
    `Instante da análise: ${input.asOf}`,
    `Mercado: ${formatMarket(input.market)}`,
  ]
    .filter((line): line is string => line !== null)
    .join('\n');

  const fragments =
    input.fragments.length > 0
      ? input.fragments.map(formatFragment).join('\n\n')
      : '(nenhum fragmento)';

  return {
    system: V1_SYSTEM,
    user: `${header}\n\n## Fragmentos de contexto\n\n${fragments}\n\nQual a probabilidade de ${input.teamA} vencer a série?`,
  };
};

// ---------------------------------------------------------------------------
// Registro
// ---------------------------------------------------------------------------

const PROMPTS: Record<string, PromptBuilder> = { v1 };

/**
 * `null` quando a versão não existe — e o chamador PARA em vez de cair na v1.
 *
 * Cair na v1 seria pior que falhar: a config diria uma coisa, a linha gravada
 * registraria outra, e a comparação entre versões — que é a razão de a coluna
 * existir — passaria a mentir.
 */
export function getPrompt(version: string): PromptBuilder | null {
  return PROMPTS[version] ?? null;
}

export function promptVersions(): string[] {
  return Object.keys(PROMPTS).sort();
}
