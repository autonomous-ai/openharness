/**
 * The scenario's model of this computer, for tier A: its live session processes, the app each runs in, the apps'
 * bundle ids and the sessions those processes have open. The mocks of dialAppEval.spec.ts answer every read the devices
 * make of the machine (its process table, a process's terminal and app, the open sessions and their rows) from this, so
 * the devices see the scenario's processes and nothing of the host's.
 *
 * It imports nothing at run time from src/: vi.hoisted loads it before the mocks that read it are in place.
 */
export interface LiveProcess { pid: number; ppid: number; executable: string; tty?: string; app?: string }

export interface MachineModel {
  processes: Map<number, LiveProcess>
  /** An app's bundle id by the path of its bundle, as its Info.plist would give it. */
  bundleIds: Map<string, string>
  reset(): void
  start(p: LiveProcess): void
  /** The process ends, and the sessions it had open with it. */
  end(pid: number): void
  /** The sessions open, by session id: the engine and process that have each open, its folder and its transcript. */
  owners: Map<string, { engine: 'claude' | 'codex'; pid: number; cwd: string; transcriptPath: string | null }>
}

export const machine: MachineModel = {
  processes: new Map(),
  bundleIds: new Map(),
  owners: new Map(),
  reset() {
    this.processes.clear()
    this.bundleIds.clear()
    this.owners.clear()
  },
  start(p) {
    this.processes.set(p.pid, p)
  },
  end(pid) {
    this.processes.delete(pid)
    for (const [sessionId, owner] of this.owners) if (owner.pid === pid) this.owners.delete(sessionId)
  },
}
