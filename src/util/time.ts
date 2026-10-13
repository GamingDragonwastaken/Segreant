/** Recorded evidence timestamps use zero as an unknown sentinel, never epoch. */
export function recordedTime(ms: number | null | undefined, dayOnly = false): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0 || ms > 8.64e15) return 'unknown';
  const iso = new Date(ms).toISOString();
  return dayOnly ? iso.slice(0, 10) : iso;
}
