/**
 * The fourteen engines' live conversations, in their worker (`engine-others`): per attached session a stream that
 * reads it as the core used to (docs/design/2026-11-15-core-plan/engines.md, "Design S"). A file engine's transcript is
 * folded into its normalizer, then tailed by the legacy tailer, line by line; a database engine's store is read by its
 * own reader, which hydrates silently and then polls. Moved out of core/transcripts/attach.ts, ingest.ts and
 * normalizers.ts, core/turns/turnHooks.ts, agyBackstop.ts and core/engines/cursorTasks.ts, the readings as they were.
 *
 * What a stream makes is handed to the core as numbered frames (engines/others/streamProtocol.ts), kept until the core
 * acknowledges them: the events, a failure to announce, what each record says of the profile (the five engines'
 * profile readers run here, over every line), a store's named state, and the turn it leaves. The core keeps the turn's
 * state, decides when to close it, and closes it itself when this process does not answer (core/engines/otherStreams.ts).
 *
 * Each engine's code is loaded on its first stream (engines/inProcess.ts): one nobody runs costs this process nothing.
 */
import { access, open as openFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { ProfileEvidence } from '../facets/runtime.js'
import type { LiveEvent } from '../kit/events.js'
import { foldTranscript } from '../kit/transcriptFold.js'
import { loadEngine, type InProcessModules } from '../inProcess.js'
import { PENDING_TASKS_FILE } from '../cursor/contract.js'
import { OPENCLAW_STATES } from '../openclaw/contract.js'
import { keepsStore, type OtherEngine } from '../otherEngines.js'
import { env } from '../../config/env.js'
import { sid } from '../../lib/log.js'
import { tailFileCapped, WHOLE_READ_CAP_BYTES } from '../../lib/transcriptTail.js'
import type { HistoryEvent, LineEvent, RewrittenEvent, Watcher } from '../../watcher/watcher.js'
import { STREAM_EVIDENCE, STREAM_KEPT_BYTES, STREAMS_MAX, type StreamFrame, type StreamOpened, type StreamTurn } from './streamProtocol.js'

/** The session a stream reads: what the core sent of it, and nothing else. */
export interface StreamSession {
  agentId: string
  sessionId: string
  engine: OtherEngine
  transcriptPath: string | null
  /** The store a database engine keeps the conversation in, as the core names it (core/transcripts/stores.ts). */
  store: string | null
}

export interface StreamOpen {
  token: string
  session: StreamSession
  /** The transcript is the conversation's live first turn, not its history: its fold is emitted (attach's `replayLive`). */
  live: boolean
  /** A turn the fold leaves open began before its engine was started again (core/transcripts/relaunch.ts): history. */
  abandon: boolean
  /** Nothing is delivered until the core lets it go (`release`): it is recovering the session's interpretation. */
  held: boolean
  /** Opened again after this process restarted: nothing replays, the tail goes on from where the core took it, and
   *  the turn is put back as the core holds it. */
  resume?: { turnOpen: boolean; offset?: number }
}

type FileEngine = Exclude<OtherEngine, 'opencode' | 'kilo' | 'hermes' | 'devin' | 'openclaw'>
type Code = InProcessModules[OtherEngine]

/** A file engine's normalizer, as each of theirs is used. */
interface Normalizer {
  readonly turnOpen: boolean
  ingest(line: string): LiveEvent[]
  closeTurn(): LiveEvent[] | void
  abortTurn?(): LiveEvent[]
  openTurn?(text?: string): LiveEvent[]
}
/** A database engine's reader: it reads its store itself, on its own poll. */
interface StoreReader {
  readonly turnOpen: boolean
  start(): Promise<void>
  stop(): void
  closeTurn(): void
  poll(): Promise<void>
  paneRead?(reading: { ready: boolean; gatewayLost: boolean; running: boolean }): void
  paneDue?(): boolean
}

/** A pane read idle stays quiet for this long unless the stream has something new (engines/openclaw/live.ts). */
const QUIET_PANE_MS = 30_000

class Stream {
  serial = 0
  revision = 0
  outbox: Array<{ frame: StreamFrame; bytes: number }> = []
  kept = 0
  held: boolean
  /** Where the transcript's next unread record starts, as the frames taken so far leave it. */
  offset: number | undefined
  normalizer: Normalizer | null = null
  reader: StoreReader | null = null
  private lastTurnOpen = false

  constructor(readonly token: string, readonly session: StreamSession, readonly code: Code, held: boolean,
    private readonly made: (stream: Stream) => void) {
    this.held = held
  }

  get engine(): OtherEngine { return this.session.engine }
  get turnOpen(): boolean { return this.normalizer?.turnOpen ?? this.reader?.turnOpen ?? false }
  turn(): StreamTurn { return { identity: `${this.token}:${this.revision}`, turnOpen: this.turnOpen } }

  /** A turn that started, ended or changed hands is a new turn identity: a close the core asked about an older one is stale. */
  moved(events: readonly LiveEvent[]): void {
    if (this.turnOpen !== this.lastTurnOpen || events.some(event => event.type === 'turn_started' || event.type === 'turn_ended')) this.revision++
    this.lastTurnOpen = this.turnOpen
  }

  push(parts: Omit<StreamFrame, 'serial' | 'turn'>): void {
    this.moved(parts.events)
    const frame: StreamFrame = { serial: ++this.serial, ...parts, turn: this.turn() }
    const bytes = JSON.stringify(frame).length
    this.outbox.push({ frame, bytes })
    this.kept += bytes
    this.made(this)
  }

  /** What the core has taken. */
  ack(serial: number): void {
    while (this.outbox.length && this.outbox[0].frame.serial <= serial) this.kept -= this.outbox.shift()!.bytes
  }

  frames(): StreamFrame[] { return this.outbox.map(entry => entry.frame) }
}

export interface OtherStreamsDeps {
  /** The tailer every file stream shares, as the core's was (watcher/watcher.ts), started with the first. */
  watcher: Pick<Watcher, 'on' | 'addSession' | 'removeSession' | 'pollSession'> & { start?(): void }
  load?: typeof loadEngine
  log?: (line: string) => void
  warn?: (line: string) => void
  /** Where Cursor's hook queues Tasks while no daemon runs (engines/cursor/contract.ts). */
  dataDir?: string
}

/** One record's profile evidence, read by its engine's reader (engines/<engine>/profileReader.ts `transcriptEvidence`). */
function evidenceOf(code: Code, line: string): ProfileEvidence | null {
  const read = (code as { transcriptEvidence?: (raw: Record<string, unknown>) => ProfileEvidence | null }).transcriptEvidence
  if (!read) return null
  let raw: unknown
  try { raw = JSON.parse(line) } catch { return null }
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? read(raw as Record<string, unknown>) : null
}

/** Evidence in order, each repeat of the one before left out (applying it again changes nothing), the newest kept. */
function keepEvidence(list: ProfileEvidence[], next: ProfileEvidence | null): void {
  if (!next) return
  if (list.length && JSON.stringify(list[list.length - 1]) === JSON.stringify(next)) return
  list.push(next)
  if (list.length > STREAM_EVIDENCE) list.shift()
}

/** The lines of a transcript up to `end`, the newest `cap` bytes of them: what a stream opened again folds. */
async function linesTo(path: string, end: number, cap: number): Promise<string[]> {
  const start = Math.max(0, end - cap)
  const handle = await openFile(path, 'r')
  try {
    const buffer = Buffer.alloc(end - start)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, start)
    const lines = buffer.subarray(0, bytesRead).toString('utf8').split('\n')
    if (start > 0) lines.shift()
    return lines.map(line => line.replace(/\r$/, '')).filter(line => line.trim())
  } finally { await handle.close() }
}

