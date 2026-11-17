// The window made from VS Code's API: each terminal's shell pid, kept so state() answers at once, and read again at each
// terminal event, since VS Code relaunches a shell in the same Terminal with a new pid.
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
  const readAll = () => {
    for (const terminal of api.window.terminals) {
      if (!pids.has(terminal)) pids.set(terminal, undefined)
      Promise.resolve(terminal.processId).then(
        (pid) => {
          // A terminal closed before its answer came is not brought back.
          if (disposed || !pids.has(terminal) || pids.get(terminal) === pid) return
          pids.set(terminal, pid)
          tell()
        },
        // A shell that failed to start has no pid to list.
        () => {},
      )
    }
  }
  const pidOf = (terminal: ApiTerminal | undefined) => (terminal ? pids.get(terminal) : undefined)

  readAll()
  const subscriptions = [
    api.window.onDidOpenTerminal(readAll),
    api.window.onDidCloseTerminal((terminal) => {
      pids.delete(terminal)
      tell()
      readAll()
    }),
    api.window.onDidChangeActiveTerminal(() => {
      tell()
      readAll()
    }),
    api.window.onDidChangeTerminalState(readAll),
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
    raise() {
      // VS Code before 1.128 has no such command and rejects: there the terminal is shown without its window raised.
      void api.commands.executeCommand('workbench.action.focusWindow').then(undefined, () => {})
    },
    async scrollLine(up) {
      await api.commands.executeCommand(up ? 'workbench.action.terminal.scrollUp' : 'workbench.action.terminal.scrollDown')
    },
    dispose() {
      disposed = true
      listeners.clear()
      for (const subscription of subscriptions) subscription.dispose()
    },
  }
}
