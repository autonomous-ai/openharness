/**
 * A notice handed on at a random moment within `spreadMs` of the first told, once for every notice told before it goes:
 * what it makes a reader read again is read after each of them. Prod 2026-10-28: the backend told every computer of a
 * person about an invitation at the same moment, and every window read the shares list in that same second; across a
 * Swarm's members the reads came in waves that held the backend at its pod limit.
 */
export function spreadNotice(hand: () => void, spreadMs: number): { tell(): void; stop(): void } {
  let timer: ReturnType<typeof setTimeout> | null = null
  return {
    tell() {
      if (timer) return
      timer = setTimeout(() => { timer = null; hand() }, Math.floor(Math.random() * spreadMs))
      timer.unref?.()
    },
    stop() {
      if (timer) clearTimeout(timer)
      timer = null
    },
  }
}
