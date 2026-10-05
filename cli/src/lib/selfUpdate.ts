/**
 * Self-update mechanics — PURE (no process-control; the daemon decides when to restart).
 *
 * The daemon polls a GCS `metadata.json` (same shape as the device OTA manifest), and when a strictly
 * newer build is published it downloads `cli.js` + `notify.mjs`, verifies sha256 IN MEMORY (so a bad
 * download never touches disk), canary-runs the new bundle, then atomically swaps them into the install
 * dir (keeping a `.prev` for rollback). Firing the restart, supervising the new process, and rolling
 * back are all the CALLER's job (`restartForUpdate` in cli.ts) — this module only stages.
 *
 * Manifest entry shape (key = ADAPTER_UPDATE_KEY, coexists with the device `commander` key):
 *   { "adapter": { "version": "0.0.2",
 *                  "cli":    { "url": "…/cli.js",    "sha256": "…", "size": N },
 *                  "notify": { "url": "…/notify.mjs","sha256": "…", "size": M } } }
 */

import { createHash } from 'crypto'
import { existsSync, linkSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs'
import { execFile } from 'child_process'
import { join } from 'path'
import { SpawnLockBusyError, describeSpawnLockFailure } from './daemonSpawnLock.js'
import { managedNodePath } from './nodeRuntime.js'
import { patientDeadline } from './patientExec.js'

export interface FileRef {
  url: string
  sha256: string
  size?: number
}
export interface UpdateEntry {
  version: string
  cli: FileRef
  notify: FileRef
}

const CLI = 'cli.js'
const NOTIFY = 'notify.mjs'
const PACKAGE = 'package.json'
const RUNTIME_PACKAGE = `${JSON.stringify({ type: 'module' })}\n`
/** The version a staged update put in place, until it is kept (`confirm`) or rolled back (`restore`). */
const PENDING = 'update-pending.json'
/** Versions this machine rolled back. The background updater never stages them again; a newer build,
 *  or `harness update` on purpose, moves past them. */
const REJECTED = 'update-rejected.json'
const REJECTED_KEPT = 10

function readJson(file: string): unknown {
  try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return null }
}

/** Written whole and renamed into place; a write cut short (a full disk) leaves nothing behind. */
function writeJson(file: string, value: unknown): void {
  writeWhole(file, `${JSON.stringify(value)}\n`)
}

function writeWhole(file: string, bytes: string | Buffer): void {
  const tmp = `${file}.tmp`
  try {
    writeFileSync(tmp, bytes)
    renameSync(tmp, file)
  } catch (error) {
    try { rmSync(tmp, { force: true }) } catch { /* not a file this call wrote */ }
    throw error
  }
}

const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')

/** The update a stage left to be kept or rolled back: its version, and the sha256 of the cli.js it put in place. */
interface Pending { version: string; sha256: string | null }

function readPending(dir: string): Pending | null {
  const pending = readJson(join(dir, PENDING)) as { version?: unknown; sha256?: unknown } | null
  if (typeof pending?.version !== 'string') return null
  return { version: pending.version, sha256: typeof pending.sha256 === 'string' ? pending.sha256 : null }
}

function pendingVersion(dir: string): string | null {
  return readPending(dir)?.version ?? null
}

/**
 * The version of the update the bundle on disk is, when it is one still waiting to be kept or rolled
 * back: the pending marker names the cli.js with this sha256 (`fingerprint`, the bytes a master runs).
 * A master that starts on such a bundle (launchd after a crash, `harness start` after a power cut,
 * mid-probation) judges it as the master before it would have, instead of running it unwatched.
 */
export function unjudgedUpdate(dir: string, fingerprint: string | null): string | null {
  const pending = readPending(dir)
  return pending && fingerprint && pending.sha256 === fingerprint ? pending.version : null
}

/** The versions this machine rolled back, oldest first. */
export function rejectedVersions(dir: string): string[] {
  const rejected = readJson(join(dir, REJECTED))
  return Array.isArray(rejected) ? rejected.filter((version): version is string => typeof version === 'string') : []
}

