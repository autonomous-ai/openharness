/**
 * The ChatGPT app's Codex threads on the dial, with or without a process
 * (docs/plans/2026-11-19-dial-chatgpt-ring-and-follow-design.md): the newest 16 that codexAppThreads.ts reads from the
 * app's metadata, while a dial is attached. Each is an idle row on the ChatGPT page under the id the observed source
 * gives the same thread, so the hooked copy and this one are one row (registry.ts) and the row keeps its id as the
 * thread's process comes and goes. No process runs it, so it rests: no voice, and no weight in the dial's default app.
 * Every thread the read returns gets its place in the app's sidebar as the page's rank, so a running thread's hooked
 * copy is placed too.
 *
 * Pushed by one watch on the Codex home, never polled. Codex writes its WAL several times a second during any turn, the
 * app's or a terminal's, so one read runs at a time, and the changes during it give one more after it, at least 1 s
 * after its start: a busy machine costs one read a second.
 *
 * A log line says only fixed words and counts: the app's metadata names people's folders and threads.
 */
import type { CodexAppRead, CodexAppThread, CodexAppThreads } from './codexAppThreads.js'
import { observedAgentId, type PaneName } from './observed.js'
import type { RingRank } from './select.js'
import type { Caps, HostAgent, HostSource, PaneSwitch } from './types.js'

/** The least time between the starts of two reads. */
const GAP_MS = 1_000
/** The home's entries that ask for a read: the store, its WAL, the sidebar's projects and Codex's thread names. The
 *  store's `-shm`, Codex's logs and its rollouts change nothing listed. */
const WATCHED: ReadonlySet<string> = new Set([
  'state_5.sqlite', 'state_5.sqlite-wal', '.codex-global-state.json', 'session_index.jsonl',
])

export interface CodexAppSourceDeps {
  /** The reader (codexAppThreads.ts) on the Codex home, computed once by devices.ts. */
  threads: Pick<CodexAppThreads, 'there' | 'read' | 'forget'>
  /** One watch on the Codex home (folderWatch.ts watchNearest), telling the changed entry's name when the OS gave one.
   *  Its stop. */
  watch(changed: (file?: string) => void): () => void
  /** A timer; its cancel is returned. */
  after(ms: number, run: () => void): () => void
  /** A tap on that agent's thread, as the devices route it. */
  focus(threadId: string, agentId: string): Promise<boolean>
  canShow(threadId: string): boolean
  show(threadId: string, agentId: string): Promise<PaneSwitch>
  /** The ChatGPT page's rank: each agent's place in the sidebar's order, or none. */
  rank(rank: RingRank | undefined): void
  monotonic(): number
  log(line: string): void
}

/** A listed thread: its id, which its tap and rest open, and its row. */
interface Row {
  threadId: string
  agent: HostAgent
}

/** The read under way or last run: whether it is under way, and whether it is too soon for the next one, 1 s not
 *  having passed since it started (and that timer's cancel). */
interface Pass {
  under: boolean
  tooSoon: boolean
  cancel: () => void
}

/** What the dial is told a change of: never a new `lastActivityAt` alone, or each write of a working turn would run the
 *  dial's merge. */
const shape = (rows: readonly Row[]): string => JSON.stringify(rows.map(({ agent }) => [agent.id, agent.name, agent.cwd]))

function rowOf(thread: CodexAppThread): Row {
  return {
    threadId: thread.id,
    agent: {
      id: observedAgentId('codex', thread.id),
      engine: 'codex',
      sessionId: thread.id,
      name: thread.name,
      cwd: thread.cwd,
      host: 'codex',
      app: 'codex',
      state: 'idle',
      unseenDone: false,
      resting: true,
      lastActivityAt: thread.at,
    },
  }
}

export class CodexAppSource implements HostSource {
  readonly id = 'codex-app'
  private readonly listeners = new Set<() => void>()
  private rows: Row[] = []
  private names: ReadonlyMap<string, PaneName> = new Map()
  /** The sidebar's order the rank was last given for, its ids joined; none while no rank is set. */
  private order: string | undefined
  private running = false
  /** The count of stops: a read started before the last stop takes nothing. */
  private stops = 0
  private unwatch: (() => void) | undefined
  /** Whether a read waits for the next pass. */
  private again = false
  private pass: Pass | undefined
  /** Whether the home was there, as last said: kept across a detach, so a dial plugged in again says nothing. */
  private there: boolean | undefined
  /** The slowest read said this start, and the counts last said. */
  private slowest: number | undefined
  private said: string | undefined
  /** Whether the last read failed, so a run of failures says one line. */
  private failed = false

  constructor(private readonly deps: CodexAppSourceDeps) {}

  start(): void {
    if (this.running) return
    this.running = true
    this.slowest = undefined
    const there = this.deps.threads.there()
    if (there !== this.there) {
      this.there = there
      this.deps.log(`[codex-app] watch · ${there ? 'on' : 'none'}`)
    }
    // With no home, nothing is watched or read: the next attach looks again.
    if (!there) return
    this.unwatch = this.deps.watch((file) => {
      if (file === undefined || WATCHED.has(file)) this.wake()
    })
    this.wake()
  }

