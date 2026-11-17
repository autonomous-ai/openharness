import { createHash } from 'node:crypto'
import { basename, join } from 'node:path'
// Types only: the devices process must not load core code.
import type { ObservedAsked, ObservedEvent, ObservedHookEvent } from '../../core/observedHook.js'
import { truncateUtf8 } from '../../lib/deviceRecentTrim.js'
import type { OpenSessions, SessionOwner, SessionRows } from '../../lib/sessionSearch/external.js'
import { type fileStamp, within } from '../../lib/sessionSearch/externals/support.js'
import type { ExternalEngine, RunningProcess } from '../../lib/sessionSearch/externals/types.js'
import { roundDrawable } from '../roundGlyphs.js'
import type { HostAdapter, Pane } from './adapter.js'
import { CODEX_THREAD, type CodexQueue, type CodexQueueFailure } from './codexQueue.js'
import { detectApp, detectHost, hostDisplayName, UNKNOWN_APP } from './hostDetect.js'
import type { Delivery } from './inbox.js'
import { bundleOf, type OpenTarget } from './open.js'
import { MAX_TEXT } from './orca.js'
import { isTabApp } from './tabs.js'
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

/** The name of an agent with no title: its folder's, else its engine (a folder such as `/` has no name). */
function folderName(cwd: string | undefined, engine: string): string {
  return (cwd && basename(cwd)) || engine
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
  /** The name the person gave a Claude Code session, from its own process record (recordName.ts); one that rejects names
   *  nothing. Absent, the scan names by folder. */
  recordName?(owner: Pick<SessionOwner, 'pid' | 'record'> & { sessionId: string }): Promise<string | undefined>
  /** The tty of a process in a tab app (tabs.ts readTty), rejecting when `ps` could not be read; absent (off macOS), no
   *  agent has a tab. */
  tty?(pid: number): Promise<string | undefined>
  /** Every owner a scan read, before any is listed. Absent, nothing is told. */
  scanned?(owners: ReadonlyMap<string, SessionOwner>): void
}

export interface ObservedActions {
  /** The apps an agent may run in, in the order its panes are kept: each verb uses the first pane whose adapter can do it. */
  adapters: readonly HostAdapter[]
  /** The session's mod has a poll open, or closed one moments ago. */
  modReady(sessionId: string): boolean
  toMod(sessionId: string, text: string): Promise<Delivery>
  /** Whether a tap can open the target here: macOS brings an app forward, elsewhere only a pane's own command runs. */
  canOpen(target: OpenTarget): boolean
  /** A tap: the agent's pane and its app, in the order the pane's adapter keeps (open.ts). */
  open(agentId: string, target: OpenTarget): Promise<boolean>
  /** Codex's own queue (codexQueue.ts): a thread runs its words as its next turn, and no terminal is typed into. */
  codexQueue: Pick<CodexQueue, 'can' | 'send'>
  /** The Codex home Harness reads (env.CODEX_HOME): `codex queue` loads its config, so a hook's path never chooses it. */
  codexHome: string
  /** The route (`codex`, `mod`, or the adapter that typed, said by its fixed id) or the refusal, the adapter that
   *  refused in its own sentence, and a failed queue's reason. Fixed words or an adapter only: a string from a hook, a
   *  pane's id, cannot reach the log line. */
  count(what: 'mod' | 'waiting' | 'busy' | 'pending' | 'too-long' | 'no-answer' | 'codex' | 'codex-timeout'
    | `codex-failed (${CodexQueueFailure})` | HostAdapter | { refused: HostAdapter }): void
}

/** What a count says in the log: a fixed word, the adapter that typed by its id, or `refused (<its id>)`. */
export function countWord(what: Parameters<ObservedActions['count']>[0]): string {
  if (typeof what === 'string') return what
  return 'refused' in what ? `refused (${what.refused.id})` : what.id
}

/** One of an agent's panes, beside the adapter whose it is. */
interface Located {
  adapter: HostAdapter
  pane: Pane
}