/** Strict semver-greater on the `X.Y.Z` core (ignores pre-release/build). Unparseable → false, so a
 *  malformed manifest or the `0.0.0-dev` dev sentinel never triggers a downgrade/oscillation.
 *
 *  Ordering only — it is NOT the permission to update. Automatic updates go through
 *  {@link shouldAutoUpdate}, which also refuses to overwrite a local build. */
export function semverGt(a: string, b: string): boolean {
  const parse = (v: string): number[] | null => {
    const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v)
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
  }
  const x = parse(a)
  const y = parse(b)
  if (!x || !y) return false
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i]
  return false
}

/** A build made from a working tree rather than downloaded from the release channel: the
 *  `<published-core>-dev.<sha>[.dirty]` label that scripts/lib/build-label.sh stamps on every local
 *  install, plus the `0.0.0-dev` sentinel version.ts falls back to. */
export function isLocalDevBuild(version: string): boolean {
  return /^\d+\.\d+\.\d+-dev(\.|$)/.test(version.trim())
}

/**
 * The gate every AUTOMATIC update passes: the daemon's background poll and `harness start`'s
 * update-before-connect. Newer, AND not on top of a local build.
 *
 * Install-if-missing, never upgrade-over-a-dev-build. The old rule was ordering alone, and because
 * `install-cli.sh` labels a local build `<published-core>-dev.<sha>`, the very next release outranked
 * it: a machine developing against unreleased CLI code had its bundle silently replaced mid-session,
 * and the only symptom was the unreleased feature quietly not working. Being carried forward is not
 * worth that — a developer who wants the release can ask for it (`harness update --force`) and a
 * release install, which is every user's, still updates exactly as before.
 */
export function shouldAutoUpdate(candidate: string, current: string): boolean {
  if (isLocalDevBuild(current)) return false
  return semverGt(candidate, current)
}

/**
 * How long a transfer may go without a byte (`idleMs`) and take in all (`deadlineMs`). A link that
 * stalls without dropping (a lid closed, a network changed, a proxy that holds the connection) answered
 * nothing and closed nothing: the check waited on undici's own five-minute body timeout, and a trickle
 * held it for as long as the trickle lasted, every later check skipped meanwhile, with a fix waiting
 * (e2e/updateHostile.e2e.ts). Each is now its own failure, retried at the next check.
 */
export interface TransferLimits {
  idleMs: number
  deadlineMs: number
  /**
   * The slowest a transfer of a known size (Content-Length, or the size the manifest names) may average:
   * its deadline grows to what that rate needs, when that is longer. A link that keeps sending, however
   * slowly, finishes; one that trickles a byte a minute to stay under the idle limit still ends.
   */
  floorBytesPerSecond?: number
}
/** A bundle: a minute without a byte, and a quarter of an hour in all or whatever 1 KB/s needs, the longer
 *  (4.4 MB: about 75 minutes). The fixed quarter of an hour left a link under 5 KB/s never updating: each
 *  check started again from nothing and kept the link full. */
export const DOWNLOAD_LIMITS: TransferLimits = { idleMs: 60_000, deadlineMs: 15 * 60_000, floorBytesPerSecond: 1_024 }
/** The manifest is a few hundred bytes. */
export const MANIFEST_LIMITS: TransferLimits = { idleMs: 30_000, deadlineMs: 60_000 }
/**
 * A managed runtime (lib/runtimeInstall.ts): tens of MB every daemon runs on, which a slow link must be
 * able to finish however long it takes, so no deadline; five minutes without a byte, undici's own body
 * timeout and what these downloads always had.
 */
export const RUNTIME_DOWNLOAD_LIMITS: TransferLimits = { idleMs: 300_000, deadlineMs: Number.POSITIVE_INFINITY }

/** The transfer went quiet for too long, or took too long in all. */
export class TransferStalledError extends Error {}

