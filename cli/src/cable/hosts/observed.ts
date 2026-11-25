import { createHash } from 'node:crypto'
import { basename, join } from 'node:path'
// Types only: the devices process must not load core code.
import type { ObservedAsked, ObservedEvent, ObservedHookEvent } from '../../core/observedHook.js'
import { truncateUtf8 } from '../../lib/deviceRecentTrim.js'
import type { DialOtherApp } from '../../lib/dialUsageContract.js'
import type { OpenSessions, SessionOwner, SessionRows } from '../../lib/sessionSearch/external.js'
import { type fileStamp, within } from '../../lib/sessionSearch/externals/support.js'
import type { ExternalEngine, RunningProcess } from '../../lib/sessionSearch/externals/types.js'
import { errorKind } from '../../lib/log.js'
import { roundDrawable } from '../roundGlyphs.js'
import type { HostAdapter, Outer, Pane, Place } from './adapter.js'
import { CODEX_THREAD, type CodexQueue, type CodexQueueFailure, type CodexRan } from './codexQueue.js'
import { agentPlaceName, APP_BUNDLES, detectApp, detectHost, EXTENSION_TAB, inOrca, otherProduct, ownHints, UNKNOWN_APP } from './hostDetect.js'
import type { Delivery } from './inbox.js'
import { answerEngine, type AnswerEngine } from './lastAnswer.js'
import { bundleOf, type OpenTarget } from './open.js'
import { MAX_TEXT } from './orca.js'
import { FRESH_WITHIN_MS, type Nested, type NestedLookup, type NestedPlace, type OuterLookup } from './outer.js'
import type { SessionRecord } from './record.js'
import { parentChain, type ProcessName, scanLearnsApps } from './scannedApp.js'
import { isTabApp } from './tabs.js'
import type { Caps, HostAgent, HostAgentState, HostSource, Nest, PaneSwitch, SendResult } from './types.js'

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
/** How long a tap or a rest on an agent nested in a multiplexer waits for its client's place, read afresh, before it acts
 *  on what it holds: the open keeps 300 ms of the eval's full-score 1 s (PM, 2026-11-24). tmux's fresh lookup took
 *  p95 156 ms on macOS (docs/plans/2026-11-24-dial-iterm2-tab-and-restart-plan.md, Measured). */
export const OUTER_FRESH_WAIT_MS = 700

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
 *  character on the card. Orca's chats' too (orcaChatSource.ts). */
export function cutAnswer(text: string): string {
  const chars = Array.from(text)
  return chars.length > ANSWER_CHARS ? `${chars.slice(0, ANSWER_CHARS - 1).join('')}…` : text
}

/** The name of an agent with no title: its folder's, else its engine (a folder such as `/` has no name). */
function folderName(cwd: string | undefined, engine: string): string {
  return (cwd && basename(cwd)) || engine
}

export interface ObservedDeps {
  now(): number
  /** Only macOS gives a process an inherited bundle id (__CFBundleIdentifier): elsewhere the hook works it out (ownHints). */
  platform: NodeJS.Platform
  /** The machine's processes, read once for every session (externals/support.ts listProcesses); none when unreadable. */
  processes(): Promise<readonly Pick<RunningProcess, 'pid' | 'generation'>[]>
  /** Whether a pid is running: for a session whose process has no generation to read (Windows has no `ps` here), and
   *  for a session's process when a hook other than its session-start comes from another (ingest). */
  alive(pid: number): boolean
  openSessions: Pick<OpenSessions, 'owners' | 'busy'>
  sessionRows: Pick<SessionRows, 'find'>
  /** The last answer in a transcript (lastAnswer.ts), asked only for the engines answerEngine names. */
  lastAnswer(engine: AnswerEngine, path: string): Promise<string | undefined>
  /** A transcript's last change (externals/support.ts fileStamp): one that grew while its agent waited was answered. */
  fileStamp: typeof fileStamp
  /** Folders whose sessions are Harness's own (its data folder), as the external sessions are given them: never observed. */
  excluded: readonly string[]
  log(line: string): void
  /** The routes for the dial's voice and tap; absent, an agent is status only. */
  actions?: ObservedActions
  /** The machine's processes by name (scannedApp.ts readProcessNames), read once a look for its walk, its makers and its
   *  nested lookups; rejects when unreadable. Absent, the walk reads its own and no maker is read. */
  table?(): Promise<readonly ProcessName[]>
  /** The app each of these processes runs in, where its parents name one (scannedApp.ts), walked over [rows] when given
   *  (the look's table); absent, nothing is learned. */
  apps?(pids: readonly number[], rows?: readonly ProcessName[]): Promise<ReadonlyMap<number, string>>
  /** For each of these processes on a terminal a multiplexer with a lookup by process made, that host, its maker and
   *  the process's own tty (scannedApp.ts readMadeBy), over the look's table. Absent, the scan asks no nested lookup. */
  madeBy?(pids: readonly number[], rows: readonly ProcessName[]): Promise<ReadonlyMap<number, Omit<Nested, 'pid' | 'rows'>>>
  /** Where the person sees a process the scan found nested, by the process alone (outer.ts NestedLookup), as devices.ts
   *  sends each host to its multiplexer's lookup. Absent, the scan asks no nested lookup. */
  nested?: NestedLookup
  /** What a Claude Code session's own process record gives (record.ts): the name the person gave it, and the Claude
   *  app's id of it; one that rejects gives nothing. Absent, the scan names by folder and places by its app alone. */
  record?(owner: Pick<SessionOwner, 'pid' | 'record'> & { sessionId: string }): Promise<SessionRecord>
  /** The tty of a process in a tab app (tabs.ts readTty), rejecting when `ps` could not be read; absent (off macOS), no
   *  agent has a tab. */
  tty?(pid: number): Promise<string | undefined>
  /** The host that made the pseudo-terminal a process runs on (scannedApp.ts readPtyOwner, on Windows
   *  readWindowsPtyOwner), rejecting when the process table could not be read. Absent, no terminal's or multiplexer's
   *  pane is any agent's own. */
  ptyOwner?(pid: number): Promise<string | undefined>
  /** Every owner a scan read, before any is listed. Absent, nothing is told. */
  scanned?(owners: ReadonlyMap<string, SessionOwner>): void
  /** The hc terminal whose foreground is that pid, when exactly one is (hcSource.ts terminalOf). Absent, nothing is
   *  paired. */
  herdrTerminal?(pid: number): string | undefined
  /** The place of an agent nested in a multiplexer whose own pty is no tab (outer.ts firstOuter of herdrOuter.ts's,
   *  tmux.ts's and zellij.ts's lookups), by its event's hints and caller: undefined at once when it is not nested; else
   *  the app holding that multiplexer's client, the client's tty and its process, `{}` when none was found, never
   *  rejected; the multiplexer is told first, once the maker's read confirms it. Absent, nothing is learned. */
  outer?: OuterLookup
}

/** The hints of the panes that take words only on the terminal their host made (Place.ptyOwner): no other caller's
 *  terminal is read. */
const PTY_HINTS = ['WEZTERM_PANE', 'KITTY_WINDOW_ID', 'ZELLIJ_PANE_ID', 'HERDR_PANE_ID', 'ORCA_TERMINAL_HANDLE', 'REX_BLOCK']

/** The variable each multiplexer gives its panes, which a hook's hints carry while it runs in one (askOuter). Not
 *  detectHost: it says herdr for a tmux inside herdr, whose hints carry both. */
