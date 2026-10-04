/**
 * Conversations on this machine that Harness did not start: sessions people ran in a terminal, an
 * editor or an engine's app. Found where each engine keeps them, so Cmd-P and the welcome page can
 * find them and open one in Harness (`agent_create` with `resumeSessionId`), taking it over from a
 * terminal that still has it.
 *
 * Each engine is a provider (`externals/<engine>.ts`): how it lists its conversations, which process
 * has one open, and whether that process is mid-turn. This file joins them: one list, one look at
 * the machine's processes, and one way to stop a terminal's process.
 */

import { open } from 'node:fs/promises'

import { harnessTtys as readHarnessTtys, processAlive, processTtys, processView, run, scanMemo } from './externals/support.js'
import type { ExternalEngine, ExternalProvider, ExternalSession, OwnerClaim, ProcessView } from './externals/types.js'

export type { ExternalEngine, ExternalOrigin, ExternalProvider, ExternalSession } from './externals/types.js'
export { processAlive } from './externals/support.js'

export interface ExternalSessionsOptions {
  providers: readonly ExternalProvider[]
  /** Folders whose sessions are Harness's own byproducts (its data folder): never offered. */
  excluded?: readonly string[]
  log?: (line: string) => void
}

export class ExternalSessions {
  private found: ExternalSession[] = []
  private byId = new Map<string, ExternalSession>()
  private readonly lastGood = new Map<ExternalEngine, ExternalSession[]>()
  private scanning: Promise<ExternalSession[]> | null = null
  private readonly memo

  constructor(private readonly opts: ExternalSessionsOptions) {
    this.memo = scanMemo({ excluded: opts.excluded ?? [] })
  }

  /** What the last scan found, newest first. */
  list(): readonly ExternalSession[] { return this.found }

  get(sessionId: string): ExternalSession | undefined { return this.byId.get(sessionId) }

  /** Looks again. One scan at a time: a second caller shares the one in progress. */
  scan(): Promise<ExternalSession[]> {
    this.scanning ??= this.scanOnce().finally(() => { this.scanning = null })
    return this.scanning
  }

  private async scanOnce(): Promise<ExternalSession[]> {
    const ctx = this.memo.context()
    const all: ExternalSession[] = []
    for (const provider of this.opts.providers) {
      try {
        const sessions = await provider.scan(ctx)
        this.lastGood.set(provider.engine, sessions)
        all.push(...sessions)
      } catch (error) {
        // One engine's store failing (locked, mid-migration) keeps what it said last time.
        this.opts.log?.(`[search] ${provider.engine} sessions not read: ${error instanceof Error ? error.message : error}`)
        all.push(...this.lastGood.get(provider.engine) ?? [])
      }
    }
    this.memo.prune()
    all.sort((a, b) => b.mtime - a.mtime)
    // One id, one conversation: the newest record of it wins.
    const byId = new Map<string, ExternalSession>()
    for (const session of all) if (!byId.has(session.sessionId)) byId.set(session.sessionId, session)
    this.found = [...byId.values()]
    // An older id of a conversation that carried on under a new one finds the conversation.
    for (const session of this.found) {
      for (const alias of session.aliases ?? []) if (!byId.has(alias)) byId.set(alias, session)
    }
    this.byId = byId
    return this.found
  }
}

/**
 * Where an open session is: a terminal, which Harness can take it over from; an app, which it cannot;
 * one of Harness's own panes, whose agent the daemon is still binding; or `maybe` a terminal, whose
 * process was started on it and may have moved on since (`OwnerClaim.fromArgs`).
 */
export type OpenIn = 'terminal' | 'app' | 'harness' | 'maybe'

/** The process that has a session open. */
export interface SessionOwner {
  pid: number
  engine: ExternalEngine
  /** The terminal it runs in (`/dev/ttys003`), or null for an app: an app is never stopped from here. */
  tty: string | null
  /** What says whether it is mid-turn: a record, a transcript, a database. */
  record: string
  /** It runs in one of Harness's own panes: an agent of Harness's, never an outside conversation. */
  harness?: boolean
  /** Only its arguments name the session: it may have moved on, and is never stopped from here. */
  fromArgs?: boolean
  /** Harness's own panes could not be listed, so this one may be Harness's: never stopped from here. */
  unverified?: boolean
}

