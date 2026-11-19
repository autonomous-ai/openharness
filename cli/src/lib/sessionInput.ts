import { readOpenclawScreen, openclawBoxHolds } from '../engines/openclaw/contract.js'
import type { ScreenReader } from './screenReader.js'
import type { SubmissionReader } from './submissionReader.js'
import { createHash } from 'crypto'
import { composerHolds, composerShown, normalizedTerminalText, visibleTerminal } from '../engines/kit/submission.js'
import { launchBound, captureSessionBinding } from '../core/engines/sessionBinding.js'
import type { RegisteredSession } from './registry.js'
import { errorKind, sid } from './log.js'
import { isMessageHold, messageHoldText, messageWithheldText, passingHold, type MessageHold } from './messageHolds.js'
import type { MoveGate } from './hostMove/gate.js'
import { enterWithheldReason, terminalActionNotStarted, TERMINAL_LEASE_REFUSED, type TerminalActionResult } from './terminalTypes.js'

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

/** Scheduling and correlation are independent: a correlated input may use a busy engine's composer. */
export interface SessionInputRequest {
  content: string
  when: 'composer' | 'turn'
  deliveryId?: string
  receipt?: MessageReceipt
  /** The original authenticated caller, checked after waits and immediately before effects. Never supplied over the wire. */
  current?: () => boolean
}

/** Retained by the one queue when a preflight returns it there; waiting never renews its deadline. */
interface QueuedRequest extends SessionInputRequest { expiresAt?: number }

export interface SessionInputProgress {
  agentId: string
  deliveryId?: string
  when: SessionInputRequest['when']
  phase: 'waiting_for_writer' | 'waiting_for_user' | 'waiting_for_turn' | 'dispatching' | 'written' | 'composer_available' | 'unconfirmed'
  /** The conversation and turn state bound to this dispatch, not a later registry snapshot. */
  sessionId?: string
  duringTurn?: boolean
  content?: string
  /** Core activity at actual dispatch; pairs only with this operation's concrete session. */
  activity?: { epoch: string; revision: number }
}

interface InputOperation {
  request: SessionInputRequest
  session: RegisteredSession
  duringTurn: boolean
  writing: boolean
  dispatched: boolean
  release?: () => void
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
  request?: SessionInputRequest
}

/** A pending message retains capacity until its move, cancel or earlier-write callback is consumed. */
interface HeldInput {
  deliveryId?: string
  receipt?: MessageReceipt
  bytes: number
  cancelled: boolean
}

interface InputWriter {
  held: boolean
  writing: number
  waiters: Array<() => void>
  retired: boolean
}

/** Burst profiling found discarded splice results on every consumed ticket. Preserve order without that allocation. */
function removeHeld(held: HeldInput[], item: HeldInput): void {
  const at = held.indexOf(item)
  if (at < 0) return
  for (let i = at; i < held.length - 1; i++) held[i] = held[i + 1]
  held.pop()
}

interface InputState {
  operation?: InputOperation
  userAction?: boolean
  writer?: InputWriter
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
  firstTask: string | null
  /** A message waits for its OpenClaw pane to be able to send ([OPENCLAW_NOT_READY]): nothing of it is typed. */
  paneWait: boolean
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
  onInput?: (event: SessionInputProgress) => void
  getSession: (sessionId: string) => RegisteredSession | undefined
  validateRuntime: (session: RegisteredSession) => Promise<boolean>
  /** Boolean is retained for direct controller tests and legacy embedders. Production returns dispatch evidence. */
  inject: (terminalTarget: string, content: string, current?: () => boolean) => Promise<boolean | TerminalActionResult>
  /** Host serializes the preflight and paste with other terminal writers. */
  injectTeam?: (terminalTarget: string, content: string, deliveryId: string, current?: () => boolean) => Promise<boolean | TerminalActionResult>
  /** An engine command into an empty composer, under the same authority as a message. */
  injectCommand?: (terminalTarget: string, line: string, current?: () => boolean) => Promise<boolean | TerminalActionResult>
  sendKey: (terminalTarget: string, key: string, current?: () => boolean) => Promise<boolean | TerminalActionResult>
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
  /** Stop, restart and retarget revoke a pending restored launch through this existing lifecycle revision. */
  launchRevision?: (agentId: string) => number
  /** A message waits for something before it is typed: said once, as it starts to wait. */
  onWaiting?: (sessionId: string, reason: 'engine_starting') => void
  /** An agent's `waitingFor` changed (its first message began to wait, or its last stopped): its frame is pushed again. */
  onWaitChanged?: (id: string) => void
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

function fingerprint(content: string): string {
  return createHash('sha256').update(content.replace(/\r\n/g, '\n').trim()).digest('hex')
}

/** Engine-aware prompt injection. Terminal TUIs get a bounded per-session FIFO while a turn is busy. */
export class SessionInputController {
  private states = new Map<string, InputState>()
  /** A forgotten pane stays excluded until its actual writes settle, even if its agent is recreated. */
  private retiredWriters = new Map<string, InputWriter>()
  /** The messages waiting for each agent's engine's reader to start (`engineReady`), by session. */
  private readonly waitingEngine = new Map<string, number>()

  constructor(private readonly deps: SessionInputDeps) {}

  private writer(id: string, state: InputState): InputWriter {
    return state.writer ??= this.retiredWriters.get(id) ?? { held: false, writing: 0, waiters: [], retired: false }
  }

  private releaseRetiredWriter(id: string, writer: InputWriter): void {
    if (!writer.retired || writer.held || writer.writing || writer.waiters.length) return
    if (this.retiredWriters.get(id) === writer) this.retiredWriters.delete(id)
    writer.retired = false
    // The old control release cannot wake a replacement state; actual writer settlement must do it.
    const state = this.states.get(id)
    if (state?.writer === writer && state.queue.length) this.drainOne(id, state)
  }

