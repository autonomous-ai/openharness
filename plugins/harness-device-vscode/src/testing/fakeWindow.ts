// A window the loop's tests drive: its state is what the test sets, and each terminal the loop asks for, each raise and
// each scroll, is recorded.
import type { WindowFacade, WindowState } from '../window'

export function fakeWindow(initial: Partial<WindowState> & { remote?: boolean } = {}): {
  window: WindowFacade
  /** Tells the change. */
  set(next: Partial<WindowState>): void
  /** Each pid asked to be shown. */
  shows: number[]
  /** For each raise, how many shows came before it. */
  raised: number[]
  /** Each scrollLine, true for up. */
  scrolls: boolean[]
  /** How the next scrollLines end, in turn: held until release(), or rejected. Resolved once none is left. */
  scrollReplies: ('held' | 'rejected')[]
  /** Resolves every scrollLine held. */
  release(): void
} {
  const { remote = false, ...first } = initial
  let state: WindowState = { terminals: [], active: null, focused: false, ...first }
  const listeners = new Set<() => void>()
  const shows: number[] = []
  const raised: number[] = []
  const scrolls: boolean[] = []
  const scrollReplies: ('held' | 'rejected')[] = []
  let held: (() => void)[] = []
  return {
    window: {
      remote,
      state: () => state,
      onChange(changed) {
        listeners.add(changed)
        return () => {
          listeners.delete(changed)
        }
      },
      show(pid) {
        shows.push(pid)
        return state.terminals.includes(pid)
      },
      raise() {
        raised.push(shows.length)
      },
      scrollLine(up) {
        scrolls.push(up)
        const reply = scrollReplies.shift()
        if (reply === 'rejected') return Promise.reject(new Error('the command failed'))
        if (reply === 'held') return new Promise<void>((done) => held.push(done))
        return Promise.resolve()
      },
    },
    set(next) {
      state = { ...state, ...next }
      for (const changed of [...listeners]) changed()
    },
    shows,
    raised,
    scrolls,
    scrollReplies,
    release() {
      const done = held
      held = []
      for (const resolve of done) resolve()
    },
  }
}
