/**
 * The master replacing itself with the bundle on disk (docs/design/2026-10-03-harnessd.md, "Updates").
 *
 * An update replaced the core but not the master: the core staged the new bundle and exited 75, the
 * master started a core on it, and went on running its own old code until something restarted it, and
 * so did every master fix. Now, in the gap before a core starts, a master whose code is not the bundle
 * on disk re-executes itself on it (`process.execve`).
 *
 * In place, keeping its pid, rather than handing over to a fresh master: launchd and systemd follow the
 * pid they started (a master that exits is, to them, a job that ended, and its successor runs
 * unsupervised), and so do the pid file, `harness stop` and the desktop app's owner check. Only in the
 * gap: with no core running and the services stopped and reaped first, nothing loses its channel to
 * the master and nothing is orphaned, and the agents live in tmux, out of reach of all of it.
 *
 * What exec gives up is the old master as a fallback, so two things stand in for it:
 *   - a probe: the bundle's own master is asked first (`__harnessd-probe`, `probeMaster` in ./master.ts)
 *     to load and to build itself from the state it would be handed. A bundle from before this answers
 *     "Unknown command", so it is never started as a probe, which could have started a second daemon;
 *     one that fails the probe fails the update, which is rolled back and remembered;
 *   - a marker (`harnessd-reexec.json`): written before the exec, removed once the new master's first
 *     core is up. A master that starts and finds one left by a process that is gone knows that re-exec
 *     never came up, and puts the previous bundle back (`recoverFailedReexec`). Under launchd or systemd,
 *     which restart a master that died, that happens by itself; otherwise at the next `harness start`.
 *
 * Everything that touches the operating system is injected (`ReexecDeps`).
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { closeSync, linkSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { PROBE_ANSWER, PROBE_COMMAND, PROBE_HANDOVER, PROBE_TIMEOUT_MS } from './protocol.js'
import { signedExitCode, type ExitReason, type ReexecOutcome, type ResumeState } from './supervisor.js'

/** The environment variable that hands a master's state to the one it re-executes as. */
export const RESUME_ENV = 'HARNESSD_RESUME'
/** Asked by a core on its own too, before it hands an update to a master (core/updateHandoff.ts): in
 *  ./protocol.ts, which the core's process loads anyway, where this module it does not need is not. */
export { PROBE_ANSWER, PROBE_COMMAND, PROBE_HANDOVER, PROBE_TIMEOUT_MS } from './protocol.js'
/**
 * This many re-executions in a row without a core coming up, and the master keeps its code: each new
 * master found yet another bundle before it could start one, and following them would be a loop. An
 * update that is rolled back takes two (onto the bundle, and back), each brought up a core or tried.
 */
export const REEXEC_LIMIT = 3

/** How much of a file `sha256File` holds at a time. */
const HASH_PIECE_BYTES = 64 * 1024

/**
 * The sha256 of the file at [path], read a piece at a time. A master hashes cli.js, 6.5 MB, and every
 * file of its lean bundle before each process it starts (./leanServices.ts), eight of them as it boots:
 * read whole, each read was a buffer the size of the file, and at idle a master still held 35 to 45 MiB
 * of them, which a collection would have freed but none came (measured 2026-10-06).
 */
export function sha256File(path: string): string {
  const hash = createHash('sha256')
  const fd = openSync(path, 'r')
  try {
    const piece = Buffer.allocUnsafe(HASH_PIECE_BYTES)
    for (let read = readSync(fd, piece); read > 0; read = readSync(fd, piece)) hash.update(piece.subarray(0, read))
  } finally {
    closeSync(fd)
  }
  return hash.digest('hex')
}

/** A file's sha256: which bundle a master runs, or which is on disk; null when it cannot be read. */
export function fingerprint(path: string): string | null {
  try { return sha256File(path) } catch { return null }
}

const EXIT_REASONS: readonly ExitReason[] = ['crashed', 'hung', 'did-not-bind', 'not-ready', 'memory', 'update', 'stopped']

export function encodeResume(state: ResumeState): string {
  return JSON.stringify(state)
}

