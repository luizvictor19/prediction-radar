import { createHash } from 'node:crypto';
import type { CompletionResult, LlmClient, TokenUsage } from '../llm/client.js';
import { clientFor } from '../llm/registry.js';
import {
  getPrompt,
  getSchema,
  SEVERIDADES,
  tiposDe,
  TIPOS_AMBIGUIDADE_V4,
  type BuiltPrompt,
  type DigestInput,
} from './prompts.js';

/**
 * A digestão de regras: o texto de resolução vira campo estruturado.
 *
 * Um mercado de previsão publica a regra que decide o dinheiro — mediana de
 * 1.262 caracteres, com condição, cláusula de anulação, fonte nomeada e critério
 * de desempate, preenchida em 100% dos mercados. Quase ninguém lê. Foram mais de
 * 1.150 mercados disputados em 2026, e num caso de US$ 60 milhões a briga foi se
 * "vendeu até 31 de maio" significava a venda ou a divulgação dela.
 *
 * Este arquivo é o contrato e a chamada. Quem decide QUAIS mercados digerir e se
 * vale o gasto é `scripts/digerir-regras.ts`. Quem fala com o fornecedor é
 * `src/llm/` — aqui não há nada específico de fornecedor além da tabela de preço.
 *
 * O desenho é o do analista (`src/verticals/analyst.ts`), de propósito: mesma
 * separação entre contrato e chamada, mesma telemetria por chamada, mesma
 * validação que falha alto em vez de gravar linha pela metade.
 */

const COMPONENT = 'rule_digest';

/**
 * Teto de saída da chamada.
 *
 * Era 8.000, com o comentário de que 8.000 era "generoso". Não era: na primeira
 * rodada da v2 do prompt, **4 de 10 chamadas truncaram** — e as 6 que passaram
 * tiveram 4.540 a 7.812 tokens de saída, encostando no teto. Truncar perde a
 * chamada inteira, que é o gasto sem o produto, e ainda aparece como taxa de
 * saída inválida de 40% que parece defeito do modelo e é defeito do teto.
 *
 * Duas coisas empurram a saída para cima e as duas contam aqui: o teto cobre
 * PENSAMENTO + texto juntos, e o pensamento é a maior parte (a saída visível da
 * v2 tem poucos milhares de caracteres); e a v2 pede objetos — cada ambiguidade
 * leva tipo, trecho e duas leituras onde a v1 pedia uma frase.
 *
 * E 16.000 também não bastou: a v3 truncou 1 de 10 ali, com mediana de 12.247 e
 * máximo de 15.946. Cada versão do prompt pede mais campos por item — a v3 põe
 * trecho e cenário em cada pegadinha — e o raciocínio cresce junto.
 *
 * 32.000 é o dobro do maior caso da v3, na mesma regra de sempre. Subir o teto
 * não custa nada: cobra-se o que foi gerado, não o que foi permitido. O que
 * custa é apertá-lo — e o histórico deste arquivo é de subestimar duas vezes
 * seguidas, o que é razão para folgar mais e não menos.
 */
const MAX_TOKENS = 32_000;

// ---------------------------------------------------------------------------
// Preço
// ---------------------------------------------------------------------------

interface ModelPrice {
  /** US$ por milhão de tokens. */
  input: number;
  output: number;
}

/**
 * Preço por modelo, em US$/MTok.
 *
 * Tabela no código e não em config: é fato do fornecedor, não escolha do dono. O
 * que é escolha — qual modelo roda — está em `system_config.digest_model`.
 *
 * **Modelo fora desta tabela não roda.** Sem preço não há como somar gasto, sem
 * soma não há teto, e um teto que não sabe contar é o mesmo que não ter teto,
 * com a agravante de parecer que tem.
 *
 * Tabela própria, e não a de `src/verticals/analyst.ts`, por duas razões que não
 * são preguiça: aquela é só de modelos da Anthropic, e o Claude aqui entra pelo
 * preço de tabela (US$ 3/15 em Sonnet 5) e não pelo promocional que vence em
 * 31/08/2026 — a comparação do degrau 2 decide o que vai rodar por meses, e
 * decidir por um preço que expira em duas semanas é decidir errado.
 */
const MODEL_PRICING: Record<string, ModelPrice> = {
  // Aposentados em 24/07/2026: `deepseek-chat` e `deepseek-reasoner`. Não estão
  // aqui de propósito — escrever um deles de memória agora falha no `knownModel`
  // em vez de falhar com 404 no meio de um laço de 673.
  'deepseek-v4-flash': { input: 0.14, output: 0.28 },
  'deepseek-v4-pro': { input: 0.435, output: 0.87 },
  'claude-sonnet-5': { input: 3, output: 15 },
  'claude-haiku-4-5': { input: 1, output: 5 },
};

export function knownModel(model: string): boolean {
  return model in MODEL_PRICING;
}

export function pricedModels(): string[] {
  return Object.keys(MODEL_PRICING).sort();
}