/** The dial's words go to the first pane whose app types now. */
const words = (adapter: HostAdapter, pane: Pane): boolean => !!adapter.type && (adapter.canType?.(pane) ?? true)
/** A rest shows the first pane its app can show now, without coming forward. */
const rest = (adapter: HostAdapter, pane: Pane): boolean => !!adapter.show && (adapter.canShow?.(pane) ?? true)
/** A tap hands the opener the first pane its app brings forward here, before or instead of the app: one after it is
 *  raised once the app came. */
const tapped = (adapter: HostAdapter, pane: Pane): boolean => adapter.tap !== 'after' && adapter.canFocus(pane)

interface Entry {
  agent: HostAgent
  /** When its state began (a turn's start renews it): how long a turn has run, and since when an agent waits. */
  since: number
  transcriptPath?: string
  pid: number
  /** Its latest event's host hints: none for a session the scan found, until its first. */
  hints: Readonly<Record<string, string>>
  /** The process its latest event came from: none for a session the scan found, until its first. */
  caller?: number
  /** Every pane an adapter knows it by, from its latest event and its tty, in the adapters' order. */
  panes: readonly Located[]
  /** The process its tty was read for, its latest in a tab app, and that tty once read. */
  ttyPid?: number
  tty?: string
  /** When the read of ttyPid began, once that read failed. */
  ttyFailedAt?: number
  /** The process whose parents were walked for its app, a caller whose hints named none, and the app they named: none
   *  while the walk runs, or when they named no listed app. */
  appPid?: number
  callerApp?: string
  /** A walk of appPid's parents runs: one at a time. */
  appWalking?: boolean
  /** The app a tap brings forward, from its last event: none for a session the scan found, until its first. */
  bundle?: string
  /** What the permission prompt it waits on asks, from its hook (deviceClaude/asked.ts): '' when it names nothing. */
  asked?: string
  /** The name the session gives itself, from its session-start or turn-start, or, for a session the scan found, the one
   *  the person gave it in its own process record until then. Only Claude Code's event with none clears it: its hook
   *  says the name on each of these while the session has one, while Command Code's turn-start is every tool call and
   *  says none. */
  title?: string
  generation?: string
  endAt?: number
  /** The read of the last answer, waiting out the grace. */
  answerTimer?: ReturnType<typeof setTimeout>
  /** When the dial's words reached it, oldest first, each until a turn starts for it. */
  dialPrompts: { at: number }[]
}

/** A pane's name as its app shows it, and whether the person set it. */
export interface PaneName {
  title: string
  renamed: boolean
}

export class ObservedSource implements HostSource {
  readonly id = 'observed'
  private readonly entries = new Map<string, Entry>()
  private readonly listeners = new Set<() => void>()
  /** Each adapter's names for its panes, by pane id, as its app shows them, and the pane its caller placed each agent
   *  with none of that adapter's at, by agent id. */
  private readonly paneNames = new Map<string, { names: ReadonlyMap<string, PaneName>; placed: ReadonlyMap<string, string> }>()
  private scanning: Promise<void> | null = null

  constructor(private readonly deps: ObservedDeps) {}