/** The state a master was handed, or null when there is none or it is not one this code can read. */
export function decodeResume(text: string | undefined): ResumeState | null {
  if (text === undefined) return null
  try {
    const value = JSON.parse(text) as Partial<ResumeState>
    const ok = Number.isInteger(value.restarts) && value.restarts! >= 0
      && (value.lastExit === null || typeof value.lastExit === 'string')
      && (value.lastExitReason === null || EXIT_REASONS.includes(value.lastExitReason as ExitReason))
      && (value.update === null || value.update === 'pending')
      && typeof value.claimed === 'boolean'
      && Number.isInteger(value.reexecs) && value.reexecs! >= 0
      && Number.isInteger(value.unproven) && value.unproven! >= 0
      && (value.handover === undefined || (!!value.handover && Number.isInteger(value.handover.from) && value.handover.from > 0
        && typeof value.handover.token === 'string' && value.handover.token.length > 0))
    return ok ? value as ResumeState : null
  } catch {
    return null
  }
}

/** What a master writes before it re-executes: who, from which bundle to which, and when. */
export interface ReexecMarker {
  pid: number
  from: string | null
  to: string
  at: number
  /** Windows: the handover this marker belongs to (`HandOverDeps.token`). */
  handover?: string
}

export function writeMarker(file: string, marker: ReexecMarker): void {
  const temp = `${file}.${marker.pid}.tmp`
  try {
    writeFileSync(temp, `${JSON.stringify(marker)}\n`)
    renameSync(temp, file)
  } catch (error) {
    // A write cut short (a full disk) is the caller's to handle (`createReexec` keeps its master); what
    // it left in the data folder is this function's to clear.
    try { rmSync(temp, { force: true }) } catch { /* not a file this call wrote */ }
    throw error
  }
}

export function readMarker(file: string): ReexecMarker | null {
  try {
    const marker = JSON.parse(readFileSync(file, 'utf8')) as Partial<ReexecMarker>
    return Number.isInteger(marker.pid) && typeof marker.to === 'string' && typeof marker.at === 'number'
      && (marker.from === null || typeof marker.from === 'string')
      && (marker.handover === undefined || typeof marker.handover === 'string')
      ? marker as ReexecMarker
      : null
  } catch {
    return null
  }
}

export function removeMarker(file: string): void {
  try { rmSync(file, { force: true }) } catch { /* nothing more to do */ }
}

/**
 * Windows, which has no exec: a handover's one decision. The replacement takes the handover (`takeHandover`), or the
 * master that handed over takes it back when it gives up waiting (`takeBackHandover`): each makes the same file, and
 * only one of them can. The replacement claims the pid file only once it took the handover, and the master that
 * handed over leaves only once it can no longer take it back. The file is made by a hard link from a file of the
 * process's own, so it is never there unwritten; a rename would not do, because on Windows two processes renaming the
 * same file away both succeed, the file ending under the last name (measured 2026-10-16 on Windows 11, Node 24: 931
 * of 2000 races; never with a hard link or an exclusive create). The name is the marker's with the token:
 * `readMarker`, `removeMarker` and the marker's own temporary file (`<marker>.<pid>.tmp`) never touch it. It stays
 * after the decision, so a replacement that comes up late finds it made.
 */
const HANDOVER_TOKEN = /^[\w-]{1,64}$/

function handoverFile(file: string, token: string): string {
  // In a file name: one that could reach out of the data folder is refused.
  if (!HANDOVER_TOKEN.test(token)) throw new Error(`not a handover token: ${JSON.stringify(token)}`)
  return `${file}.${token}.handover`
}

/** Make [file] hold [text] if no process has made it yet: true when this call made it, false when one had. */
function decide(file: string, text: string, pid: number): boolean {
  const own = `${file}.${pid}.tmp`
  try {
    writeFileSync(own, text)
    linkSync(own, file)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false
    throw error
  } finally {
    removeMarker(own)
  }
}

/**
 * The replacement, right before it writes the pid file, and before and after it takes the handover: may it still?
 * Only while the marker names this handover and before its cutoff (`HANDOVER_CUTOFF_MS` after the marker's `at`, on
 * [now]). Past it and its margin, the master that handed over stays unless the pid file names another process that
 * runs, and removes the marker.
 */
export function mayClaimPidFile(file: string, token: string, now: () => number = Date.now): boolean {
  const marker = readMarker(file)
  return marker?.handover === token && now() <= marker.at + HANDOVER_CUTOFF_MS
}