/**
 * Custo da chamada. `null` para modelo sem preço conhecido.
 *
 * A leitura de cache entra a 0,1x da entrada. Ao contrário do analista — cujas
 * chamadas são espaçadas por dezenas de minutos e nunca leem cache —, aqui o
 * laço dispara centenas de chamadas em minutos com o MESMO system prompt, e a
 * DeepSeek faz cache automático. A leitura de cache é esperada e não é ruído.
 *
 * O fator 0,1 é aproximação declarada, não preço confirmado do fornecedor. É por
 * isso que o relatório imprime os tokens de cache em coluna separada: quando a
 * fatura chegar, dá para conferir o termo que foi estimado em vez de descobrir
 * que a conta inteira estava errada.
 */
export function estimateCostUsd(model: string, usage: TokenUsage): number | null {
  const price = MODEL_PRICING[model];
  if (price === undefined) return null;

  const perToken = (rate: number): number => rate / 1_000_000;

  const cost =
    usage.input * perToken(price.input) +
    usage.output * perToken(price.output) +
    usage.cacheRead * perToken(price.input) * 0.1 +
    usage.cacheWrite * perToken(price.input) * 1.25;

  return Math.round(cost * 1_000_000) / 1_000_000;
}

// ---------------------------------------------------------------------------
// A estimativa que o `--dry-run` imprime
// ---------------------------------------------------------------------------

/**
 * Quantos caracteres por token, na entrada.
 *
 * 4 é a razão usual para texto em inglês, que é o idioma das descrições da
 * Polymarket. É ESTIMATIVA DECLARADA: nenhum dos dois fornecedores expõe
 * contador de token gratuito para este formato, e chamar a API para contar
 * seria uma chamada paga antes do `--dry-run`, que é justamente o que o teto
 * existe para impedir.
 *
 * A divergência entre esta conta e a fatura real é medida no degrau 1 e sai no
 * relatório. É por isso que o degrau 1 existe.
 */
const CHARS_PER_TOKEN = 4;

/**
 * Saída esperada por digestão. **Medido, não estimado.**
 *
 * Começou em 700 — sete campos, a maioria listas curtas — e o degrau 1 mostrou
 * 4.832 tokens de MEDIANA em `deepseek-v4-flash` (9 digestões válidas, faixa de
 * 19s a 64s de latência). Sete vezes o chute, e o erro é todo deste lado: a
 * entrada foi estimada em ~1,2k contra 1.056 medidos.
 *
 * A explicação é que `completion_tokens` inclui o raciocínio do modelo, não só o
 * JSON — o objeto devolvido tem alguns milhares de caracteres, o resto é
 * pensamento cobrado como saída. E a saída é a metade cara da conta: 2x a
 * entrada em Flash, 5x em Sonnet.
 *
 * A v2 do prompt subiu de novo: mediana de **6.941** e máximo de 11.178, nos
 * mesmos 10 mercados. Faz sentido — a v2 pede objetos onde a v1 pedia frases
 * (cada ambiguidade leva tipo, trecho e duas leituras), e o raciocínio cresce
 * junto com a estrutura pedida.
 *
 * A v3 subiu de novo, e mais: mediana de **12.247**, máximo de 15.946. Trecho e
 * cenário em cada pegadinha custam caro, e a curva 700 → 4.832 → 6.941 → 12.247
 * é o registro de que cada campo novo cobra.
 *
 * 12.000 é a mediana da v3. Errar para cima é barato e errar para baixo é a
 * fatura surpresa, e há uma folga natural do outro lado: a estimativa ignora o
 * cache de contexto, que na prática derruba a entrada de ~1.050 tokens para ~83
 * (o system prompt é idêntico entre chamadas e a DeepSeek o cacheia sozinha).
 *
 * O número vale para Flash e para a v3; o do Claude sai no degrau 2, e uma
 * versão nova de prompt pede recalibração antes de estimar um laço grande.
 */
const EXPECTED_OUTPUT_TOKENS = 12_000;

export interface CostEstimate {
  /** Tokens de entrada estimados, incluindo o system prompt. */
  inputTokens: number;
  outputTokens: number;
  usd: number;
}

/**
 * O custo estimado de UMA digestão, sem gastar nada.
 *
 * Estima sobre o prompt de verdade — system e user montados — e não sobre a
 * descrição solta. O system prompt tem alguns milhares de caracteres e é
 * repetido em toda chamada; deixá-lo de fora subestimaria o laço inteiro.
 */
export function estimateOne(
  model: string,
  promptVersion: string,
  input: DigestInput,
): CostEstimate | null {
  const price = MODEL_PRICING[model];
  const build = getPrompt(promptVersion);
  if (price === undefined || build === null) return null;

  const prompt = build(input);
  const inputTokens = Math.ceil((prompt.system.length + prompt.user.length) / CHARS_PER_TOKEN);
  const usd =
    (inputTokens * price.input + EXPECTED_OUTPUT_TOKENS * price.output) / 1_000_000;

  return {
    inputTokens,
    outputTokens: EXPECTED_OUTPUT_TOKENS,
    usd: Math.round(usd * 1_000_000) / 1_000_000,
  };
}

