/** The footer's own timer ("15m 31s", "1h 2m 3s") in seconds, or undefined when it shows none or an absurd one. */
export function elapsedSecondsOf(indicator: string | undefined): number | undefined {
  const duration = indicator && /\(\s*((?:\d+[hms]\s*){1,3})[•·]/u.exec(indicator)?.[1]
  if (!duration) return undefined
  const seconds = [...duration.matchAll(/(\d+)([hms])/g)]
    .reduce((sum, part) => sum + Number(part[1]) * ({ h: 3600, m: 60, s: 1 }[part[2]] ?? 0), 0)
  return Number.isSafeInteger(seconds) && seconds <= 2_592_000 ? seconds : undefined
}
