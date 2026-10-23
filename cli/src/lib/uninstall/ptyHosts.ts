/**
 * `harness uninstall`'s end of the Harness terminal host (pty/, A): the panes the daemon could not stop as harnesses
 * (a terminal, an agent whose stop was refused), then the host. Each pane is killed with the op the daemon uses, which
 * gives it its grace, then the host is asked to shut down, which it does only with no pane left.
 *
 * A host that does not answer, refuses to shut down, or speaks a protocol without `shutdown`, is ended by its pid, on
 * every platform only once one read of the process table proves the pid is the host this home's discovery file named:
 * a harness-pty image, with a start marker, started no later than the file was written, running `serve --home` this
 * home. A pid alone proves nothing: the pty home outlives a reboot or a host crash, after which the recorded pid can
 * be any of the user's processes, or another install's host (the review of B5.7, round 1). The kill is B3's
 * identity-checked one (pid + start marker): TerminateProcess on Windows, SIGTERM on Unix, never a tree kill.
 */
import { statSync } from 'node:fs'
import path from 'node:path'
import { env } from '../../config/env.js'
import type { PtyHostClient, PtyHostDiscovery } from '../ptyHost/client.js'
import { discoveryFileName } from '../ptyHost/instance.js'
import { discoveredHostDead, listDiscoveries, pidAlive, reachPtyHost, type HostLiveness } from '../ptyHost/launch.js'
import { SHUTDOWN_PROTOCOL, SUPPORTED_PTY_PROTOCOLS } from '../ptyHost/protocol.js'
import { startedNoLaterThan, startMarkerMs } from '../processProof.js'
import { argvTokens, processRows, type ProcessRow } from '../processTable.js'
import { windowsProcessRows } from '../windows/processTable.js'
import { terminateVerified } from '../windows/terminate.js'

/** As long as `harness stop` gives the daemon (daemonStop.ts STOP_GRACE_MS). */
export const PANE_GRACE_MS = 3_000
export const HOST_EXIT_WAIT_MS = 5_000

export type HostClient = Pick<PtyHostClient, 'call' | 'close' | 'protocol' | 'pid'>
type HostRow = Pick<ProcessRow, 'pid' | 'executable' | 'startMarker'> & Partial<ProcessRow>

export interface PtyHostsDeps {
  platform: NodeJS.Platform
  /** The pty home (HARNESS_PTY_DIR) whose hosts these are: a host must run `serve --home` it to be ended. */
  home: string
  /** This home's discovery records, each with when it was written as it was read (null when that could not be read):
   *  a host that agreed to shut down removes its record before it exits, and is still judged against it. */
  discover(): RecordedHost[]
  reach(instance: string): Promise<{ client: HostClient } | { unreachable: string }>
  alive(pid: number): boolean
  /** A's proof that the discovery file's host has gone (its pid now belongs to a later process). */
  dead(discovery: PtyHostDiscovery): Promise<boolean>
  rows(): Promise<readonly HostRow[] | null>
  /** The identity-checked kill: TerminateProcess on Windows, SIGTERM on Unix. */
  terminate(pid: number, startMarker: string): Promise<'ended' | 'gone' | 'mismatch'>
  sleep(ms: number): Promise<void>
}

export interface RecordedHost { discovery: PtyHostDiscovery; written: number | null }

export interface PtyHostEnd { pid: number; protocol: number; panes: number; how: 'shut down' | 'ended' | 'gone' | 'left'; detail?: string }

async function gone(deps: PtyHostsDeps, pid: number, ms: number): Promise<boolean> {
  for (let waited = 0; deps.alive(pid); waited += 100) {
    if (waited >= ms) return false
    await deps.sleep(100)
  }
  return true
}

