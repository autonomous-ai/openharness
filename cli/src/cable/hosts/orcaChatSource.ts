/**
 * Orca's chats on a Harness Max's Orca page, with or without a process (owner 23 Nov: the bar showed 2 of the 5 chats
 * Orca had open). A chat of Orca 1.4.271 is a session Orca runs itself, not a terminal: `orca terminal list` names none,
 * and its Claude transcript says `entrypoint: "orca"`, which the open scan's adoption leaves out
 * (engines/claude/adoption.ts). So only a chat whose hook spoke since the devices started was listed. `orca agent list
 * --json` lists every chat of every workspace Orca has: the newest 16 `kind: "chat"` rows are resting rows on Orca's
 * page, the Max's whole ring (cableHost.ts appRing).
 *
 * A chat a hook told of (its ORCA_AGENT_SESSION_ID, observed.ts orcaSessions) gets the hooked copy's id and session, so the
 * two are one row (registry.ts), and keeps them as its process comes and goes; any other its Orca id's. Orca's titles
 * name the hooked copies too (paneNames), as the Orca tabs name the hooked agents in them.
 *
 * Orca tells no change, so it is read every 5 s, one read at a time, while a dial is attached, and only while one of
 * them is a Max: the other dials' pages stay as they were. A read takes about 0.2 s of `orca`.
 *
 * A log line says only fixed words and counts: Orca's list names people's folders, chats and their words.
 */
import { cutAnswer, observedAgentId, type PaneName } from './observed.js'
import { observedTitle } from './observedTitle.js'
import type { Caps, HostAgent, HostAgentState, HostSource } from './types.js'

/** The time between the end of a read and the start of the next. */
export const ORCA_CHAT_POLL_MS = 5_000
/** How long a read may take: Orca answers in a fraction of a second. */
export const ORCA_CHAT_TIMEOUT_MS = 5_000
/** The chats listed, the newest first: as many as the ChatGPT app's threads (codexAppSource.ts). */
export const ORCA_CHATS = 16
/** Orca's session ids are a UUID or `claude_` and one with underscores: one past 128 or with a control character is
 *  none of Orca's. An agent's id is Orca's short name of its CLI. */
const MAX_SESSION_ID = 128
const ENGINE = /^[a-z][a-z0-9-]{0,31}$/
const CONTROL_CHAR = /\p{Cc}/u
/** A worktree's id is Orca's repo uuid, `::` and the worktree's folder; the folder is the row's. */
const MAX_PATH = 4096

/** The session a chat a hook told of runs. */
export interface HeardChat {
  engine: string
  sessionId: string
}

export interface OrcaChatSourceDeps {
  /** Orca's CLI (orcaHomes.ts orcaBinary), asked at each read: none while Orca is not installed. */
  binary(): string | null
  run(file: string, args: string[], timeoutMs: number): Promise<{ code: number | null; stdout: string }>
  /** Whether a Harness Max is attached (cableFleet.ts wantsWholeApps): only then are the chats read and listed. */
  wanted(): boolean
  /** The session each chat a hook told of runs, by its Orca session id (observed.ts orcaSessions). */
  heard(): ReadonlyMap<string, HeardChat>
  /** A timer; its cancel is returned. */
  after(ms: number, run: () => void): () => void
  /** A tap: Orca comes forward, as the devices route it. Orca's CLI opens no chat. */
  focus(agentId: string): Promise<boolean>
  log(line: string): void
}

