// A window the loop's tests drive: its state is what the test sets, and each terminal the loop asks for is recorded.
import type { WindowFacade, WindowState } from '../window'

export function fakeWindow(initial: Partial<WindowState> & { remote?: boolean } = {}): {
  window: WindowFacade
  /** Tells the change. */
  set(next: Partial<WindowState>): void
  /** Each pid asked to be shown. */
  shows: number[]
} {
  const { remote = false, ...first } = initial
  let state: WindowState = { terminals: [], active: null, focused: false, ...first }
  const listeners = new Set<() => void>()
  const shows: number[] = []
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
    },
    set(next) {
      state = { ...state, ...next }
      for (const changed of [...listeners]) changed()
    },
    shows,
  }
}