export async function endPtyHosts(deps: PtyHostsDeps): Promise<PtyHostEnd[]> {
  const ended: PtyHostEnd[] = []
  for (const recorded of deps.discover()) {
    const { discovery } = recorded
    const { pid, protocol } = discovery
    if (!deps.alive(pid) || await deps.dead(discovery)) { ended.push({ pid, protocol, panes: 0, how: 'gone' }); continue }
    let panes = 0
    let why: string
    const reached = await deps.reach(discovery.instance)
    if ('client' in reached) {
      const client = reached.client
      let agreed = false
      why = `its protocol (${client.protocol}) has no shutdown`
      try {
        for (let round = 0; round < 2; round++) {
          const inventory = await client.call({ op: 'inventory' })
          if (inventory.state !== 'ok') why = `its panes could not be listed (${inventory.reason})`
          const rows = inventory.state === 'ok' ? inventory.value.panes : []
          for (const row of rows) if ((await client.call({ op: 'kill', pane: row.pane, graceMs: PANE_GRACE_MS })).state === 'ok') panes++
          if (rows.length) await deps.sleep(PANE_GRACE_MS)
          if (client.protocol < SHUTDOWN_PROTOCOL) break
          // A pane made between the inventory and the shutdown is refused, and gets one more round. An answer lost on
          // the way (`unknown`) may be a host already exiting: it is waited for like an `ok`.
          const shutdown = await client.call({ op: 'shutdown' })
          if (shutdown.state !== 'failed') { agreed = true; break }
          why = `it would not shut down (${shutdown.reason})`
        }
      } finally {
        client.close()
      }
      // Only a host that agreed is waited for: one that refused, or has no shutdown, is not about to exit.
      if (agreed) {
        if (await gone(deps, pid, HOST_EXIT_WAIT_MS)) { ended.push({ pid, protocol, panes, how: 'shut down' }); continue }
        why = 'it agreed to shut down but did not exit'
      }
    } else {
      why = reached.unreachable
    }
    ended.push({ pid, protocol, panes, ...await force(deps, recorded, why) })
  }
  return ended
}

const HOST_IMAGE = /(^|[\\/])harness-pty(\.exe)?$/i

/**
 * Whether [row]'s image is a harness-pty. macOS `ps -o comm=` cuts the image's path to 16 characters (measured
 * 2026-10-18: `/Users/<user>/`, `pty/target/relea`), so on Unix a comm that is the start of the program argv names
 * stands for it, and that program is checked instead. The program is everything before ` serve`, since `ps` quotes no
 * path with a space in it.
 */
function hostImage(row: HostRow, platform: NodeJS.Platform): boolean {
  if (HOST_IMAGE.test(row.executable)) return true
  if (platform === 'win32' || !row.executable) return false
  const text = row.args ?? ''
  const serve = text.search(/\sserve(\s|$)/)
  const program = row.nativeArgv?.[0] ?? (serve >= 0 ? text.slice(0, serve) : argvTokens(text)[0] ?? '')
  return HOST_IMAGE.test(program) && program.startsWith(row.executable)
}

/**
 * Whether [row] runs `serve --home` [home]. Windows paths compare without case, as Windows opens them. Unix `ps` joins
 * argv with spaces and quotes nothing, so a home with a space in it is looked for in the text as a whole, followed by
 * the next flag or the end.
 */
function servesHome(row: HostRow, home: string, platform: NodeJS.Platform): boolean {
  const paths = platform === 'win32' ? path.win32 : path.posix
  const same = (a: string, b: string) => {
    const [x, y] = [paths.resolve(a), paths.resolve(b)]
    return platform === 'win32' ? x.toLowerCase() === y.toLowerCase() : x === y
  }
  const argv = row.nativeArgv ?? argvTokens(row.args ?? '')
  const serve = argv.indexOf('serve')
  if (serve >= 0) {
    for (let at = argv.indexOf('--home', serve + 1); at >= 0; at = argv.indexOf('--home', at + 1)) {
      const value = argv[at + 1]
      // Tokens split from text: a word after the value that is not the next flag means the value was cut there
      // (`serve --home /x/pty old` is not the home /x/pty).
      const next = row.nativeArgv ? undefined : argv[at + 2]
      if (value !== undefined && same(value, home) && (next === undefined || next.startsWith('--'))) return true
    }
  }
  if (platform === 'win32' || row.nativeArgv || !/\s/.test(home)) return false
  const text = row.args ?? ''
  const serveAt = text.search(/(^|\s)serve(\s|$)/)
  if (serveAt < 0) return false
  return [home, paths.resolve(home)].some((wanted) => {
    const flag = ` --home ${wanted}`
    for (let at = text.indexOf(flag, serveAt); at >= 0; at = text.indexOf(flag, at + 1)) {
      const after = text.slice(at + flag.length)
      if (after === '' || after.startsWith(' --')) return true
    }
    return false
  })
}

