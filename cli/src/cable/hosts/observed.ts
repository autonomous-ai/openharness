import { createHash } from 'node:crypto'
import { basename } from 'node:path'
// Types only: the devices process must not load core code.
import type { ObservedAsked, ObservedEvent, ObservedHookEvent } from '../../core/observedHook.js'
import { truncateUtf8 } from '../../lib/deviceRecentTrim.js'
import type { OpenSessions, SessionRows } from '../../lib/sessionSearch/external.js'
import { type fileStamp, within } from '../../lib/sessionSearch/externals/support.js'
import type { ExternalEngine, RunningProcess } from '../../lib/sessionSearch/externals/types.js'
import { roundDrawable } from '../roundGlyphs.js'
import { detectApp, detectHost, hostDisplayName, UNKNOWN_APP } from './hostDetect.js'
import type { Delivery } from './inbox.js'
import { openTarget, type OpenTarget } from './open.js'
import { MAX_TEXT, ORCA_HANDLE } from './orca.js'
import { isTabApp, type TabApp } from './tabs.js'
import type { Caps, HostAgent, HostAgentState, HostSource, PaneSwitch, SendResult } from './types.js'

export { detectHost, hostDisplayName } from './hostDetect.js'

const NAMESPACE = '6f1d0c3e-5b7a-4c92-8e41-3a9d7b2f60c8'
const MAX_SESSIONS = 50
const END_DELAY_MS = 10_000
const NO_GENERATION_TTL_MS = 12 * 60 * 60 * 1000
/** The dial's card is small; keep what it can show. */
const ANSWER_CHARS = 300
/** The core's Stop grace (STOP_HOOK_GRACE_MS, core/turns/turnHooks.ts, which this process must not load): Claude's
 *  transcript can lag its Stop hook, and an answer read at once is the last turn's or none. */
const ANSWER_GRACE_MS = 1_500
/** A turn's hook runs before the engine marks the turn begun in its record: a turn younger than this may still read idle. */
const TURN_SETTLE_MS = 2_000
/** The tool call's line reaches the transcript just after its permission hook ran, and nobody answers a prompt sooner than
 *  this: a write that soon after the prompt is the asking's own, not the app's answer. */
const ASK_SETTLE_MS = 1_000
/** The firmware's activity line, `activity[100]` (ui_habitat.c), less its terminating zero: it cuts a longer one there. */
const LINE_BYTES = 99
/** A tty read that failed (`ps` timed out under load, or did not run) is tried again on a later event, no sooner than this:
 *  a busy machine is not handed one more `ps` per hook. */
const TTY_RETRY_MS = 10_000

/** What a turn's start was: a prompt a person typed, one another session sent, or the dial's own words. */
export type PromptSource = 'person' | 'relayed' | 'dial'
/** The mod holds the dial's words until a long turn is over: a turn that starts later than this is not theirs. */
const DIAL_PROMPT_TTL_MS = 600_000
/** The dial's words a session holds before a turn starts for them: one that never starts a turn holds no more. */
const MAX_DIAL_PROMPTS = 8

/**
 * The dial's line for a prompt that waits: what it asks, and the app to answer it in. What the round dial cannot draw is a
 * `?`, and the summary is cut, never the app: the line is all that tells the person where the prompt is answered.
 */
export function askedLine(summary: string, host: string): string {
  const where = ` · answer in ${host}`
  const room = LINE_BYTES - Buffer.byteLength(where)
  const shown = roundDrawable(summary)
  return `${Buffer.byteLength(shown) <= room ? shown : `${truncateUtf8(shown, room - Buffer.byteLength('…'))}…`}${where}`
}

