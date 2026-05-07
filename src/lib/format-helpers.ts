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

export function formatTimeUntilResolution(endDateIso: string): string {
  const ms = new Date(endDateIso).getTime() - Date.now();

  if (ms <= 0) return 'Resolução vencida';

  const totalMin = Math.floor(ms / 60000);
  const days = Math.floor(totalMin / (60 * 24));
  const hours = Math.floor((totalMin % (60 * 24)) / 60);
  const mins = totalMin % 60;

  if (days >= 2) return `Resolve em ${days} dias`;
  if (days === 1) {
    return hours > 0 ? `Resolve em 1 dia e ${hours}h` : 'Resolve em 1 dia';
  }
  if (hours >= 1) {
    return mins > 0 ? `Resolve em ${hours}h ${mins}min` : `Resolve em ${hours}h`;
  }
  if (mins >= 1) return `Resolve em ${mins}min`;
  return 'Resolve em segundos';
}

export function formatEndDate(endDateIso: string): string {
  const d = new Date(endDateIso);

  const ddU = String(d.getUTCDate()).padStart(2, '0');
  const mmU = String(d.getUTCMonth() + 1).padStart(2, '0');
  const yyyyU = d.getUTCFullYear();
  const hhU = String(d.getUTCHours()).padStart(2, '0');
  const minU = String(d.getUTCMinutes()).padStart(2, '0');

  const brt = new Date(d.getTime() - 3 * 60 * 60 * 1000);
  const ddB = String(brt.getUTCDate()).padStart(2, '0');
  const mmB = String(brt.getUTCMonth() + 1).padStart(2, '0');
  const yyyyB = brt.getUTCFullYear();
  const hhB = String(brt.getUTCHours()).padStart(2, '0');
  const minB = String(brt.getUTCMinutes()).padStart(2, '0');

  return `${ddU}/${mmU}/${yyyyU} ${hhU}:${minU} UTC (${ddB}/${mmB}/${yyyyB} ${hhB}:${minB} BRT)`;
}

export function formatTimeSinceOpen(startDateIso: string): string {
  const diffMs = Date.now() - new Date(startDateIso).getTime();
  const mins = Math.floor(diffMs / 60000);

  if (mins < 1) return 'agora há pouco';
  if (mins < 60) return `${mins}min`;

  const hours = Math.floor(mins / 60);
  const remainingMins = mins % 60;

  if (hours < 24) {
    if (remainingMins === 0) return `${hours}h`;
    return `${hours}h ${remainingMins}min`;
  }

  const days = Math.floor(hours / 24);
  const remainingHours = hours % 24;

  if (remainingHours === 0) return `${days}d`;
  return `${days}d ${remainingHours}h`;
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
