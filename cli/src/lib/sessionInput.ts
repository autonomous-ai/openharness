import type { ScreenReader } from './screenReader.js'
import type { SubmissionReader } from './submissionReader.js'
import { createHash } from 'crypto'
import { composerHolds, composerShown, normalizedTerminalText, visibleTerminal } from '../engines/kit/submission.js'
import { openclawBoxExactly, openclawBoxHolds, openclawClearKeys, readOpenclawScreen, type OpenclawBoxHidden, type OpenclawScreen } from '../engines/openclaw/contract.js'
import { launchBound } from '../core/engines/sessionBinding.js'
import { adaptSlashCommand } from './goalCommand.js'
import type { RegisteredSession } from './registry.js'
import { errorKind, sid } from './log.js'
import { isMessageHold, messageHoldText, messageWithheldText, passingHold, type MessageHold } from './messageHolds.js'
import type { MoveGate } from './hostMove/gate.js'
import { enterWithheldReason, TERMINAL_LEASE_REFUSED, type TerminalActionResult } from './terminalTypes.js'

const MAX_QUEUE_ITEMS = 8
const MAX_QUEUE_BYTES = 24 * 1024
/** The longest a cancel holds the messages sent while its Ctrl-C is on its way (`interrupting`). */
const CANCEL_HOLD_MS = 5_000
const ITEM_TTL_MS = 5 * 60_000
// The window for an engine that declares none of its own (engines/submissionPolicies.ts declares Claude
// Code's and Codex's, with the reasons).
const SUBMIT_VERIFY_MS = 1_500
// OpenCode's accept signal is the reader's DB poll (~1s) surfacing a new user row → turn_started, so
// give it a slightly longer window than the file-based engines before a retry-Enter.
const OPENCODE_SUBMIT_VERIFY_MS = 2_500
// Kilo is opencode's fork and its user row lands on Enter the same way, read by the same 1s DB poll, so
// it gets the same window. Measured on a live pane: the row is written as the turn opens, not when the
// model replies — so this covers the poll, not model latency (which is Command Code's problem, not this).
const KILO_SUBMIT_VERIFY_MS = 2_500
// Pi has no composer glyph either, and its JSONL is written per completed message — give the derived
// turn_started a comparable window before re-pressing Enter.
const PI_SUBMIT_VERIFY_MS = 2_500
// Hermes' composer glyph (`❯`) is user-skinnable, so it is verified from the DB like opencode/pi. Its
// user row lands at turn start, so the window matches theirs.
const HERMES_SUBMIT_VERIFY_MS = 2_500
// Command Code's composer is a bare `>` (and `/`+`@` open autocompletes that swallow Enter), so it is
// verified from the transcript like opencode/pi/hermes. Unlike them it does not write the user record on
// Enter: the file is flushed per model round-trip, so the record only lands once the first response comes
// back (measured 3.2s on its fastest model). A shorter window fires a spurious retry-Enter on every
// injection and can raise a false "did not accept" — so this window covers model TTFT, not terminal echo.
const COMMANDCODE_SUBMIT_VERIFY_MS = 6_000
// Devin's accept signal is its sessions.db poll (~1s) surfacing the new user row. Unlike Command Code it
// writes that row on Enter rather than when the model round-trip commits (measured: turn_started 1.1s
// after paste), so it needs only the same poll-sized window as opencode/pi/hermes.
const DEVIN_SUBMIT_VERIFY_MS = 2_500
// Muse writes the `started` record as soon as it accepts the prompt, so the transcript answers within
// one poll — same window as the other store-verified engines.
const MUSE_SUBMIT_VERIFY_MS = 6_000
// Amp's plugin writes `turn_start` from the agent.start event, which fires the instant the prompt is
// accepted — no model round trip in between, so the same store-verified window fits.
const AMP_SUBMIT_VERIFY_MS = 6_000
// Grok's FIRST prompt creates the session, runs SessionStart + UserPromptSubmit hooks, then writes the
// user_message_chunk. The isolated real run took ~4.4s from paste to watcher-visible turn start; 2.5s
// pressed Enter a second time on every fresh agent even though the first submission was accepted.
const GROK_SUBMIT_VERIFY_MS = 6_000
// agy's first `PreInvocation` is what clears the fingerprint, and it only fires once the model call
// starts. Measured 3-5s from Enter to the first hook on a warm session; 8s leaves headroom without
// making a genuinely dropped message wait too long for its error.
const AGY_SUBMIT_VERIFY_MS = 8_000
// Copilot's first hook of a turn is `userPromptSubmitted`, which fires as soon as Enter is accepted —
// faster than agy's, which waits for the model call. 6s is the same headroom grok gets.
const COPILOT_SUBMIT_VERIFY_MS = 6_000
// OpenClaw's TUI draws no composer glyph Harness reads, so only the run's user row confirms a message, and the Gateway
// writes it as the run starts. A Gateway short of memory stalled 18 s at a time before writing it (lamp, 2026-11-11):
// three 10 s windows give the row 30 s in all before the message is given up.
const OPENCLAW_SUBMIT_VERIFY_MS = 10_000
// OpenClaw puts a message it refused back into its input box (Gateway not connected, history not loaded, a run going)
// and sends nothing until its pane can. Two Enters on a pane that could not send gave a first task up with a log line
// only (reproduced on a cold Gateway, 2026-11-19): a message waits for such a pane, untyped, up to this long, and once
// typed, its windows on one are not counted, up to this long from the paste.
const OPENCLAW_NOT_READY_MAX_MS = 180_000
/** How often a message waiting for its OpenClaw pane to be able to send reads it again: one capture a second, typed
 *  within a second of the `/session` that lets the pane send. */
const OPENCLAW_PANE_RETRY_MS = 1_000
/**
 * Why a message was not typed into an OpenClaw pane, nothing written: the pane could not send it (core/input.ts). Typed,
 * it would be refused back into the input box, where nothing sends it: the binding pass types `/session` only into an
 * empty box (core/agents/bind.ts). It waits here instead.
 */
export const OPENCLAW_NOT_READY = 'openclaw_not_ready'
/**
 * Why a message waiting for its OpenClaw pane was not typed, nothing written: the agent's first task goes first
 * ([InputState.firstTaskAhead]), and its hand-over is typed behind the write this message holds. It waits in the queue
 * behind the task instead.
 */
const GAVE_WAY = 'gave_way'
const CURSOR_TURN_SETTLE_MS = 750
const SUBMIT_MAX_RETRIES = 2
/** How long a paste the control lease refused, before a byte was written, waits for the lease, and how
 *  often it asks again. */
const LEASE_WAIT_MS = 15_000
const LEASE_RETRY_MS = 250
// Re-observe briefly while a submitted prompt awaits a transcript event. Reaching this limit is not
// evidence of rejection: Claude can hold an accepted follow-up while background agents finish.
const SUBMIT_MAX_OBSERVES = 5

export interface SessionInputDelivery {
  deliveryId: string
  sessionId: string
  state: 'queued' | 'delivered' | 'started' | 'rejected' | 'unknown'
  reason?: string
}

/**
 * What became of a person's message, one without a delivery id (the windows' and the phone's composers), said
 * once and for measurement only: the request's measurement had its start and nothing more (2026-10-19: 14 phone
 * messages, no outcome). `started`, its turn began; `taken`, the engine took it without a turn being seen yet (it
 * left the composer, or a running turn it follows ended). The person was told why for each of the next nine
 * (`agent_gone`, `runtime_gone`, `held`, `withheld`, `paste_failed`, `not_submitted`, `queue_full`,
 * `queue_expired`, `invalid`, nothing sent for most); `ambiguous`, `prompt_mismatch` and `turn_ended` were typed
 * and never confirmed either way; `cancelled`, the person stopped it.
 */
export type MessageOutcome = 'started' | 'taken' | 'agent_gone' | 'runtime_gone' | 'held' | 'withheld' | 'paste_failed'
  | 'not_submitted' | 'queue_full' | 'queue_expired' | 'invalid' | 'ambiguous' | 'prompt_mismatch' | 'turn_ended' | 'cancelled'
export type MessageReceipt = (outcome: MessageOutcome) => void

/** [receipt] said at most once, and never into the input path: a receipt that throws is measurement lost. */
function sayOnce(receipt?: MessageReceipt): MessageReceipt | undefined {
  if (!receipt) return undefined
  let said = false
  return (outcome) => {
    if (said) return
    said = true
    try { receipt(outcome) } catch { /* Optional measurement. */ }
  }
}

interface QueuedInput {
  deliveryId?: string
  receipt?: MessageReceipt
  content: string
  bytes: number
  expiresAt: number
  /** The agent's first task ([submitFirstTask]): it goes before every other message, and never expires here. */
  first?: true
  /** When a message put back here after it was typed ([clearRefused]) was first pasted. */
  firstPaste?: number
}

/** A pending message retains capacity until its move, cancel or earlier-write callback is consumed. */
interface HeldInput {
  deliveryId?: string
  receipt?: MessageReceipt
  bytes: number
  cancelled: boolean
}

/** Burst profiling found discarded splice results on every consumed ticket. Preserve order without that allocation. */
function removeHeld(held: HeldInput[], item: HeldInput): void {
  const at = held.indexOf(item)
  if (at < 0) return
  for (let i = at; i < held.length - 1; i++) held[i] = held[i + 1]
  held.pop()
}

interface InputState {
  /** The writes this agent's messages are making, one after another in the order they arrived. */
  writes?: Promise<void>
  deliveryId?: string
  deliveryFingerprint?: string
  dispatching?: boolean
  writing?: boolean
  cancelled?: boolean
  observedStart?: string
  turnOpen: boolean
  awaitingFingerprint: string | null
  awaitingContent: string | null
  /** When the message awaiting confirmation was pasted. */
  pastedAt: number
  /** The agent's first task is the controller's, from when it is expected until a turn takes it ([firstTaskEnded]): it
   *  is never given up here ([firstTaskWaiting]). */
  firstTask: boolean
  /** A message waits for its OpenClaw pane to be able to send ([OPENCLAW_NOT_READY]): nothing of it is typed but while the
   *  pane is read again ([pasting]). */
  paneWait: boolean
  /** That message is being written while its pane is read again: it is typed if the pane can send it. */
  pasting: boolean
  /** The message awaiting confirmation is a first task an earlier daemon typed ([adoptTypedFirstTask]): this one never
   *  pasted it, and the box may hold the person's draft, so it gets an Enter only on a box read to hold it. */
  adopted: boolean
  /** The message awaiting confirmation was cleared from its OpenClaw box ([clearRefused]), which happens once a message:
   *  kept across its paste again, and for a first task until the first task ends, across its hand-over again. */
  cleared: boolean
  /** Ctrl+U is being pressed into the box ([clearRefused]): what it shows is what is left of Harness's message. */
  clearing: boolean
  /** The first task goes before every message and is not typing yet: back on its row ([clearRefused]), handed over
   *  ([expectFirstTask]), or submitted and waiting for its write to start ([submitFirstTask]). A message sent meanwhile is
   *  queued behind it ([heldBehindFirstTask]). */
  firstTaskAhead: boolean
  /** The first task as its row holds it, which the row is asked for it by, and its fingerprint as typed (the row's text
   *  as the engine takes it, lib/goalCommand.ts), which tells its turn from any other. */
  firstTaskRow: string | null
  firstTaskFingerprint: string | null
  /** The first task is done with while its row says it waits untyped: the person stopped it before it was typed
   *  ([interrupted]), or its turn took it while its row was asked for it back ([keepFirstTaskTyped]). The hand-over to come
   *  lets its row go instead of typing it. */
  firstTaskDropped: boolean
  /** The receipt of the person's message typed last, until it is settled ([settle]). */
  awaitingReceipt?: MessageReceipt
  controlLocked: boolean
  /** Cancels still pressing their Ctrl-C: a message sent meanwhile waits for it, in `held` (`interrupting`). */
  cancelling: number
  /** What those cancels hold, to go on once they are done: writes that were already on their way first, then
   *  messages sent since, each in the order it came. */
  afterCancel: { writes: Array<() => void>; sent: Array<() => void> }
  settling: boolean
  queue: QueuedInput[]
  /** Messages waiting on a move, cancel or earlier write. Counted against the queue's limits. */
  held: HeldInput[]
  timer: NodeJS.Timeout | null
  settleTimer: NodeJS.Timeout | null
  retries: number
  observes: number
  ambiguousDispatch: boolean
}

