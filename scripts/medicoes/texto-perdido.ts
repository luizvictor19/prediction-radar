/**
 * Quantas digestões já apontam para um texto de regra que não existe mais.
 *
 * `market_rule_digests` guarda `description_sha256` e NUNCA o texto. O texto só
 * existe em `events.description`, que é a versão ATUAL. Quando a Polymarket
 * edita uma descrição, o texto digerido deixa de existir em qualquer lugar — e
 * todo achado daquele texto vira citação de um documento que ninguém possui.
 *
 * Esta medição responde uma pergunta só: **já aconteceu, ou ainda é risco?**
 *
 * ## O custo da leitura, porque leitura pesada não é inofensiva
 *
 * Duas consultas, e nenhuma varre `events`:
 *
 * 1. `market_rule_digests` inteira, projetando duas colunas. É a tabela pequena
 *    do par — 1033 pares (mercado, texto) em 22/08/2026.
 * 2. `events` por PK, em lotes de `id`, só para os event_id que a primeira
 *    devolveu. `in` sobre a chave primária usa o índice; não há `like`, não há
 *    filtro sobre coluna sem índice, e o conjunto é limitado ao que já veio.
 *
 * O hash é recalculado em memória com a MESMA conta da digestão —
 * `sha256(description.trim())`, ver `hashDescription` em `src/digest/digest.ts`.
 *
 * Só SELECT. Não escreve nada.
 */
import 'dotenv/config';
import { createHash } from 'node:crypto';
import { supabase } from '../../src/lib/supabase.js';

/** Lotes do `in`: o PostgREST tem limite de tamanho de URL. */
const LOTE = 200;

/** A mesma conta de `hashDescription`, e o mesmo `trim` de `readMarketsToDigest`. */
function hashDe(description: string): string {
  return createHash('sha256').update(description.trim()).digest('hex');
}

type Par = { event_id: string; description_sha256: string };

async function lerPares(): Promise<Par[]> {
  const pares: Par[] = [];
  for (let de = 0; ; de += 1000) {
    const { data, error } = await supabase
      .from('market_rule_digests')
      .select('event_id, description_sha256')
      .order('event_id')
      .range(de, de + 999);
    if (error) throw new Error(`market_rule_digests: ${error.message}`);
    const linhas = (data ?? []) as Par[];
    pares.push(...linhas);
    if (linhas.length < 1000) return pares;
  }
}

async function lerDescricoes(ids: string[]): Promise<Map<string, string | null>> {
  const porId = new Map<string, string | null>();
  for (let i = 0; i < ids.length; i += LOTE) {
    const lote = ids.slice(i, i + LOTE);
    const { data, error } = await supabase
      .from('events')
      .select('id, description')
      .in('id', lote);
    if (error) throw new Error(`events: ${error.message}`);
    for (const row of (data ?? []) as { id: string; description: string | null }[])
      porId.set(row.id, row.description);
  }
  return porId;
}

async function medir() {
  const pares = await lerPares();
  const ids = [...new Set(pares.map(p => p.event_id))];
  const descricoes = await lerDescricoes(ids);

  // Um mercado pode ter mais de um texto digerido. O par é a unidade.
  const distintos = new Map<string, Par>();
  for (const p of pares) distintos.set(`${p.event_id}|${p.description_sha256}`, p);

  let batem = 0;
  let perdidos = 0;
  let semDescricao = 0;
  const mercadosPerdidos = new Set<string>();

  for (const p of distintos.values()) {
    const atual = descricoes.get(p.event_id);
    if (atual === undefined || atual === null || atual.trim() === '') {
      semDescricao++;
      continue;
    }
    if (hashDe(atual) === p.description_sha256) batem++;
    else {
      perdidos++;
      mercadosPerdidos.add(p.event_id);
    }
  }

  const total = distintos.size;
  const frac = (n: number) => (total === 0 ? '—' : `${((100 * n) / total).toFixed(1)}%`);

  console.log(`pares (mercado, texto) digeridos: ${total}`);
  console.log(`  texto ainda recuperável:  ${batem} (${frac(batem)})`);
  console.log(`  TEXTO PERDIDO:            ${perdidos} (${frac(perdidos)})`);
  console.log(`  mercado sem descrição:    ${semDescricao} (${frac(semDescricao)})`);
  console.log(`mercados distintos com ao menos um texto perdido: ${mercadosPerdidos.size} de ${ids.length}`);
}

medir().catch(e => {
  console.error(e);
  process.exitCode = 1;
});
