/**
 * A core's stop, bounded. Under harnessd the master gives its core `stopGraceMs` (2.5 s) to leave and kills
 * it after (harnessd/supervisor.ts). A core with no master had no such bound: Harness OS's
 * harness-daemon.service runs the core alone (HARNESS_NO_MASTER=1), and one step of the stop that never
 * resolved held it until systemd's own 90 s ran out, three seconds after boot, with the OS's update waiting
 * on all of it (2026-10-13). A core alone keeps the same time on itself, and says which step it gave up on.
 * An unsettled registry write keeps process ownership until this forced exit; it is never acknowledged by the deadline.
 */

export const ALONE_STOP_DEADLINE_MS = 2_500

export interface StopDeadline {
  /** The step the stop is on: what the log names should it be given up on. */
  at(step: string): void
}

export interface StopDeadlineDeps {
  /** A master runs this core, and ends a stop that outlives its grace itself. */
  supervised: boolean
  /** Leave now, as a stop that finished would. */
  exit: () => void
  log: (line: string) => void
  deadlineMs?: number
  setTimer?: (fn: () => void, ms: number) => unknown
}

export function stopDeadline(deps: StopDeadlineDeps): StopDeadline {
  let step = 'the first steps'
  if (!deps.supervised) {
    const ms = deps.deadlineMs ?? ALONE_STOP_DEADLINE_MS
    ;(deps.setTimer ?? setTimeout)(() => {
      deps.log(`[cli] the stop is still on ${step} after ${ms} ms — leaving without it`)
      deps.exit()
    }, ms)
  }
  return { at: (next) => { step = next } }
}
