/**
 * Delivery of a promoted PTY payload (six files in one zip): decide whether one is wanted, download and
 * verify it, unpack it beside the live install and prove it runs: each binary says its version, and the host serves
 * one pane (`serveCanary`). Nothing here calls a Windows API, so it is tested on every OS; only the default unzip tool
 * and the canary pane's command differ by platform.
 */
import { execFile, spawn, type ChildProcess } from 'child_process'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { PtyHostClient } from '../ptyHost/client.js'
import { hostInstanceName } from '../ptyHost/instance.js'
import { VERSION_COMMAND, readInstanceDiscovery } from '../ptyHost/launch.js'
import { PTY_PROTOCOL, SHUTDOWN_PROTOCOL, SUPPORTED_PTY_PROTOCOLS } from '../ptyHost/protocol.js'
import { windowsProcessRows } from './processTable.js'
import { scrubTerminalContext } from '../terminalEnvironment.js'
import {
  DigestMismatchError, MANIFEST_LIMITS, downloadVerified, fetchWithin, isLocalDevBuild, semverGt,
  type FileRef, type TransferLimits,
} from '../selfUpdate.js'

/** The files a payload carries, and the only ones it may carry. */
export const PTY_PAYLOAD_FILES: readonly string[] = [
  'harness-pty.exe', 'harness-launch.exe', 'harness.exe', 'conpty.dll', 'OpenConsole.exe', 'harness-serial.exe',
]

/** Each canary run must answer within this; a hung binary must not hold the updater. */
const CANARY_TIMEOUT_MS = 5_000
/**
 * The serve canary's work (`serveCanary`): its start and discovery file, the hello, one pane's create and exit, and the
 * shutdown. With its cleanup (`SERVE_CANARY_CLEANUP_MS`) at most 20 s, under the updater's 30 s heartbeat timeout
 * (harnessd/services.ts), though the canary is asynchronous and the heartbeat goes on beside it.
 */
export const SERVE_CANARY_TIMEOUT_MS = 10_000
/** Cleanup, step 1: how long the host gets to end itself on `shutdown`, so it closes its consoles as it exits. */
const SERVE_CANARY_ASK_MS = 2_000
/** Cleanup, step 2: how long a killed host gets to exit before its temporary home is removed: on Windows a file a process
 *  still holds, or a folder that is a process's working directory, cannot be removed. */
const SERVE_CANARY_EXIT_WAIT_MS = 2_000
/** Cleanup, step 3 (Windows): how long a console process the host started (OpenConsole.exe) gets to follow the host
 *  out before it is ended; then the same again, after the ending, to see it gone. */
const SERVE_CANARY_IMAGES_WAIT_MS = 3_000
const SERVE_CANARY_IMAGES_ENDED_MS = 1_000
/** The cleanup's whole bound: ask 2 s + exit wait 2 s + images 3 s + 1 s, then the removal's retries (`removeCanaryHome`, 2 s). */
const SERVE_CANARY_CLEANUP_MS = 10_000
/** The serve canary from start to cleanup: what `preparePtyPayload` waits for it at most. */
export const SERVE_CANARY_BOUND_MS = SERVE_CANARY_TIMEOUT_MS + SERVE_CANARY_CLEANUP_MS
/** The canary's temporary homes: `<temporary folder>/harness-pty-canary-*`. */
const CANARY_HOME_PREFIX = 'harness-pty-canary-'
/** A canary home this old is left over from one whose removal failed (`sweepCanaryHomes`): no canary runs this long. */
export const CANARY_HOME_STALE_MS = 10 * 60_000

/** Where canary homes are made: the OS's temporary folder; off Windows (the tests) `/tmp`, as the host's endpoint is a
 *  Unix socket in the home, whose path must fit in about 100 bytes, and a macOS temporary folder alone takes half. */
export function canaryTempRoot(): string {
  return process.platform === 'win32' ? tmpdir() : '/tmp'
}

/** Remove a canary home, retrying while Windows still reports it held (a process that has just exited). */
function removeCanaryHome(dir: string): void {
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
}