  stop(): void {
    if (!this.running) return
    this.running = false
    this.stops++
    this.unwatch?.()
    this.unwatch = undefined
    this.again = false
    // A read under way runs to its end and takes nothing, so a start meanwhile waits for it: one read at a time.
    if (this.pass) {
      this.pass.cancel()
      this.pass.tooSoon = false
      this.next()
    }
    this.deps.threads.forget()
    this.said = undefined
    this.names = new Map()
    if (this.order !== undefined) {
      this.order = undefined
      this.deps.rank(undefined)
    }
    if (this.rows.length === 0) return
    this.rows = []
    this.emit()
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  list(): HostAgent[] {
    return this.rows.map(({ agent }) => ({ ...agent }))
  }

  /** Status, a tap, and a rest while the app is in front: no process runs the thread to take words or answer. */
  capabilities(): Caps {
    return { status: true, voice: false, focus: true, answer: false }
  }

  async focus(agent: HostAgent): Promise<boolean> {
    const row = this.find(agent.id)
    return row ? this.deps.focus(row.threadId, row.agent.id) : false
  }

  hasPane(agent: HostAgent): boolean {
    const row = this.find(agent.id)
    return row ? this.deps.canShow(row.threadId) : false
  }

  async showPane(agent: HostAgent): Promise<PaneSwitch> {
    const row = this.find(agent.id)
    return row ? this.deps.show(row.threadId, row.agent.id) : 'failed'
  }

  /** The listed threads' names by thread id, the ChatGPT adapter's pane id, so a hooked copy keeps the row's name. */
  paneNames(): ReadonlyMap<string, PaneName> {
    return this.names
  }

  private find(agentId: string): Row | undefined {
    return this.rows.find(({ agent }) => agent.id === agentId)
  }

  private emit(): void {
    for (const listener of [...this.listeners]) listener()
  }

  private wake(): void {
    if (!this.running) return
    this.again = true
    if (!this.pass) void this.run()
  }

  /** A read that ended, 1 s after it started, frees the way: one that waited since runs. */
  private next(): void {
    const pass = this.pass
    if (!pass || pass.under || pass.tooSoon) return
    this.pass = undefined
    if (this.again) void this.run()
  }

  /** One read. A failed one, or a listener that throws, keeps the rows and rank as they were: the next change reads. */
  private async run(): Promise<void> {
    const pass: Pass = { under: true, tooSoon: true, cancel: () => {} }
    this.pass = pass
    pass.cancel = this.deps.after(GAP_MS, () => {
      pass.tooSoon = false
      this.next()
    })
    this.again = false
    const stops = this.stops
    const began = this.deps.monotonic()
    try {
      const read = await this.deps.threads.read()
      if (this.stops !== stops) return
      if (!read.ok) {
        this.fail()
        return
      }
      this.take(read, this.deps.monotonic() - began)
      this.failed = false
    } catch {
      // Nothing throws into the devices process. The error is not said: it can name the home's path.
      this.fail()
    } finally {
      pass.under = false
      this.next()
    }
  }

  private fail(): void {
    if (!this.failed) this.deps.log('[codex-app] read · failed')
    this.failed = true
  }

  private take(read: Extract<CodexAppRead, { ok: true }>, ms: number): void {
    const before = shape(this.rows)
    this.rows = read.listed.map(rowOf)
    this.names = new Map(read.listed.map(({ id, name }) => [id, { title: name, renamed: false }]))
    this.timed(ms, read)
    this.counted(read.listed)
    // A new rank only for a new order: the dial's ring sorts again on each new rank, and a working turn writes its
    // thread's time many times. Set before the change is told, so the dial's next list has it.
    const order = read.order.join('\n')
    if (order !== this.order) {
      this.order = order
      this.deps.rank(new Map(read.order.map((id, at) => [observedAgentId('codex', id), at])))
    }
    if (shape(this.rows) !== before) this.emit()
  }

  /** The first read of a start, then only one slower than every one said: the number the read's target needs, not a
   *  line per write of a working turn. */
  private timed(ms: number, { rows, skipped }: { rows: number; skipped: number }): void {
    if (this.slowest !== undefined && ms <= this.slowest) return
    this.slowest = ms
    this.deps.log(`[codex-app] read · ${Math.round(ms)} ms · ${rows} rows · ${skipped} skipped`)
  }

  /** The listed rows and those of them under a project, said when either count changes. */
  private counted(listed: readonly CodexAppThread[]): void {
    const counts = `${listed.length} threads · ${listed.filter(({ inProject }) => inProject).length} in projects`
    if (counts === this.said) return
    this.said = counts
    this.deps.log(`[codex-app] listed · ${counts}`)
  }
}
