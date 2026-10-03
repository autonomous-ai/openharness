/**
 * Keeps the session search index in step with the transcripts on this machine.
 *
 * One path for everything: a pass reads a transcript from where the last pass stopped — the opening
 * of its last turn, which may have grown since — through the engine's normalizer into the index. The
 * first pass over a session is the backfill; every later one is an increment of a turn or two. A sweep
 * shortly after boot and every few minutes after catches up anything missed; a turn starting or ending
 * in a live session asks for its pass right away, so what was just said is searchable a second later.
 *
 * The daemon's thread is shared with every terminal it streams, so passes run one at a time, read in
 * 1 MB chunks, skip tool output unparsed, and yield to the event loop every few milliseconds.
 */

import { stat } from 'node:fs/promises'
import { performance } from 'node:perf_hooks'

import type { LiveEvent } from '../normalize.js'
import { forEachLine, lineNormalizer, lineTime, skipPredicate } from './transcript.js'
import { TurnCollector } from './turns.js'
import type { IndexedSession, SearchHit, SessionSearchStore, SessionTail } from './store.js'

export interface SearchSource {
  agentId: string
  sessionId: string
  engine: string
  transcriptPath: string | null
  /** What the session is called — name, title, folder — searchable beside what was said in it. */
  header: string
  /**
   * When the conversation last moved (epoch ms), from stamps that move only with it — never the
   * registry's bookkeeping time. Newest sessions are indexed first, and a database-backed history
   * is read again when this moves.
   */
  changedAt: number
  /**
   * The whole history, for an engine that keeps it in a database rather than a transcript file
   * (OpenCode, Kilo, Hermes, Devin). Read in full when the session changed: there is no offset to
   * resume from.
   */
  readHistory?: () => Promise<readonly LiveEvent[]>
  /**
   * A conversation Harness did not start (external.ts). Its `agentId` is empty and its header is made
   * here, from its title and folder: the title the engine gave it (Codex's thread name here; Claude's
   * read from its transcript as it is indexed), else what was first asked in it.
   */
  external?: { cwd: string; origin: string; title: string }
}

/** Claude Code's titles in a transcript: its own, and one the person gave (which wins). */
const CLAUDE_TITLE = /"type":"(ai-title|custom-title)"/

/** The title a Claude Code line gives, kept over [current] unless it is the person's own. */
function claudeTitle(line: string, current: { title: string; custom: boolean } | null): { title: string; custom: boolean } | null {
  try {
    const record = JSON.parse(line) as { type?: unknown; aiTitle?: unknown; customTitle?: unknown }
    if (record.type === 'custom-title' && typeof record.customTitle === 'string' && record.customTitle.trim()) {
      return { title: record.customTitle, custom: true }
    }
    if (record.type === 'ai-title' && typeof record.aiTitle === 'string' && record.aiTitle.trim() && !current?.custom) {
      return { title: record.aiTitle, custom: false }
    }
  } catch { /* not a title after all */ }
  return current
}

/** A title as a header holds it: one line, not an essay. */
function titleLine(text: string): string {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length > 80 ? `${line.slice(0, 79).trimEnd()}…` : line
}

function headerFor(source: SearchSource, title: string): string {
  return source.external ? [title, folderWords(source.external.cwd)].filter(Boolean).join(' · ') : source.header
}

function externalFields(source: SearchSource, title: string): Pick<IndexedSession, 'title' | 'cwd' | 'origin'> {
  return source.external
    ? { title, cwd: source.external.cwd, origin: source.external.origin }
    : { title: '', cwd: '', origin: '' }
}

export interface SessionSearchResult {
  hits: SearchHit[]
  /** Sessions in the index, and sessions still waiting for their first pass. */
  indexed: number
  pending: number
  tookMs: number
}