export interface SessionInputDeps {
  readScreen: ScreenReader
  /** The reading of a typed prompt by the engines whose worker reads it (Claude Code, Codex): the pane after
   *  the paste, and a turn's prompt as recorded. Every verdict and every Enter stays here. */
  submission: SubmissionReader
  /** A team-only preflight at the actual write boundary. A reason proves no paste occurred. */
  beforeTeamWrite?: (session: RegisteredSession, deliveryId?: string) => Promise<string | null>
  onDelivery?: (event: SessionInputDelivery) => void
  getSession: (sessionId: string) => RegisteredSession | undefined
  validateRuntime: (session: RegisteredSession) => Promise<boolean>
  /** Boolean is retained for direct controller tests and legacy embedders. Production returns dispatch evidence. */
  inject: (terminalTarget: string, content: string) => Promise<boolean | TerminalActionResult>
  /** Host serializes the preflight and paste with other terminal writers. */
  injectTeam?: (terminalTarget: string, content: string, deliveryId: string) => Promise<boolean | TerminalActionResult>
  /** A command of the engine's own and its Enter, typed as `inject` types a message but into an empty box, whether or not
   *  the pane can send a message yet: the command is what makes it able to ([typeCommand]). */
  injectCommand?: (terminalTarget: string, line: string) => Promise<boolean | TerminalActionResult>
  sendKey: (terminalTarget: string, key: string) => Promise<boolean | TerminalActionResult>
  capture?: (terminalTarget: string) => Promise<string | null>
  onError: (sessionId: string, message: string) => void
  /**
   * A message was accepted by the pane. Not every engine needs this — most announce the turn
   * themselves — but an engine that only writes its transcript once the turn is OVER has no other
   * moment at which a turn is known to have started, and this one is exact: we sent it.
   */
  onSubmitted?: (sessionId: string, content: string) => void
  /** Whether the engine's reader of [session] is starting: null when it is up (or the engine needs none), else whether it came up
   *  within its bounded wait (core/serviceLinks.ts `whenUp`). A message waits for it before the lease's wait begins. */
  engineStarting?: (session: RegisteredSession) => Promise<boolean> | null
  /** A message waits for something before it is typed: said once, as it starts to wait. */
  onWaiting?: (sessionId: string, reason: 'engine_starting') => void
  /** An agent's `waitingFor` changed (its first message began to wait, or its last stopped): its frame is pushed again. */
  onWaitChanged?: (id: string) => void
  /** An OpenClaw first task's move on its row from typed back to waiting untyped (lib/registry.ts), made before its box is
   *  cleared, asked by the row's own text: true once it is saved. False, or absent, and nothing is pressed. */
  untypeFirstTask?: (id: string, text: string) => Promise<boolean>
  /** Its move back, from waiting untyped to typed, when the clear did not end in an empty box ([keepFirstTaskTyped]), asked
   *  by the row's own text: true once it is saved. */
  retypeFirstTask?: (id: string, text: string) => Promise<boolean>
  /** The agent's first task is done with: its turn took it ([onTurnStarted]), or the person stopped it before it was typed
   *  ([interrupted]). Its row lets the typed task go (lib/registry.ts `firstTaskTaken`). Not said for a stop once it is
   *  typed, nor for a forget: OpenClaw's store or the binding pass's bound settles those (core/agents/bind.ts). */
  onFirstTaskTaken?: (id: string) => void
  /** Clock and timer for the lease wait; real ones by default. */
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  /** While an agent changes host, its messages wait here and are typed into the pane it ends on. Absent: none
   *  is ever held. */
  moveGate?: MoveGate
}

/** A message not typed because of what the pane showed (messageHold.ts): nothing was written. */
function heldBack(delivery: boolean | TerminalActionResult): MessageHold | null {
  return typeof delivery !== 'boolean' && delivery.state === 'failed' && delivery.dispatch === 'not_started'
    && isMessageHold(delivery.reason) ? delivery.reason : null
}

/**
 * A write refused before a byte of it was written for a reason that passes: the pane's control lease, or
 * a screen with no composer on it yet, an engine starting or redrawing (messageHold.ts `passingHold`).
 */
function leaseRefused(delivery: boolean | TerminalActionResult): boolean {
  return typeof delivery !== 'boolean' && delivery.state === 'failed' && delivery.dispatch === 'not_started'
    && (delivery.reason === TERMINAL_LEASE_REFUSED || passingHold(delivery.reason))
}

/** A write its OpenClaw pane held back, nothing written: the pane could not send it yet ([OPENCLAW_NOT_READY]). */
function paneNotReady(delivery: boolean | TerminalActionResult): boolean {
  return typeof delivery !== 'boolean' && delivery.state === 'failed' && delivery.dispatch === 'not_started'
    && delivery.reason === OPENCLAW_NOT_READY
}

/** A write that waited for its pane and gave way to the agent's first task, nothing written ([GAVE_WAY]). */
function gaveWay(delivery: boolean | TerminalActionResult): boolean {
  return typeof delivery !== 'boolean' && delivery.state === 'failed' && delivery.reason === GAVE_WAY
}

/** A message waits for its OpenClaw pane, nothing of it being typed now ([InputState.paneWait]). */
function waitingUntyped(state: InputState): boolean {
  return state.paneWait && !state.pasting
}

/**
 * Whether the messages queued for a pane wait for its first task, which goes first and is not typing yet
 * ([InputState.firstTaskAhead]), and is not itself the next in the queue. Typed nowhere yet, they do not hold the
 * `/session` its pane needs to send it ([acquireControl]).
 */
function heldBehindFirstTask(state: InputState): boolean {
  return state.firstTaskAhead && !state.queue[0]?.first
}

function fingerprint(content: string): string {
  return createHash('sha256').update(content.replace(/\r\n/g, '\n').trim()).digest('hex')
}

/** Engine-aware prompt injection. Terminal TUIs get a bounded per-session FIFO while a turn is busy. */
export class SessionInputController {
  private states = new Map<string, InputState>()
  /** The messages waiting for each agent's engine's reader to start (`engineReady`), by session. */
  private readonly waitingEngine = new Map<string, number>()

  constructor(private readonly deps: SessionInputDeps) {}

  /**
   * An engine whose own TUI queues a message typed while a turn is running, and runs it when the turn ends,
   * says so in its submission policy (`typesWhileBusy`: Claude Code and Codex). For those the daemon types
   * immediately — the follow-up appears in the pane the moment it is spoken, and the TUI's queue is the one
   * the user can see and edit. Every other engine gets this file's FIFO, pasted only once the pane is idle.
   */
  private typesWhileBusy(engine: string): boolean {
    return this.deps.submission.policy(engine)?.typesWhileBusy === true
  }


  /** Controller dependencies take the stable agent id, never a backend route. */
  private controlSession(id: string): RegisteredSession | undefined {
    return this.deps.getSession(id)
  }

  /**
   * The record the checks after a paste read the pane under. A message sent while its engine starts is
   * typed before the engine's first hook binds the conversation, and its turn can start after the verify
   * window: read as typed, the fenced readings refuse it and the message is reported unconfirmed. The
   * record as it now stands is taken when it is that launch, bound since (core/engines/sessionBinding.ts
   * `launchBound`); a rebind, a rotation, another pane or another process is read as typed, and fails closed.
   */
  private readingSession(session: RegisteredSession): RegisteredSession {
    return launchBound(session, this.controlSession(session.agentId))
  }

  /** Waits, bounded, for the engine's reader to start (`engineStarting`), saying so once to the person (a team delivery is
   *  automatic: its mailbox hears how it ends); one that does not come in time is logged by name. Whether it waited: the agent may
   *  have gone meanwhile, which its caller checks again. */
  private engineReady(sessionId: string, session: RegisteredSession, team: boolean): Promise<true> | false {
    const starting = this.deps.engineStarting?.(session)
    // Keep ready input synchronous: profiling found a needless Promise and continuation on every message.
    if (!starting) return false
    return this.waitForEngine(sessionId, session, team, starting)
  }

  private async waitForEngine(sessionId: string, session: RegisteredSession, team: boolean, starting: Promise<boolean>): Promise<true> {
    console.warn(`[inject] ${sid(sessionId)} waiting · engine=${session.engine} · its reader is starting`)
    if (!team) this.deps.onWaiting?.(sessionId, 'engine_starting')
    const since = (this.deps.now ?? Date.now)()
    // A person's wait is on the agent's frame too, as message_waiting said it (a team delivery's is not), and every window hears
    // when it starts and ends (`onWaitChanged`).
    if (!team) this.countWait(sessionId, 1)
    let up = false
    try { up = await starting } finally { if (!team) this.countWait(sessionId, -1) }
    console.warn(`[inject] ${sid(sessionId)} ${up ? 'reader up' : 'ENGINE_NOT_STARTED reader did not start'} · engine=${session.engine} · after ${Math.round(((this.deps.now ?? Date.now)() - since) / 1000)} s`)
    return true
  }

  /** What a message to [id] (an agent's id or its session's, as it was sent) waits for now: `engine` while one waits for its
   *  engine's reader (the agent's frame says so). */
  waitingFor(id: string): 'engine' | null {
    return this.waitingEngine.has(id) ? 'engine' : null
  }

  /** Whether [id]'s first task is expected, being typed, or typed, and its user row has not confirmed it yet. */
  firstTaskWaiting(id: string): boolean {
    return this.states.get(id)?.firstTask === true
  }

  /**
   * [id]'s first task is about to be taken off its row and submitted (core/agents/bind.ts): from now its frame reads it
   * from here ([firstTaskWaiting]), as the row no longer does once the task leaves it. Said from the paste, the agent
   * read idle with no ask between the two, about 350 ms (e2e/openclawShow.e2e.ts). A message sent from now waits behind
   * it until it is typing ([submitFirstTask]): pasted ahead of it, its turn was read as the task's. One done with before it
   * was typed ([InputState.firstTaskDropped]) is expected no more.
   */
  expectFirstTask(id: string): void {
    const state = this.state(id)
    if (state.firstTaskDropped) return
    state.firstTaskAhead = true
    if (state.firstTask) return
    state.firstTask = true
    this.deps.onWaitChanged?.(id)
  }

  /**
   * Types [task], [id]'s first task as its row holds it, as its engine takes it (a `/loop` or `/goal` it has not,
   * lib/goalCommand.ts): the binding pass's hand-over (core/agents/bind.ts). It goes before every message queued for [id],
   * once nothing else holds the pane (a caller, a cancel, a turn, a message awaiting its turn, a move), waits as long as
   * the first task does ([firstTaskEnded]), and is neither refused for a full queue nor expired here. One done with before
   * it was typed ([InputState.firstTaskDropped]) is not typed: its row lets it go.
   */
  submitFirstTask(id: string, task: string): void {
    const session = this.controlSession(id)
    if (!session) return
    const state = this.state(id)
    if (state.firstTaskDropped) {
      state.firstTaskDropped = false
      this.deps.onFirstTaskTaken?.(id)
      return
    }
    const typed = adaptSlashCommand(task, session.engine)
    state.firstTaskRow = task
    state.firstTaskFingerprint = fingerprint(typed)
    state.firstTaskAhead = true
    state.queue.unshift({ content: typed, bytes: Buffer.byteLength(typed, 'utf8'), expiresAt: Infinity, first: true })
    if (!state.firstTask) {
      state.firstTask = true
      this.deps.onWaitChanged?.(id)
    }
    this.drainOne(id, state)
  }