export interface OpenSessionsOptions {
  providers: readonly ExternalProvider[]
  /** How long an answer is reused. */
  maxAgeMs?: number
  /** A fresh look at the machine's processes; tests replace it. */
  view?: () => ProcessView
  /** The terminal each process runs in, or null; tests replace it. */
  ttys?: (pids: number[]) => Promise<Map<number, string | null>>
  /** The terminals of Harness's own panes, or null when they could not be listed; tests replace it. */
  harnessTtys?: () => Promise<Set<string> | null>
  now?: () => number
  log?: (line: string) => void
}

type OpenAnswer = { at: number; owners: Map<string, SessionOwner>; open: Map<string, OpenIn> }

/**
 * Which sessions are open in a running process right now, so Cmd-P does not open one a second time
 * beside a terminal that still has it: both would write the same conversation. One open in a
 * terminal can be taken over instead (`owner`, `stopSessionOwner`).
 *
 * Only exact evidence counts: a process's own record, a lock it holds, a file it has open, the id in
 * its arguments. A guess from a folder is never enough to stop a process.
 */
export class OpenSessions {
  private answer: OpenAnswer | null = null
  private asking: Promise<OpenAnswer> | null = null

  constructor(private readonly opts: OpenSessionsOptions) {}

  /** The last answer, however old; empty before the first. Never waits. */
  known(): ReadonlyMap<string, OpenIn> {
    const now = (this.opts.now ?? Date.now)()
    if (!this.answer || now - this.answer.at > (this.opts.maxAgeMs ?? 5_000)) void this.fresh()
    return this.answer?.open ?? new Map()
  }

  /** An answer at most `maxAgeMs` old. */
  async fresh(): Promise<ReadonlyMap<string, OpenIn>> {
    return (await this.current()).open
  }

  /** The process that has [sessionId] open, looked at now rather than taken from a recent answer. */
  async owner(sessionId: string): Promise<SessionOwner | null> {
    if (!this.asking) this.answer = null
    return (await this.current()).owners.get(sessionId) ?? null
  }

  /** Whether [owner] is mid-turn. An engine whose store cannot say counts as busy: the answer only
   *  decides whether to ask before stopping it. */
  async busy(owner: Pick<SessionOwner, 'engine' | 'pid' | 'record'>): Promise<boolean> {
    const provider = this.opts.providers.find((candidate) => candidate.engine === owner.engine)
    const said = await provider?.busy?.(owner).catch(() => null)
    return said ?? true
  }

  /** Display state, unlike the conservative stop guard above: unknown is never called working. */
  async working(sessionId: string): Promise<boolean | null> {
    const owner = (await this.current()).owners.get(sessionId)
    if (!owner) return false
    if (owner.fromArgs) return null
    const provider = this.opts.providers.find((candidate) => candidate.engine === owner.engine)
    return await provider?.busy?.(owner).catch(() => null) ?? null
  }

  private current(): Promise<OpenAnswer> {
    const now = (this.opts.now ?? Date.now)()
    if (this.answer && now - this.answer.at <= (this.opts.maxAgeMs ?? 5_000)) return Promise.resolve(this.answer)
    this.asking ??= this.read().then((owners) => {
      const open = new Map([...owners].map(([id, owner]): [string, OpenIn] => [
        id, owner.harness ? 'harness' : !owner.tty ? 'app' : owner.fromArgs || owner.unverified ? 'maybe' : 'terminal',
      ]))
      this.answer = { at: (this.opts.now ?? Date.now)(), owners, open }
      return this.answer
    }).finally(() => { this.asking = null })
    return this.asking
  }

