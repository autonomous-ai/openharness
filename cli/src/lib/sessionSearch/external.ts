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

import { harnessTtys as readHarnessTtys, processAlive, processTtys, processView, scanMemo } from './externals/support.js'
import type { ExternalEngine, ExternalProvider, ExternalSession, OwnerClaim, ProcessView } from './externals/types.js'
import { externalReadFailed } from './evidence.js'

export type { ExternalEngine, ExternalOrigin, ExternalProvider, ExternalSession } from './externals/types.js'
export { processAlive } from './externals/support.js'

/** Canonical records outrank aliases; the newest canonical record wins across stores and homes. */
export function externalSessionCatalog(rows: readonly ExternalSession[]): { found: ExternalSession[]; byId: Map<string, ExternalSession> } {
  const byId = new Map<string, ExternalSession>()
  for (const row of [...rows].sort((a, b) => b.mtime - a.mtime)) if (!byId.has(row.sessionId)) byId.set(row.sessionId, row)
  const found = [...byId.values()]
  for (const row of found) for (const alias of row.aliases ?? []) if (!byId.has(alias)) byId.set(alias, row)
  return { found, byId }
}

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
        externalReadFailed(error, 'session store')
        // One engine's store failing (locked, mid-migration) keeps what it said last time.
        this.opts.log?.(`[search] ${provider.engine} sessions not read: ${error instanceof Error ? error.message : error}`)
        all.push(...this.lastGood.get(provider.engine) ?? [])
      }
    }
    this.memo.prune()
    const catalog = externalSessionCatalog(all)
    this.found = catalog.found
    this.byId = catalog.byId
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

export { foregroundJob, stopSessionOwner, writeTty, TERMINAL_RESTORE, type StopOptions } from '../externalOwnerControl.js'