  /**
   * [text] is [id]'s first task an earlier daemon typed and did not see confirmed (its row's `firstTaskTyped`, found by the
   * binding pass after a restart): it is awaited as if typed now, its window from here, and settles as one typed here
   * does: an Enter only on a box that holds it, a box whose history did not load cleared ([clearRefused]), never a paste.
   * False, and nothing changes, while a first task or a message already awaits for [id] or is being typed, or a turn is
   * open (the task may be that turn, which OpenClaw's store confirms): the caller may ask again on a later pass.
   */
  adoptTypedFirstTask(id: string, text: string): boolean {
    const session = this.controlSession(id)
    if (!session) return false
    const state = this.state(id)
    if (state.firstTask || state.awaitingFingerprint !== null || state.turnOpen || (state.writes && !waitingUntyped(state))) return false
    // In its box as the engine took it from that daemon ([submitFirstTask]).
    const typed = adaptSlashCommand(text, session.engine)
    state.firstTask = true
    state.firstTaskRow = text
    state.firstTaskFingerprint = fingerprint(typed)
    state.awaitingFingerprint = state.firstTaskFingerprint
    state.awaitingContent = typed
    state.retries = 0
    state.observes = 0
    state.ambiguousDispatch = false
    this.pasted(state, undefined)
    state.adopted = true
    this.deps.onWaitChanged?.(id)
    this.armSubmitCheck(id, session, state)
    return true
  }

  /**
   * OpenClaw's store holds the user row of [id]'s first task (core/agents/bind.ts), written with no turn seen here (while
   * the daemon was down, say): the task was taken. Its wait ends as a turn's would, with no error and no key, and what
   * waits behind it goes on.
   */
  firstTaskConfirmed(id: string): void {
    const state = this.states.get(id)
    if (!state?.firstTask) return
    if (state.timer) clearTimeout(state.timer)
    state.timer = null
    state.awaitingFingerprint = null
    state.awaitingContent = null
    state.retries = 0
    state.observes = 0
    state.ambiguousDispatch = false
    this.settle(state, 'taken')
    this.firstTaskEnded(id, state)
    this.drainOne(id, state)
  }

  private countWait(id: string, by: 1 | -1): void {
    const count = (this.waitingEngine.get(id) ?? 0) + by
    if (count > 0) this.waitingEngine.set(id, count)
    else this.waitingEngine.delete(id)
    if (count === (by > 0 ? 1 : 0)) this.deps.onWaitChanged?.(id)
  }

  /**
   * A paste the pane's control lease refused before a byte was written: the agent is there, but its
   * process is not yet the one the registry holds — a resume or restart moments ago, before the new
   * process was confirmed — or another writer holds the pane. Wait for the lease, up to
   * LEASE_WAIT_MS, rather than fail the message; nothing was written, so asking again can never type
   * it twice. Found end to end: a message sent as a resume was confirmed was refused 140 ms later and
   * lost, and a real engine takes seconds to confirm.
   *
   * An OpenClaw pane that cannot send the message yet ([OPENCLAW_NOT_READY]) is waited for the same way, up to
   * OPENCLAW_NOT_READY_MAX_MS, and for a first task as long as it waits ([firstTaskEnded]): the binding pass bounds
   * that. It is not read again while a command of the pane's own is typed (`typeCommand`), which the message would run
   * into in the box, nor while a first task an earlier daemon typed awaits its turn ([adoptTypedFirstTask]), which it would
   * go ahead of once that task's Enter empties the box. A message typed once already and cleared ([clearRefused]) counts
   * that wait from [firstPaste]. While the agent's first task goes first ([InputState.firstTaskAhead]), a message waiting
   * for its pane gives way ([GAVE_WAY]): the task's write is chained behind this one, so waiting here would hold it.
   */
  private async injectWhenLeased(
    state: InputState,
    write: () => Promise<boolean | TerminalActionResult>,
    current: () => boolean,
    held: () => boolean,
    firstPaste?: number,
  ): Promise<boolean | TerminalActionResult> {
    const now = this.deps.now ?? Date.now
    const sleep = this.deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
    const deadline = now() + LEASE_WAIT_MS
    const refused = (): TerminalActionResult => ({ state: 'failed', dispatch: 'not_started', reason: 'held' })
    if (held()) return refused()
    if (!current()) return { state: 'failed', dispatch: 'not_started', reason: TERMINAL_LEASE_REFUSED }
    let delivery = await write()
    let notReadySince = firstPaste
    try {
      for (;;) {
        const notReady = paneNotReady(delivery)
        if (notReady) {
          notReadySince ??= now()
          if (!state.firstTask && now() - notReadySince >= OPENCLAW_NOT_READY_MAX_MS) break
          // Said from its first not-ready answer until it is typed or given up, each read of the pane included: the binding
          // pass reads it once a pass, and a read caught between two said it no more.
          state.paneWait = true
        } else if (!leaseRefused(delivery) || now() >= deadline) break
        await sleep(notReady ? OPENCLAW_PANE_RETRY_MS : LEASE_RETRY_MS)
        if (held()) return refused()
        if (!current()) break
        if (notReady && state.firstTaskAhead) return { state: 'failed', dispatch: 'not_started', reason: GAVE_WAY }
        if (notReady && (state.controlLocked || state.awaitingFingerprint !== null)) continue
        state.pasting = true
        try { delivery = await write() } finally { state.pasting = false }
      }
    } finally {
      state.paneWait = false
    }
    return delivery
  }

  private state(sessionId: string): InputState {
    let value = this.states.get(sessionId)
    if (!value) {
      value = {
        turnOpen: false,
        awaitingFingerprint: null,
        awaitingContent: null,
        pastedAt: 0,
        firstTask: false,
        paneWait: false,
        pasting: false,
        adopted: false,
        cleared: false,
        clearing: false,
        firstTaskAhead: false,
        firstTaskRow: null,
        firstTaskFingerprint: null,
        firstTaskDropped: false,
        controlLocked: false,
        cancelling: 0,
        afterCancel: { writes: [], sent: [] },
        settling: false,
        queue: [],
        held: [],
        timer: null,
        settleTimer: null,
        retries: 0,
        observes: 0,
        ambiguousDispatch: false,
      }
      this.states.set(sessionId, value)
    }
    return value
  }

  setTurnOpen(sessionId: string, open: boolean): void {
    this.state(sessionId).turnOpen = open
  }

  private delivery(sessionId: string, deliveryId: string | undefined, state: SessionInputDelivery['state'], reason?: string): void {
    if (deliveryId) this.deps.onDelivery?.({ sessionId, deliveryId, state, ...(reason ? { reason } : {}) })
  }

  private finishDelivery(sessionId: string, state: InputState, outcome: SessionInputDelivery['state'], reason?: string): void {
    const id = state.deliveryId
    state.deliveryId = undefined
    state.deliveryFingerprint = undefined
    this.delivery(sessionId, id, outcome, reason)
  }

  /** The awaited person's message is settled as [outcome]: wherever its wait for a turn ends. */
  private settle(state: InputState, outcome: MessageOutcome): void {
    const receipt = state.awaitingReceipt
    state.awaitingReceipt = undefined
    receipt?.(outcome)
  }

  /**
   * A first task waits no more: its turn took it, the person stopped it, or the agent is gone. Nothing else ends its
   * wait, a message given up or a turn of other text included: the binding pass's bound fails the launch instead
   * (core/agents/bind.ts), so a task lost after it left its row is never read as idle with no ask. The agent's frame
   * says so (`onWaitChanged`).
   */
  private firstTaskEnded(sessionId: string, state: InputState): void {
    if (!state.firstTask) return
    state.firstTask = false
    state.cleared = false
    state.firstTaskAhead = false
    state.firstTaskRow = null
    state.firstTaskFingerprint = null
    this.deps.onWaitChanged?.(sessionId)
  }

  /** Revoke queued work only; a paste already in progress cannot be recalled. */
  cancelDelivery(deliveryId: string): boolean {
    for (const [sessionId, state] of this.states) {
      const held = state.held.findIndex((item) => item.deliveryId === deliveryId && !item.cancelled)
      if (held >= 0) {
        state.held[held].cancelled = true
        // Its callback still retains the content; cancellation must not allow unbounded pending writes.
        this.delivery(sessionId, deliveryId, 'rejected', 'cancelled')
        return true
      }
      const index = state.queue.findIndex((item) => item.deliveryId === deliveryId)
      if (index >= 0) {
        state.queue.splice(index, 1)
        this.delivery(sessionId, deliveryId, 'rejected', 'cancelled')
        return true
      }
      if (state.deliveryId === deliveryId && !state.writing && !state.awaitingFingerprint && !state.deliveryFingerprint) {
        state.cancelled = true
        this.finishDelivery(sessionId, state, 'rejected', 'cancelled')
        return true
      }
    }
    return false
  }

  /** [receipt]: what became of a person's message (one with no [deliveryId]), for its measurement. */
  submit(sessionId: string, content: string, deliveryId?: string, receipt?: MessageReceipt): void {
    const said = sayOnce(receipt)
    if (this.refuseHeldMessage(sessionId, deliveryId, said)) return
    // An agent changing host has no pane to type into until the move ends: the message waits, as itself, and
    // is submitted then, through every check `submitNow` makes, into the pane the row then names.
    const agentId = this.controlSession(sessionId)?.agentId
    const gate = this.deps.moveGate
    if (agentId && gate?.holding(agentId)) {
      const state = this.state(sessionId)
      const bytes = Buffer.byteLength(content, 'utf8')
      if (this.refusedFull(sessionId, state, bytes, deliveryId, said)) return
      console.log(`[inject] ${sid(sessionId)} held · the agent is changing host · depth=${state.held.length + 1}`)
      const item: HeldInput = { deliveryId, receipt: said, bytes, cancelled: false }
      state.held.push(item)
      gate.enqueue(agentId, async () => {
        removeHeld(state.held, item)
        if (!item.cancelled && this.states.get(sessionId) === state) await this.submitNow(sessionId, content, deliveryId, said)
      }, () => {
        removeHeld(state.held, item)
        if (!item.cancelled && this.states.get(sessionId) === state) {
          item.cancelled = true
          this.rejectHeldMessage(sessionId, deliveryId, said)
        }
      })
      return
    }
    void this.submitNow(sessionId, content, deliveryId, said)
  }

  /**
   * `submit` past the move gate. Resolves once this message's write is done, or at once when it is queued
   * here or refused: the gate delivers what it held one at a time, and a keystroke held behind this message
   * must not land between its paste and its Enter.
   */
  private submitNow(sessionId: string, content: string, deliveryId?: string, said?: MessageReceipt): Promise<void> {
    if (this.refuseHeldMessage(sessionId, deliveryId, said)) return Promise.resolve()
    const session = this.controlSession(sessionId)
    if (!session) {
      said?.('agent_gone')
      this.delivery(sessionId, deliveryId, 'rejected', 'agent_gone')
      if (!deliveryId?.startsWith('team:')) this.deps.onError(sessionId, 'This harness is no longer available.')
      return Promise.resolve()
    }
    const state = this.state(sessionId)
    if (state.cancelling) {
      this.holdForCancel(sessionId, state, Buffer.byteLength(content, 'utf8'), deliveryId, said, 'sent',
        () => void this.submitNow(sessionId, content, deliveryId, said))
      return Promise.resolve()
    }
    this.dropExpired(sessionId, state)
    if (state.controlLocked || state.firstTaskAhead
      || (deliveryId && (state.deliveryId || state.dispatching || state.awaitingFingerprint || state.turnOpen || state.settling))
      || (!this.typesWhileBusy(session.engine) && (state.turnOpen || state.awaitingFingerprint || state.settling))) {
      console.log(`[inject] ${sid(sessionId)} queued · engine=${session.engine} · depth=${state.queue.length + 1}`)
      this.enqueue(sessionId, state, content, deliveryId, said)
      return Promise.resolve()
    }
    this.delivery(sessionId, deliveryId, 'queued')
    // One write at a time per agent, in the order the messages arrived. Claude Code and Codex take
    // typing while a turn runs, so a message is not held for the turn — but two pastes into one pane at
    // once interleave: one message's text lands between another's paste and its Enter, and the engine
    // receives a single prompt made of both. Found end to end: five messages sent within 30 ms became
    // two turns, "one" and "three" run together and the rest, out of order. Each write starts with the
    // agent as it is by then, which a restart in between may have changed.
    // With nothing in flight the write starts at once, so a cancel or a control request that follows
    // the submit sees it, as before.
    return this.scheduleWrite(sessionId, content, deliveryId, said)
  }