  /** Ordinary writes retain their concurrency, except while an atomic input owns this pane. */
  writeTerminal(id: string, operation: () => Promise<boolean | TerminalActionResult>): Promise<boolean | TerminalActionResult> {
    const state = this.state(id)
    const writer = this.writer(id, state)
    const run = async (): Promise<boolean | TerminalActionResult> => {
      // Waiting behind another input does not carry authority into a replacement input state.
      if (this.states.get(id) !== state) return terminalActionNotStarted('terminal agent is unavailable')
      writer.writing++
      try { return await operation() }
      finally {
        writer.writing--
        this.releaseRetiredWriter(id, writer)
        if (state.queue.length && this.states.get(id) === state) this.drainOne(id, state)
      }
    }
    if (!writer.held) return run()
    return new Promise((resolve, reject) => writer.waiters.push(() => { void run().then(resolve, reject) }))
  }

  /** Reserve an atomic input locally; terminal authority never leaves the input controller. */
  acquireInputWriter(id: string): (() => void) | null {
    const writer = this.writer(id, this.state(id))
    if (writer.held || writer.writing) return null
    const releaseControl = this.acquireControl(id, { forAnswer: true })
    if (!releaseControl) return null
    writer.held = true
    let released = false
    return () => {
      if (released) return
      released = true
      writer.held = false
      // Register the ordinary writes before releasing control, which can drain another input.
      for (const resume of writer.waiters.splice(0)) resume()
      releaseControl()
      this.releaseRetiredWriter(id, writer)
    }
  }

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
    return !!this.states.get(id)?.firstTask
  }