/**
 * Remove the canary homes in [root] older than [maxAgeMs]: those whose removal failed (a file still held as the canary
 * ended), left for this sweep, which the updater runs as it starts (./ptyUpdate.ts `sweepPtyLeftovers`). A fresh one may
 * be a canary running now, and stays; so does one that still cannot be removed. Returns how many were removed.
 */
export function sweepCanaryHomes(root: string = canaryTempRoot(), maxAgeMs: number = CANARY_HOME_STALE_MS, now: number = Date.now()): number {
  let names: string[]
  try { names = readdirSync(root) } catch { return 0 }
  let removed = 0
  for (const name of names) {
    if (!name.startsWith(CANARY_HOME_PREFIX)) continue
    const dir = join(root, name)
    try {
      const info = statSync(dir)
      if (!info.isDirectory() || now - info.mtimeMs < maxAgeMs) continue
      removeCanaryHome(dir)
      removed++
    } catch { /* held still, or gone meanwhile: the next sweep's */ }
  }
  return removed
}

export interface PtyEntry { version: string; url: string; sha256: string; size: number }

/** The payload manifest sits beside the CLI one, so both follow the same override of the update URL. */
export function ptyManifestUrl(cliManifestUrl: string): string {
  const tail = 'cli/metadata.json'
  if (!cliManifestUrl.endsWith(`/${tail}`)) throw new Error(`not a CLI manifest url: ${cliManifestUrl}`)
  return `${cliManifestUrl.slice(0, -tail.length)}pty/metadata.json`
}

export function ptyPlatformKey(arch: string = process.arch): 'win32-x64' | 'win32-arm64' | null {
  if (arch === 'x64') return 'win32-x64'
  if (arch === 'arm64') return 'win32-arm64'
  return null
}

/** Fetch the manifest `{ "pty": { "<platform key>": entry } }` and return this platform's entry, or null
 *  when the response is not 2xx, the JSON is malformed, or the entry is absent or invalid: an https url, a
 *  64-digit sha256 hex digest and a positive integer size. */
