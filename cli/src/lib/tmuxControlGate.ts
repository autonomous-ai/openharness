/**
 * Keeps a terminal opening apart from what tmux tells every terminal about, on a tmux that crashes when
 * the two meet.
 *
 * Every open terminal is a tmux control client (`tmux -C attach-session`, tmuxStream.ts). Before tmux 3.7
 * the server marks a client as a control client when the first of its identify messages arrives, and
 * builds the state it writes that client's notifications into only when the last one does, a few turns
 * of its event loop later. A notification for every control client sent in between is written into state
 * that is not there yet: a NULL dereference, and the whole server is gone, every agent's pane with it
 * (tmux issue 4980, fixed in 3.7 by commit e5a2a25, "Do not notify clients if not fully initialized").
 * The notifications that go to a client before it has a session are: a client detaching, a session
 * created, closed or renamed, a paste buffer set or deleted, a pane changing mode, a window's active pane
 * or a session's current window changing.
 *
 * Found by the end-to-end suite on Ubuntu 24.04 (tmux 3.4): windows.e2e.ts, where windows open terminals
 * while others close theirs, failed 7 of 27 CI runs with `tmux pane metadata is unavailable`. The tmux
 * server had segfaulted; there was no server left to list panes for the failure's artifacts. Measured
 * outside the daemon, 2026-10-06:
 * - two control clients attaching and detaching side by side, 600 rounds: Ubuntu's tmux 3.4 died
 *   (SIGSEGV) in each of 6 runs, a tmux 3.5a built from source in 1 of 4;
 * - 300 control clients attaching one after another while another client sets and deletes paste buffers,
 *   or creates and kills sessions: Ubuntu's 3.4 died in every run of both, 3.6a with sessions;
 * - tmux 3.7 survived all of them.
 * A gdb backtrace on 3.4 puts it in `control_write` from `control_notify_client_detached`, the client's
 * `control_state` NULL. Ubuntu 24.04 ships 3.4, Debian 12 3.3a, Fedora 3.5a. tmuxStream.real.spec.ts
 * holds the churn that found it; without this gate it failed on 3.4 within a second, every run.
 *
 * So on such a tmux a control client attaches in the `attach` room, from its spawn until tmux has
 * answered its first command (its state exists by then), and what this daemon does that sends such a
 * notification happens in the `notify` room: a control client going, a session made or killed, a paste.
 * Each room holds any number at once; the two never overlap. What tmux does on its own (an engine
 * exiting and closing its session) and what a person does in their own tmux clients cannot be held
 * here; only tmux 3.7 ends those.
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
