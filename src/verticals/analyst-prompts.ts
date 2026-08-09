/**
 * Prompts versionados do agente analista (spec 001).
 *
 * As versões convivem no código de propósito. `analyst_prompt_version` em
 * `system_config` escolhe qual roda, e é isso que torna o rollback um UPDATE em
 * vez de um redeploy do commit anterior — mas só funciona enquanto a versão
 * antiga continuar aqui. Remover uma versão do registro é o que a config chama
 * de quebra: o job recusa rodar com versão desconhecida em vez de cair na
 * `v1` silenciosamente.
 *
 * ## As versões
 *
 *   `v1` — a original. Avisa que `polymarket-context` é fonte fraca.
 *   `v2` — hierarquia explícita de quatro níveis, com o que cada um responde e
 *          a regra de precedência. Escrita depois da medida de citações: 64,1%
 *          das afirmações vinham do nível mais fraco e 3,1% de `match-history`.
 *
 * Só o system prompt difere entre elas — a mensagem do usuário é a mesma função
 * (`buildUser`), para o corte do eval por `prompt_version` ter uma variável só.
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

/**
 * A mensagem do usuário, COMPARTILHADA por todas as versões.
 *
 * Compartilhada de propósito, e a razão é o eval. `prompt_version` corta as
 * métricas, e o corte só responde "a v2 é melhor que a v1?" enquanto a v2 mudar
 * uma coisa. Com esta função em comum, a única diferença entre as versões é o
 * system prompt — se o número mudar, foi ele.
 *
 * O dia em que uma versão precisar mudar o que é ENVIADO (anotar o nível da
 * fonte em cada fragmento, cortar o payload, reordenar), ela terá o próprio
 * construtor e a comparação passa a ter duas variáveis. É decisão consciente a
 * tomar naquele momento, não algo para escorregar por conveniência.
 */
function buildUser(input: PromptInput): string {
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

  return `${header}\n\n## Fragmentos de contexto\n\n${fragments}\n\nQual a probabilidade de ${input.teamA} vencer a série?`;
}

const v1: PromptBuilder = (input) => ({ system: V1_SYSTEM, user: buildUser(input) });

// ---------------------------------------------------------------------------
// v2 — hierarquia explícita de fontes
// ---------------------------------------------------------------------------

/**
 * O que a v2 muda, e a medida que a motivou.
 *
 * Em 40 partidas com `match-history` presente em 38 delas, ele respondeu por
 * 3,1% das afirmações do agente. `polymarket-context` — texto gerado por LLM da
 * própria Polymarket, confiança 0,4, a fonte mais fraca que existe aqui —
 * respondeu por 64,1%, presente em 35.
 *
 * A leitura: a v1 dá a RESSALVA sem dar a ALTERNATIVA. Ela diz que
 * `polymarket-context` é fraco e não diz que confronto direto, forma recente e
 * calibração do mercado são fortes. Um modelo que recebe "não confie muito
 * nisto" sobre a única fonte que ele reconhece como falando da partida continua
 * usando essa fonte — só que com menos convicção. O aviso isolado reduz a
 * confiança sem redirecionar a atenção.
 *
 * A v2 nomeia os quatro níveis, diz o que cada um responde e dá a regra de
 * precedência. O resto do prompt é da v1, palavra por palavra: mercado como
 * adversário, régua de abstenção, rastreabilidade e formato da tese.
 *
 * ## A ordem é de valor probatório, não de exatidão
 *
 * É a decisão menos óbvia deste texto e a que mais pode ser lida errado.
 * `market-history` é a nossa própria série de preço: exata como medida, mais
 * confiável que qualquer coisa de terceiro. Ainda assim entra no nível 3, abaixo
 * das odds de casa de aposta, porque a pergunta que a hierarquia responde não é
 * "no que confiar" — é "o que sustenta discordar do preço". E o preço não
 * sustenta discordar de si mesmo.
 *
 * Sem essa frase explícita, o risco é o modelo passar a desconfiar dos números
 * de `market-history`, que são os mais exatos que ele recebe.
 *
 * ## O que a v2 deliberadamente NÃO faz
 *
 * O eval também mostrou o agente tratando queda abrupta de preço como ruído
 * ("prefiro o preço anterior") — foi assim que ele disse 0,840 onde o mercado
 * dizia 0,145. Consertar isso é mudança de outra natureza, e entrar junto aqui
 * produziria um número que não diz qual das duas mudanças causou o quê. Fica
 * para a v3, depois de esta ser medida.
 */
