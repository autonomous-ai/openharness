/**
 * `harness uninstall`'s end of the Harness terminal host (pty/, A): the panes the daemon could not stop as harnesses
 * (a terminal, an agent whose stop was refused), then the host. Each pane is killed with the op the daemon uses, which
 * gives it its grace, then the host is asked to shut down, which it does only with no pane left. A host that does not
 * answer, or speaks a protocol without `shutdown`, is ended by its pid: on Windows only after the process table says
 * that pid is a harness-pty with a start marker, with B3's identity-checked TerminateProcess, never a tree kill.
 */
import { env } from '../../config/env.js'
import type { PtyHostClient, PtyHostDiscovery } from '../ptyHost/client.js'
import { discoverHosts, discoveredHostDead, pidAlive, reachPtyHost, type HostLiveness } from '../ptyHost/launch.js'
import { SHUTDOWN_PROTOCOL } from '../ptyHost/protocol.js'
import type { ProcessRow } from '../processTable.js'
import { windowsProcessRows } from '../windows/processTable.js'
import { terminateVerified } from '../windows/terminate.js'

/** As long as `harness stop` gives the daemon (daemonStop.ts STOP_GRACE_MS). */
export const PANE_GRACE_MS = 3_000
export const HOST_EXIT_WAIT_MS = 5_000

export type HostClient = Pick<PtyHostClient, 'call' | 'close' | 'protocol' | 'pid'>
type HostRow = Pick<ProcessRow, 'pid' | 'executable' | 'startMarker'> & Partial<ProcessRow>

export interface PtyHostsDeps {
  platform: NodeJS.Platform
  discover(): PtyHostDiscovery[]
  reach(protocol: number): Promise<{ client: HostClient } | { unreachable: string }>
  alive(pid: number): boolean
  /** A's proof that the discovery file's host has gone (its pid now belongs to a later process). */
  dead(discovery: PtyHostDiscovery): Promise<boolean>
  rows(): Promise<readonly HostRow[] | null>
  terminate(pid: number, startMarker: string): Promise<'ended' | 'gone' | 'mismatch'>
  signal(pid: number): void
  sleep(ms: number): Promise<void>
}

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
  for (const discovery of deps.discover()) {
    const { pid, protocol } = discovery
    if (!deps.alive(pid) || await deps.dead(discovery)) { ended.push({ pid, protocol, panes: 0, how: 'gone' }); continue }
    let panes = 0
    let why = 'it did not exit'
    const reached = await deps.reach(protocol)
    if ('client' in reached) {
      const client = reached.client
      try {
        for (let round = 0; round < 2; round++) {
          const inventory = await client.call({ op: 'inventory' })
          const rows = inventory.state === 'ok' ? inventory.value.panes : []
          for (const row of rows) if ((await client.call({ op: 'kill', pane: row.pane, graceMs: PANE_GRACE_MS })).state === 'ok') panes++
          if (rows.length) await deps.sleep(PANE_GRACE_MS)
          if (client.protocol < SHUTDOWN_PROTOCOL) break
          // A pane made between the inventory and the shutdown is refused, and gets one more round.
          if ((await client.call({ op: 'shutdown' })).state === 'ok') break
        }
      } finally {
        client.close()
      }
      if (await gone(deps, pid, HOST_EXIT_WAIT_MS)) { ended.push({ pid, protocol, panes, how: 'shut down' }); continue }
      if (client.protocol < SHUTDOWN_PROTOCOL) why = `its protocol (${client.protocol}) has no shutdown`
    } else {
      why = reached.unreachable
    }
    ended.push({ pid, protocol, panes, ...await force(deps, pid, why) })
  }
  return ended
}

async function force(deps: PtyHostsDeps, pid: number, why: string): Promise<Pick<PtyHostEnd, 'how' | 'detail'>> {
  if (deps.platform === 'win32') {
    const row = (await deps.rows())?.find((candidate) => candidate.pid === pid)
    if (!row?.startMarker) return { how: 'left', detail: `${why}, and its start time could not be read` }
    if (!/(^|[\\/])harness-pty(\.exe)?$/i.test(row.executable)) return { how: 'left', detail: `${why}, and pid ${pid} is not a harness-pty process` }
    const outcome = await deps.terminate(pid, row.startMarker)
    return outcome === 'mismatch' ? { how: 'left', detail: `${why}; pid ${pid} changed while it was being ended` } : { how: outcome === 'gone' ? 'gone' : 'ended' }
  }
  deps.signal(pid)
  return await gone(deps, pid, HOST_EXIT_WAIT_MS) ? { how: 'ended' } : { how: 'left', detail: `${why}, and it outlived SIGTERM` }
}

/** This computer's hosts, in HARNESS_PTY_DIR. */
export function ptyHostsDeps(home: string = env.HARNESS_PTY_DIR): PtyHostsDeps {
  const rows = () => windowsProcessRows(null)
  const liveness: HostLiveness = process.platform === 'win32' ? { alive: pidAlive, rows } : { alive: pidAlive }
  return {
    platform: process.platform,
    discover: () => discoverHosts(home),
    reach: async (protocol) => {
      const result = await reachPtyHost(home, protocol, liveness)
      return 'client' in result ? { client: result.client } : { unreachable: 'incompatible' in result ? result.incompatible : result.unavailable }
    },
    alive: pidAlive,
    dead: (discovery) => discoveredHostDead(home, discovery, liveness),
    rows,
    terminate: terminateVerified,
    signal: (pid) => { try { process.kill(pid, 'SIGTERM') } catch { /* gone */ } },
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  }
}
