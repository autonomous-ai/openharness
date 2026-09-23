/** Per-conversation token totals, computed on the owning machine. No Git or vendor requests.
 * Frames read a tiny in-memory snapshot; a bounded background queue maintains private checkpoints.
 * JSONL is scanned once, then only appended bytes are read. Nothing walks transcript directories. */
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { env } from '../config/env.js'
import type { RegisteredSession } from './registry.js'
import { sqliteReadAll } from './sqliteRead.js'
import { emptyOutputLedger, ingestOutput, outputSnapshot, validOutputLedger, type AgentOutputStats, type OutputLedger } from './agentOutputStats.js'

export type AgentTokenUsage = { totalTokens: number | null; updatedAt: string; output?: AgentOutputStats }
type Target = Pick<RegisteredSession, 'engine' | 'sessionId' | 'transcriptPath' | 'codexHome' | 'agentId' | 'forkedFrom' | 'registeredAt'>
type Buckets = [number, number, number, number]
type CodexTotals = [number, number, number, number]
type Checkpoint = {
  version: 2; key: string; offset: number; size: number; mtime: number; inode: string;
  boundary: string; total: number; observed: boolean; updatedAt: string | null;
  claude: Record<string, Buckets>; codex: CodexTotals | null; seen: Record<string, true>;
  output: OutputLedger;
}
type Entry = {
  target: Target; value: AgentTokenUsage | null; checked: number; pending: Promise<void> | null;
  fingerprint?: string;
  dirty?: boolean;
  timer?: NodeJS.Timeout;
}
const REFRESH_MS = 15_000
const MAX_CACHE_BYTES = 8 * 1024 * 1024
const MAX_TRANSCRIPT_BYTES = 128 * 1024 * 1024
const MAX_LINE_BYTES = 8 * 1024 * 1024
const MAX_ENTRIES = 512
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
const object = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
const tokens = (value: unknown): number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : 0
const sum = (values: number[]) => values.reduce((a, b) => a + b, 0)

function keyFor(s: Target): string | null {
  if (!s.sessionId || !['claude', 'codex', 'opencode'].includes(s.engine)) return null
  if (s.engine !== 'opencode' && !s.transcriptPath) return null
  return hash(JSON.stringify([s.engine, s.codexHome ?? '', s.sessionId, s.transcriptPath,
    s.forkedFrom ? s.registeredAt : null]))
}
function targetSnapshot(s: Target): Target {
  return { agentId: s.agentId, sessionId: s.sessionId, engine: s.engine, transcriptPath: s.transcriptPath,
    codexHome: s.codexHome, registeredAt: s.registeredAt, forkedFrom: s.forkedFrom ? { ...s.forkedFrom } : null }
}
function empty(key: string): Checkpoint {
  return { version: 2, key, offset: 0, size: 0, mtime: 0, inode: '', boundary: '', total: 0,
    observed: false, updatedAt: null, claude: {}, codex: null, seen: {}, output: emptyOutputLedger() }
}
function rawCodex(value: unknown): CodexTotals | null {
  const row = object(value)
  return row && ['input_tokens', 'output_tokens', 'cached_input_tokens'].some(key => typeof row[key] === 'number')
    ? [tokens(row.input_tokens), tokens(row.cached_input_tokens ?? row.cache_read_input_tokens),
    tokens(row.output_tokens), tokens(row.reasoning_output_tokens)] : null
}

/** Same counting rules as the desktop usage ledger: cached input is included once, reasoning is
 * already inside output, Claude streaming repeats merge, and Codex cumulative snapshots are deltas. */
