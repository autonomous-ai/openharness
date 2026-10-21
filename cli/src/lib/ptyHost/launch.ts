/**
 * Finding `harness-pty`, finding the host it started (its discovery file), and starting one when
 * there is none. In production harnessd keeps the host running (sub-project B); this is how the
 * daemon gets one without it, in development and tests.
 */
import { spawn } from 'node:child_process'
import { accessSync, constants, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { env } from '../../config/env.js'
import { scrubTerminalContext } from '../terminalEnvironment.js'
import { PtyHostClient, type PtyHostDiscovery } from './client.js'
import { PTY_PROTOCOL, SUPPORTED_PTY_PROTOCOLS } from './protocol.js'
import { pidAlive, recordedProcessDead, startMarkerMs, type HostLiveness, type HostProcessRow } from '../processProof.js'

// Moved to ../processProof.ts with the daemon's own record; still exported from here for the pty host's callers.
export { pidAlive, startMarkerMs, type HostLiveness, type HostProcessRow }

const BINARY = process.platform === 'win32' ? 'harness-pty.exe' : 'harness-pty'
/** How long a host we started has to publish its discovery file. */
const START_WAIT_MS = 5_000
const POLL_MS = 25
/** How long a connection may take to be accepted: as long as `PtyHostClient.connect` gives a hello. */
const CONNECT_TIMEOUT_MS = 5_000

function runnable(file: string): boolean {
  try {
    accessSync(file, process.platform === 'win32' ? constants.F_OK : constants.X_OK)
    return true
  } catch {
    return false
  }
}

const VERSION_DIR = /^\d+(\.\d+)*$/

export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return d
  }
  // `1.0` and `1.0.0` are the same version; order them anyway so readdir's order cannot pick.
  return a.length - b.length
}

export interface PtyHostBinaryOptions {
  env?: NodeJS.ProcessEnv
  runtimeDir?: string
  /** The bundle's own directory (`dist/` in a release); the binary is looked for in its `pty/`. */
  besideDir?: string
}

/**
 * `<runtime>/pty/current-pty`: the name of the `<runtime>/pty/<version>/` directory whose host the installed CLI
 * ships, as `current-grid` pins grid (gridBinary.ts). The installer writes it (sub-project B); this reads it. Only a
 * version name is taken, so the pointer can never name a file outside `<runtime>/pty/`.
 */
export function currentPtyVersion(runtimeDir: string = env.ADAPTER_RUNTIME_DIR): string | null {
  try {
    const recorded = readFileSync(path.join(runtimeDir, 'pty', 'current-pty'), 'utf8').trim()
    return VERSION_DIR.test(recorded) ? recorded : null
  } catch {
    return null
  }
}

/**
 * The `harness-pty` to start, or null when there is none:
 * 1. `HARNESS_PTY_BIN`, as it is (a wrong override should fail loudly, not fall back);
 * 2. `<runtime>/pty/<version>/harness-pty[.exe]` for the version `current-pty` names. Binaries install per version
 *    because Windows cannot overwrite a running .exe (spec §4, host upgrade); older ones stay for the hosts still
 *    draining on them. Pinned, not the newest directory there: a newer one may be another install's, of another
 *    protocol, or one that has not finished (Task 12's review);
 * 3. in `pty/` beside the bundle, where `build-bundle.mjs` puts it with its ConPTY payload for local Windows testing
 *    (scripts/lib/ptyPayload.mjs).
 */
export function ptyHostBinary(options: PtyHostBinaryOptions = {}): string | null {
  const override = (options.env ?? process.env).HARNESS_PTY_BIN?.trim()
  if (override) return override
  const runtimeDir = options.runtimeDir ?? env.ADAPTER_RUNTIME_DIR
  const version = currentPtyVersion(runtimeDir)
  if (version) {
    const file = path.join(runtimeDir, 'pty', version, BINARY)
    if (runnable(file)) return file
  }
  const beside = path.join(options.besideDir ?? path.dirname(fileURLToPath(import.meta.url)), 'pty', BINARY)
  return runnable(beside) ? beside : null
}

