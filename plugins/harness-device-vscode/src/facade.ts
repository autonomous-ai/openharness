// The window made from VS Code's API: each terminal's shell pid, asked once and kept, so state() answers at once.
import type { ApiTerminal, Disposable, VscodeApi } from './vscodeApi'
import { windowState, type WindowFacade } from './window'

export function windowFacade(api: VscodeApi): WindowFacade & Disposable {
  // A terminal is a key from the moment it is asked; its value stays undefined until its pid resolves.
  const pids = new Map<ApiTerminal, number | undefined>()
  const listeners = new Set<() => void>()
  let disposed = false
  const tell = () => {
    for (const changed of [...listeners]) changed()
  }
  const ask = (terminal: ApiTerminal) => {
    if (pids.has(terminal)) return
    pids.set(terminal, undefined)
    Promise.resolve(terminal.processId).then(
      (pid) => {
        // A terminal closed before its answer came is not brought back.
        if (disposed || !pids.has(terminal) || pid === undefined) return
        pids.set(terminal, pid)
        tell()
      },
      // A shell that failed to start has no pid to list.
      () => {},
    )
  }
  const pidOf = (terminal: ApiTerminal | undefined) => (terminal ? pids.get(terminal) : undefined)

  for (const terminal of api.window.terminals) ask(terminal)
  const subscriptions = [
    api.window.onDidOpenTerminal(ask),
    api.window.onDidCloseTerminal((terminal) => {
      pids.delete(terminal)
      tell()
    }),
    api.window.onDidChangeActiveTerminal(tell),
    api.window.onDidChangeWindowState(tell),
  ]

  return {
    remote: api.env.remoteName !== undefined,
    state: () => windowState(api.window.terminals.map(pidOf), pidOf(api.window.activeTerminal), api.window.state.focused),
    onChange(changed) {
      listeners.add(changed)
      return () => {
        listeners.delete(changed)
      }
    },
    show(pid) {
      const terminal = api.window.terminals.find((each) => pids.get(each) === pid)
      if (!terminal) return false
      terminal.show(false)
      return true
    },
    dispose() {
      disposed = true
      listeners.clear()
      for (const subscription of subscriptions) subscription.dispose()
    },
  }
}
