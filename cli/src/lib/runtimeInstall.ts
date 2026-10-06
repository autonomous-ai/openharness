import { spawn } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, sep } from 'node:path'

import { env } from '../config/env.js'
import { gridChildEnv, managedGridPath, meetsVersionFloor } from './gridExec.js'
import { managedNodePath } from './nodeRuntime.js'
import { RUNTIME_DOWNLOAD_LIMITS, downloadVerified } from './selfUpdate.js'

/**
 * Provisioning the Node the CLI runs on, from inside the CLI.
 *
 * Until now only the shell installers ever wrote a runtime or a launcher, and nothing re-ran them —
 * so a computer installed before the product owned its Node keeps a launcher that execs a bare `node`
 * (or an absolute path to a system Node that may since have been removed), and stays broken until
 * somebody re-runs an installer by hand. Doing it here means `harness start` and the post-update
 * restart repair the machine themselves.
 *
 * Everything in this file is best-effort and returns rather than throws: a daemon must not fail to
 * start because a download failed. It keeps running on the interpreter it already has, and tries
 * again next start.
 */

/** `darwin-arm64` | `darwin-x64` | `linux-arm64` | `linux-x64`, or null off those platforms. */
function platformKey(): string | null {
  const os = process.platform === 'darwin' ? 'darwin' : process.platform === 'linux' ? 'linux' : null
  const arch = process.arch === 'arm64' ? 'arm64' : process.arch === 'x64' ? 'x64' : null
  return os && arch ? `${os}-${arch}` : null
}

interface RuntimeArtifact {
  version: string
  url: string
  sha256: string
  size?: number
  archiveRoot: string
}

/** The `<name>` → `<platform>` → entry document every managed runtime publishes, read for one runtime. */
function artifactFor(document: unknown, name: string, key: string): RuntimeArtifact | null {
  const runtime = (document as Record<string, Record<string, unknown> | undefined> | null)?.[name]
  const raw = runtime?.[key] as Partial<RuntimeArtifact> | undefined
  if (!raw || typeof raw.version !== 'string' || typeof raw.url !== 'string') return null
  if (typeof raw.sha256 !== 'string' || typeof raw.archiveRoot !== 'string') return null
  // Refuse a plaintext URL: this archive becomes something the daemon executes.
  if (!raw.url.startsWith('https://')) return null
  return { version: raw.version, url: raw.url, sha256: raw.sha256, size: raw.size, archiveRoot: raw.archiveRoot }
}

/** How long a child that outlived its deadline has between SIGTERM and SIGKILL. */
const KILL_GRACE_MS = 2_000

/**
 * Runs [file] to its end and says whether it exited 0 within [timeoutMs] — WITHOUT holding up the
 * event loop while it runs.
 *
 * This module runs inside the core: on every start, and every ten minutes while it runs
 * ([startGridPinRecheck]). A synchronous exec here froze the core for as long as the child took — up
 * to two minutes for an unpack and one for a onefile grid's first `--version` — and a core that does
 * not turn its event loop answers no client, beats no heartbeat, and is restarted by its master. A
 * child that outlives its deadline is sent SIGTERM, as the synchronous exec did, and SIGKILL if it
 * is still there [KILL_GRACE_MS] later; the answer waits for it to be gone, so a staging directory is
 * never removed under a tar that is still writing into it.
 */
export function finishesCleanly(file: string, args: string[], timeoutMs: number, childEnv?: NodeJS.ProcessEnv): Promise<boolean> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(file, args, { stdio: 'ignore', ...(childEnv ? { env: childEnv } : {}) })
    } catch {
      resolve(false)
      return
    }
    let timedOut = false
    let grace: NodeJS.Timeout | undefined
    const deadline = setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
      grace = setTimeout(() => child.kill('SIGKILL'), KILL_GRACE_MS)
    }, timeoutMs)
    let settled = false
    const settle = (ok: boolean) => {
      if (settled) return
      settled = true
      clearTimeout(deadline)
      clearTimeout(grace)
      resolve(ok)
    }
    child.once('error', () => settle(false))
    child.once('close', (code) => settle(!timedOut && code === 0))
  })
}

