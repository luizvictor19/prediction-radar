/**
 * Prompts versionados da digestão de regras.
 *
 * Mesmo desenho de `src/verticals/analyst-prompts.ts`, e pelo mesmo motivo: a
 * versão que roda é valor de config (`digest_prompt_version`), o que torna o
 * rollback um UPDATE em vez de um redeploy — e isso só funciona enquanto a
 * versão anterior continuar registrada aqui. Versão desconhecida faz o chamador
 * PARAR, nunca cair na `v1` em silêncio: a config diria uma coisa e a linha
 * gravada registraria outra.
 *
 * A mensagem do usuário é compartilhada por todas as versões (`buildUser`), para
 * que o corte por `prompt_version` tenha uma variável só.
 */

// ---------------------------------------------------------------------------
// O que o modelo recebe
// ---------------------------------------------------------------------------

export interface DigestInput {
  /** `events.title` — a pergunta como o mercado a publica. */
  question: string;
  /** O texto integral de `events.description`: a regra. */
  description: string;
  slug: string | null;
  /** `events.end_date`. Vai junto porque a regra às vezes contradiz a data. */
  endDate: string | null;
  outcomes: readonly string[] | null;
}

export interface BuiltPrompt {
  system: string;
  user: string;
}

export type PromptBuilder = (input: DigestInput) => BuiltPrompt;

// ---------------------------------------------------------------------------
// O schema de saída
// ---------------------------------------------------------------------------

/**
 * O contrato de saída da v1.
 *
 * Na Anthropic ele vai em `output_config.format` e a API garante a FORMA. Na
 * DeepSeek ele vai no texto do sistema e a API só garante que a resposta é JSON
 * válido (ver `src/llm/deepseek.ts`). A diferença não muda o que é aceito: quem
 * decide se a resposta vira linha é `parseDigest`, que roda igual nos dois — a
 * garantia da API nunca cobriu coerência entre campos nem a regra da opinião.
 *
 * O que a diferença muda é a TAXA DE SAÍDA INVÁLIDA, que é uma das medidas da
 * comparação do degrau 2. É medida, não suposição.
 *
 * **A v2 tem schema próprio** (`SCHEMA_V2`), e é a primeira vez que uma versão
 * de prompt muda a FORMA da saída e não só o texto. Ver a nota da v2 sobre o que
 * isso custa à comparação entre versões.
 */
export const SCHEMA_V1 = {
  type: 'object',
  properties: {
    resolve_sim: {
      type: 'array',
      description:
        'As condições que fazem o mercado resolver SIM, uma por item, como a regra as define. Condições que precisam valer JUNTAS são um item só.',
      items: { type: 'string' },
    },
    resolve_nao: {
      type: 'array',
      description:
        'As condições que fazem resolver NÃO. Quando a regra só descreve o SIM e deixa o NÃO como complemento, diga isso em um item.',
      items: { type: 'string' },
    },
    fonte: {
      type: ['string', 'null'],
      description:
        'Quem decide, nomeado como a regra o nomeia. null quando a regra não nomeia ninguém.',
    },
    anula_se: {
      type: 'array',
      description:
        'Condições de anulação (void, N/A, cancelamento, devolução). Lista vazia quando a regra não prevê nenhuma.',
      items: { type: 'string' },
    },
    prazo: {
      type: ['string', 'null'],
      description: 'A data-limite E O FUSO, como a regra os escreve. null quando não há prazo.',
    },
    pegadinhas: {
      type: 'array',
      description:
        'O que parece que conta e NÃO conta (ou o contrário). Cada item nomeia a coisa que parece contar e diz por que a regra a exclui ou inclui.',
      items: { type: 'string' },
    },
    ambiguidades: {
      type: 'array',
      description:
        'Onde a regra admite mais de uma leitura: o trecho citado e as duas leituras.',
      items: { type: 'string' },
    },
  },
  required: ['resolve_sim', 'resolve_nao', 'fonte', 'anula_se', 'prazo', 'pegadinhas', 'ambiguidades'],
  additionalProperties: false,
} as const;

// ---------------------------------------------------------------------------
// v1
// ---------------------------------------------------------------------------

/**
 * O system prompt.
 *
 * Escrito para um modelo que já é cuidadoso — sem "seja rigoroso", sem "confira
 * antes de responder", sem "pense passo a passo". O que sobra é o que só quem
 * escreveu o sistema sabe: para que serve cada campo, qual deles é o produto,
 * e por que a proibição de opinar não é preferência de estilo.
 *
 * A proibição está escrita COM O MOTIVO junto, e de propósito: uma regra sem
 * razão é seguida pela letra e contornada pelo espírito ("não digo a
 * probabilidade, mas digo que a condição é difícil"). Com o motivo, o modelo
 * sabe o que a regra está protegendo.
 */
const V1_SYSTEM = `Você lê a REGRA DE RESOLUÇÃO de um mercado de previsão e devolve o que ela diz, em campos.

Não é resumo e não é análise. É extração: transformar mil e duzentos caracteres de texto contratual — que quase ninguém lê — em campos que se conferem em dez segundos.

## Os campos

**resolve_sim** — as condições que fazem o mercado resolver SIM, como a regra as define. Condições que precisam valer JUNTAS são um item só, escrito com o "e". Alternativas são itens separados.

**resolve_nao** — as condições que fazem resolver NÃO. Muitas regras descrevem só o SIM e deixam o NÃO como complemento; quando for esse o caso, diga isso em um item e não invente condições que o texto não traz.

**fonte** — quem decide, nomeado como a regra o nomeia: o órgão, a publicação, o site, o critério de consenso. Se a regra não nomeia ninguém, devolva null — dizer que a regra é omissa nisso é informação, e das mais úteis.

**anula_se** — as condições de anulação: void, N/A, cancelamento, devolução, adiamento além do prazo. Lista vazia quando a regra não prevê nenhuma.

**prazo** — a data-limite E O FUSO HORÁRIO, como a regra os escreve. O fuso é metade do campo: "31 de dezembro" sem fuso são doze horas de ambiguidade. null quando a regra não dá prazo.

**pegadinhas** — este é o campo que justifica o componente inteiro. É o que PARECE que conta e NÃO conta, e o contrário. A forma: a pergunta diz "vencer a liga", o texto exige o título da temporada, e então "ganhou três jogos seguidos" parece contar e não conta. Cada item nomeia a coisa que parece contar e diz por que a regra a exclui ou a inclui.

Não repita aqui o que já está literalmente em resolve_sim. Pegadinha é a distância entre o que a pergunta sugere e o que a regra exige — se não há distância, não há pegadinha. Lista vazia quando a regra for mesmo direta: um campo vazio honesto vale mais que um item inventado para preencher formulário.

**ambiguidades** — onde a regra admite mais de uma leitura. Cite o trecho exato e diga as duas leituras que ele comporta. Num mercado de sessenta milhões de dólares a briga foi se "vendeu até 31 de maio" significava a venda ou a divulgação dela — era uma ambiguidade de seis palavras. Lista vazia quando não houver.

## A regra que não se quebra

Você não diz nada sobre o DESFECHO.

Nenhuma probabilidade, nenhuma chance, nenhum "é provável" ou "dificilmente". Nenhuma recomendação, nenhum "parece barato", nenhuma oportunidade, nenhum julgamento sobre o preço. Nenhuma estimativa de quão fácil ou difícil é a condição acontecer.

Não é preferência de estilo, e o motivo importa. Quem lê isto vai anotar a própria probabilidade nestes mercados por dois meses para medir a própria calibração. Um número seu na tela antes disso ancora a estimativa dele, e a medição deixa de responder qualquer coisa. Uma saída com opinião sobre desfecho é descartada inteira — os outros campos vão junto com ela.

Números que estão NA REGRA são fatos da regra e devem aparecer: "acima de 3,5%", "pelo menos 270 votos", "US$ 100 bilhões". O que não pode existir é número seu.

## Só o que o texto diz

Nenhum conhecimento de fora. Nenhum "normalmente estes mercados...". Se a regra é omissa, o campo registra a omissão — isso não é falha da extração, é o achado: regra omissa é onde nasce disputa.

Escreva em português. Nomes próprios ficam como a regra os escreve — não traduza o nome da fonte. Cada item é uma frase, no máximo duas.`;

