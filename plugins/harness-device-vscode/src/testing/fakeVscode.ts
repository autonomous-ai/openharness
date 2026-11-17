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

/** `missing`: commands this VS Code does not have, whose run rejects as VS Code's does. */
export function fakeVscode(options: { remoteName?: string; missing?: readonly string[] } = {}): {
  api: VscodeApi
  /** A terminal whose shell's pid resolves, or whose ask fails, when the test says. `relaunch` starts a new shell in the
   *  same terminal, as VS Code does: its processId answers the new pid from then on, and no event fires. */
  open(): { terminal: ApiTerminal; resolve(pid: number | undefined): void; reject(): void; relaunch(pid: number): void; shown: boolean[] }
  close(terminal: ApiTerminal): void
  activate(terminal: ApiTerminal | undefined): void
  /** Fires onDidChangeTerminalState for that terminal. */
  changeState(terminal: ApiTerminal): void
  focus(focused: boolean): void
  /** Each command run, in order, a missing one too. */
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
  const terminalChanged = emitter<ApiTerminal>()
  const stateChanged = emitter<{ readonly focused: boolean }>()
  const channels: Array<{ name: string; lines: string[]; disposed: boolean }> = []
  const commands: string[] = []
  const api: VscodeApi = {
    env: { remoteName: options.remoteName },
    commands: {
      executeCommand(command) {
        commands.push(command)
        if (options.missing?.includes(command)) return Promise.reject(new Error(`command '${command}' not found`))
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
      onDidChangeTerminalState: terminalChanged.on,
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
      let processId = new Promise<number | undefined>((yes, no) => {
        resolve = yes
        reject = no
      })
      const shown: boolean[] = []
      const terminal: ApiTerminal = {
        get processId() {
          return processId
        },
        // VS Code's preserveFocus is false when left out.
        show: (preserveFocus = false) => shown.push(preserveFocus),
      }
      terminals.push(terminal)
      opened.fire(terminal)
      return {
        terminal,
        resolve,
        reject: () => reject(new Error('the shell did not start')),
        relaunch: (pid) => {
          processId = Promise.resolve(pid)
        },
        shown,
      }
    },
    close(terminal) {
      terminals.splice(terminals.indexOf(terminal), 1)
      closed.fire(terminal)
    },
    activate(terminal) {
      activeTerminal = terminal
      activeChanged.fire(terminal)
    },
    changeState(terminal) {
      terminalChanged.fire(terminal)
    },
    focus(next) {
      focused = next
      stateChanged.fire({ focused })
    },
    commands,
    channels,
    listeners: () => opened.size() + closed.size() + activeChanged.size() + terminalChanged.size() + stateChanged.size(),
  }
}
