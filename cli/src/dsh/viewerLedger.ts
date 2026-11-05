/**
 * Which viewer processes THIS daemon has started, on disk, so the NEXT daemon can stop the ones it
 * never got to.
 *
 * Viewers are spawned detached, in their own process group (shell.ts spawnDshCommand), and only the
 * daemon's clean exits stop them (`dshViewers.stopAll()` on shutdown and on the self-update handoff).
 * Every other way a daemon ends — a crash, a force quit, `harness stop` falling through to SIGKILL —
 * leaves them running under launchd/systemd, still polling, still holding memory, and the daemon
 * that comes up next starts a fresh set beside them: seven generations of one viewer were found on
 * a single Mac. Nothing in the packages can fix that, so the daemon keeps a ledger.
 *
 * A pid alone is not proof — pids are reused — so each entry also records when the process started,
 * and the reaper only touches a pid whose live start time agrees with the ledger's.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { env } from '../config/env.js'
import type { ProcessRow } from '../lib/processTable.js'
import { ptyHostBinary } from '../lib/ptyHost/launch.js'
import { WINDOWS_PS_TIMEOUT_MS, windowsProcessTable } from '../lib/windows/processTable.js'
import { windowsStartTime } from '../lib/windows/treeKill.js'
import { killPidGroup } from './shell.js'

const WINDOWS_EPOCH_MS = 11_644_473_600_000n
/** [ms] as a Windows start time (100 ns ticks since 1601), as `windowsStartTime` reads one. */
const asWindowsTime = (ms: number): bigint => (BigInt(Math.trunc(ms)) + WINDOWS_EPOCH_MS) * 10_000n

/** Windows' process table now, or null when it could not be read. */
function readWindowsRows(): ProcessRow[] | null {
  try {
    const binary = ptyHostBinary()
    if (!binary) return null
    const output = execFileSync(binary, ['ps', '--json'], { encoding: 'utf8', timeout: WINDOWS_PS_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024, windowsHide: true })
    return windowsProcessTable(JSON.parse(output))
  } catch { return null }
}

/**
 * The pids of what remains of a ledgered viewer on Windows: its launcher, and a program running from its folder whose parent
 * has gone. The launcher alone is not enough: what Git Bash runs is a process of its own whose Windows parent has exited
 * (lib/windows/gitBashTree.ts), so nothing walks down to it once the launcher ends with the daemon. A parent still running means
 * something else started it, an agent in a pane for one, and it is left alone, as is what started before this viewer.
 */
export function windowsViewerLeftovers(entry: ViewerLedgerEntry, rows: readonly ProcessRow[]): number[] {
  const since = asWindowsTime(entry.startedAt - START_TOLERANCE_MS)
  const started = (row: ProcessRow) => windowsStartTime(row.startMarker)
  const fresh = (row: ProcessRow) => { const at = started(row); return at !== null && at >= since }
  const folder = `${entry.viewerDir.replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase()}/`
  const live = new Set(rows.map(row => row.pid))
  const launcher = rows.filter(row => {
    const at = started(row)
    return row.pid === entry.pid && at !== null && at >= since && at <= asWindowsTime(entry.startedAt + START_TOLERANCE_MS)
  })
  const programs = rows.filter(row => row.pid !== entry.pid && !live.has(row.parentPid) && fresh(row)
    && row.args.replaceAll('\\', '/').toLowerCase().includes(folder))
  return [...launcher, ...programs].map(row => row.pid)
}

export interface ViewerLedgerEntry {
  pid: number
  /** ms epoch when the daemon spawned it; compared against the live process's start time. */
  startedAt: number
  agentId: string
  dshId: string
  viewerDir: string
}

/** How far the ledger's spawn time and the kernel's process start time may disagree and still be
 *  the same process. Spawn-to-exec is milliseconds; `ps` prints whole seconds. */
const START_TOLERANCE_MS = 10_000

export const VIEWER_LEDGER_FILE = join(env.ADAPTER_DATA_DIR, 'viewers.json')

/** When `pid` started, per the kernel, or null when it is gone or `ps` cannot say. `lstart` is the
 *  one column both macOS and Linux ps print in a form Date.parse reads ("Mon Sep 22 10:00:01 2026"). */
export function processStartedAt(pid: number): number | null {
  try {
    const out = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', timeout: 5_000 }).trim()
    if (!out) return null
    const at = Date.parse(out)
    return Number.isFinite(at) ? at : null
  } catch { return null }
}

