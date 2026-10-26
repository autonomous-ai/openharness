/**
 * The terminal host's self-update on Windows (spec §5): the updater process (services/updaterProcess.ts) polls the PTY
 * manifest beside the CLI's, downloads and canaries a promoted payload outside the lock (./ptyPayload.ts), installs it
 * under the daemon spawn lock (./ptyInstall.ts) and tells harnessd's master, which hands over to a new core and judges
 * it on the CLI's probation. When both have an update, the CLI's poller takes the prepared payload into its own lock
 * hold and handover, first (`readyToStage`), so the daemon restarts once.
 *
 * A payload whose host speaks a protocol above this CLI's (a protocol bump's) is canaried like any other but never
 * installed on its own: no daemon of this build could open a pane on it. It waits, prepared, for the CLI build whose
 * `version --json` needs exactly that protocol, and goes into that build's handover, first; one probation judges the
 * pair (spec §5, the pairing rule beside the protocol rule).
 *
 * Also the master's half: what its probation runs when the new core fails (`rollBackStaged`) or stays up
 * (`keepStaged`), for the CLI build and the host alike, and the start-of-updater sweep of what installs leave behind.
 * Nothing here calls a Windows API, so it is tested on every OS.
 */
import { existsSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { SpawnLockBusyError, describeSpawnLockFailure } from '../daemonSpawnLock.js'
import { binaryVersion, currentPtyVersion } from '../ptyHost/launch.js'
import { PTY_PROTOCOL, SUPPORTED_PTY_PROTOCOLS } from '../ptyHost/protocol.js'
import { REFUSED_RETRY_MAX_MS, msUntilSlot, type Poller } from '../selfUpdate.js'
import {
  BIN_FILES, PTY_PENDING, PTY_REJECTED, confirmPty, defaultPtyInstallFs, installPreparedPty, readPtyPending, rejectedPtyVersions, restorePty,
  sweepAsideFiles, type PtyInstallFs, type PtyPending, type PtyRestore,
} from './ptyInstall.js'
import {
  PtyPayloadRefused, PtyPayloadUnpackFailed, fetchPtyEntry, preparePtyPayload, ptyUpdateWanted, sweepCanaryHomes, sweepStagingFolders,
  type PreparedPty,
  type PtyEntry,
} from './ptyPayload.js'

export interface PtyUpdaterDeps {
  fetchEntry: (url: string, key: string) => Promise<PtyEntry | null>
  /** [verified]: the entry's bytes, downloaded and verified at an earlier check whose unpack failed
   *  (`PtyPayloadUnpackFailed`): unpacked again, not downloaded again. */
  prepare: (entry: PtyEntry, runtimeDir: string, verified?: Buffer) => Promise<PreparedPty>
  install: (prepared: PreparedPty, rootDir: string) => boolean
  /** Remove the staging folder of a payload that will not be installed. */
  discard: (prepared: PreparedPty) => void
  /** What the poller runs once, under the lock, before its first check. */
  sweep: (rootDir: string, log: (line: string) => void) => void
  now: () => number
  log: (line: string) => void
  error: (line: string) => void
}

const DEFAULT_DEPS: PtyUpdaterDeps = {
  fetchEntry: (url, key) => fetchPtyEntry(url, key),
  prepare: (entry, runtimeDir, verified) => preparePtyPayload(entry, runtimeDir, {}, verified),
  install: (prepared, rootDir) => installPreparedPty(prepared, rootDir),
  discard: (prepared) => {
    // A just-run canary can hold a file a moment; what is left is the next start's sweep's.
    try { rmSync(prepared.staging, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }) } catch { /* swept later */ }
  },
  sweep: (rootDir, log) => sweepPtyLeftovers(rootDir, log),
  now: () => Date.now(),
  log: (line) => console.log(line),
  error: (line) => console.error(line),
}