// ---------------------------------------------------------------------------
// O hash da descrição
// ---------------------------------------------------------------------------

/**
 * A identidade do texto que foi digerido.
 *
 * Regra não muda, então digere uma vez e reusa para sempre. Mas "não muda" é
 * quase-sempre: a Polymarket edita descrição, e uma digestão que envelhece em
 * silêncio é o defeito que este projeto mais pagou para aprender. Com o hash
 * gravado, texto editado tem hash diferente e o mercado volta para a fila
 * sozinho — sem ninguém precisar lembrar de conferir.
 *
 * Hash completo, sem cortar em 32 como o `fingerprintFragments` do analista: ali
 * o hash é chave de deduplicação de curto prazo, aqui ele é o que decide se uma
 * digestão de meses atrás ainda vale. Colisão parcial custaria caro e os 32
 * caracteres a mais não custam nada.
 */
export function hashDescription(description: string): string {
  return createHash('sha256').update(description).digest('hex');
}

// ---------------------------------------------------------------------------
// O contrato de saída, e sua validação
// ---------------------------------------------------------------------------

export type Severidade = (typeof SEVERIDADES)[number];
export type TipoAmbiguidade = (typeof TIPOS_AMBIGUIDADE_V4)[number];

/**
 * Uma pegadinha: algo que a regra diz e o título esconde.
 *
 * `severidade` é `null` na v1, que não a pedia. Não é "desconhecida" nem
 * "detalhe" — é AUSENTE, e a diferença importa: contar as v1 como `detalhe`
 * inflaria a categoria com material que nunca foi classificado.
 *
 * `trecho` e `cenario` chegam na v3, e são o que a transforma de afirmação em
 * afirmação conferível: o trecho tem que existir na regra e ser único, e o
 * cenário é o que sustenta as duas severidades fortes.
 */
export interface Pegadinha {
  texto: string;
  severidade: Severidade | null;
  /** A passagem literal da regra que cria a armadilha. `null` antes da v3. */
  trecho: string | null;
  /** A situação concreta em que título e regra divergem. `null` em `detalhe`. */
  cenario: string | null;
}

/**
 * Uma ambiguidade: onde a regra admite mais de uma leitura.
 *
 * Na v1 era texto solto, e é por isso que `tipo`, `trecho` e `leituraB` são
 * anuláveis — a digestão de ontem continua legível ao lado da de hoje sem
 * inventar categoria para ela.
 */
export interface Ambiguidade {
  tipo: TipoAmbiguidade | null;
  /** O trecho literal da regra que a causa. `null` na v1. */
  trecho: string | null;
  /**
   * A SEGUNDA passagem literal, a que contradiz a primeira. Preenchido só em
   * `contradicao_interna`, e obrigatório lá: uma contradição é uma afirmação
   * sobre duas passagens do texto, e com um campo só a segunda vira prosa que
   * ninguém confere. `null` em todos os outros tipos e em toda versão antes da
   * v4.
   */
  trechoConflito: string | null;
  leituraA: string;
  /** A outra leitura. `null` na v1, que pedia uma frase só. */
  leituraB: string | null;
}

export interface DigestOutput {
  resolveSim: string[];
  resolveNao: string[];
  fonte: string | null;
  anulaSe: string[];
  prazo: string | null;
  pegadinhas: Pegadinha[];
  ambiguidades: Ambiguidade[];
}

export type DigestFailureCode =
  | 'not_json'
  | 'schema'
  | 'sem_resolve_sim'
  | 'severidade_invalida'
  | 'tipo_invalido'
  | 'opiniao'
  | 'refusal'
  | 'truncated'
  | 'no_text'
  | 'unknown_model'
  | 'unknown_prompt'
  | 'unknown_provider'
  | 'api_error';

export class DigestError extends Error {
  constructor(
    readonly code: DigestFailureCode,
    message: string,
  ) {
    super(message);
    this.name = 'DigestError';
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readStringList(raw: unknown, field: string): string[] {
  if (!Array.isArray(raw)) {
    throw new DigestError('schema', `${field} não é lista: ${JSON.stringify(raw)}`);
  }

  const out: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'string') {
      throw new DigestError('schema', `${field} tem item não-string: ${JSON.stringify(entry)}`);
    }
    const trimmed = entry.trim();
    // Item vazio dentro da lista é ruído silencioso: some do relatório e conta
    // como conteúdo em qualquer medida de "quantas pegadinhas por mercado".
    if (trimmed.length > 0) out.push(trimmed);
  }
  return out;
}

function requiredString(record: Record<string, unknown>, key: string, where: string): string {
  const value = record[key];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new DigestError('schema', `${where}.${key} ausente ou vazio: ${JSON.stringify(value)}`);
  }
  return value.trim();
}