/** `<home>/run/pty-host-<protocol>.json`, or null when it is missing or not a discovery file. */
export function readDiscovery(home: string, protocol: number): PtyHostDiscovery | null {
  try {
    const value = JSON.parse(readFileSync(path.join(home, 'run', `pty-host-${protocol}.json`), 'utf8'))
    if (
      value && typeof value === 'object'
      && value.protocol === protocol
      && typeof value.instance === 'string'
      && typeof value.endpoint === 'string'
      && typeof value.pid === 'number'
      && typeof value.version === 'string'
      && typeof value.token === 'string'
    ) {
      const { instance, endpoint, pid, version, token } = value
      return { protocol, instance, endpoint, pid, version, token }
    }
  } catch {
    // Missing, or caught mid-way by a reader that is not atomic: the caller looks again.
  }
  return null
}

/** Every supported protocol's discovery file in [home], oldest protocol first (SUPPORTED_PTY_PROTOCOLS). */
export function discoverHosts(home: string): PtyHostDiscovery[] {
  return SUPPORTED_PTY_PROTOCOLS.flatMap((protocol) => readDiscovery(home, protocol) ?? [])
}

const DEFAULT_LIVENESS: HostLiveness = { alive: (pid) => pidAlive(pid) }

/**
 * Whether the host [discovery] names is proven dead, so nothing should dial its endpoint: a Windows host that died
 * leaves its file naming a pipe that any user can see in `\\.\pipe\` and create once the host's last instance is
 * gone, and dialling it hands the hello (and the daemon's identity, libuv sets no SQOS) to whoever did. Proof: the
 * pid runs no process; or the process table has no such pid; or the process with it started after the discovery
 * file was written (the pid was given to another process since). No proof (a table that cannot be read, a file that
 * cannot be stat'ed) is not death: the endpoint is dialled as before, and a hello that fails there stays an error.
 */
export async function discoveredHostDead(
  home: string,
  discovery: Pick<PtyHostDiscovery, 'protocol' | 'pid'>,
  liveness: HostLiveness = DEFAULT_LIVENESS,
): Promise<boolean> {
  return recordedProcessDead(path.join(home, 'run', `pty-host-${discovery.protocol}.json`), discovery.pid, liveness)
}

export type PtyHostUnavailable = { unavailable: string; code: 'PTY_HOST_UNAVAILABLE' }
export type EnsurePtyHostResult = { client: PtyHostClient } | PtyHostUnavailable | { incompatible: string }

export interface EnsurePtyHostOptions {
  /** The binary to start; `null` means there is none. Defaults to `ptyHostBinary()`. */
  binary?: string | null
  /** How long a started host has to publish its discovery file. */
  waitMs?: number
  /** How a discovery file's host is proven dead before it is dialled (`discoveredHostDead`); its pid alone by default. */
  liveness?: HostLiveness
}

const unavailable = (reason: string): PtyHostUnavailable => ({ unavailable: reason, code: 'PTY_HOST_UNAVAILABLE' })

/**
 * The host the discovery file names: a client, `{ incompatible }` when it answers but refuses this
 * daemon, or null when nothing answers there (or there is no file).
 */
async function connectExisting(
  home: string,
  protocol = PTY_PROTOCOL,
  liveness: HostLiveness = DEFAULT_LIVENESS,
): Promise<{ client: PtyHostClient } | { incompatible: string } | null> {
  const discovery = readDiscovery(home, protocol)
  if (!discovery) return null
  // A dead host's endpoint is never dialled: no host, so the caller starts one (a drain backend's judges it gone).
  if (await discoveredHostDead(home, discovery, liveness)) return null
  const result = await PtyHostClient.connect(discovery)
  if (result instanceof PtyHostClient) return { client: result }
  if (result === null) return null
  // A host that restarted between our read and our hello has a new token: read the file again.
  const again = readDiscovery(home, protocol)
  if (again && (again.token !== discovery.token || again.endpoint !== discovery.endpoint)) {
    if (await discoveredHostDead(home, again, liveness)) return null
    const retried = await PtyHostClient.connect(again)
    if (retried instanceof PtyHostClient) return { client: retried }
    if (retried === null) return null
    return { incompatible: retried.incompatible }
  }
  return { incompatible: result.incompatible }
}