/** A host `readyToStage` installed: its protocol, from its canary, and whether it was a paired one. */
export interface StagedHost { version: string; protocol: number; paired: boolean }

export type PtyPoller = Poller & {
  /** Under a lock the caller already holds: install the payload already prepared and return its version, or null
   *  when there is none (or it can no longer be installed). [forPtyProtocol]: the host protocol the CLI build being
   *  staged needs; a paired payload (./ptyPayload.ts `PreparedPty.paired`) goes in only for a build that needs exactly
   *  its protocol. Never throws: the CLI's stage goes on either way, under the protocol rule. */
  readyToStage(forPtyProtocol?: number): Promise<StagedHost | null>
  /** The protocol of the payload prepared and waiting, or null: what lets a CLI build that needs it go ahead
   *  (lib/selfUpdate.ts `readyPtyProtocol`), with it first. */
  readyProtocol(): number | null
  /** The host `readyToStage` installed was taken back out (`takeBackPty`: its CLI build did not stage). The poller,
   *  finished by that install, checks again, the payload backed off as a refused one is: the next updater start is
   *  otherwise the first to prepare it for the next build. Nothing once stopped, or with nothing installed. */
  takenBack(): void
}

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/**
 * Poll on the CLI's schedule (scheduled ticks on the same slot), for a payload newer than `current-pty`. A download
 * outside the lock; a refused payload backed off as the CLI's (`refuse` in lib/selfUpdate.ts `startSelfUpdater`),
 * a transient failure retried at the next check; under the lock, asked again whether `current-pty` is still older
 * (install.ps1 or `harness update` may have moved it), then installed and handed over (`onStaged`, awaited inside the
 * lock). Nothing is checked while a version is on probation: the master keeps it or rolls it back first.
 *
 * A payload prepared at a check is installed on its own at the next one, not at once: the CLI's check runs on the same
 * slot, and when it stages a build too it takes the payload into its handover (`readyToStage`), so the daemon restarts
 * once for both, the host first. Each log line is said once per version.
 */