export interface SessionSearchIndexOptions {
  store: SessionSearchStore
  /** Every session this machine can index: live agents and stopped ones. */
  sources: () => SearchSource[]
  /**
   * Every agent this machine knows, indexable right now or not. An agent's sessions leave the index
   * only when the agent does — never because its current session has no transcript for a moment
   * (a `/clear` between sessions), since its earlier ones cannot be read back once dropped.
   * Defaults to the agents of `sources`.
   */
  agents?: () => Iterable<string>
  log?: (line: string) => void
  /**
   * Which sessions are open in a running process right now (external.ts `OpenSessions`), so a
   * conversation Harness did not start says whether a terminal still has it. `known` never waits.
   */
  openSessions?: { known(): ReadonlyMap<string, 'terminal' | 'app' | 'harness' | 'maybe'>; fresh(): Promise<ReadonlyMap<string, 'terminal' | 'app' | 'harness' | 'maybe'>> }
  /** Looks again for conversations Harness did not start, before each sweep lists its sources. */
  discover?: () => Promise<unknown>
  /** Between full sweeps. */
  sweepEveryMs?: number
  /** How long a pass may hold the thread before yielding. */
  sliceMs?: number
  /** How long after a turn event its session's pass runs: a burst of events is one pass. */
  touchDelayMs?: number
}

const NO_TURN_DELETE = Number.MAX_SAFE_INTEGER
/** Rows written per transaction on a long first pass. */
const WRITE_BATCH = 32

/** The folders a session ran in, as a person would name them: the last two path segments. */
export function folderWords(cwd: string | null | undefined): string {
  if (!cwd) return ''
  return cwd.split(/[\\/]+/).filter(Boolean).slice(-2).reverse().join(' ')
}

export class SessionSearchIndex {
  private readonly queue = new Set<string>()
  /** Sessions with a turn event since their last pass: a database history has no size to compare. */
  private readonly dirty = new Set<string>()
  private readonly touches = new Map<string, NodeJS.Timeout>()
  private sources = new Map<string, SearchSource>()
  private sourcesReadAt = 0
  private running = false
  private stopped = false
  private sweepTimer: NodeJS.Timeout | null = null
  private sliceStart = 0
  /** Callers waiting for a session's next pass (`tail`). */
  private readonly waiters = new Map<string, Array<() => void>>()

  private readonly deletedSessions = new Set<string>()

  constructor(private readonly opts: SessionSearchIndexOptions) {}

  deleteHistory(sessionId: string): void {
    this.deletedSessions.add(sessionId)
    this.sources.delete(sessionId)
    this.queue.delete(sessionId)
    this.dirty.delete(sessionId)
    this.opts.store.removeSession(sessionId)
  }

  /** The first sweep after `delayMs` (boot has other work), then one every `sweepEveryMs`. */
  start(delayMs = 15_000): void {
    const every = this.opts.sweepEveryMs ?? 10 * 60_000
    const first = setTimeout(() => {
      this.sweep()
      this.sweepTimer = setInterval(() => this.sweep(), every)
      this.sweepTimer.unref?.()
    }, delayMs)
    first.unref?.()
    this.sweepTimer = first
  }

  stop(): void {
    this.stopped = true
    if (this.sweepTimer) clearTimeout(this.sweepTimer)
    for (const timer of this.touches.values()) clearTimeout(timer)
    this.touches.clear()
    this.queue.clear()
    for (const id of [...this.waiters.keys()]) this.settle(id)
  }

  /** A turn started or ended in this session: index it shortly. */
  touch(sessionId: string): void {
    if (this.stopped) return
    this.dirty.add(sessionId)
    const pending = this.touches.get(sessionId)
    if (pending) clearTimeout(pending)
    const timer = setTimeout(() => {
      this.touches.delete(sessionId)
      this.refreshSources()
      if (!this.sources.has(sessionId)) this.refreshSources(true)
      // Ahead of a sweep's backlog: what somebody just said is what they are likeliest to look for.
      this.front(sessionId)
      void this.drain()
    }, this.opts.touchDelayMs ?? 1_500)
    timer.unref?.()
    this.touches.set(sessionId, timer)
  }

  /** Queue every known session, newest first; drop sessions whose agent no longer exists. */
  sweep(): void {
    if (this.stopped) return
    if (this.opts.discover) {
      // Which of them are open, looked at now: a search reads it without waiting.
      void this.opts.openSessions?.fresh().catch(() => undefined)
      void this.opts.discover().catch(() => undefined).then(() => this.sweepSources())
      return
    }
    this.sweepSources()
  }

