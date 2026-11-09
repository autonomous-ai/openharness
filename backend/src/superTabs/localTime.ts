/** The local date and time ("2026-10-27", "08:00") in [timeZone] at `now`. */
export function localNow(timeZone: string, now: number): { date: string; time: string } {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit',
    minute: '2-digit', hourCycle: 'h23' }).formatToParts(now).map(p => [p.type, p.value]))
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` }
}

/** Whether the zone is one this runtime knows. */
export function knownTimeZone(timeZone: string): boolean {
  try { localNow(timeZone, 0); return true } catch { return false }
}