  /** [firstPaste]: when a message typed again after it was cleared ([clearRefused]) was first pasted. [first]: the agent's
   *  first task ([submitFirstTask]), which messages wait behind until its write starts. */
  private scheduleWrite(sessionId: string, content: string, deliveryId?: string, receipt?: MessageReceipt, firstPaste?: number, first?: true): Promise<void> {
    const state = this.state(sessionId)
    let pending: HeldInput | undefined
    if (state.writes) {
      const bytes = Buffer.byteLength(content, 'utf8')
      if (this.refusedFull(sessionId, state, bytes, deliveryId, receipt)) return Promise.resolve()
      pending = { deliveryId, receipt, bytes, cancelled: false }
      state.held.push(pending)
    }
    const write = (): Promise<void> => {
      if (pending) {
        removeHeld(state.held, pending)
        if (pending.cancelled) return Promise.resolve()
      }
      if (this.states.get(sessionId) !== state) return Promise.resolve()
      if (this.refuseHeldMessage(sessionId, deliveryId, receipt)) return Promise.resolve()
      // On its way before a cancel began, its turn to be typed came while the Ctrl-C is: it goes on after it.
      if (state.cancelling) {
        this.holdForCancel(sessionId, state, pending?.bytes ?? Buffer.byteLength(content, 'utf8'), deliveryId, receipt, 'writes',
          () => void this.scheduleWrite(sessionId, content, deliveryId, receipt, firstPaste, first))
        return Promise.resolve()
      }
      if (first) {
        state.firstTaskAhead = false
        // Done with before its write started (stopped, say): never typed, and its row lets it go.
        if (state.firstTaskDropped) {
          state.firstTaskDropped = false
          this.deps.onFirstTaskTaken?.(sessionId)
          return Promise.resolve()
        }
      }
      const current = this.controlSession(sessionId)
      if (!current) {
        this.delivery(sessionId, deliveryId, 'rejected', 'agent_gone')
        receipt?.('agent_gone')
        if (!deliveryId?.startsWith('team:')) this.deps.onError(sessionId, 'This harness is no longer available.')
        return Promise.resolve()
      }
      return this.inject(sessionId, current, content, deliveryId, receipt, firstPaste)
    }
    const running = state.writes ? state.writes.then(write, write) : write()
    const clear = (): void => {
      if (state.writes === settled) state.writes = undefined
    }
    const settled = running.then(clear, clear)
    state.writes = settled
    return settled
  }

  /** Reserve this pane for a short native control interaction such as `/model`. */
  /**
   * Take the terminal for a write that is not a new message.
   *
   * `forAnswer` exists because an engine's ask-the-user dialog opens INSIDE its turn — claude, agy and
   * every other engine with a question tool — so the `turnOpen` guard, which is there to stop an
   * INJECTED message colliding with a running turn, also blocked the one write that is only ever valid
   * during a turn. Measured on both claude and agy: the device's answer arrived, was refused here, and
   * the pane sat on the dialog looking like a hung agent, with nothing logged.
   *
   * Every other guard still applies: another writer holding the lock, a submit awaiting confirmation, a
   * settling turn, or queued messages all still refuse; queued ones not while the message ahead of them waits for
   * its pane to be able to send (`paneWait`), nor while a first task not typing yet does ([heldBehindFirstTask]), typed
   * nowhere yet.
   */
  acquireControl(sessionId: string, opts?: { forAnswer?: boolean }): (() => void) | null {
    const session = this.controlSession(sessionId)
    if (!session) return null
    // Not while the agent changes host: what the holder typed would reach the pane being replaced. Refused
    // as a busy pane is, so the caller asks again (device input every 100 ms) and gets it after the move.
    const gate = this.deps.moveGate
    if (gate?.holding(session.agentId)) {
      gate.touch(session.agentId)
      return null
    }
    const state = this.state(sessionId)
    this.dropExpired(sessionId, state)
    const turnBlocks = state.turnOpen && !opts?.forAnswer
    const queued = state.queue.length > 0 && !waitingUntyped(state) && !heldBehindFirstTask(state)
    if (state.controlLocked || state.cancelling || turnBlocks || state.awaitingFingerprint || state.settling || queued) return null
    state.controlLocked = true
    let released = false
    return () => {
      if (released) return
      released = true
      const current = this.states.get(sessionId)
      if (current !== state) return
      current.controlLocked = false
      this.drainOne(sessionId, current)
    }
  }

  /**
   * Types [line] and its Enter, a command of the engine's own (OpenClaw's `/session <key>`), into [id]'s pane through
   * `injectCommand`, under the pane's write lock, only while nothing typed is pending for the pane: no message awaiting
   * confirmation or being written, none queued, no caller holding it, no turn open. A message waiting for the pane to
   * be able to send, and those queued behind it or behind a first task not typing yet, are typed nowhere yet: the command
   * is what lets the pane send them.
   * Held as a control is, so a message sent meanwhile waits for it. Whether it was typed.
   */
  async typeCommand(id: string, line: string): Promise<boolean> {
    const session = this.controlSession(id)
    const state = this.states.get(id)
    const injectCommand = this.deps.injectCommand
    if (!session || !injectCommand || (state?.writes && !waitingUntyped(state))) return false
    const release = this.acquireControl(id)
    if (!release) return false
    try {
      const delivery = await injectCommand(session.agentId, line)
      return typeof delivery === 'boolean' ? delivery : delivery.state === 'succeeded'
    } catch {
      return false
    } finally {
      release()
    }
  }

  /** Whether a caller holds this pane (`acquireControl`): a question being answered, a sequence of keys. */
  controlHeld(sessionId: string): boolean {
    return this.states.get(sessionId)?.controlLocked === true
  }

  /** Whether a message typed into this pane awaits the turn that confirms it. */
  awaitingConfirmation(id: string): boolean {
    return this.states.get(id)?.awaitingFingerprint != null
  }

  /** Whether a message waits, typed nowhere, for its OpenClaw pane to be able to send ([OPENCLAW_NOT_READY]). */
  waitsForPane(id: string): boolean {
    return this.states.get(id)?.paneWait === true
  }

  onTurnStarted(sessionId: string, userMessage: string): void {
    const state = this.state(sessionId)
    const session = this.controlSession(sessionId)
    // An exact echo of the typed prompt needs no reading. Anything else is, for an engine whose worker
    // reads its submissions, that engine's to unwrap (Claude Code 2.1.283 records a bracketed paste inside
    // an envelope of its own), and is settled once it has; every other engine's record is compared whole.
    const observedFingerprint = fingerprint(userMessage)
    const engineReads = !!session && !!this.deps.submission.policy(session.engine)
    if (state.deliveryId && state.writing) state.observedStart = userMessage
    else if (state.deliveryId && state.deliveryFingerprint) {
      const expected = state.deliveryFingerprint
      if (expected === observedFingerprint || !engineReads) {
        this.finishDelivery(sessionId, state, expected === observedFingerprint ? 'started' : 'unknown',
          expected === observedFingerprint ? undefined : 'prompt_mismatch')
      } else {
        // Taken off the pane's state now, as a settled delivery is, so a write that follows never waits on
        // the reading; only what is said of this delivery waits for it.
        const deliveryId = state.deliveryId
        state.deliveryId = undefined
        state.deliveryFingerprint = undefined
        void this.echoes(session, userMessage, expected).then(started => this.delivery(sessionId, deliveryId,
          started ? 'started' : 'unknown', started ? undefined : 'prompt_mismatch'))
      }
    }
    if (state.settleTimer) clearTimeout(state.settleTimer)
    state.settleTimer = null
    state.settling = false
    state.turnOpen = true
    // The row keeps a typed first task until a turn takes it (lib/registry.ts `firstTaskTyped`): this is that turn when it is
    // the task's text. Another's, a message ahead of it say, takes nothing.
    if (state.firstTask && state.firstTaskFingerprint === observedFingerprint) {
      this.deps.onFirstTaskTaken?.(sessionId)
      this.firstTaskEnded(sessionId, state)
    }
    // Cursor does not clear its composer when it accepts a prompt: the submitted text stays on the "→"
    // line for the whole turn and long after it, so the terminal reads as if the question is still
    // waiting to be sent. Clearing before the NEXT paste (see inject) stops the two from running
    // together, but leaves that stale copy on screen in the meantime. Drop it as soon as the turn is
    // confirmed started.
    void this.clearCursorEcho(sessionId, userMessage)
    if (state.awaitingFingerprint) {
      const warn = () => console.warn(`[inject] ${sessionId.slice(0, 8)} observed a different terminal prompt while awaiting submit`)
      const expected = state.awaitingFingerprint
      const receipt = state.awaitingReceipt
      state.awaitingReceipt = undefined
      if (expected !== observedFingerprint) {
        if (engineReads) void this.echoes(session, userMessage, expected).then(matched => { if (!matched) warn(); receipt?.(matched ? 'started' : 'prompt_mismatch') })
        else { warn(); receipt?.('prompt_mismatch') }
      } else receipt?.('started')
      state.awaitingFingerprint = null
      state.awaitingContent = null
      state.retries = 0
      state.observes = 0
      state.ambiguousDispatch = false
      if (state.timer) clearTimeout(state.timer)
      state.timer = null
    }
    this.drainOne(sessionId, state)
  }

  /**
   * Whether a turn's prompt, as the engine recorded it, is the prompt typed: the part of the record the
   * engine says is the typed text, compared exactly. No reading is no match.
   */
  private async echoes(session: RegisteredSession, recorded: string, expected: string): Promise<boolean> {
    const span = await this.deps.submission.echo(session, recorded).catch(() => null)
    return !!span && fingerprint(recorded.slice(span.start, span.end)) === expected
  }

  /**
   * Remove Cursor's leftover copy of a just-submitted prompt from its composer.
   *
   * Guarded by a pane read on purpose: it only sends the clear when the composer still holds the exact
   * text we submitted. A blind C-u here would delete a follow-up the user had already started typing in
   * the terminal during the turn — a small window, but their keystrokes, not ours.
   */
  private async clearCursorEcho(sessionId: string, userMessage: string): Promise<void> {
    const session = this.controlSession(sessionId)
    if (session?.engine !== 'cursor' || !this.deps.capture) return
    try {
      const capture = await this.deps.capture(session.agentId)
      if (!capture || !cursorComposerContains(capture, userMessage)) return
      await this.deps.sendKey(session.agentId, 'C-u')
      console.log(`[inject] ${sid(sessionId)} cleared the echoed prompt from the Cursor composer`)
    } catch {
      /* best-effort cosmetics — never let this break the turn */
    }
  }

  onTurnEnded(sessionId: string): void {
    const state = this.state(sessionId)
    if (!state.dispatching) this.finishDelivery(sessionId, state, 'unknown', 'turn_ended_without_start')
    // Typed while a turn ran, the engine holds it as that turn's follow-up; otherwise no turn was seen for it.
    this.settle(state, state.turnOpen ? 'taken' : 'turn_ended')
    state.turnOpen = false
    state.awaitingFingerprint = null
    state.awaitingContent = null
    state.retries = 0
    state.observes = 0
    state.ambiguousDispatch = false
    if (state.timer) clearTimeout(state.timer)
    state.timer = null
    const session = this.controlSession(sessionId)
    if (session?.engine === 'cursor') {
      // Cursor's stop hook can arrive just before its TUI has returned to the idle composer. A prompt
      // injected in that short window becomes a follow-up; Enter retries then enqueue it repeatedly.
      state.settling = true
      if (state.settleTimer) clearTimeout(state.settleTimer)
      state.settleTimer = setTimeout(() => {
        state.settleTimer = null
        state.settling = false
        this.drainOne(sessionId, state)
      }, CURSOR_TURN_SETTLE_MS)
      return
    }
    this.drainOne(sessionId, state)
  }

