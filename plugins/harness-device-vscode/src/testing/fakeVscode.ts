// A VS Code API the facade's tests drive: terminals open, close and resolve their shell's pid when the test says.
import type { ApiTerminal, Disposable, VscodeApi } from '../vscodeApi'

function emitter<T>(): { on(listener: (value: T) => void): Disposable; fire(value: T): void; size(): number } {
  const listeners = new Set<(value: T) => void>()
  return {
    on(listener) {
      listeners.add(listener)
      return {
        dispose: () => {
          listeners.delete(listener)
        },
      }
    },
    fire(value) {
      for (const listener of [...listeners]) listener(value)
    },
    size: () => listeners.size,
  }
}

export function fakeVscode(options: { remoteName?: string } = {}): {
  api: VscodeApi
  /** A terminal whose shell's pid resolves, or whose ask fails, when the test says. */
  open(): { terminal: ApiTerminal; resolve(pid: number | undefined): void; reject(): void; shown: boolean[] }
  close(terminal: ApiTerminal): void
  activate(terminal: ApiTerminal | undefined): void
  focus(focused: boolean): void
  /** Each command run, in order. */
  commands: string[]
  /** Each channel made: its name, its lines, whether it was disposed. */
  channels: Array<{ name: string; lines: string[]; disposed: boolean }>
  /** How many listeners are still registered. */
  listeners(): number
} {
  const terminals: ApiTerminal[] = []
  let activeTerminal: ApiTerminal | undefined
  let focused = false
  const opened = emitter<ApiTerminal>()
  const closed = emitter<ApiTerminal>()
  const activeChanged = emitter<ApiTerminal | undefined>()
  const stateChanged = emitter<{ readonly focused: boolean }>()
  const channels: Array<{ name: string; lines: string[]; disposed: boolean }> = []
  const commands: string[] = []
  const api: VscodeApi = {
    env: { remoteName: options.remoteName },
    commands: {
      executeCommand(command) {
        commands.push(command)
        return Promise.resolve(undefined)
      },
    },
    window: {
      get terminals() {
        return [...terminals]
      },
      get activeTerminal() {
        return activeTerminal
      },
      get state() {
        return { focused }
      },
      onDidOpenTerminal: opened.on,
      onDidCloseTerminal: closed.on,
      onDidChangeActiveTerminal: activeChanged.on,
      onDidChangeWindowState: stateChanged.on,
      createOutputChannel(name) {
        const channel = { name, lines: [] as string[], disposed: false }
        channels.push(channel)
        return {
          appendLine: (line) => channel.lines.push(line),
          dispose: () => {
            channel.disposed = true
          },
        }
      },
    },
  }
  return {
    api,
    open() {
      let resolve!: (pid: number | undefined) => void
      let reject!: (error: Error) => void
      const processId = new Promise<number | undefined>((yes, no) => {
        resolve = yes
        reject = no
      })
      const shown: boolean[] = []
      // VS Code's preserveFocus is false when left out.
      const terminal: ApiTerminal = { processId, show: (preserveFocus = false) => shown.push(preserveFocus) }
      terminals.push(terminal)
      opened.fire(terminal)
      return { terminal, resolve, reject: () => reject(new Error('the shell did not start')), shown }
    },
    close(terminal) {
      terminals.splice(terminals.indexOf(terminal), 1)
      closed.fire(terminal)
    },
    activate(terminal) {
      activeTerminal = terminal
      activeChanged.fire(terminal)
    },
    focus(next) {
      focused = next
      stateChanged.fire({ focused })
    },
    commands,
    channels,
    listeners: () => opened.size() + closed.size() + activeChanged.size() + stateChanged.size(),
  }
}
