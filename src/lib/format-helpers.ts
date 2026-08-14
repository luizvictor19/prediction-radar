import type { BankrollState } from './bankroll.js';

/**
 * A frase que explica a recusa, montada a partir do estado.
 *
 * Existe uma vez só, e não em cada tela, para que a explicação não divirja
 * entre o `/status`, o `/signals` e o `/track` — e para que acrescentar um
 * motivo novo na view apareça em todos de uma vez.
 *
 * Mora neste arquivo, e não em `bankroll.ts`, porque `bankroll.ts` importa o
 * cliente do Supabase no topo e explodiria num teste sem `.env`. O tipo vem de
 * lá por `import type`, que o compilador apaga.
 */
export function explicarSemMarcacao(state: BankrollState): string {
  if (state.bankroll !== null) return '';

  const motivos = Object.entries(state.motivos_sem_marcacao)
    .sort((a, b) => b[1] - a[1])
    .map(([motivo, n]) => `${n}× ${motivo}`)
    .join(' · ');

  const quantas =
    state.legs_sem_marcacao === 1
      ? '1 leg aberta sem preço de mercado'
      : `${state.legs_sem_marcacao} legs abertas sem preço de mercado`;

  return (
    `⚠️ Carteira não marcada: ${quantas}.\n` +
    `   ${motivos}\n` +
    `   Marcado até aqui: $${state.portfolio_value_parcial.toFixed(2)} ` +
    `(parcial, não é o total) · Cash: $${state.cash.toFixed(2)}`
  );
}

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

/**
 * Devolve `null` quando a carteira não está marcada — a RECUSA.
 *
 * Tratar `null` como `0` aqui daria `Math.round(0) = 0`, e o caminho do
 * `calcStake` daria `Math.max(0.5, 0) = 0.50`: o bot sugeriria uma aposta de
 * cinquenta centavos como se tivesse dimensionado alguma coisa. Sugestão feita
 * a partir de carteira desconhecida é pior que nenhuma sugestão, porque tem
 * cara de conta.
 *
 * Ver `getBankrollState` em `src/lib/bankroll.ts` para de onde vem o nulo.
 */
export function calcCalendarDrivenStake(
  bankroll: number | null,
  cap: number,
  confidence: number,
): number | null {
  if (bankroll === null) return null;
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