/**
 * The replacement: take the handover under [token], saying who took it. True only when this call took it while it
 * still may (`mayClaimPidFile`, asked again once it is taken, for a marker gone in between), and from then on this
 * process is the master and the one to claim the pid file; false when the master that handed over took it back, or it
 * could not be taken. Taken and then refused, the decision is left naming this process: the master that handed over
 * reads it as taken, and stays all the same, the pid file never naming this process (`HandOverDeps`).
 */
export function takeHandover(file: string, token: string, pid: number, now: () => number = Date.now): boolean {
  try {
    if (!mayClaimPidFile(file, token, now)) return false
    return decide(handoverFile(file, token), `${JSON.stringify({ pid })}\n`, pid) && mayClaimPidFile(file, token, now)
  } catch {
    return false
  }
}

/** Who took the handover under [token] (`takeHandover`), or null while no one has, as far as can be read. */
export function readHandoverClaimant(file: string, token: string): number | null {
  try {
    const { pid } = JSON.parse(readFileSync(handoverFile(file, token), 'utf8')) as { pid?: unknown }
    return Number.isInteger(pid) && (pid as number) > 0 ? pid as number : null
  } catch {
    return null
  }
}

/**
 * The master that handed over ([pid]): take the handover back. True when this call took it, and no replacement can
 * take over any more; false when the replacement took it. Throws when neither is known.
 */
export function takeBackHandover(file: string, token: string, pid: number): boolean {
  return decide(handoverFile(file, token), `${JSON.stringify({ abandoned: pid })}\n`, pid)
}

/**
 * A master's start (Windows): the decisions of handovers over and done go, all but [keep]'s, the handover this master
 * took and the one its marker names, which a master that handed over may still be reading.
 */
export function sweepHandovers(file: string, keep: ReadonlyArray<string | undefined>): void {
  const prefix = `${basename(file)}.`
  let names: string[]
  try { names = readdirSync(dirname(file)) } catch { return }
  for (const name of names) {
    if (!name.startsWith(prefix) || !name.endsWith('.handover')) continue
    const token = name.slice(prefix.length, -'.handover'.length)
    if (HANDOVER_TOKEN.test(token) && !keep.includes(token)) removeMarker(join(dirname(file), name))
  }
}

/**
 * At a master's start: did a re-execution before it fail? A marker left by a process that is gone,
 * with the bundle it moved to still on disk, means the master that process became never brought a core
 * up. The previous bundle is put back (`restoreUpdate` also remembers the version, so the updater does
 * not stage it again) and true says so: this master runs that bundle's code and must move off it before
 * it starts anything. A marker that is this process's own is a re-execution in progress, and one whose
 * process lives on is not this master's to judge.
 */
export function recoverFailedReexec(deps: {
  marker: ReexecMarker | null
  pid: number
  alive(pid: number): boolean
  /** The bundle on disk now. */
  current(): string | null
  restoreUpdate(): void
  removeMarker(): void
  log(line: string): void
}): boolean {
  const { marker } = deps
  if (!marker || marker.pid === deps.pid || deps.alive(marker.pid)) return false
  deps.removeMarker()
  if (deps.current() !== marker.to) return false
  deps.restoreUpdate()
  deps.log(`[harnessd] the master that re-executed on the new bundle (pid ${marker.pid}) never brought a core up — rolled back to the previous bundle`)
  return true
}

export interface ProbeResult {
  ok: boolean
  detail: string
  /** The bundle's master says it takes a handover (`PROBE_HANDOVER`); left out, it does not. */
  handover?: true
}

/** Run a bundle's master probe: `node <flags> <bundle> __harnessd-probe`, which must answer in time. */
export function runProbe(
  nodePath: string, args: string[], env: NodeJS.ProcessEnv, timeoutMs = PROBE_TIMEOUT_MS,
  start: (file: string, args: string[], env: NodeJS.ProcessEnv) => ChildProcess = (file, argv, environment) => spawn(file, argv, { env: environment, stdio: ['ignore', 'pipe', 'pipe'] }),
): { result: Promise<ProbeResult>; cancel(): void } {
  const child = start(nodePath, args, env)
  // Apart: a bundle from before probes answers with its usage on stdout and the reason on stderr.
  let out = ''
  let err = ''
  child.stdout?.on('data', (chunk: Buffer) => { out += chunk.toString('utf8') })
  child.stderr?.on('data', (chunk: Buffer) => { err += chunk.toString('utf8') })
  const lastLine = (text: string): string => { const lines = text.trim().split('\n'); return lines[lines.length - 1].trim() }
  const result = new Promise<ProbeResult>((resolve) => {
    let settled = false
    const done = (ok: boolean, detail: string, handover = false) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ ok, detail, ...(handover ? { handover: true } : {}) })
    }
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL') } catch { /* gone */ }
      done(false, `no answer within ${timeoutMs} ms`)
    }, timeoutMs)
    child.on('error', (error) => done(false, error.message))
    child.on('close', (code, signal) => {
      const ok = code === 0 && out.includes(PROBE_ANSWER)
      done(ok, lastLine(err) || lastLine(out) || (signal ? `signal ${signal}` : `exit ${signedExitCode(code)}`), ok && out.includes(PROBE_HANDOVER))
    })
  })
  return { result, cancel: () => { try { child.kill('SIGKILL') } catch { /* gone */ } } }
}