export function startPtyUpdater(opts: {
  url: string
  key: string
  /** The install root: `bin\` and `runtime\pty\` are in it. */
  rootDir: string
  intervalMs: number
  /** Wall-clock second the ticks land on, as the CLI's; omit or negative for a plain interval. */
  slotSecond?: number
  /** The CLI build installed: a development one never takes an update (lib/selfUpdate.ts `isLocalDevBuild`). */
  installedCli: () => string
  /** The daemon spawn lock, around the install and `onStaged`. */
  withLock: <T>(fn: () => Promise<T>) => Promise<T>
  onStaged: (ptyVersion: string) => void | Promise<void>
  deps?: Partial<PtyUpdaterDeps>
}): PtyPoller {
  const d: PtyUpdaterDeps = { ...DEFAULT_DEPS, ...opts.deps }
  const runtimeDir = join(opts.rootDir, 'runtime')
  const marker = join(runtimeDir, 'pty', PTY_PENDING)
  let timer: NodeJS.Timeout | null = null
  let checking = false
  let halted = false
  // Downloaded, verified and canaried, waiting for the lock. `fresh`: prepared at this check, left for the CLI's.
  let ready: { key: string; entry: PtyEntry; prepared: PreparedPty; fresh: boolean } | null = null
  let refused: { key: string; tries: number; until: number } | null = null
  // The bytes of an entry downloaded and verified whose unpack failed: the next check unpacks them, and downloads nothing.
  let verified: { key: string; zip: Buffer } | null = null
  // What `installReady` installed last, for `takenBack`.
  let installedLast: { key: string; version: string } | null = null
  let stopped = false
  const told = new Map<string, string>()
  const once = (kind: string, version: string, say: () => void): void => {
    if (told.get(kind) === version) return
    told.set(kind, version)
    say()
  }

  const stop = (): void => { if (timer) { clearTimeout(timer); timer = null } }
  const schedule = (): void => {
    stop()
    timer = setTimeout(() => void tick(), msUntilSlot(d.now(), opts.slotSecond, opts.intervalMs))
    timer.unref?.()
  }
  const finish = (): void => { halted = true; stop() }

  const drop = (): void => {
    if (ready) d.discard(ready.prepared)
    ready = null
  }
  /** Hold [key] back, as the CLI's refusal does: twice as long each time in a row, up to `REFUSED_RETRY_MAX_MS`. */
  const backOff = (key: string): string => {
    const tries = refused?.key === key ? refused.tries + 1 : 1
    const wait = Math.min(opts.intervalMs * 2 ** tries, REFUSED_RETRY_MAX_MS)
    refused = { key, tries, until: d.now() + wait }
    return wait >= 1000 ? `${Math.round(wait / 1000)} s` : `${wait} ms`
  }
  const refuse = (key: string, version: string, reason: string): void => {
    const wait = backOff(key)
    once('refused', version, () => d.error(`[update] terminal host ${version} was refused (${reason}) — not trying it again for ${wait}`))
  }
  /** Whether [entry] is still an update over what is installed now; said once when it no longer is. */
  const wanted = (entry: PtyEntry): boolean => {
    const installed = currentPtyVersion(runtimeDir)
    if (ptyUpdateWanted(entry, { pty: installed, cli: opts.installedCli() }, rejectedPtyVersions(opts.rootDir))) return true
    if (ready?.entry.version === entry.version) {
      drop()
      once('gone', entry.version, () => d.log(`[update] terminal host ${entry.version} is no longer an update: the installed host is now ${installed ?? 'none'}. Nothing was staged.`))
    }
    return false
  }

  /** Under the lock: install what is ready. Null when nothing was installed. A paired payload only for a CLI build that
   *  needs its protocol ([forPtyProtocol]), never on its own: it stays ready for that build. */
  const installReady = (forPtyProtocol?: number): StagedHost | null => {
    if (halted || !ready) return null
    const { key, entry, prepared } = ready
    if (prepared.paired && forPtyProtocol !== prepared.protocol) return null
    // Another installer may have moved the pointer, or put a version on probation, since the download began.
    if (!wanted(entry)) return null
    if (existsSync(marker)) { drop(); return null }
    // The install owns the staging folder from here, whatever happens to it.
    ready = null
    let installed: boolean
    try {
      installed = d.install(prepared, opts.rootDir)
    } catch (error) {
      d.discard(prepared)
      if (error instanceof PtyPayloadRefused) { refuse(key, entry.version, error.reason); return null }
      throw error
    }
    if (!installed) return null
    finish()
    installedLast = { key, version: entry.version }
    d.log(`[update] staged terminal host ${entry.version} — handing over`)
    return { version: entry.version, protocol: prepared.protocol, paired: prepared.paired === true }
  }

  // At the updater's start, before any check prepares a staging folder the sweep would take for a stale one.
  const swept = opts.withLock(async () => { d.sweep(opts.rootDir, d.log) })
    .catch((error: unknown) => d.error(`[update] could not sweep the terminal host's leftovers (${message(error)}) — the next start tries again`))

  const tick = async (): Promise<void> => {
    // Booked first, from the clock, as the CLI's: a slow download neither drifts the slot nor ends the chain.
    schedule()
    if (checking) return
    checking = true
    try {
      await swept
      if (halted) return
      if (existsSync(marker)) return
      const entry = await d.fetchEntry(opts.url, opts.key)
      if (halted) return
      // What was prepared is installed only while the manifest still offers it: one withdrawn, replaced or moved back
      // goes, before the CLI's next stage could take it into its handover (`readyToStage`).
      const key = entry ? `${entry.version} ${entry.sha256}` : null
      if (ready && ready.key !== key) drop()
      if (verified && verified.key !== key) verified = null
      if (!entry || key === null || !wanted(entry)) return
      if (!ready) {
        if (refused?.key === key && d.now() < refused.until) return
        once('available', entry.version, () => d.log(`[update] newer terminal host available: ${currentPtyVersion(runtimeDir)} → ${entry.version}`))
        let prepared: PreparedPty
        try {
          prepared = await d.prepare(entry, runtimeDir, verified?.key === key ? verified.zip : undefined)
        } catch (error) {
          if (error instanceof PtyPayloadUnpackFailed) {
            verified = { key, zip: error.zip }
            d.error(`[update] terminal host ${entry.version} was downloaded but could not be unpacked (${error.reason}) — unpacking it again next check, from the bytes already verified`)
            return
          }
          verified = null
          if (!(error instanceof PtyPayloadRefused)) throw error
          refuse(key, entry.version, error.reason)
          return
        }
        verified = null
        ready = { key, entry, prepared, fresh: true }
        if (halted) { drop(); return }
      }
      if (ready.prepared.paired) {
        const { version, protocol } = ready.prepared
        once('paired', version, () => d.log(`[update] terminal host ${version} speaks protocol ${protocol}, above this CLI's ${PTY_PROTOCOL} — it goes in only with a CLI build that needs it`))
        return
      }
      if (ready.fresh) { ready.fresh = false; return }
      const version = ready.entry.version
      await opts.withLock(async () => {
        const staged = installReady()
        // From the marker's write to the master hearing `harnessd:staged` is one IPC send: an updater killed in that
        // window leaves a host on probation this master never judges, until a master's start does (`unjudgedUpdate`).
        if (staged !== null) await opts.onStaged(staged.version)
      }).catch((error: unknown) => {
        // A busy lock is no failed check: the payload is good and waiting, and the next tick tries again.
        if (!(error instanceof SpawnLockBusyError)) throw error
        once('busy', version, () => d.log(`[update] terminal host ${version} is ready but the daemon spawn lock is ${describeSpawnLockFailure(error)} — trying again next check`))
      })
    } catch (error) {
      d.error(`[update] terminal host check failed (will retry): ${message(error)}`)
    } finally {
      checking = false
    }
  }

  schedule()
  return {
    stop: () => {
      stopped = true
      finish()
      // A download under way finds `halted` and discards what it prepared; one already waiting goes now.
      if (!checking) drop()
    },
    takenBack: () => {
      if (stopped || !installedLast) return
      const { key, version } = installedLast
      installedLast = null
      halted = false
      const wait = backOff(key)
      d.log(`[update] terminal host ${version} was taken back out with the build it came with — preparing it again in ${wait}`)
      schedule()
    },
    readyProtocol: () => ready?.prepared.protocol ?? null,
    readyToStage: async (forPtyProtocol?: number) => {
      const version = ready?.entry.version
      try {
        return installReady(forPtyProtocol)
      } catch (error) {
        d.error(`[update] terminal host ${version} could not be installed (${message(error)}) — trying again next check`)
        return null
      }
    },
  }
}

