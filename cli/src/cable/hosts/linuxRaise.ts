/**
 * The one way a tap brings an agent's window forward on Linux, as macOS's `open -b` does
 * (docs/plans/2026-11-19-dial-linux-design.md §§ 2.1-2.2): the window of the agent's process or of the nearest parent
 * that owns one (its terminal's or its editor's), else its app's by class. Which desktop answers is found once at
 * start, and again after a raise fails: the person may have logged out and into another desktop since.
 */
import { desktopLine, type LinuxDesktop } from './linuxDesktop.js'
import type { OrcaDeps } from './orca.js'
import { parentChain, type ProcessName } from './scannedApp.js'

/** The agent's process and its parents, nearest first, and its app's class spellings. */
export interface RaiseTarget { pids: readonly number[]; classes: readonly string[] }
export interface RaiseBackend { raise(target: RaiseTarget): Promise<boolean> }
export type RaiseRun = Pick<OrcaDeps, 'run' | 'onPath'>
export interface LinuxRaise {
  /** Whether the last look found a desktop: false until the first look lands. */
  ready(): boolean
  /** Brings forward the window of that process or one of its parents, else its app's by class. Never throws. */
  raise(window: { pid?: number; app?: string }): Promise<boolean>
}
export interface LinuxRaiseDeps {
  find(): Promise<LinuxDesktop>
  backend(desktop: Exclude<LinuxDesktop, { kind: 'none' }>): RaiseBackend
  processes(): Promise<readonly Pick<ProcessName, 'pid' | 'ppid'>[]>
  classes(app: string): readonly string[]
  log(line: string): void
}

export function createLinuxRaise(deps: LinuxRaiseDeps): LinuxRaise {
  let desktop: LinuxDesktop | undefined
  let said: string | undefined
  let looking: Promise<void> | undefined
  // One look at a time: raises that fail together share it.
  const look = () => (looking ??= deps.find().then((found) => {
    desktop = found
    const line = desktopLine(found)
    if (line !== said) deps.log(line)
    said = line
  }).finally(() => {
    looking = undefined
  }))
  const chainOf = async (pid: number) => {
    const table = await deps.processes().catch(() => [])
    return parentChain(pid, new Map(table.map((p) => [p.pid, p]))).map((p) => p.pid)
  }
  void look()

  return {
    ready: () => desktop !== undefined && desktop.kind !== 'none',
    async raise({ pid, app }) {
      await looking
      const found = desktop
      if (found === undefined || found.kind === 'none') return false
      // pid 1 holds every orphan, so it names no agent's window.
      const pids = pid !== undefined && Number.isInteger(pid) && pid > 1 ? await chainOf(pid) : []
      const classes = app === undefined ? [] : deps.classes(app)
      if (pids.length === 0 && classes.length === 0) return false
      try {
        if (await deps.backend(found).raise({ pids, classes })) return true
      } catch {
        // A backend that throws found no window, as one that answers false.
      }
      void look()
      return false
    },
  }
}
