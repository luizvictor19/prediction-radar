/**
 * As chaves da digestão, e as três perguntas que se faz sobre elas.
 *
 * Módulo separado de `store.ts` por um motivo prático e um de desenho. O
 * prático: `store.ts` cria o cliente do Supabase no import, e um teste que o
 * importasse morreria pedindo variável de ambiente — foi assim que este arquivo
 * nasceu. O de desenho: aqui não há I/O, então a regra que decide o que é
 * "já lido" e o que é "já carregado" pode ser exercida sem rede, e ela é
 * exatamente a regra que o passo 2b não pode errar.
 */

export interface DigestedKey {
  eventId: string;
  descriptionSha256: string;
  model: string;
  promptVersion: string;
}

export interface DigestedIndex {
  /** `false` enquanto a migration da tabela não estiver aplicada. */
  tabelaExiste: boolean;
  /**
   * `false` enquanto a `20260817163046` não estiver aplicada.
   *
   * Não é detalhe de compatibilidade: sem a coluna, a chave do banco continua
   * sendo a de 4 partes e uma segunda leitura do mesmo texto pelo mesmo modelo
   * COLIDE. Quem for nivelar tem que parar aqui, alto, em vez de rodar e
   * descobrir na carga — ver `scripts/nivelar-leituras.ts`.
   */
  colunaLeituraN: boolean;
  /** As chaves de QUATRO partes: "este texto já foi lido alguma vez?". */
  keys: Set<string>;
  /**
   * As chaves de CINCO partes, com o índice da leitura: "ESTA leitura já está
   * no banco?". É contra este conjunto que a carga decide o que pular.
   *
   * Existe separado de `keys` porque as duas perguntas são diferentes e as duas
   * são legítimas — a escada quer a primeira, para não pagar de novo; a carga
   * quer a segunda, para não duplicar. Usar a primeira no lugar da segunda é a
   * armadilha do passo 2b: a leitura 2 de um texto já lido seria pulada em
   * silêncio e o job terminaria verde tendo gravado nada.
   */
  keysComLeitura: Set<string>;
  /**
   * Quantas leituras cada TEXTO tem, somando todos os mercados que o receberam.
   * É o número que o nivelamento compara contra o mínimo.
   */
  leiturasPorTexto: Map<string, number>;
  /**
   * O maior `leitura_n` já gravado em cada chave de 4 partes. `+1` é o índice da
   * próxima leitura daquele (mercado, texto, modelo, versão).
   */
  maxLeituraPorChave: Map<string, number>;
  /**
   * Quantas linhas cada par `modelo|versão` tem.
   *
   * Existe porque `system_config` NÃO é a fonte da verdade sobre o que já foi
   * rodado — ela guarda o default do próximo comando. Em 17/08/2026 a config
   * dizia `v1` e as 728 digestões eram todas `v4`, porque a passada usou
   * `--prompt=v4`. Quem for RELER o que já foi lido tem que perguntar às linhas,
   * não à config: reler em v1 o que foi lido em v4 gravaria leituras de outro
   * prompt sob o mesmo texto, e o experimento que compara antes e depois
   * passaria a comparar duas coisas ao mesmo tempo.
   */
  combinacoes: Map<string, number>;
}

export function keyOf(k: DigestedKey): string {
  return `${k.eventId}|${k.descriptionSha256}|${k.model}|${k.promptVersion}`;
}

/** Este texto já foi lido alguma vez por este modelo nesta versão? */
export function jaDigerido(index: DigestedIndex, key: DigestedKey): boolean {
  return index.keys.has(keyOf(key));
}

/**
 * ESTA leitura já está no banco?
 *
 * Pertinência num conjunto, e não `leituraN <= max`. A comparação com o máximo
 * seria equivalente enquanto os índices forem contíguos — e eles são, por
 * construção, já que `proximaLeitura` só devolve `max + 1`. Mas uma carga
 * parcial que gravasse a 1 e a 3 faria a 2 parecer gravada, e a contiguidade
 * deixaria de ser propriedade para virar torcida.
 */
export function jaCarregado(index: DigestedIndex, key: DigestedKey, leituraN: number): boolean {
  return index.keysComLeitura.has(`${keyOf(key)}|${leituraN}`);
}

/**
 * O índice da próxima leitura desta chave. 1 quando nunca foi lida.
 *
 * Existe para o nivelamento: ele agenda leituras de textos que JÁ foram
 * digeridos, então `jaDigerido` diria `true` para todas elas. A pergunta que
 * importa lá não é "já foi lido?" e sim "esta é a leitura número quantos?".
 */
export function proximaLeitura(index: DigestedIndex, key: DigestedKey): number {
  return (index.maxLeituraPorChave.get(keyOf(key)) ?? 0) + 1;
}

/** Quantas leituras este TEXTO tem, somando todos os mercados que o receberam. */
export function leiturasDoTexto(index: DigestedIndex, descriptionSha256: string): number {
  return index.leiturasPorTexto.get(descriptionSha256) ?? 0;
}
