/** Durable associations, scoped to one conversation on its owning machine. Never cleanup authority. */
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { env } from '../config/env.js'
import type { RegisteredSession } from './registry.js'
import type { SessionGitContext } from './sessionGitContext.js'
import { validPullRequestUrl, validWorkPath } from './sessionWorkWire.js'
import type { WorkPullRequest } from './sessionWork.js'
import type { PullRequestResult } from './gitPullRequest.js'

export type WorkBranch = { cwd: string; remote: string | null; branch: string; at: string }
export type RecordedPullRequest = WorkPullRequest & { result?: PullRequestResult; checkedAt?: string; aliases?: string[] }
export type GitHistory = { branches: WorkBranch[]; pullRequests: RecordedPullRequest[]; truncated: boolean }
type Target = Pick<RegisteredSession, 'engine' | 'sessionId' | 'agentId' | 'codexHome' | 'forkedFrom' | 'registeredAt'>
type Entry = { value: GitHistory; loaded: Promise<void>; saving: Promise<void>; readers: number; writes: number }
const MAX = 128
const empty = (): GitHistory => ({ branches: [], pullRequests: [], truncated: false })
function keyFor(target: Target): string {
  return createHash('sha256').update(JSON.stringify([target.engine, target.codexHome ?? '',
    target.sessionId || target.agentId, target.forkedFrom ? target.registeredAt : null])).digest('hex')
}
const label = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 4096 && !/[\x00-\x1f\x7f]/.test(v)
const date = (v: unknown): v is string => typeof v === 'string' && Number.isFinite(Date.parse(v))
/** The server pages in the same order the two clients display. Unknown precedes finished work. */
export function comparePullRequests(a: RecordedPullRequest, b: RecordedPullRequest): number {
  const rank = (p: RecordedPullRequest) => p.result?.status !== 'found' ? 1
    : p.result.state === 'Open' || p.result.state === 'Draft' ? 0 : 2
  const time = (p: RecordedPullRequest) => {
    const pr = p.result?.status === 'found' ? p.result : null
    const value = pr?.state === 'Merged' ? pr.mergedAt : pr?.state === 'Closed' ? pr.closedAt : pr?.updatedAt ?? pr?.createdAt
    return value && date(value) ? Date.parse(value) : Date.parse(p.at)
  }
  return rank(a) - rank(b) || time(b) - time(a)
    || (a.url === b.url ? 0 : a.url < b.url ? -1 : 1)
}
function valid(value: unknown): value is GitHistory {
  if (!value || typeof value !== 'object') return false
  const row = value as GitHistory
  return typeof row.truncated === 'boolean' && Array.isArray(row.branches) && row.branches.length <= MAX
    && row.branches.every(b => validWorkPath(b?.cwd) && label(b.branch) && (b.remote === null || label(b.remote)) && date(b.at))
    && Array.isArray(row.pullRequests) && row.pullRequests.length <= MAX
    && row.pullRequests.every(p => validPullRequestUrl(p?.url) && (p.cwd === null || validWorkPath(p.cwd)) && date(p.at)
      && (p.aliases === undefined || Array.isArray(p.aliases) && p.aliases.length <= 16 && p.aliases.every(validPullRequestUrl))
      && (p.checkedAt === undefined || date(p.checkedAt)) && (p.result === undefined || p.result.status === 'none'
        || p.result.status === 'unavailable' || p.result.status === 'found' && p.result.url === p.url
        && Number.isSafeInteger(p.result.number) && p.result.number > 0 && p.url.endsWith(`/pull/${p.result.number}`)
        && ['Draft', 'Open', 'Merged', 'Closed'].includes(p.result.state)))
}

