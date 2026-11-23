/**
 * Orca's chats on the dial, with or without a process (docs/plans/2026-11-23-dial-orca-chats-design.md, from the Harness
 * Max branch's 6decff7e69). A chat of Orca 1.4.271 is a session Orca runs itself, not a terminal: `orca terminal list`
 * names none, so only a chat whose hook spoke since the devices started was on Orca's page, with no pane (Tony
 * 23 Nov: "Orca · 2 agents" of the 17 his sidebar listed). `orca agent list --json` lists every chat of every worktree:
 * its `kind: "chat"` rows of this computer are resting rows on Orca's page, each with its `worktreeId`, which the scope
 * of the worktree on screen and a tap's `worktree activate` use. `orca worktree list --json` maps the plugin's
 * `identity:<key>` of a worktree to that id.
 *
 * A chat a hook told of (its ORCA_AGENT_SESSION_ID, observed.ts orcaSessions) gets the hooked copy's id and session, so
 * the two are one row (registry.ts), and keeps them as its process comes and goes; any other its Orca id's. Orca's
 * titles name the hooked copies too (paneNames), as the Orca tabs name the hooked agents in them.
 *
 * Read on pushes only, never on a timer (decided 3): the devices ask at a dial's attach, when Orca settles in front, at
 * a new worktree from the plugin and at a hook of a chat this does not list, which are the moments a chat can appear or
 * matter. Orca tells no change of its own, and the Max branch's 5 s poll ran `orca` all day for a list that changes when
 * the person works in Orca. One read runs at a time, and the asks during it make one more after it, never more.
 *
 * At most 64 chats are kept, the newest: the ring holds 16 (select.ts RING_PLACES), and 64 holds the chats of the
 * worktree on screen with room to spare (Tony's 17 across six worktrees, 2026-11-23), while a person with hundreds keeps
 * a bounded list, fold and APPS count. Nothing is kept while no dial is attached.
 *
 * A log line says only fixed words and counts: Orca's lists name people's folders, chats and their words.
 */
import { cutAnswer, observedAgentId, type PaneName } from './observed.js'
import { observedTitle } from './observedTitle.js'
import type { OrcaDeps, OrcaReadDeps } from './orca.js'
import { ORCA_CHAT_REFUSAL } from './orcaChat.js'
import type { Caps, HostAgent, HostAgentState, HostSource } from './types.js'

/** How long each `orca` run may take: Orca answers its lists in a fraction of a second (0.2 s for 17 chats). */
export const ORCA_CHAT_TIMEOUT_MS = 5_000
/** The chats kept, the newest first. */
export const ORCA_CHATS_KEPT = 64
/** The rows parsed of each of Orca's lists: an answer past them is cut, not walked. */
export const ORCA_ROWS_READ = 256
/** Orca's session ids are a UUID, or one after `chat-`: one past 128 or with a control character is none of Orca's. An
 *  agent's id is Orca's short name of its CLI. */
const MAX_SESSION_ID = 128
const ENGINE = /^[a-z][a-z0-9-]{0,31}$/
const CONTROL_CHAR = /\p{Cc}/u
/** A worktree's id is Orca's repo uuid, `::` and the worktree's folder: one past a folder's bound and 64 more is no id
 *  of Orca's (orca.ts holds the same bound). It reaches `orca` as an argument, so none holds a control character. */
const MAX_PATH = 4096
const MAX_WORKTREE_ID = MAX_PATH + 64
/** Orca's identity keys are `wt2:local:<uuid>`; with `identity:` before it the plugin's id stays within 255. */
const IDENTITY_KEY = /^[A-Za-z0-9:._-]{1,246}$/
const IDENTITY = 'identity:'
const AGENT_LIST = ['agent', 'list', '--json']
const WORKTREE_LIST = ['worktree', 'list', '--json']

/** The session a chat a hook told of runs. */
export interface HeardChat {
  engine: string
  sessionId: string
}