  private sweepSources(): void {
    if (this.stopped) return
    this.refreshSources(true)
    const agents = new Set(this.opts.agents?.() ?? [...this.sources.values()].map((source) => source.agentId))
    for (const sessionId of this.opts.store.sessionIds()) {
      // An agent's earlier sessions (before a /clear) stay findable while the agent exists; one
      // Harness did not start, while its file does.
      const indexed = this.opts.store.session(sessionId)
      if (indexed && !agents.has(indexed.agentId) && !this.sources.has(sessionId)) this.opts.store.removeSession(sessionId)
    }
    const newest = [...this.sources.values()].sort((a, b) => b.changedAt - a.changedAt)
    for (const source of newest) this.queue.add(source.sessionId)
    void this.drain()
  }

  search(query: string, options: { limit?: number; from?: number; to?: number } = {}): SessionSearchResult {
    const started = performance.now()
    const hits = this.opts.store.search(query, options)
    // Whether a terminal still has it, as last looked: a search never waits for a process table.
    if (hits.some((hit) => hit.external) && this.opts.openSessions) {
      const open = this.opts.openSessions.known()
      for (const hit of hits) {
        if (!hit.external) continue
        hit.external.open = open.has(hit.sessionId)
        const where = open.get(hit.sessionId)
        if (where) hit.external.openIn = where
      }
    }
    const indexed = this.opts.store.counts().sessions
    return { hits, indexed, pending: this.queue.size, tookMs: Math.round((performance.now() - started) * 10) / 10 }
  }

  /**
   * The end of one session, for a preview. The last page is brought up to date first: a working
   * agent's current turn otherwise reaches the index only at its next turn event. That pass is waited
   * for at most `freshMs`; after that the preview gets what the index holds.
   */
  async tail(sessionId: string, options: { beforeTurn?: number; maxChars?: number; freshMs?: number } = {}): Promise<SessionTail | null> {
    if (options.beforeTurn === undefined && !this.stopped) {
      this.refreshSources()
      if (!this.sources.has(sessionId)) this.refreshSources(true)
      if (this.sources.has(sessionId)) {
        const passed = new Promise<void>((resolve) => {
          const waiting = this.waiters.get(sessionId) ?? []
          waiting.push(resolve)
          this.waiters.set(sessionId, waiting)
        })
        this.front(sessionId)
        void this.drain()
        let timer: NodeJS.Timeout | undefined
        await Promise.race([passed, new Promise<void>((resolve) => { timer = setTimeout(resolve, options.freshMs ?? 400) })])
        clearTimeout(timer)
      }
    }
    const tail = this.opts.store.tail(sessionId, options)
    const session = tail && this.opts.store.session(sessionId)
    if (tail && session && !session.agentId) {
      // A preview of a conversation Harness did not start says whether a terminal has it, as of now.
      const open = await this.opts.openSessions?.fresh().catch(() => null)
      const where = open?.get(sessionId)
      tail.external = { title: session.title ?? '', cwd: session.cwd ?? '', origin: session.origin ?? '', open: open?.has(sessionId) ?? false, ...(where ? { openIn: where } : {}) }
    }
    return tail
  }

  /** What the index holds about one session. */
  session(sessionId: string): IndexedSession | undefined {
    return this.opts.store.session(sessionId)
  }

  /** A bounded snapshot of the dated conversation text already indexed on this machine. */
  recentConversations(from: number, to: number) {
    return { ...this.opts.store.recentConversations(from, to), indexing: this.queue.size + (this.running ? 1 : 0) }
  }

  /** Moves a session to the head of the queue. */
  private front(sessionId: string): void {
    const rest = [...this.queue].filter((id) => id !== sessionId)
    this.queue.clear()
    this.queue.add(sessionId)
    for (const id of rest) this.queue.add(id)
  }

  private settle(sessionId: string): void {
    const waiting = this.waiters.get(sessionId)
    if (!waiting) return
    this.waiters.delete(sessionId)
    for (const resolve of waiting) resolve()
  }

  /** Runs queued passes one at a time until the queue is empty. */
  async drain(): Promise<void> {
    if (this.running) return
    this.running = true
    try {
      while (!this.stopped && this.queue.size) {
        const sessionId = this.queue.values().next().value as string
        this.queue.delete(sessionId)
        const source = this.sources.get(sessionId)
        if (!source) { this.settle(sessionId); continue }
        try {
          await this.pass(source)
        } catch (error) {
          this.opts.log?.(`[search] ${sessionId.slice(0, 8)} index pass failed: ${error instanceof Error ? error.message : String(error)}`)
        }
        this.settle(sessionId)
      }
    } finally {
      this.running = false
    }
  }