/**
 * The protocol the host `current-pty` names speaks (`harness-pty.exe version`, run once per build: ptyHost/launch.ts
 * `binaryVersion`), or null when there is no pointer or the host cannot be read. The CLI's updater holds back a build
 * that needs more (lib/selfUpdate.ts `installedPtyProtocol`, spec §5's protocol rule).
 */
export function installedPtyProtocol(rootDir: string, version: (binary: string) => { protocol: number } | null = binaryVersion): number | null {
  const runtimeDir = join(rootDir, 'runtime')
  const current = currentPtyVersion(runtimeDir)
  return current === null ? null : version(join(runtimeDir, 'pty', current, 'harness-pty.exe'))?.protocol ?? null
}

/** The aside files (`<name>.old-<pid>-<ms>`) of bin\[name], newest first. */
function asideFiles(bin: string, name: string): string[] {
  const pattern = new RegExp(`^${name.replace(/[.]/g, '\\.')}\\.old-(\\d+)-(\\d+)$`)
  let names: string[]
  try { names = readdirSync(bin) } catch { return [] }
  return names.map((n) => ({ n, m: pattern.exec(n) })).filter((x) => x.m)
    .sort((a, b) => Number(b.m![2]) - Number(a.m![2]) || Number(b.m![1]) - Number(a.m![1])).map((x) => x.n)
}