/** A name-based UUID (v5 layout, SHA-1) of engine + sessionId, so the same session always gets the same id. */
export function observedAgentId(engine: string, sessionId: string): string {
  const ns = Buffer.from(NAMESPACE.replace(/-/g, ''), 'hex')
  const h = createHash('sha1').update(ns).update(`${engine}\0${sessionId}`).digest()
  h[6] = (h[6] & 0x0f) | 0x50
  h[8] = (h[8] & 0x3f) | 0x80
  const x = h.subarray(0, 16).toString('hex')
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20, 32)}`
}

export interface ObservedDeps {
  now(): number
  /** The machine's processes, read once for every session (externals/support.ts listProcesses); none when unreadable. */
  processes(): Promise<readonly Pick<RunningProcess, 'pid' | 'generation'>[]>
  /** Whether a pid is running, for a session whose process has no generation to read (Windows has no `ps` here). */
  alive(pid: number): boolean
  openSessions: Pick<OpenSessions, 'owners' | 'busy'>
  sessionRows: Pick<SessionRows, 'find'>
  lastAnswer(engine: string, path: string): Promise<string | undefined>
  /** A transcript's last change (externals/support.ts fileStamp): one that grew while its agent waited was answered. */
  fileStamp: typeof fileStamp
  /** Folders whose sessions are Harness's own (its data folder), as the external sessions are given them: never observed. */
  excluded: readonly string[]
  log(line: string): void
  /** The routes for the dial's voice and tap; absent, an agent is status only. */
  actions?: ObservedActions
  /** The app each of these processes runs in, where its parents name one (scannedApp.ts); absent, nothing is learned. */
  apps?(pids: readonly number[]): Promise<ReadonlyMap<number, string>>
  /** The tty of a process in a tab app (tabs.ts readTty), rejecting when `ps` could not be read; absent (off macOS), no
   *  agent has a tab. */
  tty?(pid: number): Promise<string | undefined>
}

export interface ObservedActions {
  /** The session's mod has a poll open, or closed one moments ago. */
  modReady(sessionId: string): boolean
  toMod(sessionId: string, text: string): Promise<Delivery>
  orcaSend(handle: string, text: string): Promise<boolean>
  /** Picks the terminal inside Orca; Orca itself stays where it is. */
  orcaSwitch(handle: string): Promise<PaneSwitch>
  /** Whether a tap can open the target here: macOS brings an app forward, elsewhere only a pane's own command runs. */
  canOpen(target: OpenTarget): boolean
  /** A tap: the agent's pane, then its app (open.ts). */
  open(agentId: string, target: OpenTarget): Promise<boolean>
  /** The Claude app is the app most recently reported in front. */
  claudeInFront(): boolean
  /** A rest: the session in the Claude app, already in front (open.ts). */
  claudeShow(agentId: string, session: string): Promise<PaneSwitch>
  /** A watch holds the tabs stream open: a select has somewhere to go. */
  tabsOpen(): boolean
  /** One select line for the watch, a tap's raising its window too: ok once written, failed with no stream. */
  tabSelect(app: TabApp, tty: string, raise: boolean): PaneSwitch
  count(what: 'mod' | 'orca' | 'waiting' | 'busy' | 'pending' | 'too-long' | 'no-answer'): void
}

/** A pane a rest can show without its app coming forward, by the app that holds it: a later kind is one member here, one
 *  line in shownPane, one case in showPane and its ObservedActions members. */
type ShownPane = { kind: 'orca'; handle: string } | { kind: 'claude'; session: string } | { kind: 'tty'; app: TabApp; tty: string }

interface Entry {
  agent: HostAgent
  /** When its state began (a turn's start renews it): how long a turn has run, and since when an agent waits. */
  since: number
  transcriptPath?: string
  pid: number
  /** The Orca terminal its last event came from. */
  handle?: string
  /** The process its tty was read for, its latest in a tab app, and that tty once read. */
  ttyPid?: number
  tty?: string
  /** When the read of ttyPid began, once that read failed. */
  ttyFailedAt?: number
  /** What a tap opens, from its last event: none for a session the scan found, until its first. */
  opens: OpenTarget
  /** What the permission prompt it waits on asks, from its hook (deviceClaude/asked.ts): '' when it names nothing. */
  asked?: string
  generation?: string
  endAt?: number
  /** The read of the last answer, waiting out the grace. */
  answerTimer?: ReturnType<typeof setTimeout>
  /** When the dial's words reached it, oldest first, each until a turn starts for it. */
  dialPrompts: { at: number }[]
}

export class ObservedSource implements HostSource {
  readonly id = 'observed'
  private readonly entries = new Map<string, Entry>()
  private readonly listeners = new Set<() => void>()
  private scanning: Promise<void> | null = null

  constructor(private readonly deps: ObservedDeps) {}

  list(): HostAgent[] {
    return [...this.entries.values()].map((e) => ({ ...e.agent }))
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  capabilities(agent?: HostAgent): Caps {
    const e = agent && this.entries.get(agent.id)
    const actions = this.deps.actions
    if (!e || !actions) return { status: true, voice: false, focus: false, answer: false }
    // An ended session's terminal holds a shell now, where its words would run.
    const live = this.live(e)
    return {
      status: true,
      voice: live && (!!e.handle || this.modReady(e, actions)),
      focus: live && actions.canOpen(e.opens),
      // Its prompts are answered in its own app: the dial only shows them.
      answer: false,
    }
  }

  /** Only Claude Code runs the mod; another engine's session id is no poll. */
  private modReady(e: Entry, actions: ObservedActions): boolean {
    return e.agent.engine === 'claude' && actions.modReady(e.agent.sessionId!)
  }

  /**
   * The dial's words for the agent, and nothing is queued here: to its mod in every state, as a Harness agent's are
   * (lib/sessionInput.ts), whose `$.prompt.submit` types nothing and starts them once the turn is over; else typed into its
   * Orca terminal, only at its prompt.
   */
  async send(agent: HostAgent, text: string): Promise<SendResult> {
    const e = this.entries.get(agent.id)
    const actions = this.deps.actions
    const refuse = (what: 'waiting' | 'busy' | 'pending' | 'too-long' | 'no-answer', reason: string): SendResult => {
      actions?.count(what)
      return { ok: false, reason }
    }
    if (text.length > MAX_TEXT) return refuse('too-long', 'Too long. Say it shorter.')
    const name = (e?.agent ?? agent).name
    const noAnswer = (): SendResult => refuse('no-answer', `${name} did not answer.`)
    // Its session ended: its terminal holds a shell now, where these words would run.
    if (!e || !actions || !this.live(e)) return noAnswer()
    const handle = e.handle
    if (this.modReady(e, actions)) {
      const delivery = await actions.toMod(e.agent.sessionId!, text)
      if (delivery === 'taken') {
        this.dialPrompt(e)
        actions.count('mod')
        return { ok: true }
      }
      // One before it still waits for the mod's next poll: typed into Orca now, this one would land before it.
      if (delivery === 'busy') return refuse('pending', `${name} has not taken your last words yet.`)
    }
    // In that wait the session may also have ended, moved to another terminal or gone: the old one holds something else.
    if (!handle || !this.live(e) || e.handle !== handle) return noAnswer()
    // A prompt open in the terminal takes what is typed as its answer: Enter there would allow what the dial only shows,
    // as the core never types into a Harness pane that shows one (lib/messageHolds.ts `permission_open`).
    if (e.agent.state === 'needs-you') return refuse('waiting', `${name} is waiting for your answer in ${hostDisplayName(e.agent.host)}.`)
    // A working turn may show a prompt not yet heard of: Codex's approval overlay, which takes `y` or Enter, has no hook, and
    // Claude Code's comes a few hundred ms after its prompt opens.
    if (e.agent.state === 'working' || !this.idleKnown(e)) return refuse('busy', `${name} is busy. Say it when it is done.`)
    // Recorded first: `orca terminal send` returns once the prompt is submitted, and its turn's hook can be heard before.
    const record = this.dialPrompt(e)
    if (!await actions.orcaSend(handle, text)) {
      // Its own record only, if no turn took it meanwhile: an earlier one is the mod's, for words still to come.
      const i = e.dialPrompts.indexOf(record)
      if (i >= 0) e.dialPrompts.splice(i, 1)
      return noAnswer()
    }
    actions.count('orca')
    return { ok: true }
  }

  /** The dial's words reached the session: its next turn is theirs, not a person's. */
  private dialPrompt(e: Entry): { at: number } {
    const record = { at: this.deps.now() }
    if (e.dialPrompts.push(record) > MAX_DIAL_PROMPTS) e.dialPrompts.shift()
    return record
  }

  /**
   * Claude Code's and Codex's idle is their turn state, as the scan and checkWorking read it. Nothing reads another
   * engine's turn: it reads idle only as it was listed, before any hook told of a turn, so it is at its prompt only once a
   * hook said its turn ended, done or errored.
   */
  private idleKnown(e: Entry): boolean {
    return e.agent.engine === 'claude' || e.agent.engine === 'codex' || e.agent.state === 'done' || e.agent.state === 'error'
  }

  /** Still listed, and its session has not ended. */
  private live(e: Entry): boolean {
    return this.entries.get(e.agent.id) === e && e.endAt === undefined
  }

  async focus(agent: HostAgent): Promise<boolean> {
    const e = this.entries.get(agent.id)
    const actions = this.deps.actions
    if (!e || !actions || !this.live(e) || !actions.canOpen(e.opens)) return false
    const opened = await actions.open(e.agent.id, e.opens)
    // `open -b` brings the app forward on whichever tab it had: its window and tab are raised once it came. Read after the
    // open, as an agent that ended or moved meanwhile has no tab to raise.
    const pane = opened ? this.shownPane(agent) : undefined
    if (pane?.kind === 'tty') actions.tabSelect(pane.app, pane.tty, true)
    return opened
  }

  /** Only an Orca terminal, a Claude app session while that app is in front, or a tab a watch can select, is shown without
   *  its app coming forward. */
  hasPane(agent: HostAgent): boolean {
    return this.shownPane(agent) !== undefined
  }

  showPane(agent: HostAgent): Promise<PaneSwitch> {
    const pane = this.shownPane(agent)
    if (!pane) return Promise.resolve('failed')
    switch (pane.kind) {
      case 'orca': return this.deps.actions!.orcaSwitch(pane.handle)
      case 'claude': return this.deps.actions!.claudeShow(agent.id, pane.session)
      // A rest never raises: the app stays where it is.
      case 'tty': return Promise.resolve(this.deps.actions!.tabSelect(pane.app, pane.tty, false))
    }
  }

  /** The pane of its latest event, while it lives: one it left, or an ended session's, holds something else now. A Claude
   *  app session only while a tap could open it and that app is in front, and a tab only while a watch holds the stream
   *  open, each asked at each look: the front moves, and a watch comes and goes. */
  private shownPane(agent: HostAgent): ShownPane | undefined {
    const e = this.entries.get(agent.id)
    const actions = this.deps.actions
    if (!e || !actions || !this.live(e)) return undefined
    if (e.handle) return { kind: 'orca', handle: e.handle }
    const pane = e.opens.pane
    if (pane?.app === 'claude' && actions.canOpen({ pane }) && actions.claudeInFront()) return { kind: 'claude', session: pane.id }
    if (e.tty && isTabApp(e.agent.app) && actions.tabsOpen()) return { kind: 'tty', app: e.agent.app, tty: e.tty }
    return undefined
  }

  /** The live agent in that app's tab: of two that read the same tty, the one heard from last. */
  byTab(app: string, tty: string): HostAgent | undefined {
    let found: Entry | undefined
    for (const e of this.entries.values()) {
      if (e.tty !== tty || e.agent.app !== app || !this.live(e)) continue
      if (!found || e.agent.lastActivityAt > found.agent.lastActivityAt) found = e
    }
    return found && { ...found.agent }
  }

  /**
   * Its tty, read once per process in the background: a session resumed in another tab runs in a process of its own, and
   * the old tab holds something else now, so its tty goes at once. An answer lands only on its own entry, and only while
   * that process is still its latest. A read that fails said nothing of the tty: a later event reads it again, `??` never.
   */
  private learnTty(entry: Entry, pid: number): void {
    const now = this.deps.now()
    if (entry.ttyPid === pid && (entry.ttyFailedAt === undefined || now - entry.ttyFailedAt < TTY_RETRY_MS)) return
    entry.ttyPid = undefined
    entry.tty = undefined
    entry.ttyFailedAt = undefined
    if (!this.deps.tty || !isTabApp(entry.agent.app)) return
    entry.ttyPid = pid
    this.deps.tty(pid).then((tty) => { if (entry.ttyPid === pid) entry.tty = tty }, () => {
      if (entry.ttyPid === pid) entry.ttyFailedAt = now
      // A count only: never the pid or the session.
      this.deps.log('[observed] tty · not read')
    })
  }

  private emit(): void {
    for (const l of [...this.listeners]) l()
  }

  /** What the permission prompt the agent waits on asks, while it waits; '' for a prompt that names nothing. */
  waitingOn(agentId: string): string | undefined {
    return this.entries.get(agentId)?.asked
  }

  /** Takes the event; for a turn's start of a session it lists, answers what started it. */
  ingest(e: ObservedEvent): PromptSource | undefined {
    if (e.event === 'asked') {
      this.asked(e)
      return
    }
    // The end of a session never listed (one of the 50 dropped when full, or ended before the devices started) lists none.
    if (e.event === 'session-end' && !this.entries.has(observedAgentId(e.engine, e.sessionId))) return
    const now = this.deps.now()
    const entry = this.entry(e.engine, e.sessionId, now, {
      cwd: e.cwd, transcriptPath: e.transcriptPath, pid: e.callerPid,
    })
    if (!entry) return
    const a = entry.agent
    a.lastActivityAt = now
    // A hook says where a session runs: one the open scan found is not known yet until its first, unless its parent
    // processes named its app. A hook with no hints says it too: the session runs in a terminal nothing names.
    a.host = detectHost(e.hostHints)
    a.app = detectApp(e.hostHints)
    delete a.appPending
    // Every event's own: a session resumed elsewhere must not be typed into the terminal it left.
    const handle = e.hostHints.ORCA_TERMINAL_HANDLE
    entry.handle = handle && ORCA_HANDLE.test(handle) ? handle : undefined
    entry.opens = openTarget(a.host, e.hostHints)
    if (e.cwd) { a.cwd = e.cwd; a.name = basename(e.cwd) || a.name }
    if (e.transcriptPath) entry.transcriptPath = e.transcriptPath
    if (e.event === 'session-end') {
      entry.endAt = now
      this.clearAsked(entry)
      this.emit()
      return
    }
    // A session that comes back after its end (a resume) is a live one again.
    entry.endAt = undefined
    this.learnTty(entry, e.callerPid)
    let source: PromptSource | undefined
    switch (e.event) {
      case 'session-start':
        // A start must not undo a state a faster event already set.
        break
      case 'turn-start':
        this.setState(entry, 'working', now)
        a.unseenDone = false
        // The last turn's answer is not this one's: cleared, the same answer at this turn's end is a change the dial hears.
        a.lastAnswer = undefined
        source = this.promptSource(entry, e, now)
        break
      case 'needs-input':
        // In every state: the hook hears a prompt only (hook/notify.mjs, never the idle notice), and one can open in any.
        // An agent the open scan found reads idle until its next hook though its turn may run, the quota's resume asks
        // after its turn stopped, and a turn another Stop hook keeps going asks after its Stop.
        this.setState(entry, 'needs-you', now)
        break
      case 'turn-error':
        this.setState(entry, 'error', now)
        break
      case 'turn-stop':
        this.setState(entry, 'done', now)
        a.unseenDone = true
        clearTimeout(entry.answerTimer)
        entry.answerTimer = setTimeout(() => { void this.readAnswer(entry) }, ANSWER_GRACE_MS)
        entry.answerTimer.unref()
        break
    }
    this.emit()
    return source
  }

  private promptSource(entry: Entry, e: ObservedHookEvent, now: number): PromptSource | undefined {
    // Their turn starts on a model call or a tool call (hook/notify.mjs, observedEvent): no prompt at all.
    if (e.engine === 'agy' || e.engine === 'commandcode') return undefined
    // Another session's message is not the dial's words: their turn is still to come.
    if (e.relayed === true) return 'relayed'
    entry.dialPrompts = entry.dialPrompts.filter((p) => now - p.at < DIAL_PROMPT_TTL_MS)
    return entry.dialPrompts.shift() ? 'dial' : 'person'
  }

  /**
   * A permission prompt the session waits on: the agent waits, and the dial's line says for what. Only on an agent the
   * session's own hooks listed: the plugin's hook runs in a Harness pane too, whose agent is Harness's, and says nothing
   * of where a session runs.
   */
  private asked(e: ObservedAsked): void {
    const entry = this.entries.get(observedAgentId(e.engine, e.sessionId))
    if (!entry || !this.live(entry)) return
    const now = this.deps.now()
    this.setState(entry, 'needs-you', now)
    // A new prompt, though the agent may still read needs-you for the last one: what was written before is not its answer.
    entry.since = now
    entry.agent.lastActivityAt = now
    entry.asked = e.summary || e.tool || ''
    // Counts only: never the prompt, the tool or the session.
    this.deps.log('[observed] waiting prompt · shown')
    this.emit()
  }

  /** The prompt it waited on is over. */
  private clearAsked(entry: Entry): void {
    if (entry.asked === undefined) return
    entry.asked = undefined
    this.deps.log('[observed] waiting prompt · cleared')
  }

  private setState(entry: Entry, state: HostAgentState, now: number): void {
    if (entry.agent.state !== state || state === 'working') entry.since = now
    entry.agent.state = state
    if (state !== 'needs-you') this.clearAsked(entry)
  }

  /** The existing entry, or a new one if there is room. */
  private entry(
    engine: string, sessionId: string, now: number,
    init: { cwd?: string; transcriptPath?: string | null; pid: number },
  ): Entry | undefined {
    const id = observedAgentId(engine, sessionId)
    // Harness's own session (the voice router's Claude Code runs in the data folder, outside a pane) is never an agent
    // outside it: one first heard of without its folder (a hook cut to its bound) goes once the folder is known.
    if (init.cwd && this.deps.excluded.some((dir) => within(dir, init.cwd!))) {
      if (this.entries.delete(id)) this.emit()
      return undefined
    }
    const have = this.entries.get(id)
    if (have) return have
    if (this.entries.size >= MAX_SESSIONS && !this.evict()) {
      this.deps.log(`[observed] full; dropped ${engine} session`)
      return undefined
    }
    const entry: Entry = {
      agent: {
        id, engine, sessionId, cwd: init.cwd,
        name: (init.cwd && basename(init.cwd)) || engine,
        host: 'terminal',
        app: UNKNOWN_APP,
        appPending: true,
        state: 'idle', lastActivityAt: now, unseenDone: false, callerPid: init.pid,
      },
      since: now,
      pid: init.pid,
      opens: {},
      dialPrompts: [],
      ...(init.transcriptPath ? { transcriptPath: init.transcriptPath } : {}),
    }
    this.entries.set(id, entry)
    return entry
  }

  /** Drops the oldest idle session; failing that the oldest finished one. False when every session is busy. */
  private evict(): boolean {
    const oldest = (states: HostAgentState[]): Entry | undefined =>
      [...this.entries.values()]
        .filter((e) => states.includes(e.agent.state))
        .sort((x, y) => x.agent.lastActivityAt - y.agent.lastActivityAt)[0]
    const victim = oldest(['idle']) ?? oldest(['done', 'error'])
    if (!victim) return false
    this.entries.delete(victim.agent.id)
    return true
  }

  private async readAnswer(entry: Entry): Promise<void> {
    if ((entry.agent.engine !== 'claude' && entry.agent.engine !== 'codex') || !entry.transcriptPath) return
    let text: string | undefined
    try {
      text = await this.deps.lastAnswer(entry.agent.engine, entry.transcriptPath)
    } catch (error) {
      this.deps.log(`[observed] last answer not read: ${error instanceof Error ? error.message : error}`)
      return
    }
    if (!text || this.entries.get(entry.agent.id) !== entry) return
    // A newer turn began while the file was read; its answer is not this one's.
    if (entry.agent.state !== 'done') return
    // By code point: a cut through an emoji's surrogate pair leaves a broken character on the card.
    const chars = Array.from(text)
    entry.agent.lastAnswer = chars.length > ANSWER_CHARS ? `${chars.slice(0, ANSWER_CHARS - 1).join('')}…` : text
    this.emit()
  }

  /** Adds the sessions found open in a terminal or app, idle or in a turn, until their next hook event. One look at a time. */
  scanOpen(): Promise<void> {
    this.scanning ??= this.scanOnce().finally(() => { this.scanning = null })
    return this.scanning
  }

  private async scanOnce(): Promise<void> {
    // One fresh look at the machine's processes for every session, each of its reads under a timeout
    // (externals/support.ts): the cached answer is empty before the first look, so the scan a dial's attach runs would
    // find nothing until the next one, 60 s later. Then the rows of only the sessions it found, from their own stores.
    const owners = await this.deps.openSessions.owners()
    const open = new Map<string, ExternalEngine>()
    for (const [sessionId, owner] of owners) {
      if (!owner.harness && !this.entries.has(observedAgentId(owner.engine, sessionId))) open.set(sessionId, owner.engine)
    }
    if (!open.size) return
    const rows = await this.deps.sessionRows.find(open)
    // Asked once, as a session is first listed: its next hook is the next word on where it runs.
    const pids = [...open].filter(([sessionId, engine]) => rows.has(sessionId) && !this.entries.has(observedAgentId(engine, sessionId)))
      .slice(0, MAX_SESSIONS).map(([sessionId]) => owners.get(sessionId)!.pid)
    const learning = this.deps.now()
    const apps = await this.appsOf(pids)
    const ms = this.deps.now() - learning
    let listed = 0
    let known = 0
    const now = this.deps.now()
    for (const [sessionId, engine] of open) {
      // No row, no folder to tell Harness's own from a person's (the voice router's transcript is a program's, in the data
      // folder) or to name it by. A hook may also have told of it while the rows or the apps were read: it said more.
      const row = rows.get(sessionId)
      if (!row || this.entries.has(observedAgentId(engine, sessionId))) continue
      const owner = owners.get(sessionId)!
      const entry = this.entry(engine, sessionId, now, { cwd: row.cwd, transcriptPath: row.transcriptPath, pid: owner.pid })
      if (!entry) continue
      listed++
      // The app alone: its host and what a tap opens stay unknown until its first hook.
      const app = apps.get(owner.pid)
      if (app) {
        entry.agent.app = app
        delete entry.agent.appPending
        known++
      }
      this.learnTty(entry, owner.pid)
      // A turn it is in when found reads working, as checkWorking reads it, which ends it once its owner reads idle: listed
      // idle, its compaction's SessionStart (which moves no state) would give a running turn a handle to type into.
      if ((engine === 'claude' || engine === 'codex') && await this.deps.openSessions.busy(owner)
        && entry.agent.state === 'idle' && this.live(entry)) this.setState(entry, 'working', this.deps.now())
    }
    if (!listed) return
    // Counts only: an app, a pid or a path would say whose session runs where.
    this.deps.log(`[observed] scan · ${listed} found · ${known} app known · ${ms} ms`)
    this.emit()
  }

  /** None when there is no reader or it failed: every session is still listed, not known yet. */
  private async appsOf(pids: readonly number[]): Promise<ReadonlyMap<number, string>> {
    if (!this.deps.apps || !pids.length) return new Map()
    try {
      return await this.deps.apps(pids)
    } catch {
      // No error text: a path in it holds the account's name.
      this.deps.log('[observed] scan · apps not read')
      return new Map()
    }
  }

  /** Removals: ended sessions, dead or reused pids, and sessions with no generation silent for 12 h. Called every 30 s by the owner. */
  async tick(): Promise<void> {
    if (!this.entries.size) return
    // Only the sessions known as the read begins: one first heard of while `ps` runs may have a process it did not see.
    const judged = [...this.entries]
    // One read of the machine's processes for every session: a `ps` each blocked the loop for seconds with 50 of them.
    // A table that cannot be read is empty: it always holds the process reading it.
    const table = new Map((await this.deps.processes()).map((p) => [p.pid, p.generation]))
    const now = this.deps.now()
    let changed = false
    for (const [id, e] of judged) {
      if (this.entries.get(id) !== e) continue
      // Its process's generation, noted at the first look that sees it.
      const gen = table.get(e.pid)
      if (gen) e.generation ??= gen
      let gone: boolean
      if (e.endAt !== undefined && now - e.endAt >= END_DELAY_MS) gone = true
      else if (table.size && !table.has(e.pid)) gone = true
      else if (gen) gone = gen !== e.generation
      // No generation to tell a reused pid by: running, and heard from in the last 12 h.
      else gone = !this.deps.alive(e.pid) || now - e.agent.lastActivityAt >= NO_GENERATION_TTL_MS
      if (gone) { this.entries.delete(id); changed = true }
    }
    if (changed) this.emit()
  }

  /**
   * The turns no hook moves, every 3 s. A person who answers a prompt in their own terminal sends no hook: the transcript
   * growing past the moment the agent began waiting says the turn goes on. Codex sends no end-of-turn hook, and a Claude
   * turn stopped with Esc gets no Stop: the owner's record reading idle says each is over.
   */
  async checkWorking(): Promise<void> {
    const all = [...this.entries.values()]
    // A prompt its hook told of writes a line of its own as it asks.
    const answeredAfter = (e: Entry): number => e.since + (e.asked === undefined ? 0 : ASK_SETTLE_MS)
    for (const e of all) {
      if (e.agent.state !== 'needs-you' || !e.transcriptPath) continue
      const stamp = await this.deps.fileStamp(e.transcriptPath)
      if (!stamp || stamp.mtime <= answeredAfter(e) || e.agent.state !== 'needs-you' || this.entries.get(e.agent.id) !== e) continue
      const now = this.deps.now()
      this.setState(e, 'working', now)
      e.agent.lastActivityAt = now
      this.emit()
    }
    const at = this.deps.now()
    const turns = all.filter((e) => (e.agent.engine === 'codex' || e.agent.engine === 'claude')
      && e.agent.state === 'working' && at - e.since >= TURN_SETTLE_MS)
    if (!turns.length) return
    const owners = await this.deps.openSessions.owners()
    for (const e of turns) {
      // Not found says nothing (a process read that timed out finds nobody): only an owner that reads idle ends a turn.
      const owner = owners.get(e.agent.sessionId ?? '')
      if (!owner || await this.deps.openSessions.busy(owner)) continue
      if (e.agent.state !== 'working' || this.entries.get(e.agent.id) !== e) continue
      const now = this.deps.now()
      e.agent.lastActivityAt = now
      if (e.agent.engine === 'claude') {
        // Stopped with Esc: no answer, nothing to tell as done.
        this.setState(e, 'idle', now)
        this.emit()
        continue
      }
      this.setState(e, 'done', now)
      e.agent.unseenDone = true
      this.emit()
      await this.readAnswer(e)
    }
  }

  markSeen(agentId: string): void {
    const e = this.entries.get(agentId)
    if (!e?.agent.unseenDone) return
    e.agent.unseenDone = false
    this.emit()
  }
}