const NEST_VARIABLE: Readonly<Record<Nest, string>> = { tmux: 'TMUX_PANE', herdr: 'HERDR_PANE_ID' }

/** Whether a caller's app is learnt from its parents: its hints name none, or name VS Code by TERM_PROGRAM alone, which
 *  Cursor's terminal says too. Only a bundle id tells the two apart: Linux has none, and an editor started from another
 *  app has none once the one it inherited is dropped (hostDetect.ts ownHints). So for Orca by TERM_PROGRAM alone, which
 *  every program started from an Orca terminal keeps unless it sets its own (kitty, the ChatGPT app): Orca stands when
 *  the parents name none. Not on Windows, where they never do (scannedApp.ts scanLearnsApps): a walk would only hold
 *  the agent on Other's page until it answered. */
function walked(hints: Readonly<Record<string, string>>, platform: NodeJS.Platform): boolean {
  const named = detectApp(hints)
  return named === UNKNOWN_APP || (named === 'vscode' && !hints.__CFBundleIdentifier) || (inOrca(hints) && scanLearnsApps(platform))
}

/** Whether an outer answer's client's process is one a raise can bring forward. */
function clientPid(pid: number | undefined): boolean {
  return Number.isSafeInteger(pid) && pid! > 0
}

/** Whether two events' hints are the same, key for key. */
function sameHints(a: Readonly<Record<string, string>>, b: Readonly<Record<string, string>>): boolean {
  const keys = Object.keys(a)
  return keys.length === Object.keys(b).length && keys.every((key) => Object.hasOwn(b, key) && a[key] === b[key])
}

export interface ObservedActions {
  /** The apps an agent may run in, in the order its panes are kept: each verb uses the first pane whose adapter can do it. */
  adapters: readonly HostAdapter[]
  /** The session's mod has a poll open, or closed one moments ago. */
  modReady(sessionId: string): boolean
  toMod(sessionId: string, text: string): Promise<Delivery>
  /** Whether a tap can open the target here (open.ts can): a pane its adapter brings forward, its app by bundle on macOS
   *  and Windows, or on Linux the agent's window, found by [agentId] (windowOf), as a target names no window. */
  canOpen(agentId: string, target: OpenTarget): boolean
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

// A held pane (Pane.held) shows the terminal, editor or multiplexer the agent was started from, and whatever is in front
// there: words typed into it would run at another's prompt, and a rest would show something else.
/** The dial's words go to the first pane whose app types now. */
const words = (adapter: HostAdapter, pane: Pane): boolean => !pane.held && !!adapter.type && (adapter.canType?.(pane) ?? true)
/** A rest shows the first pane its app can show now, without coming forward. */
const rest = (adapter: HostAdapter, pane: Pane): boolean => !pane.held && !!adapter.show && (adapter.canShow?.(pane) ?? true)
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
  /** The product its latest event's hints name, for the dial's counts of the Other page: never the hint itself. None for
   *  a session the scan found, until its first. */
  otherApp?: DialOtherApp
  /** The process its latest event came from: none for a session the scan found, until its first. */
  caller?: number
  /** The hc terminal a session the scan found runs in, until its first hook, and the app and multiplexer the scan gave
   *  it, which a pairing that no longer holds puts back. No hook's hints: only locate() reads it. */
  paired?: { address: string; app: string; appPending?: true; nest?: Nest }
  /** The Claude app's id of a session the scan found, from its record, until its first hook: only locate() reads it. */
  hostSession?: string
  /** Every pane an adapter knows it by, from its latest event and its tty, in the adapters' order. */
  panes: readonly Located[]
  /** The process its tty was read for, its latest in a tab app, and that tty once read. */
  ttyPid?: number
  tty?: string
  /** When the read of ttyPid began, once that read failed. */
  ttyFailedAt?: number
  /** The caller the host that made its terminal was read for, that host once read (null: none the dial types into), and
   *  when that read began, once it failed (learnPtyOwner). */
  ptyPid?: number
  ptyOwner?: string | null
  ptyFailedAt?: number
  /** The caller and hints its outer place was last asked for (ObservedDeps.outer), while it runs nested: only that ask's
   *  answer lands. */
  outerAsk?: { pid: number; hints: Readonly<Record<string, string>> }
  /** Its client's place read afresh for a tap or a rest (askAfresh): landing, or landed at `settledAt` (deps.now()). */
  fresh?: { landing: Promise<void>; settledAt?: number }
  /** The app and tab it is seen in, from that answer, while its caller and hints are those it was asked for; for a
   *  session the scan found nested, from the scan's lookup (placeNested) until its first hook's own answer lands. */
  outer?: Outer
  /** Its outer place is the scan's (placeNested), or its multiplexer is (HostAgent.nest from the scan's maker read), and
   *  no hook has come since: the first hook keeps them while that hook's own ask runs (askOuter). */
  scanPlaced?: true
  /** What the scan asked its lookup by process (placeNested), when that lookup had an answer to give, until its first
   *  hook: a tap's or a rest's fresh ask asks it again (askAfresh), over a table read then. The look's table is not
   *  kept: it holds no client started since. */
  scanNested?: Omit<Nested, 'rows'>
  /** The multiplexer's pane the scan's lookup placed a session found nested at, until its first hook: a rest and a tap
   *  show it (placeIn), and it is never one of its panes, so no words reach it before a hook names the pane. */
  placed?: Pane
  /** Its parents below the server of the multiplexer that made its terminal, from the scan's table: its pane's shell is
   *  one (foundNested). Read only until its first hook. */
  nestParents?: readonly number[]
  /** The client's process from an answer that named no app (a client in a terminal with no page): the raise's alone,
   *  never a page, a tab or a pane, while its caller and hints are those it was asked for. */
  outerPid?: number
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
  /** A session-start was heard and no turn-start since: where cursor-agent's idle is read (idleKnown). Never the scan's. */
  startedAtPrompt?: true
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
  /** Each tap and rest here, in turn: past its wait for a fresh place (waitFresh) a rest acts only while no later tap or
   *  rest came, so it shows nothing the person left meanwhile (PM, 2026-11-24: last action wins). A tap asks the dial's
   *  own count (focus), as a later tap on another source's agent is none of these. */
  private acted = 0

  constructor(private readonly deps: ObservedDeps) {}

