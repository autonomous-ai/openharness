/**
 * The `grid` children this process runs, and a pause an install holds.
 *
 * On Windows a running grid holds its install's files open. grid's installer (`install.ps1`) then refuses to replace
 * it — and a grid started after its check, while `uv tool install --force` is replacing files, leaves an install that
 * cannot even `grid stop`. A Swarm machine starts a short grid call every few seconds, so an install (Windows' pin,
 * `gridWindowsPin.ts`) holds new ones back and waits for those running to end before it begins.
 */

let running = 0
let paused: Promise<void> | null = null
let idle: (() => void) | null = null

/** Wait out an install, then count one grid child as running; call the answer when it has ended. */
export async function gridCallStarted(): Promise<() => void> {
  while (paused) await paused
  running++
  let ended = false
  return () => {
    if (ended) return
    ended = true
    running--
    if (running === 0) idle?.()
  }
}

/** How long an install waits for the grid calls already running. Past it, it starts anyway: grid's installer looks
 *  for a running grid itself and refuses rather than replace one. */
const DRAIN_MS = 60_000

/** Run [install] with no new grid call starting, once those running have ended (or [drainMs] has passed). */
export async function withGridCallsPaused<T>(install: () => Promise<T>, drainMs: number = DRAIN_MS): Promise<T> {
  while (paused) await paused
  let release: () => void = () => {}
  paused = new Promise<void>((resolve) => { release = resolve })
  try {
    if (running > 0) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, drainMs)
        idle = () => { clearTimeout(timer); resolve() }
      })
      idle = null
    }
    return await install()
  } finally {
    paused = null
    release()
  }
}