export interface ReexecDeps {
  /** The bundle this master was started from: its code. */
  own: string | null
  /** The bundle on disk now. */
  current(): string | null
  /** What a re-executed master runs: this node, these flags, this bundle. */
  nodePath: string
  execArgv: string[]
  scriptPath: string
  /** The master's own environment; the resume state is added to it. */
  env: NodeJS.ProcessEnv
  pid: number
  /** `process.execve`, where this Node has it (22.15 and 23.11 on). */
  execve: ((file: string, args: string[], env: NodeJS.ProcessEnv) => void) | null
  /** Whether a file is there: the node binary and the bundle, checked right before the exec. */
  exists(path: string): boolean
  probe(args: string[], env: NodeJS.ProcessEnv): { result: Promise<ProbeResult>; cancel(): void }
  /** Stop the services and wait for them to be gone, so none is left a zombie or an orphan. */
  stopChildren(done: () => void): void
  /** Start them again, when this master carries on as itself. */
  startChildren(): void
  writeMarker(marker: ReexecMarker): void
  removeMarker(): void
  /** The master is stopping: nothing is replaced or restarted then. */
  stopping(): boolean
  /** The wall clock, ms. */
  now(): number
  log(line: string): void
  /**
   * Windows has no exec (`process.execve` is not there): the replacement is a new process, started through
   * harness-launch.exe, and this master leaves once it holds the pid file. Still only in the gap before a core starts,
   * the services stopped and reaped first (./AGENTS.md rule 6). Left out, `execve`.
   */
  handOver?: HandOverDeps
}

/** How long the replacement has to start and claim the pid file: Node loading cli.js, under an antivirus scan. */
export const HANDOVER_WAIT_MS = 30_000
export const HANDOVER_POLL_MS = 250
/** After this, from the marker's `at`, no replacement takes the handover (`takeHandover`). */
export const HANDOVER_CUTOFF_MS = 2 * HANDOVER_WAIT_MS
/** And this much past it, for one that read the marker in time and was a moment writing the pid file (a stall under an
 *  antivirus scan), this master waits before it settles on what the pid file says. */
export const HANDOVER_CUTOFF_MARGIN_MS = 20_000
/** How long a master that is stopping tries to take the handover back. */
export const HANDOVER_STOP_BUDGET_MS = 2_000

export interface HandOverDeps {
  /**
   * The daemon spawn lock (lib/daemonSpawnLock.ts), held from before the replacement starts until this master leaves,
   * so a `harness stop` waits for the handover to finish rather than stop the master on its way out while the new one
   * comes up, and the scheduled task's `harness start --if-down` does nothing meanwhile. Null when it is busy; a
   * rejection (`SpawnLockBusyError`) is taken as busy.
   */
  lock(): Promise<(() => void) | null>
  /**
   * Write this master's pid to the pid file. Before the replacement starts, so that what the file held before (a
   * crash's, a pid Windows has since given to another process) is never taken for it: under the lock, the replacement
   * is the only other writer. Again when this master stays and the file no longer names it.
   */
  claim(): void
  /** Start `__harnessd` on the bundle on disk with [env]; null once it is started, why not otherwise. */
  launch(env: NodeJS.ProcessEnv): Promise<string | null>
  /** Who the pid file names now, and whether that runs. A throw from either is taken as not known. */
  readPid(): number | null
  alive(pid: number): boolean
  /** Who took the handover (`readHandoverClaimant`), null while no one has; a throw, as not known. */
  claimant(token: string): number | null
  /**
   * Take the handover back (`takeBackHandover`, as this master): false once the replacement took it. A throw is not
   * known, and is tried again every HANDOVER_POLL_MS, up to the replacement's cutoff (`takeHandover`) and its margin.
   */
  takeBack(token: string): boolean
  sleep(ms: number): Promise<void>
  /** A fresh token naming this handover in the marker, the state handed on and its decision: letters, digits, - and _. */
  token(): string
  /** This master's end: the replacement holds the pid file. The spawn lock is released just before (./reexec.ts). */
  leave(): void
}