export interface OrcaChatDeps {
  /** Orca's CLI (orcaHomes.ts orcaBinary), asked at each read: none while Orca is not installed. */
  binary(): string | null
  /** With no shell: every argument is one, never a command line. */
  run: OrcaDeps['run']
  /** The binary's real path and mtime: `orca agent --help` is read once per pair, as orca.ts orcaWatchesFocus does. */
  mtime: OrcaReadDeps['mtime']
  /** The session each chat a hook told of runs, by its Orca session id (observed.ts orcaSessions). */
  heard(): ReadonlyMap<string, HeardChat>
  /** A tap: the chat's worktree comes up and Orca forward, as the devices route it. Orca's CLI opens no chat. */
  focus(agentId: string, worktreeId: string | undefined): Promise<boolean>
  log(line: string): void
  /** A monotonic clock in ms, for the read's time. */
  now(): number
}

/** Why a read failed, in the log's fixed words. */
type Failure = 'exit' | 'no answer' | 'unreadable'

/** A chat as the last read gave it: what each row is built from again when a hook names its session. */
interface Chat {
  orcaId: string
  engine: string
  name: string
  worktreeId: string
  cwd?: string
  state: HostAgentState
  at: number
  answer?: string
  /** Its place in Orca's list, which the rank follows. */
  place: number
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** Outside text held to a bound before it is kept or reaches a command line. */
const bounded = (value: unknown, max: number): value is string =>
  typeof value === 'string' && value !== '' && value.length <= max && !CONTROL_CHAR.test(value)

/** Orca's states: a chat that works, one that waits on the person (a permission or a question), and one that is done. */
function stateOf(state: unknown): HostAgentState {
  if (state === 'working') return 'working'
  if (state === 'blocked' || state === 'waiting') return 'needs-you'
  return 'idle'
}

/** The folder after the worktree id's `::`, when it is a whole absolute path. */
function folderOf(worktreeId: string): string | undefined {
  const at = worktreeId.indexOf('::')
  const folder = at === -1 ? '' : worktreeId.slice(at + 2)
  return folder.startsWith('/') && folder.length <= MAX_PATH ? folder : undefined
}

/** Orca's preview of the last answer as a card keeps it: on one line, cut as a hooked agent's (observed.ts cutAnswer). */
function answerOf(text: unknown): string | undefined {
  const words = typeof text === 'string' ? text.replace(/[\s\p{Cc}]+/gu, ' ').trim() : ''
  return words === '' ? undefined : cutAnswer(words)
}

/** One row of Orca's list, or none: it is outside text, and a newer Orca may print rows this one does not know. A
 *  terminal agent's row is the Orca adapter's (orca.ts), and a chat of another of Orca's hosts runs on another computer,
 *  which this one's `orca` neither shows nor activates (decided 2). A chat with no worktree id could be neither scoped
 *  nor brought up. */
function chatOf(row: unknown, place: number): Chat | undefined {
  if (!isObject(row) || row.kind !== 'chat' || row.hostId !== 'local') return undefined
  const { orcaSessionId: orcaId, agent, updatedAt, worktreeId } = row
  if (!bounded(orcaId, MAX_SESSION_ID) || !bounded(worktreeId, MAX_WORKTREE_ID)) return undefined
  if (typeof agent !== 'string' || !ENGINE.test(agent)) return undefined
  if (typeof updatedAt !== 'number' || !Number.isFinite(updatedAt)) return undefined
  const cwd = folderOf(worktreeId)
  const answer = answerOf(row.lastAssistantMessage)
  return {
    orcaId,
    engine: agent,
    // An untitled chat is named by its workspace, as Orca's sidebar names it, else by its CLI.
    name: observedTitle(row.title) ?? observedTitle(row.workspace) ?? agent,
    worktreeId,
    ...(cwd !== undefined && { cwd }),
    state: stateOf(row.state),
    at: updatedAt,
    ...(answer !== undefined && { answer }),
    place,
  }
}

/** The rows of an answer Orca's CLI gives (`{ ok: true, result: { <key>: [...] } }`), the first 256; none when it is
 *  not that shape. */
function rowsOf(stdout: string, key: string): unknown[] | undefined {
  let answer: unknown
  try {
    answer = JSON.parse(stdout)
  } catch {
    return undefined
  }
  if (!isObject(answer) || answer.ok !== true || !isObject(answer.result)) return undefined
  const rows = answer.result[key]
  return Array.isArray(rows) ? rows.slice(0, ORCA_ROWS_READ) : undefined
}

/** The chats of `orca agent list --json`'s answer, the newest 64, each once. */
function chatsOf(stdout: string): Chat[] | undefined {
  const rows = rowsOf(stdout, 'agents')
  if (rows === undefined) return undefined
  const chats = new Map<string, Chat>()
  for (const [place, row] of rows.entries()) {
    const chat = chatOf(row, place)
    if (chat && !chats.has(chat.orcaId)) chats.set(chat.orcaId, chat)
  }
  return [...chats.values()].sort((a, b) => b.at - a.at).slice(0, ORCA_CHATS_KEPT)
}

/** A chat's row: the hooked copy's id and session when a hook told of it, else its Orca id's. */
function rowOf({ orcaId, engine, name, cwd, state, at, answer }: Chat, heard: HeardChat | undefined): HostAgent {
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

/** Each identity key of `orca worktree list --json`'s answer to its worktree's id. A worktree with no identity is named
 *  by its id alone, which the devices compare as it is. */
function worktreesOf(stdout: string): Map<string, string> | undefined {
  const rows = rowsOf(stdout, 'worktrees')
  if (rows === undefined) return undefined
  const worktrees = new Map<string, string>()
  for (const row of rows) {
    if (!isObject(row) || !isObject(row.identity) || !bounded(row.id, MAX_WORKTREE_ID)) continue
    const { key } = row.identity
    if (typeof key === 'string' && IDENTITY_KEY.test(key) && !worktrees.has(key)) worktrees.set(key, row.id)
  }
  return worktrees
}

/** Whether `orca agent --help` lists [command]: the first word of a line of its Commands list, which ends at the first
 *  empty line. The word in a description, or past the list, names no command (orca.ts reads `terminal --help` so). */
function listsCommand(help: string, command: string): boolean {
  const lines = help.split('\n').map((line) => line.trim())
  const commands = lines.indexOf('Commands:')
  if (commands === -1) return false
  for (const line of lines.slice(commands + 1)) {
    if (line === '') break
    if (line.split(/\s/, 1)[0] === command) return true
  }
  return false
}

const failureOf = (code: number | null): Failure => (code === 0 ? 'unreadable' : code === null ? 'no answer' : 'exit')

/** The read's time, in the log's buckets. */
const bucketOf = (ms: number): string => (ms < 500 ? '<0.5s' : ms < 2_000 ? '<2s' : '>2s')

function sameEntries(a: ReadonlyMap<string, string>, b: ReadonlyMap<string, string>): boolean {
  if (a.size !== b.size) return false
  for (const [key, value] of a) if (b.get(key) !== value) return false
  return true
}

export class OrcaChatSource implements HostSource {
  readonly id = 'orca-chat'
  private readonly listeners = new Set<() => void>()
  private chats: Chat[] = []
  private byOrcaId = new Map<string, Chat>()
  /** The session each listed chat a hook told of runs, kept past the hooked copy's end: the row keeps its id. */
  private sessions = new Map<string, HeardChat>()
  private rows: HostAgent[] = []
  /** Each row's Orca session id, by the row's id. */
  private orcaIds = new Map<string, string>()
  /** The rows' ids in Orca's order. */
  private ordered: string[] = []
  /** Each identity key to its worktree's id, from the last worktree read, and a count of its changes, so a new map is
   *  told without comparing it whole at every fold. */
  private worktrees = new Map<string, string>()
  private worktreesSeen = 0
  /** The last binary asked whether its `agent` lists chats, and its answer. */
  private probe: { realPath: string; mtimeMs: number; lists: boolean } | undefined
  /** Whether a read is under way, whether one more is asked after it, and whether that one reads the worktrees too. */
  private reading = false
  private again = false
  private worktreesAsked = false
  /** The count of stops: a read started before the last stop takes nothing. */
  private stops = 0
  /** The counts and bucket last said, and whether the last read failed, so a run of failures says one line. */
  private said: string | undefined
  private bucket: string | undefined
  private failing = false

  constructor(private readonly deps: OrcaChatDeps) {}

  /** Reads Orca's chats, and its worktrees with them when asked or when the last worktreeFor missed. One at a time: an
   *  ask during a read makes one more after it, however many come. */
  read(opts: { worktrees?: boolean } = {}): void {
    if (opts.worktrees) this.worktreesAsked = true
    this.again = true
    if (!this.reading) void this.run()
  }

  /** No dial attached: nothing listed, nothing kept, and a read under way takes nothing. */
  stop(): void {
    this.stops++
    this.again = false
    this.worktreesAsked = false
    this.failing = false
    this.bucket = undefined
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

  voiceRefusal(): string {
    // No process of the devices' takes a resting chat's words: Orca has no command to put them in one yet (decided 8).
    return ORCA_CHAT_REFUSAL
  }

  async focus(agent: HostAgent): Promise<boolean> {
    return this.orcaIds.has(agent.id) ? this.deps.focus(agent.id, this.worktreeOfAgent(agent.id)) : false
  }

  /** The rows again with the sessions the hooks named since the last read: a hook that names a chat's session folds its
   *  row into the hooked copy now, not at the next read. */
  refold(): void {
    if (this.chats.length === 0) return
    const before = this.shape()
    this.build(this.chats)
    if (this.shape() !== before) this.emit()
  }

  /** The worktree id of a listed chat, by its Orca session id. */
  worktreeOf(orcaId: string): string | undefined {
    return this.byOrcaId.get(orcaId)?.worktreeId
  }

  /** The worktree id of a listed chat's row, resting or the hooked copy's. */
  worktreeOfAgent(agentId: string): string | undefined {
    const orcaId = this.orcaIds.get(agentId)
    return orcaId === undefined ? undefined : this.worktreeOf(orcaId)
  }

  /** The worktree id the plugin's `identity:<key>` names, from the last worktree read. A miss asks for the worktree list
   *  with the next read: the worktree may be new since. Any other form names no identity: none, and nothing asked. */
  worktreeFor(workspace: string): string | undefined {
    if (!workspace.startsWith(IDENTITY)) return undefined
    const key = workspace.slice(IDENTITY.length)
    if (!IDENTITY_KEY.test(key)) return undefined
    const id = this.worktrees.get(key)
    if (id === undefined) this.worktreesAsked = true
    return id
  }

  /** The listed rows' ids in Orca's order, for the rank. */
  order(): readonly string[] {
    return this.ordered
  }

  /** The listed chats' titles by Orca session id, the place `placed` gives each row's id, so a hooked copy is named as
   *  Orca names its chat (observed.ts setPaneNames). Orca says nothing of who named it. */
  paneNames(): ReadonlyMap<string, PaneName> {
    return new Map(this.chats.map(({ orcaId, name }) => [orcaId, { title: name, renamed: false }]))
  }

  placed(): ReadonlyMap<string, string> {
    return this.orcaIds
  }

  /** Each listener on its own: one that throws neither keeps the next from hearing nor fails a good read. */
  private emit(): void {
    for (const listener of [...this.listeners]) {
      try { listener() } catch { /* said by the listener's own guard */ }
    }
  }

  /** What the dial is told a change of: never a new `lastActivityAt` alone. A chat's worktree, Orca's order and the
   *  worktree map change the scope or the rank. */
  private shape(): string {
    return JSON.stringify([
      this.rows.map((a, at) => [a.id, a.name, a.cwd, a.state, a.lastAnswer, this.chats[at].worktreeId]),
      this.ordered,
      this.worktreesSeen,
    ])
  }

  /** The rows of these chats with the sessions heard. Everything is set at the end: a `heard` that throws leaves the
   *  last rows whole, never rows of one read beside chats of another. */
  private build(chats: Chat[]): void {
    const byOrcaId = new Map(chats.map((chat) => [chat.orcaId, chat]))
    const sessions = new Map<string, HeardChat>()
    for (const [orcaId, kept] of this.sessions) if (byOrcaId.has(orcaId)) sessions.set(orcaId, kept)
    if (chats.length > 0) for (const [orcaId, heard] of this.deps.heard()) if (byOrcaId.has(orcaId)) sessions.set(orcaId, heard)
    const rows = chats.map((chat) => rowOf(chat, sessions.get(chat.orcaId)))
    this.chats = chats
    this.byOrcaId = byOrcaId
    this.sessions = sessions
    this.rows = rows
    this.orcaIds = new Map(rows.map((agent, at) => [agent.id, chats[at].orcaId]))
    this.ordered = rows
      .map((agent, at) => ({ id: agent.id, place: chats[at].place }))
      .sort((a, b) => a.place - b.place)
      .map(({ id }) => id)
  }

  private setWorktrees(worktrees: Map<string, string>): void {
    if (sameEntries(worktrees, this.worktrees)) return
    this.worktrees = worktrees
    this.worktreesSeen++
  }

  /** Nothing listed or kept, the change told; the counts are said again at the next good read. */
  private clear(): void {
    const before = this.shape()
    this.build([])
    this.setWorktrees(new Map())
    this.said = undefined
    if (this.shape() !== before) this.emit()
  }

  private fail(failure: Failure): void {
    if (!this.failing) this.deps.log(`[orca-chat] read · failed · ${failure}`)
    this.failing = true
  }

  /** The reads asked, one after another until none is. */
  private async run(): Promise<void> {
    this.reading = true
    while (this.again) {
      this.again = false
      const worktrees = this.worktreesAsked
      this.worktreesAsked = false
      // Nothing throws into the devices process: a listener's throw is its own guard's to say, and a read that threw
      // leaves the next one free to run.
      await this.once(worktrees).catch(() => {})
    }
    this.reading = false
  }

  /** Whether this Orca's `agent` lists chats, asked once per binary; why not, when `--help` itself failed. */
  private async listsChats(orca: string): Promise<boolean | Failure> {
    const stamp = this.deps.mtime(orca)
    if (stamp === null) return false
    const { probe } = this
    if (probe?.realPath === stamp.realPath && probe.mtimeMs === stamp.mtimeMs) return probe.lists
    const { code, stdout } = await this.ask(orca, ['agent', '--help'])
    // A help that failed says nothing of the CLI: the next read asks again.
    if (code !== 0) return failureOf(code)
    const lists = listsCommand(stdout, 'list')
    this.probe = { ...stamp, lists }
    return lists
  }

  /** A run that rejects is one that gave no answer. */
  private ask(orca: string, args: string[]): Promise<{ code: number | null; stdout: string }> {
    return this.deps.run(orca, args, ORCA_CHAT_TIMEOUT_MS).catch(() => ({ code: null, stdout: '' }))
  }

  /** One read. A failed chat list empties everything; a failed worktree list empties the worktree map alone. */
  private async once(withWorktrees: boolean): Promise<void> {
    const stops = this.stops
    const orca = this.deps.binary()
    // Orca not installed, or too old to list its chats: no chats on the dial, as before, and no line (decided 1).
    const lists = orca === null ? false : await this.listsChats(orca)
    if (this.stops !== stops) return
    if (orca === null || lists === false) {
      this.failing = false
      this.clear()
      return
    }
    if (lists !== true) {
      this.fail(lists)
      this.clear()
      return
    }
    const began = this.deps.now()
    const [agents, trees] = await Promise.all([
      this.ask(orca, AGENT_LIST),
      withWorktrees ? this.ask(orca, WORKTREE_LIST) : undefined,
    ])
    if (this.stops !== stops) return
    const chats = agents.code === 0 ? chatsOf(agents.stdout) : undefined
    if (chats === undefined) {
      // Orca not running, or an answer of another shape: its chats cannot be reached now.
      this.fail(failureOf(agents.code))
      this.clear()
      return
    }
    const worktrees = trees === undefined || trees.code !== 0 ? undefined : worktreesOf(trees.stdout)
    const before = this.shape()
    this.build(chats)
    if (trees === undefined) {
      this.failing = false
    } else if (worktrees === undefined) {
      this.setWorktrees(new Map())
      this.fail(failureOf(trees.code))
    } else {
      this.setWorktrees(worktrees)
      this.failing = false
    }
    this.timed(this.deps.now() - began)
    this.counted()
    if (this.shape() !== before) this.emit()
  }

  /** The read's time, said when its bucket changes: the warning for a person whose Orca lists more than it reads fast. */
  private timed(ms: number): void {
    const bucket = bucketOf(ms)
    if (bucket === this.bucket) return
    this.bucket = bucket
    this.deps.log(`[orca-chat] read · ${bucket}`)
  }

  /** The listed chats and those of them a hook told of, said when either count changes. */
  private counted(): void {
    const counts = `${this.chats.length} chats · ${this.sessions.size} heard`
    if (counts === this.said) return
    this.said = counts
    this.deps.log(`[orca-chat] listed · ${counts}`)
  }
}