/** A chat as the last read gave it: what each row is built from again when a hook names its session. */
interface Chat {
  orcaId: string
  engine: string
  name: string
  cwd?: string
  state: HostAgentState
  at: number
  answer?: string
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** Orca's states: a chat that works, one that waits on the person (a permission or a question), and one that is done. */
function stateOf(state: unknown): HostAgentState {
  if (state === 'working') return 'working'
  if (state === 'blocked' || state === 'waiting') return 'needs-you'
  return 'idle'
}

/** The folder after the worktree id's `::`, when it is a whole absolute path. */
function folderOf(worktreeId: unknown): string | undefined {
  if (typeof worktreeId !== 'string') return undefined
  const at = worktreeId.indexOf('::')
  const folder = at === -1 ? '' : worktreeId.slice(at + 2)
  return folder.startsWith('/') && folder.length <= MAX_PATH && !CONTROL_CHAR.test(folder) ? folder : undefined
}

/** One row of Orca's list, or none: it is outside text, and a newer Orca may print rows this one does not know. */
function chatOf(row: unknown): Chat | undefined {
  if (!isObject(row) || row.kind !== 'chat') return undefined
  const { orcaSessionId: orcaId, agent, updatedAt } = row
  if (typeof orcaId !== 'string' || orcaId === '' || orcaId.length > MAX_SESSION_ID || CONTROL_CHAR.test(orcaId)) return undefined
  if (typeof agent !== 'string' || !ENGINE.test(agent)) return undefined
  if (typeof updatedAt !== 'number' || !Number.isFinite(updatedAt)) return undefined
  const cwd = folderOf(row.worktreeId)
  // Orca's preview of the last answer, already cut: on one line, with no control character, as a card shows it.
  const words = typeof row.lastAssistantMessage === 'string' ? row.lastAssistantMessage.replace(/[\s\p{Cc}]+/gu, ' ').trim() : ''
  const answer = words === '' ? undefined : words
  return {
    orcaId,
    engine: agent,
    // An untitled chat is named by its workspace, as Orca's sidebar names it, else by its CLI.
    name: observedTitle(row.title) ?? observedTitle(row.workspace) ?? agent,
    ...(cwd !== undefined && { cwd }),
    state: stateOf(row.state),
    at: updatedAt,
    ...(answer !== undefined && { answer: cutAnswer(answer) }),
  }
}

/** The chats of `orca agent list --json`'s answer, the newest first, each once; none when it is not Orca's shape. */
function chatsOf(stdout: string): Chat[] | undefined {
  let answer: unknown
  try {
    answer = JSON.parse(stdout)
  } catch {
    return undefined
  }
  if (!isObject(answer) || answer.ok !== true || !isObject(answer.result) || !Array.isArray(answer.result.agents)) return undefined
  const chats = new Map<string, Chat>()
  for (const row of answer.result.agents) {
    const chat = chatOf(row)
    if (chat && !chats.has(chat.orcaId)) chats.set(chat.orcaId, chat)
  }
  return [...chats.values()].sort((a, b) => b.at - a.at).slice(0, ORCA_CHATS)
}

/** What the dial is told a change of: never a new `lastActivityAt` alone. */
const shape = (rows: readonly HostAgent[]): string =>
  JSON.stringify(rows.map((a) => [a.id, a.name, a.cwd, a.state, a.lastAnswer]))

export class OrcaChatSource implements HostSource {
  readonly id = 'orca-chat'
  private readonly listeners = new Set<() => void>()
  private chats: Chat[] = []
  /** The session each listed chat a hook told of runs, kept past the hooked copy's end: the row keeps its id. */
  private readonly sessions = new Map<string, HeardChat>()
  private rows: HostAgent[] = []
  /** Each row's Orca session id, by the row's id. */
  private orcaIds = new Map<string, string>()
  private running = false
  /** The count of stops: a read started before the last stop takes nothing. */
  private stops = 0
  private cancel: (() => void) | undefined
  /** The counts last said, and whether the last read failed, so a run of failures says one line. */
  private said: string | undefined
  private failed = false

  constructor(private readonly deps: OrcaChatSourceDeps) {}

  start(): void {
    if (this.running) return
    this.running = true
    void this.tick()
  }