  list(): HostAgent[] {
    return [...this.entries.values()].map((e) => {
      // The keys a listing source knows its panes by (registry.ts). A held pane's would fold another agent's row there
      // into this one; until its maker is read, it may be this agent's own, and its key folds that source's row of it, so
      // the list shows no two rows in the first moments after a hook
      // (docs/plans/2026-11-21-dial-linux-followups-design.md, Decided).
      const paneKeys = e.panes.flatMap(({ adapter, pane }) =>
        (adapter.paneKey && (!pane.held || e.ptyOwner === undefined) ? [adapter.paneKey(pane)] : []))
      // A pane its caller placed it at is the listing source's own row of it (herdr's and cmux's, by its session or its
      // shell): its key folds that row into this one. It stays no pane of its own, so no words reach it (shownOnly).
      for (const [id, { placed }] of this.paneNames) {
        const at = placed.get(e.agent.id)
        const adapter = at === undefined ? undefined : this.deps.actions?.adapters.find((a) => a.id === id)
        if (adapter?.paneKey) paneKeys.push(adapter.paneKey({ adapter: id, id: at! }))
      }
      // An ended session gives its row to another source's live copy. It keeps its pane keys to find one whose session id
      // differs (the Claude app's store, before it names the new id): the registry folds nothing by an ended copy's keys.
      if (!this.live(e)) return { ...e.agent, ended: true, ...(paneKeys.length && { paneKeys }) }
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
      focus: live && actions.canOpen(e.agent.id, this.target(e)),
      // Its prompts are answered in its own app: the dial only shows them.
      answer: false,
    }
  }

  /** The first sentence its adapters give, in their order, for a live agent no route of theirs takes words for: the
   *  sentence is the app's, so this source names none. */
  voiceRefusal(agent: HostAgent): string | undefined {
    const e = this.entries.get(agent.id)
    const actions = this.deps.actions
    if (!e || !actions || !this.live(e) || this.capabilities(agent).voice) return undefined
    const place = this.placeOf(e)
    for (const adapter of actions.adapters) {
      const sentence = adapter.voiceRefusal?.(place)
      if (sentence) return sentence
    }
    return undefined
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
    const waiting = (): SendResult => refuse('waiting', `${name} is waiting for your answer in ${agentPlaceName(e.agent)}.`)
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
    if (!typer) return noAnswer()
    const there = (): boolean => {
      const still = this.first(e, words)
      return this.live(e) && still?.pane.adapter === typer.pane.adapter && still.pane.id === typer.pane.id
    }
    if (!there()) return noAnswer()
    // A prompt open in the terminal takes what is typed as its answer: Enter there would allow what the dial only shows,
    // as the core never types into a Harness pane that shows one (lib/messageHolds.ts `permission_open`).
    if (e.agent.state === 'needs-you') return waiting()
    // A working turn may show a prompt not yet heard of: Codex's approval overlay, which takes `y` or Enter, has no hook, and
    // Claude Code's comes a few hundred ms after its prompt opens.
    if (e.agent.state === 'working' || !this.idleKnown(e)) return busy()
    // The same checks, asked again by an adapter that waits before its words or their Enter: a turn that started, a
    // prompt that opened or a pane that moved meanwhile gets nothing more.
    const atPrompt = (): boolean => there() && e.agent.state !== 'needs-you' && e.agent.state !== 'working' && this.idleKnown(e)
    // Recorded first: `orca terminal send` returns once the prompt is submitted, and its turn's hook can be heard before.
    const record = this.dialPrompt(e)
    const typed = await typer.adapter.type!(typer.pane, text, e.agent.engine, atPrompt)
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
   * engine's turn for its state (the scan reads Cursor's for its answer alone): it reads idle only as it was listed,
   * before any hook told of a turn, so it is at its prompt only once a hook said its turn ended, done or errored.
   * cursor-agent is also at its prompt from a heard session-start until a turn starts
   * (docs/plans/2026-11-22-dial-vscode-cursor-voice-design.md, "cursor-agent's idle"): its turn under way stays busy, as
   * its approval prompt sends no hook and a typed Enter would answer it. Unverified: that cursor-agent sends
   * `sessionStart` as its screen opens rather than at its first submit; either way the turn-start after that submit
   * clears it.
   */
  private idleKnown(e: Entry): boolean {
    return e.agent.engine === 'claude' || e.agent.engine === 'codex' || e.agent.state === 'done' || e.agent.state === 'error'
      || (e.agent.engine === 'cursor' && e.startedAtPrompt === true)
  }

  /** Still listed, and its session has not ended. */
  private live(e: Entry): boolean {
    return this.entries.get(e.agent.id) === e && e.endAt === undefined
  }

  async focus(agent: HostAgent, latest: () => boolean): Promise<boolean | 'superseded'> {
    ++this.acted
    const e = this.entries.get(agent.id)
    const actions = this.deps.actions
    if (!e || !actions || !this.live(e)) return false
    const waiting = this.waitFresh(e)
    if (waiting) {
      await waiting
      if (!latest()) return 'superseded'
      if (!this.live(e)) return false
    }
    const target = this.target(e)
    if (!actions.canOpen(e.agent.id, target)) return false
    const opened = await actions.open(e.agent.id, target)
    if (opened) await this.raiseAfter(agent)
    return opened
  }

  /** `open -b` brings the app forward on whichever tab it had: a pane that comes after its app (a tab) is raised once it
   *  came, also when the tapped pane was the multiplexer's inside that tab. Read after the open, as an agent that ended
   *  or moved meanwhile has no such pane to raise. A nested agent's is raised without asking whether a rest could show
   *  it: one shown only while its app is in front would be skipped while the front report lags the open. */
  private async raiseAfter(agent: HostAgent): Promise<void> {
    const e = this.entries.get(agent.id)
    if (e?.outer && this.live(e)) {
      const tab = this.shownOnly(e).find(({ adapter, pane }) => adapter.tap === 'after' && adapter.canFocus(pane))
      if (tab) await tab.adapter.focus(tab.pane)
      return
    }
    const tab = this.shown(agent).find(({ adapter }) => adapter.tap === 'after')
    if (tab?.adapter.canFocus(tab.pane)) await tab.adapter.focus(tab.pane)
  }

  /** A tap and a rest wait for its client's place read afresh (askAfresh), at most OUTER_FRESH_WAIT_MS: past it they act
   *  on what it holds, and the late answer still lands. None when nothing is asked: a tap or rest on an agent in no
   *  multiplexer acts in the same tick, as one that had no wait. */
  private waitFresh(entry: Entry): Promise<void> | undefined {
    const landing = this.askAfresh(entry)
    if (!landing) return undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    return Promise.race([
      landing.then(() => false),
      new Promise<true>((resolve) => { timer = setTimeout(() => resolve(true), OUTER_FRESH_WAIT_MS) }),
    ]).then((late) => {
      if (late) this.deps.log('[observed] outer · late')
      else clearTimeout(timer)
    })
  }

  /**
   * Its client's place read afresh for a tap or a rest (eval I13, PM 2026-11-24): a hook asks only at a session's or a
   * turn's start, and the scan once, so a person who attached its multiplexer from another tab since, and typed nothing,
   * would be shown the old tab. One landing an agent, shared while it runs and for FRESH_WITHIN_MS after: a burst of
   * taps and rests runs one lookup. None when there is nothing to ask (readAfresh). The landing always settles: a
   * lookup never rejects, yet one that did, or threw, would hold it unsettled, and every later tap and rest on the agent
   * would fail with it and never ask again.
   */
  private askAfresh(entry: Entry): Promise<void> | undefined {
    const held = entry.fresh
    if (held && (held.settledAt === undefined || this.deps.now() - held.settledAt < FRESH_WITHIN_MS)) return held.landing
    let read: Promise<void> | undefined
    try {
      read = this.readAfresh(entry)
    } catch (error) {
      read = Promise.reject(error)
    }
    if (!read) return undefined
    const fresh: NonNullable<Entry['fresh']> = {
      landing: read.catch((error: unknown) => {
        // Its kind, no error text: a path in it holds the account's name. The tap acts on what it holds.
        this.deps.log(`[observed] outer · lookup not read · ${errorKind(error)}`)
      }).then(() => { fresh.settledAt = this.deps.now() }),
    }
    entry.fresh = fresh
    return fresh.landing
  }

  /**
   * Its client's place, read afresh and landed. A hooked agent's is asked for its latest hook's ask, and lands as that
   * hook's answer does: a hook since then that asked anew wins (landOuter). One with no app and no client's process
   * (detached, not attached again, or failed) changes nothing, so a tap never moves its row to another page. A session
   * the scan placed, no hook told of yet, is asked by process as the scan asked it, over a table read now (a client
   * started since is in no older one), and lands as the scan's answer does (landNested): only one that names an app,
   * while no hook came. A table that cannot be read changes nothing. None when it is not nested, or its lookup has no
   * answer here (Windows).
   */
  private readAfresh(entry: Entry): Promise<void> | undefined {
    const ask = entry.outerAsk
    if (ask) {
      return this.deps.outer?.(ask.hints, ask.pid, undefined, { fresh: true })?.then((place) => {
        if (place.app || clientPid(place.pid)) this.landOuter(entry, ask, place.nest, place)
      })
    }
    const found = entry.scanNested
    const nested = this.deps.nested
    if (!found || !entry.scanPlaced || !this.unhooked(entry) || !this.deps.table || !nested) return undefined
    return this.deps.table().then(async (rows) => {
      const place = await nested({ ...found, rows }, { fresh: true })
      if (place) this.landNested(entry, place)
    }, (error: unknown) => {
      // Its kind, no error text: a path in it holds the account's name.
      this.deps.log(`[observed] outer · processes not read · ${errorKind(error)}`)
    })
  }

  /** Only a pane whose app can show it now (an Orca terminal, a Claude app session while that app is in front, a tab a
   *  watch can select) is shown without its app coming forward. */
  hasPane(agent: HostAgent): boolean {
    return this.shown(agent).length > 0
  }

  /** Each pane a rest shows, in turn: a tab first, as the pane inside it is seen only once its tab is. Busy if one was
   *  busy, failed only if every one failed. */
  async showPane(agent: HostAgent): Promise<PaneSwitch | 'superseded'> {
    const mine = ++this.acted
    const e = this.entries.get(agent.id)
    const waiting = e && this.live(e) ? this.waitFresh(e) : undefined
    if (waiting) {
      await waiting
      if (this.acted !== mine) return 'superseded'
    }
    const said: PaneSwitch[] = []
    for (const { adapter, pane } of this.shown(agent)) said.push(await adapter.show!(pane, agent.id))
    return said.includes('busy') ? 'busy' : said.includes('ok') ? 'ok' : 'failed'
  }

  /** The panes a rest shows, from its latest event, while it lives: one it left, or an ended session's, holds something
   *  else now. An agent nested in a multiplexer is seen in the tab holding the multiplexer's client (a pane that comes
   *  after its app) and in its pane there: the first a rest can show of each. Any other is shown in its first such pane
   *  alone: an Orca terminal its handle names comes before the tab its tty is. Asked at each look: the front moves, and
   *  a watch comes and goes. */
  private shown(agent: HostAgent): Located[] {
    const e = this.entries.get(agent.id)
    if (!e || !this.live(e)) return []
    const panes = this.shownOnly(e).filter(({ adapter, pane }) => rest(adapter, pane))
    if (!e.outer) return panes.slice(0, 1)
    const tab = panes.find(({ adapter }) => adapter.tap === 'after')
    const inTab = panes.find(({ adapter }) => adapter.tap !== 'after')
    return [tab, inTab].filter((located) => located !== undefined)
  }

  /** What a tap opens: its app, and the first of its panes the opener brings forward. Asked at each look, as a rest's.
   *  An agent placed by its caller, or found by the scan, has had no hook to name its app: its pane's adapter names it. */
  private target(e: Entry): OpenTarget {
    const panes = this.shownOnly(e)
    // The pane of the host that made its terminal is where it is: one before it in the adapters' order only holds it
    // (tmux inside a Zellij pane). A held pane comes after its others: switched to, it shows the terminal, editor or
    // multiplexer the agent was started from, not the one it runs in.
    const near = panes.find(({ adapter, pane }) => adapter.id === e.ptyOwner && tapped(adapter, pane))
      ?? panes.find(({ adapter, pane }) => !pane.held && tapped(adapter, pane))
      ?? panes.find(({ adapter, pane }) => tapped(adapter, pane))
    const bundle = e.bundle ?? near?.adapter.bundle
    return { ...(bundle ? { bundle } : {}), ...(near ? { pane: near.pane } : {}) }
  }

  /** What a rest and a tap may show: its panes, and in an adapter where it has none of its own, the pane the scan's
   *  lookup or its caller placed it at (placeIn). A place is a guess: showing the wrong terminal costs a look, while
   *  words typed there would run at another's prompt. So only these two, its name and Orca's scope (shownAt) read it,
   *  never words, `byPane` or `paneOf`. */
  private shownOnly(e: Entry): readonly Located[] {
    return (this.deps.actions?.adapters ?? []).flatMap((adapter) => {
      const pane = this.placeIn(e, adapter.id)
      return pane ? [{ adapter, pane }] : []
    })
  }

  /** Its pane in that adapter as a rest, a tap and its name read it: its own; else the one the scan's lookup placed it
   *  at (Entry.placed); else the one its caller placed it at; else its held one. A held pane counts as none for paneOf,
   *  which the devices read to place the agent where it runs, while the held pane shows only where it was started from. */
  private placeIn(e: Entry, adapter: string): Pane | undefined {
    const own = e.panes.find(({ pane }) => pane.adapter === adapter)?.pane
    if (own && !own.held) return own
    if (e.placed?.adapter === adapter) return e.placed
    const at = this.paneNames.get(adapter)?.placed.get(e.agent.id)
    return at === undefined ? own : { adapter, id: at }
  }

  /** Every pane its adapters know it by, afresh: a session resumed elsewhere keeps none it left. One paired with an hc
   *  terminal is where that terminal's hook would place it. A session the scan found has no caller until its first hook:
   *  its own process (the engine's record's, or the rollout's owner) places it. */
  private locate(entry: Entry): void {
    const place = this.placeOf(entry)
    entry.panes = (this.deps.actions?.adapters ?? []).flatMap((adapter) => {
      const pane = adapter.paneOf(place)
      return pane ? [{ adapter, pane }] : []
    })
  }

  /** Where it runs, as its adapters read it. */
  private placeOf(entry: Entry): Place {
    const hints = entry.paired ? { HC_TERMINAL_ID: entry.paired.address } : entry.hints
    return { host: entry.agent.host, app: entry.agent.app, hints, tty: entry.tty, hostSession: entry.hostSession,
      pid: entry.caller ?? entry.pid, sessionId: entry.agent.sessionId, engine: entry.agent.engine, cwd: entry.agent.cwd,
      outer: entry.outer, ptyOwner: entry.ptyOwner }
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

  /** The live agent with that adapter's pane of that id: of two, the one heard from last. A held pane is not its own, as
   *  for paneOf. */
  byPane(adapter: string, id: string): HostAgent | undefined {
    let found: Entry | undefined
    for (const e of this.entries.values()) {
      if (!this.live(e) || !e.panes.some(({ pane }) => pane.adapter === adapter && pane.id === id && !pane.held)) continue
      if (!found || e.agent.lastActivityAt > found.agent.lastActivityAt) found = e
    }
    return found && { ...found.agent }
  }

  /** A live agent's pane id in that adapter; none when it has no pane there, or its session ended. A held pane is not
   *  its own: the devices' paths that read this (Orca's ring order, the scroll) take it for none. */
  paneOf(agentId: string, adapter: string): string | undefined {
    const e = this.entries.get(agentId)
    return e && this.live(e) ? e.panes.find(({ pane }) => pane.adapter === adapter && !pane.held)?.pane.id : undefined
  }

  /** Whether a live agent holds a pane its adapter keys [key] (Pane.held) and the asker's row folds into it: that
   *  agent's maker is not read yet, so the pane may be its own, or the asker carries its session, the same agent another
   *  source lists. A source that types into panes asks it first, so what folds with a held pane takes no words there by
   *  that source's route either. */
  holds(key: string, asker: { engine: string; sessionId?: string }): boolean {
    for (const e of this.entries.values()) {
      if (!this.live(e) || !e.panes.some(({ adapter, pane }) => pane.held && adapter.paneKey?.(pane) === key)) continue
      if (e.ptyOwner === undefined) return true
      if (asker.sessionId !== undefined && asker.engine === e.agent.engine && asker.sessionId === e.agent.sessionId) return true
    }
    return false
  }

  /** Each live agent the scan found on a terminal [host]'s server made, no hook told of yet, with its parents below that
   *  server: the devices find the herdr pane of one whose herdr row names no session by that pane's shell
   *  (services/devices.ts placeInHerdr). */
  foundNested(host: string): { agentId: string; parents: readonly number[] }[] {
    return [...this.entries.values()].flatMap((e) =>
      (e.nestParents && e.agent.nest === host && this.unhooked(e) ? [{ agentId: e.agent.id, parents: e.nestParents }] : []))
  }

  /** A live agent's latest process, the one whose window a raise brings forward, and its app; none once its session
   *  ended, as its window holds something else now. Nested in a multiplexer, the process is the client its app holds:
   *  the agent's own is under the multiplexer's server, which owns no window. A client in a terminal with no page is
   *  that client too (Entry.outerPid). `outer` says the pid is that client's: only such a pid is raised on Windows
   *  (open.ts), as the agent's own process there is under herdr's server. */
  windowOf(agentId: string): { pid: number; app: string; outer?: true } | undefined {
    const e = this.entries.get(agentId)
    if (!e || !this.live(e)) return undefined
    const client = e.outer?.pid ?? e.outerPid
    return client !== undefined ? { pid: client, app: e.agent.app, outer: true } : { pid: e.caller ?? e.pid, app: e.agent.app }
  }

  /** A live agent's tab, the tty byTab reads: its own in a tab app, its multiplexer client's when nested (a hook's
   *  outer answer, or the scan's place); none when it has none, or its session ended. */
  tabTty(agentId: string): string | undefined {
    const e = this.entries.get(agentId)
    return e && this.live(e) ? e.tty : undefined
  }

  /** A live agent's pane id in that adapter as a rest, a tap and its name read it (placeIn), a held one too, which
   *  only a tap shows; none once its session ended. Orca's ring for the worktree on screen reads this, not paneOf: a
   *  held terminal is still in the worktree the agent was started from, while words and the focus watch keep to its
   *  own panes. */
  shownAt(agentId: string, adapter: string): string | undefined {
    const e = this.entries.get(agentId)
    return e && this.live(e) ? this.placeIn(e, adapter)?.id : undefined
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
    }, (error) => {
      if (entry.ttyPid === pid) entry.ttyFailedAt = now
      // Its kind only: never the pid or the session.
      this.deps.log(`[observed] tty · not read · ${errorKind(error)}`)
    })
  }