/** GET `url` whole within `limits`: the status, and the body once it has all arrived. */
async function fetchWithin(url: string, limits: TransferLimits, expectedBytes?: number): Promise<{ ok: boolean; status: number; body: Buffer }> {
  const controller = new AbortController()
  let stalled!: (error: TransferStalledError) => void
  const gaveUp = new Promise<never>((_, reject) => { stalled = reject })
  gaveUp.catch(() => {})
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null
  const giveUp = (why: string): void => {
    stalled(new TransferStalledError(`${url} ${why}`))
    controller.abort()
    void reader?.cancel().catch(() => {})
  }
  const timer = (ms: number, why: string): NodeJS.Timeout => {
    const handle = setTimeout(() => giveUp(why), ms)
    handle.unref?.()
    return handle
  }
  // No deadline at all for an infinite one: a timer given Infinity fires at once.
  const startedAt = performance.now()
  let deadline = Number.isFinite(limits.deadlineMs) ? timer(limits.deadlineMs, `took longer than ${limits.deadlineMs} ms in all`) : undefined
  /** Once the size is known: the deadline the floor rate needs, when that is the longer. */
  const scaleDeadline = (bytes: number): void => {
    if (!deadline || !limits.floorBytesPerSecond || !(bytes > 0)) return
    const needed = Math.ceil(bytes / limits.floorBytesPerSecond * 1000)
    if (needed <= limits.deadlineMs) return
    clearTimeout(deadline)
    deadline = timer(Math.max(0, needed - (performance.now() - startedAt)), `took longer than ${needed} ms in all (${bytes} bytes at ${limits.floorBytesPerSecond} B/s)`)
  }
  if (expectedBytes !== undefined) scaleDeadline(expectedBytes)
  let idle = timer(limits.idleMs, `sent nothing for ${limits.idleMs} ms`)
  const heard = (): void => { clearTimeout(idle); idle = timer(limits.idleMs, `sent nothing for ${limits.idleMs} ms`) }
  try {
    const res = await Promise.race([fetch(url, { signal: controller.signal }), gaveUp])
    heard()
    if (expectedBytes === undefined) scaleDeadline(Number(res.headers?.get?.('content-length')))
    // Read as it arrives, so the idle timer hears every chunk. A response with no stream (a body-less
    // status, or a Response-like object that only buffers) is read whole, within the same limits.
    if (!res.body) {
      const whole = res.ok && typeof res.arrayBuffer === 'function' ? Buffer.from(await Promise.race([res.arrayBuffer(), gaveUp])) : Buffer.alloc(0)
      return { ok: res.ok, status: res.status, body: whole }
    }
    const chunks: Buffer[] = []
    reader = res.body.getReader()
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), gaveUp])
      if (done) break
      chunks.push(Buffer.from(value))
      heard()
    }
    return { ok: res.ok, status: res.status, body: Buffer.concat(chunks) }
  } finally {
    clearTimeout(deadline)
    clearTimeout(idle)
  }
}

/** Fetch + parse the manifest; return this adapter's entry, or null (unreachable / malformed / absent). */
export async function fetchManifest(url: string, key: string, limits: TransferLimits = MANIFEST_LIMITS): Promise<UpdateEntry | null> {
  // No `cache` option needed: undici doesn't HTTP-cache by default and GCS serves the manifest no-cache.
  const res = await fetchWithin(url, limits)
  if (!res.ok) return null
  const json = JSON.parse(res.body.toString('utf8')) as Record<string, unknown>
  const entry = json?.[key] as Partial<UpdateEntry> | undefined
  const okFile = (f: unknown): f is FileRef =>
    !!f && typeof (f as FileRef).url === 'string' && typeof (f as FileRef).sha256 === 'string'
  if (!entry || typeof entry.version !== 'string' || !okFile(entry.cli) || !okFile(entry.notify)) return null
  return { version: entry.version, cli: entry.cli, notify: entry.notify }
}

/** The whole download arrived, and it is not what the manifest names. */
export class DigestMismatchError extends Error {}

/** Download one file within `limits` and verify its sha256 in memory; throws on a non-2xx, a stall or a
 *  digest mismatch. */