export class SessionGitHistoryStore {
  private entries = new Map<string, Entry>()
  constructor(private readonly directory: string, private readonly capacity = 512) {}
  private trim(): void {
    for (const [key, entry] of this.entries) {
      if (this.entries.size <= this.capacity) break
      if (!entry.readers && !entry.writes) this.entries.delete(key)
    }
  }
  private entry(target: Target): [string, Entry] {
    const key = keyFor(target)
    let entry = this.entries.get(key)
    if (!entry) {
      entry = { value: empty(), loaded: Promise.resolve(), saving: Promise.resolve(), readers: 0, writes: 0 }
      const current = entry
      entry.loaded = (async () => {
        try {
          const path = join(this.directory, `${key}.json`)
          if ((await stat(path)).size > 512 * 1024) return
          const data: unknown = JSON.parse(await readFile(path, 'utf8'))
          if (valid(data)) current.value = data
        } catch { /* Missing/corrupt history remains unknown, never a reason to stop a session. */ }
      })()
      this.entries.set(key, entry)
    }
    entry.readers++
    this.trim()
    return [key, entry]
  }
  async get(target: Target): Promise<GitHistory> {
    const [, entry] = this.entry(target)
    try {
      await entry.loaded
      const value = structuredClone(entry.value)
      value.pullRequests.sort(comparePullRequests)
      return value
    } finally { entry.readers--; this.trim() }
  }
  async observe(target: Target, context: SessionGitContext): Promise<GitHistory> {
    const [key, entry] = this.entry(target)
    try {
      await entry.loaded
      const before = JSON.stringify(entry.value)
      // This records branches checked out for the session, not authorship or proof of edits.
      // Engine logs are optional enrichment; direct Git observations work for every engine.
      for (const current of context.checkouts ?? (context.current ? [context.current] : [])) {
        const branch = current.branch
        if (!current.root || !branch || current.branchPending || branch.startsWith('Detached ')) continue
        const same = (b: WorkBranch) => b.cwd === (current.root ?? current.cwd) && b.branch === branch && b.remote === current.remote
        const previous = entry.value.branches.find(same)
        // Retrospective tool receipts cannot establish when this branch was checked out.
        const at = previous?.at ?? new Date().toISOString()
        if (!previous || previous.at < at) entry.value.branches = [
          { cwd: current.root ?? current.cwd, branch, remote: current.remote, at }, ...entry.value.branches.filter(b => !same(b)),
        ]
      }
      for (const pr of context.pullRequests) if (!entry.value.pullRequests.some(p => p.url === pr.url || p.aliases?.includes(pr.url))) entry.value.pullRequests.unshift({ ...pr })
      entry.value.truncated ||= context.truncated || entry.value.branches.length > MAX || entry.value.pullRequests.length > MAX
      entry.value.branches = entry.value.branches.sort((a, b) => b.at.localeCompare(a.at)).slice(0, MAX)
      entry.value.pullRequests = entry.value.pullRequests.sort((a, b) => b.at.localeCompare(a.at)).slice(0, MAX)
      if (before !== JSON.stringify(entry.value)) this.save(key, entry)
      const value = structuredClone(entry.value)
      value.pullRequests.sort(comparePullRequests)
      return value
    } finally { entry.readers--; this.trim() }
  }
  async recordPullRequest(target: Target, pr: WorkPullRequest, result: PullRequestResult, checkedAt: string): Promise<void> {
    if (!validPullRequestUrl(pr.url)) return
    const [key, entry] = this.entry(target)
    try {
      await entry.loaded
      let url = result.status === 'found' ? result.url : pr.url
      if (!validPullRequestUrl(url)) return
      const matches = (p: RecordedPullRequest) => p.url === pr.url || p.url === url || !!p.aliases?.includes(pr.url)
      const candidates = entry.value.pullRequests.filter(matches)
      const existing = candidates.sort((a, b) => (b.checkedAt ?? '').localeCompare(a.checkedAt ?? ''))[0]
      // Network failures preserve the last observed state, with its original observation time.
      if (result.status === 'unavailable' && existing) return
      const source = existing?.checkedAt && existing.checkedAt > checkedAt ? existing
        : { ...pr, at: existing?.at ?? pr.at, cwd: existing?.cwd ?? pr.cwd, result, checkedAt }
      if (source === existing) url = existing.url
      const aliases = [...new Set([pr.url, ...candidates.flatMap(p => [p.url, ...(p.aliases ?? [])])])].filter(alias => alias !== url).slice(0, 16)
      const next = { ...source, url,
        ...(aliases.length ? { aliases } : {}),
        ...(source.result?.status === 'found' ? { result: { ...source.result, url } } : {}) }
      entry.value.pullRequests = [next, ...entry.value.pullRequests.filter(p => !matches(p))]
      if (entry.value.pullRequests.length > MAX) { entry.value.pullRequests.length = MAX; entry.value.truncated = true }
      this.save(key, entry)
    } finally { entry.readers--; this.trim() }
  }
  private save(key: string, entry: Entry): void {
    const bytes = JSON.stringify(entry.value)
    entry.writes++
    entry.saving = entry.saving.then(async () => {
      const temporary = join(this.directory, `${key}.${randomUUID()}.tmp`)
      try {
        await mkdir(this.directory, { recursive: true, mode: 0o700 })
        await writeFile(temporary, bytes, { mode: 0o600, flag: 'wx' })
        await rename(temporary, join(this.directory, `${key}.json`))
      } finally { await unlink(temporary).catch(() => {}) }
    }).catch(() => { /* Display keeps the in-memory observations if disk is temporarily unavailable. */ })
      .finally(() => { entry.writes--; this.trim() })
  }
  async settled(): Promise<void> { await Promise.all([...this.entries.values()].map(e => e.saving)) }
}
export const sessionGitHistory = new SessionGitHistoryStore(join(env.ADAPTER_DATA_DIR, 'session-git-history'))