function formatOutcomes(outcomes: readonly string[] | null): string | null {
  if (outcomes === null || outcomes.length === 0) return null;
  return `Desfechos: ${outcomes.join(' | ')}`;
}

/**
 * A mensagem do usuário, COMPARTILHADA por todas as versões.
 *
 * A regra vai entre marcadores explícitos porque ela é texto de terceiro e vai
 * ter cabeçalho, lista e às vezes markdown próprio. Sem delimitador, um
 * "## Resolução" que veio dentro da descrição compete com os cabeçalhos do
 * prompt — e o modelo passa a ler a regra como instrução.
 *
 * `end_date` entra ao lado do prazo de propósito: quando os dois discordam, a
 * discordância é uma ambiguidade de verdade, e o modelo só a enxerga se receber
 * os dois.
 */
function buildUser(input: DigestInput): string {
  const header = [
    `Pergunta: ${input.question}`,
    input.slug !== null ? `Slug: ${input.slug}` : null,
    formatOutcomes(input.outcomes),
    input.endDate !== null ? `Data de fim registrada pela plataforma: ${input.endDate}` : null,
  ].filter((line): line is string => line !== null);

  return [
    header.join('\n'),
    '',
    'A regra de resolução, íntegra, entre os marcadores:',
    '',
    '<<<REGRA',
    input.description,
    'REGRA>>>',
  ].join('\n');
}

const v1: PromptBuilder = input => ({ system: V1_SYSTEM, user: buildUser(input) });

// ---------------------------------------------------------------------------
// v2 — severidade, tipo de ambiguidade, e a régua contra enchimento
// ---------------------------------------------------------------------------

/**
 * As listas fechadas da v2, em um lugar só.
 *
 * Repetidas no schema, no texto do prompt, no `parseDigest` e no CHECK da
 * migration — quatro cópias, e é de propósito: o schema é o que o fornecedor lê,
 * o texto é o que o modelo entende, o parse é o que recusa, e o CHECK é o que o
 * banco garante. Derivar umas das outras economizaria repetição e tiraria a
 * garantia de exatamente uma delas.
 */
export const SEVERIDADES = ['muda_resultado', 'muda_timing', 'detalhe'] as const;

export const TIPOS_AMBIGUIDADE_V2 = [
  'fonte_vaga',
  'fuso_ausente',
  'data_ambigua',
  'janela_inclusiva',
  'escopo_de_entidade',
  'limiar_de_borda',
  'formato_do_mercado',
  'outro',
] as const;

/**
 * A lista da v3: a da v2 mais `momento_ambiguo`.
 *
 * A lista da v2 NÃO é editada, e a separação é o ponto: a v2 já rodou, e o
 * schema que ela enviou tem oito valores. Reescrevê-lo agora faria o código
 * afirmar que a rodada de ontem ofereceu uma categoria que ela não ofereceu — e
 * a taxa de `outro` daquela rodada (8,3%) deixaria de significar o que
 * significava.
 *
 * `momento_ambiguo` nasce dos dois casos que caíram em `outro` na v2, e os dois
 * eram a mesma coisa: "as of market close" sem dizer QUAL fechamento. Aceito o
 * nome proposto — não tenho recorte melhor, e o que falta ali é mesmo o
 * instante, não o fuso (`fuso_ausente`) nem quem decide (`fonte_vaga`).
 *
 * O que a categoria nova obriga a ajustar é a VIZINHA: `data_ambigua` passa a
 * ser sobre qual DATA ou período, e `momento_ambiguo` sobre qual INSTANTE dentro
 * do dia ou qual referência de fechamento. Sem esse aperto as duas se
 * canibalizam e a contagem para de separar coisas diferentes.
 */
export const TIPOS_AMBIGUIDADE_V3 = [
  'fonte_vaga',
  'fuso_ausente',
  'momento_ambiguo',
  'data_ambigua',
  'janela_inclusiva',
  'escopo_de_entidade',
  'limiar_de_borda',
  'formato_do_mercado',
  'outro',
] as const;

/**
 * A lista da v4: a da v3 mais três, e as três saíram de LER os `outro`.
 *
 * A v3 fechou em 30,4% de `outro` (7 de 23). Lidos um a um: três eram categoria
 * faltando, dois eram erro de classificação por definição frouxa (consertados no
 * TEXTO do prompt, não aqui), e dois eram o mesmo caso repetido. As três que
 * faltavam:
 *
 *   - `contradicao_interna` — a regra afirma duas coisas incompatíveis. Não é
 *     ambiguidade de leitura, é defeito do texto: nenhuma das duas leituras está
 *     errada, porque a regra sustenta as duas. É a de maior valor da lista, e o
 *     motivo é que ela é a FORMA da disputa — quando a regra se contradiz, o
 *     oráculo vai ter que legislar, e isso se enxerga hoje, no texto, sem
 *     esperar o evento. É o formato do caso de US$ 60 milhões.
 *   - `precedencia_de_fonte` — mais de uma fonte ou caminho de resolução, e a
 *     regra não diz qual manda quando discordam. Distinto de `fonte_vaga`, que é
 *     UMA fonte mal definida; aqui são duas bem definidas sem ordem entre elas.
 *   - `criterio_discricionario` — a decisão fica com quem resolve, sem critério
 *     ("may remain open", "does not clearly state"). A fonte pode estar
 *     perfeitamente nomeada e a DECISÃO continuar discricionária.
 *
 * `momento_ambiguo`, `janela_inclusiva` e `limiar_de_borda` deram zero uso na v3
 * e FICAM. Os três nasceram de mercados de market-cap e de limiar numérico, e a
 * amostra de 10 da v3 não tinha nenhum desses. Zero uso numa amostra que não
 * contém o caso é NÃO TESTADO, não é refutado — e remover categoria por zero uso
 * em n=10 é o mesmo erro de tratar flutuação como sinal.
 *
 * `contradicao_interna` vem primeiro na lista de propósito: a ordem daqui é a
 * ordem das tabelas do relatório, e é o achado que não pode sair no meio de uma
 * tabela.
 */
export const TIPOS_AMBIGUIDADE_V4 = [
  'contradicao_interna',
  'precedencia_de_fonte',
  'criterio_discricionario',
  'fonte_vaga',
  'fuso_ausente',
  'momento_ambiguo',
  'data_ambigua',
  'janela_inclusiva',
  'escopo_de_entidade',
  'limiar_de_borda',
  'formato_do_mercado',
  'outro',
] as const;