  cancel(sessionId: string): void {
    void this.interrupt(sessionId, true).catch((error) => {
      console.warn(`[inject] ${sid(sessionId)} cancel failed · ${errorKind(error)}`)
      this.deps.onError(sessionId, 'Stop did not reach this agent.')
    })
  }

  cancelConfirmed(sessionId: string): Promise<boolean> {
    return this.interrupt(sessionId, false)
  }

  /**
   * A cancel's Ctrl-C and what it settles. A message sent while the key is on its way (or a write whose turn
   * to be typed comes then, or a device's control) waits, and goes on after it, once the cancel has settled
   * what it interrupted: typed before, the cancel took it for its own and settled it as cancelled, with its
   * submit check dropped, and the Ctrl-C could clear it from the composer (seen once in seven Codex Stop runs,
   * 2026-11-10: received, never typed). Held at most CANCEL_HOLD_MS: a key stuck behind another writer does not
   * hold them for good.
   */
  private async interrupt(sessionId: string, reportGone: boolean): Promise<boolean> {
    const session = this.controlSession(sessionId)
    if (!session) return false
    const state = this.state(sessionId)
    state.cancelling++
    let held = true
    const release = (): void => {
      if (!held) return
      held = false
      clearTimeout(timer)
      state.cancelling--
      if (state.cancelling) return
      const { writes, sent } = state.afterCancel
      state.afterCancel = { writes: [], sent: [] }
      // A moment for the engine to take the key, as before; a forgotten agent's held messages are told so there.
      setTimeout(() => {
        for (const next of [...writes, ...sent]) next()
        if (this.states.get(sessionId) === state) this.drainOne(sessionId, state)
      }, 250)
    }
    const timer = setTimeout(() => {
      console.warn(`[inject] ${sid(sessionId)} cancel still pressing after ${CANCEL_HOLD_MS} ms · held messages go on`)
      release()
    }, CANCEL_HOLD_MS)
    try {
      if (!await this.deps.validateRuntime(session)) {
        if (reportGone) this.deps.onError(sessionId, 'This agent process is no longer running.')
        return false
      }
      const result = await this.deps.sendKey(session.agentId, 'C-c')
      this.interrupted(sessionId, state)
      return typeof result === 'boolean' ? result : result.dispatch === 'executed'
    } finally { release() }
  }

  /** Hold one message for the cancel pressing now, counted against the queue's limits and cancellable as queued ones are. */
  private holdForCancel(sessionId: string, state: InputState, bytes: number, deliveryId: string | undefined,
    receipt: MessageReceipt | undefined, kind: 'writes' | 'sent', go: () => void): void {
    if (this.refusedFull(sessionId, state, bytes, deliveryId, receipt)) return
    const item: HeldInput = { deliveryId, receipt, bytes, cancelled: false }
    state.held.push(item)
    console.log(`[inject] ${sid(sessionId)} held · a cancel is pressing Ctrl-C · depth=${state.held.length}`)
    state.afterCancel[kind].push(() => {
      removeHeld(state.held, item)
      if (!item.cancelled && this.states.get(sessionId) === state) go()
    })
  }

  /** What a Ctrl-C the person asked for ends: the message typed last, the turn, and a first task not typed yet. */
  private interrupted(sessionId: string, state: InputState): void {
    this.finishDelivery(sessionId, state, 'unknown', 'cancelled_after_paste')
    this.settle(state, 'cancelled')
    if (state.firstTaskAhead) state.firstTaskDropped = true
    this.firstTaskEnded(sessionId, state)
    state.turnOpen = false
    state.awaitingFingerprint = null
    state.awaitingContent = null
    state.ambiguousDispatch = false
    if (state.timer) clearTimeout(state.timer)
    state.timer = null
  }

  forget(sessionId: string): void {
    const state = this.states.get(sessionId)
    if (state?.timer) clearTimeout(state.timer)
    if (state?.settleTimer) clearTimeout(state.settleTimer)
    if (state) {
      this.finishDelivery(sessionId, state, state.writing || state.awaitingFingerprint || state.deliveryFingerprint ? 'unknown' : 'rejected', 'agent_gone')
      this.settle(state, 'ambiguous')
      this.firstTaskEnded(sessionId, state)
      for (const item of state.queue) {
        this.delivery(sessionId, item.deliveryId, 'rejected', 'agent_gone')
        item.receipt?.('agent_gone')
      }
      state.queue = []
      for (const item of state.held) {
        if (item.cancelled) continue
        item.cancelled = true
        this.delivery(sessionId, item.deliveryId, 'rejected', 'agent_gone')
        item.receipt?.('agent_gone')
      }
      state.held = []
      state.afterCancel = { writes: [], sent: [] }
      state.cancelled = true
    }
    this.states.delete(sessionId)
  }

  /** Preserve the established injection path for every caller that opts out of receipts. */
  private async injectLegacy(sessionId: string, session: RegisteredSession, content: string, receipt?: MessageReceipt, firstPaste?: number): Promise<void> {
    const state = this.state(sessionId)
    const current = (): boolean => this.states.get(sessionId) === state && this.controlSession(sessionId) !== undefined
    const gone = (outcome: MessageOutcome = 'agent_gone'): void => {
      receipt?.(outcome)
      if (this.states.get(sessionId) !== state) return
      console.warn(`[inject] ${sid(sessionId)} abort · agent no longer available`)
      this.deps.onError(sessionId, 'This harness is no longer available.')
    }
    const valid = await this.deps.validateRuntime(session)
    if (!current()) { gone(); return }
    if (!valid) {
      console.warn(`[inject] ${sid(sessionId)} abort · engine=${session.engine} · process not running`)
      receipt?.('runtime_gone')
      this.deps.onError(sessionId, 'This agent process is no longer running.')
      return
    }
    if (this.refuseHeldMessage(sessionId, undefined, receipt)) return
    if (session.engine === 'cursor') {
      // Cursor leaves the previous prompt sitting in its composer after the turn completes — the text is
      // still on the "→" line long after the answer and its recap have arrived. sendToTmux() types into
      // whatever is already there, so the next message is APPENDED to the last one and the pair is
      // submitted as a single run-on prompt:
      //   "…đầu tư dài hạn" + "Có nên mua thêm eth không…"
      // The agent then answers a question nobody asked, and the device shows a recap for it.
      //
      // The adapter already NOTICED this — onTurnStarted logs "observed a different terminal prompt while
      // awaiting submit" when the fingerprint of the started turn does not match what we sent — but it
      // only warned and carried on. Clear the line first so the composer is ours alone.
      //
      // C-u (kill-to-start-of-line) is a no-op on an empty composer, so this costs nothing in the normal
      // case. It does discard a draft a human was typing in the terminal — but pasting into that draft
      // would corrupt it into a run-on prompt anyway, which is worse and harder to notice.
      await this.deps.sendKey(session.agentId, 'C-u')
      if (!current()) { gone(); return }
    }
    const waitingForEngine = this.engineReady(sessionId, session, false)
    if (waitingForEngine) {
      await waitingForEngine
      // Seconds may have passed: the agent may have been closed, or its process ended.
      if (!current()) { gone(); return }
      const stillValid = await this.deps.validateRuntime(session)
      if (!current()) { gone(); return }
      if (!stillValid) {
        console.warn(`[inject] ${sid(sessionId)} abort · engine=${session.engine} · process not running`)
        receipt?.('runtime_gone')
        this.deps.onError(sessionId, 'This agent process is no longer running.')
        return
      }
    }
    if (!current()) { gone(); return }
    const delivery = await this.injectWhenLeased(state, () => this.deps.inject(session.agentId, content),
      current, () => this.deps.moveGate?.refused(session.agentId) === true, firstPaste)
    const accepted = typeof delivery === 'boolean'
      ? delivery
      : delivery.state === 'succeeded' || delivery.dispatch === 'possibly_executed'
    if (!current()) { gone(accepted ? 'ambiguous' : 'agent_gone'); return }
    if (gaveWay(delivery)) { this.putBack(state, { content, receipt, firstPaste }); return }
    if (typeof delivery !== 'boolean' && delivery.state === 'failed' && delivery.dispatch === 'not_started' && delivery.reason === 'held') {
      this.rejectHeldMessage(sessionId, undefined, receipt); return
    }
    const withheld = enterWithheldReason(delivery)
    if (withheld) {
      // Typed, its Enter not pressed: never pressed later either, which would send it into whatever is open.
      console.warn(`[inject] ${sid(sessionId)} typed, not sent · engine=${session.engine} · ${withheld} opened before Enter`)
      receipt?.('withheld')
      this.deps.onError(sessionId, messageWithheldText(session.engine, withheld))
      return
    }
    if (paneNotReady(delivery)) {
      receipt?.('not_submitted')
      this.paneNeverReady(sessionId, session)
      return
    }
    if (!accepted) {
      const held = heldBack(delivery)
      if (held) {
        console.warn(`[inject] ${sid(sessionId)} not typed · engine=${session.engine} · ${held}`)
        receipt?.('held')
        this.deps.onError(sessionId, messageHoldText(session.engine, held))
        return
      }
      console.warn(`[inject] ${sid(sessionId)} paste failed · engine=${session.engine} · target=${session.agentId}`)
      receipt?.('paste_failed')
      this.deps.onError(sessionId, 'The message could not be delivered to the agent.')
      return
    }
    console.log(`[inject] ${sid(sessionId)} paste ok · engine=${session.engine} · target=${session.agentId} · len=${content.length}`)
    // The one typed before it, never refused, was taken as the message before this one.
    this.settle(state, 'taken')
    state.awaitingReceipt = receipt
    state.awaitingFingerprint = fingerprint(content)
    state.awaitingContent = content
    state.retries = 0
    state.observes = 0
    state.ambiguousDispatch = typeof delivery !== 'boolean' && delivery.dispatch === 'possibly_executed'
    this.pasted(state, firstPaste)
    this.deps.onSubmitted?.(sessionId, content)
    this.armSubmitCheck(sessionId, session, state)
  }

  /**
   * The message awaiting confirmation was pasted: its bound runs from now, or from [firstPaste] for one typed again after
   * it was cleared, which stays cleared. Any other message may be cleared once of its own, but a first task, which is
   * one message until it ends, its hand-over again included.
   */
  private pasted(state: InputState, firstPaste: number | undefined): void {
    state.pastedAt = firstPaste ?? (this.deps.now ?? Date.now)()
    state.adopted = false
    if (firstPaste === undefined && !state.firstTask) state.cleared = false
  }

