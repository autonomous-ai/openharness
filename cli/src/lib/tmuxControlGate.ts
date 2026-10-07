/**
 * Keeps a terminal attaching apart from what tmux tells every terminal, on a tmux that crashes when the
 * two meet. Every open terminal is a tmux control client (`tmux -C attach-session`, tmuxStream.ts).
 * Before 3.7 tmux marks a control client at its first identify message but builds the state it writes
 * notifications into only at its last, a few turns of its loop later. A notification for every control
 * client in between (a client detaching; a session created, closed or renamed; a paste buffer set or
 * deleted) dereferences NULL, and the server dies with every agent's pane (tmux issue 4980, fixed in 3.7
 * by e5a2a25). Ubuntu 24.04 ships 3.4, Debian 12 3.3a, Fedora 3.5a.
 *
 * Found by windows.e2e.ts on Ubuntu 24.04: 7 of 27 CI runs failed with `tmux pane metadata is
 * unavailable`; the server had segfaulted. Measured, 2026-10-06: control clients attaching beside others
 * detaching killed Ubuntu's 3.4 (SIGSEGV) in each of 6 runs, gdb in `control_write` from
 * `control_notify_client_detached` with `control_state` NULL; attaches beside paste buffers, or beside
 * sessions made and killed, killed it every run; 3.7 survived all. The churn is in tmuxStream.real.spec.ts:
 * without this gate it failed on 3.4 within a second, every run.
 *
 * So, before 3.7, a control client attaches in the `attach` room until tmux answers its first command,
 * and what this daemon does that notifies (a control client going, a session made or killed or renamed,
 * a paste) runs in the `notify` room. Each room holds any number; the two never overlap. What tmux does
 * on its own (an engine exiting ends its session) and a person's own tmux clients cannot be held here.
 */

import { tmuxFeatures, type TmuxFeatures } from './tmuxVersion.js'

export type TmuxGateRoom = 'attach' | 'notify'

interface Waiter {
  room: TmuxGateRoom
  admit: () => void
}

/**
 * Two rooms, any number inside one, never both occupied. First come, first served: one that arrives
 * while others wait queues behind them even when its room is the one open, so a stream of pastes never
 * keeps a terminal from opening, nor the other way round.
 */
export class TwoRoomGate {
  private room: TmuxGateRoom | null = null
  private inside = 0
  private readonly queue: Waiter[] = []

  /** Resolves once [room] is entered, with the way out (calling it again does nothing). */
  enter(room: TmuxGateRoom): Promise<() => void> {
    if (this.queue.length === 0 && (this.inside === 0 || this.room === room)) return Promise.resolve(this.admit(room))
    return new Promise((resolve) => this.queue.push({ room, admit: () => resolve(this.admit(room)) }))
  }

  /** Who is inside and who waits, for tests and the log. */
  get state(): { room: TmuxGateRoom | null; inside: number; waiting: number } {
    return { room: this.room, inside: this.inside, waiting: this.queue.length }
  }

  private admit(room: TmuxGateRoom): () => void {
    this.room = room
    this.inside++
    let left = false
    return () => {
      if (left) return
      left = true
      this.inside--
      if (this.inside > 0) return
      this.room = null
      // Everyone at the head who wants the same room goes in together.
      const next = this.queue[0]?.room
      while (next && this.queue[0]?.room === next) this.queue.shift()!.admit()
    }
  }
}

/** The one gate for this process: every control client and every notifying command of this daemon. */
export const tmuxControlGate = new TwoRoomGate()

/** Whether this tmux needs the gate: before 3.7 (see above). An unknown version is new, as everywhere. */
export function needsControlGate(features: TmuxFeatures): boolean {
  return !features.controlNotifyGuard
}

const OPEN_DOOR = (): void => {}

/** Enter [room] on a tmux that needs it; on one that does not, the way out of a room never entered. */
export async function enterTmuxRoom(room: TmuxGateRoom, features?: TmuxFeatures): Promise<() => void> {
  if (!needsControlGate(features ?? await tmuxFeatures())) return OPEN_DOOR
  return tmuxControlGate.enter(room)
}

/** Run [work] in [room] (see `enterTmuxRoom`), leaving it however [work] ends. */
export async function inTmuxRoom<T>(room: TmuxGateRoom, work: () => Promise<T>, features?: TmuxFeatures): Promise<T> {
  const leave = await enterTmuxRoom(room, features)
  try {
    return await work()
  } finally {
    leave()
  }
}