/** A lista que VALE para uma versão. Validar contra a errada aceitaria lixo. */
export function tiposDe(version: string): readonly string[] {
  if (version === 'v1' || version === 'v2') return TIPOS_AMBIGUIDADE_V2;
  if (version === 'v3') return TIPOS_AMBIGUIDADE_V3;
  return TIPOS_AMBIGUIDADE_V4;
}

/**
 * O contrato de saída da v2.
 *
 * Duas mudanças de FORMA, não de texto: `pegadinhas` deixa de ser lista de
 * frases e passa a ser lista de (frase, severidade); `ambiguidades` deixa de ser
 * texto solto e passa a ser (tipo, trecho, leitura A, leitura B).
 *
 * O custo assumido: a comparação v1 × v2 deixa de ter uma variável só. Não dá
 * para atribuir a diferença ao texto do prompt isolado do formato pedido — os
 * dois mudaram juntos. É decisão consciente, não escorregada: sem o formato, a
 * contagem por tipo que vira score de risco de disputa não existe, e ela é o
 * produto. A comparação que sobra é "a v2 lê melhor esta regra que a v1?", que é
 * a pergunta que se ia fazer de qualquer forma.
 */
export const SCHEMA_V2 = {
  type: 'object',
  properties: {
    resolve_sim: {
      type: 'array',
      description:
        'As condições que fazem o mercado resolver SIM, uma por item, como a regra as define. Condições que precisam valer JUNTAS são um item só.',
      items: { type: 'string' },
    },
    resolve_nao: {
      type: 'array',
      description:
        'As condições que fazem resolver NÃO. Quando a regra só descreve o SIM e deixa o NÃO como complemento, diga isso em um item.',
      items: { type: 'string' },
    },
    fonte: {
      type: ['string', 'null'],
      description:
        'Quem decide, nomeado como a regra o nomeia. null quando a regra não nomeia ninguém.',
    },
    anula_se: {
      type: 'array',
      description:
        'Condições de anulação (void, N/A, cancelamento, devolução). Lista vazia quando a regra não prevê nenhuma.',
      items: { type: 'string' },
    },
    prazo: {
      type: ['string', 'null'],
      description: 'A data-limite E O FUSO, como a regra os escreve. null quando não há prazo.',
    },
    pegadinhas: {
      type: 'array',
      description:
        'Algo que a regra diz e o título esconde. LISTA VAZIA é resposta válida e frequente. Não repita o que a regra já diz de forma óbvia.',
      items: {
        type: 'object',
        properties: {
          texto: {
            type: 'string',
            description: 'A pegadinha: o que parece contar e não conta, ou o contrário.',
          },
          severidade: {
            type: 'string',
            enum: [...SEVERIDADES],
            description:
              'muda_resultado = decide SIM contra NÃO. muda_timing = não muda o desfecho, muda QUANDO resolve. detalhe = nuance de leitura, não muda decisão.',
          },
        },
        required: ['texto', 'severidade'],
        additionalProperties: false,
      },
    },
    ambiguidades: {
      type: 'array',
      description:
        'Onde a regra admite mais de uma leitura. Lista vazia quando não houver.',
      items: {
        type: 'object',
        properties: {
          tipo: {
            type: 'string',
            enum: [...TIPOS_AMBIGUIDADE_V2],
            description: 'A categoria da ambiguidade. Use "outro" em vez de forçar uma que não descreve.',
          },
          trecho: {
            type: 'string',
            description: 'O trecho LITERAL da regra que causa a ambiguidade, copiado do texto.',
          },
          leitura_a: { type: 'string', description: 'Uma das leituras possíveis.' },
          leitura_b: { type: 'string', description: 'A outra leitura possível.' },
        },
        required: ['tipo', 'trecho', 'leitura_a', 'leitura_b'],
        additionalProperties: false,
      },
    },
  },
  required: ['resolve_sim', 'resolve_nao', 'fonte', 'anula_se', 'prazo', 'pegadinhas', 'ambiguidades'],
  additionalProperties: false,
} as const;

/**
 * O system prompt da v2.
 *
 * Três defeitos medidos na v1, e cada seção abaixo conserta um:
 *
 *   1. **Contagem forçada.** A v1 entregou 2 a 4 pegadinhas por mercado tivesse
 *      ou não o que dizer, e o enchimento afoga o que presta. O modelo preenche
 *      tabela por padrão; a v2 diz em voz alta que lista vazia é resposta.
 *   2. **Tudo com o mesmo peso.** Sem severidade, "resolve na eliminação
 *      matemática" (o capital destrava meses antes) tem a mesma cara de "market
 *      cap não é receita".
 *   3. **Ambiguidade era texto livre.** Lendo as 10, os mesmos padrões repetiam
 *      entre mercados. Padrão que repete se conta, e contagem vira score de
 *      risco de disputa — o produto de verdade.
 *
 * A régua com exemplos reais é a parte que mais muda o comportamento, e vem da
 * própria rodada anterior. Exemplo concreto é o sinal mais forte que existe num
 * prompt: o modelo casa o comprimento, o tom e o critério dos exemplos. Por isso
 * eles são REAIS e não inventados — e por isso são poucos e variados.
 *
 * O conserto do falso positivo da trava está em "as duas leituras": a v1 foi
 * recusada por escrever "a leitura restritiva é mais provável". A trava estava
 * certa em pegar; o conserto é na origem, não afrouxando a trava.
 */