  private refreshSources(force = false): void {
    if (!force && Date.now() - this.sourcesReadAt < 5_000) return
    const next = new Map<string, SearchSource>()
    for (const source of this.opts.sources()) {
      if (!source.sessionId || this.deletedSessions.has(source.sessionId)) continue
      const known = next.get(source.sessionId)
      // One session can be listed live and stopped at once: the fresher record wins.
      if (!known || source.changedAt > known.changedAt) next.set(source.sessionId, source)
    }
    this.sources = next
    this.sourcesReadAt = Date.now()
  }

  /** One pass over one session: from where the last one stopped, or from the start. */
  async pass(source: SearchSource): Promise<void> {
    if (this.deletedSessions.has(source.sessionId)) return
    const store = this.opts.store
    const existing = store.session(source.sessionId)
    const dirty = this.dirty.delete(source.sessionId)
    if (!source.transcriptPath && source.readHistory) return this.historyPass(source, existing, dirty)
    const normalize = source.transcriptPath ? lineNormalizer(source.engine, source.sessionId) : null
    const file = source.transcriptPath && normalize ? await stat(source.transcriptPath).catch(() => null) : null
    const knownTitle = source.external ? source.external.title || existing?.title || '' : ''
    const header = headerFor(source, knownTitle)
    if (!file || !source.transcriptPath || !normalize) {
      // Nothing to read (a terminal, a database-backed engine, a missing file): its name is still findable.
      if (existing?.header === header && existing.agentId === source.agentId) return
      if (this.deletedSessions.has(source.sessionId)) return
      store.writeSession({
        sessionId: source.sessionId, agentId: source.agentId, engine: source.engine,
        path: existing?.path ?? source.transcriptPath ?? '', header,
        size: existing?.size ?? 0, mtime: existing?.mtime ?? 0,
        resumeOffset: existing?.resumeOffset ?? 0, resumeTurn: existing?.resumeTurn ?? 0,
        lastAt: existing?.lastAt ?? (source.changedAt || null), turns: 0,
        ...externalFields(source, knownTitle),
      }, NO_TURN_DELETE, [])
      return
    }
    const path = source.transcriptPath
    const mtime = Math.floor(file.mtimeMs)
    const samePath = existing?.path === path
    if (samePath && existing.size === file.size && existing.mtime === mtime) {
      if (existing.header !== header || existing.agentId !== source.agentId) {
        if (this.deletedSessions.has(source.sessionId)) return
        store.writeSession({ ...existing, header, agentId: source.agentId, ...externalFields(source, knownTitle) }, NO_TURN_DELETE, [])
      }
      return
    }
    // A file that shrank was rewritten: start over. One that grew picks up at its last turn.
    const resume = samePath && file.size >= existing.size && existing.resumeOffset <= file.size
    const from = resume ? existing.resumeOffset : 0
    const fromTurn = resume ? existing.resumeTurn : 0
    const collector = new TurnCollector(fromTurn)
    let lastAt: number | null = null
    let named: { title: string; custom: boolean } | null = null
    this.sliceStart = performance.now()
    const { end } = await forEachLine(path, from, async ({ text, offset }) => {
      const at = lineTime(text) ?? lastAt
      if (at !== null && (lastAt === null || at > lastAt)) lastAt = at
      if (source.external && CLAUDE_TITLE.test(text)) named = claudeTitle(text, named)
      collector.feed(normalize(text), offset, at)
      await this.pace()
    }, { skip: skipPredicate(source.engine), shouldStop: () => this.stopped })
    if (this.stopped) return
    const { closed, open } = collector.finish()
    const turns = open ? [...closed, open] : closed
    const firstAsk = fromTurn === 0 ? turns.find((turn) => turn.ask)?.ask ?? '' : ''
    const title = source.external
      ? titleLine(source.external.title || (named as { title: string } | null)?.title || existing?.title || firstAsk)
      : ''
    const session: IndexedSession = {
      sessionId: source.sessionId, agentId: source.agentId, engine: source.engine, path,
      header: headerFor(source, title),
      size: file.size, mtime,
      resumeOffset: open ? open.offset : end,
      resumeTurn: open ? open.turn : collector.next,
      // Lines with no time of their own (Cursor's) date the session by when its conversation last
      // moved, as its engine says, before the file's own time.
      lastAt: lastAt ?? (resume ? existing.lastAt : null) ?? (source.external && source.changedAt ? source.changedAt : mtime),
      turns: 0,
      ...externalFields(source, title),
    }
    // A long session's first pass writes hundreds of rows. In one transaction that held the thread for
    // 130 ms, so rows go in batches, each but the last saved as a pass that stopped at the next batch:
    // a daemon stopped between them resumes there.
    for (let start = WRITE_BATCH; start < turns.length; start += WRITE_BATCH) {
      const next = turns[start]
      if (this.deletedSessions.has(source.sessionId)) return
      store.writeSession(
        { ...session, size: next.offset, mtime: 0, resumeOffset: next.offset, resumeTurn: next.turn },
        start === WRITE_BATCH ? fromTurn : NO_TURN_DELETE,
        turns.slice(start - WRITE_BATCH, start),
      )
      await this.pace()
      if (this.stopped) return
    }
    const written = Math.floor(Math.max(0, turns.length - 1) / WRITE_BATCH) * WRITE_BATCH
    if (this.deletedSessions.has(source.sessionId)) return
    store.writeSession(session, written ? NO_TURN_DELETE : fromTurn, turns.slice(written))
    if (!resume) {
      this.opts.log?.(`[search] indexed ${source.sessionId.slice(0, 8)} · ${source.engine} · ${closed.length + (open ? 1 : 0)} turns · ${Math.round(file.size / 1024)} KB`)
    }
  }