  private async inject(sessionId: string, session: RegisteredSession, content: string, deliveryId?: string, receipt?: MessageReceipt, firstPaste?: number): Promise<void> {
    if (this.refuseHeldMessage(sessionId, deliveryId, receipt)) return
    const state = this.state(sessionId)
    if (!deliveryId) {
      // A local submission keeps its original scheduling. Overlap removes our ability
      // to attribute a later terminal turn to the lamp; it must not block local input.
      this.finishDelivery(sessionId, state, 'unknown', 'prompt_mismatch')
      if (!receipt) return this.injectLegacy(sessionId, session, content, undefined, firstPaste)
      // A write that threw may have typed something: unknown, and thrown on as before.
      return this.injectLegacy(sessionId, session, content, receipt, firstPaste).catch((error: unknown) => {
        receipt('ambiguous')
        throw error
      })
    }
    state.deliveryId = deliveryId
    state.deliveryFingerprint = undefined
    state.dispatching = true
    state.cancelled = false
    try {
      if (!(await this.deps.validateRuntime(session))) {
        console.warn(`[inject] ${sid(sessionId)} abort · engine=${session.engine} · process not running`)
        this.finishDelivery(sessionId, state, 'rejected', 'runtime_gone_pre_paste')
        if (!deliveryId.startsWith('team:')) this.deps.onError(sessionId, 'This agent process is no longer running.')
        return
      }
      if (state.cancelled || this.states.get(sessionId) !== state) return
      if (this.deps.moveGate?.refused(session.agentId)) { this.finishDelivery(sessionId, state, 'rejected', 'held'); receipt?.('held'); return }
      // Before the team's own check of the pane, which a reader not yet up cannot read either.
      const waitingForEngine = this.engineReady(sessionId, session, deliveryId.startsWith('team:'))
      if (waitingForEngine) {
        await waitingForEngine
        if (state.cancelled || this.states.get(sessionId) !== state) return
        if (!(await this.deps.validateRuntime(session))) {
          console.warn(`[inject] ${sid(sessionId)} abort · engine=${session.engine} · process not running`)
          this.finishDelivery(sessionId, state, 'rejected', 'runtime_gone_pre_paste')
          if (!deliveryId.startsWith('team:')) this.deps.onError(sessionId, 'This agent process is no longer running.')
          return
        }
      }
      if (state.cancelled || this.states.get(sessionId) !== state) return
      if (deliveryId.startsWith('team:')) {
        const held = this.deps.beforeTeamWrite ? await this.deps.beforeTeamWrite(session, deliveryId) : 'team_waiting_unavailable'
        if (state.cancelled || this.states.get(sessionId) !== state) return
        if (held) { this.finishDelivery(sessionId, state, 'rejected', held); return }
      }
      if (session.engine === 'cursor' && !deliveryId.startsWith('team:')) {
        if (this.deps.moveGate?.refused(session.agentId)) { this.finishDelivery(sessionId, state, 'rejected', 'held'); receipt?.('held'); return }
        // Cursor leaves the previous prompt sitting in its composer after the turn completes — the text is
        // still on the "→" line long after the answer and its recap have arrived. sendToTmux() types into
        // whatever is already there, so the next message is APPENDED to the last one and the pair is
        // submitted as a single run-on prompt:
        //   "…đầu tư dài hạn" + "Có nên mua thêm eth không…"
        // The agent then answers a question nobody asked, and the device shows a recap for it.
        //
        // The adapter already NOTICED this — onTurnStarted logs "observed a different terminal prompt while
        // awaiting submit" when the fingerprint of the started turn does not match what we sent — but it
        // only warned and carried on. Clear the line first so the composer is ours alone.
        //
        // C-u (kill-to-start-of-line) is a no-op on an empty composer, so this costs nothing in the normal
        // case. It does discard a draft a human was typing in the terminal — but pasting into that draft
        // would corrupt it into a run-on prompt anyway, which is worse and harder to notice.
        await this.deps.sendKey(session.agentId, 'C-u')
      }
      if (state.cancelled || this.states.get(sessionId) !== state) return
      state.writing = true
      const delivery = await this.injectWhenLeased(state, () => (deliveryId.startsWith('team:') && this.deps.injectTeam
        ? this.deps.injectTeam(session.agentId, content, deliveryId) : this.deps.inject(session.agentId, content)),
      () => !state.cancelled && this.states.get(sessionId) === state, () => this.deps.moveGate?.refused(session.agentId) === true, firstPaste)
      state.writing = false
      if (state.cancelled || this.states.get(sessionId) !== state) return
      if (gaveWay(delivery)) {
        // Still on its way, said so already: it is no longer the delivery the pane is typing.
        state.deliveryId = undefined
        this.putBack(state, { content, deliveryId, receipt, firstPaste })
        return
      }
      if (typeof delivery !== 'boolean' && delivery.state === 'failed' && delivery.dispatch === 'not_started' && delivery.reason === 'held') {
        this.finishDelivery(sessionId, state, 'rejected', 'held'); receipt?.('held'); return
      }
      if (typeof delivery !== 'boolean' && delivery.state === 'failed' && delivery.dispatch === 'not_started' && delivery.reason.startsWith('team_waiting_')) {
        this.finishDelivery(sessionId, state, 'rejected', delivery.reason)
        return
      }
      const withheld = enterWithheldReason(delivery)
      if (withheld) {
        // Typed, its Enter not pressed: never pressed later either, which would send it into whatever is open.
        console.warn(`[inject] ${sid(sessionId)} typed, not sent · engine=${session.engine} · ${withheld} opened before Enter`)
        this.finishDelivery(sessionId, state, 'rejected', 'enter_withheld')
        if (!deliveryId.startsWith('team:')) this.deps.onError(sessionId, messageWithheldText(session.engine, withheld))
        return
      }
      const held = heldBack(delivery)
      if (held) {
        console.warn(`[inject] ${sid(sessionId)} not typed · engine=${session.engine} · ${held}`)
        this.finishDelivery(sessionId, state, 'rejected', held)
        // An Agent Messages turn is automatic, and its mailbox hears of the refusal; anyone else's is a person's to see.
        if (!deliveryId.startsWith('team:')) this.deps.onError(sessionId, messageHoldText(session.engine, held))
        return
      }
      if (paneNotReady(delivery)) {
        this.finishDelivery(sessionId, state, 'rejected', 'not_submitted')
        this.paneNeverReady(sessionId, session)
        return
      }
      const accepted = typeof delivery === 'boolean'
        ? delivery
        : delivery.state === 'succeeded' || delivery.dispatch === 'possibly_executed'
      if (!accepted) {
        console.warn(`[inject] ${sid(sessionId)} paste failed · engine=${session.engine} · target=${session.agentId}`)
        this.finishDelivery(sessionId, state, 'rejected', 'paste_failed')
        this.deps.onError(sessionId, 'The message could not be delivered to the agent.')
        return
      }
      console.log(`[inject] ${sid(sessionId)} paste ok · engine=${session.engine} · target=${session.agentId} · len=${content.length}`)
      state.awaitingFingerprint = fingerprint(content)
      state.deliveryFingerprint = state.awaitingFingerprint
      state.awaitingContent = content
      state.retries = 0
      state.observes = 0
      state.ambiguousDispatch = typeof delivery !== 'boolean' && delivery.dispatch === 'possibly_executed'
      this.pasted(state, firstPaste)
      state.dispatching = false
      this.delivery(sessionId, state.deliveryId, 'delivered')
      if (state.observedStart !== undefined) {
        const observed = state.observedStart
        state.observedStart = undefined
        this.onTurnStarted(sessionId, observed)
      }
      this.deps.onSubmitted?.(sessionId, content)
      this.armSubmitCheck(sessionId, session, state)
    } catch {
      this.finishDelivery(sessionId, state, state.writing || state.awaitingFingerprint ? 'unknown' : 'rejected', state.writing || state.awaitingFingerprint ? 'dispatch_ambiguous' : 'runtime_gone_pre_paste')
      this.deps.onError(sessionId, 'The message delivery could not be confirmed. Check the agent before trying again.')
    } finally {
      state.writing = false
      state.dispatching = false
      if (!state.awaitingFingerprint && !state.turnOpen) this.drainOne(sessionId, state)
    }
  }

  private armSubmitCheck(sessionId: string, session: RegisteredSession, state: InputState): void {
    if (state.timer) clearTimeout(state.timer)
    state.timer = setTimeout(() => {
      state.timer = null
      if (!state.awaitingFingerprint || state.turnOpen) return
      const retry = this.retrySubmit(sessionId, session, state)
      if (state.deliveryId) void retry.catch(() => this.failAmbiguousSubmission(sessionId, state))
      else void retry
    }, this.deps.submission.policy(session.engine)?.verifyMs ?? (session.engine === 'opencode'
        ? OPENCODE_SUBMIT_VERIFY_MS
        : session.engine === 'pi'
          ? PI_SUBMIT_VERIFY_MS
          : session.engine === 'hermes'
            ? HERMES_SUBMIT_VERIFY_MS
            : session.engine === 'commandcode'
              ? COMMANDCODE_SUBMIT_VERIFY_MS
              : session.engine === 'devin'
                ? DEVIN_SUBMIT_VERIFY_MS
                : session.engine === 'muse'
                  ? MUSE_SUBMIT_VERIFY_MS
                  : session.engine === 'amp'
                    ? AMP_SUBMIT_VERIFY_MS
                    : session.engine === 'kilo'
                      ? KILO_SUBMIT_VERIFY_MS
                      : session.engine === 'grok'
                        ? GROK_SUBMIT_VERIFY_MS
                        : session.engine === 'agy'
                          ? AGY_SUBMIT_VERIFY_MS
                          : session.engine === 'copilot'
                            ? COPILOT_SUBMIT_VERIFY_MS
                            : session.engine === 'openclaw'
                              ? OPENCLAW_SUBMIT_VERIFY_MS
                      : SUBMIT_VERIFY_MS))
  }

  private async retrySubmit(sessionId: string, session: RegisteredSession, state: InputState): Promise<void> {
    if (state.turnOpen && !state.deliveryId) return
    if (state.deliveryId?.startsWith('team:')) {
      // Team traffic is automatic. A missing transcript start is not permission to press Enter
      // again: the message may already be in the engine's queue. Inbox/reply correlation can
      // still finish the exchange even when the terminal receipt remains uncertain.
      if (++state.observes <= SUBMIT_MAX_OBSERVES) this.armSubmitCheck(sessionId, session, state)
      else this.failAmbiguousSubmission(sessionId, state)
      return
    }
    if (session.engine === 'cursor') {
      const capture = await this.deps.capture?.(session.agentId)
      if (!state.awaitingFingerprint || state.turnOpen) return
      if (await this.dialogOverComposer(sessionId, session, state, capture)) return
      const draftPending = !!capture && cursorComposerContains(capture, state.awaitingContent ?? '')
      if (state.ambiguousDispatch && !draftPending) {
        this.failAmbiguousSubmission(sessionId, state)
        return
      }
      if (capture && cursorSubmissionAccepted(capture, state.awaitingContent ?? '')) {
        if (state.deliveryId && ++state.observes > SUBMIT_MAX_OBSERVES) {
          this.failAmbiguousSubmission(sessionId, state)
          return
        }
        // The transcript hook can trail the TUI by a moment. Observe again without pressing Enter:
        // another Enter here would duplicate a running/queued follow-up.
        this.armSubmitCheck(sessionId, session, state)
        return
      }
      if (!draftPending) {
        console.warn(`[inject] ${sid(sessionId)} not accepted · engine=cursor · composer clear of draft`)
        state.awaitingFingerprint = null
        state.awaitingContent = null
        this.settle(state, 'not_submitted')
        this.finishDelivery(sessionId, state, 'unknown', 'not_submitted')
        this.deps.onError(sessionId, 'The agent did not accept the message. Please try again.')
        return
      }
    } else if (session.engine === 'openclaw') {
      await this.retryOpenclaw(sessionId, session, state)
      return
    } else if (session.engine === 'opencode' || session.engine === 'kilo' || session.engine === 'pi' || session.engine === 'hermes' || session.engine === 'muse'
      || session.engine === 'amp' || session.engine === 'grok' || session.engine === 'agy' || session.engine === 'copilot') {
      // OpenCode has no composer glyph, and the submitted text stays visible in the message area, so a
      // pane scrape can't tell "still in the composer" from "already sent". Rely purely on the reader-
      // derived turn_started (a new user row in opencode.db) to clear awaitingFingerprint; if it hasn't
      // arrived yet, fall through to a bounded retry-Enter, then error.
      if (!state.awaitingFingerprint || state.turnOpen) return
      if (state.ambiguousDispatch) {
        this.failAmbiguousSubmission(sessionId, state)
        return
      }
    } else {
      // Claude Code and Codex (their worker reads the pane) and Command Code: verify against the terminal
      // before pressing Enter again or declaring failure.
      const capture = await this.deps.capture?.(session.agentId)
      if (!state.awaitingFingerprint || state.turnOpen) return
      if (await this.dialogOverComposer(sessionId, session, state, capture)) return
      // Command Code writes the user line to its transcript only once the model has finished THINKING, so
      // the turn_started this used to wait for can be half a minute late on a real task — and the user
      // watched the terminal accept the message and start working while the device claimed it had been
      // refused. The pane says so immediately: a running turn shows "esc to interrupt". Treat that as the
      // acceptance it is, rather than timing out into an error the user can see is false.
      if (capture && session.engine === 'commandcode' && /esc to interrupt/i.test(visibleTerminal(capture))) {
        console.log(`[inject] ${sid(sessionId)} accepted (agent working) · engine=commandcode`)
        // Keep the optional delivery fingerprint for the real transcript start.
        // Visible work confirms acceptance; it must not be timed out as a failed submit.
        state.awaitingFingerprint = null
        state.awaitingContent = null
        state.observes = 0
        state.ambiguousDispatch = false
        this.settle(state, 'taken')
        return
      }
      if (capture) {
        // The engine's own reading for Claude Code and Codex, from their worker; the core's for the others.
        const prompt = state.awaitingContent ?? ''
        const reading = this.deps.submission.policy(session.engine)
          ? await this.deps.submission.read(this.readingSession(session), capture, prompt).catch(() => null)
          : { draft: composerHolds(capture, prompt), composer: composerShown(capture) }
        if (this.states.get(sessionId) !== state || !state.awaitingFingerprint || state.turnOpen) return
        // No reading is no evidence (the engine's worker down, or the agent rebound while it read): never
        // an Enter on it, and never a claim the message was or was not taken, as for an unreadable screen.
        if (!reading) {
          this.failAmbiguousSubmission(sessionId, state)
          return
        }
        if (!reading.draft) {
          this.leftComposer(sessionId, session, state, reading.composer)
          return
        }
      }
      // capture === null (dep missing / unreadable) → fall through to today's blind retry/error so a
      // real delivery failure is never hidden.
      if (!capture && state.ambiguousDispatch) {
        this.failAmbiguousSubmission(sessionId, state)
        return
      }
    }
    if (state.retries >= SUBMIT_MAX_RETRIES) {
      this.notAccepted(sessionId, session, state, `gave up after ${state.retries} retries`)
      return
    }
    await this.resubmit(sessionId, session, state)
  }