/** Does `binary --version` answer? `env` and `timeout` for a runtime whose first run is slow — a
 *  onefile grid unpacks itself the first time, and must not be told to update itself while it does. */
function runs(binary: string, timeout: number = 15_000, childEnv?: NodeJS.ProcessEnv): Promise<boolean> {
  return finishesCleanly(binary, ['--version'], timeout, childEnv)
}

/**
 * One managed runtime, as this module lays it down. Node and grid differ in four things and share
 * everything else: the archive shape (`<name>-<version>-<key>/bin/<name>`), the staging, the rename
 * race, the pointer file — the convention nodejs.org's tarballs set and tmux and grid copy.
 */
interface ManagedArchive {
  /** The manifest's top-level key and the runtime's name in every path. */
  name: 'node' | 'grid'
  /** How the runtime is named to a person. */
  label: string
  manifestUrl: string
  /** The executable, relative to the archive root. */
  binary: string
  /** What this daemon already resolved to under the runtime dir, or null when nothing is there. */
  installed: () => string | null
  /**
   * Whether an installed runtime that is not the manifest's version is replaced. Node stops at "one
   * is installed" — which version is the installer's business, and a daemon must not swap the
   * interpreter it is running on. The grid follows the PIN: the manifest names the version this build
   * of the CLI drives, and a pin that moved must reach a machine that already has an older one.
   */
  followsPin: boolean
  /** A version the manifest may not go below — this daemon's floor, which a manifest cannot lower. */
  acceptsVersion?: (version: string) => boolean
  /** Does the laid-down binary run on this computer? Asked before the pointer is written. */
  runs: (binary: string) => Promise<boolean>
  /**
   * Lay the binary and its directory down read-only. For a runtime whose own updater would replace
   * the file in place — `grid update` is an os.replace INTO the directory — a directory it cannot
   * write to is what makes that fail loudly instead of overwriting the pin.
   */
  readOnly?: boolean
  log: (message: string) => void
}

/**
 * Install [spec]'s runtime from its manifest, or move to the version the manifest pins, or leave it
 * be. Returns the binary this daemon should use — which is whatever it already had whenever the
 * manifest, the download or the unpacked binary cannot be trusted — or null when there is nothing.
 *
 * Everything here is best-effort and returns rather than throws: a daemon must not fail to start
 * because a download failed.
 */
/**
 * The staging folders of processes that are gone: a core that exited in the middle of an unpack (an
 * update's handoff, a master's restart) left its `.<name>-staging-<pid>-<time>`, the archive and a
 * partial tree in it, and nothing else ever removes one. Another process's, still running, is its own.
 */
function sweepStaging(name: string): void {
  const prefix = `.${name}-staging-`
  let entries: string[]
  try { entries = readdirSync(env.ADAPTER_RUNTIME_DIR) } catch { return }
  for (const entry of entries) {
    if (!entry.startsWith(prefix)) continue
    const pid = Number(entry.slice(prefix.length).split('-')[0])
    if (Number.isSafeInteger(pid) && pid > 0 && processAlive(pid)) continue
    try { rmSync(join(env.ADAPTER_RUNTIME_DIR, entry), { recursive: true, force: true }) } catch { /* the next start tries again */ }
  }
}

function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM' }
}