/**
 * As pegadinhas: (texto, severidade) na v2, mais (trecho, cenário) na v3.
 *
 * Severidade fora da lista fechada RECUSA a digestão inteira, e não vira
 * `detalhe`. O motivo é o uso: severidade existe para separar "decide SIM contra
 * NÃO" de "muda quando o capital destrava", e uma categoria que aceita lixo em
 * silêncio devolve exatamente a mesma soma que não ter categoria nenhuma.
 *
 * A conferência do TRECHO é outra coisa e trata diferente: item cujo trecho não
 * existe na regra é DESCARTADO, e o resto da digestão vive. A diferença é
 * proposital — severidade inválida é a resposta malformada, e trecho inexistente
 * é uma pegadinha sem fonte no meio de outras que têm. Derrubar a digestão
 * inteira por causa de um item jogaria fora o material bom junto com o
 * enchimento, e é o enchimento que se quer podar.
 */
function readPegadinhas(
  raw: unknown,
  version: string,
  descricao: string,
  descartes: Descartes,
): Pegadinha[] {
  if (!Array.isArray(raw)) {
    throw new DigestError('schema', `pegadinhas não é lista: ${JSON.stringify(raw)}`);
  }

  const exigeTrecho = version !== 'v1' && version !== 'v2';

  const out: Pegadinha[] = [];
  for (const entry of raw) {
    const record = asRecord(entry);
    if (record === null) {
      throw new DigestError('schema', `pegadinha não é objeto: ${JSON.stringify(entry)}`);
    }

    const texto = requiredString(record, 'texto', 'pegadinha');
    const severidade = record['severidade'];
    if (typeof severidade !== 'string' || !(SEVERIDADES as readonly string[]).includes(severidade)) {
      throw new DigestError(
        'severidade_invalida',
        `severidade fora da lista (${SEVERIDADES.join(' | ')}): ${JSON.stringify(severidade)}`,
      );
    }

    out.push({
      texto,
      severidade: severidade as Severidade,
      trecho: exigeTrecho ? requiredString(record, 'trecho', 'pegadinha') : null,
      cenario: readNullableString(record['cenario'], 'cenario'),
    });
  }

  return exigeTrecho ? podar(out, descricao, descartes) : out;
}

/**
 * Quanto foi podado, e por quê. É a medida direta do enchimento.
 *
 * Os três números respondem coisas diferentes: `trechoInexistente` é a pegadinha
 * que não tem passagem da regra que a sustente (a impressão disfarçada de
 * achado); `trechoRepetido` é a mesma observação dita duas vezes; `trechoCurto`
 * é a citação que existe mas não identifica nada.
 */
export interface Descartes {
  trechoInexistente: number;
  trechoRepetido: number;
  trechoCurto: number;
  severidadeRebaixada: number;
  /** Os itens podados, para o relatório poder mostrar O QUÊ foi cortado. */
  amostras: Array<{ motivo: string; texto: string; trecho: string }>;

  /**
   * A poda das AMBIGUIDADES, e ela existe para uma categoria só.
   *
   * `contradicaoSemSegundoTrecho` é a contradição que veio com uma passagem e a
   * outra em prosa; `contradicaoNaoAncorada` é a que citou duas e pelo menos uma
   * não está na regra. As duas dizem a mesma coisa por caminhos diferentes: o
   * modelo afirmou que o texto se contradiz sem mostrar as duas passagens em que
   * isso acontece.
   *
   * Contadas em separado das pegadinhas porque respondem outra pergunta — e
   * contadas, não descartadas em silêncio: `contradicao_interna` é a categoria
   * de maior valor da lista, e uma poda muda ali seria a diferença entre "o
   * modelo não achou contradição" e "achou e não sustentou".
   */
  contradicaoSemSegundoTrecho: number;
  contradicaoNaoAncorada: number;
  amostrasAmbiguidade: Array<{ motivo: string; texto: string; trecho: string }>;
}

export function descartesVazios(): Descartes {
  return {
    trechoInexistente: 0,
    trechoRepetido: 0,
    trechoCurto: 0,
    severidadeRebaixada: 0,
    amostras: [],
    contradicaoSemSegundoTrecho: 0,
    contradicaoNaoAncorada: 0,
    amostrasAmbiguidade: [],
  };
}

/**
 * O comprimento mínimo de um trecho, em caracteres.
 *
 * Sem piso, o mecanismo se anula sozinho: "the" é substring de toda descrição em
 * inglês, e uma pegadinha ancorada em "the" passa na conferência sem estar
 * ancorada em nada. Não é hipótese sobre má-fé do modelo — é a saída de menor
 * esforço quando o campo é obrigatório e a observação não tem fonte.
 *
 * 10 caracteres deixa passar citação curta de verdade ("higher than", "as of
 * market close") e barra a palavra solta.
 */
const TRECHO_MIN = 10;

/**
 * A conferência: o trecho existe na regra, e não se repete.
 *
 * A comparação é NORMALIZADA, e o afrouxamento é deliberado e limitado. As
 * descrições da Polymarket vêm com aspas e travessões tipográficos (’ “ ” —), e
 * um modelo que copia honestamente às vezes devolve o equivalente reto. Exigir
 * igualdade byte a byte rejeitaria citação correta, que é o oposto do que a
 * conferência existe para fazer. O que se tolera é grafia; o que se exige é que
 * a PASSAGEM esteja lá.
 *
 * Empate de trecho: fica o `texto` mais longo. É proxy de "mais específica" —
 * duas frases sobre a mesma passagem, a que diz mais é a que sobrevive.
 */