interface PutBack { restored: Array<{ name: string; from: string }>; failed: Array<{ name: string; from: string; error: unknown }> }

/**
 * Put bin\[name] back from its newest aside file, for each of [names] that is missing and has one: a rollback whose
 * copy back failed, undo and all, leaves the path missing and its last bytes aside (./ptyInstall.ts `PtyRestore`).
 */
export function putBackAside(rootDir: string, names: readonly string[], fs: Pick<PtyInstallFs, 'rename'> = defaultPtyInstallFs): PutBack {
  const bin = join(rootDir, 'bin')
  const result: PutBack = { restored: [], failed: [] }
  for (const name of names) {
    if (existsSync(join(bin, name))) continue
    const from = asideFiles(bin, name)[0]
    if (!from) continue
    try {
      fs.rename(join(bin, from), join(bin, name))
      result.restored.push({ name, from })
    } catch (error) {
      result.failed.push({ name, from, error })
    }
  }
  return result
}

/**
 * What an updater sweeps as it starts, under the lock: staging folders an interrupted check left, stale serve canary homes
 * in the temporary folder (./ptyPayload.ts `sweepCanaryHomes`), and bin\'s aside and temporary files (./ptyInstall.ts
 * `sweepAsideFiles`). A bin file that is missing is put back from its aside file first; while one cannot be, nothing in
 * bin\ is swept, as its aside file holds the only copy of its bytes.
 */
export function sweepPtyLeftovers(rootDir: string, log: (line: string) => void, fs: Partial<PtyInstallFs> = {}): void {
  const all: PtyInstallFs = { ...defaultPtyInstallFs, ...fs }
  sweepStagingFolders(join(rootDir, 'runtime'))
  // A serve canary's temporary home whose removal failed (./ptyPayload.ts `serveCanary`).
  sweepCanaryHomes()
  const put = putBackAside(rootDir, BIN_FILES, all)
  for (const { name, from } of put.restored) log(`[update] put bin\\${name} back from ${from}`)
  for (const { name, from, error } of put.failed) {
    log(`[update] bin\\${name} is missing and ${from} could not be put back (${message(error)}) — nothing is swept until it is`)
  }
  if (put.failed.length === 0) sweepAsideFiles(rootDir, all)
}

/**
 * The master's rollback (its probation's `restoreUpdate`): the CLI build only when one is pending (Windows; off it
 * there is no host payload, and the CLI is restored as it always was), and the host whenever `pty-pending.json`
 * exists. Never throws: the supervisor calls it on its way to the next core.
 */