async function force(deps: PtyHostsDeps, { discovery, written }: RecordedHost, why: string): Promise<Pick<PtyHostEnd, 'how' | 'detail'>> {
  const { pid } = discovery
  // One read: the row that proves the identity is the one whose start marker the kill checks.
  const row = (await deps.rows())?.find((candidate) => candidate.pid === pid)
  if (!row?.startMarker) return { how: 'left', detail: `${why}, and its start time could not be read` }
  if (!hostImage(row, deps.platform)) return { how: 'left', detail: `${why}, and pid ${pid} is not a harness-pty process` }
  // Exited since the top of the loop: it is not a later process to be judged.
  if (!deps.alive(pid)) return { how: 'gone' }
  // Fail closed: a pid is the recorded host only when its start is known to be no later than its record.
  if (written === null || startMarkerMs(row.startMarker) === null) return { how: 'left', detail: `${why}, and its record's time could not be read` }
  if (!startedNoLaterThan(row, written)) {
    return { how: 'left', detail: `${why}, and pid ${pid} started after its record was written, so it is another process` }
  }
  if (!servesHome(row, deps.home, deps.platform)) return { how: 'left', detail: `${why}, and pid ${pid} is not the host of ${deps.home}` }
  const outcome = await deps.terminate(pid, row.startMarker)
  if (outcome === 'mismatch') return { how: 'left', detail: `${why}; pid ${pid} changed while it was being ended` }
  if (outcome === 'gone') return { how: 'gone' }
  // TerminateProcess has ended it; SIGTERM only asks.
  if (deps.platform === 'win32' || await gone(deps, pid, HOST_EXIT_WAIT_MS)) return { how: 'ended' }
  return { how: 'left', detail: `${why}, and it outlived SIGTERM` }
}

function writtenAt(file: string): number | null {
  try {
    return statSync(file).mtimeMs
  } catch {
    return null
  }
}

/** This computer's hosts, in HARNESS_PTY_DIR. */
export function ptyHostsDeps(home: string = env.HARNESS_PTY_DIR): PtyHostsDeps {
  // The process table on every platform: Windows reads it from harness-pty, Unix from `ps` (with `lstart` markers).
  const rows = process.platform === 'win32' ? () => windowsProcessRows(null) : processRows
  const liveness: HostLiveness = { alive: pidAlive, rows }
  return {
    platform: process.platform,
    home,
    discover: () => {
      // Each record's time before the records: one rewritten in between is judged against the older time, which a
      // later host fails, so the error is on the side of leaving it. Keyed by instance: a legacy `p2` and any number
      // of versioned `p2-<tag>` hosts of one protocol each have their own record.
      const written = new Map(listDiscoveries(home).map((found) => [found.instance, writtenAt(path.join(home, 'run', discoveryFileName(found.instance) ?? ''))]))
      return listDiscoveries(home)
        .filter((discovery) => SUPPORTED_PTY_PROTOCOLS.includes(discovery.protocol))
        .map((discovery) => ({ discovery, written: written.get(discovery.instance) ?? null }))
    },
    reach: async (instance) => {
      const result = await reachPtyHost(home, instance, liveness)
      return 'client' in result ? { client: result.client } : { unreachable: 'incompatible' in result ? result.incompatible : result.unavailable }
    },
    alive: pidAlive,
    dead: (discovery) => discoveredHostDead(home, discovery, liveness),
    rows,
    terminate: process.platform === 'win32'
      ? (pid, marker) => terminateVerified(pid, marker)
      : (pid, marker) => terminateVerified(pid, marker, { rows: processRows, kill: (target) => { process.kill(target, 'SIGTERM') } }),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  }
}