function podar(
  pegadinhas: readonly Pegadinha[],
  descricao: string,
  descartes: Descartes,
): Pegadinha[] {
  const alvo = normalizarParaBusca(descricao);

  const vivas: Pegadinha[] = [];
  for (const p of pegadinhas) {
    const trecho = p.trecho ?? '';
    const normalizado = normalizarParaBusca(trecho);

    if (normalizado.length < TRECHO_MIN) {
      descartes.trechoCurto += 1;
      descartes.amostras.push({ motivo: 'trecho curto demais', texto: p.texto, trecho });
      continue;
    }
    if (!alvo.includes(normalizado)) {
      descartes.trechoInexistente += 1;
      descartes.amostras.push({ motivo: 'trecho não está na regra', texto: p.texto, trecho });
      continue;
    }
    vivas.push(p);
  }

  // Unicidade do trecho, resolvida pela mais específica.
  const porTrecho = new Map<string, Pegadinha>();
  for (const p of vivas) {
    const chave = normalizarParaBusca(p.trecho ?? '');
    const anterior = porTrecho.get(chave);
    if (anterior === undefined) {
      porTrecho.set(chave, p);
      continue;
    }
    const perdedora = anterior.texto.length >= p.texto.length ? p : anterior;
    porTrecho.set(chave, anterior.texto.length >= p.texto.length ? anterior : p);
    descartes.trechoRepetido += 1;
    descartes.amostras.push({
      motivo: 'trecho repetido',
      texto: perdedora.texto,
      trecho: perdedora.trecho ?? '',
    });
  }

  // A ordem original sobrevive: o primeiro item de uma lista costuma ser o mais
  // forte, e essa hipótese só se mede se a ordem não for embaralhada pela poda.
  const sobreviventes = new Set(porTrecho.values());
  return vivas
    .filter(p => sobreviventes.has(p))
    .map(p => rebaixarSemCenario(p, descartes));
}

/**
 * Sem cenário, a severidade cai para `detalhe`. Em código, não por pedido.
 *
 * 75% das pegadinhas da v2 vieram marcadas `muda_resultado`, e isso é alto
 * demais para ser verdade: quando o nível mais forte não custa nada, o nível
 * mais forte é o que sai. O cenário é o custo — uma situação concreta em que a
 * leitura ingênua e a regra divergem. "A posição durante o dia não conta" não
 * produz nenhuma; "fechamento exatamente em US$ 76.000 resolve NÃO" produz na
 * hora.
 */
function rebaixarSemCenario(p: Pegadinha, descartes: Descartes): Pegadinha {
  const precisaCenario = p.severidade === 'muda_resultado' || p.severidade === 'muda_timing';
  if (!precisaCenario || p.cenario !== null) return p;

  descartes.severidadeRebaixada += 1;
  return { ...p, severidade: 'detalhe' };
}

/**
 * Normalização para a busca do trecho.
 *
 * Tolera grafia (aspas e travessões tipográficos, espaço colapsado, caixa) e
 * nada mais. Não tolera paráfrase, tradução nem resumo — que é exatamente o que
 * a conferência existe para pegar.
 */