export async function fetchPtyEntry(url: string, key: string, limits: TransferLimits = MANIFEST_LIMITS): Promise<PtyEntry | null> {
  const res = await fetchWithin(url, limits)
  if (!res.ok) return null
  let json: unknown
  try { json = JSON.parse(res.body.toString('utf8')) } catch { return null }
  const platforms = (json as { pty?: unknown } | null)?.pty
  if (!platforms || typeof platforms !== 'object') return null
  const e = (platforms as Record<string, unknown>)[key] as Partial<PtyEntry> | undefined
  if (!e || typeof e.version !== 'string' || !e.version) return null
  if (typeof e.url !== 'string' || !/^https:\/\//.test(e.url)) return null
  if (typeof e.sha256 !== 'string' || !/^[0-9a-fA-F]{64}$/.test(e.sha256)) return null
  if (typeof e.size !== 'number' || !Number.isInteger(e.size) || e.size <= 0) return null
  return { version: e.version, url: e.url, sha256: e.sha256, size: e.size }
}

/** Only over an installed host: with no `current-pty` there is no version for probation to roll back to, and the
 *  first host is install.ps1's to put in. A dev CLI never updates, as for the CLI itself. */
export function ptyUpdateWanted(entry: PtyEntry, installed: { pty: string | null; cli: string }, rejected: readonly string[]): boolean {
  if (isLocalDevBuild(installed.cli)) return false
  if (rejected.includes(entry.version)) return false
  return installed.pty !== null && semverGt(entry.version, installed.pty)
}

export interface PreparedPty {
  version: string
  staging: string
  protocol: number
  features: string[]
  /** Its host speaks a protocol above this CLI's (spec §5, the pairing rule): no daemon of this build could open a pane
   *  on it, so it is installed only with a CLI build that needs exactly that protocol, in that build's handover. */
  paired?: boolean
}

export class PtyPayloadRefused extends Error {
  constructor(readonly reason: string) { super(`pty payload refused: ${reason}`) }
}

/**
 * A payload downloaded and verified that could not be unpacked (a tool that failed, a full disk, a scan holding a
 * file): transient, as a network failure is, but its bytes are good. The poller keeps [zip] and hands it to the next
 * check's prepare, which unpacks it again rather than download it again, as the CLI's updater keeps its `verified`.
 */
export class PtyPayloadUnpackFailed extends Error {
  readonly reason: string
  constructor(readonly zip: Buffer, cause: unknown) {
    const reason = cause instanceof Error ? cause.message : String(cause)
    super(`pty payload not unpacked: ${reason}`)
    this.reason = reason
  }
}

export interface PreparePtyDeps {
  download: (ref: FileRef) => Promise<Buffer>
  unzip: (zip: Buffer, dest: string) => Promise<void>
  /** Run `<binary> version` and return its one parsed JSON line. */
  probe: (binary: string) => Promise<unknown>
  /** Prove the staged host serves (`serveCanary`); throws why not. */
  serve: (binary: string, host: { protocol: number; version: string }) => Promise<void>
}

/** `tar.exe` is the bsdtar Windows ships (install.ps1's Expand-HarnessZip falls back to it too); `unzip`
 *  stands in elsewhere so the tests can run. tar.exe reads its arguments in the ANSI code page, so a profile
 *  path outside it (CJK on a Western Windows) breaks extraction: as install.ps1 does, run it in the staging
 *  folder with an ASCII relative zip name. The zip is removed after. */
async function unzipWithTool(zip: Buffer, dest: string): Promise<void> {
  const name = 'payload.zip'
  writeFileSync(join(dest, name), zip)
  const [cmd, args] = process.platform === 'win32'
    ? [join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe'), ['-xf', name]] as const
    : ['unzip', ['-q', '-o', name]] as const
  try {
    await new Promise<void>((resolve, reject) => {
      execFile(cmd, [...args], { cwd: dest, windowsHide: true, timeout: 60_000 }, (err) => (err ? reject(err) : resolve()))
    })
  } finally {
    rmSync(join(dest, name), { force: true })
  }
}

/** The last line a binary prints for `version`, parsed: ptyHost/launch.ts `VERSION_COMMAND`, the run `binaryVersion`
 *  makes, but asynchronous. A binary whose child holds its output open past the timeout keeps a synchronous run going
 *  with it, the updater's event loop blocked and the process killed as hung; here `canary`'s own timer ends the wait. */
export function probeVersionLine(binary: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    execFile(binary, [...VERSION_COMMAND.args], VERSION_COMMAND.options, (err, stdout) => {
      if (err) return reject(err)
      try { resolve(JSON.parse(String(stdout).trim().split(/\r?\n/).filter(Boolean).pop() ?? '')) } catch (e) { reject(e) }
    })
  })
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
const reasonOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/** The canary pane's command: one that exits at once, with 0. */
const CANARY_COMMAND = process.platform === 'win32' ? ['cmd.exe', '/d', '/c', 'exit 0'] : ['/bin/sh', '-c', 'exit 0']

/** Processes (pid, image) alive whose executable sits in [dir], or null when the table cannot be read. This scan's own
 *  child (`harness-pty ps`, from the same folder) is left out. */
export async function processesInFolder(binary: string): Promise<{ pid: number; image: string }[] | null> {
  const rows = await windowsProcessRows(null, { binary: () => binary })
  const dir = dirname(binary)
  if (!rows) return null
  const prefix = dir.replace(/[\\/]+$/, '').toLowerCase().replace(/\//g, '\\') + '\\'
  return rows
    .filter((row) => row.parentPid !== process.pid && row.imagePath && row.imagePath.toLowerCase().replace(/\//g, '\\').startsWith(prefix))
    .map((row) => ({ pid: row.pid, image: row.imagePath! }))
}

/** After the host is gone, no process of ours may keep running from the binary's folder: an OpenConsole.exe there would
 *  hold the canary's working folder and, in production, block the rename of the staging folder. Wait for them to end,
 *  then end what is left (their image is in our staging folder, so they are ours). */
async function endBinaryProcesses(binary: string): Promise<void> {
  const waitUntilNone = async (ms: number): Promise<{ pid: number; image: string }[]> => {
    const until = Date.now() + ms
    for (;;) {
      const left = await processesInFolder(binary)
      if (!left?.length || Date.now() >= until) return left ?? []
      await sleep(100)
    }
  }
  const left = await waitUntilNone(SERVE_CANARY_IMAGES_WAIT_MS)
  if (!left.length) return
  await Promise.all(left.map((p) => new Promise<void>((resolve) => {
    execFile('taskkill', ['/PID', String(p.pid), '/T', '/F'], { windowsHide: true, timeout: 2_000 }, () => resolve())
  })))
  await waitUntilNone(SERVE_CANARY_IMAGES_ENDED_MS)
}

/**
 * Prove a staged host serves, which `harness-pty version` does not: that never loads conpty.dll, never binds an
 * endpoint and never starts a pane. `<binary> serve --home <a fresh temporary home> --no-reexec` (no copy outside a job,
 * so the process started is the host), hidden; its discovery file; the hello; one pane running [command] (a shell that
 * exits 0) and its exit; `shutdown`, and the process gone. A host of a protocol above this CLI's (a paired one) cannot
 * be spoken to by any client here: for it the canary ends at the discovery file. Within [timeoutMs]; on every path the
 * host is killed if it still runs, its exit waited for, and the temporary home removed; a home that cannot be removed
 * even so is left for `sweepCanaryHomes`. Neither the host nor its pane runs in the home: on Windows a folder that is a
 * process's working directory cannot be removed while it runs, and a pane's console may outlive the host a moment.
 * Throws why it did not pass.
 */
export async function serveCanary(binary: string, host: { protocol: number; version: string }, options: {
  timeoutMs?: number
  /** Where the temporary home is made: `canaryTempRoot()` unless a test names one. */
  tmpRoot?: string
  command?: string[]
  /** How the home is removed (`removeCanaryHome`); a test's may fail. */
  remove?: (dir: string) => void
} = {}): Promise<void> {
  const timeoutMs = options.timeoutMs ?? SERVE_CANARY_TIMEOUT_MS
  const root = options.tmpRoot ?? canaryTempRoot()
  const home = mkdtempSync(join(root, CANARY_HOME_PREFIX))
  const instance = hostInstanceName(host.protocol, host.version)
  let child: ChildProcess | null = null
  let client: PtyHostClient | null = null
  let ended: string | null = null
  let done = false
  const work = async (): Promise<void> => {
    const started = spawn(binary, ['serve', '--home', home, '--no-reexec'], {
      cwd: root, windowsHide: true, stdio: 'ignore', env: scrubTerminalContext({ ...process.env }),
    })
    child = started
    started.once('error', (error) => { ended ??= `could not start (${error.message})` })
    started.once('exit', (code, signal) => { ended ??= `exited with ${code === null ? `signal ${signal}` : `code ${code}`}` })
    let discovery = readInstanceDiscovery(home, instance)
    while (!discovery) {
      if (ended) throw new Error(`it ${ended} before it published its discovery file`)
      await sleep(25)
      if (done) return
      discovery = readInstanceDiscovery(home, instance)
    }
    if (!SUPPORTED_PTY_PROTOCOLS.includes(host.protocol)) return
    const connected = await PtyHostClient.connect(discovery)
    if (!(connected instanceof PtyHostClient)) throw new Error(connected ? `its hello was refused (${connected.incompatible})` : 'nothing answers at the endpoint it published')
    client = connected
    const exits = new Map<string, number | null>()
    let wake: (() => void) | null = null
    connected.onEvent((event) => {
      if (event.event !== 'exit') return
      exits.set(event.pane, event.status)
      wake?.()
    })
    const created = await connected.call({ op: 'create', command: options.command ?? CANARY_COMMAND, cwd: root, cols: 80, rows: 24, owner: 'harness-pty-canary', hold: false })
    if (created.state !== 'ok') throw new Error(`its create failed (${created.state === 'failed' ? `${created.code}: ${created.reason}` : created.reason})`)
    const pane = created.value.pane
    while (!exits.has(pane)) {
      await new Promise<void>((resolve) => { wake = resolve; setTimeout(resolve, 100) })
      if (done) return
    }
    const status = exits.get(pane)!
    if (status !== null && status !== 0) throw new Error(`its pane exited with ${status}`)
    // A host from before `shutdown` is ended by the cleanup, as the drain ends one.
    if (connected.protocol < SHUTDOWN_PROTOCOL) return
    const down = await connected.call({ op: 'shutdown' })
    if (down.state !== 'ok') throw new Error(`its shutdown failed (${down.state === 'failed' ? `${down.code}: ${down.reason}` : down.reason})`)
    while (!ended) {
      await sleep(25)
      if (done) return
    }
  }
  let timer: NodeJS.Timeout | undefined
  try {
    await Promise.race([
      work(),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`no answer within ${timeoutMs} ms`)), timeoutMs) }),
    ])
  } finally {
    done = true
    clearTimeout(timer)
    const askedClient = client as PtyHostClient | null
    const running = child as ChildProcess | null
    const open = () => !!running && running.exitCode === null && running.signalCode === null
    if (running && open()) {
      const gone = new Promise<void>((resolve) => { running.once('exit', () => resolve()); running.once('error', () => resolve()) })
      // Ask first: a host ended by TerminateProcess never closes its pseudoconsoles, and the console process behind each
      // (OpenConsole.exe) may outlive it holding the folder it started in. `shutdown` succeeds when no pane is left.
      if (askedClient && askedClient.protocol >= SHUTDOWN_PROTOCOL) {
        await Promise.race([askedClient.call({ op: 'shutdown' }).then(() => gone, () => undefined), sleep(SERVE_CANARY_ASK_MS)])
      }
      if (open()) {
        try { running.kill('SIGKILL') } catch { /* gone meanwhile */ }
        await Promise.race([gone, sleep(SERVE_CANARY_EXIT_WAIT_MS)])
      }
    }
    askedClient?.close()
    if (process.platform === 'win32') await endBinaryProcesses(binary)
    try { (options.remove ?? removeCanaryHome)(home) } catch { /* still held: the updater's next start sweeps it (`sweepCanaryHomes`) */ }
  }
}