  /**
   * The app of a caller whose hints leave it to its parents (walked), from its parents as the open scan reads them:
   * walked once per process, as its tty is read, and one walk at a time. Until the walk answers, the session keeps the app
   * it had. The answer lands only while that process is still its caller, its latest hook still leaves the app to it, no
   * outer place holds it and it is live, and a nested one's tty is not read for it; a caller it moved to is walked next.
   * An ended session keeps the answer for its caller, for a resume from it. A session no longer listed is walked no more.
   * One that names no listed app, or fails, leaves the app the hints [named]: the unknown one when they name none.
   */
  private learnApp(entry: Entry, pid: number, named: string): string {
    if (entry.appPid === pid) return entry.appWalking ? entry.agent.app : entry.callerApp ?? named
    if (entry.appWalking) return entry.agent.app
    entry.appPid = pid
    entry.callerApp = undefined
    entry.appWalking = true
    this.deps.apps!([pid]).then((apps) => apps.get(pid), (error) => {
      // Its kind only: no error text, as a path in it holds the account's name.
      this.deps.log(`[observed] app · not read · ${errorKind(error)}`)
      return undefined
    }).then((app) => {
      entry.appWalking = false
      entry.callerApp = app
      // Its latest hook named its app, or it is seen in the app holding its multiplexer's client (askOuter), which a walk
      // that ends at the multiplexer's server cannot name: that stands. An ended one is on no app's page.
      if (!walked(entry.hints, this.deps.platform) || entry.outer || !this.live(entry)) return
      // It moved to another process during the walk: that one is walked now.
      if (entry.caller !== pid) {
        this.learnApp(entry, entry.caller!, detectApp(entry.hints))
        return
      }
      const had = entry.agent.app
      // Placed again for its app's bundle too: the editor its parents named is the one a tap opens.
      this.placeApp(entry, entry.hints, pid)
      // Nested, its caller's tty is the multiplexer's pane's, which no tab holds: never read (askOuter).
      if (entry.agent.app === had || entry.outerAsk) this.locate(entry)
      else {
        // Its tty was read for the app it had: one in a tab app now has its tab read, and one that left it has none.
        entry.ttyPid = undefined
        this.learnTty(entry, pid)
      }
      this.emit()
    })
    return entry.agent.app
  }