function normalizarParaBusca(text: string): string {
  return text
    .normalize('NFC')
    .replace(/[‘’‛′]/g, "'")
    .replace(/[“”″]/g, '"')
    .replace(/[‐-―−]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * As ambiguidades da v2: (tipo, trecho, leitura A, leitura B).
 *
 * As duas leituras são obrigatórias, e é aí que mora o conserto do falso
 * positivo da trava: a v1 foi recusada por escrever "a leitura restritiva é mais
 * provável". Com dois campos, dizer qual vence deixa de ter onde caber — o
 * formato faz o trabalho que a instrução sozinha não fazia.
 *
 * O `trecho` é obrigatório porque sem ele nada disso é auditável: uma categoria
 * sem o texto que a motivou é uma afirmação sobre a regra que não se confere.
 *
 * ## A conferência que a v4 acrescenta, e por que só nela
 *
 * `contradicao_interna` é a única categoria cujo trecho é procurado NA REGRA, e
 * o recorte é deliberado. Ela é a única que afirma algo sobre DUAS passagens do
 * texto ao mesmo tempo — "estas duas, juntas, se contradizem" —, e essa é uma
 * afirmação que ou está sustentada nas duas citações ou é impressão. As demais
 * categorias apontam UMA passagem e dizem que ela admite duas leituras, e o
 * formato de duas leituras já é o que impede o modelo de decidir por conta.
 *
 * Estender a conferência verbatim às outras onze categorias é mudança maior, com
 * efeito na contagem por tipo, e não é o que a v4 se propôs a medir — ela existe
 * porque a LISTA estava incompleta. Fica registrado como pendência, não como
 * esquecimento.
 */
function readAmbiguidades(
  raw: unknown,
  version: string,
  descricao: string,
  descartes: Descartes,
): Ambiguidade[] {
  if (!Array.isArray(raw)) {
    throw new DigestError('schema', `ambiguidades não é lista: ${JSON.stringify(raw)}`);
  }

  // A lista da versão, não a maior das listas: aceitar `momento_ambiguo` numa
  // saída da v2 registraria uma categoria que aquele schema não ofereceu, e a
  // taxa de `outro` daquela rodada deixaria de significar o que significava.
  const tipos = tiposDe(version);
  const alvo = normalizarParaBusca(descricao);

  const out: Ambiguidade[] = [];
  for (const entry of raw) {
    const record = asRecord(entry);
    if (record === null) {
      throw new DigestError('schema', `ambiguidade não é objeto: ${JSON.stringify(entry)}`);
    }

    const tipo = record['tipo'];
    if (typeof tipo !== 'string' || !tipos.includes(tipo)) {
      throw new DigestError(
        'tipo_invalido',
        `tipo fora da lista (${tipos.join(' | ')}): ${JSON.stringify(tipo)}`,
      );
    }

    const trecho = requiredString(record, 'trecho', 'ambiguidade');
    const leituraA = requiredString(record, 'leitura_a', 'ambiguidade');
    const leituraB = requiredString(record, 'leitura_b', 'ambiguidade');

    // Fora de `contradicao_interna` o campo é forçado a `null`, e não só
    // ignorado: é o que a coluna aceita (CHECK da migration), e deixar passar um
    // segundo trecho decorativo em `fonte_vaga` faria o insert falhar no meio do
    // laço, longe de onde o defeito nasceu.
    if (tipo !== 'contradicao_interna') {
      out.push({ tipo: tipo as TipoAmbiguidade, trecho, trechoConflito: null, leituraA, leituraB });
      continue;
    }

    const conflito = readNullableString(record['trecho_conflito'], 'trecho_conflito');
    if (conflito === null) {
      descartes.contradicaoSemSegundoTrecho += 1;
      descartes.amostrasAmbiguidade.push({
        motivo: 'contradição sem a segunda passagem',
        texto: leituraA,
        trecho,
      });
      continue;
    }

    const naRegra = (t: string): boolean => {
      const normalizado = normalizarParaBusca(t);
      return normalizado.length >= TRECHO_MIN && alvo.includes(normalizado);
    };

    if (!naRegra(trecho) || !naRegra(conflito)) {
      descartes.contradicaoNaoAncorada += 1;
      descartes.amostrasAmbiguidade.push({
        motivo: 'contradição cujos trechos não estão na regra',
        texto: leituraA,
        trecho: `${trecho} ⟂ ${conflito}`,
      });
      continue;
    }

    out.push({
      tipo: tipo as TipoAmbiguidade,
      trecho,
      trechoConflito: conflito,
      leituraA,
      leituraB,
    });
  }

  return out;
}

function readNullableString(raw: unknown, field: string): string | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== 'string') {
    throw new DigestError('schema', `${field} não é string nem null: ${JSON.stringify(raw)}`);
  }
  const trimmed = raw.trim();
  // String vazia e `null` significam a mesma coisa — "a regra não diz" —, e
  // manter as duas faria toda leitura depois testar os dois casos.
  return trimmed.length > 0 ? trimmed : null;
}

// ---------------------------------------------------------------------------
// A regra que não se quebra
// ---------------------------------------------------------------------------

/**
 * Os marcadores de opinião sobre desfecho.
 *
 * Este é o guardrail do experimento inteiro, não um filtro de estilo. O dono vai
 * anotar a própria probabilidade nestes mercados por dois meses para medir a
 * PRÓPRIA calibração. Um número da IA na tela antes disso ancora a estimativa —
 * todo mundo ancora —, e o que ele medir depois não responde nada. O projeto já
 * mediu oito vezes que o modelo não bate o preço; não é disso que se trata.
 *
 * ## O que a lista deliberadamente NÃO pega
 *
 * Número. Percentual. Valor em dólar. E não é lacuna: a regra que está sendo
 * extraída é feita de números — "acima de 3,5%", "pelo menos 270 votos", "US$
 * 100 bilhões" —, e uma lista que banisse dígito rejeitaria toda digestão
 * correta. O que se proíbe é o VOCABULÁRIO de opinar sobre desfecho, que é o que
 * uma extração honesta nunca produz.
 *
 * Também ficam de fora `venda`, `compra` e `favorito`, e cada um por medição do
 * próprio material: "vendeu até 31 de maio" é o texto do caso de US$ 60 milhões
 * que motivou este componente. Bani-los rejeitaria justamente o exemplo canônico.
 *
 * ## Por que é estrito, e o que isso custa
 *
 * `provável` e `dificilmente` entram mesmo aparecendo às vezes em leitura de
 * regra ("a leitura mais provável do trecho"). O erro para o lado seguro de
 * propósito: um falso positivo custa uma chamada de fração de centavo; um número
 * que passa custa o experimento de dois meses.
 *
 * A função devolve QUAL termo bateu e em qual campo — sem isso a lista não é
 * ajustável com evidência, só com intuição.
 */
