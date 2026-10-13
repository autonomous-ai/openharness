/**
 * Who started which harness (docs/design/2026-10-11-agent-client.md, "Who started it"): one line per harness an
 * agent started with `harness new`, appended by the CLI to the data folder of the daemon that owns the agent's
 * pane. A harness with no line was started by the person.
 *
 * Read by `harness ps` (who started each), by `new` and `stop` (limits, and which harnesses an agent may stop),
 * and by Agent Messages, which lets a harness and the harnesses it started message each other without a tab.
 * Like Agent Messages it is a collaboration scope, not a sandbox: any process of this user can write the file.
 */
import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'

export interface LedgerMember { machineId: string; agentId: string }
export interface Started {
  at: number
  /** The harness that ran `harness new`. */
  by: LedgerMember & { name: string; engine: string }
  /** The harness it started. */
  child: LedgerMember & { name: string }
  /** 1 for a harness a person's harness started, 2 for one that harness started. */
  depth: number
}

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
    child: { machineId: child.machineId as string, agentId: child.agentId as string, name: String(child.name ?? '') },
    depth: v.depth,
  }
}

const same = (a: LedgerMember, b: LedgerMember): boolean => a.machineId === b.machineId && a.agentId === b.agentId

export class Ledger {
  private cache: { key: string; rows: Started[] } | null = null
  constructor(readonly path: string) {}

  /** Where the older lines went when the file passed its size. */
  get previous(): string { return `${this.path}.1` }

  /** Every line, oldest first: the previous file's, then this one's. An unreadable file is an empty one. Read again
   *  only when either changed. */
  all(): Started[] {
    const files = [this.previous, this.path].map((path) => { try { const st = statSync(path); return { path, key: `${st.mtimeMs}:${st.size}` } } catch { return null } })
    const key = files.map((f) => f?.key ?? '-').join('|')
    if (this.cache?.key === key) return this.cache.rows
    const rows: Started[] = []
    for (const file of files) {
      if (!file) continue
      let text = ''
      try { text = readFileSync(file.path, 'utf8') } catch { continue }
      for (const line of text.split('\n')) { const row = line ? parseStarted(line) : null; if (row) rows.push(row) }
    }
    this.cache = { key, rows }
    return rows
  }

  append(row: Started): void {
    mkdirSync(dirname(this.path), { recursive: true })
    // One short line with O_APPEND: two agents starting harnesses at once never interleave.
    appendFileSync(this.path, `${JSON.stringify(row)}\n`, { mode: 0o600 })
    // Past its size the file becomes the previous one, by a rename: a line appended meanwhile lands in one file or the
    // other, both read. Rewriting the file in place lost a line appended during the rewrite (the review of #1180).
    try { if (statSync(this.path).size > ROTATE_BYTES) renameSync(this.path, this.previous) } catch { /* rotated by another */ }
  }

  /** The line that says who started [m], or null when the person did. */
  parentOf(m: LedgerMember): Started | null {
    return this.all().findLast((row) => same(row.child, m)) ?? null
  }

  /** The harnesses [m] started, newest last. */
  childrenOf(m: LedgerMember): Started[] {
    return this.all().filter((row) => same(row.by, m))
  }

  /** 0 for a harness the person started. */
  depthOf(m: LedgerMember): number {
    return this.parentOf(m)?.depth ?? 0
  }

  /** Whether one of the two started the other. */
  linked(a: LedgerMember, b: LedgerMember): boolean {
    return this.all().some((row) => (same(row.by, a) && same(row.child, b)) || (same(row.by, b) && same(row.child, a)))
  }

  /** The harnesses [m] may message without a tab: its parent and its children. */
  links(m: LedgerMember): LedgerMember[] {
    const out: LedgerMember[] = []
    for (const row of this.all()) {
      const other = same(row.by, m) ? row.child : same(row.child, m) ? row.by : null
      if (other && !out.some((o) => same(o, other))) out.push({ machineId: other.machineId, agentId: other.agentId })
    }
    return out
  }
}