export async function downloadVerified(ref: FileRef, limits: TransferLimits = DOWNLOAD_LIMITS): Promise<Buffer> {
  const res = await fetchWithin(ref.url, limits, ref.size)
  if (!res.ok) throw new Error(`download ${ref.url} → HTTP ${res.status}`)
  const got = sha256(res.body)
  if (got.toLowerCase() !== ref.sha256.toLowerCase()) {
    throw new DigestMismatchError(`sha256 mismatch for ${ref.url}: expected ${ref.sha256}, got ${got}`)
  }
  return res.body
}

/**
 * What the canary found. `unwritable`: it could not be set up (a full disk, a folder it may not write),
 * which says nothing about the build; `failed`: the build ran and failed; `wrong-version`: it ran and
 * said it is another version than the manifest names.
 */
export type CanaryResult = { ok: true } | { ok: false; problem: 'unwritable' | 'failed' | 'wrong-version'; detail: string }

/** How long the canary may take to answer. */
export const CANARY_TIMEOUT_MS = 15_000
/** How long a canary that outlived its deadline has between SIGTERM and SIGKILL. */
export const CANARY_KILL_GRACE_MS = 2_000

/** Cheap runnability check: write the new bundle into a temp install-shaped dir and run
 *  `node cli.js version`. This catches broken ESM/CJS packaging before the live install is touched.
 *
 *  Given the version the manifest names, the build must also say it is that version. A manifest that
 *  named an older build's bytes under a newer version (published by mistake, e2e/updateHostile.e2e.ts)
 *  was otherwise installed, came up, still reported the older version, found the newer one in the
 *  manifest again and installed it again: a restart a minute on every machine until it was fixed.
 *
 *  Asynchronous. It ran with `spawnSync` inside the daemon's own updater, on the core's event loop: for
 *  as long as the new build took to load and answer, up to its 15 s timeout, no terminal byte, hook,
 *  heartbeat or request was handled, and the master kills a core that stops beating as hung. */
export async function runCanary(cliBuf: Buffer, dir: string, version?: string, timeoutMs = CANARY_TIMEOUT_MS): Promise<CanaryResult> {
  const tmpDir = join(dir, `.canary-${process.pid}-${Date.now()}`)
  const tmpCli = join(tmpDir, CLI)
  try {
    try {
      mkdirSync(tmpDir, { recursive: true })
      writeFileSync(join(tmpDir, PACKAGE), RUNTIME_PACKAGE)
      writeFileSync(tmpCli, cliBuf)
    } catch (error) {
      return { ok: false, problem: 'unwritable', detail: error instanceof Error ? error.message : String(error) }
    }
    // The interpreter the NEXT daemon will run on — see managedNodePath(). Canarying on this
    // process's interpreter would assert about a Node the new build may never be started with.
    // The deadline counts only time this process's event loop ran (patientDeadline): Node's own timeout,
    // fired late after a held loop, threw a build's answer away and took it for no answer. A build that
    // outlives it is sent SIGTERM, and SIGKILL [CANARY_KILL_GRACE_MS] later: one that ignores SIGTERM held
    // the check open for good, and with it every later check (`checking`), a fixed release's included.
    const r = await new Promise<{ failure: string | null; stdout: string }>((resolve) => {
      let timedOut = false
      let grace: ReturnType<typeof setTimeout> | undefined
      let cancel = (): void => {}
      const child = execFile(managedNodePath(), [tmpCli, 'version'], { encoding: 'utf8' }, (error, stdout) => {
        cancel()
        clearTimeout(grace)
        // An answer is an answer, even one that raced the kill.
        if (!error) { resolve({ failure: null, stdout }); return }
        const failed = error as NodeJS.ErrnoException & { signal?: NodeJS.Signals | null; code?: number | string }
        resolve({
          failure: timedOut ? `no answer within ${timeoutMs >= 1000 ? `${Math.round(timeoutMs / 1000)} s` : `${timeoutMs} ms`}`
            : typeof failed.code === 'number' ? `exit ${failed.code}`
            : failed.signal ? `signal ${failed.signal}`
            : failed.message,
          stdout: '',
        })
      })
      cancel = patientDeadline(timeoutMs, () => {
        timedOut = true
        child.kill('SIGTERM')
        grace = setTimeout(() => child.kill('SIGKILL'), CANARY_KILL_GRACE_MS)
      })
    })
    if (r.failure !== null) return { ok: false, problem: 'failed', detail: r.failure }
    const lines = r.stdout.trim().split('\n')
    const said = lines[lines.length - 1]
    if (version !== undefined && said !== version) return { ok: false, problem: 'wrong-version', detail: `it says it is ${said || 'nothing'}` }
    return { ok: true }
  } finally {
    try { rmSync(tmpDir, { recursive: true, force: true }) } catch { /* ignore */ }
  }
}

