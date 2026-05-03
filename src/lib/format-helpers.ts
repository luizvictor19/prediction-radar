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

export function calcCalendarDrivenStake(
  bankroll: number,
  cap: number,
  confidence: number,
): number {
  const raw = bankroll * cap * confidence;
  return Math.round(raw * 100) / 100;
}

export function formatSignalAge(lastSeenIso: string): string {
  const ageMin = Math.floor((Date.now() - new Date(lastSeenIso).getTime()) / 60000);
  if (ageMin < 1) return '🕐 Atualizado agora há pouco';
  if (ageMin < 60) return `🕐 Atualizado há ${ageMin}min`;
  const hours = Math.floor(ageMin / 60);
  const mins = ageMin % 60;
  return mins === 0 ? `🕐 Atualizado há ${hours}h` : `🕐 Atualizado há ${hours}h ${mins}min`;
}

export function calcMinBankroll(
  legs: number,
  cap: number,
  modifier: number,
): number {
  const fraction = cap * modifier;
  if (fraction <= 0) return Infinity;
  return Math.ceil((legs * 1.0) / fraction);
}
