/**
 * Who started which harness (docs/design/2026-10-11-agent-client.md, "Who started it"): one line per harness an
 * agent started with `harness new`, appended by the CLI to the data folder of the daemon that owns the agent's
 * pane. A harness with no line was started by the person.
 *
 * Read by `harness ps` (who started each), and by `new` and `close` (limits, depth, and which harnesses an agent
 * may close). It never lets two harnesses message each other: only sharing a tab does (owner, 2026-10-11). It is a collaboration scope, not a sandbox: any process of this user can write the file.
 *
 * A harness asked for and not started yet (its engine still installing) has a line of its own, `Pending`, with the
 * machine's creation id: it starts by itself later, after `harness new` has answered, and is then recorded as started
 * by whichever verb of the agent's first sees it made (agentClient/commands.ts `opened`). Older readers skip the line.
 *
 * A harness an agent closed with `harness close` has a line too, `Closed`: its `harness wait` then says the harness
 * was closed, by the agent itself, rather than reporting it stopped as a failure. Older readers skip that line as well.
 *
 * The file is not only appended to: deleting a harness rewrites it without the `Told` lines naming that harness
 * (`forgetTold`), whose `probe` keeps the opening words of a `tell`. Every writer, an append and that rewrite alike,
 * takes one lock, `<file>.lock`: a rewrite in place once lost a line appended during it (the review of #1180).
 *
 * A harness the Hachi harness started is handed to the person when Hachi closes, however it closes
 * (docs/design/2026-11-12-hachi.md, "What Hachi started never closes with it"): a `Handed` line says so, and from it on
 * the harness has no starter here, so neither the cascade nor the idle cleanup closes it (services/agentCleanup.ts) and
 * Hachi may no longer tell or close it. Older readers skip that line too.
 */