  /**
   * A database-backed session, read whole the first time, after each turn event (`touch`), and when
   * its activity stamp moved — which catches a turn whose event was lost to a restart. What it read
   * is fingerprinted, so the session counts as worked on only when its conversation changed.
   */
  private async historyPass(source: SearchSource, existing: IndexedSession | undefined, dirty: boolean): Promise<void> {
    const store = this.opts.store
    const stamp = source.changedAt
    // A conversation Harness did not start is headed by its own title and folder, as a transcript's is.
    const headed = (title: string) => ({ header: headerFor(source, title), ...externalFields(source, title) })
    if (existing && !dirty && existing.mtime === stamp) {
      const again = source.external ? headed(existing.title ?? '') : { header: source.header }
      if (existing.header !== again.header || existing.agentId !== source.agentId) {
        if (this.deletedSessions.has(source.sessionId)) return
        store.writeSession({ ...existing, ...again, agentId: source.agentId }, NO_TURN_DELETE, [])
      }
      return
    }
    const events = await source.readHistory!()
    if (this.stopped) return
    const collector = new TurnCollector(0)
    for (let at = 0; at < events.length; at += 200) {
      collector.feed(events.slice(at, at + 200), 0, null)
      await this.pace()
    }
    const { closed, open } = collector.finish()
    const turns = open ? [...closed, open] : closed
    const title = source.external ? titleLine(source.external.title || turns.find((turn) => turn.ask)?.ask || '') : ''
    const head = source.external ? headed(title) : { header: source.header }
    // The size field holds the fingerprint: how much conversation there was when last read.
    const fingerprint = turns.reduce((sum, turn) => sum + turn.ask.length + turn.answer.length + turn.tools.length + 1, 0)
    if (existing && existing.size === fingerprint && existing.mtime === stamp
      && existing.header === head.header && existing.agentId === source.agentId) return
    const changed = !existing || existing.size !== fingerprint
    if (this.deletedSessions.has(source.sessionId)) return
    store.writeSession({
      sessionId: source.sessionId, agentId: source.agentId, engine: source.engine, path: '',
      ...head, size: fingerprint, mtime: stamp, resumeOffset: 0, resumeTurn: 0,
      // Its turns carry no time: the session's is its activity stamp, or now for a turn just seen.
      lastAt: !changed ? existing!.lastAt : dirty ? Math.max(Date.now(), stamp) : stamp || null,
      turns: 0,
    }, 0, turns)
    if (!existing) this.opts.log?.(`[search] indexed ${source.sessionId.slice(0, 8)} · ${source.engine} · ${turns.length} turns`)
  }

  private async pace(): Promise<void> {
    if (performance.now() - this.sliceStart < (this.opts.sliceMs ?? 12)) return
    await new Promise<void>((resolve) => setImmediate(resolve))
    this.sliceStart = performance.now()
  }
}
