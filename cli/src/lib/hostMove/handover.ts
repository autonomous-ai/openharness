import type { MoveGate } from './gate.js'
import type { HostMover } from './mover.js'

/** How long a hand-over waits for a move that holds input to finish (`settleMovesForHandOver`). */
export const HAND_OVER_MOVE_WAIT_MS = 20_000
/** How long it then gives the held input to be written, when it could not wait the move out. */
export const HAND_OVER_FLUSH_MS = 5_000

/**
 * What a hand-over does first, before its teardown closes the connections held input would be written through: no move
 * starts any more ([mover] stopped: one not yet past its old engine's stop cancels itself there, core/main.ts
 * `eligible`), and a move that holds input is waited for, at most [waitMs]: its own release then writes what was held
 * to the pane that stays. Past the bound, remaining input is refused and pending moves are revoked (`refuseAll`),
 * within [flushMs], and the hand-over goes on. Nothing held: nothing to wait for. Both bounds and the teardown's own
 * (core/updateHandoff.ts `TEARDOWN_DEADLINE_MS`) fit in the master's hand-over grace (harnessd/supervisor.ts).
 */
export async function settleMovesForHandOver(o: {
  mover: Pick<HostMover, 'stop' | 'settled'> | null
  gate: Pick<MoveGate, 'held' | 'refuseAll'>
  log: (line: string) => void
  waitMs?: number
  flushMs?: number
}): Promise<void> {
  o.mover?.stop()
  if (o.gate.held().length === 0) return
  const waitMs = o.waitMs ?? HAND_OVER_MOVE_WAIT_MS
  if (o.mover) await within(o.mover.settled(), waitMs)
  const held = o.gate.held()
  if (held.length === 0) return
  o.log(`[terminal] move: a move still holds input after ${waitMs / 1000} s; refusing pending input before handing over`)
  await within(o.gate.refuseAll(), o.flushMs ?? HAND_OVER_FLUSH_MS)
}

/** [work], or nothing once [ms] have passed. */
async function within(work: Promise<void>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([work, new Promise<void>((resolve) => { timer = setTimeout(resolve, ms) })])
  } finally {
    clearTimeout(timer)
  }
}
