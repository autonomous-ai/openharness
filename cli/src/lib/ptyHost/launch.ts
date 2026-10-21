/**
 * Finding `harness-pty` and the host build it is (the target), finding hosts by their instance (their discovery files),
 * and starting one when there is none. In production harnessd keeps the host running (sub-project B); this is how the
 * daemon gets one without it, in development and tests.
 */
import { execFileSync, spawn } from 'node:child_process'
import { accessSync, constants, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { env } from '../../config/env.js'
import { scrubTerminalContext } from '../terminalEnvironment.js'
import { PtyHostClient, type PtyHostDiscovery } from './client.js'
import { discoveryFileName, hostInstanceName, instanceProtocol } from './instance.js'
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
/** How long `harness-pty version` may take. */
const VERSION_TIMEOUT_MS = 5_000

function runnable(file: string): boolean {
  try {
    accessSync(file, process.platform === 'win32' ? constants.F_OK : constants.X_OK)
    return true
  } catch {
    return false
  }
}

export const VERSION_DIR = /^\d+(\.\d+)*$/

/**
 * Orders two versions: their dotted numbers first, then a pre-release (`-dev.win1`) before its release, as semver
 * does, and build metadata (`+…`) not at all. A host's version is any build string (a dev build's is not a plain
 * number), so a part that is not a number counts as 0. The order is total: two versions that differ only in how they
 * are written are told apart by that, so readdir's order never picks.
 */
export function compareVersions(a: string, b: string): number {
  const va = versionParts(a)
  const vb = versionParts(b)
  for (let i = 0; i < Math.max(va.core.length, vb.core.length); i++) {
    const d = (va.core[i] ?? 0) - (vb.core[i] ?? 0)
    if (d !== 0) return d
  }
  if (va.pre !== vb.pre) {
    if (va.pre === null) return 1
    if (vb.pre === null) return -1
    return va.pre < vb.pre ? -1 : 1
  }
  // `1.0` and `1.0.0` are the same version; order them anyway so readdir's order cannot pick.
  return a.length - b.length || (a < b ? -1 : a > b ? 1 : 0)
}

function versionParts(version: string): { core: number[]; pre: string | null } {
  const plain = version.split('+')[0]
  const dash = plain.indexOf('-')
  const core = (dash < 0 ? plain : plain.slice(0, dash)).split('.').map((part) => Number(part) || 0)
  return { core, pre: dash < 0 ? null : plain.slice(dash + 1) }
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

/** `<home>/run/<instance's discovery file>`, or null for anything that is not an instance. */
function discoveryPath(home: string, instance: string): string | null {
  const name = discoveryFileName(instance)
  return name ? path.join(home, 'run', name) : null
}

/**
 * The discovery file named [name] in [home]'s run directory, or null when it is missing or not one. A file's own
 * `instance` and `protocol` must be well formed and agree with each other and with the file's name: a copy under
 * another name, or a file that names another instance, is not that instance's.
 */
function readDiscoveryFile(home: string, name: string): PtyHostDiscovery | null {
  try {
    const value = JSON.parse(readFileSync(path.join(home, 'run', name), 'utf8'))
    if (
      value && typeof value === 'object'
      && typeof value.instance === 'string'
      && discoveryFileName(value.instance) === name
      && value.protocol === instanceProtocol(value.instance)
      && typeof value.endpoint === 'string'
      && typeof value.pid === 'number'
      && typeof value.version === 'string'
      && typeof value.token === 'string'
    ) {
      const { protocol, instance, endpoint, pid, version, token } = value
      return { protocol, instance, endpoint, pid, version, token }
    }
  } catch {
    // Missing, or caught mid-way by a reader that is not atomic: the caller looks again.
  }
  return null
}

/** [instance]'s discovery file (a legacy `p<n>` from `pty-host-<n>.json`), or null when it is missing or not one. */
export function readInstanceDiscovery(home: string, instance: string): PtyHostDiscovery | null {
  const name = discoveryFileName(instance)
  return name ? readDiscoveryFile(home, name) : null
}

const DISCOVERY_FILE = /^pty-host-.+\.json$/

/**
 * Every host discovery file in [home]: legacy (`pty-host-<n>.json`) and versioned, of every protocol, supported or
 * not. Oldest first: by protocol, then by version (`compareVersions`).
 */
export function listDiscoveries(home: string): PtyHostDiscovery[] {
  let names: string[]
  try {
    names = readdirSync(path.join(home, 'run'))
  } catch {
    return []
  }
  return names
    .filter((name) => DISCOVERY_FILE.test(name))
    .flatMap((name) => readDiscoveryFile(home, name) ?? [])
    .sort((a, b) => a.protocol - b.protocol || compareVersions(a.version, b.version) || (a.instance < b.instance ? -1 : 1))
}

/** What `harness-pty version` says of its build. */
export interface PtyHostBinaryVersion { version: string; protocol: number; features: string[] }

/** `binaryVersion`'s, with whether the build is from before features (and so before versioned instances). */
type ReadVersion = PtyHostBinaryVersion & { legacy: boolean }

/** `binaryVersion`'s answers, by path: kept while the file's mtime is the same, so each build is run once. */
const versions = new Map<string, { mtimeMs: number; value: ReadVersion }>()

function readBinaryVersion(binary: string): ReadVersion | null {
  const key = path.resolve(binary)
  let mtimeMs: number
  try {
    mtimeMs = statSync(key).mtimeMs
  } catch {
    return null
  }
  const known = versions.get(key)
  if (known && known.mtimeMs === mtimeMs) return known.value
  let value: ReadVersion | null = null
  try {
    // Synchronous: once per build.
    const parsed = JSON.parse(runVersionCommand(binary).trim()) as Record<string, unknown> | null
    const features = parsed?.features
    if (
      parsed && typeof parsed === 'object'
      && typeof parsed.version === 'string' && parsed.version !== ''
      && Number.isSafeInteger(parsed.protocol) && (parsed.protocol as number) >= 1
      && (features === undefined || (Array.isArray(features) && features.every((name) => typeof name === 'string')))
    ) {
      value = {
        version: parsed.version, protocol: parsed.protocol as number,
        features: features === undefined ? [] : [...features as string[]], legacy: features === undefined,
      }
    }
  } catch {
    // Did not run, timed out, or said something else: no version. Asked again next time.
  }
  if (value) versions.set(key, { mtimeMs, value })
  return value
}

/**
 * How this CLI asks a PTY build what it is: `<binary> version`, an argument array so no shell reads the path, hidden
 * so no console flashes on Windows, within 5 s. One definition for `runVersionCommand` here (synchronous, the daemon's
 * `binaryVersion`) and the payload canary's asynchronous run (lib/windows/ptyPayload.ts `probeVersionLine`), which must
 * never block the updater's event loop.
 */
export const VERSION_COMMAND = {
  args: ['version'] as readonly string[],
  options: { encoding: 'utf8', timeout: VERSION_TIMEOUT_MS, windowsHide: true } as const,
}

/** What `<binary> version` prints, or a throw when it fails to run, exits non-zero or takes longer than 5 s. */
export function runVersionCommand(binary: string): string {
  return execFileSync(binary, [...VERSION_COMMAND.args], { ...VERSION_COMMAND.options, stdio: ['ignore', 'pipe', 'ignore'] })
}

/**
 * What [binary] says it is (`harness-pty version`: `{"version","protocol","features"}`), or null when it cannot be
 * run or says something else. A build from before features lists none: `[]`. Run with a 5 s timeout, hidden, and
 * cached by path and mtime.
 */
export function binaryVersion(binary: string): PtyHostBinaryVersion | null {
  const read = readBinaryVersion(binary)
  return read ? { version: read.version, protocol: read.protocol, features: [...read.features] } : null
}

/**
 * `previous` of `pty-pending.json` (lib/windows/ptyInstall.ts `PTY_PENDING`), or null with no marker. Read here rather
 * than imported: ptyInstall.ts imports this module.
 */
function probationPrevious(ptyRoot: string): string | null {
  try {
    const previous: unknown = JSON.parse(readFileSync(path.join(ptyRoot, 'pty-pending.json'), 'utf8'))?.previous
    return typeof previous === 'string' && previous !== '' ? previous : null
  } catch {
    return null
  }
}

/** The builds `targetHost` said it would not target, by path and version: said once each. */
const toldUnsupported = new Set<string>()

/** The host build new panes go to: the one this daemon would start. */
export interface PtyHostTarget {
  protocol: number
  version: string
  instance: string
  features: readonly string[]
  /** `installed`: the version is the one `current-pty` names (the binary is that folder's); `binary`: it said so. */
  source: 'installed' | 'binary'
}

/**
 * The target host: the build `ptyHostBinary()` resolves. Its version is the one `current-pty` names when the binary
 * is that folder's, else the binary's own (a dev build's `HARNESS_PTY_BIN`, the bundle's). Its protocol and features
 * are always the binary's (`binaryVersion`). Null when there is no binary or it cannot say what it is: the version,
 * or the protocol, is then unknown, and the caller does what it did before targets.
 *
 * The instance is the one the host will publish: named from the binary's own version (instance.rs names it so), and
 * `p<protocol>` for a build from before features, which predates versioned instances too.
 *
 * A build of a protocol outside `SUPPORTED_PTY_PROTOCOLS` is no target either (said once per binary): a paired host left
 * in `current-pty` without the CLI build that needs it (spec §5, the pairing rule), which `ensurePtyHost` would only
 * find incompatible. Unknown, the daemon takes the newest running host it speaks, as it did before targets.
 */
export function targetHost(options: PtyHostBinaryOptions = {}): PtyHostTarget | null {
  const binary = ptyHostBinary(options)
  if (!binary) return null
  const read = readBinaryVersion(binary)
  if (!read) return null
  if (!SUPPORTED_PTY_PROTOCOLS.includes(read.protocol)) {
    const key = `${path.resolve(binary)}\u0000${read.version}`
    if (!toldUnsupported.has(key)) {
      toldUnsupported.add(key)
      console.error(`[terminal] ptyhost: the host ${read.version} speaks protocol ${read.protocol}, which this daemon does not (it speaks ${SUPPORTED_PTY_PROTOCOLS.join(' and ')}): target unknown, the newest running host of protocol ${PTY_PROTOCOL} is used`)
    }
    return null
  }
  const runtimeDir = options.runtimeDir ?? env.ADAPTER_RUNTIME_DIR
  const current = currentPtyVersion(runtimeDir)
  const installed = current !== null && path.resolve(binary) === path.resolve(runtimeDir, 'pty', current, BINARY)
  return {
    protocol: read.protocol,
    version: installed ? current : read.version,
    instance: read.legacy ? `p${read.protocol}` : hostInstanceName(read.protocol, read.version),
    features: [...read.features],
    source: installed ? 'installed' : 'binary',
  }
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
  discovery: Pick<PtyHostDiscovery, 'instance' | 'pid'>,
  liveness: HostLiveness = DEFAULT_LIVENESS,
): Promise<boolean> {
  const file = discoveryPath(home, discovery.instance)
  // Not an instance: no file to judge it by, so no proof.
  if (!file) return false
  return recordedProcessDead(file, discovery.pid, liveness)
}

export type PtyHostUnavailable = { unavailable: string; code: 'PTY_HOST_UNAVAILABLE' }
export type EnsurePtyHostResult = { client: PtyHostClient } | PtyHostUnavailable | { incompatible: string }

export interface EnsurePtyHostOptions {
  /**
   * The host new panes go to (`targetHost`): only its instance is connected to, and the binary is started for it.
   * Null when the target is unknown: the newest running host of `PTY_PROTOCOL`, whatever its build, as before targets.
   */
  target: PtyHostTarget | null
  /** The binary to start; `null` means there is none. Defaults to `ptyHostBinary()`. */
  binary?: string | null
  /** How long a started host has to publish its discovery file. */
  waitMs?: number
  /** How a discovery file's host is proven dead before it is dialled (`discoveredHostDead`); its pid alone by default. */
  liveness?: HostLiveness
}

const unavailable = (reason: string): PtyHostUnavailable => ({ unavailable: reason, code: 'PTY_HOST_UNAVAILABLE' })

type Connected = { client: PtyHostClient } | { incompatible: string } | null

/**
 * The host [instance]'s discovery file names: a client, `{ incompatible }` when it answers but refuses this
 * daemon, or null when nothing answers there (or there is no file).
 */
async function connectInstance(home: string, instance: string, liveness: HostLiveness): Promise<Connected> {
  const discovery = readInstanceDiscovery(home, instance)
  if (!discovery) return null
  // A dead host's endpoint is never dialled: no host, so the caller starts one (a drain backend's judges it gone).
  if (await discoveredHostDead(home, discovery, liveness)) return null
  const result = await PtyHostClient.connect(discovery)
  if (result instanceof PtyHostClient) return { client: result }
  if (result === null) return null
  // A host that restarted between our read and our hello has a new token: read the file again.
  const again = readInstanceDiscovery(home, instance)
  if (again && (again.token !== discovery.token || again.endpoint !== discovery.endpoint)) {
    if (await discoveredHostDead(home, again, liveness)) return null
    const retried = await PtyHostClient.connect(again)
    if (retried instanceof PtyHostClient) return { client: retried }
    if (retried === null) return null
    return { incompatible: retried.incompatible }
  }
  return { incompatible: result.incompatible }
}

/** The hosts a start for [instance] (null: any build of `PTY_PROTOCOL`) waits for or finds, oldest first. */
function hostsFor(home: string, instance: string | null): PtyHostDiscovery[] {
  if (instance !== null) {
    const discovery = readInstanceDiscovery(home, instance)
    return discovery ? [discovery] : []
  }
  return listDiscoveries(home).filter((discovery) => discovery.protocol === PTY_PROTOCOL)
}

/**
 * [instance]'s host; with null, the newest host of `PTY_PROTOCOL` that answers, else the first refusal. A dead host's
 * endpoint is never dialled (`connectInstance`).
 */
async function connectExisting(home: string, instance: string | null, liveness: HostLiveness): Promise<Connected> {
  if (instance !== null) return connectInstance(home, instance, liveness)
  let refused: Connected = null
  for (const discovery of hostsFor(home, null).reverse()) {
    const result = await connectInstance(home, discovery.instance, liveness)
    if (result && 'client' in result) return result
    refused ??= result
  }
  return refused
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

/** One start per home and instance at a time in this process; concurrent callers share it. */
const starting = new Map<string, Promise<PtyHostUnavailable | null>>()

function startHost(home: string, instance: string | null, binary: string | null, waitMs: number, liveness: HostLiveness): Promise<PtyHostUnavailable | null> {
  const key = `${path.resolve(home)}\u0000${instance ?? ''}`
  let start = starting.get(key)
  if (!start) {
    start = spawnAndWait(home, instance, binary, waitMs, liveness).finally(() => starting.delete(key))
    starting.set(key, start)
  }
  return start
}

/**
 * Start `binary serve --home <home>` and wait for a discovery file of [instance] (null: of any build of
 * `PTY_PROTOCOL`) that was not there before, or names another pid.
 */
async function spawnAndWait(home: string, instance: string | null, binary: string | null, waitMs: number, liveness: HostLiveness): Promise<PtyHostUnavailable | null> {
  const seen = (discovery: PtyHostDiscovery) => `${discovery.instance}\u0000${discovery.pid}`
  const before = hostsFor(home, instance)
  const known = new Set(before.map(seen))
  // A caller that found no host may arrive just after another caller's start finished. Not a dead host's endpoint:
  // something else may have taken its name (`discoveredHostDead`).
  const live = (discovery: PtyHostDiscovery) => discoveredHostDead(home, discovery, liveness).then((dead) => !dead)
  const answering = async (discoveries: PtyHostDiscovery[]) => {
    for (const discovery of discoveries) if (await live(discovery) && await reachable(discovery.endpoint)) return true
    return false
  }
  if (await answering(before)) return null
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
    const now = hostsFor(home, instance)
    if (now.some((discovery) => !known.has(seen(discovery)))) return null
    if (exitedCleanly && await answering(now)) return null
  }
  return unavailable(`harness-pty did not publish its discovery file within ${waitMs} ms`)
}

/**
 * A client of the host serving `home` that new panes go to, starting the host first when nothing answers at the
 * endpoint its discovery file names. With a target, that is the target's instance alone: a host of another build is
 * never connected to, though it runs. Without one (null), the newest running host of `PTY_PROTOCOL`. `incompatible`
 * is a host that answers and refuses this daemon; starting another would not replace it.
 */
export async function ensurePtyHost(home: string, options: EnsurePtyHostOptions): Promise<EnsurePtyHostResult> {
  const liveness = options.liveness ?? DEFAULT_LIVENESS
  const instance = options.target?.instance ?? null
  const existing = await connectExisting(home, instance, liveness)
  if (existing) return existing
  const binary = options.binary !== undefined ? options.binary : ptyHostBinary()
  const failed = await startHost(home, instance, binary, options.waitMs ?? START_WAIT_MS, liveness)
  if (failed) return failed
  // The host this start found or made published a discovery file, but nothing answers where it says.
  return (await connectExisting(home, instance, liveness)) ?? unavailable('no harness-pty answers at the endpoint its discovery file names')
}

/**
 * `reachPtyHost`'s: nothing answered. What the discovery file named, for the caller to judge whether that host is gone
 * (a drain backend checks the process table, ptyHostBackend.ts): `pid` from a readable file, else null; `missing`
 * when there is no file at all, which a read that failed (caught mid-write, unreadable) is not.
 */
export type PtyHostUnreached = PtyHostUnavailable & { pid: number | null; missing: boolean }
export type ReachPtyHostResult = { client: PtyHostClient } | { incompatible: string } | PtyHostUnreached

/**
 * A client of [instance]'s host serving `home`, never starting one: how a drain backend reaches a host that new panes
 * no longer go to (ptyHost/drain.ts). Whether a host that does not answer has gone is not decided here: a file that
 * could not be read, or a pid that runs, is no proof either way.
 */
export async function reachPtyHost(home: string, instance: string, liveness: HostLiveness = DEFAULT_LIVENESS): Promise<ReachPtyHostResult> {
  const name = discoveryFileName(instance)
  // Not an instance: there is no file it could have.
  if (!name) return { ...unavailable(`${JSON.stringify(instance)} is not a pty host instance`), pid: null, missing: true }
  const discovery = readInstanceDiscovery(home, instance)
  if (!discovery) {
    const missing = !existsSync(path.join(home, 'run', name))
    return { ...unavailable(missing ? `there is no ${name}` : `${name} cannot be read`), pid: null, missing }
  }
  const existing = await connectInstance(home, instance, liveness)
  if (existing) return existing
  return { ...unavailable(`nothing answers for the ${instance} host (pid ${discovery.pid})`), pid: discovery.pid, missing: false }
}

/**
 * Take down what [instance]'s host that has exited left published: its discovery file, and its socket file on
 * Unix. Only while the file still names [pid] and that process is gone: a host that took its place keeps its own.
 * A host that shut down (protocol 2 on) has removed them itself; a protocol 1 host ended by its pid leaves them.
 */
export function forgetExitedHost(home: string, instance: string, pid: number): void {
  const discovery = readInstanceDiscovery(home, instance)
  const file = discoveryPath(home, instance)
  if (!discovery || !file || discovery.pid !== pid || pidAlive(pid)) return
  rmSync(file, { force: true })
  // The host's lock and pane-id counter sit beside its discovery file under the same name. The host cannot delete the
  // lock itself: removing it before the lock is released lets a host starting meanwhile lock an unlinked file while
  // another makes a new one. Here the host is proven gone, so no one holds either; one a scanner still holds stays
  // for the next time.
  for (const ext of ['lock', 'panes']) {
    try { rmSync(file.replace(/\.json$/, `.${ext}`), { force: true }) } catch { /* held for now */ }
  }
  if (process.platform !== 'win32' && path.isAbsolute(discovery.endpoint)
    && path.dirname(discovery.endpoint) === path.join(home, 'run')) rmSync(discovery.endpoint, { force: true })
}

/**
 * Delete the `<runtime>/pty/<version>/` directories no host runs from any more, after a drained host has gone: every
 * version older than the one `current-pty` names (the installed CLI's) whose version no running host of [home] has
 * (any instance's discovery file, legacy or versioned: its `version`, its pid alive). The current one, newer ones (another install's, perhaps not
 * finished), the one a version on probation would roll back to (`pty-pending.json`'s `previous`), and anything that
 * is not a version directory stay. Nothing goes without a `current-pty`: with no
 * installed CLI's word, no version is known to be old. A directory that cannot be removed (a running .exe on
 * Windows, of some other home's host) stays for the next time. Returns the versions removed.
 */
export function removeUnusedPtyVersions(home: string, runtimeDir: string = env.ADAPTER_RUNTIME_DIR): string[] {
  const current = currentPtyVersion(runtimeDir)
  if (!current) return []
  const root = path.join(runtimeDir, 'pty')
  const running = new Set(listDiscoveries(home).filter((host) => pidAlive(host.pid)).map((host) => host.version))
  // While a version is on probation, the one it replaced is what a rollback puts back, host or not.
  const rollback = probationPrevious(root)
  if (rollback) running.add(rollback)
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