  /**
   * OpenClaw's pane says what became of a message before any Enter: one it refused (Gateway not connected, history not
   * loaded, a run going) is back in its input box, and its status line says when it can send. Only the user row
   * confirms one, so a window ends here: on a pane that cannot send, waiting without counting it; on a ready one, an
   * Enter only when its box holds the message (never a second paste). One its history did not load refused is cleared
   * from the box ([clearRefused]).
   */
  private async retryOpenclaw(sessionId: string, session: RegisteredSession, state: InputState): Promise<void> {
    // A write that may have gone through is given up, but a first task's, which is never given up here: its box says
    // whether OpenClaw refused it, and an unread pane gets no Enter.
    if (state.ambiguousDispatch && !state.firstTask) {
      this.failAmbiguousSubmission(sessionId, state)
      return
    }
    const capture = await this.deps.capture?.(session.agentId)
    if (this.states.get(sessionId) !== state || !state.awaitingFingerprint || state.turnOpen) return
    const screen = capture ? readOpenclawScreen(capture) : null
    if (screen?.state === 'no-history' && !state.cleared && openclawBoxExactly(screen.box, screen.boxHidden, state.awaitingContent ?? '')
      && await this.clearRefused(sessionId, session, state)) return
    if (screen && screen.state !== 'ready') {
      if (state.firstTask || (this.deps.now ?? Date.now)() - state.pastedAt < OPENCLAW_NOT_READY_MAX_MS) this.armSubmitCheck(sessionId, session, state)
      else this.notAccepted(sessionId, session, state, `its pane could not send for ${OPENCLAW_NOT_READY_MAX_MS / 1000} s`)
      return
    }
    // A first task is never given up here: the binding pass bounds it from the agent's launch (core/agents/bind.ts).
    if (state.retries >= SUBMIT_MAX_RETRIES && !state.firstTask) {
      this.notAccepted(sessionId, session, state, `gave up after ${state.retries} retries`)
      return
    }
    // An empty box sent the message, and other text in it is the person's, which an Enter would send. With no reading,
    // the blind Enters every engine gets, and no more; none for a task an earlier daemon typed, which may not be in the box.
    if (screen ? openclawBoxHolds(screen.box, state.awaitingContent ?? '', screen.boxHidden)
      : !state.adopted && state.retries < SUBMIT_MAX_RETRIES && !state.ambiguousDispatch) {
      await this.resubmit(sessionId, session, state)
      return
    }
    state.retries++
    this.armSubmitCheck(sessionId, session, state)
  }

  /**
   * A message OpenClaw refused into its box while its history did not load was never sent: OpenClaw sends nothing until
   * a load works, and the binding pass types `/session`, which loads it again, only into an empty box. So a box that
   * shows exactly the message, whole, is cleared, once a message: Ctrl+U `openclawClearKeys` times (never Ctrl+C, on which
   * OpenClaw exits while disconnected), then the box is read again, and anything left there (the person typed meanwhile)
   * stops it. Emptied, a message waits untyped as any message does while the pane cannot send, its bound still from its
   * first paste, and is typed again from the empty box: its one send. A first task is cleared its own way
   * ([clearFirstTask]). Whether the paste is awaited no more; false only while it still is.
   */
  private async clearRefused(sessionId: string, session: RegisteredSession, state: InputState): Promise<boolean> {
    const content = state.awaitingContent ?? ''
    const keys = openclawClearKeys(content)
    if (keys === null) return false
    if (state.firstTask) return this.clearFirstTask(sessionId, session, state, content, keys)
    state.cleared = true
    const left = await this.pressClear(sessionId, session, state, keys)
    if (!this.awaited(sessionId, state)) return true
    if (left !== '') return false
    const { awaitingReceipt, deliveryId, pastedAt } = state
    state.awaitingFingerprint = null
    state.awaitingContent = null
    state.ambiguousDispatch = false
    state.awaitingReceipt = undefined
    state.deliveryId = undefined
    state.deliveryFingerprint = undefined
    // Typed again as a drained message is: through the move gate, so never into a pane being replaced.
    this.putBack(state, { content, deliveryId, receipt: awaitingReceipt, firstPaste: pastedAt })
    this.drainOne(sessionId, state)
    return true
  }

  /**
   * [clearRefused] for the first task (decision 7). Its row says waiting untyped before the first key, so a daemon that
   * stops meanwhile types it again only into an empty box; a row that did not take it back is asked again at the next
   * window. Then the box is read again, and pressed only while it still shows exactly the task: the person may have typed
   * while the row was written. Emptied, its wait here ends, and the binding pass types it from its row, ahead of the
   * messages sent after it ([heldBehindFirstTask]). Anything else (the box changed, a key refused, a box not read, a turn
   * meanwhile) and the row says typed again, as the box does ([keepFirstTaskTyped]).
   */
  private async clearFirstTask(sessionId: string, session: RegisteredSession, state: InputState, content: string, keys: number): Promise<boolean> {
    const row = state.firstTaskRow ?? content
    if (!await this.untypeFirstTask(sessionId, session.agentId, row)) return !this.awaited(sessionId, state)
    const capture = this.awaited(sessionId, state) ? await this.deps.capture?.(session.agentId).catch(() => null) : null
    const screen = capture ? readOpenclawScreen(capture) : null
    if (this.awaited(sessionId, state) && screen?.state === 'no-history' && openclawBoxExactly(screen.box, screen.boxHidden, content)) {
      state.cleared = true
      if (await this.pressClear(sessionId, session, state, keys) === '' && this.awaited(sessionId, state)) {
        state.awaitingFingerprint = null
        state.awaitingContent = null
        state.ambiguousDispatch = false
        state.firstTaskAhead = true
        return true
      }
    }
    return this.keepFirstTaskTyped(sessionId, session.agentId, state, row, content)
  }

  /** The first task's row moved back from typed to waiting untyped (`untypeFirstTask`): whether that is saved. */
  private async untypeFirstTask(sessionId: string, agentId: string, row: string): Promise<boolean> {
    const untype = this.deps.untypeFirstTask
    if (!untype) return false
    const untyped = await untype(agentId, row).catch((error: unknown) => {
      console.warn(`[inject] ${sid(sessionId)} openclaw · first task not taken back · ${errorKind(error)}`)
      return null
    })
    if (untyped === false) console.warn(`[inject] ${sid(sessionId)} openclaw · first task not taken back · its row does not hold it typed`)
    return untyped === true
  }

  /**
   * A first task's clear that did not end in an empty box: its row, which says waiting untyped, says typed again, as the
   * box does, so nothing types it a second time from there. Still the first task, it is awaited as before (an Enter only
   * on a box that holds it); taken by its turn or stopped meanwhile, its row lets it go. A row that cannot say typed again
   * is left as it says: the task is typed from there only into an empty box, and gets no key from here; one taken or
   * stopped is then let go at its hand-over. Whether the paste is awaited no more.
   */
  private async keepFirstTaskTyped(sessionId: string, agentId: string, state: InputState, row: string, content: string): Promise<boolean> {
    if (this.states.get(sessionId) !== state) return true
    const retyped = await this.deps.retypeFirstTask?.(agentId, row).catch((error: unknown) => {
      console.warn(`[inject] ${sid(sessionId)} openclaw · first task not typed again on its row · ${errorKind(error)}`)
      return false
    }) === true
    if (this.states.get(sessionId) !== state) return true
    if (!state.firstTask) {
      if (retyped) this.deps.onFirstTaskTaken?.(sessionId)
      else state.firstTaskDropped = true
      return true
    }
    if (!retyped) {
      state.awaitingFingerprint = null
      state.awaitingContent = null
      state.ambiguousDispatch = false
      state.firstTaskAhead = true
      return true
    }
    state.awaitingFingerprint = fingerprint(content)
    state.awaitingContent = content
    return false
  }

  /** Presses Ctrl+U [keys] times into the box, then reads what is left there: null when it is not read, or the message is
   *  no longer awaited. A key refused presses no more. */
  private async pressClear(sessionId: string, session: RegisteredSession, state: InputState, keys: number): Promise<string | null> {
    let pressed = 0
    state.clearing = true
    try {
      for (; pressed < keys; pressed++) {
        const key = await this.deps.sendKey(session.agentId, 'C-u').catch(() => false)
        if (!this.awaited(sessionId, state)) return null
        if (typeof key === 'boolean' ? !key : key.state !== 'succeeded') break
      }
      const capture = await this.deps.capture?.(session.agentId).catch(() => null)
      if (!this.awaited(sessionId, state)) return null
      const left = capture ? readOpenclawScreen(capture).box : null
      if (left === '') console.log(`[inject] ${sid(sessionId)} openclaw · refused message cleared · ${pressed} keys`)
      else console.warn(`[inject] ${sid(sessionId)} openclaw · refused message not cleared · ${pressed} keys, its box ${left === null ? 'not read' : 'not empty'}`)
      return left
    } finally {
      state.clearing = false
    }
  }

  /** Whether the message pasted into [sessionId]'s pane is still awaited: no turn has settled it, and the agent is there. */
  private awaited(sessionId: string, state: InputState): boolean {
    return this.states.get(sessionId) === state && !!state.awaitingFingerprint && !state.turnOpen
  }

  /**
   * Whether what [id]'s OpenClaw box shows is Harness's: a write or a command of its own is being typed into the pane (a
   * message waiting untyped for the pane to be able to send is not), the box is being cleared, or it shows the message
   * awaiting confirmation. On a pane that can send ([pane] `ready`), that is what the message's Enter would send
   * ([retryOpenclaw]), a long one scrolled in its box included; on any other, the message exactly, whole, as only that
   * is ever cleared (decision 1). Any other text is the person's, which Harness never clears.
   */
  ownsBox(id: string, box: string | null, hidden: OpenclawBoxHidden, pane?: OpenclawScreen['state']): boolean {
    const state = this.states.get(id)
    if (!state) return false
    if (state.controlLocked || state.clearing || (state.writes !== undefined && !waitingUntyped(state))) return true
    if (state.awaitingContent === null) return false
    return pane === 'ready' ? openclawBoxHolds(box, state.awaitingContent, hidden) : openclawBoxExactly(box, hidden, state.awaitingContent)
  }

