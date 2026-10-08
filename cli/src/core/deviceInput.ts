/**
 * The pane writer lock, and the Wi-Fi device's queued turns behind it: one writer at a time into an
 * agent's pane, whoever is writing (a device's turn, a window's message, a team's), and a device turn
 * held until the pane can take it.
 *
 * The core's, not the device's: every write the core makes into a pane takes this lock (core/input.ts),
 * so it has to be where the writes are. It lived beside the Wi-Fi device (lib/autonomous-device/input.ts)
 * until the devices moved into a process of their own (docs/design/2026-10-06-core-boundary-next.md,
 * step 9): a lock that every pane write waits on cannot sit on the far side of a process boundary.
 */
import { createHash } from 'node:crypto'
import type { RegisteredSession } from '../lib/registry.js'
import type { SessionInputDelivery } from '../lib/sessionInput.js'
import type { LiveEvent } from '../lib/normalize.js'
import { isMessageHold } from '../lib/messageHolds.js'
import { enterWithheldReason, type TerminalActionResult } from '../lib/terminalTypes.js'
import type { SubmissionReader } from '../lib/submissionReader.js'
import type { SubmissionPolicy } from '../engines/facets/submission.js'
const VERIFY_MS = 1500
const TTL_MS = 5 * 60_000
export interface DeviceInputStatus {
  sessionId: string
  deliveryId: string
  mode: 'direct' | 'steering' | 'native_queue' | 'native_input' | 'daemon_queue'
  phase: 'waiting_for_writer' | 'waiting_for_user' | 'waiting_for_turn' | 'submitted' | 'accepted' | 'unconfirmed'
}
interface Input {
  deliveryId: string
  content: string
  fingerprint: string
  expires: number
  started: boolean
  dispatched: boolean
  cancelled: boolean
  mode: DeviceInputStatus['mode']
  retry: boolean
  retries: number
  observes: number
}
interface State {
  busy: boolean
  userAction: boolean
  queue: Input[]
  pending: Input[]
  active?: Input
  writing: boolean
  release?: () => void
  timer?: NodeJS.Timeout
}
interface Writer {
  held: boolean
  legacy: number
  waiters: Array<() => void>
}
export interface DeviceInputDeps {
  getSession: (id: string) => RegisteredSession | undefined
  validateRuntime: (session: RegisteredSession) => Promise<boolean>
  inject: (id: string, text: string) => Promise<boolean | TerminalActionResult>
  sendKey: (id: string, key: string) => Promise<boolean | TerminalActionResult>
  capture: (id: string) => Promise<string | null>
  /** The engine's reading of its composer after a paste, from its worker; core decides on it. */
  submission: Pick<SubmissionReader, 'read' | 'policy'>
  isAwaitingUser?: (session: RegisteredSession) => Promise<boolean>
  acquireControl: (id: string) => (() => void) | null
  legacySubmit: (id: string, text: string, deliveryId: string) => void
  legacyCancel: (deliveryId: string) => boolean
  onDispatch?: (id: string, deliveryId: string, text: string) => void
  onDelivery: (event: SessionInputDelivery) => void
  onInputStatus: (event: DeviceInputStatus) => void
  onForget?: (id: string) => void
}
const fingerprint = (text: string) => createHash('sha256').update(text.replace(/\r\n/g, '\n').trim()).digest('hex')
/**
 * How a message typed mid-turn is taken, as the engine declares it: steering from the release it names on,
 * its own mode before that or with no release known. An engine without a policy (one retargeted after its
 * message was queued) is native input: never claimed as steering.
 */
function busyMode(policy: SubmissionPolicy | undefined, session: RegisteredSession): DeviceInputStatus['mode'] {
  const busy = policy?.busyInput ?? { mode: 'native_input' }
  const version = session.cliVersion?.match(/(\d+)\.(\d+)\.(\d+)/)
  const [major, minor] = busy.steeringSince ?? [Infinity, 0]
  return version && (Number(version[1]) > major || (Number(version[1]) === major && Number(version[2]) >= minor)) ? 'steering' : busy.mode
}
const executed = (result: boolean | TerminalActionResult) => result === true || (typeof result !== 'boolean' && result.dispatch === 'executed')
const rejected = (result: boolean | TerminalActionResult) => result === false || (typeof result !== 'boolean' && (result.dispatch === 'not_started' || result.dispatch === 'rejected'))