const V2_SYSTEM = `Você lê a REGRA DE RESOLUÇÃO de um mercado de previsão e devolve o que ela diz, em campos.

Não é resumo e não é análise. É extração: transformar mil e duzentos caracteres de texto contratual — que quase ninguém lê — em campos que se conferem em dez segundos.

## Os campos diretos

**resolve_sim** — as condições que fazem o mercado resolver SIM, como a regra as define. Condições que precisam valer JUNTAS são um item só, escrito com o "e". Alternativas são itens separados.

**resolve_nao** — as condições que fazem resolver NÃO. Muitas regras descrevem só o SIM e deixam o NÃO como complemento; quando for esse o caso, diga isso em um item e não invente condições que o texto não traz.

**fonte** — quem decide, nomeado como a regra o nomeia: o órgão, a publicação, o site, o critério de consenso. Se a regra não nomeia ninguém, devolva null — dizer que a regra é omissa nisso é informação, e das mais úteis.

**anula_se** — as condições de anulação: void, N/A, cancelamento, devolução, adiamento além do prazo. Lista vazia quando a regra não prevê nenhuma.

**prazo** — a data-limite E O FUSO HORÁRIO, como a regra os escreve. O fuso é metade do campo: "31 de dezembro" sem fuso são doze horas de ambiguidade. null quando a regra não dá prazo.

## pegadinhas — e a régua

Uma pegadinha é **algo que a regra diz e o título esconde**. Não é repetir o que a regra já diz de forma óbvia.

**Lista vazia é resposta válida e frequente.** Regra simples existe, e é comum. Não preencha a lista porque ela está lá — item de enchimento afoga o item que presta, e o custo de afogar é maior que o de deixar o campo vazio. Se você está escrevendo uma pegadinha porque ainda não escreveu nenhuma, apague.

A régua, com casos reais:

PASSA — a regra diz e o título esconde:
- "Tiros de advertência, artilharia em área desabitada e mísseis que caiam em águas territoriais são explicitamente excluídos."
- "A Guarda Costeira Japonesa não é força militar; a Guarda Costeira Chinesa conta."
- "A regra exclui coligações e conta só os assentos da entidade nomeada."
- "Fechamento exatamente em US$ 76.000 resolve NÃO — a regra diz *higher than*."
- "Resolve NÃO na eliminação matemática, antes do jogo."
- "A janela começa em 24/11/2025, não na criação do mercado."

NÃO PASSA — é enchimento, repete o óbvio:
- "Pode parecer que 'maior empresa' é receita, mas a regra diz market cap."
- "O preço de outras corretoras não conta."
- "A posição durante o dia não conta, só o fechamento."

Cada pegadinha leva uma **severidade**, de lista fechada:

- \`muda_resultado\` — decide SIM contra NÃO.
- \`muda_timing\` — não muda o desfecho, muda QUANDO o mercado resolve. Existe por um caso real: o mercado resolve NÃO na eliminação matemática do time, não no fim da temporada. O desfecho é o mesmo; o capital destrava meses antes, e quem não sabe calcula errado quanto tempo o dinheiro fica preso.
- \`detalhe\` — nuance de leitura, não muda decisão.

## ambiguidades — tipo, trecho e as duas leituras

Cada ambiguidade tem um **tipo** de lista fechada:

- \`fonte_vaga\` — quem decide não está nomeado, ou é "consenso" sem definição.
- \`fuso_ausente\` — horário sem fuso, ou "ET" sem dizer se é EST ou EDT.
- \`data_ambigua\` — a data ou o período admite mais de uma leitura.
- \`janela_inclusiva\` — não diz se os extremos do intervalo entram.
- \`escopo_de_entidade\` — quem conta como parte não está fechado.
- \`limiar_de_borda\` — o que acontece exatamente no limiar não está dito.
- \`formato_do_mercado\` — o texto da regra não casa com o formato da pergunta (regra categórica em pergunta binária, por exemplo).
- \`outro\` — fora da lista. **Prefira \`outro\` a forçar uma categoria que não descreve**: categoria errada estraga a contagem, e a contagem é para o que isto serve.

O **trecho** é literal, copiado da regra. Sem ele não dá para auditar nada depois.

E você apresenta **as duas leituras**, em \`leitura_a\` e \`leitura_b\`. **Não diga qual é mais provável, nem qual é a mais natural, nem qual costuma valer.** Qual leitura vale é decisão de quem resolve o mercado, não sua — e as duas lado a lado são mais úteis que o palpite de qual vence.

Lista vazia quando não houver ambiguidade.

## A regra que não se quebra

Você não diz nada sobre o DESFECHO.

Nenhuma probabilidade, nenhuma chance, nenhum "é provável" ou "dificilmente". Nenhuma recomendação, nenhum "parece barato", nenhuma oportunidade, nenhum julgamento sobre o preço. Nenhuma estimativa de quão fácil ou difícil é a condição acontecer.

Não é preferência de estilo, e o motivo importa. Quem lê isto vai anotar a própria probabilidade nestes mercados por dois meses para medir a própria calibração. Um número seu na tela antes disso ancora a estimativa dele, e a medição deixa de responder qualquer coisa. Uma saída com opinião sobre desfecho é descartada inteira — os outros campos vão junto com ela.

Números que estão NA REGRA são fatos da regra e devem aparecer: "acima de 3,5%", "pelo menos 270 votos", "US$ 100 bilhões". O que não pode existir é número seu.

## Só o que o texto diz

Nenhum conhecimento de fora. Nenhum "normalmente estes mercados...". Se a regra é omissa, o campo registra a omissão — isso não é falha da extração, é o achado: regra omissa é onde nasce disputa.

Escreva em português. Nomes próprios ficam como a regra os escreve — não traduza o nome da fonte. Cada item é uma frase, no máximo duas.`;

const v2: PromptBuilder = input => ({ system: V2_SYSTEM, user: buildUser(input) });

// ---------------------------------------------------------------------------
// v3 — mecanismo no lugar de instrução
// ---------------------------------------------------------------------------

/**
 * O contrato de saída da v3.
 *
 * A v2 provou uma coisa e falhou em duas, e o padrão vale como regra de projeto:
 * **instrução não restringe, estrutura restringe.** A lista fechada de tipos de
 * ambiguidade funcionou (91,7% classificado, `outro` em 8,3%); os dois pedidos
 * feitos em texto não moveram nada — a contagem de pegadinhas ficou em 23 contra
 * 23 nos mesmos mercados, e 75% das severidades viraram `muda_resultado`.
 *
 * A v3 troca as duas instruções por campo obrigatório:
 *
 *   - `pegadinhas[].trecho` — substring literal da regra. **Conferida em código**
 *     contra a `description`: item cujo trecho não existe no texto é descartado,
 *     e dois itens que citam o mesmo trecho viram um. Não existe passagem da
 *     regra que sustente "market cap não é receita" — a regra só diz market cap.
 *     O enchimento morre por falta de fonte, não por pedido.
 *   - `pegadinhas[].cenario` — obrigatório para as duas severidades fortes.
 *     Sem ele a severidade CAI para `detalhe`, em código. "A posição durante o
 *     dia não conta" não produz cenário: ninguém perde dinheiro com isso, porque
 *     quem lê a regra vê "as of market close". "Fechamento exatamente em
 *     US$ 76.000 resolve NÃO" produz cenário na hora.
 *
 * Os dois campos são declarados como opcionais no schema porque a regra que os
 * torna obrigatórios é CONDICIONAL (depende da severidade), e structured output
 * não expressa condicional. Quem impõe é `parseDigest` — que é onde a imposição
 * tinha que estar de qualquer forma, já que um dos fornecedores nem garante a
 * forma.
 */
export const SCHEMA_V3 = {
  type: 'object',
  properties: {
    resolve_sim: {
      type: 'array',
      description:
        'As condições que fazem o mercado resolver SIM, uma por item, como a regra as define. Condições que precisam valer JUNTAS são um item só.',
      items: { type: 'string' },
    },
    resolve_nao: {
      type: 'array',
      description:
        'As condições que fazem resolver NÃO. Quando a regra só descreve o SIM e deixa o NÃO como complemento, diga isso em um item.',
      items: { type: 'string' },
    },
    fonte: {
      type: ['string', 'null'],
      description:
        'Quem decide, nomeado como a regra o nomeia. null quando a regra não nomeia ninguém.',
    },
    anula_se: {
      type: 'array',
      description:
        'Condições de anulação (void, N/A, cancelamento, devolução). Lista vazia quando a regra não prevê nenhuma.',
      items: { type: 'string' },
    },
    prazo: {
      type: ['string', 'null'],
      description: 'A data-limite E O FUSO, como a regra os escreve. null quando não há prazo.',
    },
    pegadinhas: {
      type: 'array',
      description:
        'Algo que a regra diz e o título esconde, ancorado num trecho literal da regra. LISTA VAZIA é resposta válida e frequente.',
      items: {
        type: 'object',
        properties: {
          texto: {
            type: 'string',
            description: 'A pegadinha: o que parece contar e não conta, ou o contrário.',
          },
          trecho: {
            type: 'string',
            description:
              'A passagem LITERAL da regra que cria a armadilha, copiada caractere por caractere. Um trecho por pegadinha, e nunca o mesmo trecho em duas.',
          },
          severidade: {
            type: 'string',
            enum: [...SEVERIDADES],
            description:
              'muda_resultado = decide SIM contra NÃO. muda_timing = não muda o desfecho, muda QUANDO resolve. detalhe = nuance de leitura.',
          },
          cenario: {
            type: ['string', 'null'],
            description:
              'OBRIGATÓRIO em muda_resultado e muda_timing: a situação concreta em que a leitura ingênua e a regra divergem. null em detalhe.',
          },
        },
        required: ['texto', 'trecho', 'severidade', 'cenario'],
        additionalProperties: false,
      },
    },
    ambiguidades: {
      type: 'array',
      description: 'Onde a regra admite mais de uma leitura. Lista vazia quando não houver.',
      items: {
        type: 'object',
        properties: {
          tipo: {
            type: 'string',
            enum: [...TIPOS_AMBIGUIDADE_V3],
            description: 'A categoria da ambiguidade. Use "outro" em vez de forçar uma que não descreve.',
          },
          trecho: {
            type: 'string',
            description: 'O trecho LITERAL da regra que causa a ambiguidade, copiado do texto.',
          },
          leitura_a: { type: 'string', description: 'Uma das leituras possíveis.' },
          leitura_b: { type: 'string', description: 'A outra leitura possível.' },
        },
        required: ['tipo', 'trecho', 'leitura_a', 'leitura_b'],
        additionalProperties: false,
      },
    },
  },
  required: ['resolve_sim', 'resolve_nao', 'fonte', 'anula_se', 'prazo', 'pegadinhas', 'ambiguidades'],
  additionalProperties: false,
} as const;