  /**
   * The host that made its caller's terminal (Place.ptyOwner), read once per process in the background, as its tty is,
   * and only for a caller whose hints name a pane that asks it (PTY_HINTS): until it lands, a terminal's or a
   * multiplexer's pane only holds the agent, and takes no words. An answer lands only while that process is still its
   * caller, null when it named no host: placed again, its adapters know the read landed, and may say so. A host named is
   * told; none is told only when a held pane's key goes, as the list showed it while the read ran (list), and every pane
   * stays held as it was. A read that failed said nothing of the host: a later event reads it again, no sooner than
   * TTY_RETRY_MS.
   */
  private learnPtyOwner(entry: Entry, pid: number): void {
    if (!this.deps.ptyOwner || !PTY_HINTS.some((key) => entry.hints[key] !== undefined)) return
    const now = this.deps.now()
    if (entry.ptyPid === pid && (entry.ptyFailedAt === undefined || now - entry.ptyFailedAt < TTY_RETRY_MS)) return
    entry.ptyPid = pid
    entry.ptyOwner = undefined
    entry.ptyFailedAt = undefined
    this.deps.ptyOwner(pid).then((owner) => {
      if (entry.ptyPid !== pid) return
      entry.ptyOwner = owner ?? null
      if (!this.live(entry)) return
      this.locate(entry)
      if (owner !== undefined || entry.panes.some(({ adapter, pane }) => pane.held && adapter.paneKey)) this.emit()
    }, (error) => {
      if (entry.ptyPid === pid) entry.ptyFailedAt = now
      // Its kind only: never the pid or the session.
      this.deps.log(`[observed] pty · not read · ${errorKind(error)}`)
    })
  }

