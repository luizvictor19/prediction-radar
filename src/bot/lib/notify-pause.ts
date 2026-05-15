let pauseUntil = 0;

export function pauseNotify(durationMs: number): void {
  const newPauseUntil = Date.now() + durationMs;
  if (newPauseUntil > pauseUntil) {
    pauseUntil = newPauseUntil;
  }
}

export function isNotifyPaused(): boolean {
  return Date.now() < pauseUntil;
}

export function getRemainingPauseMs(): number {
  return Math.max(0, pauseUntil - Date.now());
}