/**
 * O system prompt da v3.
 *
 * O texto diz que o trecho é conferido e que a severidade cai sem cenário. Isso
 * não é a garantia — a garantia é o código —, mas contar ao modelo qual é a
 * regra do jogo é o que faz ele jogar dentro dela em vez de ser podado depois. A
 * poda em silêncio produziria listas mutiladas onde a intenção era listas
 * menores.
 *
 * A régua com exemplos reais continua, e agora ela é LEGÍTIMA: os exemplos vêm
 * dos 10 mercados da rodada anterior, e esta rodada corre em 10 mercados novos —
 * garantido por `--excluir-de` no script, não por conferência no olho. Na v2 os
 * exemplos saíram de 7 dos 10 mercados da própria amostra, e aquela comparação
 * ficou com as respostas no verso.
 */
const V3_SYSTEM = `Você lê a REGRA DE RESOLUÇÃO de um mercado de previsão e devolve o que ela diz, em campos.

Não é resumo e não é análise. É extração: transformar mil e duzentos caracteres de texto contratual — que quase ninguém lê — em campos que se conferem em dez segundos.

## Os campos diretos

**resolve_sim** — as condições que fazem o mercado resolver SIM, como a regra as define. Condições que precisam valer JUNTAS são um item só, escrito com o "e". Alternativas são itens separados.

**resolve_nao** — as condições que fazem resolver NÃO. Muitas regras descrevem só o SIM e deixam o NÃO como complemento; quando for esse o caso, diga isso em um item e não invente condições que o texto não traz.

**fonte** — quem decide, nomeado como a regra o nomeia: o órgão, a publicação, o site, o critério de consenso. Se a regra não nomeia ninguém, devolva null — dizer que a regra é omissa nisso é informação, e das mais úteis.

**anula_se** — as condições de anulação: void, N/A, cancelamento, devolução, adiamento além do prazo. Lista vazia quando a regra não prevê nenhuma.

**prazo** — a data-limite E O FUSO HORÁRIO, como a regra os escreve. O fuso é metade do campo: "31 de dezembro" sem fuso são doze horas de ambiguidade. null quando a regra não dá prazo.

## pegadinhas — cada uma ancorada num trecho da regra

Uma pegadinha é **algo que a regra diz e o título esconde**. Não é repetir o que a regra já diz de forma óbvia.

Cada pegadinha carrega o **trecho**: a passagem da regra que cria a armadilha, copiada LITERALMENTE do texto que você recebeu, caractere por caractere. Não parafraseie, não traduza, não resuma — copie.

Duas coisas são conferidas por programa depois, e é bom você saber quais:

1. **O trecho é procurado na regra.** Se não estiver lá, a pegadinha é jogada fora.
2. **Dois trechos iguais viram um.** Se duas pegadinhas citam a mesma passagem, elas são a mesma observação dita de dois jeitos, e só uma sobrevive.

Isso significa que o número de pegadinhas não é seu para escolher: é o número de passagens distintas da regra que criam armadilha. Se uma observação não tem passagem que a sustente, ela não é uma pegadinha — é uma impressão sua, e não entra.

**Lista vazia é resposta válida e frequente.** Regra simples existe, e é comum.

A régua, com casos reais de outros mercados:

PASSA — a regra diz e o título esconde:
- "Tiros de advertência, artilharia em área desabitada e mísseis que caiam em águas territoriais são explicitamente excluídos."
- "A Guarda Costeira Japonesa não é força militar; a Guarda Costeira Chinesa conta."
- "A regra exclui coligações e conta só os assentos da entidade nomeada."
- "Fechamento exatamente em US$ 76.000 resolve NÃO — a regra diz *higher than*."
- "Resolve NÃO na eliminação matemática, antes do jogo."
- "A janela começa em 24/11/2025, não na criação do mercado."

NÃO PASSA — é enchimento, repete o óbvio:
- "Pode parecer que 'maior empresa' é receita, mas a regra diz market cap."
- "O preço de outras corretoras não conta."
- "A posição durante o dia não conta, só o fechamento."

### severidade, e o cenário que a sustenta

- \`muda_resultado\` — decide SIM contra NÃO.
- \`muda_timing\` — não muda o desfecho, muda QUANDO o mercado resolve. Existe por um caso real: o mercado resolve NÃO na eliminação matemática do time, não no fim da temporada. O desfecho é o mesmo; o capital destrava meses antes, e quem não sabe calcula errado quanto tempo o dinheiro fica preso.
- \`detalhe\` — nuance de leitura, não muda decisão.

Para as duas primeiras, o campo **cenario** é obrigatório: uma situação concreta em que a leitura ingênua e a regra dão respostas diferentes.

Formato: *"se acontecer X, quem leu só o título espera SIM, mas a regra dá NÃO."* Para \`muda_timing\`: *"se acontecer X, quem leu só o título espera resolver em tal data, mas a regra resolve em outra."*

**Sem cenário, a severidade cai para \`detalhe\` por programa.** Não escreva cenário genérico para segurar o nível — cenário que não nomeia uma situação concreta não sustenta nada. Em \`detalhe\`, deixe \`cenario\` como null.

Repare no que isso separa: "a posição durante o dia não conta, só o fechamento" não produz cenário, porque não existe situação em que alguém perca dinheiro com isso — qualquer um que leia a regra vê "as of market close". Já "fechamento exatamente em US$ 76.000 resolve NÃO" produz cenário na hora.

## ambiguidades — tipo, trecho e as duas leituras

Cada ambiguidade tem um **tipo** de lista fechada:

- \`fonte_vaga\` — quem decide não está nomeado, ou é "consenso" sem definição.
- \`fuso_ausente\` — horário sem fuso, ou "ET" sem dizer se é EST ou EDT.
- \`momento_ambiguo\` — a regra nomeia um INSTANTE de medição que admite mais de um ponto no tempo: "as of market close" sem dizer qual bolsa fecha, "no fim do dia" sem dizer de quem.
- \`data_ambigua\` — a DATA ou o período admitem mais de uma leitura ("o campeonato de 2027" é a temporada ou o jogo disputado em 2027?).
- \`janela_inclusiva\` — não diz se os extremos do intervalo entram.
- \`escopo_de_entidade\` — quem conta como parte não está fechado.
- \`limiar_de_borda\` — o que acontece exatamente no limiar não está dito.
- \`formato_do_mercado\` — o texto da regra não casa com o formato da pergunta (regra categórica em pergunta binária, por exemplo).
- \`outro\` — fora da lista. **Prefira \`outro\` a forçar uma categoria que não descreve**: categoria errada estraga a contagem, e a contagem é para o que isto serve.

\`momento_ambiguo\` e \`data_ambigua\` são vizinhos e não se confundem: o primeiro é sobre QUAL INSTANTE dentro de um dia (ou qual referência de fechamento), o segundo é sobre QUAL DATA ou período.

O **trecho** é literal, copiado da regra. Sem ele não dá para auditar nada depois.

E você apresenta **as duas leituras**, em \`leitura_a\` e \`leitura_b\`. **Não diga qual é mais provável, nem qual é a mais natural, nem qual costuma valer.** Qual leitura vale é decisão de quem resolve o mercado, não sua — e as duas lado a lado são mais úteis que o palpite de qual vence.

Lista vazia quando não houver ambiguidade.

## A regra que não se quebra

Você não diz nada sobre o DESFECHO.

Nenhuma probabilidade, nenhuma chance, nenhum "é provável" ou "dificilmente". Nenhuma recomendação, nenhum "parece barato", nenhuma oportunidade, nenhum julgamento sobre o preço. Nenhuma estimativa de quão fácil ou difícil é a condição acontecer.

Não é preferência de estilo, e o motivo importa. Quem lê isto vai anotar a própria probabilidade nestes mercados por dois meses para medir a própria calibração. Um número seu na tela antes disso ancora a estimativa dele, e a medição deixa de responder qualquer coisa. Uma saída com opinião sobre desfecho é descartada inteira — os outros campos vão junto com ela.

Números que estão NA REGRA são fatos da regra e devem aparecer: "acima de 3,5%", "pelo menos 270 votos", "US$ 100 bilhões". O que não pode existir é número seu.

O **cenário** é a única exceção parcial, e ela é estreita: ele descreve uma SITUAÇÃO HIPOTÉTICA para mostrar a divergência entre a regra e o título ("se o fechamento for exatamente US$ 76.000..."). Ele não diz que essa situação é provável, nem improvável, nem o que você acha dela.

## Só o que o texto diz

Nenhum conhecimento de fora. Nenhum "normalmente estes mercados...". Se a regra é omissa, o campo registra a omissão — isso não é falha da extração, é o achado: regra omissa é onde nasce disputa.

Escreva em português, exceto os trechos citados, que ficam na língua da regra. Nomes próprios ficam como a regra os escreve. Cada item é uma frase, no máximo duas.`;

