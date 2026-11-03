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
 */
import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'

export interface LedgerMember { machineId: string; agentId: string }
export interface Started {
  at: number
  /** The harness that ran `harness new`. */
  by: LedgerMember & { name: string; engine: string }
  /** The harness it started, and the creation it was asked for by when that was saved first (`Pending`). */
  child: LedgerMember & { name: string; creationId?: string }
  /** 1 for a harness a person's harness started, 2 for one that harness started. */
  depth: number
}

/** A harness asked for that has not started yet: its creation on [creation.machineId], and the name it was given. */
export interface Pending {
  at: number
  by: LedgerMember & { name: string; engine: string }
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

/** How long a pending line is asked after. An install ends within twenty minutes (engines/kit/nativeInstall.ts). */
export const PENDING_WITHIN_MS = 30 * 60_000

/** The file, in the daemon's data folder. */
export const ledgerPath = (dataDir: string): string => join(dataDir, 'agent-client', 'started.jsonl')

/** The file's size before it becomes the previous one: the two hold about 20,000 starts. */
export const ROTATE_BYTES = 2 * 1024 * 1024

const member = (v: unknown): v is LedgerMember => {
  const m = v as Record<string, unknown> | null
  return !!m && typeof m.machineId === 'string' && !!m.machineId && typeof m.agentId === 'string' && !!m.agentId
}

export function parseStarted(line: string): Started | null {
  let v: Record<string, unknown>
  try { v = JSON.parse(line) } catch { return null }
  if (!v || typeof v !== 'object' || typeof v.at !== 'number' || !member(v.by) || !member(v.child)
    || typeof v.depth !== 'number' || v.depth < 1) return null
  const by = v.by as unknown as Record<string, unknown>, child = v.child as unknown as Record<string, unknown>
  return {
    at: v.at,
    by: { machineId: by.machineId as string, agentId: by.agentId as string, name: String(by.name ?? ''), engine: String(by.engine ?? '') },
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
    by: { machineId: by.machineId as string, agentId: by.agentId as string, name: String(by.name ?? ''), engine: String(by.engine ?? '') },
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

const same = (a: LedgerMember, b: LedgerMember): boolean => a.machineId === b.machineId && a.agentId === b.agentId

export class Ledger {
  private cache: { key: string; rows: Started[]; pending: Pending[]; closed: Closed[]; told: Told[] } | null = null
  constructor(readonly path: string) {}

  /** Where the older lines went when the file passed its size. */
  get previous(): string { return `${this.path}.1` }

  /** Every line, oldest first: the previous file's, then this one's. An unreadable file is an empty one. Read again
   *  only when either changed. */
  all(): Started[] { return this.read().rows }

  private read(): { rows: Started[]; pending: Pending[]; closed: Closed[]; told: Told[] } {
    const files = [this.previous, this.path].map((path) => { try { const st = statSync(path); return { path, key: `${st.mtimeMs}:${st.size}` } } catch { return null } })
    const key = files.map((f) => f?.key ?? '-').join('|')
    if (this.cache?.key === key) return this.cache
    const rows: Started[] = [], pending: Pending[] = [], closed: Closed[] = [], told: Told[] = []
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
        if (tell) told.push(tell)
      }
    }
    this.cache = { key, rows, pending, closed, told }
    return this.cache
  }

  append(row: Started | Pending | Closed | Told): void {
    mkdirSync(dirname(this.path), { recursive: true })
    // One short line with O_APPEND: two agents starting harnesses at once never interleave.
    appendFileSync(this.path, `${JSON.stringify(row)}\n`, { mode: 0o600 })
    // Past its size the file becomes the previous one, by a rename: a line appended meanwhile lands in one file or the
    // other, both read. Rewriting the file in place lost a line appended during the rewrite (the review of #1180).
    try { if (statSync(this.path).size > ROTATE_BYTES) renameSync(this.path, this.previous) } catch { /* rotated by another */ }
  }

  /** Appends [row] unless [row.child] already has its line: a harness asked for and started later is recorded by
   *  whichever of the agent's verbs sees it made first, and two at once would each count it toward the limits. */
  record(row: Started): void {
    if (!this.parentOf(row.child)) this.append(row)
  }

  /** The line that says who started [m], or null when the person did. */
  parentOf(m: LedgerMember): Started | null {
    return this.all().findLast((row) => same(row.child, m)) ?? null
  }

  /** The harnesses [m] started, newest last. */
  childrenOf(m: LedgerMember): Started[] {
    // One a harness, its latest line: two verbs recording the same start at once (`record`) both write it, and a child
    // counted twice met the limits early and matched no name (two rows for one).
    const children = new Map(this.all().filter((row) => same(row.by, m)).map((row) => [`${row.child.machineId}/${row.child.agentId}`, row]))
    return [...children.values()].sort((a, b) => a.at - b.at)
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