import { appendFileSync, closeSync, constants, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { lockOwnerAlive, lockStartMarker, processLockIdentity, type LockGeneration } from '../lib/processLiveness.js'

export interface LedgerMember { machineId: string; agentId: string }
/** A starter: the harness that ran `harness new`, its name and engine, and whether it is the Hachi harness
 *  (docs/design/2026-11-12-hachi.md), which the machine a harness runs on reads to let Hachi tell it while the account
 *  has Hachi on (messages/tell.ts), and to hand it to the person when Hachi closes (services/agentCleanup.ts). */
export type Starter = LedgerMember & { name: string; engine: string; hachi?: true }
export interface Started {
  at: number
  /** The harness that ran `harness new`. */
  by: Starter
  /** The harness it started, and the creation it was asked for by when that was saved first (`Pending`). */
  child: LedgerMember & { name: string; creationId?: string }
  /** 1 for a harness a person's harness started, 2 for one that harness started. */
  depth: number
}

/** A harness asked for that has not started yet: its creation on [creation.machineId], and the name it was given. */
export interface Pending {
  at: number
  by: Starter
  creation: { machineId: string; creationId: string; name: string; engine: string }
  depth: number
}

/** [by] closed [closed] with `harness close`. */
export interface Closed {
  at: number
  by: LedgerMember
  closed: LedgerMember
}

/**
 * [by] gave [told] more work with `harness tell`, at [at]; [probe] is the start of those words. `harness wait` reads it:
 * until a turn asked with those words has been seen, the harness's last answer is to the work before, and an idle
 * harness has not taken the new work yet. Older readers skip the line.
 */
export interface Told {
  at: number
  by: LedgerMember
  told: LedgerMember
  probe: string
}

/** [handed], which [from] started, became the person's at [at]: a start of it before then is not [from]'s any more. */
export interface Handed {
  at: number
  from: LedgerMember
  handed: LedgerMember
}

/** How long a pending line is asked after. An install ends within twenty minutes (engines/kit/nativeInstall.ts). */
export const PENDING_WITHIN_MS = 30 * 60_000

/** The file, in the daemon's data folder. */
export const ledgerPath = (dataDir: string): string => join(dataDir, 'agent-client', 'started.jsonl')

/** The file's size before it becomes the previous one: the two hold about 20,000 starts. */
export const ROTATE_BYTES = 2 * 1024 * 1024

/** How long a writer waits for another process's writer before it gives up, as the registry's lock does. */
export const LEDGER_LOCK_WAIT_MS = 2_000
const LOCK_STEP_MS = 10

export class LedgerBusyError extends Error {
  constructor() {
    super('The agent ledger is busy. Try again.')
    this.name = 'LedgerBusyError'
  }
}

const pause = new Int32Array(new SharedArrayBuffer(4))

/** The lock's text, or null once its writer let go. */
function lockText(lock: string): string | null {
  try { return readFileSync(lock, 'utf8') } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

/** A lock that names no one is a writer between making it and writing its pid, unless it is older than this: its writer
 *  died in between. Under the wait, so a waiter still takes such a lock over. */
const OWNERLESS_STALE_MS = 1_000

function ownerlessStale(lock: string): boolean {
  try { return Date.now() - statSync(lock).mtimeMs > OWNERLESS_STALE_MS } catch { return true }
}

/** Removes [lock] when the process it names is gone, or it has named no one for too long, and says whether to try for
 *  it again at once. */
function takeOver(lock: string): boolean {
  const seen = lockText(lock)
  if (seen === null) return true
  let owner: (LockGeneration & { pid?: unknown }) | null = null
  try { owner = JSON.parse(seen) } catch { /* names no one */ }
  const pid = Number(owner?.pid)
  if (pid > 0 ? lockOwnerAlive(pid, lockStartMarker(owner)) : !ownerlessStale(lock)) return false
  // The check can run `ps`, for milliseconds: a lock let go and taken meanwhile is a live writer's, not this one's.
  if (lockText(lock) === seen) rmSync(lock, { force: true })
  return true
}

const member = (v: unknown): v is LedgerMember => {
  const m = v as Record<string, unknown> | null
  return !!m && typeof m.machineId === 'string' && !!m.machineId && typeof m.agentId === 'string' && !!m.agentId
}

const starter = (by: Record<string, unknown>): Starter => ({ machineId: by.machineId as string, agentId: by.agentId as string,
  name: String(by.name ?? ''), engine: String(by.engine ?? ''), ...(by.hachi === true ? { hachi: true as const } : {}) })

export function parseStarted(line: string): Started | null {
  let v: Record<string, unknown>
  try { v = JSON.parse(line) } catch { return null }
  if (!v || typeof v !== 'object' || typeof v.at !== 'number' || !member(v.by) || !member(v.child)
    || typeof v.depth !== 'number' || v.depth < 1) return null
  const by = v.by as unknown as Record<string, unknown>, child = v.child as unknown as Record<string, unknown>
  return {
    at: v.at,
    by: starter(by),
    child: { machineId: child.machineId as string, agentId: child.agentId as string, name: String(child.name ?? ''),
      ...(typeof child.creationId === 'string' && child.creationId ? { creationId: child.creationId } : {}) },
    depth: v.depth,
  }
}

export function parsePending(line: string): Pending | null {
  let v: Record<string, unknown>
  try { v = JSON.parse(line) } catch { return null }
  const creation = v?.creation as Record<string, unknown> | undefined
  if (!v || typeof v !== 'object' || typeof v.at !== 'number' || !member(v.by) || typeof v.depth !== 'number' || v.depth < 1
    || !creation || typeof creation.machineId !== 'string' || !creation.machineId || typeof creation.creationId !== 'string' || !creation.creationId) return null
  const by = v.by as unknown as Record<string, unknown>
  return {
    at: v.at,
    by: starter(by),
    creation: { machineId: creation.machineId, creationId: creation.creationId, name: String(creation.name ?? ''), engine: String(creation.engine ?? '') },
    depth: v.depth,
  }
}

export function parseClosed(line: string): Closed | null {
  let v: Record<string, unknown>
  try { v = JSON.parse(line) } catch { return null }
  if (!v || typeof v !== 'object' || typeof v.at !== 'number' || !member(v.by) || !member(v.closed)) return null
  const by = v.by as unknown as LedgerMember, closed = v.closed as unknown as LedgerMember
  return { at: v.at, by: { machineId: by.machineId, agentId: by.agentId }, closed: { machineId: closed.machineId, agentId: closed.agentId } }
}

export function parseTold(line: string): Told | null {
  let v: Record<string, unknown>
  try { v = JSON.parse(line) } catch { return null }
  if (!v || typeof v !== 'object' || typeof v.at !== 'number' || !member(v.by) || !member(v.told) || typeof v.probe !== 'string') return null
  const by = v.by as unknown as LedgerMember, told = v.told as unknown as LedgerMember
  return { at: v.at, by: { machineId: by.machineId, agentId: by.agentId }, told: { machineId: told.machineId, agentId: told.agentId }, probe: v.probe }
}

export function parseHanded(line: string): Handed | null {
  let v: Record<string, unknown>
  try { v = JSON.parse(line) } catch { return null }
  if (!v || typeof v !== 'object' || typeof v.at !== 'number' || !member(v.from) || !member(v.handed)) return null
  const from = v.from as unknown as LedgerMember, handed = v.handed as unknown as LedgerMember
  return { at: v.at, from: { machineId: from.machineId, agentId: from.agentId }, handed: { machineId: handed.machineId, agentId: handed.agentId } }
}

const same = (a: LedgerMember, b: LedgerMember): boolean => a.machineId === b.machineId && a.agentId === b.agentId

export class Ledger {
  private cache: { key: string; rows: Started[]; pending: Pending[]; closed: Closed[]; told: Told[]; handed: Handed[] } | null = null
  constructor(readonly path: string, private readonly lockWaitMs = LEDGER_LOCK_WAIT_MS) {}

  /** Where the older lines went when the file passed its size. */
  get previous(): string { return `${this.path}.1` }

  /** Every line, oldest first: the previous file's, then this one's. An unreadable file is an empty one. Read again
   *  only when either changed. */
  all(): Started[] { return this.read().rows }

  private read(): { rows: Started[]; pending: Pending[]; closed: Closed[]; told: Told[]; handed: Handed[] } {
    const files = [this.previous, this.path].map((path) => { try { const st = statSync(path); return { path, key: `${st.mtimeMs}:${st.size}` } } catch { return null } })
    const key = files.map((f) => f?.key ?? '-').join('|')
    if (this.cache?.key === key) return this.cache
    const rows: Started[] = [], pending: Pending[] = [], closed: Closed[] = [], told: Told[] = [], handed: Handed[] = []
    for (const file of files) {
      if (!file) continue
      let text = ''
      try { text = readFileSync(file.path, 'utf8') } catch { continue }
      for (const line of text.split('\n')) {
        if (!line) continue
        const row = parseStarted(line)
        if (row) { rows.push(row); continue }
        const asked = parsePending(line)
        if (asked) { pending.push(asked); continue }
        const close = parseClosed(line)
        if (close) { closed.push(close); continue }
        const tell = parseTold(line)
        if (tell) { told.push(tell); continue }
        const over = parseHanded(line)
        if (over) handed.push(over)
      }
    }
    this.cache = { key, rows, pending, closed, told, handed }
    return this.cache
  }

  append(row: Started | Pending | Closed | Told | Handed): void {
    this.locked(() => {
      appendFileSync(this.path, `${JSON.stringify(row)}\n`, { mode: 0o600 })
      // Past its size the file becomes the previous one, by a rename: a reader sees each line in one file or the other.
      if (statSync(this.path).size > ROTATE_BYTES) renameSync(this.path, this.previous)
    })
  }

  /** Drops the `Told` lines that name [agentId] as told from both files, for a harness being deleted, and returns how
   *  many went. Every other line stays byte for byte, one this reader cannot parse included. */
  forgetTold(agentId: string): number {
    return this.locked(() => {
      let gone = 0
      for (const file of [this.previous, this.path]) {
        let bytes: Buffer
        try { bytes = readFileSync(file) } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
          throw error
        }
        const kept: Buffer[] = []
        let dropped = 0
        for (let start = 0; start < bytes.length;) {
          const newline = bytes.indexOf(0x0a, start)
          const end = newline < 0 ? bytes.length : newline + 1
          const line = bytes.subarray(start, end)
          if (parseTold(line.toString('utf8'))?.told.agentId === agentId) dropped++
          else kept.push(line)
          start = end
        }
        if (!dropped) continue
        // A new file renamed over the old: a reader sees the whole file before or after, and no copy of the words stays.
        const temp = `${file}.tmp`
        try {
          writeFileSync(temp, Buffer.concat(kept), { mode: 0o600 })
          renameSync(temp, file)
        } catch (error) {
          rmSync(temp, { force: true })
          throw error
        }
        gone += dropped
      }
      return gone
    })
  }

  /** Runs [write] holding `<path>.lock`, made with O_EXCL. A lock whose owner is gone is taken over; a live owner is
   *  waited for up to [lockWaitMs], then LedgerBusyError with nothing written. */
  private locked<T>(write: () => T): T {
    mkdirSync(dirname(this.path), { recursive: true })
    const lock = `${this.path}.lock`
    // Known before the lock is made: `ps` can take milliseconds, and a lock that names no one meanwhile is taken over.
    const mine = JSON.stringify({ pid: process.pid, ...processLockIdentity(process.pid) })
    const deadline = Date.now() + this.lockWaitMs
    for (;;) {
      let fd: number
      try { fd = openSync(lock, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600) } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        if (takeOver(lock)) continue
        if (Date.now() >= deadline) throw new LedgerBusyError()
        // Blocks this thread without spinning, as the registry's lock does: every writer here is synchronous.
        Atomics.wait(pause, 0, 0, LOCK_STEP_MS)
        continue
      }
      try { writeFileSync(fd, mine) } finally { closeSync(fd) }
      try { return write() } finally { rmSync(lock, { force: true }) }
    }
  }

  /** Appends [row] unless [row.child] already has its line: a harness asked for and started later is recorded by
   *  whichever of the agent's verbs sees it made first, and two at once would each count it toward the limits. */
  record(row: Started): void {
    if (!this.parentOf(row.child)) this.append(row)
  }

  /** The line that says who started [m], or null when the person did, or it was handed to them since. */
  parentOf(m: LedgerMember): Started | null {
    const row = this.all().findLast((each) => same(each.child, m)) ?? null
    return row && !this.handedSince(row) ? row : null
  }

  /** The harnesses [m] started and still has, newest last: none handed to the person since. */
  childrenOf(m: LedgerMember): Started[] {
    // One a harness, its latest line: two verbs recording the same start at once (`record`) both write it, and a child
    // counted twice met the limits early and matched no name (two rows for one).
    const children = new Map(this.all().filter((row) => same(row.by, m)).map((row) => [`${row.child.machineId}/${row.child.agentId}`, row]))
    return [...children.values()].filter((row) => !this.handedSince(row)).sort((a, b) => a.at - b.at)
  }

  /** When [m] was handed to the person, or null while the start recorded last for it is still its starter's. */
  handedAt(m: LedgerMember): number | null {
    const row = this.all().findLast((each) => same(each.child, m))
    const handed = this.read().handed.findLast((each) => same(each.handed, m))
    return handed && (!row || handed.at >= row.at) ? handed.at : null
  }

  /** Whether [row]'s child was handed to the person at or after [row]'s start, by the harness that started it. */
  private handedSince(row: Started): boolean {
    return this.read().handed.some((each) => same(each.handed, row.child) && same(each.from, row.by) && each.at >= row.at)
  }

  /** When [by] last closed [m] with `harness close`, or null when it did not. */
  closedBy(by: LedgerMember, m: LedgerMember): number | null {
    return this.read().closed.findLast((row) => same(row.by, by) && same(row.closed, m))?.at ?? null
  }

  /** What [by] last told [m] with `harness tell`, or null when it never did. */
  toldBy(by: LedgerMember, m: LedgerMember): Told | null {
    return this.read().told.findLast((row) => same(row.by, by) && same(row.told, m)) ?? null
  }

  /** The last words [by] gave any harness on [machineId] (`harness reply`, `harness route --send`), or null. This
   *  machine's ledger holds only its own callers' lines, so another computer's follow-up never steers this one's. */
  lastToldBy(by: LedgerMember, machineId: string): Told | null {
    return this.read().told.findLast((row) => same(row.by, by) && row.told.machineId === machineId) ?? null
  }

  /** 0 for a harness the person started. */
  depthOf(m: LedgerMember): number {
    return this.parentOf(m)?.depth ?? 0
  }

  /** What [m] asked for in the last half hour that has no started line yet, newest last; anyone's when [m] is null. */
  pendingOf(m: LedgerMember | null, now: number): Pending[] {
    const { rows, pending } = this.read()
    const started = new Set(rows.map((row) => row.child.creationId).filter(Boolean))
    // One per creation, its latest line: a line written twice is one harness asked for.
    const asked = new Map(pending.filter((row) => (!m || same(row.by, m)) && now - row.at < PENDING_WITHIN_MS && !started.has(row.creation.creationId))
      .map((row) => [row.creation.creationId, row]))
    return [...asked.values()]
  }
}