/**
 * Whether something accepts a connection at `endpoint` within `timeoutMs` (the hello's own limit); it is closed
 * without a hello. A connection never accepted (a stopped host's full backlog) counts as nothing there, and must not
 * hold the shared start for this home.
 */
export function reachable(endpoint: string, timeoutMs = CONNECT_TIMEOUT_MS): Promise<boolean> {
  return new Promise(resolve => {
    const socket = net.connect(endpoint)
    const finish = (accepted: boolean) => {
      clearTimeout(timer)
      socket.destroy()
      resolve(accepted)
    }
    const timer = setTimeout(() => finish(false), timeoutMs)
    socket.once('connect', () => finish(true))
    socket.once('error', () => finish(false))
  })
}

/** One start per home at a time in this process; concurrent callers share it. */
const starting = new Map<string, Promise<PtyHostUnavailable | null>>()

function startHost(home: string, binary: string | null, waitMs: number, liveness: HostLiveness): Promise<PtyHostUnavailable | null> {
  const key = path.resolve(home)
  let start = starting.get(key)
  if (!start) {
    start = spawnAndWait(home, binary, waitMs, liveness).finally(() => starting.delete(key))
    starting.set(key, start)
  }
  return start
}

/** Start `binary serve --home <home>` and wait for a discovery file naming another pid. */
async function spawnAndWait(home: string, binary: string | null, waitMs: number, liveness: HostLiveness): Promise<PtyHostUnavailable | null> {
  const before = readDiscovery(home, PTY_PROTOCOL)
  // A caller that found no host may arrive just after another caller's start finished. Not a dead host's endpoint:
  // something else may have taken its name (`discoveredHostDead`).
  const live = (discovery: PtyHostDiscovery) => discoveredHostDead(home, discovery, liveness).then((dead) => !dead)
  if (before && await live(before) && await reachable(before.endpoint)) return null
  if (!binary) return unavailable('harness-pty is not installed')
  let failed: string | null = null
  let exitedCleanly = false
  try {
    // Detached so the host outlives this daemon: panes must survive a daemon restart, as tmux's
    // do. On Windows the host also breaks away from the daemon's job by re-executing itself.
    // Without the daemon's own tmux identity (`TMUX`, `TMUX_PANE`), which a daemon started from a tmux pane has:
    // every pane the host spawns inherits its environment, and would read as that tmux pane's to a hook or a shell.
    // In the home, not the daemon's directory: a running program's directory cannot be removed on Windows, and the
    // daemon's may be an old install's. On the first start of a home (a fresh HARNESS_PTY_DIR) it is made first.
    mkdirSync(home, { recursive: true, mode: 0o700 })
    const child = spawn(binary, ['serve', '--home', home], {
      cwd: home, detached: true, windowsHide: true, stdio: 'ignore', env: scrubTerminalContext({ ...process.env }),
    })
    child.once('error', err => { failed ??= `could not start ${binary}: ${err.message}` })
    child.once('exit', (code, signal) => {
      // 0 is a host that found another one already serving this home.
      if (code === 0) exitedCleanly = true
      else failed ??= `${binary} exited with ${code === null ? `signal ${signal}` : `code ${code}`}`
    })
    child.unref()
  } catch (err) {
    return unavailable(`could not start ${binary}: ${(err as Error).message}`)
  }
  const deadline = Date.now() + waitMs
  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, POLL_MS))
    if (failed) return unavailable(failed)
    const now = readDiscovery(home, PTY_PROTOCOL)
    if (now && now.pid !== before?.pid) return null
    if (exitedCleanly && now && await live(now) && await reachable(now.endpoint)) return null
  }
  return unavailable(`harness-pty did not publish its discovery file within ${waitMs} ms`)
}

/**
 * A client of the host serving `home`, starting the host first when nothing answers at the
 * endpoint its discovery file names. `incompatible` is a host that answers and refuses this
 * daemon; starting another would not replace it.
 */
export async function ensurePtyHost(home: string, options: EnsurePtyHostOptions = {}): Promise<EnsurePtyHostResult> {
  const liveness = options.liveness ?? DEFAULT_LIVENESS
  const existing = await connectExisting(home, PTY_PROTOCOL, liveness)
  if (existing) return existing
  const binary = options.binary !== undefined ? options.binary : ptyHostBinary()
  const failed = await startHost(home, binary, options.waitMs ?? START_WAIT_MS, liveness)
  if (failed) return failed
  // The host this start found or made published a discovery file, but nothing answers where it says.
  return (await connectExisting(home, PTY_PROTOCOL, liveness)) ?? unavailable('no harness-pty answers at the endpoint its discovery file names')
}

