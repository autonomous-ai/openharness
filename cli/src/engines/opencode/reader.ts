/**
 * OpenCode live tailer.
 *
 * OpenCode has no per-session transcript file — it writes `message`/`part` rows to a SQLite DB. We
 * cannot byte-offset-tail it, so this reader **polls** the DB every ~1s (through `lib/sqliteRead`:
 * `node:sqlite` in-process, or the `sqlite3` CLI on a Node without it) and diffs against per-part
 * state to emit incremental `LiveEvent`s into the same `emitSessionEvents` funnel the file-based
 * engines use.
 *
 * opencode 1.18.6 writes the legacy `message`/`part` tables (the newer `session_message`/`seq` tables
 * exist but are empty), so those are the primary cursor. OpenCode 2 is the other way round: its conversation is
 * in `session_v2`/`session_message`, and the legacy tables only keep what v1 wrote (measured on 2.0.29: 27 recent
 * sessions with messages in `session_message` and none in `message`). A session is read from `session_message`
 * when it has rows there, else from the legacy tables, and the cursor of a v2 session is the row's `time_created`
 * with `seq` tying within the millisecond (`time_created` and `seq` disagree in real stores, so time leads).
 */

import type { LiveEvent } from '../../lib/normalize.js'
import { oversizeRow, readStorePages, type StorePage } from '../../lib/sqlitePage.js'
import {
  MAX_OUTPUT, MAX_THINKING, OC_V2_TURN_TYPES, clip, object, str, ocMessageFromV2,
  opencodeToolName, toolOutputText, toolSummary, userMessageText,
  isTaskPart, taskStartEvent, taskEndEvent,
  type OcMessage, type OcPart, type ChildStats,
} from './normalizer.js'

const ID_RE = /^[A-Za-z0-9_]+$/
const POLL_MS = 1_000

function parseJson(text: unknown): Record<string, unknown> {
  if (typeof text !== 'string') return object(text) ?? {}
  try { return object(JSON.parse(text)) ?? {} } catch { return {} }
}

/** Where a read left off. `seq` is set when the session is OpenCode 2's, ordered by `time_created` first, `seq` breaking its ties. */
interface Cursor { tc: number; id: string; seq?: number }

function cursorOf(msg: OcMessage): Cursor {
  return { tc: msg.timeCreated, id: msg.id, seq: msg.seq }
}

/**
 * Read messages (+ their parts) for one session from opencode.db: from OpenCode 2's `session_message` when the
 * session has rows there, else from the legacy `message`/`part` tables. Either way the result is the v1 shape.
 * `after` restricts to messages strictly after that boundary (for incremental polling); a cursor with a `seq`
 * belongs to a v2 session and one without to a v1 session, so it picks the table it continues in.
 * Read a page at a time, bounded by bytes (lib/sqlitePage.ts): one read of a session past 32 MiB was refused on every
 * poll, so its reader never seeded and its history never loaded (#4188).
 * Read-only, with a short busy timeout, so it never contends with opencode's writer.
 * Throws `OpencodeSqliteMissing` when this machine has no way to read SQLite at all.
 */
export async function readOpencodeMessages(
  dbPath: string,
  sessionId: string,
  after?: Cursor | null,
): Promise<OcMessage[]> {
  return await loadOpencodeMessages(dbPath, sessionId, after) ?? []
}

/** As [readOpencodeMessages], but null when the store did not answer (locked, mid-write, past its deadline). */
async function loadOpencodeMessages(
  dbPath: string,
  sessionId: string,
  after?: Cursor | null,
): Promise<OcMessage[] | null> {
  if (!ID_RE.test(sessionId)) return []
  if (!after || after.seq !== undefined) {
    const afterSeq = Number.isFinite(after?.seq) ? Math.trunc(after!.seq!) : -1
    const afterTimeCreated = after?.seq !== undefined ? after.tc : undefined
    const v2 = await readV2Messages(dbPath, sessionId, afterSeq, afterTimeCreated)
    if (v2 === null || v2.length > 0 || after) return v2
  }
  return readLegacyMessages(dbPath, sessionId, after ?? null)
}

/**
 * The user, assistant and idle rows of an OpenCode 2 session after `afterSeq`, in order. Empty for a v1 session, null
 * when the store did not answer.
 */
