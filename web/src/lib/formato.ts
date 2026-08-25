/**
 * Formatação. Uma regra atravessa tudo: **nulo é `—`, nunca `0`.**
 *
 * `mid_price` nulo quer dizer livro de um lado só (123 de 673 mercados em
 * 14/08). Variação nula quer dizer que não havia âncora na janela. Mostrar zero
 * no lugar transforma "não sei" em "não mudou", que é uma afirmação que o dado
 * não fez.
 */

import { polymarketUrl } from '../../../src/lib/polymarket-url';

export const VAZIO = '—';

export function preco(v: number | null): string {
  return v === null ? VAZIO : v.toFixed(3);
}

export function pct(v: number | null): string {
  return v === null ? VAZIO : `${(v * 100).toFixed(1)}%`;
}

/** Variação: sempre com sinal, porque a direção é metade da informação. */
export function variacao(v: number | null): string {
  if (v === null) return VAZIO;
  const p = v * 100;
  return `${p >= 0 ? '+' : ''}${p.toFixed(1)} pp`;
}

export function dinheiro(v: number | null): string {
  if (v === null) return VAZIO;
  // `US$` e não `$`: a tela é lida em português, onde `$` sozinho lê como real.
  if (v >= 1_000_000) return `US$ ${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `US$ ${(v / 1_000).toFixed(0)}k`;
  return `US$ ${v.toFixed(0)}`;
}

export function prazo(dias: number | null): string {
  if (dias === null) return VAZIO;
  if (dias < 0) return 'já passou';
  if (dias < 1) return 'hoje';
  if (dias < 2) return '1 dia';
  if (dias < 60) return `${Math.floor(dias)} dias`;
  return `${Math.floor(dias / 30)} meses`;
}

export function data(iso: string | null): string {
  if (!iso) return VAZIO;
  return new Date(iso).toLocaleString('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function idade(minutos: number | null): string {
  if (minutos === null) return VAZIO;
  if (minutos < 60) return `${Math.round(minutos)} min`;
  if (minutos < 1440) return `${Math.round(minutos / 60)} h`;
  return `${Math.round(minutos / 1440)} d`;
}

/**
 * A URL do Polymarket. A regra NÃO mora aqui.
 *
 * Ela mora em `src/lib/polymarket-url.ts`, e as duas camadas — esta e o bot —
 * importam de lá. Isto aqui é só o nome em português da fronteira de `web/`.
 *
 * Antes eram duas cópias, e elas divergiram: o bot montava com
 * `event_group_slug` e esta função montava `/event/<slug>` com slug de MERCADO,
 * que respondia 404 em 956 dos 1.024 mercados do roster ativo. Uma cópia certa
 * e uma errada é o estado que produziu o defeito; ter escrito a certa aqui de
 * novo teria recriado a condição.
 *
 * `slugDoGrupo` é `events.event_group_slug`. `v_radar` ainda NÃO o expõe — a
 * migration que acrescenta a coluna está escrita e não aplicada
 * (`20260825..._v_radar_expoe_event_group_slug.sql`). Enquanto ela não entra,
 * as telas passam `null` e a URL cai no fallback `/market/<slug>`, medido
 * abrindo 55/55 no mercado certo. Não é o caminho preferido — é o caminho que
 * funciona com um campo só, e o parâmetro já está aqui para o dia em que o
 * segundo campo chegar.
 */
export function urlPolymarket(
  slug: string | null,
  slugDoGrupo: string | null = null,
): string | null {
  return polymarketUrl(slug, slugDoGrupo);
}

export function segundos(ms: number): string {
  return `${(ms / 1000).toFixed(1)} s`;
}