  /**
   * [id]'s first task is about to be taken off its row and submitted (core/agents/bind.ts): from now its frame reads it
   * from here ([firstTaskWaiting]), as the row no longer does once the task leaves it. Said from the paste, the agent
   * read idle with no ask between the two, about 350 ms (e2e/openclawShow.e2e.ts).
   */
  expectFirstTask(id: string, content: string): void {
    const state = this.state(id)
    if (state.firstTask) return
    state.firstTask = fingerprint(content)
    this.deps.onWaitChanged?.(id)
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
   * into in the box.
   */
  private async injectWhenLeased(
    state: InputState,
    firstTask: () => boolean,
    write: () => Promise<boolean | TerminalActionResult>,
    current: () => boolean,
    held: () => boolean,
  ): Promise<boolean | TerminalActionResult> {
    const now = this.deps.now ?? Date.now
    const sleep = this.deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
    let leaseWaitMs = 0, paneWaitMs = 0
    const refused = (): TerminalActionResult => ({ state: 'failed', dispatch: 'not_started', reason: 'held' })
    if (held()) return refused()
    if (!current()) return { state: 'failed', dispatch: 'not_started', reason: TERMINAL_LEASE_REFUSED }
    let delivery = await write()
    for (;;) {
      const notReady = paneNotReady(delivery)
      if (notReady) {
        if (!firstTask() && paneWaitMs >= OPENCLAW_NOT_READY_MAX_MS) break
      } else {
        if (!leaseRefused(delivery) || leaseWaitMs >= LEASE_WAIT_MS) break
      }
      state.paneWait = notReady
      const waitingAt = now()
      await sleep(notReady ? OPENCLAW_PANE_RETRY_MS : LEASE_RETRY_MS)
      state.paneWait = false
      if (held()) return refused()
      if (!current()) break
      if (!notReady || !state.controlLocked) delivery = await write()
      // Alternating refusal reasons pause, rather than spend or renew, each other's bounded wait.
      if (notReady) paneWaitMs += now() - waitingAt
      else leaseWaitMs += now() - waitingAt
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
        firstTask: null,
        paneWait: false,
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

  private progress(agentId: string, operation: InputOperation, phase: SessionInputProgress['phase'], content?: string): void {
    this.deps.onInput?.({ agentId, deliveryId: operation.request.deliveryId, when: operation.request.when, phase,
      sessionId: operation.session.sessionId, duringTurn: operation.duringTurn, ...(content === undefined ? {} : { content }) })
  }

  /** All callers enter here; submit remains an argument adapter for existing local embedders. */
  submitInput(sessionId: string, request: SessionInputRequest): void {
    this.submit(sessionId, request.content, request.deliveryId, request.receipt, { ...request })
  }

  setUserAction(sessionId: string, open: boolean): void {
    const state = this.state(sessionId)
    state.userAction = open
    if (!open) this.drainOne(sessionId, state)
  }

  private correlatedComposer(request: SessionInputRequest | undefined, session: RegisteredSession): boolean {
    return !!request?.deliveryId && request.when === 'composer' && this.typesWhileBusy(session.engine)
  }

  /** A queued composer held by a dialog reuses the input's existing observation timer. */
  private wakeInput(sessionId: string, state: InputState): void {
    if (state.timer || this.states.get(sessionId) !== state) return
    state.timer = setTimeout(() => { state.timer = null; state.userAction = false; this.drainOne(sessionId, state) }, SUBMIT_VERIFY_MS)
  }

  private finishDelivery(sessionId: string, state: InputState, outcome: SessionInputDelivery['state'], reason?: string): void {
    const id = state.deliveryId
    state.deliveryId = undefined
    state.deliveryFingerprint = undefined
    this.delivery(sessionId, id, outcome, reason)
  }

  /** Keep content and caller authority only while an observation or an in-flight effect needs them. */
  private clearObservation(state: InputState): void {
    state.awaitingFingerprint = null
    state.awaitingContent = null
    if (!state.dispatching && !state.operation?.release) state.operation = undefined
  }

  /** The awaited person's message is settled as [outcome]: wherever its wait for a turn ends. */
  private settle(state: InputState, outcome: MessageOutcome): void {
    const receipt = state.awaitingReceipt
    state.awaitingReceipt = undefined
    receipt?.(outcome)
  }

  /**
   * A first task waits no more: a turn took it, the person stopped it, or the agent is gone. Nothing else ends its
   * wait, a message given up included: the binding pass's bound fails the launch instead (core/agents/bind.ts), so a
   * task lost after it left its row is never read as idle with no ask. The agent's frame says so (`onWaitChanged`).
   */
  private firstTaskEnded(sessionId: string, state: InputState): void {
    if (!state.firstTask) return
    state.firstTask = null
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
  submit(sessionId: string, content: string, deliveryId?: string, receipt?: MessageReceipt, request?: SessionInputRequest): void {
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
        if (!item.cancelled && this.states.get(sessionId) === state) await this.submitNow(sessionId, content, deliveryId, said, request)
      }, () => {
        removeHeld(state.held, item)
        if (!item.cancelled && this.states.get(sessionId) === state) {
          item.cancelled = true
          this.rejectHeldMessage(sessionId, deliveryId, said)
        }
      })
      return
    }
    void this.submitNow(sessionId, content, deliveryId, said, request)
  }

  /**
   * `submit` past the move gate. Resolves once this message's write is done, or at once when it is queued
   * here or refused: the gate delivers what it held one at a time, and a keystroke held behind this message
   * must not land between its paste and its Enter.
   */
  private submitNow(sessionId: string, content: string, deliveryId?: string, said?: MessageReceipt, request?: SessionInputRequest): Promise<void> {
    if (this.refuseHeldMessage(sessionId, deliveryId, said)) return Promise.resolve()
    const session = this.controlSession(sessionId)
    if (!session) {
      said?.('agent_gone')
      this.delivery(sessionId, deliveryId, 'rejected', 'agent_gone')
      if (!deliveryId?.startsWith('team:')) this.deps.onError(sessionId, 'This harness is no longer available.')
      return Promise.resolve()
    }
    const state = this.state(sessionId)
    if (request?.current?.() === false) {
      this.delivery(sessionId, deliveryId, 'rejected', 'caller_gone')
      said?.('agent_gone')
      return Promise.resolve()
    }
    if (state.cancelling) {
      this.holdForCancel(sessionId, state, Buffer.byteLength(content, 'utf8'), deliveryId, said, 'sent',
        () => void this.submitNow(sessionId, content, deliveryId, said, request))
      return Promise.resolve()
    }
    this.dropExpired(sessionId, state)
    if (this.correlatedComposer(request, session)) {
      if (state.controlLocked || state.awaitingFingerprint || state.settling || state.queue.length || state.userAction) {
        this.enqueue(sessionId, state, content, deliveryId, said, request)
        if (state.userAction) this.wakeInput(sessionId, state)
        return Promise.resolve()
      }
      this.delivery(sessionId, deliveryId, 'queued')
      return this.inject(sessionId, session, content, deliveryId, said, request)
    }
    if (state.controlLocked
      || (deliveryId && (state.deliveryId || state.dispatching || state.awaitingFingerprint || state.turnOpen || state.settling))
      || (!this.typesWhileBusy(session.engine) && (state.turnOpen || state.awaitingFingerprint || state.settling))) {
      console.log(`[inject] ${sid(sessionId)} queued · engine=${session.engine} · depth=${state.queue.length + 1}`)
      this.enqueue(sessionId, state, content, deliveryId, said, request)
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
    return this.scheduleWrite(sessionId, content, deliveryId, said, request)
  }

  private scheduleWrite(sessionId: string, content: string, deliveryId?: string, receipt?: MessageReceipt, request?: SessionInputRequest): Promise<void> {
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
          () => void this.scheduleWrite(sessionId, content, deliveryId, receipt, request))
        return Promise.resolve()
      }
      const current = this.controlSession(sessionId)
      if (!current) {
        this.delivery(sessionId, deliveryId, 'rejected', 'agent_gone')
        receipt?.('agent_gone')
        if (!deliveryId?.startsWith('team:')) this.deps.onError(sessionId, 'This harness is no longer available.')
        return Promise.resolve()
      }
      return this.inject(sessionId, current, content, deliveryId, receipt, request)
    }
    const running = state.writes ? state.writes.then(write, write) : write()
    const clear = (): void => {
      if (state.writes === settled) {
        state.writes = undefined
        if (state.queue.length) this.drainOne(sessionId, state)
      }
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
   * settling turn, or queued messages all still refuse. Only pane recovery may pass queued messages while the
   * message ahead waits for its pane to be able to send (`paneWait`), typed nowhere yet.
   */
  acquireControl(sessionId: string, opts?: { forAnswer?: boolean; forPaneRecovery?: boolean }): (() => void) | null {
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
    const queuedTurn = state.queue.some(item => !this.correlatedComposer(item.request, session))
    if (state.controlLocked || state.cancelling || turnBlocks || state.awaitingFingerprint || state.settling
      || !(opts?.forPaneRecovery && state.paneWait) && (opts?.forAnswer ? queuedTurn : state.queue.length > 0)) return null
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
   * be able to send, and those queued behind it, are typed nowhere yet: the command is what lets the pane send them.
   * Held as a control is, so a message sent meanwhile waits for it. Whether it was typed.
   */
  async typeCommand(id: string, line: string): Promise<boolean> {
    const session = this.controlSession(id)
    const state = this.states.get(id)
    const injectCommand = this.deps.injectCommand
    if (!session || !injectCommand || (state?.writes && !state.paneWait)) return false
    const release = this.acquireControl(id, { forPaneRecovery: true })
    if (!release) return false
    const ownedState = this.states.get(id)
    const sameBinding = captureSessionBinding(session)
    const current = () => this.states.get(id) === ownedState && !!this.controlSession(id) && sameBinding(this.controlSession(id)!)
    try {
      const delivery = await this.writeTerminal(id, () => injectCommand(session.agentId, line, current))
      return current() && (typeof delivery === 'boolean' ? delivery : delivery.state === 'succeeded')
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

  /** A user row within an existing turn still confirms its exact pending input, without inventing another turn. */
  onUserMessage(sessionId: string, content: string): void {
    const state = this.states.get(sessionId)
    if (state?.awaitingFingerprint && state.awaitingFingerprint === fingerprint(content)) this.onTurnStarted(sessionId, content)
  }

  onTurnStarted(sessionId: string, userMessage: string): void {
    const state = this.state(sessionId)
    const session = this.controlSession(sessionId)
    if (state.operation?.release) {
      state.turnOpen = true
      // An older identical input can start here. Only a new reading can release this writer.
      if (!state.operation.writing) void this.verifyComposer(sessionId, state, state.operation, false)
      return
    }
    // A person's intervening turn cannot confirm the first task or discard its submission evidence.
    if (state.firstTask && state.awaitingFingerprint === state.firstTask && fingerprint(userMessage) !== state.firstTask) {
      state.turnOpen = true
      return
    }
    // An exact echo of the typed prompt needs no reading. Anything else is, for an engine whose worker
    // reads its submissions, that engine's to unwrap (Claude Code 2.1.283 records a bracketed paste inside
    // an envelope of its own), and is settled once it has; every other engine's record is compared whole.
    // Callbacks below can reenter; compute at each actual comparison, sharing only this call's hash.
    let observedFingerprint: string | undefined
    const engineReads = !!session && !!this.deps.submission.policy(session.engine)
    if (state.deliveryId && state.writing) state.observedStart = userMessage
    else if (state.deliveryId && state.deliveryFingerprint) {
      const expected = state.deliveryFingerprint
      observedFingerprint ??= fingerprint(userMessage)
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
    if (state.firstTask && fingerprint(userMessage) === state.firstTask) this.firstTaskEnded(sessionId, state)
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
      observedFingerprint ??= fingerprint(userMessage)
      if (expected !== observedFingerprint) {
        if (engineReads) void this.echoes(session, userMessage, expected).then(matched => { if (!matched) warn(); receipt?.(matched ? 'started' : 'prompt_mismatch') })
        else { warn(); receipt?.('prompt_mismatch') }
      } else receipt?.('started')
      this.clearObservation(state)
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
      await this.writeTerminal(sessionId, () => this.deps.sendKey(session.agentId, 'C-u'))
      console.log(`[inject] ${sid(sessionId)} cleared the echoed prompt from the Cursor composer`)
    } catch {
      /* best-effort cosmetics — never let this break the turn */
    }
  }

  onTurnEnded(sessionId: string): void {
    const state = this.state(sessionId)
    if (state.operation?.release) {
      state.turnOpen = false
      if (!state.operation.writing) void this.verifyComposer(sessionId, state, state.operation, false)
      return
    }
    if (state.firstTask && state.awaitingFingerprint === state.firstTask) {
      state.turnOpen = false
      const session = this.controlSession(sessionId)
      if (session) this.armSubmitCheck(sessionId, session, state)
      return
    }
    if (!state.dispatching) this.finishDelivery(sessionId, state, 'unknown', 'turn_ended_without_start')
    // Typed while a turn ran, the engine holds it as that turn's follow-up; otherwise no turn was seen for it.
    this.settle(state, state.turnOpen ? 'taken' : 'turn_ended')
    state.turnOpen = false
    this.clearObservation(state)
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
      // Before an owner was captured, an unexpected failure can be logged but cannot address an agent.
      console.warn(`[inject] ${sid(sessionId)} cancel failed · ${errorKind(error)}`)
    })
  }

  cancelConfirmed(sessionId: string, current?: () => boolean): Promise<boolean> {
    return this.interrupt(sessionId, false, current)
  }

  /**
   * A cancel's Ctrl-C and what it settles. A message sent while the key is on its way (or a write whose turn
   * to be typed comes then, or a device's control) waits, and goes on after it, once the cancel has settled
   * what it interrupted: typed before, the cancel took it for its own and settled it as cancelled, with its
   * submit check dropped, and the Ctrl-C could clear it from the composer (seen once in seven Codex Stop runs,
   * 2026-11-10: received, never typed). Held at most CANCEL_HOLD_MS: a key stuck behind another writer does not
   * hold them for good.
   */
  private async interrupt(sessionId: string, reportGone: boolean, callerCurrent: () => boolean = () => true): Promise<boolean> {
    if (!callerCurrent()) return false
    const session = this.controlSession(sessionId)
    if (!session) return false
    const state = this.state(sessionId), sameBinding = captureSessionBinding(session)
    // A runtime check or queued key may finish after this id belongs to another pane or input owner.
    const current = (): boolean => callerCurrent() && this.states.get(sessionId) === state && sameBinding(this.controlSession(sessionId))
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
      const valid = await this.deps.validateRuntime(session)
      if (!current()) return false
      if (!valid) {
        if (reportGone) this.deps.onError(sessionId, 'This agent process is no longer running.')
        return false
      }
      const result = await this.writeTerminal(sessionId, () => current()
        ? this.deps.sendKey(session.agentId, 'C-c', current) : Promise.resolve(false))
      if (!current()) return false
      this.interrupted(sessionId, state)
      return typeof result === 'boolean' ? result : result.dispatch === 'executed'
    } catch (error) {
      if (!current()) return false
      if (!reportGone) throw error
      // No extra promise continuation may put this original failure on a replacement agent.
      console.warn(`[inject] ${sid(sessionId)} cancel failed · ${errorKind(error)}`)
      this.deps.onError(sessionId, 'Stop did not reach this agent.')
      return false
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

  /** What a Ctrl-C the person asked for ends: the message typed last, and the turn. */
  private interrupted(sessionId: string, state: InputState): void {
    this.finishDelivery(sessionId, state, 'unknown', 'cancelled_after_paste')
    this.settle(state, 'cancelled')
    this.firstTaskEnded(sessionId, state)
    state.turnOpen = false
    this.clearObservation(state)
    state.ambiguousDispatch = false
    if (state.timer) clearTimeout(state.timer)
    state.timer = null
  }

  forget(sessionId: string): void {
    const state = this.states.get(sessionId)
    const operation = state?.operation
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
      const writer = state.writer
      if (writer && (writer.held || writer.writing || writer.waiters.length)) {
        writer.retired = true
        this.retiredWriters.set(sessionId, writer)
      }
    }
    this.states.delete(sessionId)
    if (operation?.release && !operation.writing) { operation.release(); operation.release = undefined }
  }

  /** Every caller takes the same runtime, reader, paste and Enter boundary. Scheduling and receipt
   * requirements choose how long its result is followed; they do not choose another terminal writer. */
  private async inject(sessionId: string, session: RegisteredSession, content: string, deliveryId?: string,
    receipt?: MessageReceipt, supplied?: QueuedRequest): Promise<void> {
    const request = supplied ?? { content, when: deliveryId ? 'turn' : 'composer', deliveryId, receipt }
    const state = this.state(sessionId)
    const atomic = !!deliveryId && request.when === 'composer' && this.typesWhileBusy(session.engine)
    const release = atomic ? this.acquireInputWriter(sessionId) : undefined
    if (atomic && !release) {
      this.enqueue(sessionId, state, content, deliveryId, receipt, request)
      return
    }
    let typed = { ...session }
    let sameBinding = captureSessionBinding(typed)
    const operation: InputOperation = { request, session: typed, duringTurn: state.turnOpen,
      writing: false, dispatched: false, ...(release ? { release } : {}) }
    const current = (): boolean => {
      const now = this.controlSession(sessionId)
      return this.states.get(sessionId) === state && !(deliveryId && state.cancelled) && request.current?.() !== false && !!now
        && (launchBound(typed, now) === now || sameBinding(now))
    }
    const gone = (): void => {
      if (deliveryId && state.cancelled) return // cancellation already published its proven refusal
      const callerGone = request.current?.() === false
      this.delivery(sessionId, deliveryId, operation.dispatched ? 'unknown' : 'rejected',
        operation.dispatched ? 'dispatch_ambiguous' : callerGone ? 'caller_gone' : 'agent_gone')
      receipt?.(operation.dispatched ? 'ambiguous' : 'agent_gone')
      if (!callerGone && this.states.get(sessionId) === state && !deliveryId?.startsWith('team:')) this.deps.onError(sessionId,
        operation.dispatched ? 'The message delivery could not be confirmed. Check the agent before trying again.' : 'This harness is no longer available.')
    }
    const refuse = (reason: string, outcome: MessageOutcome, message?: string): void => {
      this.delivery(sessionId, deliveryId, 'rejected', reason)
      receipt?.(outcome)
      if (message && !deliveryId?.startsWith('team:')) this.deps.onError(sessionId, message)
    }
    const write = <T>(run: () => Promise<T>): Promise<T | boolean | TerminalActionResult> => release
      ? run() : this.writeTerminal(sessionId, run as () => Promise<boolean | TerminalActionResult>)
    let retained = false
    if (deliveryId) {
      state.operation = operation
      state.deliveryId = deliveryId
      state.deliveryFingerprint = undefined
      state.dispatching = true
      state.cancelled = false
    }
    try {
      // Restore exposes the conversation before its engine exists. Only the same lifecycle may
      // supply its first process; a pane alone never authorizes typing into the startup shell.
      if (typed.sessionId && typed.boundAt != null && typed.launch?.state === 'starting'
        && this.deps.launchRevision) {
        const restoredRevision = this.deps.launchRevision(session.agentId)
        const token = typed.launch.nativeToken
        const sameRestore = captureSessionBinding({ ...typed, processIdentity: null, evidenceRevision: undefined })
        const now = this.deps.now ?? Date.now
        const sleep = this.deps.sleep ?? (ms => new Promise<void>(resolve => setTimeout(resolve, ms)))
        const deadline = now() + LEASE_WAIT_MS
        const personal = !deliveryId?.startsWith('team:')
        if (personal) { this.deps.onWaiting?.(sessionId, 'engine_starting'); this.countWait(sessionId, 1) }
        try {
          for (;;) {
            const row = this.controlSession(sessionId)
            if (this.states.get(sessionId) !== state || deliveryId && state.cancelled || request.current?.() === false
              || this.deps.launchRevision(session.agentId) !== restoredRevision || !row
              || !sameRestore({ ...row, processIdentity: null, evidenceRevision: undefined })
              || row.launch && row.launch.state !== 'ready'
                && (row.launch.state !== 'starting' || row.launch.nativeToken !== token)) { gone(); return }
            if (this.refuseHeldMessage(sessionId, deliveryId, receipt)) return
            if (row.processIdentity && (!row.launch || row.launch.state === 'ready')) {
              typed = { ...row }
              const committedBinding = captureSessionBinding(typed)
              sameBinding = row => this.deps.launchRevision!(session.agentId) === restoredRevision && committedBinding(row)
              operation.session = typed
              break
            }
            if (now() >= deadline) {
              console.warn('[inject] RUNTIME_START_TIMEOUT restored engine did not become ready')
              refuse('runtime_start_timeout', 'runtime_gone', 'This agent is still starting. Try again when it is ready.')
              return
            }
            await sleep(LEASE_RETRY_MS)
          }
        } finally { if (personal) this.countWait(sessionId, -1) }
      }
      if (!current()) { gone(); return }
      if (this.refuseHeldMessage(sessionId, deliveryId, receipt)) return
      const valid = await this.deps.validateRuntime(typed)
      if (!current() || state.cancelled && deliveryId) { gone(); return }
      if (!valid) {
        refuse('runtime_gone_pre_paste', 'runtime_gone', 'This agent process is no longer running.')
        return
      }
      // Cursor's old submitted text remains a draft. Personal input clears it before waiting for its
      // reader, as before; tracked input clears it after its preflight.
      if (!deliveryId && session.engine === 'cursor') {
        await write(() => this.deps.sendKey(session.agentId, 'C-u', current))
        if (!current()) { gone(); return }
      }
      const waiting = this.engineReady(sessionId, typed, deliveryId?.startsWith('team:') === true)
      if (waiting) {
        await waiting
        if (!current()) { gone(); return }
        const validAgain = await this.deps.validateRuntime(typed)
        if (!current()) { gone(); return }
        if (!validAgain) { refuse('runtime_gone_pre_paste', 'runtime_gone', 'This agent process is no longer running.'); return }
      }
      if (deliveryId?.startsWith('team:')) {
        const held = this.deps.beforeTeamWrite ? await this.deps.beforeTeamWrite(typed, deliveryId) : 'team_waiting_unavailable'
        if (!current()) { gone(); return }
        if (held) { refuse(held, 'held'); return }
      } else if (atomic) {
        const capture = await this.deps.capture?.(session.agentId)
        if (!current()) { gone(); return }
        const screen = await this.deps.readScreen(this.readingSession(typed), capture ?? null)
        if (!current()) { gone(); return }
        state.userAction = !screen || screen.messageHold !== null
        if (state.userAction) {
          this.enqueue(sessionId, state, content, deliveryId, receipt, request)
          this.progress(sessionId, operation, 'waiting_for_user')
          this.wakeInput(sessionId, state)
          return
        }
      }
      if (deliveryId && !deliveryId.startsWith('team:') && session.engine === 'cursor') {
        await write(() => this.deps.sendKey(session.agentId, 'C-u', current))
        if (!current()) { gone(); return }
      }
      const result = await this.injectWhenLeased(state, () => !!state.firstTask && state.firstTask === fingerprint(content), () => write(() => {
        if (!current()) return Promise.resolve(terminalActionNotStarted('caller_gone'))
        operation.writing = true
        operation.dispatched = true
        operation.session = { ...this.readingSession(typed) }
        operation.duringTurn = state.turnOpen
        if (deliveryId) state.writing = true
        this.progress(sessionId, operation, 'dispatching', content)
        return deliveryId?.startsWith('team:') && this.deps.injectTeam
          ? this.deps.injectTeam(session.agentId, content, deliveryId, current)
          : this.deps.inject(session.agentId, content, current)
      }) as Promise<boolean | TerminalActionResult>, current, () => this.deps.moveGate?.refused(session.agentId) === true)
      operation.writing = false
      if (deliveryId) state.writing = false
      const accepted = typeof result === 'boolean' ? result : result.state === 'succeeded' || result.dispatch === 'possibly_executed'
      if (!current()) {
        operation.dispatched = accepted
        gone()
        if (atomic && accepted && this.states.get(sessionId) === state) {
          state.awaitingFingerprint = fingerprint(content)
          state.awaitingContent = content
          state.ambiguousDispatch = true
          retained = true
          this.armSubmitCheck(sessionId, typed, state)
        }
        return
      }
      if (enterWithheldReason(result)) {
        refuse('enter_withheld', 'withheld', messageWithheldText(session.engine, enterWithheldReason(result)!))
        return
      }
      const hold = heldBack(result)
      if (hold) { refuse(hold, 'held', messageHoldText(session.engine, hold)); return }
      if (paneNotReady(result)) {
        refuse('not_submitted', 'not_submitted')
        this.paneNeverReady(sessionId, session)
        return
      }
      if (!accepted) {
        const reason = typeof result !== 'boolean' && result.state === 'failed' ? result.reason : 'paste_failed'
        refuse(reason === 'held' || reason.startsWith('team_waiting_') ? reason : 'paste_failed', reason === 'held' ? 'held' : 'paste_failed',
          reason.startsWith('team_waiting_') ? undefined : 'The message could not be delivered to the agent.')
        return
      }
      // A personal follow-up displaces prior turn correlation only once it reaches the writer.
      if (!deliveryId) this.finishDelivery(sessionId, state, 'unknown', 'prompt_mismatch')
      this.settle(state, 'taken')
      state.awaitingReceipt = receipt
      state.operation = operation
      state.awaitingFingerprint = fingerprint(content)
      state.awaitingContent = content
      state.deliveryFingerprint = deliveryId && !atomic ? state.awaitingFingerprint : undefined
      state.retries = 0
      state.observes = 0
      state.ambiguousDispatch = typeof result !== 'boolean' && result.dispatch === 'possibly_executed'
      state.pastedAt = (this.deps.now ?? Date.now)()
      state.dispatching = false
      this.progress(sessionId, operation, 'written')
      this.delivery(sessionId, deliveryId, atomic && state.ambiguousDispatch ? 'unknown' : 'delivered',
        atomic && state.ambiguousDispatch ? 'dispatch_ambiguous' : undefined)
      this.deps.onSubmitted?.(sessionId, content)
      if (atomic) {
        retained = true
        await this.verifyComposer(sessionId, state, operation, false)
      } else {
        if (state.observedStart !== undefined) {
          const observed = state.observedStart
          state.observedStart = undefined
          this.onTurnStarted(sessionId, observed)
        }
        this.armSubmitCheck(sessionId, typed, state)
      }
    } catch (error) {
      this.delivery(sessionId, deliveryId, operation.dispatched ? 'unknown' : 'rejected',
        operation.dispatched ? 'dispatch_ambiguous' : 'runtime_gone_pre_paste')
      receipt?.('ambiguous')
      if (atomic && operation.dispatched && this.states.get(sessionId) === state && state.operation === operation) {
        state.awaitingFingerprint = fingerprint(content)
        state.awaitingContent = content
        state.ambiguousDispatch = true
        retained = true
        this.armSubmitCheck(sessionId, typed, state)
      } else if (!deliveryId) throw error
      else this.deps.onError(sessionId, 'The message delivery could not be confirmed. Check the agent before trying again.')
    } finally {
      operation.writing = false
      if (deliveryId && state.operation === operation) {
        state.writing = false
        state.dispatching = false
        if (!retained && !state.awaitingFingerprint) {
          state.deliveryId = undefined
          state.operation = undefined
        }
      }
      if (!retained) release?.()
      if (!state.awaitingFingerprint && !state.turnOpen) this.drainOne(sessionId, state)
    }
  }

  private armSubmitCheck(sessionId: string, session: RegisteredSession, state: InputState): void {
    if (state.timer) clearTimeout(state.timer)
    state.timer = setTimeout(() => {
      state.timer = null
      const operation = state.operation
      if (operation?.release) {
        void this.verifyComposer(sessionId, state, operation)
        return
      }
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

  /** Correlation requires stricter evidence than personal typing: a possible write never grants an
   * Enter, and time never releases a composer whose contents remain uncertain. */
  private async verifyComposer(sessionId: string, state: InputState, operation: InputOperation, retry = true): Promise<void> {
    if (operation.writing) return
    const current = (): boolean => this.states.get(sessionId) === state && state.operation === operation
      && captureSessionBinding(this.readingSession(operation.session))(this.controlSession(sessionId))
    try {
      operation.writing = true
      const capture = await this.deps.capture?.(sessionId)
      if (!current()) return
      const reading = capture ? await this.deps.submission.read(this.readingSession(operation.session), capture, operation.request.content).catch(() => null) : null
      if (!current()) return
      if (reading?.nativeDraft === 'clear') {
        this.progress(sessionId, operation, 'composer_available')
        this.clearObservation(state)
        state.deliveryId = undefined
        state.deliveryFingerprint = undefined
        state.operation = undefined
        state.ambiguousDispatch = false
        if (state.timer) clearTimeout(state.timer)
        state.timer = null
        operation.release?.()
        operation.release = undefined
        this.drainOne(sessionId, state)
        return
      }
      if (retry && reading?.nativeDraft === 'pending' && !state.ambiguousDispatch && state.retries < SUBMIT_MAX_RETRIES
        && operation.request.current?.() !== false && !state.userAction) {
        const valid = await this.deps.validateRuntime(operation.session)
        if (!current()) return
        if (!valid) {
          this.delivery(sessionId, operation.request.deliveryId, 'unknown', 'runtime_gone_post_paste')
          this.clearObservation(state)
          state.deliveryId = undefined
          state.operation = undefined
          operation.release?.()
          operation.release = undefined
          return
        }
        const pane = await this.deps.capture?.(sessionId)
        if (!current()) return
        const screen = await this.deps.readScreen(this.readingSession(operation.session), pane ?? null)
        if (!current()) return
        if (screen && screen.messageHold === null && operation.request.current?.() !== false) {
          state.ambiguousDispatch = true
          state.retries++
          const result = await this.deps.sendKey(sessionId, 'Enter', () => current() && operation.request.current?.() !== false)
          if (!current()) return
          state.ambiguousDispatch = !(result === true || typeof result !== 'boolean' && result.dispatch === 'executed')
        }
      }
      if (++state.observes <= 7) this.armSubmitCheck(sessionId, operation.session, state)
      else {
        this.delivery(sessionId, operation.request.deliveryId, 'unknown', 'input_acceptance_unconfirmed')
        this.progress(sessionId, operation, 'unconfirmed')
      }
    } catch {
      if (!current()) return
      state.ambiguousDispatch = true
      this.delivery(sessionId, operation.request.deliveryId, 'unknown', 'dispatch_ambiguous')
      if (++state.observes <= 7) this.armSubmitCheck(sessionId, operation.session, state)
      else this.progress(sessionId, operation, 'unconfirmed')
    } finally {
      operation.writing = false
      if (this.states.get(sessionId) !== state) { operation.release?.(); operation.release = undefined }
    }
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
        this.clearObservation(state)
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
        this.clearObservation(state)
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

  private async retryOpenclaw(sessionId: string, session: RegisteredSession, state: InputState): Promise<void> {
    const firstTask = !!state.firstTask && state.firstTask === state.awaitingFingerprint
    // A write that may have gone through is given up, but a first task's, which is never given up here: its box says
    // whether OpenClaw refused it, and an unread pane gets no Enter.
    if (state.ambiguousDispatch && !firstTask) {
      this.failAmbiguousSubmission(sessionId, state)
      return
    }
    const capture = await this.deps.capture?.(session.agentId)
    if (this.states.get(sessionId) !== state || !state.awaitingFingerprint || state.turnOpen) return
    const screen = capture ? readOpenclawScreen(capture) : null
    if (screen && screen.state !== 'ready') {
      if (firstTask || (this.deps.now ?? Date.now)() - state.pastedAt < OPENCLAW_NOT_READY_MAX_MS) this.armSubmitCheck(sessionId, session, state)
      else this.notAccepted(sessionId, session, state, `its pane could not send for ${OPENCLAW_NOT_READY_MAX_MS / 1000} s`)
      return
    }
    // A first task is never given up here: the binding pass bounds it from the agent's launch (core/agents/bind.ts).
    if (state.retries >= SUBMIT_MAX_RETRIES && !firstTask) {
      this.notAccepted(sessionId, session, state, `gave up after ${state.retries} retries`)
      return
    }
    // An empty box sent the message, and other text in it is the person's, which an Enter would send. With no reading,
    // the blind Enters every engine gets, and no more.
    if (screen ? openclawBoxHolds(screen.box, state.awaitingContent ?? '', screen.boxHidden) : state.retries < SUBMIT_MAX_RETRIES && !state.ambiguousDispatch) {
      await this.resubmit(sessionId, session, state)
      return
    }
    state.retries++
    this.armSubmitCheck(sessionId, session, state)
  }

  /** The message awaiting confirmation is given up, [why]: the person is told the agent did not accept it. */
  private notAccepted(sessionId: string, session: RegisteredSession, state: InputState, why: string): void {
    console.warn(`[inject] ${sid(sessionId)} not accepted · engine=${session.engine} · ${why}`)
    this.clearObservation(state)
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
      this.clearObservation(state)
      state.ambiguousDispatch = false
      this.deps.onError(sessionId, 'This agent process is no longer running.')
      return
    }
    // Said once the engine is known to be there: an engine that exited gets no Enter, and the log used
    // to claim one anyway.
    console.log(`[inject] ${sid(sessionId)} resubmit Enter · engine=${session.engine} · retry=${state.retries}/${SUBMIT_MAX_RETRIES}`)
    // Only the submit key is retried. The prompt body is never pasted twice.
    const allowed = state.operation?.request.current
    const delivery = await this.writeTerminal(sessionId, () => allowed
      ? this.deps.sendKey(session.agentId, 'Enter', allowed) : this.deps.sendKey(session.agentId, 'Enter'))
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
    this.clearObservation(state)
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
    this.clearObservation(state)
    state.observes = 0
    state.ambiguousDispatch = false
    this.settle(state, 'taken')
    return true
  }

  private failAmbiguousSubmission(sessionId: string, state: InputState): void {
    this.finishDelivery(sessionId, state, 'unknown', 'dispatch_ambiguous')
    this.settle(state, 'ambiguous')
    this.clearObservation(state)
    state.ambiguousDispatch = false
    this.deps.onError(sessionId, 'The message delivery could not be confirmed. Check the agent before trying again.')
  }

  private drainOne(sessionId: string, state: InputState): void {
    // Lifecycle and writer releases can arrive after the last queued item is gone.
    if (this.states.get(sessionId) !== state || state.queue.length === 0) return
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
    if (this.states.get(sessionId) !== state || state.queue.length === 0) return
    const agentId = this.controlSession(sessionId)?.agentId
    if (agentId && this.deps.moveGate?.refused(agentId)) { this.rejectHeldQueue(sessionId, state); return }
    this.dropExpired(sessionId, state)
    const session = this.controlSession(sessionId)
    if (state.controlLocked || state.cancelling || state.settling || state.awaitingFingerprint || state.writes || state.writer?.writing) return
    // Deferred ordinary/whole-turn work has always preceded a reserved composer writer, even while
    // that work waits for a turn end. Immediate personal input keeps its separate admission rule.
    const ordinary = session ? state.queue.findIndex(item => !this.correlatedComposer(item.request, session)) : 0
    const at = ordinary < 0 ? 0 : ordinary
    const candidate = state.queue[at]
    if (!candidate) return
    const composer = !!session && this.correlatedComposer(candidate.request, session)
    if (composer && state.userAction) return
    if (!composer && (state.turnOpen || candidate.deliveryId && (state.dispatching || state.deliveryId))) return
    const [next] = state.queue.splice(at, 1)
    if (!session) {
      this.delivery(sessionId, next.deliveryId, 'rejected', 'agent_gone')
      next.receipt?.('agent_gone')
      if (!next.deliveryId?.startsWith('team:')) this.deps.onError(sessionId, 'This harness is no longer available.')
      return
    }
    // A drained delivery must own the same write chain as a new person's message, through paste and Enter.
    if (composer) await this.inject(sessionId, session, next.content, next.deliveryId, next.receipt, next.request)
    else await this.scheduleWrite(sessionId, next.content, next.deliveryId, next.receipt, next.request)
  }

  private enqueue(sessionId: string, state: InputState, content: string, deliveryId?: string, receipt?: MessageReceipt, request?: QueuedRequest): void {
    const bytes = Buffer.byteLength(content, 'utf8')
    if (this.refusedFull(sessionId, state, bytes, deliveryId, receipt)) return
    const expiresAt = request?.expiresAt ?? Date.now() + ITEM_TTL_MS
    if (request) request.expiresAt = expiresAt
    state.queue.push({ content, bytes, expiresAt, deliveryId, ...(receipt ? { receipt } : {}), ...(request ? { request } : {}) })
    this.delivery(sessionId, deliveryId, 'queued')
    const session = this.controlSession(sessionId)
    if (request && session) this.progress(sessionId, { request, session, duringTurn: state.turnOpen, writing: false, dispatched: false },
      state.userAction ? 'waiting_for_user' : state.turnOpen && !this.correlatedComposer(request, session) ? 'waiting_for_turn' : 'waiting_for_writer')
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
    if (state.queue.length === 0) return
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