  private async read(): Promise<Map<string, SessionOwner>> {
    const view = (this.opts.view ?? (() => processView()))()
    const claims: Array<OwnerClaim & { engine: ExternalEngine }> = []
    for (const provider of this.opts.providers) {
      if (!provider.owners) continue
      try {
        for (const claim of await provider.owners(view)) claims.push({ ...claim, engine: provider.engine })
      } catch (error) {
        this.opts.log?.(`[search] ${provider.engine} owners not read: ${error instanceof Error ? error.message : error}`)
      }
    }
    const owners = new Map<string, SessionOwner>()
    if (!claims.length) return owners
    const [ttys, harness] = await Promise.all([
      (this.opts.ttys ?? ((pids) => processTtys(pids)))([...new Set(claims.map((claim) => claim.pid))]).catch(() => new Map<number, string | null>()),
      (this.opts.harnessTtys ?? (() => readHarnessTtys()))().catch(() => null),
    ])
    for (const claim of claims) {
      const tty = claim.app ? null : ttys.get(claim.pid) ?? null
      const owner: SessionOwner = {
        pid: claim.pid, engine: claim.engine, tty, record: claim.record,
        ...(tty && harness?.has(tty) ? { harness: true } : {}),
        ...(tty && !harness ? { unverified: true } : {}),
        ...(claim.fromArgs ? { fromArgs: true } : {}),
      }
      // Hard evidence outranks a process's arguments for the same session.
      const known = owners.get(claim.sessionId)
      if (!known || (known.fromArgs && !owner.fromArgs)) owners.set(claim.sessionId, owner)
    }
    return owners
  }
}

export interface StopOptions {
  alive?: (pid: number) => boolean
  kill?: (pid: number, signal: NodeJS.Signals) => void
  sleep?: (ms: number) => Promise<void>
  /** Writes to the owner's terminal; tests replace it. */
  writeTty?: (tty: string, text: string) => Promise<void>
  /** The foreground job [pid] leads, if it leads one; tests replace it. */
  job?: (pid: number) => Promise<number | null>
}

/**
 * The foreground job an engine leads in its terminal: the process group it heads, when that group is
 * the one the terminal is showing. Its whole job is signalled then, so what it started for its screen
 * goes with it (Hermes's terminal UI runs a Node child its Python does not pass SIGTERM to). An
 * engine that does not lead its job (Codex's native binary under its Node launcher, anything run
 * without job control) is signalled alone: its group may hold the shell it runs in.
 */
export async function foregroundJob(pid: number, exec: typeof run = run): Promise<number | null> {
  const out = await exec('ps', ['-o', 'pgid=,tpgid=', '-p', String(pid)], 3_000)
  const [pgid, tpgid] = (out ?? '').trim().split(/\s+/).map(Number)
  return pgid === pid && tpgid === pid ? pid : null
}

/**
 * What a terminal gets back after its engine is stopped from outside: the main screen, no mouse
 * reporting, and a cursor. A TUI that quit cleanly already restored them, and then these change
 * nothing; Codex leaves its cursor hidden, and a TUI made to quit leaves whatever it had on.
 */
export const TERMINAL_RESTORE = '\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?1049l\x1b[?25h'

/**
 * Stops the terminal process that has a session open, so Harness can resume it: asked to quit
 * (SIGTERM, which the engines answer by saving and restoring the terminal), then made to after five
 * seconds, and the terminal put back. Whether the process is gone.
 */
export async function stopSessionOwner(owner: Pick<SessionOwner, 'pid' | 'tty'>, opts: StopOptions = {}): Promise<boolean> {
  const alive = opts.alive ?? processAlive
  const kill = opts.kill ?? ((pid: number, signal: NodeJS.Signals) => { process.kill(pid, signal) })
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const gone = async (ms: number): Promise<boolean> => {
    for (let waited = 0; waited < ms; waited += 100) {
      if (!alive(owner.pid)) return true
      await sleep(100)
    }
    return !alive(owner.pid)
  }
  const job = await (opts.job ?? foregroundJob)(owner.pid).catch(() => null)
  const signal = (name: NodeJS.Signals): void => {
    try { kill(job ? -job : owner.pid, name) } catch { /* already gone */ }
  }
  signal('SIGTERM')
  if (!await gone(5_000)) {
    signal('SIGKILL')
    if (!await gone(2_000)) return false
  }
  if (owner.tty) await (opts.writeTty ?? writeTty)(owner.tty, TERMINAL_RESTORE).catch(() => undefined)
  return true
}

export async function writeTty(tty: string, content: string): Promise<void> {
  const handle = await open(tty, 'w')
  try { await handle.write(content) } finally { await handle.close() }
}