const DEFAULT_DEPS: PreparePtyDeps = {
  download: (ref) => downloadVerified(ref), unzip: unzipWithTool, probe: probeVersionLine, serve: (binary, host) => serveCanary(binary, host),
}

/** A probe that never answers must not stall the updater, whatever the injected probe does. */
async function canary(probe: PreparePtyDeps['probe'], binary: string): Promise<unknown> {
  let timer: NodeJS.Timeout | undefined
  const hung = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`no answer within ${CANARY_TIMEOUT_MS} ms`)), CANARY_TIMEOUT_MS)
  })
  try {
    return await Promise.race([probe(binary), hung])
  } catch (e) {
    throw new PtyPayloadRefused(`${binary.split(/[\\/]/).pop()} version failed: ${e instanceof Error ? e.message : String(e)}`)
  } finally {
    clearTimeout(timer)
  }
}

/** [serve], bounded as `canary` bounds a probe (`serveCanary` bounds itself and cleans up; this is for any other), and
 *  its failure a refusal. */
async function serves(serve: PreparePtyDeps['serve'], binary: string, host: { protocol: number; version: string }): Promise<void> {
  let timer: NodeJS.Timeout | undefined
  const bound = SERVE_CANARY_BOUND_MS
  try {
    await Promise.race([
      serve(binary, host),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`no answer within ${bound} ms`)), bound) }),
    ])
  } catch (e) {
    throw new PtyPayloadRefused(`harness-pty serve failed: ${reasonOf(e)}`)
  } finally {
    clearTimeout(timer)
  }
}

