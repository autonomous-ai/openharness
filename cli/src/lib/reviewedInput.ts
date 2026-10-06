import type { RegisteredSession } from './registry.js'
import { engineSupportsGoal, engineSupportsLoop } from './goalCommand.js'
import { TerminalBackendCoordinator } from './terminalBackendCoordinator.js'
import type { ReviewedSubmitPhase } from './terminalBackend.js'
import { teamWriteHold } from '../teams/preflight.js'

export type ReviewedIntent = 'goal' | 'loop'
export type ReviewedReceipt =
  | { state: 'submitted' }
  | { state: 'rejected' | 'uncertain'; error: string }
export type PreparedReview = { ok: false; error: string } | {
  ok: true
  current(): boolean
  cancel(): void
  submit(body: string): Promise<ReviewedReceipt>
}
const CHANGED = 'That harness changed. Record your instruction again.'
const UNAVAILABLE = 'Reviewed input is unavailable for this harness.'
const UNCERTAIN = 'Could not confirm sending. Check the terminal before trying again.'

/** Private cable adapter. No routing, slash adaptation, Enter retry or completion inference. */
export class ReviewedInput {
  private queues = new Map<string, { tail: Promise<void>; count: number; bytes: number }>()
  constructor(private readonly deps: {
    session: (agentId: string) => RegisteredSession | undefined
    terminals: TerminalBackendCoordinator
    acquire: (agentId: string) => (() => void) | null
    isTurnOpen: (session: RegisteredSession) => boolean
    beforeSubmit?: (agentId: string, text: string) => (() => void)
    waitMs?: number
  }) {}

  async prepare(agentId: string, intent: ReviewedIntent): Promise<PreparedReview> {
    // Copy before the first await: registry records are mutable, including same-agent restarts.
    const row = this.deps.session(agentId)
    if (!row || row.agentId !== agentId || !row.active || !row.sessionId || !row.processIdentity ||
        !(intent === 'goal' ? engineSupportsGoal(row.engine) : intent === 'loop' && engineSupportsLoop(row.engine)))
      return { ok: false, error: UNAVAILABLE }
    const snapshot = structuredClone(row)
    const acquired = await this.deps.terminals.acquireReviewedLease(snapshot)
    if (acquired.state !== 'succeeded') return { ok: false, error: UNAVAILABLE }
    const lease = acquired.value
    let cancelled = false
    const current = () => {
      const live = this.deps.session(agentId)
      return !cancelled && !!live && live.active && live.agentId === snapshot.agentId &&
        live.sessionId === snapshot.sessionId && live.engine === snapshot.engine &&
        live.processIdentity?.pid === snapshot.processIdentity!.pid &&
        live.processIdentity?.startMarker === snapshot.processIdentity!.startMarker &&
        live.processIdentity?.executable === snapshot.processIdentity!.executable &&
        // Legacy currentness refreshes lease.runtime. Keep the reviewed locator immutable.
        this.deps.terminals.leaseIsCurrent({ ...lease }, live)
    }
    if (!current()) return { ok: false, error: CHANGED }
    let receipt: Promise<ReviewedReceipt> | undefined
    return {
      ok: true, current, cancel: () => { cancelled = true },
      submit: body => receipt ??= this.enqueue(agentId, `/${intent} ${body}`, current, async text => {
        if (!current()) return { state: 'rejected', error: CHANGED }
        const deadline = Date.now() + (this.deps.waitMs ?? 5000)
        let release: (() => void) | null = null
        while (current() && !(release = this.deps.acquire(agentId))) {
          if (Date.now() >= deadline) return { state: 'rejected', error: 'That harness is busy. Your instruction was not sent.' }
          await new Promise(resolve => setTimeout(resolve, 25))
        }
        if (!release) return { state: 'rejected', error: CHANGED }
        let dispatched = false
        let forgetScope: (() => void) | undefined
        let hold: string | undefined
        const ready = async (phase: ReviewedSubmitPhase) => {
          if (phase === 'identity') return true
          if (this.deps.isTurnOpen(snapshot)) { hold = 'That harness is busy. Your instruction was not sent.'; return false }
          if (phase === 'before-enter') return true
          // Read only this pinned runtime, with styling and without old scrollback prompts.
          const capture = await this.deps.terminals.captureLease(lease, { mode: 'visible', ansi: true })
          if (!current() || this.deps.isTurnOpen(snapshot)) return false
          const reason = teamWriteHold(snapshot.engine, capture.state === 'succeeded' ? capture.value : null)
          hold = reason === 'team_waiting_draft' ? 'Finish the draft in the terminal before sending.'
            : reason === 'team_waiting_user' ? 'Answer the open question before sending an instruction.'
            : reason ? 'The terminal is not ready. Your instruction was not sent.' : undefined
          return !reason
        }
        try {
          if (!current()) return { state: 'rejected', error: CHANGED }
          forgetScope = this.deps.beforeSubmit?.(agentId, text)
          dispatched = true
          const result = await this.deps.terminals.submitReviewed(snapshot, lease, text, current, ready)
          if (result.state === 'succeeded') return { state: 'submitted' }
          if (result.dispatch !== 'possibly_executed') forgetScope?.()
          return result.dispatch === 'possibly_executed'
            ? { state: 'uncertain', error: UNCERTAIN }
            : { state: 'rejected', error: current() ? hold ?? 'The instruction was not sent. Check the harness.' : CHANGED }
        } catch {
          return dispatched ? { state: 'uncertain', error: UNCERTAIN }
            : { state: 'rejected', error: 'The instruction was not sent. Check the harness.' }
        } finally { release() }
      }),
    }
  }

  private enqueue(id: string, text: string, current: () => boolean,
    run: (text: string) => Promise<ReviewedReceipt>): Promise<ReviewedReceipt> {
    const bytes = Buffer.byteLength(text), created = Date.now()
    const queue = this.queues.get(id) ?? { tail: Promise.resolve(), count: 0, bytes: 0 }
    if (queue.count >= 8 || queue.bytes + bytes > 24 * 1024)
      return Promise.resolve({ state: 'rejected', error: 'Too much input is waiting for this harness.' })
    this.queues.set(id, queue); queue.count++; queue.bytes += bytes
    const result = queue.tail.then(async (): Promise<ReviewedReceipt> => {
      if (!current()) return { state: 'rejected', error: CHANGED }
      if (Date.now() - created > 5000) return { state: 'rejected', error: 'The instruction expired before it could be sent.' }
      try { return await run(text) }
      catch { return { state: 'uncertain', error: UNCERTAIN } }
    }).finally(() => {
      queue.count--; queue.bytes -= bytes
      if (!queue.count) this.queues.delete(id)
    })
    queue.tail = result.then(() => {})
    return result
  }
}
