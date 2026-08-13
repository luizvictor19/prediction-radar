import { TIPOS_DE_RELACAO } from './taxonomia.js';

/**
 * Prompts versionados do extrator de relações (spec 003, Parte D).
 *
 * Mesmo desenho de `src/verticals/analyst-prompts.ts`: as versões convivem no
 * código, a config escolhe qual roda, e é isso que torna rollback um UPDATE em
 * vez de redeploy. Versão desconhecida faz o chamador PARAR — cair na v1
 * silenciosamente faria a config dizer uma coisa e a linha gravada outra.
 *
 * ## Este módulo não conhece desfecho, e isso é a defesa principal da fase
 *
 * `MercadoParaPrompt` não tem campo de resultado, e este arquivo não importa
 * `desfecho.ts`. O prompt é montado a partir de um tipo que fisicamente não
 * carrega a resposta. Se ele carregasse, o modelo deduziria a relação do
 * resultado em vez de ler as perguntas, e os 90% da Parte E seriam ficção.
 *
 * ## E não conhece PREÇO, o que é menos óbvio e igualmente deliberado
 *
 * Em mercado resolvido, `outcomePrices` É o desfecho — vem `["1","0"]`. Passar
 * "preço atual" para o modelo neste gabarito seria entregar a resposta com outro
 * nome.
 *
 * Mas o corte não é só do gabarito: o preço não entra em prompt NENHUM, nem no
 * universo aberto. Relação lógica não tem data (Parte F) — "X vence a
 * Pensilvânia implica X vence a eleição" não depende de quanto cada uma custa
 * hoje. A desigualdade de preço é aritmética, e aritmética se faz em código
 * depois, com o preço na mão. Mandar o número junto só criaria a chance de o
 * modelo inferir a relação do preço, que é o erro que a spec 003 inteira existe
 * para não cometer de novo.
 */

// ---------------------------------------------------------------------------
// O que o modelo recebe
// ---------------------------------------------------------------------------

export interface MercadoParaPrompt {
  /** Rótulo curto usado na citação: `M1`, `M2`, ... */
  rotulo: string;
  /** A pergunta do mercado, como a Polymarket a escreve. */
  pergunta: string;
  /**
   * O desfecho que torna a proposição VERDADEIRA — `outcomes[0]` da Gamma.
   *
   * É definição do mercado, não resultado: existe desde que ele abre. Sem isto
   * "Total Games O/U 4.5" não é proposição nenhuma, e metade do universo (as
   * saídas `Over`/`Under` e as de nome de time) ficaria ilegível.
   */
  desfechoSim: string;
  /** A outra saída. Entra para a proposição não ter ambiguidade. */
  desfechoNao: string;
  /** As regras de resolução — o `description` da Gamma. */
  regras: string;
  fechamento: string | null;
  /**
   * `resolutionSource` da Gamma, vazio em 38% dos mercados (medido na fase 1).
   * Ausência é motivo de ressalva, não de `null` — está dito no system prompt.
   */
  fonteDeResolucao: string | null;
}

export interface EntradaDoPrompt {
  grupoId: string;
  /** Por que o gerador juntou estes mercados. Contexto, não conclusão. */
  motivoDoGrupo: string;
  mercados: readonly MercadoParaPrompt[];
}

export interface PromptMontado {
  system: string;
  user: string;
}

export type ConstrutorDePrompt = (entrada: EntradaDoPrompt) => PromptMontado;

// ---------------------------------------------------------------------------
// O schema de saída
// ---------------------------------------------------------------------------

/**
 * Schema da resposta, via `output_config.format`.
 *
 * A API garante FORMA — chaves presentes, tipos certos, `enum` respeitado. O que
 * ela NÃO garante, e por isso `parseRelacoes` não é redundante:
 *
 *   - **faixa numérica**: `minimum`/`maximum` são removidos do schema pelo SDK,
 *     então `confianca: 1.4` passa pela API;
 *   - **aridade por tipo**: `conjuncao` com dois mercados é forma válida e
 *     relação ilegível;
 *   - **rótulo existente**: citar `M9` num grupo de 4 é citação inventada — o
 *     defeito exato que a validação de rótulo existe para pegar.
 */