export function rollBackStaged(o: {
  cliPending: () => boolean
  restoreCli: () => void
  /** The install root on Windows; null elsewhere. */
  ptyRoot: string | null
  log: (line: string) => void
  restorePty?: (rootDir: string) => PtyRestore
  readPending?: (rootDir: string) => PtyPending | null
  /** The daemon spawn lock, around the host's restore: the updater sweeps bin\'s aside files under it, and one of them
   *  may hold the only copy of a path this restore puts back. Left out, none. */
  lock?: SyncSpawnLock
}): void {
  if (o.ptyRoot !== null) {
    const root = o.ptyRoot
    const pending = (o.readPending ?? readPtyPending)(root)
    if (pending || existsSync(join(root, 'runtime', 'pty', PTY_PENDING))) underLock(o.lock, o.log, `rolling terminal host ${pending?.version ?? '(unreadable marker)'} back`, () => {
      try {
        const result = (o.restorePty ?? restorePty)(root)
        if (pending && result.found) {
          o.log(result.pointer
            ? `[harnessd] terminal host ${pending.version} did not come back healthy — back to ${pending.previous}`
            : `[harnessd] terminal host ${pending.version} did not come back healthy — rejected, but ${pending.previous} is no longer there to go back to`)
        }
        // Before anything sweeps: the aside file is the only copy of that path's bytes.
        const put = putBackAside(root, result.missing)
        for (const { name, from } of put.restored) o.log(`[harnessd] put bin\\${name} back from ${from}`)
        for (const { name, from, error } of put.failed) {
          o.log(`[harnessd] bin\\${name} is missing and ${from} could not be put back (${message(error)}) — the updater sweeps nothing until it is`)
        }
        // A marker no one can read names nothing to go back to; left, it would hold every host update back for good.
        if (!pending) {
          rmSync(join(root, 'runtime', 'pty', PTY_PENDING), { force: true })
          o.log('[harnessd] removed an unreadable terminal host probation marker — the host in use stays')
        }
      } catch (error) {
        o.log(`[harnessd] could not roll terminal host ${pending?.version ?? '(unreadable marker)'} back (${message(error)}) — the next probation tries again`)
      }
    })
  }
  if (o.ptyRoot === null || o.cliPending()) o.restoreCli()
}

/** What a master's start finds on probation for the host (masterProcess.ts `unjudgedUpdate`): `terminal host <v>`, or
 *  the same with an unreadable marker, which the rollback clears; null with no marker. */
export function ptyOnProbation(rootDir: string): string | null {
  const pending = readPtyPending(rootDir)
  if (pending) return `terminal host ${pending.version}`
  return existsSync(join(rootDir, 'runtime', 'pty', PTY_PENDING)) ? 'terminal host (unreadable marker)' : null
}

/**
 * Take a paired host back out whose CLI build did not go in with it (spec §5, the pairing rule): left in, the daemon this
 * build runs could open no pane on it, and a master judging it with this build's core would likely keep it. The host
 * goes back as a probation rollback puts it (./ptyInstall.ts `restorePty`, with any missing bin path put back from its
 * aside file), but nothing was wrong with it, so the rejection that rollback records is taken back: it pairs with the
 * next build. Under the lock the install held. Never throws; each line starts with [prefix], or [failedPrefix] when it
 * says what did not happen (`harness update` marks those ✗).
 */
export function takeBackPty(rootDir: string, log: (line: string) => void, prefix: string, failedPrefix: string = prefix): void {
  const pending = readPtyPending(rootDir)
  // Only the rejection this restore adds is taken back: one from before (a version installed anyway, by name) stays.
  const rejectedBefore = rejectedPtyVersions(rootDir)
  try {
    const result = restorePty(rootDir)
    // Before anything sweeps: the aside file is the only copy of that path's bytes.
    const put = putBackAside(rootDir, result.missing)
    for (const { name, from, error } of put.failed) log(`${failedPrefix}bin\\${name} is missing and ${from} could not be put back (${message(error)})`)
    if (!pending) return
    const rejected = rejectedPtyVersions(rootDir)
    if (!rejectedBefore.includes(pending.version) && rejected.includes(pending.version)) {
      const file = join(rootDir, 'runtime', 'pty', PTY_REJECTED)
      const temporary = `${file}.tmp-${process.pid}`
      writeFileSync(temporary, JSON.stringify(rejected.filter((version) => version !== pending.version)))
      renameSync(temporary, file)
    }
    log(result.pointer
      ? `${prefix}terminal host ${pending.version} taken back out with the build it came with — back to ${pending.previous}`
      : `${failedPrefix}terminal host ${pending.version} could not be taken back out: ${pending.previous} is no longer there to go back to — it stays`)
  } catch (error) {
    // The marker stays: a master's start takes a host it cannot speak back out (`ptyUnjudged`), and failing that judges it.
    log(`${failedPrefix}could not take terminal host ${pending?.version ?? '(unreadable marker)'} back out (${message(error)}) — it stays on probation: the next master takes it back out, or judges it and may keep it`)
  }
}

