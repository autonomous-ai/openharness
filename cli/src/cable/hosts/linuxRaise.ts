/**
 * The one way a tap brings an agent's window forward on Linux, as macOS's `open -b` does
 * (docs/plans/2026-11-19-dial-linux-design.md §§ 2.1-2.2): the window of the agent's process or of the nearest parent
 * that owns one (its terminal's or its editor's), else its app's by class. Which desktop answers is found once at
 * start, and again after a raise fails: the person may have logged out and into another desktop since.
 */
import { rmSync, writeFileSync } from 'node:fs'
import { privateFolder, runtimeShortRoot } from '../../lib/localSocket.js'
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
  /** Whether a raise can bring forward [window]: the last look found a desktop (false until the first lands) that takes
   *  an agent's window by its process ([agent]; a pick has none), or knows [app]'s class. */
  ready(window: { agent: boolean; app?: string }): boolean
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

// GNOME's extension finds a window by its app's class alone (linuxRaiseGnome.ts); every other desktop by its process too.
const byProcess = (desktop: LinuxDesktop): boolean => desktop.kind !== 'gnome'

export function createLinuxRaise(deps: LinuxRaiseDeps): LinuxRaise {
  let desktop: LinuxDesktop | undefined
  let said: string | undefined
  // The failure last logged: once, until a raise ends otherwise.
  let failed: string | undefined
  let looking: Promise<void> | undefined
  // One look at a time: raises that fail together share it. A look that throws found nothing: unhandled, it would reject
  // every raise waiting on it.
  const look = () => (looking ??= deps.find().catch((): LinuxDesktop => ({ kind: 'none', why: 'no desktop session' })).then((found) => {
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
    ready: ({ agent, app }) => desktop !== undefined && desktop.kind !== 'none'
      && ((agent && byProcess(desktop)) || (app !== undefined && deps.classes(app).length > 0)),
    async raise({ pid, app }) {
      await looking
      const found = desktop
      if (found === undefined || found.kind === 'none') return false
      // pid 1 holds every orphan, so it names no agent's window. A desktop that takes no process is not handed one: with
      // no class either, nothing runs and nothing is looked at again.
      const pids = byProcess(found) && pid !== undefined && Number.isInteger(pid) && pid > 1 ? await chainOf(pid) : []
      const classes = app === undefined ? [] : deps.classes(app)
      if (pids.length === 0 && classes.length === 0) return false
      try {
        if (await deps.backend(found).raise({ pids, classes })) {
          failed = undefined
          return true
        }
      } catch {
        // A backend that throws found no window, as one that answers false.
      }
      // Which desktop's raise, never its window, process or error: a tap that brings nothing is seen in the log.
      const line = `[device] raise · ${found.kind} · failed`
      if (line !== failed) deps.log(line)
      failed = line
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
  // KWin gives a script's id to the next one loaded once it is unloaded (RECORDED_KWIN.loadScript): one KDE raise at a
  // time, so none runs or unloads a script another raise loaded.
  let kwinTurn: Promise<unknown> = Promise.resolve()
  return createLinuxRaise({
    find: () => findLinuxDesktop(desktop),
    backend: (found) => {
      switch (found.kind) {
        case 'sway': return createSwayRaise(apps, found.socket)
        case 'hyprland': return createHyprlandRaise(apps, found.signature)
        case 'gnome': return createGnomeRaise(apps, found.bus)
        case 'x11': return createX11Raise(apps, found.display, found.xauthority)
        case 'kwin': {
          // KWin runs whatever script is at the path it is handed, and a script can call any bus method as this login:
          // only a runtime dir this account owns, 0700, keeps another account from putting one there first
          // (XDG_RUNTIME_DIR=/tmp is a world-writable one). None such, no raise.
          const dir = runtimeShortRoot({ XDG_RUNTIME_DIR: found.runtimeDir })
          if (dir === null) return { raise: async () => false }
          const kwin = createKwinRaise({
            ...apps,
            dir,
            write: (path, text) => {
              // Checked again at each write, as the daemon's own short socket folders are: a link or another account's
              // folder throws, and the raise answers false with nothing written.
              privateFolder(dir)
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
          return {
            raise: (target) => {
              const turn = kwinTurn.then(() => kwin.raise(target))
              kwinTurn = turn.catch(() => false)
              return turn
            },
          }
        }
      }
    },
    processes: () => readProcessNames(),
    classes: windowClasses,
    log,
  })
}