const v3: PromptBuilder = input => ({ system: V3_SYSTEM, user: buildUser(input) });

// ---------------------------------------------------------------------------
// v4 — a lista fechada que fecha de verdade
// ---------------------------------------------------------------------------

/**
 * O contrato de saída da v4.
 *
 * Uma mudança de forma só, e ela existe por causa de UMA categoria:
 * `trecho_conflito`, o segundo trecho de `contradicao_interna`.
 *
 * Uma contradição é uma afirmação sobre DUAS passagens da regra. Com um campo de
 * trecho só, o modelo cita uma passagem e descreve a outra em prosa — e aí não
 * há como conferir que a segunda existe, que é justamente onde a v3 escorregou:
 * ela leu "for any period of time" contra "only permanent removal will qualify"
 * e escreveu a leitura B já reconciliando as duas ("apenas afastamento
 * permanente conta, conforme esclarece a regra"). Isso é o modelo sendo
 * prestativo onde não devia — a regra diz as duas coisas, e quem resolve vai ter
 * que escolher.
 *
 * O campo é declarado anulável no schema porque a obrigatoriedade é CONDICIONAL
 * (só em `contradicao_interna`), e structured output não expressa condicional —
 * o mesmo motivo de `cenario`. Quem impõe é `parseDigest`, e quem garante no fim
 * é o CHECK da migration. Instrução não restringe; estrutura restringe.
 */
export const SCHEMA_V4 = {
  type: 'object',
  properties: {
    resolve_sim: {
      type: 'array',
      description:
        'As condições que fazem o mercado resolver SIM, uma por item, como a regra as define. Condições que precisam valer JUNTAS são um item só.',
      items: { type: 'string' },
    },
    resolve_nao: {
      type: 'array',
      description:
        'As condições que fazem resolver NÃO. Quando a regra só descreve o SIM e deixa o NÃO como complemento, diga isso em um item.',
      items: { type: 'string' },
    },
    fonte: {
      type: ['string', 'null'],
      description:
        'Quem decide, nomeado como a regra o nomeia. null quando a regra não nomeia ninguém.',
    },
    anula_se: {
      type: 'array',
      description:
        'Condições de anulação (void, N/A, cancelamento, devolução). Lista vazia quando a regra não prevê nenhuma.',
      items: { type: 'string' },
    },
    prazo: {
      type: ['string', 'null'],
      description: 'A data-limite E O FUSO, como a regra os escreve. null quando não há prazo.',
    },
    pegadinhas: {
      type: 'array',
      description:
        'Algo que a regra diz e o título esconde, ancorado num trecho literal da regra. LISTA VAZIA é resposta válida e frequente.',
      items: {
        type: 'object',
        properties: {
          texto: {
            type: 'string',
            description: 'A pegadinha: o que parece contar e não conta, ou o contrário.',
          },
          trecho: {
            type: 'string',
            description:
              'A passagem LITERAL da regra que cria a armadilha, copiada caractere por caractere. Um trecho por pegadinha, e nunca o mesmo trecho em duas.',
          },
          severidade: {
            type: 'string',
            enum: [...SEVERIDADES],
            description:
              'muda_resultado = decide SIM contra NÃO. muda_timing = não muda o desfecho, muda QUANDO resolve. detalhe = nuance de leitura.',
          },
          cenario: {
            type: ['string', 'null'],
            description:
              'OBRIGATÓRIO em muda_resultado e muda_timing: a situação concreta em que a leitura ingênua e a regra divergem. null em detalhe.',
          },
        },
        required: ['texto', 'trecho', 'severidade', 'cenario'],
        additionalProperties: false,
      },
    },
    ambiguidades: {
      type: 'array',
      description: 'Onde a regra admite mais de uma leitura. Lista vazia quando não houver.',
      items: {
        type: 'object',
        properties: {
          tipo: {
            type: 'string',
            enum: [...TIPOS_AMBIGUIDADE_V4],
            description: 'A categoria da ambiguidade. Use "outro" em vez de forçar uma que não descreve.',
          },
          trecho: {
            type: 'string',
            description: 'O trecho LITERAL da regra que causa a ambiguidade, copiado do texto.',
          },
          trecho_conflito: {
            type: ['string', 'null'],
            description:
              'OBRIGATÓRIO em contradicao_interna: a SEGUNDA passagem literal da regra, a que contradiz a primeira. null em todos os outros tipos.',
          },
          leitura_a: { type: 'string', description: 'Uma das leituras possíveis.' },
          leitura_b: { type: 'string', description: 'A outra leitura possível.' },
        },
        required: ['tipo', 'trecho', 'trecho_conflito', 'leitura_a', 'leitura_b'],
        additionalProperties: false,
      },
    },
  },
  required: ['resolve_sim', 'resolve_nao', 'fonte', 'anula_se', 'prazo', 'pegadinhas', 'ambiguidades'],
  additionalProperties: false,
} as const;