  /**
   * Where an agent nested in a multiplexer whose own pty is no tab is seen (ObservedDeps.outer): an agent in Diego's tmux
   * sat on a "tmux" page while the dial followed Terminal, whose page was empty (2026-11-19), and one in the herdr his
   * Terminal tab ran sat on a "herdr" page the same way (2026-11-19). Asked at its session's start and
   * at each turn's, as the person may have attached from another app since, and at an event whose caller or hints the
   * last ask was not for. Another caller or pane drops the client's place (its tab and process) at once, so no tap or
   * rest uses the old tab; a new ask keeps it until its answer, so the agent does not leave its page meanwhile. The
   * scan's place, or the multiplexer its maker read gave with no place, counts as such an ask at the first hook, when
   * that hook is nested too and comes from the process the scan found:
   * Diego's idle agent placed on iTerm2's page by the scan (2026-11-22) must not drop to tmux's page while its first
   * hook's own lookup runs, while a resume in another pane holds another client; nor one the scan put on tmux's page
   * drop to the page of the app its pane's bundle id names. Only the latest ask's answer lands, while the session
   * lives. Its multiplexer (HostAgent.nest) stays where the place stays, and the answer gives the answer's, its host with
   * it: an agent is on tmux's or herdr's page only while that lookup confirms its own terminal is the pane (Diego,
   * 2026-11-23). Where the place goes at once, its multiplexer goes with it, unless a lookup was asked and the hook's
   * hints carry that multiplexer's own variable (NEST_VARIABLE): the last confirmation then stands until the new ask
   * answers, as for the same caller, since a resume's new caller in the same herdr left herdr's ring for its lookup's
   * length and came back at its end, and two at once emptied herdr's page, the dial falling back to the app in front
   * (eval I14, 2026-11-25).
   * Whether it is nested: its caller's tty is then the multiplexer's pane's, which no tab holds, so it is never read and
   * an old one goes.
   */
  private askOuter(entry: Entry, e: ObservedHookEvent): boolean {
    const last = entry.outerAsk
    const same = last !== undefined && last.pid === e.callerPid && sameHints(last.hints, e.hostHints)
    const scanned = entry.scanPlaced
    entry.scanPlaced = undefined
    entry.scanNested = undefined
    if (same && e.event !== 'session-start' && e.event !== 'turn-start') return true
    const ask = { pid: e.callerPid, hints: e.hostHints }
    // Its multiplexer lands as soon as the maker's read confirms it, before the client's steps end (OuterLookup's made).
    const answer = this.deps.outer?.(e.hostHints, e.callerPid, (nest) => this.landOuter(entry, ask, nest))
    if (!same && !(scanned && answer && e.callerPid === entry.pid)) {
      entry.outer = undefined
      entry.outerPid = undefined
      // A caller whose hints still say the multiplexer it was confirmed in keeps it until its own ask answers (eval I14).
      const nest = entry.agent.nest
      if (!answer || !nest || !e.hostHints[NEST_VARIABLE[nest]]) delete entry.agent.nest
    }
    if (!answer) {
      entry.outerAsk = undefined
      return false
    }
    entry.outerAsk = ask
    entry.ttyPid = undefined
    entry.ttyFailedAt = undefined
    entry.tty = entry.outer?.tty
    void answer.then((place) => this.landOuter(entry, ask, place.nest, place))
    return true
  }

  /** What [ask] learnt lands while it is the latest ask and the session lives: its multiplexer [nest] (none: its hints'
   *  host), and the client's [place] once its steps end. A multiplexer told with nothing new changes nothing. */
  private landOuter(
    entry: Entry, ask: NonNullable<Entry['outerAsk']>, nest: Nest | undefined, place?: Awaited<NonNullable<ReturnType<OuterLookup>>>,
  ): void {
    if (entry.outerAsk !== ask || !this.live(entry)) return
    if (place) {
      entry.outer = place.app ? { app: place.app, tty: place.tty, pid: place.pid } : undefined
      entry.outerPid = !place.app && clientPid(place.pid) ? place.pid : undefined
      entry.tty = entry.outer?.tty
    } else if (entry.agent.nest === nest && !entry.agent.appPending) return
    if (nest) entry.agent.nest = nest
    else delete entry.agent.nest
    entry.agent.host = nest ?? detectHost(ask.hints)
    this.placeApp(entry, ask.hints, ask.pid)
    // Its first hook's ask held it pending (ingest): placed now.
    delete entry.agent.appPending
    this.locate(entry)
    this.emit()
  }

