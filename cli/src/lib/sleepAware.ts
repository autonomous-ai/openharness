/**
 * Telling a machine that SLEPT apart from a peer that went silent.
 *
 * Node's clocks do not stop while a Mac sleeps: `performance.now()`, `process.hrtime` and the event
 * loop's own timer clock all run on the clock that keeps counting (measured on Node 22.23 and 23.11
 * against CLOCK_UPTIME_RAW / CLOCK_MONOTONIC_RAW — they match the second). A lid closed for forty
 * minutes therefore arrives, on the first loop turn after the wake, as forty minutes of "silence" on
 * every deadline at once: every socket judged dead, every terminal lease expired, the safe-mode clock
 * run out — measured 2026-09-28, `[local-ws] no traffic for 2287s — terminating` against a loopback
 * peer that was perfectly healthy, and the daemon exiting 200ms later.
 *
 * Nothing here asks the OS about power state. A periodic tick already knows how long it expects to
 * wait; a tick that arrives far later than that means the process was not running in between —
 * asleep, or a loop blocked for that long, and neither is the peer's silence.
 */

/** A tick later than this many periods is read as the process having slept through it. */
export const SLEEP_GAP_FACTOR = 2

/**
 * How much of [gapMs] — the time since the previous tick of a timer that fires every [periodMs] —
 * the process spent asleep. Zero for an ordinary tick, however late a busy loop made it.
 */
export function sleptFor(gapMs: number, periodMs: number): number {
  return gapMs > periodMs * SLEEP_GAP_FACTOR ? gapMs - periodMs : 0
}

export interface AwakeTimeout {
  cancel(): void
}

export interface AwakeTimeoutOptions {
  /** How often awake time is counted. Coarse on purpose: a long deadline only needs to be about right. */
  tickMs?: number
  now?: () => number
}

/**
 * `setTimeout` that counts only the time the process was awake: [fn] runs once [ms] of it has passed.
 * For the long deadlines a sleep must not spend — a plain timer set before the lid closed fires on
 * the first loop turn after the wake. Unref'd, like the timers it replaces: it never holds the loop.
 */
export function awakeTimeout(fn: () => void, ms: number, opts: AwakeTimeoutOptions = {}): AwakeTimeout {
  const tickMs = opts.tickMs ?? 10_000
  const now = opts.now ?? (() => performance.now())
  let awake = 0
  let last = now()
  const timer = setInterval(() => {
    const at = now()
    const gap = at - last
    last = at
    awake += gap - sleptFor(gap, tickMs)
    if (awake < ms) return
    clearInterval(timer)
    fn()
  }, tickMs)
  timer.unref?.()
  return { cancel: () => clearInterval(timer) }
}