export const RELACOES_SCHEMA = {
  type: 'object',
  properties: {
    relacoes: {
      type: 'array',
      description:
        'As relações lógicas encontradas entre os mercados do grupo. Lista vazia é uma resposta válida e esperada: significa que nenhum par tem relação lógica.',
      items: {
        type: 'object',
        properties: {
          tipo: {
            type: 'string',
            enum: [...TIPOS_DE_RELACAO],
            description: 'O tipo da relação, da lista fechada.',
          },
          mercados: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Os rótulos envolvidos, na ordem que o tipo exige. implica: [A,B] com A só acontecendo se B acontecer. conjuncao: [C,A,B] com C sendo "A e B". Os demais: dois rótulos, ordem indiferente; particiona aceita o conjunto inteiro.',
          },
          confianca: {
            type: 'number',
            description: 'Confiança na relação, entre 0 e 1.',
          },
          justificativa: {
            type: 'string',
            description:
              'Uma frase citando o trecho das perguntas que sustenta a relação.',
          },
          ressalva_de_resolucao: {
            type: ['string', 'null'],
            description:
              'Diferença nas regras de resolução que pode quebrar a relação: fonte distinta, data distinta, condição de void assimétrica. null significa que você leu as regras das duas pontas e não viu diferença.',
          },
        },
        required: ['tipo', 'mercados', 'confianca', 'justificativa', 'ressalva_de_resolucao'],
        additionalProperties: false,
      },
    },
  },
  required: ['relacoes'],
  additionalProperties: false,
} as const;

// ---------------------------------------------------------------------------
// v1
// ---------------------------------------------------------------------------

/**
 * O system prompt.
 *
 * Escrito para um modelo já calibrado: sem "seja rigoroso", sem "pense passo a
 * passo". O que sobra é o que só quem escreveu o sistema sabe — o que é a
 * proposição de um mercado, por que abster-se é o comportamento desejado, e o
 * que `null` significa na ressalva.
 *
 * A assimetria da Parte E está dita em números, não em adjetivo: relação falsa
 * custa dinheiro, relação perdida custa zero. É a única instrução do texto que
 * pede um viés, e ela pede o viés na direção de calar.
 */
const V1_SYSTEM = `Você lê perguntas de mercados de previsão e identifica RELAÇÕES LÓGICAS entre elas.

Você não prevê nada. Não estima probabilidade, não diz o que vai acontecer, não usa conhecimento sobre o mundo para adivinhar desfecho. Sua tarefa é ler o texto de duas ou mais perguntas e dizer se uma restringe a outra por necessidade lógica.

## A proposição de um mercado

Cada mercado é uma AFIRMAÇÃO que pode dar certo ou errado. A afirmação é "esta pergunta resolve no desfecho SIM indicado". Quando a pergunta é "Total Games O/U 4.5" e o desfecho SIM é "Over", a afirmação é "o total de games passou de 4.5".

Trabalhe sempre com a afirmação, nunca com a pergunta solta.

## A lista fechada

- \`implica\` — A só acontece se B acontecer. Ordem: [A, B]. Restringe P(A) ≤ P(B).
- \`exclui\` — A e B não podem acontecer juntos. Restringe P(A) + P(B) ≤ 1.
- \`equivale\` — mesmo evento, roupas diferentes. Restringe P(A) = P(B).
- \`particiona\` — exatamente um do conjunto acontece. Restringe Σ P = 1. Passe o conjunto inteiro.
- \`conjuncao\` — C é "A e B". Ordem: [C, A, B]. Restringe P(C) ≤ min(P(A),P(B)) e P(C) ≥ P(A)+P(B)−1.
- \`nenhuma\` — sem relação lógica.

Não invente tipo fora desta lista e não descreva relação em texto livre.

## Não liste o que não tem relação

A lista vazia já significa "nenhum par destes mercados tem relação lógica". Use \`nenhuma\` só quando quiser registrar que considerou um par específico e o rejeitou por um motivo que vale a pena guardar. Não emita uma entrada por par.

## Necessidade lógica, e não correlação

A relação tem que valer por CONSTRUÇÃO das duas perguntas, em todo desfecho possível. Duas perguntas sobre o mesmo jogo, o mesmo time ou o mesmo dia não têm relação lógica por isso. "Time A vence" e "Time A marca primeiro" andam juntas na prática e não se implicam: dá para marcar primeiro e perder.

O teste é: existe algum desfecho em que a restrição seria violada? Se existe, a relação não é essa. Se você precisa saber alguma coisa sobre o mundo — quem é favorito, quanto costuma sair —, não é relação lógica.

Cuidado com os limiares: "Over 4.5" implica "Over 3.5", e não o contrário. A direção da implicação é do mais forte para o mais fraco, e trocá-la é o erro mais comum aqui.

## Abster-se é barato, errar não é

Uma relação falsa faz alguém montar uma operação achando que travou lucro quando tomou posição direcional: custa dinheiro. Uma relação perdida faz alguém não ver uma oportunidade: custa zero.

Na dúvida, não emita. Meia dúzia de relações certas vale mais que trinta com três erradas. Não preencha a lista para parecer útil.

## A justificativa

Uma frase, citando o trecho das perguntas que sustenta a relação. Cite o texto, não o seu raciocínio. "M3 pede 'Over 5.5' e M1 pede 'Over 3.5'; todo total acima de 5.5 está acima de 3.5" é justificativa. "É evidente pela estrutura dos mercados" não é.

## Rótulos

Só cite rótulos que você recebeu. Um rótulo inexistente invalida a resposta inteira, não só aquela entrada.

## A ressalva de resolução

Duas perguntas podem ser logicamente ligadas e resolverem por fontes diferentes, em datas diferentes, com regras de void diferentes. Aí a relação tem furo, e o furo só aparece depois do dinheiro entrar.

Leia as regras de resolução das DUAS pontas e declare em \`ressalva_de_resolucao\` qualquer diferença que possa quebrar a relação: fonte distinta, data de fechamento distinta, condição de void ou cancelamento assimétrica, critério de arredondamento diferente.

\`null\` significa "li as regras das duas pontas e não vi diferença". NÃO significa "não olhei". Se a fonte de resolução não aparece em uma das pontas, isso por si é motivo de ressalva — escreva a ressalva, não coloque null.

O campo é só para DIFERENÇA. Não escreva frase confirmando que está tudo igual — "mesma fonte, mesma data" é exatamente o que \`null\` já diz, e escrevê-la torna impossível separar as relações com ressalva das sem.`;