export interface ViewerLedgerDeps {
  file?: string
  now?: () => number
  /** Test seams for the reaper. */
  startedAt?: (pid: number) => number | null
  kill?: (pid: number) => void
  log?: (line: string) => void
  platform?: NodeJS.Platform
  /** Windows' process table; null when it could not be read. */
  windowsRows?: () => ProcessRow[] | null
}

export class ViewerLedger {
  private readonly file: string
  constructor(private readonly deps: ViewerLedgerDeps = {}) {
    this.file = deps.file ?? VIEWER_LEDGER_FILE
  }

  read(): ViewerLedgerEntry[] {
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.file, 'utf8'))
      if (!Array.isArray(parsed)) return []
      return parsed.filter((e): e is ViewerLedgerEntry =>
        !!e && typeof e === 'object'
        // > 1, never merely > 0: signalling group -1 is "every process I own".
        && Number.isInteger((e as ViewerLedgerEntry).pid) && (e as ViewerLedgerEntry).pid > 1
        && Number.isFinite((e as ViewerLedgerEntry).startedAt)
        && typeof (e as ViewerLedgerEntry).agentId === 'string'
        && typeof (e as ViewerLedgerEntry).dshId === 'string'
        && typeof (e as ViewerLedgerEntry).viewerDir === 'string')
    } catch { return [] }
  }

  private write(entries: ViewerLedgerEntry[]): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      const tmp = `${this.file}.${process.pid}.tmp`
      writeFileSync(tmp, JSON.stringify(entries, null, 2) + '\n', { mode: 0o600 })
      renameSync(tmp, this.file)
    } catch { /* best effort: a ledger that cannot be written only means no reaping next time */ }
  }

  add(entry: Omit<ViewerLedgerEntry, 'startedAt'> & { startedAt?: number }): void {
    if (!Number.isInteger(entry.pid) || entry.pid <= 1) return
    const startedAt = entry.startedAt ?? (this.deps.now ?? Date.now)()
    this.write([...this.read().filter((e) => e.pid !== entry.pid), { ...entry, startedAt }])
  }

  remove(pid: number): void {
    const entries = this.read()
    const kept = entries.filter((e) => e.pid !== pid)
    if (kept.length !== entries.length) this.write(kept)
  }

  /**
   * Stop every ledgered viewer that is still alive and provably the same process, then start the
   * ledger over. Meant for daemon boot, BEFORE this daemon starts any viewer of its own. Returns the
   * entries it signalled.
   */
  reapOrphans(): ViewerLedgerEntry[] {
    const entries = this.read()
    if (entries.length === 0) return []
    const startedAt = this.deps.startedAt ?? processStartedAt
    const kill = this.deps.kill ?? ((pid: number) => { killPidGroup(pid) })
    const reaped: ViewerLedgerEntry[] = []
    if ((this.deps.platform ?? process.platform) === 'win32') {
      // Windows has no `ps` for the check below. A table that could not be read keeps the ledger for the next start.
      const rows = (this.deps.windowsRows ?? readWindowsRows)()
      if (!rows) return []
      for (const entry of entries) {
        const pids = windowsViewerLeftovers(entry, rows)
        for (const pid of pids) kill(pid)
        if (!pids.length) continue
        reaped.push(entry)
        this.deps.log?.(`[dsh] reaped orphaned ${entry.dshId} viewer: ${pids.length} process(es)`)
      }
      this.write([])
      return reaped
    }
    for (const entry of entries) {
      const live = startedAt(entry.pid)
      if (live === null) continue // gone, or unknowable — a pid we cannot vouch for is left alone
      if (Math.abs(live - entry.startedAt) > START_TOLERANCE_MS) {
        this.deps.log?.(`[dsh] pid ${entry.pid} is no longer the ${entry.dshId} viewer (started ${new Date(live).toISOString()}, ledger says ${new Date(entry.startedAt).toISOString()}) · left alone`)
        continue
      }
      kill(entry.pid)
      reaped.push(entry)
      this.deps.log?.(`[dsh] reaped orphaned ${entry.dshId} viewer pid ${entry.pid} (started ${new Date(entry.startedAt).toISOString()}, agent ${entry.agentId.slice(0, 8)})`)
    }
    this.write([])
    return reaped
  }
}
