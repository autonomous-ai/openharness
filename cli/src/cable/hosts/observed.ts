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
import { CODEX_THREAD, type CodexQueue, type CodexQueueFailure, type CodexRan } from './codexQueue.js'
import { APP_BUNDLES, detectApp, detectHost, hostDisplayName, UNKNOWN_APP } from './hostDetect.js'
import type { Delivery } from './inbox.js'
import { bundleOf, type OpenTarget } from './open.js'
import { MAX_TEXT } from './orca.js'
import type { SessionRecord } from './record.js'
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
 *  transcript can lag its Stop hook, and an answer read at once is the last turn's or none. A turn is told done only
 *  once it passed with no word of the turn going on: a Stop another Stop hook keeps going is followed at once by a
 *  prompt or a next turn, and the dial would sound for a turn that never ended. */
const ANSWER_GRACE_MS = 1_500
/** A lead's subagents counted at most, as the core counts a pane's (SUBAGENTS_MAX, core/turns/turnHooks.ts). */
const SUBAGENTS_MAX = 64
/** A lead heard nothing of for this long lost a SubagentStop: none is counted, as the core does (SUBAGENT_TIMEOUT_MS). */
const SUBAGENT_TIMEOUT_MS = 600_000
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

/** An answer as the dial's card keeps it. By code point: a cut through an emoji's surrogate pair leaves a broken
 *  character on the card. */
