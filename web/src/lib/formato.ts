/**
 * Formatação. Uma regra atravessa tudo: **nulo é `—`, nunca `0`.**
 *
 * `mid_price` nulo quer dizer livro de um lado só (123 de 673 mercados em
 * 14/08). Variação nula quer dizer que não havia âncora na janela. Mostrar zero
 * no lugar transforma "não sei" em "não mudou", que é uma afirmação que o dado
 * não fez.
 */

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
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `$${(v / 1_000).toFixed(0)}k`;
  return `$${v.toFixed(0)}`;
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

export function urlPolymarket(slug: string | null): string | null {
  // `v_radar` não tem coluna `url`; a montagem é a mesma que
  // `digest_contradicoes` já faz internamente (`20260817033302_...sql:207`).
  return slug ? `https://polymarket.com/event/${slug}` : null;
}

export function segundos(ms: number): string {
  return `${(ms / 1000).toFixed(1)} s`;
}