function ingest(state: Checkpoint, line: string, target: Target): void {
  if (!line.includes(target.engine === 'claude' ? '"usage"' : '"token_count"')
    && !line.includes('"tool_use"') && !line.includes('"tool_result"') && !line.includes('"response_item"')) return
  const row = object(JSON.parse(line))
  if (!row) return
  // Forks carry old messages into a new conversation. Only work after the fork belongs to it.
  if (target.forkedFrom && (typeof row.timestamp !== 'string' || !Number.isFinite(Date.parse(row.timestamp))
    || Date.parse(row.timestamp) < target.registeredAt)) return
  if (target.engine === 'claude' && typeof row.sessionId === 'string' && row.sessionId !== target.sessionId) return
  ingestOutput(state.output, row, target.engine)
  if (target.engine === 'claude') {
    if (row.type !== 'assistant') return
    if (typeof row.sessionId === 'string' && row.sessionId !== target.sessionId) return
    const message = object(row.message)
    const usage = object(message?.usage)
    if (!usage || !['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens']
      .some(key => typeof usage[key] === 'number')) return
    const next: Buckets = [tokens(usage.input_tokens), tokens(usage.output_tokens),
      tokens(usage.cache_read_input_tokens), tokens(usage.cache_creation_input_tokens)]
    const id = typeof message?.id === 'string' && message.id
      ? `${message.id}:${typeof row.requestId === 'string' ? row.requestId : ''}`
      : typeof row.uuid === 'string' ? row.uuid : line
    const key = hash(id)
    const old = state.claude[key] ?? [0, 0, 0, 0]
    const merged = next.map((value, i) => Math.max(value, old[i])) as Buckets
    state.claude[key] = merged
    state.total += sum(merged) - sum(old)
    state.observed = true
  } else {
    const payload = object(row.payload)
    const info = object(payload?.info)
    if (row.type !== 'event_msg' || payload?.type !== 'token_count' || !info) return
    const total = rawCodex(info.total_token_usage)
    const last = rawCodex(info.last_token_usage)
    if (!total && !last) return
    const id = hash(JSON.stringify([row.timestamp, total, last]))
    if (state.seen[id]) return
    state.seen[id] = true
    const previous = state.codex
    let delta: CodexTotals | null = null
    if (total && previous) {
      if (total.every((n, i) => n === previous[i])) return
      const regressed = total.some((n, i) => n < previous[i])
      if (regressed && last && (sum(total) * 100 >= sum(previous) * 98 || sum(total) + sum(last) * 2 >= sum(previous))) return
      delta = last ?? (regressed ? null : total.map((n, i) => Math.max(0, n - previous[i])) as CodexTotals)
    } else delta = last ?? total
    state.codex = total ?? (last && previous ? previous.map((n, i) => n + last[i]) as CodexTotals : null)
    if (delta) {
      // Codex input includes cache reads; output includes reasoning.
      state.total += Math.max(delta[0], delta[1]) + delta[2]
      state.observed = true
    }
  }
  if (!Number.isSafeInteger(state.total)) throw new Error('Token total exceeds safe precision')
}

export class AgentTokenUsageCache {
  private entries = new Map<string, Entry>()
  private queue: Promise<void> = Promise.resolve()
  private disposed = false
  onChanged?: (target: Target) => void
  constructor(private readonly directory: string, private readonly options: {
    now?: () => number; refreshMs?: number; opencodeDb?: string;
    readSqlite?: typeof sqliteReadAll;
    onRead?: (bytes: number) => void;
  } = {}) {}

  /** Synchronous cache lookup. A cold or unsupported count is unknown, never invented as zero. */
  get(target: Target): AgentTokenUsage | null {
    if (this.disposed) return null
    const key = keyFor(target)
    if (!key) return null
    let entry = this.entries.get(key)
    if (!entry) {
      if (this.entries.size >= MAX_ENTRIES) {
        const oldest = [...this.entries].find(([, entry]) => !entry.pending && !entry.timer)
        if (!oldest) return null
        this.entries.delete(oldest[0])
      }
      entry = { target: targetSnapshot(target), value: null, checked: -Infinity, pending: null }
      this.entries.set(key, entry)
      this.schedule(key, entry)
    }
    entry.target = targetSnapshot(target)
    // Once hydrated, frames only read memory. Existing transcript events drive refreshes;
    // opening the monitor or an idle roster poll must not rescan files or query SQLite.
    return entry.value
  }

