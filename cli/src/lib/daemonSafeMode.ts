/**
 * What a daemon does when its own start-up throws.
 *
 * Dying was the old answer, and on a machine that kept throwing it was a trap: there is no
 * supervisor, the desktop app only re-runs `harness start` on the same broken bytes — about once a
 * minute, for ever — and the self-updater lives 87% of the way down `runForeground`, so a boot that
 * never finishes can never be fixed. Measured on a person's Mac at v0.3.5: two boots, one stack, no
 * way out but deleting the registry by hand.
 *
 * So a daemon whose boot failed STAYS UP with nothing but its updater running, and says so. The
 * decisions that have nothing to do with process control live here, where they can be tested.
 */
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { atomicWriteJson } from './registry.js'

/** Written while a daemon is in safe mode; removed on the way out. `harness status` reads it. */
export const SAFE_MODE_FILE_NAME = 'adapter.safe-mode'

export interface SafeModeMarker {
  pid: number
  version: string
  at: number
  error: string
}

export interface SafeModeDisposition {
  stay: boolean
  reason: string
}

/**
 * Whether staying alive is the right answer for THIS failure.
 *
 * Two shapes where it is not, and both are the same mistake: a second daemon that lost a race has no
 * business holding a port, a pid file and an update slot the winner already owns. Without this rule
 * every lost race would leave an immortal process behind, and they would accumulate.
 */
export function safeModeDisposition(
  error: unknown,
  deps: { selfPid: number; readPid: () => number | null; isAlive: (pid: number) => boolean },
): SafeModeDisposition {
  const message = error instanceof Error ? `${error.message}` : String(error)
  if (/EADDRINUSE|address already in use/i.test(message)) {
    return { stay: false, reason: 'the control port belongs to another daemon' }
  }
  const owner = deps.readPid()
  if (owner !== null && owner !== deps.selfPid && deps.isAlive(owner)) {
    return { stay: false, reason: `another daemon (pid ${owner}) owns this machine` }
  }
  return { stay: true, reason: message || 'start-up failed' }
}

/**
 * The status a safe-mode daemon serves.
 *
 * ⚠️ CROSS-LANGUAGE CONTRACT. `discoveryReady: false` is what tells the desktop app this daemon is
 * alive but not ready (`desktop/lib/ws/local_cli_discovery.dart` — `notReady`, which it never
 * respawns over), and that single field is what stops the once-a-minute restart storm. It has to be
 * a 200: a 5xx also reads as not-ready there, but `runningDaemonStatus()` treats a non-ok response
 * as no daemon at all, and `harness start` would then mistake safe mode for a healthy machine.
 */
export function safeModeStatusBody(info: {
  version: string
  pid: number
  startedAt: number
  computerId: string
  error: string
}): Record<string, unknown> {
  return {
    safeMode: true,
    discoveryReady: false,
    discoveryError: info.error,
    connected: false,
    version: info.version,
    pid: info.pid,
    startedAt: info.startedAt,
    computerId: info.computerId,
  }
}

export function safeModeFile(dataDir: string): string {
  return join(dataDir, SAFE_MODE_FILE_NAME)
}

export function writeSafeModeMarker(dataDir: string, marker: SafeModeMarker): void {
  try { atomicWriteJson(safeModeFile(dataDir), marker) } catch { /* a marker is a courtesy, not the state */ }
}

export function clearSafeModeMarker(dataDir: string): void {
  try { rmSync(safeModeFile(dataDir), { force: true }) } catch { /* ignore */ }
}

export interface BootHandoffDeps {
  /** The bound control port, if start-up ever got that far. */
  closeServer: () => void
  removePidFile: () => void
  spawn: (extraEnv: Record<string, string>) => { pid?: number; unref: () => void }
  exit: (code: number) => never
  log: (message: string) => void
}

/**
 * Hand the machine to a newer build without finishing start-up.
 *
 * SYNCHRONOUS END TO END, and that is the whole safety argument: never awaiting means the half-built
 * boot cannot interleave between the port closing and the exit, so it can never reach the code that
 * would bind the port the successor is about to take. Two daemons are impossible by construction.
 * That is also why it does not supervise the child the way a normal update restart does — waiting
 * would leave this process running alongside the new one for up to a minute, both reconciling tmux
 * and writing the registry.
 *
 * It spawns rather than merely exiting because nothing supervises a daemon: on a machine with no
 * desktop app nothing else would ever start the successor.
 */
export function runBootHandoff(from: string, to: string, deps: BootHandoffDeps): void {
  deps.log(`[update] ${from} → ${to} staged during start-up — handing off without finishing boot`)
  deps.closeServer()
  deps.removePidFile()
  const child = deps.spawn({ ADAPTER_UPDATED_TO: to })
  child.unref()
  deps.log(`[update] boot handoff → pid ${child.pid ?? '?'} · this process is leaving`)
  deps.exit(0)
}

/** The marker, or null — including for one left behind by a process that is no longer running. */
export function readSafeModeMarker(
  dataDir: string,
  isAlive: (pid: number) => boolean,
): SafeModeMarker | null {
  const path = safeModeFile(dataDir)
  try {
    if (!existsSync(path)) return null
    const raw = JSON.parse(readFileSync(path, 'utf-8')) as Partial<SafeModeMarker>
    if (typeof raw.pid !== 'number' || !isAlive(raw.pid)) return null
    return {
      pid: raw.pid,
      version: typeof raw.version === 'string' ? raw.version : 'unknown',
      at: typeof raw.at === 'number' ? raw.at : 0,
      error: typeof raw.error === 'string' ? raw.error : 'start-up failed',
    }
  } catch { return null }
}