async function readV2Messages(dbPath: string, sessionId: string, afterSeq: number, afterTimeCreated?: number): Promise<OcMessage[] | null> {
  const types = OC_V2_TURN_TYPES.map((type) => `'${type}'`).join(', ')
  const page: StorePage = {
    table: 'session_message', where: `t.session_id = ? AND t.type IN (${types})`, params: [sessionId],
    key: [{ as: 'mtc', sql: 't.time_created' }, { as: 'mseq', sql: 't.seq' }],
    columns: [{ as: 'mid', sql: 't.id' }, { as: 'mtype', sql: 't.type' }, { as: 'mdata', sql: 't.data' }],
  }
  const result = await readStorePages(dbPath, page, afterTimeCreated !== undefined ? [afterTimeCreated, afterSeq] : null)
  if (!result.ok) {
    if (result.reason === 'missing') throw new OpencodeSqliteMissing()
    // A store with no `session_message` table (OpenCode 1) reads from the legacy tables; anything else is retried.
    return /no such table/.test(String(result.error?.message)) ? [] : null
  }
  const messages: OcMessage[] = []
  for (const row of result.rows) {
    // A row past the row cap comes back without its data: left out, said once, and the read goes on past it.
    if (Number(row.page_big)) { oversizeRow('opencode', sessionId, `seq ${row.mseq}`); continue }
    const message = ocMessageFromV2({
      id: str(row.mid), type: str(row.mtype), seq: Number(row.mseq) || 0, timeCreated: Number(row.mtc) || 0, data: parseJson(row.mdata),
    })
    if (message && message.id) messages.push(message)
  }
  return messages
}

/** The legacy `message`/`part` tables: OpenCode 1's conversation. */
async function readLegacyMessages(dbPath: string, sessionId: string, after: Cursor | null): Promise<OcMessage[] | null> {
  const bounded = !!after && ID_RE.test(after.id) && Number.isFinite(after.tc)
  // A page's unit is a message with all of its parts, so a message is never split across pages. Its own row comes
  // first and carries its data, once; its part rows follow in their order and carry the part alone.
  const page: StorePage = {
    table: 'message', where: 't.session_id = ?', params: [sessionId],
    key: [{ as: 'mtc', sql: 't.time_created' }, { as: 'mid', sql: 't.id' }], columns: [{ as: 'mdata', sql: 't.data' }],
    parts: {
      table: 'part', on: 'p.message_id = t.id', order: ['ptc', 'pid'],
      columns: [{ as: 'ptc', sql: 'p.time_created' }, { as: 'pid', sql: 'p.id' }, { as: 'pdata', sql: 'p.data' }],
    },
  }
  const result = await readStorePages(dbPath, page, bounded ? [Math.trunc(after!.tc), after!.id] : null)
  if (!result.ok) {
    if (result.reason === 'missing') throw new OpencodeSqliteMissing()
    return null // db locked / transient — retry next tick
  }

  const byId = new Map<string, OcMessage>()
  const order: string[] = []
  for (const row of result.rows) {
    const mid = str(row.mid)
    if (!mid) continue
    // A message past the row cap comes back as its own row alone, without data: left out, said once, read past.
    if (Number(row.page_big)) { oversizeRow('opencode', sessionId, `id ${mid}`); continue }
    let msg = byId.get(mid)
    if (!msg) {
      const mdata = parseJson(row.mdata)
      msg = { id: mid, role: str(mdata.role), timeCreated: Number(row.mtc) || 0, data: mdata, parts: [] }
      byId.set(mid, msg)
      order.push(mid)
    }
    const pid = str(row.pid)
    if (pid) {
      const pdata = parseJson(row.pdata)
      msg.parts.push({ id: pid, type: str(pdata.type), data: pdata })
    }
  }
  return order.map((id) => byId.get(id)!)
}

export class OpencodeSqliteMissing extends Error {
  constructor() { super('no SQLite reader (node:sqlite absent and no sqlite3 CLI on PATH) — OpenCode sessions cannot be mirrored') }
}

export interface OpencodeReaderDeps {
  dbPath: string
  sessionId: string
  onEvents: (events: LiveEvent[]) => void
  /** Reports the one-time fatal "no SQLite reader" so the caller can warn + stop the reader. */
  onFatal?: (err: Error) => void
  pollMs?: number
}

/** Is a message a closed boundary? user messages always are; assistants when `step-finish reason:stop`. */
function isDone(msg: OcMessage): boolean {
  if (msg.role !== 'assistant') return true
  return msg.parts.some((p) => p.type === 'step-finish' && str(p.data.reason) === 'stop')
}

export class OpencodeReader {
  private timer: NodeJS.Timeout | null = null
  private polling = false
  private open = false
  private thinking = 0
  private cursor: Cursor | null = null
  /** Whether the session's rows were read once and seeded; until then nothing is emitted (#4065). */
  private hydrated = false
  private readonly emittedText = new Map<string, number>() // partId → chars already emitted
  private readonly thinkingIds = new Map<string, string>() // reasoning partId → stable thinkingId
  private readonly toolStarted = new Set<string>()
  private readonly toolEnded = new Set<string>()
  private readonly seenUser = new Set<string>()