const OPINIAO: ReadonlyArray<readonly [RegExp, string]> = [
  [/probabilidade/i, 'probabilidade'],
  [/\bchances?\s+de\b/i, 'chance de'],
  [/\bprováve(l|is)\b/i, 'provável'],
  [/\bimprováve(l|is)\b/i, 'improvável'],
  [/\bprovavelmente\b/i, 'provavelmente'],
  [/\bdificilmente\b/i, 'dificilmente'],
  [/\bodds\b/i, 'odds'],
  [/\brecomend/i, 'recomendação'],
  [/\bsugiro\b/i, 'sugiro'],
  [/vale a pena/i, 'vale a pena'],
  [/\bbarato\b/i, 'barato'],
  [/\bcaro\b/i, 'caro'],
  [/\b(sub|sobre)valoriz/i, 'valoração'],
  [/mal precificad/i, 'precificação'],
  [/\boportunidade\b/i, 'oportunidade'],
  [/\baposte\b/i, 'aposte'],
  [/\bedge\b/i, 'edge'],
  [/na minha opinião/i, 'opinião'],
  [/\bacredito que\b/i, 'acredito que'],
  [/\bestimo\b/i, 'estimo'],
];

export interface OpiniaoHit {
  field: string;
  term: string;
  excerpt: string;
}

/**
 * O primeiro marcador de opinião encontrado, ou `null` se a saída é limpa.
 *
 * Os trechos da ambiguidade — `trecho` e, na v4, `trechoConflito` — ficam DE
 * FORA da varredura, e são a única exceção da função. Os dois são cópia literal
 * da regra, escrita por terceiro: uma regra que use a palavra "provável" faria a
 * trava recusar a digestão por causa do texto que ela está extraindo, e não por
 * causa de nada que o modelo escreveu. Tudo que o modelo produz continua sendo
 * varrido, inclusive as duas leituras.
 */
export function detectarOpiniao(output: DigestOutput): OpiniaoHit | null {
  const fields: Array<[string, string[]]> = [
    ['resolve_sim', output.resolveSim],
    ['resolve_nao', output.resolveNao],
    ['fonte', output.fonte === null ? [] : [output.fonte]],
    ['anula_se', output.anulaSe],
    ['prazo', output.prazo === null ? [] : [output.prazo]],
    ['pegadinhas', output.pegadinhas.map(p => p.texto)],
    [
      'ambiguidades',
      output.ambiguidades.flatMap(a => [a.leituraA, ...(a.leituraB === null ? [] : [a.leituraB])]),
    ],
  ];

  for (const [field, values] of fields) {
    for (const value of values) {
      for (const [pattern, term] of OPINIAO) {
        const match = pattern.exec(value);
        if (match !== null) {
          const at = match.index;
          return {
            field,
            term,
            excerpt: value.slice(Math.max(0, at - 40), at + 60),
          };
        }
      }
    }
  }

  return null;
}

/**
 * Valida a resposta e falha ALTO. Nunca devolve algo pela metade.
 *
 * Não é redundante com o structured output da API — e menos ainda aqui que no
 * analista, porque um dos dois fornecedores nem tem structured output (a
 * DeepSeek garante JSON válido e nada além disso; ver `src/llm/deepseek.ts`).
 * O que esta função garante e a API não:
 *
 *   - **Que existe resolução.** Um mercado que não resolve SIM sob condição
 *     nenhuma não é uma regra digerida, é uma extração que falhou. É a única
 *     lista obrigatoriamente não-vazia: `pegadinhas` e `ambiguidades` vazias são
 *     resposta legítima, e exigi-las cheias mandaria o modelo inventar.
 *   - **A regra que não se quebra.** Opinião sobre desfecho descarta a saída
 *     INTEIRA, e não só o campo onde ela apareceu — ver `detectarOpiniao`.
 *
 * Cada falha custa uma chamada paga e não gravada. É o preço combinado: melhor
 * perder o gasto que gravar linha ruim, porque o gasto é de frações de centavo e
 * a linha ruim contamina tudo que a ler depois.
 */
export interface ParsedDigest {
  output: DigestOutput;
  descartes: Descartes;
}

export function parseDigest(raw: unknown, version = 'v1', descricao = ''): ParsedDigest {
  const record = asRecord(raw);
  if (record === null) throw new DigestError('schema', 'resposta não é um objeto');

  const estruturado = version !== 'v1';
  const descartes = descartesVazios();

  const output: DigestOutput = {
    resolveSim: readStringList(record['resolve_sim'], 'resolve_sim'),
    resolveNao: readStringList(record['resolve_nao'], 'resolve_nao'),
    fonte: readNullableString(record['fonte'], 'fonte'),
    anulaSe: readStringList(record['anula_se'], 'anula_se'),
    prazo: readNullableString(record['prazo'], 'prazo'),
    pegadinhas: estruturado
      ? readPegadinhas(record['pegadinhas'], version, descricao, descartes)
      : readStringList(record['pegadinhas'], 'pegadinhas').map(texto => ({
          texto,
          severidade: null,
          trecho: null,
          cenario: null,
        })),
    ambiguidades: estruturado
      ? readAmbiguidades(record['ambiguidades'], version, descricao, descartes)
      : readStringList(record['ambiguidades'], 'ambiguidades').map(leituraA => ({
          tipo: null,
          trecho: null,
          trechoConflito: null,
          leituraA,
          leituraB: null,
        })),
  };

  if (output.resolveSim.length === 0) {
    throw new DigestError('sem_resolve_sim', 'nenhuma condição de resolução SIM');
  }

  const opiniao = detectarOpiniao(output);
  if (opiniao !== null) {
    throw new DigestError(
      'opiniao',
      `saída contém opinião sobre desfecho em ${opiniao.field} ("${opiniao.term}"): ...${opiniao.excerpt}...`,
    );
  }

  return { output, descartes };
}