/** The supervisor's `reexec`, and a way to abandon a probe still running when the master stops. */
export function createReexec(deps: ReexecDeps): {
  reexec(state: ResumeState, proceed: (outcome: ReexecOutcome) => void): void
  cancel(): void
  /** On its way to replacing this master: from stopping its children until it carries on as itself. */
  replacing(): boolean
  /**
   * Once no handover is under way (Windows), [done]: true when this master handed over, the pid file and the marker
   * then the new master's, never this one's to remove; at once when none is. Asked as the master stops.
   */
  settled(done: (handedOver: boolean) => void): void
} {
  let warned = false
  let probe: { cancel(): void } | null = null
  let replacing = false
  let handing: Promise<void> | null = null
  let handedOver = false
  const message = (error: unknown): string => error instanceof Error ? error.message : String(error)

  /**
   * Windows. The replacement holds the machine once it took the handover (`takeHandover`) and the pid file names it, so
   * a pid file written by anything else, or a replacement from another handover, is never taken for this one's.
   */
  const handOver = async (h: HandOverDeps, next: string, state: ResumeState, carryOn: (outcome: ReexecOutcome) => void): Promise<void> => {
    let busy = 'the daemon spawn lock is busy'
    const release = await h.lock().catch((error: unknown) => {
      busy = `could not take the daemon spawn lock (${message(error)})`
      return null
    })
    if (deps.stopping()) { release?.(); return }
    if (!release) {
      deps.log(`[harnessd] ${busy} — keeping this master`)
      carryOn('kept')
      return
    }
    const stay = (why: string): void => {
      release()
      deps.log(`[harnessd] ${why} — keeping this master`)
      carryOn('kept')
    }
    if (!deps.exists(deps.scriptPath)) { stay(`${deps.scriptPath} is not there to hand over to`); return }
    const token = h.token()
    // A name for the handover's decision file (`takeBackHandover`): with any other, every handover would only time out.
    if (!HANDOVER_TOKEN.test(token)) { stay(`the handover token ${JSON.stringify(token)} is not one a file can be named by`); return }
    try { h.claim() } catch (error) { stay(`could not claim the pid file (${message(error)})`); return }
    // Now, not as the re-execution began: stopping the children and the probe took up to PROBE_TIMEOUT_MS of it.
    const at = deps.now()
    // No replacement takes the handover or claims the pid file after its cutoff (`mayClaimPidFile`): past that and
    // its margin, this master settles on what the pid file says.
    const until = at + HANDOVER_CUTOFF_MS + HANDOVER_CUTOFF_MARGIN_MS
    try {
      deps.writeMarker({ pid: deps.pid, from: deps.own, to: next, at, handover: token })
    } catch (error) {
      stay(`could not leave the re-execution marker (${message(error)})`)
      return
    }

    // This master leaves only on a successor proven, and stays only on the handover proven taken back, or once no
    // replacement can take it any more; on anything not known, it holds the spawn lock, its children stopped, and
    // looks again.

    // The replacement holds the pid file: this master lets go of the spawn lock and leaves. The replacement never
    // takes the lock again, so this release is what frees it, and it comes only once the pid file names a live
    // successor: until then a `harness stop` waits rather than land on a master on its way out.
    const leave = (why: string): void => {
      deps.log(`[harnessd] ${why} — leaving`)
      handedOver = true
      release()
      h.leave()
    }
    // What the deps say, a throw read as not known.
    const claimant = (): number | null => { try { return h.claimant(token) } catch { return null } }
    const runs = (pid: number): boolean | null => { try { return h.alive(pid) } catch { return null } }
    /** Who took the handover, alive, and named by the pid file. */
    const successor = (): number | null => {
      const pid = claimant()
      if (pid === null) return null
      try { return pid === h.readPid() && runs(pid) === true ? pid : null } catch { return null }
    }
    // True: taken back; false: the replacement took it; null: not known (on Windows, the folder held by a scan).
    let unknownSaid = false
    const takeBack = (): boolean | null => {
      if (claimant() !== null) return false
      try {
        return h.takeBack(token)
      } catch (error) {
        if (!unknownSaid) deps.log(`[harnessd] could not take the handover back yet (${message(error)}) — trying again`)
        unknownSaid = true
        return null
      }
    }
    // A sleep that fails is a pause cut short: every wait below is bounded by the clock, not by the number of pauses.
    const pause = (): Promise<void> => h.sleep(HANDOVER_POLL_MS).catch(() => undefined)
    const stayOn = (why: string): void => {
      try {
        if (h.readPid() !== deps.pid) h.claim()
      } catch (error) {
        deps.log(`[harnessd] could not claim the pid file back (${message(error)})`)
      }
      stay(why)
    }
    const keep = (why: string): void => {
      deps.removeMarker()
      stayOn(why)
    }
    /**
     * Stopping: no replacement may take over now, unless it already has. Not known within HANDOVER_STOP_BUDGET_MS, the
     * marker goes, and with it the handover (`takeHandover` takes it only while the marker names it), but for a
     * replacement already between reading the marker and taking it: that one runs as the master while this one ends.
     * The children are stopped and this master is ending either way, so what is not known costs a machine with no
     * master until the next start, or a stop that did not stop the new one; never two masters.
     */
    const stop = async (): Promise<void> => {
      const until = deps.now() + HANDOVER_STOP_BUDGET_MS
      for (;;) {
        const back = takeBack()
        if (back === false) { handedOver = true; release(); return }
        if (back === true || deps.now() >= until) { deps.removeMarker(); release(); return }
        await pause()
      }
    }
    /**
     * The replacement took the handover: this master leaves once the pid file names it, and stays if it ended. Past the
     * cutoff and its margin no replacement claims the pid file any more, and this master stays only on a pid file that
     * names no process but this one that runs: a machine left with no master is started again (`harness start
     * --if-down`), two masters are noticed by nothing.
     */
    const taken = async (): Promise<void> => {
      for (;;) {
        const pid = successor()
        if (pid !== null) { leave(`handed over to the new master (pid ${pid})`); return }
        const who = claimant()
        if (who !== null && runs(who) === false) { keep(`the new master (pid ${who}) took over and then ended`); return }
        if (deps.now() >= until) {
          let named: number | null
          try {
            named = h.readPid()
          } catch (error) {
            leave(`the new master took over, and the pid file cannot be read (${message(error)})`)
            return
          }
          if (named !== null && named !== deps.pid && runs(named) !== false) { leave(`the new master took over, and the pid file names pid ${named}`); return }
          keep('the new master took over but never claimed the pid file')
          return
        }
        await pause()
        // Stopping: the replacement is the master now, and the marker is not this one's to remove.
        if (deps.stopping()) { handedOver = true; release(); return }
      }
    }
    /** The wait is over, for [why]: whose is the handover? */
    const settle = async (why: string): Promise<void> => {
      for (;;) {
        const pid = successor()
        if (pid !== null) { leave(`handed over to the new master (pid ${pid})`); return }
        const back = takeBack()
        if (back === true) { keep(why); return }
        if (back === false) { await taken(); return }
        if (deps.now() >= until) {
          // Past the cutoff: the marker goes, and then who took the handover is read once more, for one that took it as
          // this master gave up on knowing.
          deps.removeMarker()
          if (claimant() !== null) { await taken(); return }
          stayOn(`${why}, and no new master can take over any more`)
          return
        }
        await pause()
        if (deps.stopping()) { await stop(); return }
      }
    }

    const env = {
      ...deps.env,
      [RESUME_ENV]: encodeResume({ ...state, reexecs: state.reexecs + 1, unproven: state.unproven + 1, claimed: true, handover: { from: deps.pid, token } }),
    }
    // The successor's pid; why this master stays; or null once it is stopping.
    const wait = async (): Promise<number | string | null> => {
      const failed = await h.launch(env)
      if (deps.stopping()) return null
      if (failed !== null) return `could not start the new master (${failed})`
      const deadline = deps.now() + HANDOVER_WAIT_MS
      for (;;) {
        const pid = successor()
        if (pid !== null) return pid
        if (deps.now() >= deadline) return `the new master did not take over within ${HANDOVER_WAIT_MS} ms`
        await h.sleep(HANDOVER_POLL_MS)
        if (deps.stopping()) return null
      }
    }
    const outcome = await wait().catch((error: unknown) => (deps.stopping() ? null : `the handover failed (${message(error)})`))
    if (outcome === null) { await stop(); return }
    if (typeof outcome === 'string') { await settle(outcome); return }
    leave(`handed over to the new master (pid ${outcome})`)
  }

  return {
    reexec: (state, proceed) => {
      const next = deps.current()
      if (next === null || next === deps.own) { proceed('same'); return }
      if (!deps.execve && !deps.handOver) {
        if (!warned) deps.log('[harnessd] the bundle on disk is newer than this master, but this Node cannot re-execute a process: the master keeps its code until it restarts')
        warned = true
        proceed('kept')
        return
      }
      if (state.unproven >= REEXEC_LIMIT) {
        deps.log(`[harnessd] this master re-executed ${state.unproven} times without a core coming up — keeping its code; something keeps rewriting the bundle`)
        proceed('kept')
        return
      }
      const now = deps.now()
      const env = { ...deps.env, [RESUME_ENV]: encodeResume({ ...state, reexecs: state.reexecs + 1, unproven: state.unproven + 1 }) }
      const args = [...deps.execArgv, deps.scriptPath]
      // Called only once the master is known not to be stopping: its children come back, and its core.
      const carryOn = (outcome: ReexecOutcome) => {
        replacing = false
        deps.startChildren()
        proceed(outcome)
      }
      deps.log('[harnessd] the bundle on disk is not this master\'s code — re-executing on it')
      replacing = true
      deps.stopChildren(() => {
        if (deps.stopping()) return
        const running = deps.probe([...args, PROBE_COMMAND], env)
        probe = running
        void running.result.then((result) => {
          const { ok, detail } = result
          probe = null
          if (deps.stopping()) return
          if (!ok) {
            deps.log(`[harnessd] the new bundle's master did not answer its probe (${detail}) — keeping this master`)
            carryOn('refused')
            return
          }
          if (deps.handOver) {
            if (!result.handover) {
              deps.log('[harnessd] the new bundle\'s master cannot take a handover — keeping this master')
              carryOn('kept')
              return
            }
            handing = handOver(deps.handOver, next, state, carryOn)
            return
          }
          try {
            deps.writeMarker({ pid: deps.pid, from: deps.own, to: next, at: now })
          } catch (error) {
            // A full disk (e2e/updateHostile.e2e.ts). Thrown from here, it was a rejection nothing handles,
            // which ends a master that has no core and no services running at this point. Without the
            // marker a re-execution that never came up would be taken for one in progress, so this master
            // keeps its code and starts the core on the new bundle itself, judging it as every update.
            deps.log(`[harnessd] could not leave the re-execution marker (${error instanceof Error ? error.message : String(error)}) — keeping this master`)
            carryOn('kept')
            return
          }
          // An exec that fails cannot be caught once it has begun: on Node 22.23 a node binary that is not
          // there aborts this process (exit 134), and a bundle that is not there ends it in the new image
          // (MODULE_NOT_FOUND), the marker left behind for the next master to roll the update back. Both
          // were there for the probe a moment ago; they are checked again here, right before.
          const missing = [deps.nodePath, deps.scriptPath].find((path) => !deps.exists(path))
          if (missing) {
            deps.removeMarker()
            deps.log(`[harnessd] ${missing} is not there to re-execute on — keeping this master`)
            carryOn('kept')
            return
          }
          try {
            // Never returns: from here this process is the new bundle's master, with the same pid.
            deps.execve!(deps.nodePath, [deps.nodePath, ...args, '__harnessd'], env)
          } catch (error) {
            // Only what `process.execve` refuses before it begins: arguments it cannot take.
            deps.removeMarker()
            deps.log(`[harnessd] could not re-execute this master (${error instanceof Error ? error.message : String(error)}) — keeping it`)
            carryOn('kept')
          }
        })
      })
    },
    cancel: () => { probe?.cancel(); probe = null },
    replacing: () => replacing,
    settled: (done) => {
      if (!handing) { done(handedOver); return }
      const decided = (): void => done(handedOver)
      void handing.then(decided, decided)
    },
  }
}
