export function truncate(s: string, max = 12): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + '…';
}

export function confidenceStars(score: number): string {
  const filled = Math.max(1, Math.min(5, Math.ceil(score * 5)));
  return '★'.repeat(filled) + '☆'.repeat(5 - filled);
}

export function describeVolatility(vol: number): string {
  if (vol < 0.002) return 'quase parado';
  if (vol < 0.0035) return 'estável';
  return 'movendo lentamente';
}