// ---------------------------------------------------------------------------
// A chamada
// ---------------------------------------------------------------------------

export interface DigestRequest {
  model: string;
  promptVersion: string;
  timeoutMs: number;
  input: DigestInput;
  /**
   * O cliente do modelo. Omitido, resolve pelo nome em `src/llm/registry.ts`.
   *
   * Existe para o teste exercer esta função sem rede. Em produção quem escolhe é
   * o nome do modelo, e é o registro que traduz nome em fornecedor.
   */
  client?: LlmClient;
  /**
   * Esforço, quando o fornecedor tem esse controle. A DeepSeek ignora em
   * silêncio (contrato de `CompletionRequest`); a Anthropic usa.
   */
  effort?: string;
}

export interface DigestResult {
  output: DigestOutput;
  usage: TokenUsage;
  costUsd: number | null;
  latencyMs: number;
  /** O que a conferência do trecho e a exigência de cenário podaram. */
  descartes: Descartes;
  descriptionSha256: string;
  /** O que foi de fato enviado — útil para depurar uma resposta estranha. */
  prompt: BuiltPrompt;
}

/**
 * Uma chamada, um prazo, nenhum retry.
 *
 * O que se perde: um 429 ou um 500 transitório derruba esta digestão. É
 * aceitável de um jeito que não era no analista, e por um motivo melhor que
 * resignação — aqui o instante não importa. A regra é a mesma amanhã, o mercado
 * volta para a fila sozinho (o hash não bate com nada) e a próxima passada o
 * pega. O que não se pode é multiplicar o prazo pelo número de tentativas dentro
 * de um laço de centenas de chamadas.
 */
export async function runDigest(request: DigestRequest): Promise<DigestResult> {
  if (!knownModel(request.model)) {
    throw new DigestError(
      'unknown_model',
      `modelo sem preço conhecido: ${request.model} — sem preço não há teto de gasto`,
    );
  }

  const build = getPrompt(request.promptVersion);
  const schema = getSchema(request.promptVersion);
  if (build === null || schema === null) {
    throw new DigestError(
      'unknown_prompt',
      `versão de prompt desconhecida: ${request.promptVersion}`,
    );
  }

  const client = request.client ?? clientFor(request.model);
  if (client === null) {
    throw new DigestError(
      'unknown_provider',
      `nenhum fornecedor conhece o modelo ${request.model} — ver src/llm/registry.ts`,
    );
  }

  const prompt = build(request.input);
  const startedAt = Date.now();

  let completion: CompletionResult;
  try {
    completion = await client.complete({
      model: request.model,
      system: prompt.system,
      user: prompt.user,
      schema,
      ...(request.effort === undefined ? {} : { effort: request.effort }),
      maxTokens: MAX_TOKENS,
      timeoutMs: request.timeoutMs,
    });
  } catch (err) {
    throw new DigestError('api_error', err instanceof Error ? err.message : String(err));
  }

  const latencyMs = Date.now() - startedAt;

  // Recusa e truncagem antes de qualquer leitura do texto: as duas custam a
  // chamada e nenhuma delas é resposta. Colapsá-las em "veio vazio" esconderia
  // que uma não adianta retentar e a outra pede teto maior.
  if (completion.stop === 'refusal') {
    throw new DigestError('refusal', 'a chamada foi recusada pelos classificadores');
  }
  if (completion.stop === 'truncated') {
    throw new DigestError('truncated', `resposta truncada em max_tokens (${MAX_TOKENS})`);
  }
  if (completion.text === null) {
    throw new DigestError('no_text', 'resposta sem bloco de texto');
  }

  let raw: unknown;
  try {
    raw = JSON.parse(completion.text);
  } catch (err) {
    throw new DigestError('not_json', `resposta não é JSON: ${String(err)}`);
  }

  const parsed = parseDigest(raw, request.promptVersion, request.input.description);

  return {
    output: parsed.output,
    descartes: parsed.descartes,
    usage: completion.usage,
    costUsd: estimateCostUsd(request.model, completion.usage),
    latencyMs,
    descriptionSha256: hashDescription(request.input.description),
    prompt,
  };
}

export { COMPONENT as DIGEST_COMPONENT, MAX_TOKENS as DIGEST_MAX_TOKENS };
export type { DigestInput, TokenUsage };