export async function canary(cliBuf: Buffer, dir: string, version?: string): Promise<boolean> {
  return (await runCanary(cliBuf, dir, version)).ok
}

/**
 * Swap the new bytes into `dir`, backing up the current files to `.prev` for rollback, and note
 * `version` as pending until it is kept or rolled back. (Verified in memory first, so only bytes we
 * already trust are ever written.)
 *
 * All or nothing, because a full disk found the gaps (e2e/updateHostile.e2e.ts): everything new is
 * written beside what it replaces first, and only renames, which need no room and cannot tear a file,
 * touch what the daemon runs. Before, a write that failed left its temporary file (up to a whole
 * bundle, on a disk already full) behind, package.json was rewritten in place, and a failure after
 * cli.js was swapped left a mixed bundle with no pending note, which the retry then backed up over the
 * backup of the build before.
 *
 * The backups are hard links where the disk allows them: no second copy of the bundle to find room
 * for, and never a partial one. While the bundle on disk is itself an update still being judged (a
 * newer build staged during its probation), the backups already hold the last build that was kept,
 * and stay: a rollback goes back to a build that proved itself, not to one that never did.
 */
export function stage(dir: string, cliBuf: Buffer, notifyBuf: Buffer, version?: string): void {
  mkdirSync(dir, { recursive: true })
  const path = (name: string): string => join(dir, name)
  const temporary = (name: string): string => `${path(name)}.tmp`
  // The files this call wrote, removed again if it fails before the swap.
  const written: string[] = []
  const write = (file: string, bytes: string | Buffer): void => {
    written.push(file)
    writeFileSync(file, bytes)
  }
  const unjudged = (): boolean => {
    const pending = readPending(dir)
    return !!pending?.sha256 && existsSync(`${path(CLI)}.prev`) && existsSync(`${path(NOTIFY)}.prev`)
      && pending.sha256 === fileSha256(path(CLI))
  }
  const renames: Array<[string, string]> = []
  try {
    if (readText(path(PACKAGE)) !== RUNTIME_PACKAGE) {
      write(temporary(PACKAGE), RUNTIME_PACKAGE)
      renames.push([temporary(PACKAGE), path(PACKAGE)])
    }
    write(temporary(CLI), cliBuf)
    write(temporary(NOTIFY), notifyBuf)
    renames.push([temporary(CLI), path(CLI)], [temporary(NOTIFY), path(NOTIFY)])
    if (!unjudged()) {
      for (const name of [CLI, NOTIFY]) {
        if (!existsSync(path(name))) continue
        const backup = `${path(name)}.prev`
        written.push(backup)
        rmSync(backup, { force: true })
        try {
          linkSync(path(name), backup)
        } catch {
          // A filesystem without hard links: a whole copy, renamed into place, never a partial one.
          write(`${backup}.tmp`, readFileSync(path(name)))
          renameSync(`${backup}.tmp`, backup)
        }
      }
    }
    // Before the swap: a process that dies between here and the end leaves an update the next master
    // finds and judges (`unjudgedUpdate`), not a bundle no one knows is new. Written whole or not at
    // all, so a marker it would replace is never lost to a failed write.
    if (version) writeJson(path(PENDING), { version, sha256: sha256(cliBuf), at: Date.now() })
  } catch (error) {
    for (const file of written) { try { rmSync(file, { force: true }) } catch { /* not this call's to clear */ } }
    throw error
  }
  for (const [from, to] of renames) renameSync(from, to) // atomic within the same filesystem
}