/** Download, verify, unpack and canary a payload; [verified]: its bytes from an earlier check, verified then, which are
 *  unpacked without a download. A failure to unpack them is `PtyPayloadUnpackFailed`, which carries them. On any
 *  failure the staging folder is removed. */
export async function preparePtyPayload(entry: PtyEntry, runtimeDir: string, deps: Partial<PreparePtyDeps> = {}, verified?: Buffer): Promise<PreparedPty> {
  const d = { ...DEFAULT_DEPS, ...deps }
  const staging = join(runtimeDir, 'pty', `.staging-${process.pid}-${Date.now()}`)
  try {
    let zip: Buffer
    if (verified) zip = verified
    else {
      try {
        zip = await d.download({ url: entry.url, sha256: entry.sha256, size: entry.size })
      } catch (e) {
        if (e instanceof DigestMismatchError) throw new PtyPayloadRefused(`digest mismatch: ${e.message}`)
        throw e
      }
    }
    try {
      mkdirSync(staging, { recursive: true })
      await d.unzip(zip, staging)
    } catch (e) {
      throw new PtyPayloadUnpackFailed(zip, e)
    }
    const found = readdirSync(staging).sort()
    const want = [...PTY_PAYLOAD_FILES].sort()
    if (found.length !== want.length || found.some((f, i) => f !== want[i])) {
      throw new PtyPayloadRefused(`payload holds [${found.join(', ')}], expected [${want.join(', ')}]`)
    }
    const host = await canary(d.probe, join(staging, 'harness-pty.exe'))
    if (!host || typeof host !== 'object') throw new PtyPayloadRefused('harness-pty version is not a JSON object')
    const h = host as { version?: unknown; protocol?: unknown; features?: unknown }
    if (h.version !== entry.version) throw new PtyPayloadRefused(`harness-pty reports version ${String(h.version)}, expected ${entry.version}`)
    // Above this CLI's: the host of a protocol bump, kept for the CLI build that needs it. Below every supported one
    // (or not a protocol at all): no build will ever need it.
    const paired = Number.isSafeInteger(h.protocol) && (h.protocol as number) > PTY_PROTOCOL
    if (typeof h.protocol !== 'number' || (!paired && !SUPPORTED_PTY_PROTOCOLS.includes(h.protocol))) {
      throw new PtyPayloadRefused(`harness-pty speaks unsupported protocol ${String(h.protocol)}`)
    }
    if (!Array.isArray(h.features) || !h.features.every((f) => typeof f === 'string')) {
      throw new PtyPayloadRefused('harness-pty reports no features array')
    }
    const serial = await canary(d.probe, join(staging, 'harness-serial.exe'))
    const sv = (serial as { version?: unknown } | null)?.version
    if (sv !== entry.version) throw new PtyPayloadRefused(`harness-serial reports version ${String(sv)}, expected ${entry.version}`)
    // A version is no proof the host serves: one whose conpty.dll does not load, or that cannot bind or start a pane,
    // would be kept by a probation that judges the core, and every new pane would fail on it.
    await serves(d.serve, join(staging, 'harness-pty.exe'), { protocol: h.protocol, version: entry.version })
    return { version: entry.version, staging, protocol: h.protocol, features: h.features as string[], paired }
  } catch (e) {
    removeFolder(staging)
    // Content failures are refusals (the caller backs off); anything else (network, disk, a missing unzip
    // tool) is transient and rethrown as it is, so the next check retries, as selfUpdate's refuse vs rethrow.
    throw e
  }
}

/** Deleting a just-run exe on Windows often fails EBUSY/EPERM; that must not replace the real error. */
function removeFolder(dir: string): boolean {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    return true
  } catch {
    return false
  }
}

/** Delete stale `<runtime>/pty/.staging-*` folders left by an interrupted run; those still locked stay for
 *  the next sweep. Returns how many were removed. */
export function sweepStagingFolders(runtimeDir: string): number {
  const root = join(runtimeDir, 'pty')
  let names: string[]
  try { names = readdirSync(root) } catch { return 0 }
  let removed = 0
  for (const n of names) if (n.startsWith('.staging-') && removeFolder(join(root, n))) removed++
  return removed
}
