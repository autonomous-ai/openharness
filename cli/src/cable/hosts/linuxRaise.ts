/**
 * The one way a tap brings an agent's window forward on Linux, as macOS's `open -b` does
 * (docs/plans/2026-11-19-dial-linux-design.md §§ 2.1-2.2): the window of the agent's process or of the nearest parent
 * that owns one (its terminal's or its editor's), else its app's by class. Which desktop answers is found once at
 * start, and again after a raise fails: the person may have logged out and into another desktop since.
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { windowClasses } from './frontApp.js'
import { desktopLine, findLinuxDesktop, linuxDesktopDeps, type LinuxDesktop } from './linuxDesktop.js'
import { createGnomeRaise } from './linuxRaiseGnome.js'
import { createHyprlandRaise } from './linuxRaiseHyprland.js'
import { createKwinRaise } from './linuxRaiseKwin.js'
import { createSwayRaise } from './linuxRaiseSway.js'
import { createX11Raise } from './linuxRaiseX11.js'
import type { OrcaDeps } from './orca.js'
import { parentChain, readProcessNames, type ProcessName } from './scannedApp.js'

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

/** This login's raise: its desktop found from this process's own variables and sockets, each desktop's backend running
 *  through [apps]' runner, the parents from `ps`, and each app's classes from its fixed table. */
export function systemLinuxRaise(apps: OrcaDeps, log: (line: string) => void): LinuxRaise {
  const desktop = linuxDesktopDeps(apps)
  let scripts = 0
  return createLinuxRaise({
    find: () => findLinuxDesktop(desktop),
    backend: (found) => {
      switch (found.kind) {
        case 'sway': return createSwayRaise(apps, found.socket)
        case 'hyprland': return createHyprlandRaise(apps, found.signature)
        case 'gnome': return createGnomeRaise(apps, found.bus)
        case 'x11': return createX11Raise(apps, found.display, found.xauthority)
        case 'kwin': {
          // In this login's runtime dir, which only it can enter: KWin reads the script from there as the same account.
          const dir = join(found.runtimeDir, 'harness')
          return createKwinRaise({
            ...apps,
            dir,
            write: (path, text) => {
              mkdirSync(dir, { recursive: true, mode: 0o700 })
              // not a state file: a script KWin reads once, removed when its raise ends
              writeFileSync(path, text, { mode: 0o600 })
            },
            remove: (path) => {
              try {
                rmSync(path, { force: true })
              } catch {
                // Left in this login's own folder: the raise answers all the same, and the next one takes another name.
              }
            },
            name: () => `${process.pid}-${++scripts}`,
          }, found.bus)
        }
      }
    },
    processes: () => readProcessNames(),
    classes: windowClasses,
    log,
  })
}