function formatarMercado(m: MercadoParaPrompt): string {
  const linhas = [
    `[${m.rotulo}] ${m.pergunta}`,
    `  SIM = resolve em "${m.desfechoSim}"   |   NÃO = resolve em "${m.desfechoNao}"`,
    m.fechamento !== null ? `  fecha em: ${m.fechamento}` : null,
    m.fonteDeResolucao !== null && m.fonteDeResolucao.trim().length > 0
      ? `  fonte declarada: ${m.fonteDeResolucao}`
      : '  fonte declarada: (campo vazio)',
    `  regras de resolução: ${m.regras}`,
  ];
  return linhas.filter((l): l is string => l !== null).join('\n');
}

/**
 * A mensagem do usuário, COMPARTILHADA por todas as versões.
 *
 * Compartilhada pelo mesmo motivo do analista: a medição corta por versão de
 * prompt, e o corte só responde "a v2 é melhor?" enquanto a v2 mudar uma coisa
 * só. O dia em que uma versão precisar mudar o que é ENVIADO, ela ganha o
 * próprio construtor e a comparação passa a ter duas variáveis — decisão a tomar
 * naquele momento, não a escorregar por conveniência.
 */
function montarUsuario(entrada: EntradaDoPrompt): string {
  const cabecalho = [
    `Grupo: ${entrada.grupoId}`,
    `Por que estes mercados vieram juntos: ${entrada.motivoDoGrupo}`,
    '',
    'O agrupamento é uma heurística de texto e estrutura, NÃO uma afirmação de que existe relação.',
    'É perfeitamente possível que nenhum par aqui tenha relação lógica.',
  ].join('\n');

  const mercados = entrada.mercados.map(formatarMercado).join('\n\n');

  return `${cabecalho}\n\n## Mercados\n\n${mercados}\n\nQuais relações lógicas existem entre estes mercados?`;
}

const v1: ConstrutorDePrompt = (entrada) => ({ system: V1_SYSTEM, user: montarUsuario(entrada) });

// ---------------------------------------------------------------------------
// Registro
// ---------------------------------------------------------------------------

const PROMPTS: Record<string, ConstrutorDePrompt> = { v1 };

export const VERSAO_PADRAO = 'v1';

/**
 * `null` quando a versão não existe — e o chamador PARA em vez de cair na v1.
 * Cair na v1 faria a config dizer uma coisa e o registro gravado outra, e a
 * comparação entre versões, que é a razão de a coluna existir, passaria a mentir.
 */
export function obterPrompt(versao: string): ConstrutorDePrompt | null {
  return PROMPTS[versao] ?? null;
}

export function versoesDePrompt(): string[] {
  return Object.keys(PROMPTS).sort();
}