/** Whether Cursor's hook queued Tasks while no daemon ran, or is queueing one now (core/engines/cursorTasks.ts, as it was). */
async function cursorQueued(dataDir: string): Promise<boolean> {
  const file = join(dataDir, PENDING_TASKS_FILE)
  for (const path of [`${file}.lock`, file]) {
    try { await access(path); return true } catch { /* not this one */ }
  }
  return false
}

export function createOtherStreams(deps: OtherStreamsDeps) {
  const load = deps.load ?? loadEngine
  const log = deps.log ?? ((line: string) => console.log(line))
  const warn = deps.warn ?? ((line: string) => console.warn(line))
  const dataDir = deps.dataDir ?? env.ADAPTER_DATA_DIR
  const streams = new Map<string, Stream>()
  /** The stream each session's tail and hooks feed: the newest one opened for it. */
  const bySession = new Map<string, Stream>()
  const lost = new Set<string>()
  let wake: (() => void) | null = null
  let tailing = false
  const addSession: OtherStreamsDeps['watcher']['addSession'] = (session, options) => {
    if (!tailing) { tailing = true; deps.watcher.start?.() }
    return deps.watcher.addSession(session, options)
  }
  const made = (stream: Stream): void => {
    // A core that takes nothing cannot make this process hold the session's whole conversation: the stream is given
    // up, and the core attaches the session again, from what is on disk.
    if (stream.kept > STREAM_KEPT_BYTES) {
      warn(`[engine ${stream.engine}] ${sid(stream.session.sessionId)} live stream not taken by the core · ${Math.round(stream.kept / 1024 / 1024)} MB kept · given up`)
      forget(stream.token)
      lost.add(stream.token)
    }
    wake?.()
  }

  // Cursor's Task hooks and the sub-agents they start: built on Cursor's first Task hook, for every Cursor stream.
  type CursorCode = InProcessModules['cursor']
  let tasks: { subagents: InstanceType<CursorCode['CursorSubagentManager']>; queue: InstanceType<CursorCode['CursorTaskHookQueue']> } | null = null
  const cursorTasks = (code: CursorCode) => {
    if (tasks) return tasks
    const emit = (sessionId: string, events: LiveEvent[]): void => {
      const stream = bySession.get(sessionId)
      if (stream && events.length) stream.push({ events })
    }
    const subagents = new code.CursorSubagentManager(code.cursorConfigDir(), emit, code.cursorDataDir())
    const queue = new code.CursorTaskHookQueue({
      drainTranscript: (sessionId) => deps.watcher.pollSession(sessionId),
      emit,
      register: (sessionId, hook, normalizer) => subagents.register(sessionId, hook, normalizer),
      isActive: (sessionId) => bySession.get(sessionId)?.engine === 'cursor',
      onError: (sessionId, error) => { warn(`[cursor] Task hook queue failed (${sessionId}): ${error instanceof Error ? error.message : error}`) },
    })
    tasks = { subagents, queue }
    return tasks
  }
  const enqueueTask = (stream: Stream, toolUseId: string, input: unknown): void => {
    const normalizer = stream.normalizer as InstanceType<CursorCode['CursorNormalizer']> | null
    if (!normalizer) return
    cursorTasks(stream.code as CursorCode).queue.enqueue(stream.session.sessionId, { toolUseId, input }, normalizer)
  }

  // The tailer's lines, each through the normalizer of the session's stream.
  const ingest = (stream: Stream, text: string): { events: LiveEvent[]; failure?: string; failureSummary?: string; evidence?: ProfileEvidence } => {
    const evidence = evidenceOf(stream.code, text)
    const events = stream.normalizer!.ingest(text)
    // Command Code fires no Stop hook for a failed turn: this record IS the notification. `ingest` already closed the
    // turn (its turn_ended is in `events`): the reason is announced first, so the web and the device show the error
    // ahead of the turn closing.
    const commandcode = stream.engine === 'commandcode' ? stream.code as InProcessModules['commandcode'] : null
    const runError = commandcode?.commandCodeRunError(text) ?? null
    return { events, ...(runError !== null ? { failure: runError, failureSummary: commandcode!.commandCodeRunErrorSummary(runError) } : {}),
      ...(evidence ? { evidence } : {}) }
  }
  const current = (evt: { sessionId: string; engine: string }): Stream | undefined => {
    const stream = bySession.get(evt.sessionId)
    return stream?.engine === evt.engine && stream.normalizer && !stream.held ? stream : undefined
  }
  deps.watcher.on('line', (evt: LineEvent) => {
    const stream = current(evt)
    if (!stream) return
    // A single malformed line must never take the process down: contained per line, as the core's was.
    try {
      const read = ingest(stream, evt.text)
      if (evt.next !== undefined) stream.offset = evt.next
      stream.push({ events: read.events, ...(read.failure !== undefined ? { failure: read.failure, failureSummary: read.failureSummary } : {}),
        ...(read.evidence ? { evidence: [read.evidence] } : {}), ...(stream.offset !== undefined ? { offset: stream.offset } : {}) })
    } catch (error) {
      warn(`[engine ${stream.engine}] line handler error (session ${evt.sessionId}): ${error instanceof Error ? error.message : error}`)
    }
  })
  // A catch-up is history, an unfinished last turn included: one frame, which the core emits as a replay.
  deps.watcher.on('history', (batch: HistoryEvent) => {
    const stream = current(batch)
    if (!stream) return
    try {
      const events: LiveEvent[] = []
      const evidence: ProfileEvidence[] = []
      let failure: { failure: string; failureSummary?: string } | null = null
      for (const evt of batch.lines) {
        const read = ingest(stream, evt.text)
        for (const event of read.events) events.push(event)
        keepEvidence(evidence, read.evidence ?? null)
        if (read.failure !== undefined) failure = { failure: read.failure, failureSummary: read.failureSummary }
        if (evt.next !== undefined) stream.offset = evt.next
      }
      stream.push({ events, replay: true, ...(failure ?? {}), ...(evidence.length ? { evidence } : {}),
        ...(stream.offset !== undefined ? { offset: stream.offset } : {}) })
    } catch (error) {
      warn(`[engine ${stream.engine}] history handler error (session ${batch.sessionId}): ${error instanceof Error ? error.message : error}`)
    }
  })
  // Rewritten in place with too much history to replay: its tail already starts at the new end, and the core attaches
  // the session again, from that end, so its turn state is rebuilt from the file.
  deps.watcher.on('rewritten', (event: RewrittenEvent) => {
    const stream = bySession.get(event.sessionId)
    if (stream && stream.session.transcriptPath === event.transcriptPath) stream.push({ events: [], rewritten: true })
  })

  /** A database engine's reader, wired to its stream (core/transcripts/attach.ts, as it was). */
  const storeReader = (stream: Stream): StoreReader => {
    const { session, code } = stream
    const dbPath = session.store!
    const onEvents = (events: LiveEvent[]): void => { stream.push({ events }) }
    const fatal = (engine: string) => (error: Error): void => warn(`[${engine}] ${sid(session.sessionId)} ${error.message}`)
    switch (session.engine) {
      case 'opencode': return new (code as InProcessModules['opencode']).OpencodeReader({ dbPath, sessionId: session.sessionId, onEvents, onFatal: fatal('opencode') })
      case 'kilo': return new (code as InProcessModules['kilo']).KiloReader({ dbPath, sessionId: session.sessionId, onEvents, onFatal: fatal('kilo') })
      case 'hermes': return new (code as InProcessModules['hermes']).HermesReader({ dbPath, sessionId: session.sessionId, onEvents, onFatal: fatal('hermes') })
      case 'devin': return new (code as InProcessModules['devin']).DevinReader({
        dbPath, devinHome: env.DEVIN_HOME, sessionId: session.sessionId, onEvents,
        // Devin has no StopFailure: a turn that dies on a provider error writes no assistant row and fires no Stop hook,
        // so the failure is said and the turn closed here — otherwise the web sits on the typing indicator forever.
        onTurnAborted: (message) => { stream.push({ events: [{ type: 'turn_ended', payload: {} }], failure: message }) },
        onFatal: fatal('devin'),
      })
      default: {
        const openclaw = code as InProcessModules['openclaw']
        // A store this OpenClaw cannot be read from, or one the Gateway does not write, is said on the agent (the core
        // sets the hold, core/transcripts/ingest.ts), and cleared once it reads again or shows the session.
        return new openclaw.OpenclawLive({
          db: dbPath, key: session.sessionId, onEvents,
          onHeader: (record) => {
            const evidence = (openclaw as { transcriptEvidence?: (raw: Record<string, unknown>) => ProfileEvidence | null }).transcriptEvidence?.(record)
            if (evidence) stream.push({ events: [], evidence: [evidence] })
          },
          onFailed: (message) => { stream.push({ events: [], failure: message }) },
          onFatal: (reason) => {
            const hold = reason === 'unsupported' ? OPENCLAW_STATES.unsupported : OPENCLAW_STATES.harnessNode
            warn(`[openclaw] ${sid(session.sessionId)} ${hold}`)
            stream.push({ events: [], hold })
          },
          onRecovered: () => { stream.push({ events: [], hold: null }) },
          onSessionMissing: () => {
            // The folder looked in is the person's to compare with the Gateway's: the local log, never the agent's row.
            warn(`[openclaw] ${sid(session.agentId)} ${OPENCLAW_STATES.noSessions} · looked in ${dirname(dbPath)}`)
            stream.push({ events: [], hold: OPENCLAW_STATES.noSessions })
          },
          onSessionFound: () => { stream.push({ events: [], hold: null }) },
        })
      }
    }
  }

  const normalizerOf = (engine: FileEngine, code: Code, sessionId: string): Normalizer => {
    switch (engine) {
      case 'cursor': return new (code as InProcessModules['cursor']).CursorNormalizer('live', sessionId)
      case 'muse': return new (code as InProcessModules['muse']).MuseNormalizer()
      case 'amp': return new (code as InProcessModules['amp']).AmpNormalizer()
      case 'grok': return new (code as InProcessModules['grok']).GrokNormalizer()
      case 'agy': return new (code as InProcessModules['agy']).AgyNormalizer()
      case 'copilot': return new (code as InProcessModules['copilot']).CopilotNormalizer()
      case 'pi': return new (code as InProcessModules['pi']).PiNormalizer('live')
      case 'omp': return new (code as InProcessModules['omp']).OmpNormalizer('live')
      default: return new (code as InProcessModules['commandcode']).CommandCodeNormalizer('live')
    }
  }

  function forget(token: string): void {
    const stream = streams.get(token)
    if (!stream) return
    streams.delete(token)
    stream.reader?.stop()
    if (bySession.get(stream.session.sessionId) === stream) {
      bySession.delete(stream.session.sessionId)
      if (stream.normalizer && stream.session.transcriptPath) void deps.watcher.removeSession(stream.session.sessionId)
      if (stream.engine === 'cursor') {
        tasks?.subagents.forget(stream.session.sessionId)
        void removeCursorTasks(stream)
      }
    }
  }
  const removeCursorTasks = async (stream: Stream): Promise<void> => {
    if (!await cursorQueued(dataDir)) return
    await (stream.code as InProcessModules['cursor']).removeCursorPendingTasks(dataDir, stream.session.sessionId)
  }

  async function open(ask: StreamOpen): Promise<StreamOpened | null> {
    const { session } = ask
    const code = await load(session.engine)
    if (!code) return null
    if (streams.size >= STREAMS_MAX && !streams.has(ask.token)) {
      // The oldest stream gives way: the core opens it again should it still follow that session.
      const oldest = streams.keys().next().value!
      forget(oldest)
      lost.add(oldest)
    }
    const replaced = bySession.get(session.sessionId)
    const stream = new Stream(ask.token, session, code, ask.held, made)
    streams.set(ask.token, stream)
    bySession.set(session.sessionId, stream)
    // The stream it replaces keeps what it made for the core to take, until the core forgets it; its tail is this one's.
    if (replaced && replaced !== stream) replaced.reader?.stop()
    const resume = ask.resume
    const evidence: ProfileEvidence[] = []
    let historyTurnOpen = false
    let lastStarted: LiveEvent | null = null
    let lastEnded: { aborted: boolean } | null = null
    let initial: LiveEvent[] = []
    let lines = 0
    let abandoned = false
    let paneCheck = false
    if (keepsStore(session.engine)) {
      const reader = stream.reader = storeReader(stream)
      // Opened again: what the store held is history, and only the turn's difference from the core's is said.
      const said = stream.outbox.length
      await reader.start()
      if (resume) {
        const hydrated = stream.outbox.splice(said).map(entry => { stream.kept -= entry.bytes; return entry.frame })
        const started = hydrated.flatMap(frame => frame.events).findLast(event => event.type === 'turn_started') ?? null
        stream.revision++
        if (resume.turnOpen && !reader.turnOpen) stream.push({ events: [{ type: 'turn_ended', payload: {} }] })
        else if (!resume.turnOpen && reader.turnOpen && started) stream.push({ events: [started] })
      }
    } else {
      const normalizer = stream.normalizer = normalizerOf(session.engine as FileEngine, code, session.sessionId)
      const path = session.transcriptPath
      let read: string[] = []
      if (path) {
        if (resume?.offset !== undefined && session.engine !== 'cursor') read = await linesTo(path, resume.offset, WHOLE_READ_CAP_BYTES).catch(() => [])
        else {
          // One huge transcript read whole would take the process down (the October 3 crash, on Codex): its oldest
          // history past the cap is not folded; its last turns, which say whether it is working, are.
          const capped = await tailFileCapped(path, WHOLE_READ_CAP_BYTES)
          if (capped.truncated) warn(`[agent] ${sid(session.agentId)} transcript over ${Math.round(WHOLE_READ_CAP_BYTES / 1024 / 1024)} MB · folded from its newest ${Math.round(WHOLE_READ_CAP_BYTES / 1024 / 1024)} MB`)
          read = capped.lines
        }
      }
      lines = read.length
      for (const line of read) keepEvidence(evidence, evidenceOf(code, line))
      const live = ask.live && !resume
      const folded = foldTranscript((line) => normalizer.ingest(line), read, () => normalizer.turnOpen, { live })
      historyTurnOpen = folded.turnOpen
      initial = folded.live
      lastStarted = folded.history.findLast(event => event.type === 'turn_started') ?? null
      const boundary = folded.history.findLast(event => event.type === 'turn_started' || event.type === 'turn_ended')
      lastEnded = boundary?.type === 'turn_ended' ? { aborted: !!boundary.payload.aborted } : null
      // Copilot's turn lifecycle comes from the agentStop hook, not the file: `copilot --resume` replays a finished
      // conversation, the fold opens a turn on its last `user.message`, and no hook is coming to close it. Its records
      // say where the last activity actually ended.
      if (session.engine === 'copilot' && historyTurnOpen && !(code as InProcessModules['copilot']).copilotHistoryTurnOpen(read)) {
        normalizer.closeTurn()
        historyTurnOpen = false
      }
      // agy's transcript has no end-of-turn record, only its Stop hook does: a fold of a FINISHED conversation still
      // reports its last turn open, and after a restart nothing is coming to close it. The pane is the one place the
      // answer exists: the core reads it (core/transcripts/attach.ts).
      if (session.engine === 'agy' && historyTurnOpen && !resume) paneCheck = true
      // Close the old engine's turn before starting the tail: the tail may deliver a new turn written after the resume
      // at once, and closing it afterward would abandon that new turn instead.
      if (ask.abandon && historyTurnOpen && !resume) { normalizer.closeTurn(); abandoned = true }
      if (resume && normalizer.turnOpen && !resume.turnOpen) normalizer.closeTurn()
      stream.moved([])
      if (path) {
        stream.offset = resume?.offset
        await addSession({ sessionId: session.sessionId, engine: session.engine, transcriptPath: path }, {
          ...(resume?.offset !== undefined && session.engine !== 'cursor' ? { fromOffset: resume.offset } : {}),
          ...(ask.held ? { deliveryAllowed: () => !stream.held } : {}),
        })
      }
      if (resume && resume.turnOpen && !normalizer.turnOpen) stream.push({ events: [{ type: 'turn_ended', payload: {} }] })
      // The Tasks Cursor's hook queued while no daemon ran: followed once its session is.
      if (session.engine === 'cursor' && await cursorQueued(dataDir)) {
        const pending = await (code as InProcessModules['cursor']).loadCursorPendingTasks(dataDir).catch((error: unknown) => {
          warn(`[cursor] pending tasks skipped · ${error instanceof Error ? error.message : error}`)
          return []
        })
        for (const task of pending) if (task.sessionId === session.sessionId) enqueueTask(stream, task.toolUseId, task.input)
      }
    }
    if (streams.get(ask.token) !== stream) return null
    return { turn: stream.turn(), historyTurnOpen, lastStarted, lastEnded, initial, lines, evidence, abandoned,
      frames: stream.frames(), ...(paneCheck ? { paneCheck: true as const } : {}), ...(stream.offset !== undefined ? { offset: stream.offset } : {}) }
  }

  /** The turn closed for the core: what the parser emits closing, which the core says (or not: a cancel's is not). A
   *  Stop's close ends Cursor's sub-agents with the turn; a cancel forgets them. */
  const close = (stream: Stream, how: { abort?: boolean; error?: boolean; stop?: boolean; cancel?: boolean }): LiveEvent[] => {
    let events: LiveEvent[] = []
    const cursor = stream.engine === 'cursor'
    if (stream.normalizer) {
      if (cursor && how.cancel) tasks?.subagents.forget(stream.session.sessionId)
      else if (cursor && how.stop) tasks?.subagents.closeParent(stream.session.sessionId, !!how.error)
      events = (how.abort ? stream.normalizer.abortTurn?.() : stream.normalizer.closeTurn()) ?? []
      // A session's queued Tasks are dropped once its turn is over.
      if (cursor && how.stop) setTimeout(() => void removeCursorTasks(stream), 2_500).unref?.()
    } else stream.reader?.closeTurn()
    stream.moved(events)
    return events
  }

  return {
    open,
    forget,
    stream: (token: string): Stream | undefined => streams.get(token),
    /** A read now of what the session's transcript or store has that the stream has not delivered. Cursor's Tasks first,
     *  which are queued behind a drain of their own. */
    async drain(stream: Stream): Promise<void> {
      if (stream.reader) { await stream.reader.poll(); return }
      if (stream.engine === 'cursor') await tasks?.queue.wait(stream.session.sessionId)
      if (stream.session.transcriptPath) await deps.watcher.pollSession(stream.session.sessionId)
    },
    close,
    /** Command Code's turn, opened from outside its transcript: its PreToolUse hook, or a message the core typed. */
    openTurn(stream: Stream, text?: string): LiveEvent[] {
      const events = stream.normalizer?.openTurn?.(text) ?? []
      stream.moved(events)
      return events
    },
    async tail(stream: Stream, path: string, fromStart: boolean): Promise<void> {
      if (!stream.normalizer) return
      stream.session.transcriptPath = path
      await addSession({ sessionId: stream.session.sessionId, engine: stream.engine, transcriptPath: path }, { fromStart })
    },
    /** Cursor's Task hook: only a Cursor stream follows its sub-agents. */
    task(stream: Stream, toolUseId: string, input: unknown): void { if (stream.engine === 'cursor') enqueueTask(stream, toolUseId, input) },
    /** A bind pass's reading of OpenClaw's pane; how long the pane may now go unread, as its stream judges it. */
    pane(stream: Stream, reading: { ready: boolean; gatewayLost: boolean; running: boolean }): number {
      stream.reader?.paneRead?.(reading)
      return stream.reader?.paneDue?.() === false ? QUIET_PANE_MS : 0
    },
    async release(stream: Stream): Promise<void> {
      stream.held = false
      if (stream.session.transcriptPath) await deps.watcher.pollSession(stream.session.sessionId)
    },
    /** What the core took, by stream; and the streams given up since it last asked. */
    ack(acks: Record<string, number>): string[] {
      for (const [token, serial] of Object.entries(acks)) streams.get(token)?.ack(serial)
      const gone = [...lost]
      lost.clear()
      return gone
    },
    pending: (): Stream[] => [...streams.values()].filter(stream => stream.outbox.length),
    /** The stream each session is read by now. */
    all: (): Stream[] => [...bySession.values()],
    lost: (): boolean => lost.size > 0,
    onMade(listener: (() => void) | null): void { wake = listener },
    /** The core went: what it followed is gone with it. */
    clear(): void {
      for (const token of [...streams.keys()]) forget(token)
      tasks?.subagents.stop()
      lost.clear()
      log(`[engine-others] the core's live streams closed`)
    },
  }
}

export type OtherStreams = ReturnType<typeof createOtherStreams>
export type { Stream as OtherStream }