function readText(file: string): string | null {
  try { return readFileSync(file, 'utf8') } catch { return null }
}

function fileSha256(file: string): string | null {
  try { return sha256(readFileSync(file)) } catch { return null }
}

/**
 * Roll a failed update back to the `.prev` bytes (called by the supervisor when the new build crashes),
 * and remember the version that failed. Without that, the restored daemon's updater found the same
 * build in the manifest a minute later and staged it again: a release that passed its canary but
 * crashed the daemon restarted every machine once a minute until a fix was published.
 */
export function restore(dir: string): void {
  for (const name of [CLI, NOTIFY]) {
    const prev = join(dir, `${name}.prev`)
    if (existsSync(prev)) { try { renameSync(prev, join(dir, name)) } catch { /* ignore */ } }
  }
  const failed = pendingVersion(dir)
  try {
    if (failed) writeJson(join(dir, REJECTED), [...rejectedVersions(dir).filter((version) => version !== failed), failed].slice(-REJECTED_KEPT))
    rmSync(join(dir, PENDING), { force: true })
  } catch { /* the rollback itself is what matters */ }
}

/**
 * A build a rollback could not remember: a full disk kept `restore` from writing the rejected list, so
 * its pending note is still there, naming a cli.js no longer on disk. Put it on the list now if it can
 * be, and return its version either way, so the updater does not stage it again meanwhile: before, it
 * was staged again once there was room, and crashed the daemon once more (e2e/updateHostile.e2e.ts).
 * Null when there is no such note.
 */
export function settleRolledBack(dir: string): string | null {
  const pending = readPending(dir)
  if (!pending?.sha256 || pending.sha256 === fileSha256(join(dir, CLI))) return null
  try {
    const listed = rejectedVersions(dir)
    if (!listed.includes(pending.version)) writeJson(join(dir, REJECTED), [...listed, pending.version].slice(-REJECTED_KEPT))
    rmSync(join(dir, PENDING), { force: true })
  } catch { /* still no room: the note stays, and still names it */ }
  return pending.version
}

/** Drop the `.prev` backups once the new build is confirmed healthy; a version kept is not rejected. */
export function confirm(dir: string): void {
  for (const name of [CLI, NOTIFY]) {
    try { rmSync(join(dir, `${name}.prev`), { force: true }) } catch { /* ignore */ }
  }
  const kept = pendingVersion(dir)
  try {
    if (kept && rejectedVersions(dir).includes(kept)) writeJson(join(dir, REJECTED), rejectedVersions(dir).filter((version) => version !== kept))
    rmSync(join(dir, PENDING), { force: true })
  } catch { /* the new build runs either way */ }
}

export interface Poller { stop(): void }

/** The longest a build that failed on its own merits waits to be tried again. */
export const REFUSED_RETRY_MAX_MS = 60 * 60_000

/**
 * Milliseconds from `nowMs` to the next tick. With a slot, ticks land on the wall-clock instant
 * `slotSecond` seconds past each `intervalMs` boundary (`:45` of every minute for the defaults) —
 * strictly in the future, so a call made exactly on the slot waits a whole interval rather than
 * firing twice. Without a usable slot (negative, or an interval that does not divide a minute) it is
 * the plain interval.
 */
export function msUntilSlot(nowMs: number, slotSecond: number | undefined, intervalMs: number): number {
  if (slotSecond === undefined || slotSecond < 0 || intervalMs <= 0 || 60_000 % intervalMs !== 0) return intervalMs
  const slotMs = (slotSecond * 1000) % intervalMs
  const phase = ((nowMs % intervalMs) + intervalMs) % intervalMs
  const wait = slotMs - phase
  return wait > 0 ? wait : wait + intervalMs
}

