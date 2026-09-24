import { createHash } from 'node:crypto'
import type { RegisteredSession } from '../registry.js'
import type { SessionInputDelivery } from '../sessionInput.js'
import type { TerminalActionResult } from '../terminalTypes.js'
import type { LiveEvent } from '../normalize.js'

const NATIVE = new Set(['claude', 'codex'])
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
  isAwaitingUser?: (session: RegisteredSession) => Promise<boolean>
  acquireControl: (id: string) => (() => void) | null
  legacySubmit: (id: string, text: string, deliveryId: string) => void
  legacyCancel: (deliveryId: string) => boolean
  onDelivery: (event: SessionInputDelivery) => void
  onInputStatus: (event: DeviceInputStatus) => void
  onForget?: (id: string) => void
}
const fingerprint = (text: string) => createHash('sha256').update(text.replace(/\r\n/g, '\n').trim()).digest('hex')
const visible = (text: string) => text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
const normalize = (text: string) => text.replace(/\s+/g, ' ').trim()
function draft(capture: string, content: string): 'pending' | 'clear' | 'unreadable' {
  const lines = visible(capture).split('\n')
  const index = lines.findLastIndex(line => /[›❯]/u.test(line) && !/[›❯]\s*\d+\.\s/u.test(line))
  if (index < 0) return 'unreadable'
  return normalize(lines.slice(index).join('\n')).includes(normalize(content)) ? 'pending' : 'clear'
}
const executed = (result: boolean | TerminalActionResult) => result === true || (typeof result !== 'boolean' && result.dispatch === 'executed')
const rejected = (result: boolean | TerminalActionResult) => result === false || (typeof result !== 'boolean' && (result.dispatch === 'not_started' || result.dispatch === 'rejected'))

/** A separate route, used exclusively by Autonomous Device turn.send. */
export class AutonomousDeviceInput {
  private states = new Map<string, State>()
  private writers = new Map<string, Writer>()
  constructor(private readonly deps: DeviceInputDeps) {}
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
    if (!NATIVE.has(session.engine)) {
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
      const version = session.cliVersion?.match(/(\d+)\.(\d+)\.(\d+)/)
      item.mode = !state.busy ? 'direct' : session.engine === 'claude' ? 'native_queue'
        : version && (Number(version[1]) > 0 || Number(version[2]) >= 106) ? 'steering' : 'native_input'
      item.dispatched = true
      state.pending.push(item)
      const result = await this.deps.inject(session.agentId, item.content)
      if (this.states.get(id) !== state) return
      if (item.started) { this.finishWrite(id, state, item); return }
      if (rejected(result)) {
        state.pending = state.pending.filter(next => next !== item)
        this.delivery(id, item, 'rejected', 'paste_failed'); this.finishWrite(id, state, item); return
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
      const evidence = pane ? draft(pane, item.content) : 'unreadable'
      if (item.started || evidence === 'clear') {
        this.status(id, item, 'accepted'); this.finishWrite(id, state, item); return
      }
      if (allowRetry && evidence === 'pending' && item.retry && item.retries < 2 && !state.userAction) {
        state.writing = true
        const session = this.deps.getSession(id)
        if (!session || !await this.deps.validateRuntime(session)) { this.delivery(id, item, 'unknown', 'runtime_gone_post_paste'); return }
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
export function isDeviceInputBoundary(engine: string, events: readonly LiveEvent[], index: number): boolean {
  return NATIVE.has(engine) && events[index]?.type === 'turn_ended' && events[index + 1]?.type === 'turn_started'
}
