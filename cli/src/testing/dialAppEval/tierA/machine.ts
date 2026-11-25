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
  /** The sessions open, by session id: the engine and process that have each open, its folder, its transcript and what
   *  says it is mid-turn (SessionOwner.record): Claude Code's process record, another engine's transcript. */
  owners: Map<string, { engine: Engine; pid: number; cwd: string; transcriptPath: string | null; record: string }>
  /** The home iTerm2 copies its server under, on an iTerm2 scenario's machine alone: the learnApps mock walks a process
   *  no app id names with the real scannedApps there (docs/plans/2026-11-22-dial-eval-iterm2-plan.md, Decision 4). */
  itermHome?: string
  /** Each program installed here by name, at its made-up path. */
  installed: Map<string, string>
  /** Each tty's last access by its bare name (`ttys004`), at virtual time. */
  atimes: Map<string, number>
  /** What the spec's watchSocket mock was handed, by the socket's path, each until its stop: told as that socket appears
   *  (steps/herdr.ts). */
  socketWatches: Map<string, Set<() => void>>
  /** The ids made up here so far: the next random UUID is the next of them, so a scenario run twice makes the same ids
   *  (herdr's rows listed before the open scan names theirs carry one). */
  uuids: number
  uuid(): string
}

export const machine: MachineModel = {
  processes: new Map(),
  bundleIds: new Map(),
  folders: new Set(),
  owners: new Map(),
  installed: new Map(),
  atimes: new Map(),
  socketWatches: new Map(),
  uuids: 0,
  reset() {
    this.processes.clear()
    this.bundleIds.clear()
    this.folders.clear()
    this.owners.clear()
    this.itermHome = undefined
    this.installed.clear()
    this.atimes.clear()
    this.socketWatches.clear()
    this.uuids = 0
  },
  start(p) {
    this.processes.set(p.pid, p)
  },
  end(pid) {
    this.processes.delete(pid)
    for (const [sessionId, owner] of this.owners) if (owner.pid === pid) this.owners.delete(sessionId)
  },
  // A form no catalog id has (catalog.ts uuid).
  uuid() {
    return `ffffffff-ffff-4fff-bfff-${(this.uuids++).toString(16).padStart(12, '0')}`
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