/**
 * Poll on an interval; on the first build {@link shouldAutoUpdate} allows that also verifies and
 * passes its canary, STAGE it and call `onStaged(version)` exactly once, then stop polling (the
 * caller restarts immediately). Every failure
 * (fetch/parse/sha/canary/disk) is swallowed and simply retried next tick — the daemon never crashes
 * on a bad update.
 *
 * Retried, but not at every tick when the build itself is what failed: bytes that do not match the
 * manifest, or a build that fails its canary, fail again the same way, and each try is a whole
 * download. A release published broken was fetched once a minute by every machine until it was
 * replaced (e2e/updateHostile.e2e.ts counted one a second at a one-second interval). Such a build is
 * tried again after two intervals, then four, eight, … up to {@link REFUSED_RETRY_MAX_MS}; a new entry in
 * the manifest is tried at once. What was only this machine's moment (a dropped link, a full disk that
 * cannot hold the canary) is retried at the next tick, without downloading again what already arrived.
 *
 * Ticks are SCHEDULED, not immediate: the first one lands on the next slot (see {@link msUntilSlot}),
 * and each tick books the next from the clock rather than from its own end, so a slow download does
 * not drift the slot. `harness start` already staged the newest build before spawning this daemon,
 * which is why nothing is lost by not checking at start.
 */