function cutAnswer(text: string): string {
  const chars = Array.from(text)
  return chars.length > ANSWER_CHARS ? `${chars.slice(0, ANSWER_CHARS - 1).join('')}…` : text
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
  /** What a Claude Code session's own process record gives (record.ts): the name the person gave it, and the Claude
   *  app's id of it; one that rejects gives nothing. Absent, the scan names by folder and places by its app alone. */
  record?(owner: Pick<SessionOwner, 'pid' | 'record'> & { sessionId: string }): Promise<SessionRecord>
  /** The tty of a process in a tab app (tabs.ts readTty), rejecting when `ps` could not be read; absent (off macOS), no
   *  agent has a tab. */
  tty?(pid: number): Promise<string | undefined>
  /** Every owner a scan read, before any is listed. Absent, nothing is told. */
  scanned?(owners: ReadonlyMap<string, SessionOwner>): void
  /** The hc terminal whose foreground is that pid, when exactly one is (hcSource.ts terminalOf). Absent, nothing is
   *  paired. */
  herdrTerminal?(pid: number): string | undefined
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
   *  refused in its own sentence, and a failed queue's reason and which `codex` ran. Fixed words or an adapter only: a
   *  string from a hook, a pane's id, a binary's path, cannot reach the log line. */
  count(what: 'mod' | 'waiting' | 'busy' | 'pending' | 'too-long' | 'no-answer' | 'codex' | 'codex-timeout'
    | 'codex-failed (refused)' | `codex-failed (${Exclude<CodexQueueFailure, 'refused'>} · ${CodexRan})`
    | HostAdapter | { refused: HostAdapter }): void
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
  /** The folder of its first event that named one, a hook's or the scan's row: where its session started, whose
   *  project settings Claude Code reads, while `agent.cwd` follows each hook. */
  startedIn?: string
  pid: number
  /** Its latest event's host hints: none for a session the scan found, until its first. */
  hints: Readonly<Record<string, string>>
  /** The process its latest event came from: none for a session the scan found, until its first. */
  caller?: number
  /** The hc terminal a session the scan found runs in, until its first hook, and the app the scan gave it, which a
   *  pairing that no longer holds puts back. No hook's hints: only locate() reads it. */
  paired?: { address: string; app: string; appPending?: true }
  /** The Claude app's id of a session the scan found, from its record, until its first hook: only locate() reads it. */
  hostSession?: string
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
  /** Its Stop, waiting out the grace before it is told as done and its answer is read. */
  heldStop?: ReturnType<typeof setTimeout>
  /** How many of Claude Code's subagents run for it, the lead: its Stop while one runs does not end its turn. */
  subagents: number
  /** It sent a Stop in this run: its Finished comes from that, so its owner reading idle with none is a turn stopped. */
  sentStop?: boolean
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
      && CODEX_THREAD.test(e.agent.sessionId!) && actions.codexQueue.can(this.inCodexApp(e))
  }

  /**
   * A session of the ChatGPT app, whose own codex queues into its threads (codexQueue.ts): the test codexApp.ts `paneOf`
   * uses. One whose app is not known yet is not: it takes the other codex until its next hook names the app.
   */
  private inCodexApp(e: Entry): boolean {
    return e.agent.app === 'codex' && e.agent.engine === 'codex'
  }

  /**
   * The dial's words for the agent, and nothing is held here. A Codex session's in Harness's own Codex home go to Codex's
   * own queue first, in every state: a queued message types nothing and answers no approval, and runs once the turn is over
   * (docs/specs/2026-11-15-device-codex.md, the spike). Claude Code's go to its mod in every state, as a Harness agent's
   * are (lib/sessionInput.ts), whose `$.prompt.submit` types nothing and starts them once the turn is over. Else, and
   * after a queue that definitely failed, they are typed into the first of its panes whose app types (a herdr pane, an
   * Orca terminal), only at its prompt. A queue whose codex failed, for a session with no such pane, says what helps: a
   * session in the ChatGPT app is told `Update ChatGPT, then try again.` (an older app's codex has no queue), another
   * `Codex could not take it. Try again.`; "did not answer" names nothing a person can do
   * (docs/plans/2026-11-18-dial-chatgpt-pick-and-voice-design.md, cause 2).
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
      const queued = await actions.codexQueue.send(e.agent.sessionId!, text, this.inCodexApp(e))
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
      if (queued.reason === 'refused') actions.count('codex-failed (refused)')
      else {
        actions.count(`codex-failed (${queued.reason} · ${queued.ran})`)
        if (!typer) return refuse('no-answer', this.inCodexApp(e) ? 'Update ChatGPT, then try again.' : 'Codex could not take it. Try again.')
      }
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
      // `false`, or an answer outside the type, says nothing: a refusal is read only off an object that holds one.
      if (!typed || typeof typed !== 'object' || typeof typed.refused !== 'string') return noAnswer()
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
   *  An agent placed by its caller, or found by the scan, has had no hook to name its app: its pane's adapter names it. */
  private target(e: Entry): OpenTarget {
    const near = this.shownOnly(e).find(({ adapter, pane }) => tapped(adapter, pane))
    const bundle = e.bundle ?? near?.adapter.bundle
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

  /** Every pane its adapters know it by, afresh: a session resumed elsewhere keeps none it left. One paired with an hc
   *  terminal is where that terminal's hook would place it. A session the scan found has no caller until its first hook:
   *  its own process (the engine's record's, or the rollout's owner) places it. */
  private locate(entry: Entry): void {
    const hints = entry.paired ? { HC_TERMINAL_ID: entry.paired.address } : entry.hints
    const place = { host: entry.agent.host, app: entry.agent.app, hints, tty: entry.tty, hostSession: entry.hostSession,
      pid: entry.caller ?? entry.pid, sessionId: entry.agent.sessionId, engine: entry.agent.engine, cwd: entry.agent.cwd }
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

  /** The pane its caller last placed it at in that adapter (setPaneNames), as shownOnly reads it; never one of its panes. */
  placedAt(agentId: string, adapter: string): string | undefined {
    return this.paneNames.get(adapter)?.placed.get(agentId)
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

  /** The transcript path the agent's latest hook or the scan gave, as given; none when neither gave one. Its user
   *  settings' home for the page guard (claudeRenderer.ts judges the path). */
  transcriptOf(agentId: string): string | undefined {
    return this.entries.get(agentId)?.transcriptPath
  }

  /** The folder the agent's session started in (Entry.startedIn); none when no event named one. The project settings'
   *  folder for the page guard. */
  startedIn(agentId: string): string | undefined {
    return this.entries.get(agentId)?.startedIn
  }

  /** Takes the event; for a turn's start of a session it lists, answers what started it. */
  ingest(e: ObservedEvent): PromptSource | undefined {
    if (e.event === 'asked') {
      this.asked(e)
      return
    }
    const known = this.entries.get(observedAgentId(e.engine, e.sessionId))
    // The end of a session never listed (one of the 50 dropped when full, or ended before the devices started) lists none.
    if (e.event === 'session-end' && !known) return
    // Each hook is a process of its own, and a subagent stopped as its lead exits still sends SubagentStop: one that comes
    // after the lead's SessionEnd is no resume, and the ended session's terminal holds a shell now.
    if ((e.event === 'subagent-start' || e.event === 'subagent-stop') && known?.endAt !== undefined) return
    const now = this.deps.now()
    const entry = this.entry(e.engine, e.sessionId, now, {
      cwd: e.cwd, transcriptPath: e.transcriptPath, pid: e.callerPid,
    })
    if (!entry) return
    const a = entry.agent
    a.lastActivityAt = now
    // Its own hook places it now, and with a caller it is never paired again. The pairing's Herdr is given back first:
    // no hook said it, so until the caller's parents answer it keeps the app the scan gave it.
    if (entry.paired) a.app = entry.paired.app
    entry.paired = undefined
    entry.hostSession = undefined
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
    // Before locate: learnTty returns early for a caller it already read, so nothing places the session again at this
    // hook, and a pane by folder must see the one this hook names.
    if (e.cwd) {
      a.cwd = e.cwd
      entry.startedIn ??= e.cwd
    }
    this.locate(entry)
    entry.bundle = bundleOf(a.host, e.hostHints)
    if (e.event === 'session-start' || e.event === 'turn-start') {
      if (e.title !== undefined) entry.title = e.title
      else if (e.engine === 'claude') entry.title = undefined
    }
    a.name = this.nameOf(entry)
    if (e.transcriptPath) entry.transcriptPath = e.transcriptPath
    if (e.event === 'session-end') {
      entry.endAt = now
      // No turn goes on in an ended session: one whose Stop waits out the grace (`claude -p` ends at once), a lead's whose
      // subagents ran, or one cut short, at its prompt too, is over, told as nothing. One left waiting would read working
      // once the interrupt reached its transcript (checkWorking).
      if (entry.agent.state === 'working' || entry.agent.state === 'needs-you') this.setState(entry, 'idle', now)
      this.dropStop(entry)
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
        this.dropStop(entry)
        this.setState(entry, 'working', now)
        a.unseenDone = false
        // The last turn's answer is not this one's: cleared, the same answer at this turn's end is a change the dial hears.
        a.lastAnswer = undefined
        // A SubagentStop that was lost keeps the count no longer, as the core's pane turns (core/turns/turnHooks.ts).
        entry.subagents = 0
        source = this.promptSource(entry, e, now)
        break
      case 'needs-input':
        // In every state: the hook hears a prompt only (hook/notify.mjs, never the idle notice), and one can open in any.
        // An agent the open scan found reads idle until its next hook though its turn may run, the quota's resume asks
        // after its turn stopped, and a turn another Stop hook keeps going asks after its Stop.
        this.dropStop(entry)
        this.setState(entry, 'needs-you', now)
        break
      case 'turn-error':
        this.dropStop(entry)
        this.setState(entry, 'error', now)
        break
      case 'turn-aborted':
        // Codex's Interrupt: the person stopped the turn, and nothing is told as done, as a Claude turn stopped with Esc.
        this.dropStop(entry)
        this.setState(entry, 'idle', now)
        a.unseenDone = false
        break
      case 'turn-stop':
        entry.sentStop = true
        this.dropStop(entry)
        // A lead whose subagents run has not finished, though they stop within the grace: its wrap-up after the last one
        // is still to come, and its own Stop ends the turn, as a pane's does (engines/kit/stopHook.ts).
        if (entry.subagents) break
        entry.heldStop = setTimeout(() => { this.finish(entry) }, ANSWER_GRACE_MS)
        entry.heldStop.unref()
        break
      case 'subagent-start':
        if (entry.subagents < SUBAGENTS_MAX) entry.subagents++
        // Fixed words: never the session.
        else this.deps.log(`[observed] subagent not counted · ${SUBAGENTS_MAX} running`)
        break
      case 'subagent-stop':
        // One started before the devices did can stop now.
        if (entry.subagents) entry.subagents--
        break
    }
    this.emit()
    return source
  }

  /** Its Stop passed the grace with no word of the turn going on: done, unless its subagents still run. */
  private finish(entry: Entry): void {
    entry.heldStop = undefined
    if (entry.subagents) return
    this.setState(entry, 'done', this.deps.now())
    entry.agent.unseenDone = true
    this.emit()
    void this.readAnswer(entry)
  }

  /** Its turn goes on, or is over without a Finished: the Stop it held is not told. */
  private dropStop(entry: Entry): void {
    clearTimeout(entry.heldStop)
    entry.heldStop = undefined
  }

  /** No longer listed: a Stop it held is told of nothing. */
  private remove(entry: Entry): void {
    this.dropStop(entry)
    this.entries.delete(entry.agent.id)
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
    this.dropStop(entry)
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
    const have = this.entries.get(id)
    if (init.cwd && this.deps.excluded.some((dir) => within(dir, init.cwd!))) {
      if (have) {
        this.remove(have)
        this.emit()
      }
      return undefined
    }
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
      subagents: 0,
      ...(init.transcriptPath ? { transcriptPath: init.transcriptPath } : {}),
      ...(init.cwd ? { startedIn: init.cwd } : {}),
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
    this.remove(victim)
    return true
  }

  private async readAnswer(entry: Entry): Promise<void> {
    if ((entry.agent.engine !== 'claude' && entry.agent.engine !== 'codex') || !entry.transcriptPath) return
    let text: string | undefined
    try {
      text = await this.deps.lastAnswer(entry.agent.engine, entry.transcriptPath)
    } catch {
      // A count only, as the scan's read logs none: its error can hold the transcript's path, and so the account's name.
      this.deps.log('[observed] last answer · not read')
      return
    }
    if (!text || this.entries.get(entry.agent.id) !== entry) return
    // A newer turn began while the file was read; its answer is not this one's.
    if (entry.agent.state !== 'done') return
    entry.agent.lastAnswer = cutAnswer(text)
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
    // The sessions this look lists, each read once as it is first listed: a listed session is never looked at again, and
    // its next hook is the next word on where it runs and what it is called. No row, no folder to tell Harness's own from a
    // person's (the voice router's transcript is a program's, in the data folder) or to name it by.
    const listing = [...open].filter(([sessionId, engine]) => rows.has(sessionId) && !this.entries.has(observedAgentId(engine, sessionId)))
      .slice(0, MAX_SESSIONS)
    // Every read of the look runs before any session of it is listed, and nothing is awaited from the first entry to the
    // emit: the dial reads list() every second and its restore marks an agent restored before reading its recap, so a
    // session listed before its answer was read would never be restored. The loop's own check then sees a session a hook
    // told of during the reads, which keeps what it said.
    const learning = this.deps.now()
    const apps = await this.appsOf(listing.map(([sessionId]) => owners.get(sessionId)!.pid))
    const records = await this.recordsOf(listing, owners)
    const busy = await this.busyOf(listing, owners)
    const answers = await this.answersOf(listing, rows, busy)
    // Every read of the look, so a slow one shows in the line.
    const ms = this.deps.now() - learning
    let listed = 0
    let known = 0
    let named = 0
    let answered = 0
    let paired = 0
    const now = this.deps.now()
    for (const [sessionId, engine] of listing) {
      // A hook may have told of it while the reads ran: it said more.
      if (this.entries.has(observedAgentId(engine, sessionId))) continue
      const row = rows.get(sessionId)!
      const owner = owners.get(sessionId)!
      const entry = this.entry(engine, sessionId, now, { cwd: row.cwd, transcriptPath: row.transcriptPath, pid: owner.pid })
      if (!entry) continue
      listed++
      const record = records.get(sessionId)
      if (record?.name) {
        entry.title = record.name
        named++
      }
      // The app alone: its host and what a tap opens stay unknown until its first hook.
      const app = apps.get(owner.pid)
      if (app) {
        entry.agent.app = app
        delete entry.agent.appPending
        known++
      }
      // The Claude app's id of it: with its app, it places it until its first hook (claudeApp.ts).
      if (record?.hostSession) entry.hostSession = record.hostSession
      if (this.pair(entry)) paired++
      this.learnTty(entry, owner.pid)
      // Once its panes are known.
      entry.agent.name = this.nameOf(entry)
      // A turn it is in when found reads working, as checkWorking reads it, which ends it once its owner reads idle: listed
      // idle, its compaction's SessionStart (which moves no state) would give a running turn a handle to type into.
      if (busy.has(sessionId)) this.setState(entry, 'working', now)
      // Its last turn's answer, from before the dial: history, not news, so it stays idle with nothing unseen, and the
      // dial's restore shows it.
      const answer = answers.get(sessionId)
      if (answer) {
        entry.agent.lastAnswer = cutAnswer(answer)
        answered++
      }
    }
    if (!listed) return
    // Counts only: an app, a pid or a path would say whose session runs where, and a name or an answer is the person's own.
    this.deps.log(`[observed] scan · ${listed} found · ${known} app known · ${named} named · ${answered} answered · ${ms} ms`)
    this.logPaired(paired)
    this.emit()
  }

  /** Each session the scan found that no hook has told of yet, placed again in the hc terminal it runs in: Herdr's list
   *  can come after the scan, and a terminal's foreground moves. Called on each change of the hc source. */
  placeHerdr(): void {
    let changed = false
    let paired = 0
    for (const e of this.entries.values()) {
      if (!this.pair(e)) continue
      changed = true
      // Paired anew or moved; one taken back is not counted.
      if (e.paired) paired++
    }
    this.logPaired(paired)
    if (changed) this.emit()
  }

  /**
   * Places a session the scan found, which no hook has told of, in the hc terminal whose foreground is its process. hc's
   * own foreground pid, equal to the pid the scan lists it by and named by one terminal only, is a certain place (the
   * addendum of docs/plans/2026-11-17-dial-recap-after-restart-design.md, decision 5, and the PM's decision of
   * 2026-11-17), so it is placed as a hook from that terminal would place it: its pane, words and tap follow Herdr's own
   * rules. It writes no hook state: a hook's hints and caller are what later code and the next hook read, and the next
   * hook wins. A pairing that no longer holds gives back what the scan gave it. Whether anything changed.
   */
  private pair(entry: Entry): boolean {
    if (!this.deps.herdrTerminal || entry.caller !== undefined) return false
    const address = this.deps.herdrTerminal(entry.pid)
    if (address === entry.paired?.address) return false
    const a = entry.agent
    if (address !== undefined) {
      // A move keeps what the scan gave it, not the Herdr it was placed in.
      const { app, appPending } = entry.paired ?? a
      entry.paired = { address, app, ...(appPending ? { appPending } : {}) }
      a.host = 'herdr'
      a.app = 'herdr'
      delete a.appPending
      entry.bundle = APP_BUNDLES.herdr
    } else {
      const { app, appPending } = entry.paired!
      a.host = 'terminal'
      a.app = app
      if (appPending) a.appPending = appPending
      entry.bundle = undefined
      entry.paired = undefined
    }
    this.locate(entry)
    return true
  }

  /** A count only: a pid or a terminal's address would say whose session runs where. */
  private logPaired(paired: number): void {
    if (paired) this.deps.log(`[observed] herdr · ${paired} paired`)
  }

  /** The Claude Code and Codex sessions in a turn, by session id, read one at a time. One that cannot say counts as busy,
   *  as OpenSessions.busy counts an engine whose store cannot say. */
  private async busyOf(
    listing: readonly [string, ExternalEngine][], owners: ReadonlyMap<string, SessionOwner>,
  ): Promise<ReadonlySet<string>> {
    const busy = new Set<string>()
    for (const [sessionId, engine] of listing) {
      if (engine !== 'claude' && engine !== 'codex') continue
      if (await this.deps.openSessions.busy(owners.get(sessionId)!).catch(() => true)) busy.add(sessionId)
    }
    return busy
  }

  /** The last answer of each idle Claude Code or Codex session, by session id, with the Stop hook's reader, one at a time.
   *  Harness's own session is not read: it is never listed. A read that fails gives none and logs nothing: its error can
   *  hold a path. */
  private async answersOf(
    listing: readonly [string, ExternalEngine][],
    rows: ReadonlyMap<string, { cwd?: string; transcriptPath?: string | null }>,
    busy: ReadonlySet<string>,
  ): Promise<ReadonlyMap<string, string>> {
    const answers = new Map<string, string>()
    for (const [sessionId, engine] of listing) {
      const { cwd, transcriptPath } = rows.get(sessionId)!
      if ((engine !== 'claude' && engine !== 'codex') || busy.has(sessionId) || !transcriptPath) continue
      if (cwd && this.deps.excluded.some((dir) => within(dir, cwd))) continue
      const answer = await this.deps.lastAnswer(engine, transcriptPath).catch(() => undefined)
      if (answer) answers.set(sessionId, answer)
    }
    return answers
  }

  /** What each Claude Code session's own record gives, by session id, read one at a time; none when there is no reader.
   *  A read that fails gives nothing and logs nothing: its error can hold a path, and the session keeps its folder and
   *  its app's place. */
  private async recordsOf(
    listing: readonly [string, ExternalEngine][], owners: ReadonlyMap<string, SessionOwner>,
  ): Promise<ReadonlyMap<string, SessionRecord>> {
    const records = new Map<string, SessionRecord>()
    if (!this.deps.record) return records
    for (const [sessionId, engine] of listing) {
      if (engine !== 'claude') continue
      try {
        const { pid, record } = owners.get(sessionId)!
        const read = await this.deps.record({ pid, record, sessionId })
        if (read.name !== undefined || read.hostSession !== undefined) records.set(sessionId, read)
      } catch {
        // Named by its folder, as a session with no name is.
      }
    }
    return records
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
      if (gone) { this.remove(e); changed = true }
    }
    if (changed) this.emit()
  }

  /**
   * The turns no hook moves, every 3 s. A person who answers a prompt in their own terminal sends no hook: the transcript
   * growing past the moment the agent began waiting says the turn goes on. An older Codex sends no end-of-turn hook, and a
   * turn stopped with Esc gets no Stop: the owner's record reading idle says each is over. A Stop waiting out its grace,
   * and a lead's subagents, are the hooks' word that the turn goes on, whatever the record reads.
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
    for (const e of all) {
      if (!e.subagents || at - e.agent.lastActivityAt < SUBAGENT_TIMEOUT_MS) continue
      e.subagents = 0
      // Fixed words: never the session.
      this.deps.log('[observed] subagent count reset · no event in 10 min')
    }
    const ownerEnds = (e: Entry): boolean => e.agent.state === 'working' && e.heldStop === undefined && !e.subagents
    const turns = all.filter((e) => (e.agent.engine === 'codex' || e.agent.engine === 'claude')
      && ownerEnds(e) && at - e.since >= TURN_SETTLE_MS)
    if (!turns.length) return
    const owners = await this.deps.openSessions.owners()
    for (const e of turns) {
      // Not found says nothing (a process read that timed out finds nobody): only an owner that reads idle ends a turn.
      const owner = owners.get(e.agent.sessionId ?? '')
      if (!owner || await this.deps.openSessions.busy(owner)) continue
      if (!ownerEnds(e) || this.entries.get(e.agent.id) !== e) continue
      const now = this.deps.now()
      e.agent.lastActivityAt = now
      // Only an older Codex, which sends no Stop, is told done here.
      if (e.agent.engine === 'claude' || e.sentStop) {
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