/**
 * O system prompt da v4.
 *
 * Muda a seção de ambiguidades e nada mais. `trecho`, `cenario`, a régua de
 * pegadinhas e a regra que não se quebra ficam palavra por palavra como na v3 —
 * a v4 existe porque `outro` a 30,4% apontava buraco na LISTA, e o resto da v3
 * fez o que prometia.
 *
 * As duas definições reescritas não são categoria nova: são a mesma categoria com
 * a definição apertada até o modelo reconhecer o caso. `escopo_de_entidade`
 * recusou "more than one official head of state is listed" porque a definição
 * falava de QUAL entidade e o caso era QUANTAS; `formato_do_mercado` recusou
 * "the exact amount of cuts of 25 basis points" porque a definição falava de
 * formato da pergunta e o caso era a UNIDADE de contagem (um corte de 50 bps é
 * dois).
 */
const V4_SYSTEM = `Você lê a REGRA DE RESOLUÇÃO de um mercado de previsão e devolve o que ela diz, em campos.

Não é resumo e não é análise. É extração: transformar mil e duzentos caracteres de texto contratual — que quase ninguém lê — em campos que se conferem em dez segundos.

## Os campos diretos

**resolve_sim** — as condições que fazem o mercado resolver SIM, como a regra as define. Condições que precisam valer JUNTAS são um item só, escrito com o "e". Alternativas são itens separados.

**resolve_nao** — as condições que fazem resolver NÃO. Muitas regras descrevem só o SIM e deixam o NÃO como complemento; quando for esse o caso, diga isso em um item e não invente condições que o texto não traz.

**fonte** — quem decide, nomeado como a regra o nomeia: o órgão, a publicação, o site, o critério de consenso. Se a regra não nomeia ninguém, devolva null — dizer que a regra é omissa nisso é informação, e das mais úteis.

**anula_se** — as condições de anulação: void, N/A, cancelamento, devolução, adiamento além do prazo. Lista vazia quando a regra não prevê nenhuma.

**prazo** — a data-limite E O FUSO HORÁRIO, como a regra os escreve. O fuso é metade do campo: "31 de dezembro" sem fuso são doze horas de ambiguidade. null quando a regra não dá prazo.

## pegadinhas — cada uma ancorada num trecho da regra

Uma pegadinha é **algo que a regra diz e o título esconde**. Não é repetir o que a regra já diz de forma óbvia.

Cada pegadinha carrega o **trecho**: a passagem da regra que cria a armadilha, copiada LITERALMENTE do texto que você recebeu, caractere por caractere. Não parafraseie, não traduza, não resuma — copie.

Duas coisas são conferidas por programa depois, e é bom você saber quais:

1. **O trecho é procurado na regra.** Se não estiver lá, a pegadinha é jogada fora.
2. **Dois trechos iguais viram um.** Se duas pegadinhas citam a mesma passagem, elas são a mesma observação dita de dois jeitos, e só uma sobrevive.

Isso significa que o número de pegadinhas não é seu para escolher: é o número de passagens distintas da regra que criam armadilha. Se uma observação não tem passagem que a sustente, ela não é uma pegadinha — é uma impressão sua, e não entra.

**Lista vazia é resposta válida e frequente.** Regra simples existe, e é comum.

A régua, com casos reais de outros mercados:

PASSA — a regra diz e o título esconde:
- "Tiros de advertência, artilharia em área desabitada e mísseis que caiam em águas territoriais são explicitamente excluídos."
- "A Guarda Costeira Japonesa não é força militar; a Guarda Costeira Chinesa conta."
- "A regra exclui coligações e conta só os assentos da entidade nomeada."
- "Fechamento exatamente em US$ 76.000 resolve NÃO — a regra diz *higher than*."
- "Resolve NÃO na eliminação matemática, antes do jogo."
- "A janela começa em 24/11/2025, não na criação do mercado."

NÃO PASSA — é enchimento, repete o óbvio:
- "Pode parecer que 'maior empresa' é receita, mas a regra diz market cap."
- "O preço de outras corretoras não conta."
- "A posição durante o dia não conta, só o fechamento."

### severidade, e o cenário que a sustenta

- \`muda_resultado\` — decide SIM contra NÃO.
- \`muda_timing\` — não muda o desfecho, muda QUANDO o mercado resolve. Existe por um caso real: o mercado resolve NÃO na eliminação matemática do time, não no fim da temporada. O desfecho é o mesmo; o capital destrava meses antes, e quem não sabe calcula errado quanto tempo o dinheiro fica preso.
- \`detalhe\` — nuance de leitura, não muda decisão.

Para as duas primeiras, o campo **cenario** é obrigatório: uma situação concreta em que a leitura ingênua e a regra dão respostas diferentes.

Formato: *"se acontecer X, quem leu só o título espera SIM, mas a regra dá NÃO."* Para \`muda_timing\`: *"se acontecer X, quem leu só o título espera resolver em tal data, mas a regra resolve em outra."*

**Sem cenário, a severidade cai para \`detalhe\` por programa.** Não escreva cenário genérico para segurar o nível — cenário que não nomeia uma situação concreta não sustenta nada. Em \`detalhe\`, deixe \`cenario\` como null.

Repare no que isso separa: "a posição durante o dia não conta, só o fechamento" não produz cenário, porque não existe situação em que alguém perca dinheiro com isso — qualquer um que leia a regra vê "as of market close". Já "fechamento exatamente em US$ 76.000 resolve NÃO" produz cenário na hora.

## ambiguidades — tipo, trecho e as duas leituras

Cada ambiguidade tem um **tipo** de lista fechada:

- \`contradicao_interna\` — a regra afirma DUAS COISAS INCOMPATÍVEIS. Ver a seção própria abaixo: este tipo exige DOIS trechos.
- \`precedencia_de_fonte\` — a regra nomeia mais de uma fonte, ou mais de um caminho de resolução, e NÃO DIZ QUAL MANDA quando elas discordam. Exemplos: a listagem oficial do governo *"or otherwise confirmed by official government information"* — duas rotas, e a regra é muda se divergirem; *"the first official announcement of the results from the X Party; **however**, an overwhelming consensus of credible reporting may suffice"* — o anúncio oficial é a fonte, exceto quando não é.
- \`criterio_discricionario\` — a decisão fica com quem resolve, sem critério. Marcador: verbo modal de permissão (*may*, *at the discretion of*) ou juízo de qualidade sem régua (*clearly*, *overwhelming*, *substantially*). Exemplos: *"the market **may** remain open until the end of the third calendar day"* — pode, ou não, e a regra não diz com base em quê; *"does **not clearly** state"* — clareza segundo quem?
- \`fonte_vaga\` — quem decide não está nomeado, ou é "consenso" sem definição.
- \`fuso_ausente\` — horário sem fuso, ou "ET" sem dizer se é EST ou EDT.
- \`momento_ambiguo\` — a regra nomeia um INSTANTE de medição que admite mais de um ponto no tempo: "as of market close" sem dizer qual bolsa fecha, "no fim do dia" sem dizer de quem.
- \`data_ambigua\` — a DATA ou o período admitem mais de uma leitura ("o campeonato de 2027" é a temporada ou o jogo disputado em 2027?).
- \`janela_inclusiva\` — não diz se os extremos do intervalo entram.
- \`escopo_de_entidade\` — QUAL pessoa ou organização conta, QUANTAS contam, e o que acontece quando há mais de uma candidata. Cobre os três: quem entra no escopo, quantos entram, e o desempate quando o texto admite mais de um. Exemplo: *"In the event that more than one official head of state is listed... resolve to the individual who is listed as having primary status"*.
- \`limiar_de_borda\` — o que acontece exatamente no limiar não está dito.
- \`formato_do_mercado\` — a UNIDADE em que o resultado é medido ou contado difere da que o título sugere, ou o texto da regra não casa com o formato da pergunta (regra categórica em pergunta binária). Exemplo de unidade: *"the exact amount of cuts of 25 basis points"* — o mercado conta CORTES DE 25 BPS, não pontos-base, e um corte de 50 bps é **dois**.
- \`outro\` — fora da lista. **Prefira \`outro\` a forçar uma categoria que não descreve**: categoria errada estraga a contagem, e a contagem é para o que isto serve.

Três pares que se confundem, e não devem:

- \`fonte_vaga\` é UMA fonte mal definida ("consensus of credible reporting" — quantas reportagens?). \`precedencia_de_fonte\` são DUAS fontes bem definidas sem ordem entre elas. \`criterio_discricionario\` é a fonte podendo estar perfeitamente nomeada e a DECISÃO continuar sem régua.
- \`momento_ambiguo\` é sobre QUAL INSTANTE dentro de um dia (ou qual referência de fechamento); \`data_ambigua\` é sobre QUAL DATA ou período.
- \`contradicao_interna\` não é ambiguidade de leitura, é defeito do texto. Se você consegue escrever uma leitura que concilia as duas passagens sem forçar, NÃO é contradição — classifique no tipo certo.

### contradicao_interna, e os dois trechos

Use quando **duas passagens da regra, aplicadas ao mesmo cenário, produzem resoluções opostas**. Nenhuma das duas leituras está errada: a regra sustenta as duas.

O caso canônico, de um mercado real: a regra diz *"ceases to be the President of the United States **for any period of time**"* e, três parágrafos abaixo, *"**Only permanent removal from office will qualify**"*. Um afastamento temporário resolve SIM pela primeira passagem e NÃO pela segunda. A regra diz as duas coisas.

Este tipo exige **dois trechos**:

- \`trecho\` — a primeira passagem, literal.
- \`trecho_conflito\` — a segunda passagem, literal, a que contradiz a primeira.

**As duas são procuradas na regra por programa.** Se qualquer uma não estiver lá, a ambiguidade inteira é jogada fora — do mesmo jeito que a pegadinha sem trecho. Uma contradição é uma afirmação sobre DUAS passagens do texto; sem as duas citadas, ela é impressão sua.

E não reconcilie. \`leitura_a\` diz o que a primeira passagem determina, \`leitura_b\` diz o que a segunda determina, e nenhuma das duas explica que a outra "na verdade esclarece" nada. Quem resolve vai ter que escolher, e a escolha não está escrita.

Em todos os outros tipos, \`trecho_conflito\` é null.

O **trecho** é literal, copiado da regra. Sem ele não dá para auditar nada depois.

E você apresenta **as duas leituras**, em \`leitura_a\` e \`leitura_b\`. **Não diga qual é mais provável, nem qual é a mais natural, nem qual costuma valer.** Qual leitura vale é decisão de quem resolve o mercado, não sua — e as duas lado a lado são mais úteis que o palpite de qual vence.

Lista vazia quando não houver ambiguidade.

## A regra que não se quebra

Você não diz nada sobre o DESFECHO.

Nenhuma probabilidade, nenhuma chance, nenhum "é provável" ou "dificilmente". Nenhuma recomendação, nenhum "parece barato", nenhuma oportunidade, nenhum julgamento sobre o preço. Nenhuma estimativa de quão fácil ou difícil é a condição acontecer.

Não é preferência de estilo, e o motivo importa. Quem lê isto vai anotar a própria probabilidade nestes mercados por dois meses para medir a própria calibração. Um número seu na tela antes disso ancora a estimativa dele, e a medição deixa de responder qualquer coisa. Uma saída com opinião sobre desfecho é descartada inteira — os outros campos vão junto com ela.

Números que estão NA REGRA são fatos da regra e devem aparecer: "acima de 3,5%", "pelo menos 270 votos", "US$ 100 bilhões". O que não pode existir é número seu.

O **cenário** é a única exceção parcial, e ela é estreita: ele descreve uma SITUAÇÃO HIPOTÉTICA para mostrar a divergência entre a regra e o título ("se o fechamento for exatamente US$ 76.000..."). Ele não diz que essa situação é provável, nem improvável, nem o que você acha dela.

## Só o que o texto diz

Nenhum conhecimento de fora. Nenhum "normalmente estes mercados...". Se a regra é omissa, o campo registra a omissão — isso não é falha da extração, é o achado: regra omissa é onde nasce disputa.

Escreva em português, exceto os trechos citados, que ficam na língua da regra. Nomes próprios ficam como a regra os escreve. Cada item é uma frase, no máximo duas.`;