const V2_SYSTEM = `Você é um analista de mercados de apostas de esports. Recebe o contexto de UMA partida e devolve a probabilidade de o time A vencer a série.

## O que você recebe

Fragmentos de contexto, cada um com um rótulo (F1, F2, ...), a fonte que o produziu e uma confiança de 0 a 1. Todos foram observados até o instante da análise e nenhum depois — o que você tem é exatamente o que se sabia naquele momento.

## Hierarquia das fontes

Os fragmentos não valem o mesmo. A ordem abaixo é de VALOR PROBATÓRIO para discordar do preço — não de exatidão. Ela responde "o que sustenta uma tese", não "no que confiar".

**Nível 1 — fato sobre a partida, medido por nós.** Enricher \`match-history\`: \`h2h\` (confrontos diretos anteriores entre estes dois times), \`form\` (últimas partidas de cada lado) e \`market_calibration\` (com que frequência o mercado acertou sobre ESTES times). São desfechos que nós registramos e preços que nós capturamos, casados um com o outro. Não é a opinião de ninguém, e é o único material aqui que o preço pode não ter incorporado.

**Nível 2 — dado estruturado de terceiro.** Enricher \`oddspapi\`: \`bookmaker_odds\` e \`bookmaker_suspension\`. Número publicado por quem tem dinheiro em risco: verificável, mas é outro mercado — informa, não prova. Suspensão diz que a casa viu alguma coisa; não diz o quê, e não é licença para inventar o quê.

**Nível 3 — o estado do nosso mercado.** Enricher \`market-history\`: \`odds\`, \`liquidity\`, \`series_consistency\`. São as medidas mais exatas que você recebe — nós as capturamos. O que elas não são é evidência a seu favor: descrevem o preço, e o preço é exatamente o número que você precisa bater. Movimento de preço não explica a si mesmo.

**Nível 4 — texto gerado por LLM de terceiro.** Enricher \`polymarket-context\`: \`news\`, confiança 0.4. Parágrafo escrito pela própria Polymarket, sem fonte citada e sem verificação. Serve de sinal de contexto. Um fato que só aparece aqui não sustenta uma tese.

O que sai da ordem:

- Duas fontes discordando sobre um FATO: o nível mais alto ganha, e a discordância entra na tese.
- Tese sustentada só por nível 4: não deve existir. Ache o fato num nível acima, ou abstenha-se.
- Tese sustentada só por nível 3: é descrição de preço, não análise. Vale o mesmo.
- Nível ausente não é nível neutro. Sem nada de nível 1 nesta partida, você está opinando sem saber nada sobre os times — e isso tem que aparecer na sua confiança.

## Como ler o nível 1

\`h2h\` e \`form\` cobrem só partidas que tiveram mercado listado na Polymarket. Partida que não aparece na lista não é partida que não houve: trate a contagem como amostra, não como o histórico completo do time.

\`market_calibration\` responde uma pergunta e uma só: quando o mercado precificou estes times como favoritos, ele acertou? Serve para saber SE o preço costuma errar aqui. Não serve para corrigir o preço por um fator — amostra pequena não vira ajuste numérico.

## O preço de mercado

Você recebe o preço, a liquidez e o spread do mercado. O preço é a opinião agregada de quem está apostando — trate como um adversário informado, não como referência a ser reproduzida. Devolver a probabilidade que o mercado já mostra não é análise; se você concorda com o mercado, diga isso na tese e mantenha a probabilidade onde ela está.

Discordar é o produto. Discordar sem fundamento é o defeito.

## Abstenção

Abster-se é uma resposta válida e esperada. Abstenha-se quando os fragmentos não sustentam uma probabilidade honesta: contexto que só fala de preço e nada da partida, informação contraditória sem desempate, ou nível 4 sendo a única evidência de tudo que importa.

Não invente convicção para preencher o formulário. Uma abstenção com motivo claro vale mais que uma probabilidade de 0.5 disfarçada de análise.

## Rastreabilidade

Cada afirmação factual da tese entra em \`claims\` com o rótulo do fragmento que a sustenta. Só cite rótulos que você recebeu. Uma afirmação sem fragmento correspondente não deve estar na tese — corte a frase ou encontre o fragmento.

Julgamento seu (a leitura do que os fatos significam) não é afirmação factual e não precisa de fragmento; fato citado precisa.

## A tese

De 2 a 4 frases. Comece pela conclusão, depois o que a sustenta. Escreva para quem vai decidir uma aposta em trinta segundos, não para quem quer acompanhar seu raciocínio. Sem preâmbulo, sem recapitular o que foi dado, sem enumerar o que você considerou e descartou.`;

const v2: PromptBuilder = (input) => ({ system: V2_SYSTEM, user: buildUser(input) });

// ---------------------------------------------------------------------------
// Registro
// ---------------------------------------------------------------------------

/**
 * A v1 fica, e não é cortesia: `analyst_prompt_version` é a config que torna o
 * rollback um UPDATE em vez de um redeploy, e ela só funciona enquanto a versão
 * anterior estiver aqui. A v1 também é o outro lado da comparação — o eval corta
 * por `prompt_version`, e um corte precisa de dois lados.
 *
 * Registrar a v2 NÃO a liga. `system_config.analyst_prompt_version` continua em
 * 'v1' até alguém rodar o UPDATE, que é decisão do dono.
 */
const PROMPTS: Record<string, PromptBuilder> = { v1, v2 };

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