  /** The message awaiting confirmation is given up, [why]: the person is told the agent did not accept it. */
  private notAccepted(sessionId: string, session: RegisteredSession, state: InputState, why: string): void {
    console.warn(`[inject] ${sid(sessionId)} not accepted · engine=${session.engine} · ${why}`)
    state.awaitingFingerprint = null
    state.awaitingContent = null
    state.ambiguousDispatch = false
    this.settle(state, 'not_submitted')
    this.finishDelivery(sessionId, state, 'unknown', 'not_submitted')
    this.deps.onError(sessionId, 'The agent did not accept the message. Please try again.')
  }

  /** A message its OpenClaw pane could not send for OPENCLAW_NOT_READY_MAX_MS, typed nowhere: the person is told the
   *  agent did not take it. */
  private paneNeverReady(sessionId: string, session: RegisteredSession): void {
    console.warn(`[inject] ${sid(sessionId)} not typed · engine=${session.engine} · its pane could not send for ${OPENCLAW_NOT_READY_MAX_MS / 1000} s`)
    this.deps.onError(sessionId, 'The agent did not accept the message. Please try again.')
  }

  /** One retry of the message awaiting confirmation: its submit key, pressed again. */
  private async resubmit(sessionId: string, session: RegisteredSession, state: InputState): Promise<void> {
    state.retries++
    const valid = await this.deps.validateRuntime(session)
    // Each wait may outlast the message: the agent forgotten, or its turn started, meanwhile. A key pressed then would
    // land in a pane no message of this agent awaits.
    if (this.states.get(sessionId) !== state || !state.awaitingFingerprint || state.turnOpen) return
    if (!valid) {
      this.finishDelivery(sessionId, state, 'unknown', 'runtime_gone_post_paste')
      this.settle(state, 'runtime_gone')
      state.awaitingFingerprint = null
      state.awaitingContent = null
      state.ambiguousDispatch = false
      this.deps.onError(sessionId, 'This agent process is no longer running.')
      return
    }
    // Said once the engine is known to be there: an engine that exited gets no Enter, and the log used
    // to claim one anyway.
    console.log(`[inject] ${sid(sessionId)} resubmit Enter · engine=${session.engine} · retry=${state.retries}/${SUBMIT_MAX_RETRIES}`)
    // Only the submit key is retried. The prompt body is never pasted twice.
    const delivery = await this.deps.sendKey(session.agentId, 'Enter')
    if (this.states.get(sessionId) !== state || !state.awaitingFingerprint || state.turnOpen) return
    state.ambiguousDispatch = typeof delivery === 'boolean'
      ? !delivery
      : delivery.dispatch === 'possibly_executed'
    this.armSubmitCheck(sessionId, session, state)
  }

  /**
   * Our text left the composer: submitted, or queued by the TUI as a follow-up while busy. A real
   * turn_started will confirm and clear this; keep observing (bounded) WITHOUT pressing Enter — a second
   * Enter could double-submit a queued follow-up — and WITHOUT a spurious error.
   */
  private leftComposer(sessionId: string, session: RegisteredSession, state: InputState, composer: boolean): void {
    if (state.observes < SUBMIT_MAX_OBSERVES) {
      state.observes++
      console.log(`[inject] ${sid(sessionId)} accepted (queued/submitted) · engine=${session.engine} · observe=${state.observes}/${SUBMIT_MAX_OBSERVES}`)
      this.armSubmitCheck(sessionId, session, state)
      return
    }
    // An ambiguous dispatch with no visible draft still may have run. It can never justify Enter.
    if (state.ambiguousDispatch) {
      this.failAmbiguousSubmission(sessionId, state)
      return
    }
    if (state.deliveryId || !composer) {
      // A receipt promises a correlated turn, which the pane alone cannot prove. Report unknown,
      // also when no composer is visible. Never retry Enter into a dialog or a new human draft.
      this.failAmbiguousSubmission(sessionId, state)
      return
    }
    // The paste succeeded and our text left the composer. Stop polling without claiming that the
    // agent started or failed. Its real turn event can arrive much later; pressing Enter again can
    // submit somebody else's draft. This was the false "Claude didn't start" on a queued voice turn.
    console.log(`[inject] ${sid(sessionId)} submit left composer; awaiting agent turn · engine=${session.engine}`)
    state.awaitingFingerprint = null
    state.awaitingContent = null
    state.observes = 0
    this.settle(state, 'taken')
  }

  /**
   * A dialog, a menu or a view over the composer, settled without an Enter. The prompt line the retry
   * reads is then the transcript's echo of this very message, not a draft, and an Enter answers the
   * dialog: on a permission prompt, "1. Yes", a command nobody approved. A prompt or a question the
   * agent asks means the message was taken and its turn has reached a tool; anything else leaves it
   * unknown, as does any delivery with a receipt, which the pane alone cannot settle.
   */
  private async dialogOverComposer(sessionId: string, session: RegisteredSession, state: InputState, capture: string | null | undefined): Promise<boolean> {
    if (capture === undefined) return false
    const screen = await this.deps.readScreen(this.readingSession(session), capture)
    if (this.states.get(sessionId) !== state || state.turnOpen || !state.awaitingFingerprint) return true
    const hold = screen ? screen.messageHold : 'screen_unreadable'
    if (!hold) return false
    if (state.deliveryId || (hold !== 'permission_open' && hold !== 'question_open')) {
      this.failAmbiguousSubmission(sessionId, state)
      return true
    }
    console.log(`[inject] ${sid(sessionId)} accepted (${hold} on screen) · engine=${session.engine}`)
    state.awaitingFingerprint = null
    state.awaitingContent = null
    state.observes = 0
    state.ambiguousDispatch = false
    this.settle(state, 'taken')
    return true
  }

  private failAmbiguousSubmission(sessionId: string, state: InputState): void {
    this.finishDelivery(sessionId, state, 'unknown', 'dispatch_ambiguous')
    this.settle(state, 'ambiguous')
    state.awaitingFingerprint = null
    state.awaitingContent = null
    state.ambiguousDispatch = false
    this.deps.onError(sessionId, 'The message delivery could not be confirmed. Check the agent before trying again.')
  }

  private drainOne(sessionId: string, state: InputState): void {
    if (this.states.get(sessionId) !== state) return
    // A queued message whose turn is due while the agent changes host goes behind what the gate holds.
    const agentId = this.controlSession(sessionId)?.agentId
    const gate = this.deps.moveGate
    if (agentId && gate?.holding(agentId)) {
      gate.enqueue(agentId, () => this.drainNow(sessionId, state),
        () => { if (this.states.get(sessionId) === state) this.rejectHeldQueue(sessionId, state) })
      return
    }
    void this.drainNow(sessionId, state)
  }

  private async drainNow(sessionId: string, state: InputState): Promise<void> {
    if (this.states.get(sessionId) !== state) return
    const agentId = this.controlSession(sessionId)?.agentId
    if (agentId && this.deps.moveGate?.refused(agentId)) { this.rejectHeldQueue(sessionId, state); return }
    this.dropExpired(sessionId, state)
    if (state.controlLocked || state.cancelling || state.turnOpen || state.settling || state.awaitingFingerprint || heldBehindFirstTask(state)) return
    if (state.queue[0]?.deliveryId && (state.dispatching || state.deliveryId)) return
    const next = state.queue.shift()
    if (!next) return
    const session = this.controlSession(sessionId)
    if (!session) {
      this.delivery(sessionId, next.deliveryId, 'rejected', 'agent_gone')
      next.receipt?.('agent_gone')
      if (!next.deliveryId?.startsWith('team:')) this.deps.onError(sessionId, 'This harness is no longer available.')
      return
    }
    // A drained delivery must own the same write chain as a new person's message, through paste and Enter.
    await this.scheduleWrite(sessionId, next.content, next.deliveryId, next.receipt, next.firstPaste, next.first)
  }

  /**
   * A message that was on its way goes back to the head of the queue, behind only a first task waiting there: it was
   * cleared from its box ([clearRefused]) or gave way to the first task ([GAVE_WAY]). It was said to be on its way
   * already, and its bound runs from [item.firstPaste] when it was typed before.
   */
  private putBack(state: InputState, item: { content: string; deliveryId?: string; receipt?: MessageReceipt; firstPaste?: number }): void {
    const queued: QueuedInput = { ...item, bytes: Buffer.byteLength(item.content, 'utf8'), expiresAt: Date.now() + ITEM_TTL_MS }
    state.queue.splice(state.queue[0]?.first ? 1 : 0, 0, queued)
  }

  private enqueue(sessionId: string, state: InputState, content: string, deliveryId?: string, receipt?: MessageReceipt): void {
    const bytes = Buffer.byteLength(content, 'utf8')
    if (this.refusedFull(sessionId, state, bytes, deliveryId, receipt)) return
    state.queue.push({ content, bytes, expiresAt: Date.now() + ITEM_TTL_MS, deliveryId, ...(receipt ? { receipt } : {}) })
    this.delivery(sessionId, deliveryId, 'queued')
  }

  /** A failed move refuses pending messages without deleting an in-flight turn or issuing Ctrl-C. */
  refuse(agentId: string): void {
    const row = this.controlSession(agentId)
    for (const key of new Set([agentId, row?.sessionId].filter((id): id is string => !!id))) {
      const state = this.states.get(key)
      if (state) this.rejectHeldQueue(key, state)
    }
  }

  private rejectHeldQueue(sessionId: string, state: InputState): void {
    for (const item of state.queue.splice(0)) this.rejectHeldMessage(sessionId, item.deliveryId, item.receipt)
  }

  private rejectHeldMessage(sessionId: string, deliveryId?: string, receipt?: MessageReceipt): void {
    this.delivery(sessionId, deliveryId, 'rejected', 'held')
    receipt?.('held')
    if (!deliveryId?.startsWith('team:')) this.deps.onError(sessionId, 'This harness is held until the daemon restarts.')
  }

  private refuseHeldMessage(sessionId: string, deliveryId?: string, receipt?: MessageReceipt): boolean {
    const agentId = this.controlSession(sessionId)?.agentId
    if (!agentId || !this.deps.moveGate?.refused(agentId)) return false
    this.rejectHeldMessage(sessionId, deliveryId, receipt)
    return true
  }

  /** Refuse a message of [bytes] when the agent's queued and held messages are at their limits. */
  private refusedFull(sessionId: string, state: InputState, bytes: number, deliveryId?: string, receipt?: MessageReceipt): boolean {
    let waitingBytes = bytes
    for (const item of state.queue) waitingBytes += item.bytes
    for (const item of state.held) waitingBytes += item.bytes
    if (state.queue.length + state.held.length < MAX_QUEUE_ITEMS && waitingBytes <= MAX_QUEUE_BYTES) return false
    this.delivery(sessionId, deliveryId, 'rejected', 'queue_full')
    receipt?.('queue_full')
    if (!deliveryId?.startsWith('team:')) this.deps.onError(sessionId, 'This agent already has too many queued messages. Try again after the current operation finishes.')
    return true
  }

  private dropExpired(sessionId: string, state: InputState): void {
    const now = Date.now()
    const expiredLocalInput = state.queue.some(item => item.expiresAt <= now && !item.deliveryId?.startsWith('team:'))
    for (const item of state.queue) {
      if (item.expiresAt > now) continue
      this.delivery(sessionId, item.deliveryId, 'rejected', 'queue_expired')
      item.receipt?.('queue_expired')
    }
    state.queue = state.queue.filter((item) => item.expiresAt > now)
    if (expiredLocalInput) this.deps.onError(sessionId, 'A queued message expired before the agent became available.')
  }
}

function cursorComposerContains(capture: string, content: string): boolean {
  const visible = visibleTerminal(capture)
  const marker = visible.lastIndexOf('→')
  if (marker < 0) return false
  const expected = normalizedTerminalText(content)
  return !!expected && normalizedTerminalText(visible.slice(marker + 1)).includes(expected)
}

function cursorSubmissionAccepted(capture: string, content: string): boolean {
  const visible = visibleTerminal(capture)
  if (/\bfollow-ups\b/i.test(visible)) return true
  if (/\b(?:Working|Running subagent|Thinking)\b/i.test(visible)) return true
  return !cursorComposerContains(visible, content)
}