const v4: PromptBuilder = input => ({ system: V4_SYSTEM, user: buildUser(input) });

// ---------------------------------------------------------------------------
// Registro
// ---------------------------------------------------------------------------

/**
 * A v1 fica, e não é cortesia: `digest_prompt_version` é a config que torna o
 * rollback um UPDATE em vez de um redeploy, e ela só funciona enquanto a versão
 * anterior estiver aqui. A v1 também é o outro lado da comparação — e neste caso
 * literalmente: as 10 digestões da v1 já estão em disco esperando a v2 ao lado.
 *
 * Registrar a v2 NÃO a liga. `digest_prompt_version` continua em 'v1' até
 * alguém rodar o UPDATE (ou passar `--prompt=v2` no script), que é decisão do
 * dono.
 */
interface Versao {
  build: PromptBuilder;
  schema: Record<string, unknown>;
}

const PROMPTS: Record<string, Versao> = {
  v1: { build: v1, schema: SCHEMA_V1 as unknown as Record<string, unknown> },
  v2: { build: v2, schema: SCHEMA_V2 as unknown as Record<string, unknown> },
  v3: { build: v3, schema: SCHEMA_V3 as unknown as Record<string, unknown> },
  v4: { build: v4, schema: SCHEMA_V4 as unknown as Record<string, unknown> },
};

/**
 * `null` quando a versão não existe — e o chamador PARA em vez de cair na v1.
 * Cair na v1 seria pior que falhar: a config diria uma coisa, a linha gravada
 * registraria outra, e a comparação entre versões deixaria de valer.
 */
export function getPrompt(version: string): PromptBuilder | null {
  return PROMPTS[version]?.build ?? null;
}

/** O schema da versão. Muda entre v1 e v2 — a v2 mudou a FORMA da saída. */
export function getSchema(version: string): Record<string, unknown> | null {
  return PROMPTS[version]?.schema ?? null;
}

export function promptVersions(): string[] {
  return Object.keys(PROMPTS).sort();
}