  /** Its app, and the one a tap brings forward: the app it is seen in when nested, else the one its hints name; hints
   *  that name none, or only a word Cursor says too (walked), learn it from the caller's parents. */
  private placeApp(entry: Entry, hints: Readonly<Record<string, string>>, pid: number): void {
    // On Windows a herdr pane's hints are those of the client that started herdr's server, as the pane inherits its
    // environment and the hook names its app from the pane's parents, herdr's server (spec
    // 2026-11-25-dial-herdr-windows-app-design.md, "What Windows does today"): once herdr's lookup confirmed the pane,
    // only its answer names the app, and a client in no listed app is the unknown one, never the hint's (decision 4, PM
    // 2026-11-26). No walk either: the caller's parents end at herdr's server.
    if (this.deps.platform === 'win32' && entry.agent.nest === 'herdr') {
      entry.agent.app = entry.outer?.app ?? UNKNOWN_APP
      entry.bundle = entry.outer ? APP_BUNDLES[entry.outer.app] : undefined
      return
    }
    const named = detectApp(hints)
    const walk = walked(hints, this.deps.platform)
    entry.agent.app = entry.outer?.app ?? (walk && this.deps.apps ? this.learnApp(entry, pid, named) : named)
    // An app named by a word another app says too (walked: VS Code's TERM_PROGRAM, which Cursor says) has the bundle of
    // the app its parents named, else a tap on Cursor started from Terminal (`cursor .`) opened VS Code. So has the
    // extension's tab, whose word names no app: a walk that names none leaves it none, never a guessed editor's.
    const byApp = walk && (named !== UNKNOWN_APP || hints.CLAUDE_CODE_ENTRYPOINT === EXTENSION_TAB)
    entry.bundle = entry.outer ? APP_BUNDLES[entry.outer.app] : bundleOf(byApp ? entry.agent.app : entry.agent.host, hints)
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

  /** The name of its pane in the first adapter that names one, the pane a rest and a tap show there (placeIn). */
  private paneName(e: Entry): PaneName | undefined {
    for (const [adapter, { names }] of this.paneNames) {
      const id = this.placeIn(e, adapter)?.id
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

  /** Whether every pane it has only holds it (Pane.held): the dial's counts tell a voice refused there as held by
   *  design, not failed. False for an agent with no pane, which no pane holds, and for one it does not know. */
  heldOnly(agentId: string): boolean {
    const panes = this.entries.get(agentId)?.panes ?? []
    return panes.length > 0 && panes.every(({ pane }) => pane.held)
  }

  /** The product behind the Other page it is on, from its latest hook's hints (otherProduct); none on a host's page. Read
   *  at each call, as a walk of its parents or its outer place can move it off that page after the hook. */
  otherApp(agentId: string): DialOtherApp | undefined {
    const e = this.entries.get(agentId)
    return e?.agent.app === UNKNOWN_APP ? e.otherApp : undefined
  }

  /** The session each agent a hook told of runs, by the Orca session id its hints named (ORCA_AGENT_SESSION_ID): how
   *  Orca's list of its chats (orcaChatSource.ts) gives a chat the hooked copy's id, so the two are one card. An ended
   *  copy's too: Orca still holds the chat under that session, and its resting row keeps the card's id. An agent in an
   *  Orca terminal may name one as well; Orca lists it as a terminal, which the chat source skips. */
  orcaSessions(): Map<string, { engine: string; sessionId: string }> {
    const sessions = new Map<string, { engine: string; sessionId: string }>()
    for (const { agent, hints } of this.entries.values()) {
      const orcaId = hints.ORCA_AGENT_SESSION_ID
      if (orcaId && agent.sessionId) sessions.set(orcaId, { engine: agent.engine, sessionId: agent.sessionId })
    }
    return sessions
  }

  /** Takes the event; for a turn's start of a session it lists, answers what started it. */
  ingest(e: ObservedEvent): PromptSource | undefined {
    if (e.event === 'asked') {
      this.asked(e)
      return
    }
    // Once, here: every reader after it, the place and the tap, sees the editor's own hints (eval V11). macOS alone: on
    // Windows the hook works the bundle id out from the process's parents (notify.mjs lookUpWindowsApp), never inherited.
    if (this.deps.platform === 'darwin') e = { ...e, hostHints: ownHints(e.hostHints) }
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
    // no hook said it, so until the caller's parents answer it keeps the app the scan gave it, and until its lookup
    // answers the multiplexer (askOuter).
    if (entry.paired) {
      a.app = entry.paired.app
      if (entry.paired.nest) a.nest = entry.paired.nest
    }
    entry.paired = undefined
    entry.hostSession = undefined
    // From its first hook, its panes are the hook's: the scan's pane goes, as the hook names the pane it runs in.
    entry.placed = undefined
    // A hook says where a session runs: one the open scan found is not known yet until its first, unless its parent
    // processes named its app. A hook whose hints name no app (the Codex app's own Codex) learns it from its caller's
    // parents. Its host is the multiplexer askOuter keeps, else the nearest its hints name.
    const nested = this.askOuter(entry, e)
    a.host = a.nest ?? detectHost(e.hostHints)
    this.placeApp(entry, e.hostHints, e.callerPid)
    // One nested with no multiplexer known stays pending until its lookup answers: its hints' bundle id is the one its
    // multiplexer's server started with (iTerm2's for a tmux started there), and that app in front must not turn the dial
    // to it, then back once the answer puts it on tmux's page. One the scan's maker read put on its multiplexer's page,
    // kept there (askOuter), is placed: its first turn's prompt follow turns the dial to that page.
    if (!nested || a.nest) delete a.appPending
    // Every event's own: a session resumed elsewhere must not be typed into the terminal it left.
    entry.hints = e.hostHints
    entry.otherApp = otherProduct(e.hostHints)
    entry.caller = e.callerPid
    this.learnPtyOwner(entry, e.callerPid)
    // Before locate: learnTty returns early for a caller it already read, so nothing places the session again at this
    // hook, and a pane by folder must see the one this hook names.
    if (e.cwd) {
      a.cwd = e.cwd
      entry.startedIn ??= e.cwd
    }
    this.locate(entry)
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
    // And it runs in the process that took it up: an app that restarts brings its sessions back in new processes, and
    // the old one's pid would have the next tick remove them (Orca quit and relaunched, its agents dropped off the dial
    // until the next 30 s scan, dial eval O12, 2026-11-23). A new process says so by its session-start, or is the one
    // left once the old one is gone. Another hook may come from a process passing by: a late one of the process it
    // left, or on Windows the PowerShell or cmd a failed climb names, which exits with its hook (hook/notify.mjs
    // hookCallerPid); moved there, a live session would go at the next tick. That tick notes the new generation.
    if (e.callerPid !== entry.pid && (e.event === 'session-start' || !this.deps.alive(entry.pid))) {
      entry.pid = e.callerPid
      entry.generation = undefined
    }
    if (!nested) this.learnTty(entry, e.callerPid)
    let source: PromptSource | undefined
    switch (e.event) {
      case 'session-start':
        // Where cursor-agent's idle is read until a turn starts (idleKnown); a turn already under way stays busy by its
        // state.
        entry.startedAtPrompt = true
        // A start must not undo a state a faster event already set.
        break
      case 'turn-start':
        entry.startedAtPrompt = undefined
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
    const { engine } = entry.agent
    if (!answerEngine(engine) || !entry.transcriptPath) return
    let text: string | undefined
    try {
      text = await this.deps.lastAnswer(engine, entry.transcriptPath)
    } catch (error) {
      // Its kind only, never its text: that can hold the transcript's path, and so the account's name.
      this.deps.log(`[observed] last answer · not read · ${errorKind(error)}`)
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
    const pids = listing.map(([sessionId]) => owners.get(sessionId)!.pid)
    const table = await this.tableOf(pids)
    const apps = table === null ? new Map<number, string>() : await this.appsOf(pids, table)
    const nests = table ? await this.nestsOf(pids, table) : new Map<number, Nested>()
    const records = await this.recordsOf(listing, owners)
    const busy = await this.busyOf(listing, owners)
    const answers = await this.answersOf(listing, rows, busy, owners)
    let listed = 0
    let known = 0
    let named = 0
    let answered = 0
    let paired = 0
    // The sessions on a terminal a multiplexer made, asked where the person sees them once every session is listed.
    const asks: [Entry, Nested][] = []
    // The look's table by pid, built at its first nested session.
    let byPid: ReadonlyMap<number, ProcessName> | undefined
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
      const nest = nests.get(owner.pid)
      // Its tty is the multiplexer pane's pty, which on macOS has a tab's form: never read, as askOuter never reads a
      // nested caller's. Paired, it is in an hc terminal, whose pane is its own.
      if (nest && !entry.paired) {
        // The maker's read confirmed its own terminal is that multiplexer's pane: on its page from here, whatever the
        // lookup answers, as its first hook's lookup would put it (Diego, 2026-11-23), and kept there by a nested first
        // hook from this process while that hook's own lookup runs (askOuter). Zellij keeps its app's.
        if (nest.host === 'tmux' || nest.host === 'herdr') {
          entry.agent.nest = nest.host
          entry.agent.host = nest.host
          entry.scanPlaced = true
        }
        byPid ??= new Map(nest.rows.map((p) => [p.pid, p]))
        const parents = parentChain(owner.pid, byPid).slice(1).map(({ pid }) => pid)
        const server = parents.indexOf(nest.maker)
        entry.nestParents = server < 0 ? parents : parents.slice(0, server)
        this.locate(entry)
        asks.push([entry, nest])
      } else this.learnTty(entry, owner.pid)
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
    // Listed before any lookup is asked: each may take its own timeout, and the dial's restore reads list().
    this.emit()
    // One at a time: a busy machine is not handed fifty lookups at once.
    let placed = 0
    for (const [entry, nest] of asks) if (await this.placeNested(entry, nest)) placed++
    // Every read of the look and every nested lookup, so a slow one shows in the line, in its one count: the line's
    // readers match its form.
    const ms = this.deps.now() - learning
    // Counts only: an app, a pid or a path would say whose session runs where, and a name or an answer is the person's own.
    this.deps.log(`[observed] scan · ${listed} found · ${known} app known · ${named} named · ${answered} answered · ${ms} ms`
      + ` · ${placed} nested placed`)
    this.logPaired(paired)
  }

  /**
   * Where the person sees a session the scan found on a terminal a multiplexer made, before its first hook
   * (ObservedDeps.nested): Diego's idle nested agents in iTerm2 sat on Other's page after the devices started again,
   * each until it was next hooked (2026-11-22). Asked, and its answer landing, only while it lives, no hook told of it
   * and no hc terminal holds it: a hook's word is newer. An answer that names an app places it there, known, with its
   * client's tab and process (landNested); one that names none, or fails, leaves what the walk gave it: a failed one
   * must not stop the look's next. Whether it was placed.
   */
  private async placeNested(entry: Entry, nest: Nested): Promise<boolean> {
    if (!this.unhooked(entry)) return false
    let place: NestedPlace | undefined
    try {
      const asked = this.deps.nested?.(nest)
      // Placed or not, a tap or a rest asks it again (askAfresh, eval I13). A lookup with no answer for it here (a tty out
      // of its platform's form) has none then either, as it is asked the same facts: no table is read for it at a tap.
      if (asked) entry.scanNested = { host: nest.host, pid: nest.pid, tty: nest.tty, maker: nest.maker }
      place = await asked
    } catch (error) {
      // Its kind, no error text: a path in it holds the account's name.
      this.deps.log(`[observed] scan · lookup not read · ${errorKind(error)}`)
      return false
    }
    return place !== undefined && this.landNested(entry, place)
  }

  /** A nested lookup's answer for a session the scan found (placeNested, readAfresh), landed while it lives, no hook told
   *  of it and no hc terminal holds it: one that names an app places it there, known, with its client's tab and process,
   *  as a hook's outer answer does, and at the multiplexer's pane it names, for a rest and a tap alone (Entry.placed).
   *  Whether it was placed. */
  private landNested(entry: Entry, place: NestedPlace): boolean {
    if (!place.app || !this.unhooked(entry)) return false
    entry.outer = { app: place.app, tty: place.tty, pid: place.pid }
    entry.scanPlaced = true
    entry.placed = place.pane
    entry.tty = place.tty
    entry.agent.app = place.app
    delete entry.agent.appPending
    entry.bundle = APP_BUNDLES[place.app]
    this.locate(entry)
    this.emit()
    return true
  }

  /** It lives, and neither a hook nor an hc terminal has said where it runs: the scan's word is the newest. */
  private unhooked(entry: Entry): boolean {
    return this.live(entry) && entry.caller === undefined && !entry.paired
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
      const { app, appPending, nest } = entry.paired ?? a
      entry.paired = { address, app, ...(appPending ? { appPending } : {}), ...(nest ? { nest } : {}) }
      a.host = 'herdr'
      a.app = 'herdr'
      delete a.appPending
      // On Herdr's page: a multiplexer would hold it on its own (pageOf).
      delete a.nest
      entry.bundle = APP_BUNDLES.herdr
    } else {
      const { app, appPending, nest } = entry.paired!
      a.host = nest ?? 'terminal'
      a.app = app
      if (appPending) a.appPending = appPending
      if (nest) a.nest = nest
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

  /** The last answer of each idle Claude Code, Codex or Cursor session, by session id, with the Stop hook's reader, one at
   *  a time. Harness's own session is not read: it is never listed. A read that fails gives none and logs nothing: its
   *  error can hold a path. */
  private async answersOf(
    listing: readonly [string, ExternalEngine][],
    rows: ReadonlyMap<string, { cwd?: string; transcriptPath?: string | null }>,
    busy: ReadonlySet<string>,
    owners: ReadonlyMap<string, SessionOwner>,
  ): Promise<ReadonlyMap<string, string>> {
    const answers = new Map<string, string>()
    for (const [sessionId, engine] of listing) {
      const { cwd, transcriptPath } = rows.get(sessionId)!
      if (!answerEngine(engine) || busy.has(sessionId) || !transcriptPath) continue
      if (cwd && this.deps.excluded.some((dir) => within(dir, cwd))) continue
      // Cursor's turn is read for its answer alone: one under way holds that turn's words so far, no answer, and its state
      // stays as listed (idleKnown). One that cannot be told counts as under way, as busyOf counts it.
      if (engine === 'cursor' && await this.deps.openSessions.busy(owners.get(sessionId)!).catch(() => true)) continue
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

  /** The look's process table, read once for its walk, its makers and its nested lookups, as one read per session would
   *  cost a busy machine a `ps` each: none with no reader, null when it could not be read, and then every session is
   *  still listed, not known yet. */
  private async tableOf(pids: readonly number[]): Promise<readonly ProcessName[] | null | undefined> {
    if (!this.deps.table || !pids.length) return undefined
    try {
      return await this.deps.table()
    } catch (error) {
      // Its kind, no error text: a path in it holds the account's name. The table feeds the walk, the makers and the
      // lookups alike.
      this.deps.log(`[observed] scan · processes not read · ${errorKind(error)}`)
      return null
    }
  }

  /** None when there is no reader or it failed: every session is still listed, not known yet. Walked over the look's
   *  table when there is one. */
  private async appsOf(pids: readonly number[], rows: readonly ProcessName[] | undefined): Promise<ReadonlyMap<number, string>> {
    if (!this.deps.apps || !pids.length) return new Map()
    try {
      return await (rows ? this.deps.apps(pids, rows) : this.deps.apps(pids))
    } catch (error) {
      // Its kind, no error text: a path in it holds the account's name.
      this.deps.log(`[observed] scan · apps not read · ${errorKind(error)}`)
      return new Map()
    }
  }

  /** What each nested lookup is asked, by pid: none with no maker reader or no lookup to ask, or when the read failed,
   *  and then each session has its tty read as before. */
  private async nestsOf(pids: readonly number[], rows: readonly ProcessName[]): Promise<ReadonlyMap<number, Nested>> {
    if (!this.deps.madeBy || !this.deps.nested) return new Map()
    const made = await this.deps.madeBy(pids, rows).catch((error: unknown) => {
      // Its kind, no error text: a path in it holds the account's name.
      this.deps.log(`[observed] scan · makers not read · ${errorKind(error)}`)
      return new Map<number, Omit<Nested, 'pid' | 'rows'>>()
    })
    return new Map([...made].map(([pid, maker]) => [pid, { ...maker, pid, rows }]))
  }

  /** Removals: ended sessions, dead or reused pids, and sessions with no generation silent for 12 h. Called every 30 s by the owner. */
  async tick(): Promise<void> {
    if (!this.entries.size) return
    // Only the sessions known as the read begins, each in the process it ran in then: one first heard of, or brought
    // back in a new process (ingest), while `ps` runs may have a process it did not see.
    const judged = [...this.entries].map(([id, e]) => [id, e, e.pid] as const)
    // One read of the machine's processes for every session: a `ps` each blocked the loop for seconds with 50 of them.
    // A table that cannot be read is empty: it always holds the process reading it.
    const table = new Map((await this.deps.processes()).map((p) => [p.pid, p.generation]))
    const now = this.deps.now()
    let changed = false
    for (const [id, e, pid] of judged) {
      if (this.entries.get(id) !== e || e.pid !== pid) continue
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