  constructor(private readonly deps: OpencodeReaderDeps) {}

  get turnOpen(): boolean { return this.open }
  closeTurn(): void { this.open = false }

  /** Hydrate silently (no replay), then start polling. */
  async start(): Promise<void> {
    try {
      await this.seed()
    } catch (err) {
      if (err instanceof OpencodeSqliteMissing) { this.deps.onFatal?.(err); return }
    }
    this.timer = setInterval(() => { void this.tick() }, this.deps.pollMs ?? POLL_MS)
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null }
  }

  /**
   * Read the whole session and seed from it. A store that does not answer leaves the reader unseeded, and the next tick
   * reads in full again: with no cursor yet, an incremental read would emit the whole history as new (#4065).
   */
  private async seed(): Promise<void> {
    const all = await loadOpencodeMessages(this.deps.dbPath, this.deps.sessionId, null)
    if (!all) return
    this.hydrated = true
    const opening = this.hydrate(all)
    if (opening.length) this.deps.onEvents(opening)
  }

  /**
   * Seed state from existing rows without replaying them, so we only stream NEW activity after attach —
   * and return the one event that MUST still be emitted: a `turn_started` when we attached mid-turn.
   *
   * Hydrating in silence loses the opening frame of a turn that is already running, and the daemon then
   * drops that turn's recap because it never saw it open. Measured on a real pane:
   *
   *   [agent] fa12f4cb re-attached · engine=opencode · terminal=tmux:%12 · session=ses_fec1
   *   [turn]  ses_fec1 ended                     ← close with nothing to close
   *   [recap] DROPPED (no turn_started was ever seen for this session)
   *
   * Two shapes reach here mid-turn and both were broken, which is why the check is not simply "is the
   * tail an unfinished assistant":
   *
   *   - tail is an in-flight assistant → `open` became true, but silently, so the daemon's `everOpened`
   *     never flipped and the close was dropped;
   *   - tail is the USER row, with no assistant row written yet → `open` stayed false AND the user id
   *     went into `seenUser`, so `processMessage` could never emit the opening frame for it either.
   *
   * Emitting it here costs nothing on a re-attach to an idle session (the tail is a finished assistant,
   * so nothing is emitted) and cannot double-fire: every existing user id is in `seenUser` before the
   * poll loop starts. Content that predates the attach stays unreplayed on purpose — re-emitting it
   * would duplicate the transcript after a daemon restart, and the recap does not need it because it
   * reads opencode's own store (`source=session-json`) rather than this stream.
   *
   * This is the same fix kilo (an opencode fork) already carried; opencode was left behind.
   */
  private hydrate(messages: OcMessage[]): LiveEvent[] {
    if (messages.length === 0) return []
    // Find the last closed boundary; everything up to it is "already seen".
    let boundary = -1
    for (let i = messages.length - 1; i >= 0; i--) { if (isDone(messages[i])) { boundary = i; break } }
    const done = boundary >= 0 ? messages[boundary] : null
    this.cursor = done ? cursorOf(done) : null
    for (const msg of messages) {
      if (msg.role === 'user') this.seenUser.add(msg.id)
      for (const part of msg.parts) this.seedPart(part)
    }
    // Attached mid-turn: either the assistant is still working, or the user row landed and the assistant
    // has not started yet. See the note above for why both count.
    const tail = messages[messages.length - 1]
    this.open = tail.role === 'user' || (tail.role === 'assistant' && !isDone(tail))
    if (!this.open) return []
    let userMessage = ''
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role !== 'user') continue
      userMessage = userMessageText(messages[i])
      break
    }
    return [{ type: 'turn_started', payload: { userMessage } }]
  }

  private seedPart(part: OcPart): void {
    if (part.type === 'text' || part.type === 'reasoning') {
      this.emittedText.set(part.id, str(part.data.text).length)
    } else if (part.type === 'tool') {
      this.toolStarted.add(part.id)
      const status = str((object(part.data.state) ?? {}).status)
      if (status === 'completed' || status === 'error') this.toolEnded.add(part.id)
    }
  }

  private async tick(): Promise<void> {
    if (this.polling) return
    this.polling = true
    try {
      if (!this.hydrated) { await this.seed(); return }
      const batch = await readOpencodeMessages(this.deps.dbPath, this.deps.sessionId, this.cursor)
      if (batch.length === 0) return
      const events: LiveEvent[] = []
      for (const msg of batch) events.push(...await this.processMessage(msg))
      // Advance the cursor past the trailing run of closed messages; keep an in-flight tail for re-read.
      for (let i = batch.length - 1; i >= 0; i--) {
        if (isDone(batch[i])) { this.cursor = cursorOf(batch[i]); break }
      }
      if (events.length) this.deps.onEvents(events)
    } catch (err) {
      if (err instanceof OpencodeSqliteMissing) { this.stop(); this.deps.onFatal?.(err) }
    } finally {
      this.polling = false
    }
  }

  private async processMessage(msg: OcMessage): Promise<LiveEvent[]> {
    if (msg.role === 'user') {
      if (this.seenUser.has(msg.id)) return []
      this.seenUser.add(msg.id)
      const events: LiveEvent[] = []
      if (this.open) events.push({ type: 'turn_ended', payload: {} })
      this.open = true
      events.push({ type: 'turn_started', payload: { userMessage: userMessageText(msg) } })
      return events
    }
    const events: LiveEvent[] = []
    for (const part of msg.parts) {
      if (isTaskPart(part)) events.push(...await this.processTaskPart(part))
      else events.push(...this.processPart(part))
    }
    return events
  }

  /** A `task` tool part spawns a sub-agent child session — emit Task start/end, reading the child
   *  session for its tool-call count so the device/web Task card shows "N toolcalls" like the others. */
  private async processTaskPart(part: OcPart): Promise<LiveEvent[]> {
    const state = object(part.data.state) ?? {}
    const events: LiveEvent[] = []
    const status = str(state.status)
    // opencode writes the part as soon as the tool call starts streaming, BEFORE its arguments are
    // filled in — so announcing on first sight labelled every sub-agent with the `Delegated task`
    // fallback (measured live: two parallel sub-agents, two identical rows). Wait for the input; the row
    // is worth nothing without its description, and it lands within the same poll or the next.
    const described = Object.keys(object(state.input) ?? {}).length > 0
    const settled = status === 'completed' || status === 'error'
    if (!this.toolStarted.has(part.id) && (described || settled)) {
      this.toolStarted.add(part.id)
      events.push(taskStartEvent(part))
    }
    if (settled && !this.toolEnded.has(part.id)) {
      this.toolEnded.add(part.id)
      const childId = str((object(state.metadata) ?? {}).sessionId)
      const childStats = childId ? await this.childStats(childId) : undefined
      events.push(taskEndEvent(part, childStats))
    }
    return events
  }

  private async childStats(childId: string): Promise<ChildStats> {
    try {
      const msgs = await readOpencodeMessages(this.deps.dbPath, childId)
      let tools = 0
      let tokens = 0
      for (const m of msgs) {
        for (const p of m.parts) if (p.type === 'tool' && !isTaskPart(p)) tools++
        const t = object(m.data.tokens) ?? {}
        tokens += (Number(t.input) || 0) + (Number(t.output) || 0)
      }
      return { totalToolUseCount: tools, totalTokens: tokens || undefined }
    } catch { return { totalToolUseCount: 0 } }
  }

  private processPart(part: OcPart): LiveEvent[] {
    if (part.type === 'text') {
      const full = str(part.data.text)
      const seen = this.emittedText.get(part.id) ?? 0
      if (full.length <= seen) return []
      this.emittedText.set(part.id, full.length)
      return [{ type: 'text_delta', payload: { content: full.slice(seen) } }]
    }
    if (part.type === 'reasoning') {
      const full = str(part.data.text)
      const seen = this.emittedText.get(part.id) ?? 0
      if (full.length <= seen) return []
      this.emittedText.set(part.id, full.length)
      let thinkingId = this.thinkingIds.get(part.id)
      if (!thinkingId) { thinkingId = `thinking-opencode-${this.thinking++}`; this.thinkingIds.set(part.id, thinkingId) }
      return [{ type: 'thinking_delta', payload: { content: clip(full.slice(seen), MAX_THINKING), thinkingId } }]
    }
    if (part.type === 'tool') {
      const events: LiveEvent[] = []
      const state = object(part.data.state) ?? {}
      const name = opencodeToolName(str(part.data.tool))
      if (!this.toolStarted.has(part.id)) {
        this.toolStarted.add(part.id)
        events.push({ type: 'tool_start', payload: { id: part.id, tool: name, input: state.input ?? {} } })
      }
      const status = str(state.status)
      if ((status === 'completed' || status === 'error') && !this.toolEnded.has(part.id)) {
        this.toolEnded.add(part.id)
        const output = toolOutputText(state.output)
        const isError = status === 'error'
        events.push({
          type: 'tool_end',
          payload: { id: part.id, tool: name, output: clip(output, MAX_OUTPUT), isError, summary: toolSummary(name, output, isError) },
        })
      }
      return events
    }
    if (part.type === 'step-finish' && str(part.data.reason) === 'stop') {
      if (!this.open) return []
      this.open = false
      return [{ type: 'turn_ended', payload: {} }]
    }
    return []
  }
}
