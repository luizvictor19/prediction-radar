import { createHash } from 'node:crypto';

/**
 * A fila do extrator: ordem sorteada uma vez, reprodutível, e retomável.
 *
 * A Parte E é explícita sobre por que isto não é conveniência de engenharia.
 * "Rodar 100 grupos" só é uma AMOSTRA ALEATÓRIA se os 100 forem os primeiros de
 * uma ordem sorteada. Uma lista ordenada por tamanho, por data ou por qualquer
 * outra coisa faz os primeiros 100 medirem aquele pedaço — o mesmo defeito de
 * medir só as relações mais confiantes, que a Parte H já declara.
 *
 * E a semente é fixa porque a fatia tem que ser a MESMA entre rodadas: rodar 100
 * hoje e 300 semana que vem só é honesto se a segunda rodada continuar de onde a
 * primeira parou, em vez de re-sortear.
 */

/**
 * Ordem sorteada a partir do id do grupo, e não de um gerador com estado.
 *
 * Cada grupo recebe uma chave = sha256(semente + id) e a fila é a ordenação por
 * essa chave. Isso tem uma propriedade que um Fisher-Yates com PRNG não tem: a
 * posição de um grupo **não depende de quais outros grupos existem**. Se a
 * coleta de amanhã trouxer dez grupos novos, os antigos mantêm a ordem relativa
 * e os novos se encaixam entre eles — em vez de a fila inteira ser reembaralhada
 * e a fatia já rodada deixar de ser um prefixo.
 *
 * Sem essa propriedade, "os 100 primeiros" mudaria de significado toda vez que o
 * conjunto mudasse, e a retomada passaria a repetir e a pular ao mesmo tempo.
 */
export function ordenarFila<T extends { id: string }>(grupos: readonly T[], semente: string): T[] {
  const chave = new Map<string, string>();
  for (const g of grupos) {
    chave.set(g.id, createHash('sha256').update(`${semente}|${g.id}`).digest('hex'));
  }

  return [...grupos].sort((a, b) => {
    const ka = chave.get(a.id) as string;
    const kb = chave.get(b.id) as string;
    if (ka < kb) return -1;
    if (ka > kb) return 1;
    // Desempate pelo id: dois hashes iguais são impossíveis na prática, mas uma
    // ordenação não determinística num empate reintroduziria exatamente a
    // instabilidade que esta função existe para eliminar.
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/**
 * A semente padrão.
 *
 * Fixa no código, e não no relógio nem em `Math.random`: uma fila que muda a
 * cada execução não é retomável e não é amostra. Mudar este valor invalida
 * comparação com qualquer medição anterior — trocar é decisão consciente, não
 * ajuste.
 */
export const SEMENTE_PADRAO = 'spec003-fase2';

// ---------------------------------------------------------------------------
// Retomada
// ---------------------------------------------------------------------------

export interface RegistroDeGrupo {
  grupoId: string;
  /** `ok` gravou relações; `falha` gastou a chamada e não produziu resposta. */
  status: 'ok' | 'falha';
}

/**
 * Divide a fila entre o que já foi e o que falta.
 *
 * Falha ENTRA em `jaFeitos` para não ser retentada automaticamente na rodada
 * seguinte: um grupo que o modelo recusou ou que estourou o teto de saída vai
 * recusar de novo, e retentar em silêncio gastaria dinheiro em looping sem que
 * ninguém visse. Quem quiser retentar apaga a linha — decisão explícita, com um
 * humano no meio.
 */
export function pendentes<T extends { id: string }>(
  fila: readonly T[],
  registros: readonly RegistroDeGrupo[],
): { pendentes: T[]; jaFeitos: number } {
  const feitos = new Set(registros.map((r) => r.grupoId));
  return {
    pendentes: fila.filter((g) => !feitos.has(g.id)),
    jaFeitos: fila.length - fila.filter((g) => !feitos.has(g.id)).length,
  };
}