  /** Called by existing transcript events; coalesces a burst into one refresh, including its end.
   * No recurring timer, directory watcher, or refresh loop is added for idle harnesses. */
  changed(target: Target): void {
    if (this.disposed) return
    this.get(target)
    const key = keyFor(target)
    const entry = key && this.entries.get(key)
    if (!entry || entry.timer) return
    if (this.now() - entry.checked >= (this.options.refreshMs ?? REFRESH_MS)) {
      this.schedule(key!, entry)
      return
    }
    const delay = Math.max(500, (this.options.refreshMs ?? REFRESH_MS) - (this.now() - entry.checked))
    entry.timer = setTimeout(() => {
      entry.timer = undefined
      this.schedule(key!, entry)
    }, delay)
    entry.timer.unref()
  }

  /** Useful for a clean shutdown and isolated integration tests. Never awaited by a list frame. */
  async settled(): Promise<void> { await this.queue }
  dispose(): void {
    this.disposed = true
    for (const entry of this.entries.values()) if (entry.timer) clearTimeout(entry.timer)
    this.onChanged = undefined
  }
  private now(): number { return this.options.now?.() ?? Date.now() }
  private schedule(key: string, entry: Entry): void {
    if (this.disposed) return
    if (entry.pending) { entry.dirty = true; return }
    const task = this.queue.then(async () => {
      if (this.disposed) return
      entry.dirty = false
      entry.checked = this.now()
      try { await this.refresh(key, entry) } catch { /* An unreadable usage file must never affect a harness. */ }
    })
    entry.pending = task
    this.queue = task.finally(() => {
      entry.pending = null
      if (entry.dirty) this.changed(entry.target)
    })
  }
  private publish(entry: Entry, state: Checkpoint): void {
    const output = outputSnapshot(state.output)
    if (!state.updatedAt) return
    const previous = entry.value
    if (!state.observed && !output) {
      entry.value = null
      if (previous) this.onChanged?.(entry.target)
      return
    }
    entry.value = { totalTokens: state.observed ? state.total : null, updatedAt: state.updatedAt,
      ...(output ? { output } : {}) }
    if (previous?.totalTokens !== entry.value.totalTokens
      || JSON.stringify(previous?.output) !== JSON.stringify(output ?? undefined)) this.onChanged?.(entry.target)
  }
  private async load(key: string): Promise<Checkpoint> {
    try {
      const file = join(this.directory, `${key}.json`)
      if ((await stat(file)).size > MAX_CACHE_BYTES) return empty(key)
      const raw = JSON.parse(await readFile(file, 'utf8')) as Checkpoint
      if (raw.version === 2 && raw.key === key && Number.isSafeInteger(raw.total) && raw.total >= 0
        && typeof raw.observed === 'boolean'
        && (raw.updatedAt === null || typeof raw.updatedAt === 'string' && Number.isFinite(Date.parse(raw.updatedAt)))
        && Number.isSafeInteger(raw.size) && raw.size >= 0 && Number.isFinite(raw.mtime)
        && Number.isSafeInteger(raw.offset) && raw.offset >= 0 && raw.offset <= raw.size
        && typeof raw.inode === 'string' && typeof raw.boundary === 'string'
        && object(raw.claude) && Object.values(raw.claude).every(validBuckets)
        && object(raw.seen) && Object.values(raw.seen).every(value => value === true)
        && (raw.codex === null || validBuckets(raw.codex)) && validOutputLedger(raw.output)) return raw
    } catch { /* First run, corrupt cache, or removed cache: rebuild from the trusted transcript. */ }
    return empty(key)
  }
  private async save(key: string, state: Checkpoint): Promise<void> {
    const bytes = JSON.stringify(state)
    if (Buffer.byteLength(bytes) > MAX_CACHE_BYTES) throw new Error('Usage checkpoint is too large')
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    const file = join(this.directory, `${key}.json`)
    const temporary = `${file}.${randomUUID()}.tmp`
    try {
      await writeFile(temporary, bytes, { mode: 0o600, flag: 'wx' })
      await rename(temporary, file)
    } finally { await unlink(temporary).catch(() => {}) }
  }
  private async refresh(key: string, entry: Entry): Promise<void> {
    let nextFingerprint: string | undefined
    // Warm, unchanged transcripts need one stat, no checkpoint or transcript reads.
    if (entry.fingerprint && entry.target.transcriptPath) {
      const info = await stat(entry.target.transcriptPath).catch(() => null)
      if (info && entry.fingerprint === `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`) return
    }
    let state = await this.load(key)
    this.publish(entry, state)
    if (entry.target.engine === 'opencode') {
      const read = this.options.readSqlite ?? sqliteReadAll
      const database = this.options.opencodeDb ?? join(env.OPENCODE_DATA_DIR, 'opencode.db')
      const limits = { busyTimeoutMs: 20, cliTimeoutMs: 1000, maxBuffer: 4096 }
      let result = await read(database,
        'SELECT tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write FROM session WHERE id = ?',
        [entry.target.sessionId], limits)
      if (!result.ok) result = await read(database,
        'SELECT tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, 0 AS tokens_cache_write FROM session WHERE id = ?',
        [entry.target.sessionId], limits)
      if (!result.ok || result.rows.length !== 1) return
      const row = result.rows[0]
      if (!['tokens_input', 'tokens_output', 'tokens_reasoning', 'tokens_cache_read', 'tokens_cache_write']
        .every(key => typeof row[key] === 'number' && Number.isSafeInteger(row[key]) && Number(row[key]) >= 0)) return
      state.total = sum(Object.values(row).map(tokens))
      state.observed = true
    } else {
      const path = entry.target.transcriptPath!
      const file = await open(path, 'r')
      try {
        const info = await file.stat()
        if (!info.isFile() || info.size > MAX_TRANSCRIPT_BYTES) return
        const inode = `${info.dev}:${info.ino}`
        const fingerprint = `${inode}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`
        if (state.inode === inode && state.size === info.size && state.mtime === info.mtimeMs) {
          entry.fingerprint = fingerprint
          return
        }
        const boundary = async (offset: number) => {
          const length = Math.min(256, offset)
          const buffer = Buffer.alloc(length)
          const { bytesRead } = await file.read(buffer, 0, length, offset - length)
          this.options.onRead?.(bytesRead)
          return hash(buffer.subarray(0, bytesRead))
        }
        if (state.inode !== inode || info.size < state.size || (info.size === state.size && info.mtimeMs !== state.mtime)
          || state.offset > 0 && await boundary(state.offset) !== state.boundary) state = empty(key)
        let offset = state.offset
        let partial = Buffer.alloc(0)
        while (offset < info.size) {
          const buffer = Buffer.alloc(Math.min(64 * 1024, info.size - offset))
          const { bytesRead } = await file.read(buffer, 0, buffer.length, offset)
          if (!bytesRead) throw new Error('Transcript changed during usage read')
          this.options.onRead?.(bytesRead)
          offset += bytesRead
          const chunk = Buffer.concat([partial, buffer.subarray(0, bytesRead)])
          let start = 0
          for (let end = chunk.indexOf(10); end !== -1; end = chunk.indexOf(10, start)) {
            const line = chunk.subarray(start, end).toString('utf8')
            if (line.length) ingest(state, line, entry.target)
            start = end + 1
          }
          partial = chunk.subarray(start)
          if (partial.length > MAX_LINE_BYTES) throw new Error('Transcript record too large')
          // File I/O yields between chunks; only one transcript backfill runs at once.
        }
        state.offset = offset - partial.length
        state.size = info.size
        state.inode = inode
        state.mtime = info.mtimeMs
        state.boundary = await boundary(state.offset)
        nextFingerprint = fingerprint
      } finally { await file.close() }
    }
    if (!Number.isSafeInteger(state.total)) return
    state.updatedAt = new Date(this.now()).toISOString()
    await this.save(key, state)
    entry.fingerprint = nextFingerprint
    this.publish(entry, state)
  }
}

function validBuckets(value: unknown): value is Buckets {
  return Array.isArray(value) && value.length === 4
    && value.every(n => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0)
}

export const agentTokenUsage = new AgentTokenUsageCache(join(env.ADAPTER_DATA_DIR, 'agent-token-usage'))
