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
import { closeSync, openSync, readFileSync, readSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { PROBE_ANSWER, PROBE_COMMAND, PROBE_TIMEOUT_MS } from './protocol.js'
import type { ExitReason, ReexecOutcome, ResumeState } from './supervisor.js'

/** The environment variable that hands a master's state to the one it re-executes as. */
export const RESUME_ENV = 'HARNESSD_RESUME'
/** Asked by a core on its own too, before it hands an update to a master (core/updateHandoff.ts): in
 *  ./protocol.ts, which the core's process loads anyway, where this module it does not need is not. */
export { PROBE_ANSWER, PROBE_COMMAND, PROBE_TIMEOUT_MS } from './protocol.js'
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

export interface ProbeResult { ok: boolean; detail: string }

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
    const done = (ok: boolean, detail: string) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ ok, detail })
    }
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL') } catch { /* gone */ }
      done(false, `no answer within ${timeoutMs} ms`)
    }, timeoutMs)
    child.on('error', (error) => done(false, error.message))
    child.on('close', (code, signal) => {
      done(code === 0 && out.includes(PROBE_ANSWER), lastLine(err) || lastLine(out) || (signal ? `signal ${signal}` : `exit ${code}`))
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

export interface HandOverDeps {
  /**
   * The daemon spawn lock (lib/daemonSpawnLock.ts), held from before the replacement starts until this master leaves,
   * so a `harness stop` waits for the handover to finish rather than stop the master on its way out while the new one
   * comes up, and the scheduled task's `harness start --if-down` does nothing meanwhile. Null when it is busy.
   */
  lock(): Promise<(() => void) | null>
  /** Start `__harnessd` on the bundle on disk with [env]; null once it is started, why not otherwise. */
  launch(env: NodeJS.ProcessEnv): Promise<string | null>
  /** Who the pid file names now, and whether that runs. */
  readPid(): number | null
  alive(pid: number): boolean
  sleep(ms: number): Promise<void>
  /** A fresh token naming this handover in the marker and the state handed on. */
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
} {
  let warned = false
  let probe: { cancel(): void } | null = null
  let replacing = false
  const successor = (h: HandOverDeps): number | null => {
    const pid = h.readPid()
    return pid !== null && pid !== deps.pid && h.alive(pid) ? pid : null
  }

  /**
   * Windows. The marker names this handover's token: the replacement takes it (and the pid file) only while it still
   * does (./master.ts), and this master takes it back when it gives up waiting, so a replacement that comes up late
   * leaves rather than run beside this one. One that claimed the pid file as this master gave up keeps the machine.
   */
  const handOver = async (h: HandOverDeps, next: string, state: ResumeState, at: number, carryOn: (outcome: ReexecOutcome) => void): Promise<void> => {
    const release = await h.lock()
    if (deps.stopping()) { release?.(); return }
    if (!release) {
      deps.log('[harnessd] the daemon spawn lock is busy — keeping this master')
      carryOn('kept')
      return
    }
    const token = h.token()
    const keep = (why: string): void => {
      deps.removeMarker()
      release()
      deps.log(`[harnessd] ${why} — keeping this master`)
      carryOn('kept')
    }
    // The replacement holds the pid file: this master lets go of the spawn lock and leaves. The replacement never
    // takes the lock again, so this release is what frees it, and it comes only once the pid file names a live
    // successor: until then a `harness stop` waits rather than land on a master on its way out.
    const leave = (): void => {
      release()
      h.leave()
    }
    try {
      deps.writeMarker({ pid: deps.pid, from: deps.own, to: next, at, handover: token })
    } catch (error) {
      release()
      deps.log(`[harnessd] could not leave the re-execution marker (${error instanceof Error ? error.message : String(error)}) — keeping this master`)
      carryOn('kept')
      return
    }
    if (!deps.exists(deps.scriptPath)) { keep(`${deps.scriptPath} is not there to hand over to`); return }
    const env = {
      ...deps.env,
      [RESUME_ENV]: encodeResume({ ...state, reexecs: state.reexecs + 1, unproven: state.unproven + 1, claimed: true, handover: { from: deps.pid, token } }),
    }
    const failed = await h.launch(env)
    if (deps.stopping()) { deps.removeMarker(); release(); return }
    if (failed !== null) { keep(`could not start the new master (${failed})`); return }
    const deadline = deps.now() + HANDOVER_WAIT_MS
    for (;;) {
      const pid = successor(h)
      if (pid !== null) {
        deps.log(`[harnessd] handed over to the new master (pid ${pid}) — leaving`)
        leave()
        return
      }
      if (deps.now() >= deadline) break
      await h.sleep(HANDOVER_POLL_MS)
      // A stop meanwhile is the master's own exit to finish (./master.ts removes the marker it still names).
      if (deps.stopping()) return
    }
    deps.removeMarker()
    if (successor(h) !== null) { leave(); return }
    release()
    deps.log(`[harnessd] the new master did not take over within ${HANDOVER_WAIT_MS} ms — keeping this master`)
    carryOn('kept')
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
        void running.result.then(({ ok, detail }) => {
          probe = null
          if (deps.stopping()) return
          if (!ok) {
            deps.log(`[harnessd] the new bundle's master did not answer its probe (${detail}) — keeping this master`)
            carryOn('refused')
            return
          }
          if (deps.handOver) { void handOver(deps.handOver, next, state, now, carryOn); return }
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
  }
}