/** A separate route, used exclusively by Autonomous Device turn.send. */
export class AutonomousDeviceInput {
  private states = new Map<string, State>()
  private writers = new Map<string, Writer>()
  constructor(private readonly deps: DeviceInputDeps) {}
  /** The engines whose TUI takes a message typed mid-turn, which this route queues and verifies itself
   *  (Claude Code and Codex, as their submission policies declare); every other engine's goes the legacy way. */
  private native(engine: string): boolean {
    return this.deps.submission.policy(engine)?.typesWhileBusy === true
  }
  private state(id: string): State {
    let state = this.states.get(id)
    if (!state) { state = { busy: false, userAction: false, queue: [], pending: [], writing: false }; this.states.set(id, state) }
    return state
  }
  private writer(id: string): Writer {
    let writer = this.writers.get(id)
    if (!writer) { writer = { held: false, legacy: 0, waiters: [] }; this.writers.set(id, writer) }
    return writer
  }
  /** Legacy writes run unchanged unless a Device write currently owns this same pane.
   * This also covers a local validation that began before Device acquired the existing control lock.
   */
  legacyWrite<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const writer = this.writer(id)
    const run = async () => {
      writer.legacy++
      try { return await operation() }
      finally { writer.legacy-- }
    }
    if (!writer.held) return run()
    return new Promise<T>((resolve, reject) => writer.waiters.push(() => { void run().then(resolve, reject) }))
  }
  private delivery(id: string, item: Input, state: SessionInputDelivery['state'], reason?: string): void {
    this.deps.onDelivery({ sessionId: id, deliveryId: item.deliveryId, state, ...(reason ? { reason } : {}) })
  }
  private status(id: string, item: Input, phase: DeviceInputStatus['phase'], mode = item.mode): void {
    this.deps.onInputStatus({ sessionId: id, deliveryId: item.deliveryId, mode, phase })
  }
  submit(id: string, content: string, deliveryId: string): void {
    const session = this.deps.getSession(id)
    if (!session) { this.deps.onDelivery({ sessionId: id, deliveryId, state: 'rejected', reason: 'agent_gone' }); return }
    const state = this.state(id)
    if (!this.native(session.engine)) {
      this.deps.legacySubmit(id, content, deliveryId)
      this.deps.onInputStatus({ sessionId: id, deliveryId, mode: state.busy ? 'daemon_queue' : 'direct', phase: state.busy ? 'waiting_for_turn' : 'waiting_for_writer' })
      return
    }
    this.expire(id, state)
    const item: Input = { deliveryId, content, fingerprint: fingerprint(content), expires: Date.now() + TTL_MS,
      started: false, dispatched: false, cancelled: false, mode: 'direct', retry: false, retries: 0, observes: 0 }
    if (state.pending.length >= 64 || state.queue.length >= 8 || state.queue.reduce((bytes, next) => bytes + Buffer.byteLength(next.content), Buffer.byteLength(content)) > 24 * 1024) {
      this.delivery(id, item, 'rejected', 'queue_full'); return
    }
    state.queue.push(item)
    this.delivery(id, item, 'queued')
    this.status(id, item, state.userAction ? 'waiting_for_user' : 'waiting_for_writer', 'daemon_queue')
    this.pump(id, state)
  }
  private expire(id: string, state: State): void {
    state.queue = state.queue.filter(item => {
      if (item.expires > Date.now()) return true
      this.delivery(id, item, 'rejected', 'queue_expired'); return false
    })
  }
  private later(id: string, state: State, delay = VERIFY_MS): void {
    if (this.states.get(id) !== state || state.timer) return
    state.timer = setTimeout(() => {
      state.timer = undefined
      if (state.active && !state.writing) void this.verify(id, state, state.active)
      else this.pump(id, state)
    }, delay)
  }
  private pump(id: string, state: State): void {
    if (this.states.get(id) !== state || state.active) return
    this.expire(id, state)
    if (!state.queue.length || state.pending.length >= 64) return
    const session = this.deps.getSession(id)
    if (!session) { this.forget(id); return }
    const writer = this.writer(id)
    if (writer.held || writer.legacy) { this.later(id, state, 100); return }
    const release = this.deps.acquireControl(id)
    if (!release) { this.later(id, state, 100); return }
    writer.held = true
    state.release = () => {
      writer.held = false
      // Register delayed legacy writes before another Device write can acquire the pane.
      for (const resume of writer.waiters.splice(0)) resume()
      release()
    }
    const item = state.queue.shift()!
    state.active = item
    state.writing = true
    void this.dispatch(id, state, session, item)
  }
  private finishWrite(id: string, state: State, item: Input): void {
    if (state.active !== item) return
    if (state.timer) clearTimeout(state.timer)
    state.timer = undefined
    state.active = undefined
    state.writing = false
    state.release?.()
    state.release = undefined
    this.pump(id, state)
  }
  private async dispatch(id: string, state: State, session: RegisteredSession, item: Input): Promise<void> {
    try {
      if (!await this.deps.validateRuntime(session)) { this.delivery(id, item, 'rejected', 'runtime_gone_pre_paste'); this.finishWrite(id, state, item); return }
      if (this.states.get(id) !== state || item.cancelled) { this.finishWrite(id, state, item); return }
      const blocked = this.deps.isAwaitingUser ? await this.deps.isAwaitingUser(session) : state.userAction
      if (this.states.get(id) !== state || item.cancelled) { this.finishWrite(id, state, item); return }
      state.userAction = blocked
      if (blocked) {
        state.queue.unshift(item)
        this.status(id, item, 'waiting_for_user', 'daemon_queue')
        // Do not immediately pump the item returned to the queue.
        state.active = undefined; state.writing = false; state.release?.(); state.release = undefined
        this.later(id, state)
        return
      }
      item.mode = !state.busy ? 'direct' : busyMode(this.deps.submission.policy(session.engine), session)
      this.deps.onDispatch?.(id, item.deliveryId, item.content)
      item.dispatched = true
      state.pending.push(item)
      const result = await this.deps.inject(session.agentId, item.content)
      if (this.states.get(id) !== state) return
      if (item.started) { this.finishWrite(id, state, item); return }
      if (enterWithheldReason(result)) {
        // Typed, its Enter not pressed: something opened before it, and the Enter is never pressed later.
        state.pending = state.pending.filter(next => next !== item)
        this.delivery(id, item, 'rejected', 'enter_withheld'); this.finishWrite(id, state, item); return
      }
      if (rejected(result)) {
        state.pending = state.pending.filter(next => next !== item)
        // A dialog that opened between the look for one and the write: refused unwritten, and why.
        const reason = typeof result !== 'boolean' && result.state === 'failed' && isMessageHold(result.reason) ? result.reason : 'paste_failed'
        this.delivery(id, item, 'rejected', reason); this.finishWrite(id, state, item); return
      }
      item.retry = executed(result)
      this.status(id, item, 'submitted')
      this.delivery(id, item, item.retry ? 'delivered' : 'unknown', item.retry ? undefined : 'dispatch_ambiguous')
      state.writing = false
      await this.verify(id, state, item, false)
    } catch {
      if (this.states.get(id) !== state || item.cancelled) return
      if (item.started) { this.finishWrite(id, state, item); return }
      this.delivery(id, item, item.dispatched ? 'unknown' : 'rejected', item.dispatched ? 'dispatch_ambiguous' : 'runtime_gone_pre_paste')
      state.writing = false
      if (item.dispatched) this.later(id, state)
      else this.finishWrite(id, state, item)
    } finally {
      if (this.states.get(id) !== state) { state.writing = false; state.release?.(); state.release = undefined }
    }
  }
  private async verify(id: string, state: State, item: Input, allowRetry = true): Promise<void> {
    try {
      const pane = await this.deps.capture(id)
      if (this.states.get(id) !== state || state.active !== item) return
      const evidence = pane ? await this.draft(id, pane, item.content) : 'unreadable'
      if (this.states.get(id) !== state || state.active !== item) return
      if (item.started || evidence === 'clear') {
        this.status(id, item, 'accepted'); this.finishWrite(id, state, item); return
      }
      if (allowRetry && evidence === 'pending' && item.retry && item.retries < 2 && !state.userAction) {
        state.writing = true
        const session = this.deps.getSession(id)
        // The write is over either way: left active, it held every message behind it until a turn began
        // or ended, and an agent that had gone, or could not be checked, never gave one.
        if (!session || !await this.deps.validateRuntime(session)) {
          this.delivery(id, item, 'unknown', 'runtime_gone_post_paste')
          this.finishWrite(id, state, item)
          return
        }
        const blocked = await this.deps.isAwaitingUser?.(session)
        if (this.states.get(id) !== state || state.active !== item || item.started) return
        if (!blocked) {
          item.retry = false
          item.retries++
          item.retry = executed(await this.deps.sendKey(id, 'Enter'))
        }
      }
      if (++item.observes <= 7) this.later(id, state)
      else { this.delivery(id, item, 'unknown', 'input_acceptance_unconfirmed'); this.status(id, item, 'unconfirmed') }
    } catch {
      if (this.states.get(id) !== state || item.started) return
      this.delivery(id, item, 'unknown', 'dispatch_ambiguous')
      if (++item.observes <= 7) this.later(id, state)
      else this.status(id, item, 'unconfirmed')
    } finally {
      if (state.active === item) state.writing = false
      if (this.states.get(id) !== state) { state.release?.(); state.release = undefined }
      if (item.started) this.finishWrite(id, state, item)
    }
  }
  /** Whether the prompt is still in the engine's composer, as its worker reads it; no reading is unreadable. */
  private async draft(id: string, pane: string, content: string): Promise<'pending' | 'clear' | 'unreadable'> {
    const session = this.deps.getSession(id)
    const reading = session ? await this.deps.submission.read(session, pane, content).catch(() => null) : null
    return reading?.nativeDraft ?? 'unreadable'
  }
  onTurnStarted(id: string, content: string): void {
    const state = this.state(id)
    state.busy = true
    const item = state.pending.find(next => next.fingerprint === fingerprint(content))
    if (!item) return
    item.started = true
    state.pending = state.pending.filter(next => next !== item)
    this.status(id, item, 'accepted')
    this.delivery(id, item, 'started')
    if (state.active === item && !state.writing) this.finishWrite(id, state, item)
    else this.pump(id, state)
  }
  onTurnEnded(id: string): void {
    const state = this.state(id)
    state.busy = false
    if (state.active && !state.writing) this.later(id, state)
    else this.pump(id, state)
  }
  setUserAction(id: string, open: boolean): void {
    const state = this.state(id)
    state.userAction = open
    if (!open) this.pump(id, state)
  }
  cancelDelivery(deliveryId: string): boolean {
    for (const [id, state] of this.states) {
      const item = state.queue.find(next => next.deliveryId === deliveryId)
        ?? (state.active?.deliveryId === deliveryId && !state.active.dispatched ? state.active : undefined)
      if (!item) continue
      item.cancelled = true
      state.queue = state.queue.filter(next => next !== item)
      this.delivery(id, item, 'rejected', 'cancelled')
      return true
    }
    return this.deps.legacyCancel(deliveryId)
  }
  forget(id: string): void {
    const state = this.states.get(id)
    this.states.delete(id)
    if (state) {
      if (state.timer) clearTimeout(state.timer)
      for (const item of new Set([...state.queue, ...state.pending, ...(state.active ? [state.active] : [])])) {
        item.cancelled = true
        this.delivery(id, item, item.dispatched ? 'unknown' : 'rejected', 'agent_gone')
      }
      // An in-progress terminal write cannot be recalled; release only when its promise settles.
      if (!state.writing) { state.release?.(); state.release = undefined }
    }
    this.deps.onForget?.(id)
  }
}

/** Filter only the Autonomous Device view. Shared normalizers and other consumers stay unchanged.
 * A same-batch end immediately preceding new input is not sufficient completion evidence.
 */
export function isDeviceInputBoundary(policy: SubmissionPolicy | undefined, events: readonly LiveEvent[], index: number): boolean {
  return policy?.typesWhileBusy === true && events[index]?.type === 'turn_ended' && events[index + 1]?.type === 'turn_started'
}
