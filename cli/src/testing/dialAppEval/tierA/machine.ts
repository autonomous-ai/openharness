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
}

export const machine: MachineModel = {
  processes: new Map(),
  bundleIds: new Map(),
  folders: new Set(),
  owners: new Map(),
  reset() {
    this.processes.clear()
    this.bundleIds.clear()
    this.folders.clear()
    this.owners.clear()
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