async function ensureManagedArchive(spec: ManagedArchive): Promise<string | null> {
  sweepStaging(spec.name)
  const installed = spec.installed()
  if (installed && !spec.followsPin) return installed
  const key = platformKey()
  if (!key) return installed

  try {
    const response = await fetch(spec.manifestUrl)
    if (!response.ok) return installed
    const artifact = artifactFor(await response.json(), spec.name, key)
    if (!artifact) return installed
    if (spec.acceptsVersion && !spec.acceptsVersion(artifact.version)) return installed

    const target = join(env.ADAPTER_RUNTIME_DIR, `${spec.name}-${artifact.version}-${key}`)
    const binary = join(target, spec.binary)
    // The pin is what is installed: nothing to fetch, nothing to write.
    if (installed === binary) return installed
    if (!existsSync(binary)) {
      spec.log(`▸ installing the Harness ${spec.label} runtime (${artifact.version}, ${key})…`)
      // downloadVerified checks the sha256 but not the length, so check it here: a truncated body
      // that somehow collided would be caught by the hash anyway, but a mismatch here is the cheaper
      // and clearer failure.
      const bytes = await downloadVerified(artifact, RUNTIME_DOWNLOAD_LIMITS)
      if (artifact.size !== undefined && bytes.length !== artifact.size) return installed

      mkdirSync(env.ADAPTER_RUNTIME_DIR, { recursive: true, mode: 0o700 })
      const staging = join(env.ADAPTER_RUNTIME_DIR, `.${spec.name}-staging-${process.pid}-${Date.now()}`)
      try {
        mkdirSync(staging, { recursive: true, mode: 0o700 })
        const archive = join(staging, `${spec.name}.tar.gz`)
        writeFileSync(archive, bytes)
        if (!await finishesCleanly('/usr/bin/tar', ['-xzf', archive, '-C', staging], 120_000)) return installed
        const unpacked = join(staging, artifact.archiveRoot)
        if (!existsSync(join(unpacked, spec.binary))) return installed
        // Another start may have won the race; theirs is as good as ours.
        if (!existsSync(target)) renameSync(unpacked, target)
      } finally {
        rmSync(staging, { recursive: true, force: true })
      }
    }
    // After the rename, never in staging: a read-only directory cannot be emptied, and staging must
    // always be.
    if (spec.readOnly) {
      chmodSync(binary, 0o555)
      chmodSync(dirname(binary), 0o555)
    }

    // A pin this computer could not run is tried ONCE and remembered. A runtime that follows its pin
    // is asked on every daemon start, and without this a wrong-arch or broken build would cost a
    // hung exec each time until the manifest moved. A new pin is a new directory, and starts clean.
    const unrunnable = join(target, '.unrunnable')
    if (spec.followsPin && existsSync(unrunnable)) return installed
    if (!await spec.runs(binary)) {
      if (spec.followsPin) {
        try { writeFileSync(unrunnable, `${new Date().toISOString()}\n`, { mode: 0o600 }) } catch { /* the retry is the cost */ }
      }
      return installed
    }
    // Written last, and only once the binary has answered: Desktop Harness and the hook installer
    // both read this file to decide what to execute, so it must never name something that cannot run.
    writeFileSync(join(env.ADAPTER_RUNTIME_DIR, `current-${spec.name}`), `${binary}\n`, { mode: 0o600 })
    spec.log(`  ✓ ${spec.label} runtime ready → ${target}`)
    if (spec.followsPin) retireSuperseded(spec.name, key, target, installed)
    return binary
  } catch {
    return installed
  }
}

/**
 * Every `<name>-*-<key>` under the runtime dir except the one just installed and the one it
 * replaced.
 *
 * One version back stays on purpose. A pane launched before the pin moved has the OLD directory on
 * its PATH for as long as it lives (`gridPanePrelude` in engineLaunch.ts), and deleting it would
 * take `grid` away from an agent mid-conversation. Two versions of a 20 MB runtime is the price;
 * the third is not paid.
 */
function retireSuperseded(name: string, key: string, target: string, previous: string | null): void {
  const keep = new Set([target, previous ? dirname(dirname(previous)) : ''])
  try {
    for (const entry of readdirSync(env.ADAPTER_RUNTIME_DIR)) {
      if (!entry.startsWith(`${name}-`) || !entry.endsWith(`-${key}`)) continue
      const dir = join(env.ADAPTER_RUNTIME_DIR, entry)
      if (keep.has(dir)) continue
      // A read-only `bin/` cannot be emptied as it is; give it back before the sweep.
      try { chmodSync(join(dir, 'bin'), 0o755) } catch { /* not laid down read-only */ }
      rmSync(dir, { recursive: true, force: true })
    }
  } catch {
    // Disk housekeeping only; the runtime that matters is already in place and recorded.
  }
}

