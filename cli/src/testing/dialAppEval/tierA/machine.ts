/**
 * The scenario's model of this computer, for tier A: its live processes (the apps, the editors' shells and the agents),
 * the app each runs in, the apps' bundle ids and the sessions those processes have open. The mocks of
 * dialAppEval.spec.ts answer every read the devices make of the machine (its process table, a process's terminal and
 * app, the open sessions and their rows) from this, so the devices see the scenario's processes and nothing of the host's.
 *
 * It imports nothing at run time from src/: vi.hoisted loads it before the mocks that read it are in place.
 */
import type { Engine } from '../types.js'

/** app: the app id a walk of the process table names this process by, when it names one (scannedApp.ts scannedApps). */
export interface LiveProcess { pid: number; ppid: number; executable: string; tty?: string; app?: string }

export interface MachineModel {
  processes: Map<number, LiveProcess>
  /** An app's bundle id by the path of its bundle, as its Info.plist would give it. */
  bundleIds: Map<string, string>
  /** The folders there: the sessions' own, which Cursor's folder row opens (cable/hosts/cursorFolder.ts isFolder). */
  folders: Set<string>
  reset(): void
  start(p: LiveProcess): void
  /** The process ends, and the sessions it had open with it. */
  end(pid: number): void
  /** The app the walk names for the process: the nearest of it and its parents that has one, as learnApps answers. */
  appOf(pid: number): string | undefined
  /** The sessions open, by session id: the engine and process that have each open, its folder and its transcript. */
  owners: Map<string, { engine: Engine; pid: number; cwd: string; transcriptPath: string | null }>
  /** The home iTerm2 copies its server under, on an iTerm2 scenario's machine alone: the learnApps mock walks a process
   *  no app id names with the real scannedApps there (docs/plans/2026-11-22-dial-eval-iterm2-plan.md, Decision 4). */
  itermHome?: string
  /** Each program installed here by name, at its made-up path. */
  installed: Map<string, string>
  /** Each tty's last access by its bare name (`ttys004`), at virtual time. */
  atimes: Map<string, number>
  /** What the spec's watchSocket mock was handed, each until its stop: told as a socket appears (steps/herdr.ts). */
  socketWatches: Set<() => void>
}

export const machine: MachineModel = {
  processes: new Map(),
  bundleIds: new Map(),
  folders: new Set(),
  owners: new Map(),
  installed: new Map(),
  atimes: new Map(),
  socketWatches: new Set(),
  reset() {
    this.processes.clear()
    this.bundleIds.clear()
    this.folders.clear()
    this.owners.clear()
    this.itermHome = undefined
    this.installed.clear()
    this.atimes.clear()
    this.socketWatches.clear()
  },
  start(p) {
    this.processes.set(p.pid, p)
  },
  end(pid) {
    this.processes.delete(pid)
    for (const [sessionId, owner] of this.owners) if (owner.pid === pid) this.owners.delete(sessionId)
  },
  appOf(pid) {
    const passed = new Set<number>()
    for (let p = this.processes.get(pid); p && !passed.has(p.pid); p = this.processes.get(p.ppid)) {
      if (p.app !== undefined) return p.app
      passed.add(p.pid)
    }
    return undefined
  },
}
