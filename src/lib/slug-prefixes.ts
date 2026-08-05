/**
 * Guard do filtro `or=(slug.like.X*)` do PostgREST.
 *
 * O filtro é uma string em que vírgula, ponto e parênteses são estrutura, não
 * conteúdo. Um prefixo com qualquer um deles não seria escapado — mudaria o
 * sentido do filtro em silêncio, e um recorte de watchlist ou de resolução
 * errado é o tipo de bug que só aparece no extrato.
 *
 * Prefixo de slug é `[a-z0-9_-]`. O que fugir disso é descartado com aviso.
 */
const SAFE_PREFIX_RE = /^[a-z0-9_-]+$/i;

export function safeSlugPrefixes(prefixes: readonly string[], component = 'config'): string[] {
  const safe: string[] = [];

  for (const prefix of prefixes) {
    if (prefix.length === 0) continue;
    if (!SAFE_PREFIX_RE.test(prefix)) {
      console.warn(
        `[${component}] prefixo ignorado por caractere inseguro no filtro: ${JSON.stringify(prefix)}`,
      );
      continue;
    }
    safe.push(prefix);
  }

  return safe;
}

/** A cláusula `or=` pronta, na forma que o PostgREST espera. */
export function slugPrefixFilter(prefixes: readonly string[]): string {
  return prefixes.map(p => `slug.like.${p}*`).join(',');
}