  stop(): void {
    if (!this.running) return
    this.running = false
    this.stops++
    this.cancel?.()
    this.cancel = undefined
    this.said = undefined
    this.failed = false
    this.clear()
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  list(): HostAgent[] {
    return this.rows.map((agent) => ({ ...agent }))
  }

  /** Status and a tap: no process of the devices' runs the chat to take words or answer. */
  capabilities(): Caps {
    return { status: true, voice: false, focus: true, answer: false }
  }

  async focus(agent: HostAgent): Promise<boolean> {
    return this.orcaIds.has(agent.id) ? this.deps.focus(agent.id) : false
  }

  /** The listed chats' titles by Orca session id, the place `placed` gives each row's id, so a hooked copy is named as
   *  Orca names its chat (observed.ts setPaneNames). Orca says nothing of who named it. */
  paneNames(): ReadonlyMap<string, PaneName> {
    return new Map(this.chats.map(({ orcaId, name }) => [orcaId, { title: name, renamed: false }]))
  }

  placed(): ReadonlyMap<string, string> {
    return this.orcaIds
  }

  /** The rows again with the sessions the hooks named since the last read: a hook that names a chat's session folds its
   *  row into the hooked copy now, not at the next read. */
  refold(): void {
    if (this.chats.length === 0) return
    this.build()
  }

  /** Each listener on its own: one that throws neither keeps the next from hearing nor fails a good read. */
  private emit(): void {
    for (const listener of [...this.listeners]) {
      try { listener() } catch { /* said by the listener's own guard */ }
    }
  }

  private clear(): void {
    this.chats = []
    this.sessions.clear()
    this.build()
  }

  private build(): void {
    const before = shape(this.rows)
    for (const [orcaId, heard] of this.deps.heard()) this.sessions.set(orcaId, heard)
    const listed = new Set(this.chats.map(({ orcaId }) => orcaId))
    for (const orcaId of this.sessions.keys()) if (!listed.has(orcaId)) this.sessions.delete(orcaId)
    this.rows = this.chats.map((chat) => this.rowOf(chat))
    this.orcaIds = new Map(this.rows.map((agent, at) => [agent.id, this.chats[at].orcaId]))
    if (shape(this.rows) !== before) this.emit()
  }

  private rowOf({ orcaId, engine, name, cwd, state, at, answer }: Chat): HostAgent {
    const heard = this.sessions.get(orcaId)
    return {
      id: heard ? observedAgentId(heard.engine, heard.sessionId) : observedAgentId('orca', orcaId),
      engine: heard?.engine ?? engine,
      ...(heard && { sessionId: heard.sessionId }),
      name,
      ...(cwd !== undefined && { cwd }),
      host: 'orca',
      app: 'orca',
      state,
      unseenDone: false,
      resting: true,
      lastActivityAt: at,
      ...(answer !== undefined && { lastAnswer: answer }),
    }
  }

  /** One read, then the next after the poll's time. With no Max attached nothing is read and nothing listed. */
  private async tick(): Promise<void> {
    const stops = this.stops
    try {
      await this.read()
    } catch {
      // Nothing throws into the devices process: a listener's throw is its own guard's to say.
    }
    if (this.stops !== stops || !this.running) return
    this.cancel = this.deps.after(ORCA_CHAT_POLL_MS, () => { void this.tick() })
  }

  private async read(): Promise<void> {
    const orca = this.deps.wanted() ? this.deps.binary() : null
    if (orca === null) {
      this.said = undefined
      if (this.chats.length > 0) this.clear()
      return
    }
    const stops = this.stops
    const { code, stdout } = await this.deps.run(orca, ['agent', 'list', '--json'], ORCA_CHAT_TIMEOUT_MS)
    if (this.stops !== stops) return
    const chats = code === 0 ? chatsOf(stdout) : undefined
    if (chats === undefined) {
      // Orca not running, too old to list its chats, or an answer of another shape: its chats cannot be reached now.
      if (!this.failed) this.deps.log(`[orca-chat] read · failed · ${code === 0 ? 'unreadable' : code === null ? 'no answer' : 'exit'}`)
      this.failed = true
      this.said = undefined
      if (this.chats.length > 0) this.clear()
      return
    }
    this.failed = false
    this.chats = chats
    this.build()
    const counts = `${chats.length} chats · ${this.sessions.size} heard`
    if (counts !== this.said) this.deps.log(`[orca-chat] listed · ${counts}`)
    this.said = counts
  }
}