/**
 * The managed Node, installing it when this computer has not got one. Returns its path, or null when
 * no runtime could be provisioned — callers keep whatever interpreter they already have.
 *
 * Idempotent and cheap once installed: [managedNodePath] returning a path under the runtime directory
 * means the work is already done, and nothing is fetched.
 */
export async function ensureManagedRuntime(log: (message: string) => void = () => {}): Promise<string | null> {
  return ensureManagedArchive({
    name: 'node',
    label: 'Node',
    manifestUrl: env.ADAPTER_RUNTIME_METADATA_URL,
    binary: join('bin', 'node'),
    installed: () => {
      const existing = managedNodePath()
      return existing.startsWith(env.ADAPTER_RUNTIME_DIR + sep) ? existing : null
    },
    followsPin: false,
    runs: (node) => runs(node),
    log,
  })
}

/**
 * The managed grid at the version the harness manifest PINS — installing it, moving to it, or
 * leaving it be. Returns its path, or null when there is none: callers fall back to whatever `grid`
 * PATH has (`gridBinaryPath`), and an agent's pane is told when it has none (`gridCliPresence`).
 *
 * Best-effort like the Node runtime: a daemon must not fail to start because a download failed. Asked
 * on every daemon start rather than on `--repair` only, because the pin is expected to MOVE and a
 * machine installed last month has to notice. Never below [GRID_VERSION_FLOOR]: the floor is this
 * daemon's, and a manifest cannot lower it. A developer's HARNESS_GRID_BIN is left alone entirely —
 * it outranks the pin at resolution, so a pin laid down under it would be work nobody asked for.
 */
export async function ensureManagedGrid(log: (message: string) => void = () => {}): Promise<string | null> {
  if (process.env.HARNESS_GRID_BIN?.trim()) return null
  return ensureManagedArchive({
    name: 'grid',
    label: 'grid',
    manifestUrl: env.ADAPTER_GRID_RUNTIME_METADATA_URL,
    binary: join('bin', 'grid'),
    installed: managedGridPath,
    followsPin: true,
    acceptsVersion: (version) => meetsVersionFloor(version),
    // A minute, not fifteen seconds: a onefile grid unpacks itself the first time it runs.
    runs: (grid) => runs(grid, 60_000, gridChildEnv()),
    readOnly: true,
    log,
  })
}

/** How often a running daemon re-reads the managed `grid` pin. */
export const GRID_PIN_RECHECK_MS = 10 * 60_000

/**
 * Follow the pin while the daemon RUNS, not only when it starts.
 *
 * A daemon updates itself within about a minute of a release, but it can then run for days, and a pin
 * moved in between would wait for the next restart. That matters here because the pin and the daemon's
 * code are released in an ORDER (grid-reads-without-waking: CLI tag → harness tag → pin, never 0.3.48
 * alone): the pin has to reach the daemons already running the new code, the same day.
 *
 * Idempotent by construction — [ensureManagedGrid] fetches only the manifest and writes nothing while the
 * installed grid IS the pin — and one check at a time. Every `grid` call resolves the binary afresh
 * (`gridBinaryPath` reads `current-grid`), so a moved pin takes effect on the next call. Returns a stop.
 */
export function startGridPinRecheck(options: { ensure?: () => Promise<unknown>; intervalMs?: number } = {}): () => void {
  const ensure = options.ensure ?? (() => ensureManagedGrid((m) => console.log(`[grid-runtime] ${m}`)))
  let checking = false
  const timer = setInterval(() => {
    if (checking) return
    checking = true
    void ensure().catch(() => {}).finally(() => { checking = false })
  }, options.intervalMs ?? GRID_PIN_RECHECK_MS)
  timer.unref?.()
  return () => clearInterval(timer)
}

// The launchers are launchers.ts's: the hn updater, which the core runs, repairs them without loading the
// managed runtimes' code, which grid's half of is the models service's (docs/design/2026-10-06-core-boundary-next.md, step 7).
export { ensureHnLauncher, ensureLauncher } from './launchers.js'