/** The daemon spawn lock for a synchronous caller (lib/daemonSpawnLock.ts `tryAcquireSpawnLockSync`): its release, or null
 *  while it stays busy. */
export type SyncSpawnLock = () => (() => void) | null

/** [fn] under [lock] when one is given. A lock that stays busy is said ([busy]), and [fn] runs all the same, as it ran
 *  before the lock: the probation's verdict, or the next core's start, must not wait on it. */
function underLock<T>(lock: SyncSpawnLock | undefined, log: ((line: string) => void) | undefined, busy: string, fn: () => T): T {
  if (!lock) return fn()
  const release = lock()
  if (!release) log?.(`[harnessd] the daemon spawn lock is busy — ${busy} without it`)
  try {
    return fn()
  } finally {
    release?.()
  }
}

/**
 * What a master's start judges for the host (masterProcess.ts `unjudgedUpdate`), as `ptyOnProbation`, after one case
 * is put right first, under the spawn lock: a host on probation with no CLI build pending ([cliPending]) whose protocol
 * ([protocol], the host `current-pty` names) is outside this build's `SUPPORTED_PTY_PROTOCOLS` is a paired host whose
 * build never went in (a take-back that failed, or a kill between the paired install and the build's stage). Judged
 * with this build's core, which opens no pane on it, it would roll back as a failure, or worse be kept: it is taken back
 * out (`takeBackPty`, no rejection) and nothing is judged. When that fails, its marker stays and it is judged as before.
 */
export function ptyUnjudged(rootDir: string, o: {
  cliPending: boolean
  log: (line: string) => void
  protocol?: (rootDir: string) => number | null
  lock?: SyncSpawnLock
}): string | null {
  const pending = o.cliPending ? null : readPtyPending(rootDir)
  if (!pending) return ptyOnProbation(rootDir)
  const protocol = (o.protocol ?? ((root: string) => installedPtyProtocol(root)))(rootDir)
  if (protocol === null || SUPPORTED_PTY_PROTOCOLS.includes(protocol)) return ptyOnProbation(rootDir)
  return underLock(o.lock, o.log, `taking terminal host ${pending.version} back out`, () => {
    o.log(`[harnessd] terminal host ${pending.version} is on probation with no CLI build, and speaks protocol ${protocol}, which this build does not — taking it back out rather than judging it`)
    takeBackPty(rootDir, o.log, '[harnessd] ')
    return ptyOnProbation(rootDir)
  })
}

/** The master's keep (its probation's `confirmUpdate`): the CLI build and the host both stay. */
export function keepStaged(o: {
  confirmCli: () => void
  ptyRoot: string | null
  confirmPty?: (rootDir: string) => void
  /** Where a host that could not be kept is said. Left out, nowhere. */
  log?: (line: string) => void
  readPending?: (rootDir: string) => PtyPending | null
  /** The daemon spawn lock, around the host's keep, as around its rollback (`rollBackStaged`). Left out, none. */
  lock?: SyncSpawnLock
}): void {
  o.confirmCli()
  if (o.ptyRoot === null) return
  const root = o.ptyRoot
  // Nothing on probation: no lock to wait for.
  const lock = existsSync(join(root, 'runtime', 'pty', PTY_PENDING)) ? o.lock : undefined
  const pending = (o.readPending ?? readPtyPending)(root)
  underLock(lock, o.log, `keeping terminal host ${pending?.version ?? '(unreadable marker)'}`, () => {
    try {
      (o.confirmPty ?? confirmPty)(root)
    } catch (error) {
      // The marker stays, and the poller checks nothing while it does: said, as host updates wait on the next start.
      o.log?.(`[harnessd] could not keep terminal host ${pending?.version ?? '(unreadable marker)'} (${message(error)}) — judged again at the next start`)
    }
  })
}