/**
 * `reachPtyHost`'s: nothing answered. What the discovery file named, for the caller to judge whether that host is gone
 * (a drain backend checks the process table, ptyHostBackend.ts): `pid` from a readable file, else null; `missing`
 * when there is no file at all, which a read that failed (caught mid-write, unreadable) is not.
 */
export type PtyHostUnreached = PtyHostUnavailable & { pid: number | null; missing: boolean }
export type ReachPtyHostResult = { client: PtyHostClient } | { incompatible: string } | PtyHostUnreached

/**
 * A client of the [protocol] host serving `home`, never starting one: how a drain backend reaches a host of the
 * protocol before this daemon's (ptyHost/drain.ts). Whether a host that does not answer has gone is not decided
 * here: a file that could not be read, or a pid that runs, is no proof either way.
 */
export async function reachPtyHost(home: string, protocol: number, liveness: HostLiveness = DEFAULT_LIVENESS): Promise<ReachPtyHostResult> {
  const file = path.join(home, 'run', `pty-host-${protocol}.json`)
  const discovery = readDiscovery(home, protocol)
  if (!discovery) {
    const missing = !existsSync(file)
    return { ...unavailable(missing ? `there is no pty-host-${protocol}.json` : `pty-host-${protocol}.json cannot be read`), pid: null, missing }
  }
  const existing = await connectExisting(home, protocol, liveness)
  if (existing) return existing
  return { ...unavailable(`nothing answers for the protocol ${protocol} host (pid ${discovery.pid})`), pid: discovery.pid, missing: false }
}

/**
 * Take down what a host of [protocol] that has exited left published: its discovery file, and its socket file on
 * Unix. Only while the file still names [pid] and that process is gone: a host that took its place keeps its own.
 * A host that shut down (protocol 2 on) has removed them itself; a protocol 1 host ended by its pid leaves them.
 */
export function forgetExitedHost(home: string, protocol: number, pid: number): void {
  const discovery = readDiscovery(home, protocol)
  if (!discovery || discovery.pid !== pid || pidAlive(pid)) return
  rmSync(path.join(home, 'run', `pty-host-${protocol}.json`), { force: true })
  if (process.platform !== 'win32' && path.isAbsolute(discovery.endpoint)
    && path.dirname(discovery.endpoint) === path.join(home, 'run')) rmSync(discovery.endpoint, { force: true })
}

/**
 * Delete the `<runtime>/pty/<version>/` directories no host runs from any more, after a drained host has gone: every
 * version older than the one `current-pty` names (the installed CLI's) whose version no running host of [home] has
 * (its discovery file's `version`, its pid alive). The current one, newer ones (another install's, perhaps not
 * finished), and anything that is not a version directory stay. Nothing goes without a `current-pty`: with no
 * installed CLI's word, no version is known to be old. A directory that cannot be removed (a running .exe on
 * Windows, of some other home's host) stays for the next time. Returns the versions removed.
 */
export function removeUnusedPtyVersions(home: string, runtimeDir: string = env.ADAPTER_RUNTIME_DIR): string[] {
  const current = currentPtyVersion(runtimeDir)
  if (!current) return []
  const root = path.join(runtimeDir, 'pty')
  const running = new Set(discoverHosts(home).filter((host) => pidAlive(host.pid)).map((host) => host.version))
  let names: string[]
  try {
    names = readdirSync(root)
  } catch {
    return []
  }
  const removed: string[] = []
  for (const name of names) {
    if (!VERSION_DIR.test(name) || compareVersions(name, current) >= 0 || running.has(name)) continue
    const dir = path.join(root, name)
    try {
      if (!statSync(dir).isDirectory()) continue
      rmSync(dir, { recursive: true, force: true })
      removed.push(name)
    } catch (error) {
      console.error(`[terminal] ptyhost: could not remove ${dir}: ${(error as Error).message}`)
    }
  }
  return removed
}