  list(): HostAgent[] {
    return [...this.entries.values()].map((e) => {
      // The keys a listing source knows its panes by (registry.ts): an ended session's pane holds something else now.
      const paneKeys = this.live(e) ? e.panes.flatMap(({ adapter, pane }) => (adapter.paneKey ? [adapter.paneKey(pane)] : [])) : []
      return paneKeys.length ? { ...e.agent, paneKeys } : { ...e.agent }
    })
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
      voice: live && (!!this.first(e, words) || this.modReady(e, actions) || this.queueable(e, actions)),
      focus: live && actions.canOpen(this.target(e)),
      // Its prompts are answered in its own app: the dial only shows them.
      answer: false,
    }
  }

  /** Only Claude Code runs the mod; another engine's session id is no poll. */
  private modReady(e: Entry, actions: ObservedActions): boolean {
    return e.agent.engine === 'claude' && actions.modReady(e.agent.sessionId!)
  }

  /** The first of its panes whose adapter can do it. */
  private first(e: Entry, can: (adapter: HostAdapter, pane: Pane) => boolean): Located | undefined {
    return e.panes.find(({ adapter, pane }) => can(adapter, pane))
  }

  /**
   * Whether Codex's queue takes a live session's words: a Codex session whose rollout is in Harness's own Codex home, its
   * session id the thread id. Whether codex is there is asked last: it looks for the binary.
   */
  private queueable(e: Entry, actions: ObservedActions): boolean {
    return e.agent.engine === 'codex' && !!e.transcriptPath && within(join(actions.codexHome, 'sessions'), e.transcriptPath)
      && CODEX_THREAD.test(e.agent.sessionId!) && actions.codexQueue.can()
  }

  /**
   * The dial's words for the agent, and nothing is held here. A Codex session's in Harness's own Codex home go to Codex's
   * own queue first, in every state: a queued message types nothing and answers no approval, and runs once the turn is over
   * (docs/specs/2026-11-15-device-codex.md, the spike). Claude Code's go to its mod in every state, as a Harness agent's
   * are (lib/sessionInput.ts), whose `$.prompt.submit` types nothing and starts them once the turn is over. Else, and
   * after a queue that definitely failed, they are typed into the first of its panes whose app types (a herdr pane, an
   * Orca terminal), only at its prompt.
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
    const waiting = (): SendResult => refuse('waiting', `${name} is waiting for your answer in ${hostDisplayName(e.agent.host)}.`)
    const busy = (): SendResult => refuse('busy', `${name} is busy. Say it when it is done.`)
    const typer = this.first(e, words)
    if (this.queueable(e, actions)) {
      // Recorded first: an idle Codex starts the queued turn, and its hook can be heard, before `codex queue` has exited.
      const record = this.dialPrompt(e)
      const queued = await actions.codexQueue.send(e.agent.sessionId!, text)
      if (queued.outcome === 'queued') {
        actions.count('codex')
        return { ok: true }
      }
      this.forgetDialPrompt(e, record)
      // The last words are still being queued: typed into Orca now, these would land before them.
      if (queued.outcome === 'busy') return refuse('pending', `${name} has not taken your last words yet.`)
      // A timeout: they may be queued, and typed too they would run twice. Only a definite failure goes on.
      if (queued.outcome !== 'failed') {
        actions.count('codex-timeout')
        return { ok: false, reason: `${name} did not answer.` }
      }
      actions.count(`codex-failed (${queued.reason})`)
    }
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
    // Each event names its panes afresh, so the same pane is known by its adapter and id.
    const still = this.first(e, words)
    if (!typer || !this.live(e) || still?.pane.adapter !== typer.pane.adapter || still.pane.id !== typer.pane.id) return noAnswer()
    // A prompt open in the terminal takes what is typed as its answer: Enter there would allow what the dial only shows,
    // as the core never types into a Harness pane that shows one (lib/messageHolds.ts `permission_open`).
    if (e.agent.state === 'needs-you') return waiting()
    // A working turn may show a prompt not yet heard of: Codex's approval overlay, which takes `y` or Enter, has no hook, and
    // Claude Code's comes a few hundred ms after its prompt opens.
    if (e.agent.state === 'working' || !this.idleKnown(e)) return busy()
    // Recorded first: `orca terminal send` returns once the prompt is submitted, and its turn's hook can be heard before.
    const record = this.dialPrompt(e)
    const typed = await typer.adapter.type!(typer.pane, text, e.agent.engine)
    // Only `true` was sent: a refusal is an object, and truthy.
    if (typed !== true) {
      this.forgetDialPrompt(e, record)
      if (typed === 'busy') return busy()
      if (typed === 'waiting') return waiting()
      if (typed === false) return noAnswer()
      actions.count({ refused: typer.adapter })
      return { ok: false, reason: typed.refused }
    }
    actions.count(typer.adapter)
    return { ok: true }
  }

  /** The dial's words reached the session: its next turn is theirs, not a person's. */
  private dialPrompt(e: Entry): { at: number } {
    const record = { at: this.deps.now() }
    if (e.dialPrompts.push(record) > MAX_DIAL_PROMPTS) e.dialPrompts.shift()
    return record
  }

  /** Words that did not reach it: their own record only, if no turn took it meanwhile. An earlier one is the mod's, or
   *  the queue's, for words still to come. */
  private forgetDialPrompt(e: Entry, record: { at: number }): void {
    const i = e.dialPrompts.indexOf(record)
    if (i >= 0) e.dialPrompts.splice(i, 1)
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
    if (!e || !actions || !this.live(e)) return false
    const target = this.target(e)
    if (!actions.canOpen(target)) return false
    const opened = await actions.open(e.agent.id, target)
    // `open -b` brings the app forward on whichever tab it had: a pane that comes after its app (a tab) is raised once it
    // came. Read after the open, as an agent that ended or moved meanwhile has no such pane to raise.
    const shown = opened ? this.shown(agent) : undefined
    if (shown?.adapter.tap === 'after' && shown.adapter.canFocus(shown.pane)) await shown.adapter.focus(shown.pane)
    return opened
  }

  /** Only a pane whose app can show it now (an Orca terminal, a Claude app session while that app is in front, a tab a
   *  watch can select) is shown without its app coming forward. */
  hasPane(agent: HostAgent): boolean {
    return this.shown(agent) !== undefined
  }

  showPane(agent: HostAgent): Promise<PaneSwitch> {
    const shown = this.shown(agent)
    return shown ? shown.adapter.show!(shown.pane, agent.id) : Promise.resolve('failed')
  }

  /** The pane a rest shows, from its latest event, while it lives: one it left, or an ended session's, holds something
   *  else now. Asked at each look: the front moves, and a watch comes and goes. */
  private shown(agent: HostAgent): Located | undefined {
    const e = this.entries.get(agent.id)
    return e && this.live(e) ? this.shownOnly(e).find(({ adapter, pane }) => rest(adapter, pane)) : undefined
  }

  /** What a tap opens: its app, and the first of its panes the opener brings forward. Asked at each look, as a rest's.
   *  An agent placed by its caller has had no hook to name its app: the adapter it was placed in names it. */
  private target(e: Entry): OpenTarget {
    const near = this.shownOnly(e).find(({ adapter, pane }) => tapped(adapter, pane))
    const placed = near && !e.panes.includes(near)
    const bundle = e.bundle ?? (placed ? near.adapter.bundle : undefined)
    return { ...(bundle ? { bundle } : {}), ...(near ? { pane: near.pane } : {}) }
  }

  /** What a rest and a tap may show: its panes, and in an adapter where it has none, the pane its caller placed it at. A
   *  place is a guess: showing the wrong terminal costs a look, while words typed there would run at another's prompt.
   *  So only these two read it, never words, `byPane` or `paneOf`. */
  private shownOnly(e: Entry): readonly Located[] {
    return (this.deps.actions?.adapters ?? []).flatMap((adapter) => {
      const own = e.panes.find((located) => located.adapter === adapter)
      if (own) return [own]
      const at = this.paneNames.get(adapter.id)?.placed.get(e.agent.id)
      return at === undefined ? [] : [{ adapter, pane: { adapter: adapter.id, id: at } }]
    })
  }

  /** Every pane its adapters know it by, afresh: a session resumed elsewhere keeps none it left. */
  private locate(entry: Entry): void {
    const place = { host: entry.agent.host, app: entry.agent.app, hints: entry.hints, tty: entry.tty, pid: entry.caller,
      sessionId: entry.agent.sessionId, engine: entry.agent.engine }
    entry.panes = (this.deps.actions?.adapters ?? []).flatMap((adapter) => {
      const pane = adapter.paneOf(place)
      return pane ? [{ adapter, pane }] : []
    })
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

  /** The live agent with that adapter's pane of that id: of two, the one heard from last. */
  byPane(adapter: string, id: string): HostAgent | undefined {
    let found: Entry | undefined
    for (const e of this.entries.values()) {
      if (!this.live(e) || !e.panes.some(({ pane }) => pane.adapter === adapter && pane.id === id)) continue
      if (!found || e.agent.lastActivityAt > found.agent.lastActivityAt) found = e
    }
    return found && { ...found.agent }
  }

  /** A live agent's pane id in that adapter; none when it has no pane there, or its session ended. */
  paneOf(agentId: string, adapter: string): string | undefined {
    const e = this.entries.get(agentId)
    return e && this.live(e) ? e.panes.find(({ pane }) => pane.adapter === adapter)?.pane.id : undefined
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
    this.locate(entry)
    if (!this.deps.tty || !isTabApp(entry.agent.app)) return
    entry.ttyPid = pid
    this.deps.tty(pid).then((tty) => {
      if (entry.ttyPid !== pid) return
      entry.tty = tty
      this.locate(entry)
    }, () => {
      if (entry.ttyPid === pid) entry.ttyFailedAt = now
      // A count only: never the pid or the session.
      this.deps.log('[observed] tty · not read')
    })
  }

  /**
   * The app of a caller whose hints name none, from its parents as the open scan reads them: walked once per process, as
   * its tty is read, and one walk at a time. Until the walk answers, the session keeps the app it had. The answer lands
   * only while that process is still its caller, its latest hook named no app and it is live; a caller it moved to is
   * walked next. An ended session keeps the answer for its caller, for a resume from it. A session no longer listed is
   * walked no more. One that names no listed app, or fails, leaves the unknown app.
   */
  private learnApp(entry: Entry, pid: number): string {
    if (entry.appPid === pid) return entry.appWalking ? entry.agent.app : entry.callerApp ?? UNKNOWN_APP
    if (entry.appWalking) return entry.agent.app
    entry.appPid = pid
    entry.callerApp = undefined
    entry.appWalking = true
    this.deps.apps!([pid]).then((apps) => apps.get(pid), () => {
      // A count only: no error text, as a path in it holds the account's name.
      this.deps.log('[observed] app · not read')
      return undefined
    }).then((app) => {
      entry.appWalking = false
      entry.callerApp = app
      // Its latest hook named its app: that stands. An ended one is on no app's page.
      if (detectApp(entry.hints) !== UNKNOWN_APP || !this.live(entry)) return
      // It moved to another process during the walk: that one is walked now.
      if (entry.caller !== pid) {
        this.learnApp(entry, entry.caller!)
        return
      }
      const had = entry.agent.app
      entry.agent.app = app ?? UNKNOWN_APP
      if (entry.agent.app === had) this.locate(entry)
      else {
        // Its tty was read for the app it had: one in a tab app now has its tab read, and one that left it has none.
        entry.ttyPid = undefined
        this.learnTty(entry, pid)
      }
      this.emit()
    })
    return entry.agent.app
  }

  private emit(): void {
    for (const l of [...this.listeners]) l()
  }

  /** Replaces that adapter's names for its panes whole, and the panes its caller placed agents with none of its at, and
   *  names every live agent again: the change is told once. A place names an agent, and a rest and a tap show it
   *  (shownOnly); it is never one of its panes, so no words reach it. A place that came or went is told too: what a tap
   *  can reach changed. */
  setPaneNames(adapter: string, names: ReadonlyMap<string, PaneName>, placed: ReadonlyMap<string, string>): void {
    const was = this.paneNames.get(adapter)?.placed
    this.paneNames.set(adapter, { names, placed })
    let changed = false
    for (const e of this.entries.values()) {
      if (!this.live(e)) continue
      if (was?.get(e.agent.id) !== placed.get(e.agent.id)) changed = true
      const name = this.nameOf(e)
      if (name === e.agent.name) continue
      e.agent.name = name
      changed = true
    }
    if (changed) this.emit()
  }

  /** A pane name the person set wins; else the name they gave the session; else its pane's name, else its folder's. */
  private nameOf(e: Entry): string {
    const pane = this.paneName(e)
    return pane?.renamed ? pane.title : e.title ?? pane?.title ?? folderName(e.agent.cwd, e.agent.engine)
  }

  /** The name of its pane in the first adapter that names one: its own pane there, else the one it was placed at. */
  private paneName(e: Entry): PaneName | undefined {
    for (const [adapter, { names, placed }] of this.paneNames) {
      const id = e.panes.find(({ pane }) => pane.adapter === adapter)?.pane.id ?? placed.get(e.agent.id)
      const name = id === undefined ? undefined : names.get(id)
      if (name) return name
    }
    return undefined
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
    // processes named its app. A hook whose hints name no app (the Codex app's own Codex) learns it from its caller's
    // parents.
    a.host = detectHost(e.hostHints)
    const named = detectApp(e.hostHints)
    a.app = named === UNKNOWN_APP && this.deps.apps ? this.learnApp(entry, e.callerPid) : named
    delete a.appPending
    // Every event's own: a session resumed elsewhere must not be typed into the terminal it left.
    entry.hints = e.hostHints
    entry.caller = e.callerPid
    this.locate(entry)
    entry.bundle = bundleOf(a.host, e.hostHints)
    if (e.cwd) a.cwd = e.cwd
    if (e.event === 'session-start' || e.event === 'turn-start') {
      if (e.title !== undefined) entry.title = e.title
      else if (e.engine === 'claude') entry.title = undefined
    }
    a.name = this.nameOf(entry)
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
        name: folderName(init.cwd, engine),
        host: 'terminal',
        app: UNKNOWN_APP,
        appPending: true,
        state: 'idle', lastActivityAt: now, unseenDone: false, callerPid: init.pid,
      },
      since: now,
      pid: init.pid,
      hints: {},
      panes: [],
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
    // Before any filter: an owner with no row, or Harness's own, still holds its session.
    this.deps.scanned?.(owners)
    const open = new Map<string, ExternalEngine>()
    for (const [sessionId, owner] of owners) {
      if (!owner.harness && !this.entries.has(observedAgentId(owner.engine, sessionId))) open.set(sessionId, owner.engine)
    }
    if (!open.size) return
    const rows = await this.deps.sessionRows.find(open)
    // Asked once, as a session is first listed, for the ones this look is about to list: a listed session is never looked
    // at again, and its next hook is the next word on where it runs and what it is called.
    const listing = [...open].filter(([sessionId, engine]) => rows.has(sessionId) && !this.entries.has(observedAgentId(engine, sessionId)))
      .slice(0, MAX_SESSIONS)
    const learning = this.deps.now()
    const apps = await this.appsOf(listing.map(([sessionId]) => owners.get(sessionId)!.pid))
    const ms = this.deps.now() - learning
    // Read before the loop: its own check then sees a session a hook told of during the reads, which keeps what it said.
    const names = await this.namesOf(listing, owners)
    let listed = 0
    let known = 0
    let named = 0
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
      const name = names.get(sessionId)
      if (name) {
        entry.title = name
        named++
      }
      // The app alone: its host and what a tap opens stay unknown until its first hook.
      const app = apps.get(owner.pid)
      if (app) {
        entry.agent.app = app
        delete entry.agent.appPending
        known++
      }
      this.learnTty(entry, owner.pid)
      // Once its panes are known.
      entry.agent.name = this.nameOf(entry)
      // A turn it is in when found reads working, as checkWorking reads it, which ends it once its owner reads idle: listed
      // idle, its compaction's SessionStart (which moves no state) would give a running turn a handle to type into.
      if ((engine === 'claude' || engine === 'codex') && await this.deps.openSessions.busy(owner)
        && entry.agent.state === 'idle' && this.live(entry)) this.setState(entry, 'working', this.deps.now())
    }
    if (!listed) return
    // Counts only: an app, a pid or a path would say whose session runs where, and a name is the person's own.
    this.deps.log(`[observed] scan · ${listed} found · ${known} app known · ${named} named · ${ms} ms`)
    this.emit()
  }

  /** The name in each Claude Code session's own record, by session id, read one at a time; none when there is no reader.
   *  A read that fails names nothing and logs nothing: its error can hold a path, and the session keeps its folder. */
  private async namesOf(
    listing: readonly [string, ExternalEngine][], owners: ReadonlyMap<string, SessionOwner>,
  ): Promise<ReadonlyMap<string, string>> {
    const names = new Map<string, string>()
    if (!this.deps.recordName) return names
    for (const [sessionId, engine] of listing) {
      if (engine !== 'claude') continue
      try {
        const { pid, record } = owners.get(sessionId)!
        const name = await this.deps.recordName({ pid, record, sessionId })
        if (name) names.set(sessionId, name)
      } catch {
        // Named by its folder, as a session with no name is.
      }
    }
    return names
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