export function startSelfUpdater(opts: {
  currentVersion: string
  url: string
  key: string
  dir: string
  intervalMs: number
  /** Wall-clock second the ticks land on; omit or negative for a plain interval. */
  slotSecond?: number
  /** The clock (tests). */
  now?: () => number
  /** Awaited: the section from the byte swap through whatever `onStaged` does (the daemon's restart
   *  handoff) is ONE critical section, and the lock `withLock` takes must outlive all of it. */
  onStaged: (version: string) => void | Promise<void>
  /** Wrap the swap + `onStaged` in a mutual exclusion with every other process that writes the
   *  bundle or spawns the daemon. Default: none (tests, and callers that hold their own). */
  withLock?: <T>(fn: () => Promise<T>) => Promise<T>
  /** How long a download may go without a byte, and take in all; the manifest gets at most its own. */
  limits?: TransferLimits
  /**
   * Whether a newer build may be staged while the bundle on disk is itself an update still being judged.
   * A master from before #807 (v0.3.58) rolls back on ANY exit of a core on probation, the exit for the
   * newer build included: it put back the backup, which #807's `stage` keeps as the last build kept (two
   * builds back), and rejected the newer one for good. A core such a master runs waits for its own build
   * to be kept, then stages. True when left out, and for every master that says it judges such an exit
   * itself (HARNESSD_JUDGES_SUPERSEDED).
   */
  stageWhileJudged?: boolean
}): Poller {
  let checking = false
  let done = false
  let timer: NodeJS.Timeout | null = null
  const withLock = opts.withLock ?? ((fn) => fn())
  // The bytes of the manifest's build once downloaded and verified, kept across ticks with whether
  // they passed their canary: when the lock was busy (a `harness start` or `harness update`
  // mid-flight), or the canary could not be written, the next tick should try again from there, not
  // from the whole download.
  let verified: { entry: string; version: string; cliBuf: Buffer; notifyBuf: Buffer; canaried: boolean } | null = null
  // The manifest's build, when it failed in a way it would fail again, and when it may be tried again.
  let refused: { entry: string; tries: number; until: number } | null = null
  // Said once per version: the check repeats every interval.
  let toldRejected: string | null = null
  let toldWaiting: string | null = null

  const now = opts.now ?? Date.now
  const download = opts.limits ?? DOWNLOAD_LIMITS
  const manifest: TransferLimits = {
    idleMs: Math.min(download.idleMs, MANIFEST_LIMITS.idleMs), deadlineMs: Math.min(download.deadlineMs, MANIFEST_LIMITS.deadlineMs),
  }
  const stop = (): void => { if (timer) { clearTimeout(timer); timer = null } }
  // Stopped from outside: a check under way goes no further than the step it is on. Before, only the
  // next check was cancelled, and one waiting on a download or a canary went on to swap the bundle and
  // hand the machine over (`onStaged`) on a daemon that was shutting down.
  let halted = false
  const schedule = (): void => {
    stop()
    timer = setTimeout(() => void tick(), msUntilSlot(now(), opts.slotSecond, opts.intervalMs))
    timer.unref?.()
  }

  // No `done` check here or in `schedule`: `done` is set only next to `stop()`, so no tick fires after it.
  const tick = async (): Promise<void> => {
    // Booked before the work, from the clock: the next tick is on the next slot whatever this one
    // costs; a tick that stages calls `stop()` below and cancels it. Booked even when this slot is
    // skipped because the previous check is still running (a download on a slow link can outlast a
    // minute) — otherwise the chain would end there and the daemon would never look again.
    schedule()
    if (checking) return
    checking = true
    try {
      const entry = await fetchManifest(opts.url, opts.key, manifest)
      if (halted || !entry || !shouldAutoUpdate(entry.version, opts.currentVersion)) return
      const unremembered = settleRolledBack(opts.dir)
      if (unremembered === entry.version || rejectedVersions(opts.dir).includes(entry.version)) {
        if (toldRejected !== entry.version) console.log(`[update] ${entry.version} was rolled back on this machine — waiting for a newer build (\`harness update\` installs it anyway)`)
        toldRejected = entry.version
        return
      }
      const key = `${entry.version} ${entry.cli.sha256} ${entry.notify.sha256}`
      if (refused?.entry === key && now() < refused.until) return
      const refuse = (why: string): void => {
        const tries = refused?.entry === key ? refused.tries + 1 : 1
        const wait = Math.min(opts.intervalMs * 2 ** tries, REFUSED_RETRY_MAX_MS)
        refused = { entry: key, tries, until: now() + wait }
        verified = null
        console.error(`[update] ${entry.version} ${why} — not trying it again for ${wait >= 1000 ? `${Math.round(wait / 1000)} s` : `${wait} ms`}`)
      }
      if (verified?.entry !== key) {
        console.log(`[update] newer build available: ${opts.currentVersion} → ${entry.version}`)
        verified = null
        let cliBuf: Buffer
        let notifyBuf: Buffer
        try {
          cliBuf = await downloadVerified(entry.cli, download)
          notifyBuf = await downloadVerified(entry.notify, download)
        } catch (error) {
          if (!(error instanceof DigestMismatchError)) throw error
          refuse(`does not match its manifest (${error.message})`)
          return
        }
        verified = { entry: key, version: entry.version, cliBuf, notifyBuf, canaried: false }
      }
      if (halted) return
      if (!verified.canaried) {
        const result = await runCanary(verified.cliBuf, opts.dir, entry.version)
        if (halted) return
        if (!result.ok && result.problem === 'unwritable') {
          console.error(`[update] could not write the canary for ${entry.version} (${result.detail}) — trying again next check`)
          return
        }
        if (!result.ok) { refuse(`failed its canary (${result.detail})`); return }
        verified.canaried = true
      }
      const ready = verified
      if (opts.stageWhileJudged === false && unjudgedUpdate(opts.dir, fileSha256(join(opts.dir, CLI)))) {
        if (toldWaiting !== ready.version) console.log(`[update] ${ready.version} is ready — waiting for this build to be kept before staging it`)
        toldWaiting = ready.version
        return
      }
      // Downloaded and verified OUTSIDE the lock (that can take a while on a slow link and touches
      // nothing shared); swapped and handed off INSIDE it.
      await withLock(async () => {
        if (halted) return
        stage(opts.dir, ready.cliBuf, ready.notifyBuf, ready.version)
        done = true
        stop()
        console.log(`[update] staged ${ready.version} — restarting now`)
        await opts.onStaged(ready.version)
      }).catch((err: unknown) => {
        // A busy lock is not a failed check: the bytes are good and waiting, and the next tick tries
        // the swap again. Say so, or a minute of "check failed" reads as the updater being broken.
        if (!(err instanceof SpawnLockBusyError)) throw err
        console.log(`[update] ${ready.version} is ready but the daemon spawn lock is ${describeSpawnLockFailure(err)} — trying again next check`)
      })
    } catch (err) {
      console.error('[update] check failed (will retry):', err instanceof Error ? err.message : err)
    } finally {
      checking = false
    }
  }

  schedule()
  return { stop: () => { halted = true; stop() } }
}
