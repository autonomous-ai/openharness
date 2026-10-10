/** Core owns pending hook admission. A late lookup cannot replace a newer hook or binding. */
import { compareAdmissionOrder, createAdmissionOrder, type AdmissionOrder } from './admissionOrder.js'

export type AdmissionDecision<T> =
  | { kind: 'accept'; value: T }
  | { kind: 'reject'; reason: string }
  | { kind: 'hold'; reason: string }

export interface PendingAdmission<T> {
  order: AdmissionOrder
  /** Delivery IDs distinguish prompts; ordering compares their native conversation. */
  conversationId?: string
  binding?: { id: string; at: number | null } | (() => { id: string; at: number | null } | undefined)
  current: () => boolean
  inspect: () => Promise<AdmissionDecision<T>>
  /** Synchronous durable publication. Uncertainty retains this candidate and its place. */
  commit?: (value: T) => AdmissionDecision<T>
  /** Optional notification after durable acceptance; never the publication itself. */
  accept: (value: T) => void | Promise<void>
  reject: (reason: string) => void | Promise<void>
  held: (reason: string) => void | Promise<void>
}

export function createPendingAdmissions({ retryMs = 1_000, capacity = 64, isProcessCurrent }: {
  retryMs?: number; capacity?: number; isProcessCurrent?: (key: string, scope: string) => boolean
} = {}) {
  type Job = { id: string; request: PendingAdmission<unknown>; timer: ReturnType<typeof setTimeout> | null; reason?: string }
  const jobs = new Map<string, Job[]>()
  const running = new Set<string>()
  const order = createAdmissionOrder(isProcessCurrent)
  let closed = false
  const current = (key: string, job: Job) => !closed && !!jobs.get(key)?.includes(job) && job.request.current()
  const conversation = (job: Job) => job.request.conversationId ?? job.id
  const selected = (key: string) => {
    const queue = jobs.get(key)
    const newest = queue?.at(-1)
    // Distinct prompts for one conversation retain delivery order. A newer
    // conversation still gets first chance to establish or refuse its ownership.
    return newest && queue!.find(job => conversation(job) === conversation(newest))
  }
  // Known older intents wait behind the greatest native timestamp. Headerless and
  // equal-time candidates remain incomparable, so each must get a chance to prove
  // delegation or cancellation before another can publish.
  const leaders = (key: string, job: Job): Job[] => {
    const candidates = jobs.get(key)!.filter(other => other.request.order.scope === job.request.order.scope)
    const latest = Math.max(...candidates.map(other => other.request.order.firedAt ?? -Infinity))
    return candidates.filter(other => other.request.order.firedAt === undefined || other.request.order.firedAt === latest)
  }
  const clearTimer = (job: Job) => { if (job.timer) { clearTimeout(job.timer); job.timer = null } }
  const discard = (key: string, job: Job) => {
    clearTimer(job)
    const queue = jobs.get(key)
    if (!queue) return
    const index = queue.indexOf(job)
    if (index !== -1) queue.splice(index, 1)
    if (!queue.length) jobs.delete(key)
  }
  const report = (error: unknown) => console.warn('[hooks] pending admission callback failed', error)
  // Notification can await optional interpretation. Its failure is contained, but it
  // cannot block the next core admission or cause a committed binding to be retried.
  const notified = (result: void | Promise<void>) => { void Promise.resolve(result).catch(report) }
  const run = async (key: string, job: Job, retry = false): Promise<void> => {
    running.add(key)
    try {
      // One lookup owns the key. A group rotation or a new prompt may select an
      // already-held job; none of its old timers may start a concurrent lookup.
      for (const pending of jobs.get(key)!) clearTimer(pending)
      if (retry && current(key, job)) {
        const peer = leaders(key, job).find(other => conversation(other) !== conversation(job))
        if (peer) {
          const queue = jobs.get(key)!
          const group = queue.filter(other => conversation(other) === conversation(peer))
          jobs.set(key, [...queue.filter(other => conversation(other) !== conversation(peer)), ...group])
          job = group[0]!
        }
      }
      await inspect(key, job)
    } catch (error) {
      // A notification may throw after publication. Never retry that publication or
      // let its exception take down the daemon; a held read already has its retry.
      if (!job.timer) discard(key, job)
      report(error)
    } finally {
      running.delete(key)
      const next = selected(key)
      if (next && !next.timer) void run(key, next)
    }
  }
  const inspect = async (key: string, job: Job): Promise<void> => {
    if (!current(key, job)) { discard(key, job); notified(job.request.reject('stale_hook')); return }
    order.observe(key, job.request.order.scope, typeof job.request.binding === 'function' ? job.request.binding() : job.request.binding)
    let decision: AdmissionDecision<unknown>
    try { decision = await job.request.inspect() } catch (error) {
      decision = { kind: 'hold', reason: `The session source could not be read. ${error instanceof Error ? error.message : 'Native evidence unavailable.'}`.slice(0, 1024) }
    }
    if (!current(key, job)) { discard(key, job); notified(job.request.reject('stale_hook')); return }
    // A newer unverified hook pauses this candidate; it does not erase it. Hermes
    // children use their parent's process, and a rejected child must leave the parent pending.
    if (selected(key) !== job && decision.kind !== 'reject') return
    const status = order.status(key, conversation(job), job.request.order)
    if (status === 'older') decision = { kind: 'reject', reason: 'stale_hook' }
    else if (decision.kind === 'accept') {
      const unresolved = leaders(key, job).some(other => other !== job && conversation(other) !== conversation(job))
      if (status === 'ambiguous' || unresolved) decision = { kind: 'hold', reason:
        'Waiting for unambiguous native hook order; keeping the current conversation.'
        + (job.request.order.firedAt === undefined ? ' This hook has no native timestamp; reload or restart the engine with updated hooks.' : '') }
    }
    if (decision.kind === 'accept' && job.request.commit) {
      try { decision = job.request.commit(decision.value) }
      catch (error) { decision = { kind: 'hold', reason: `Waiting for durable hook admission: ${error instanceof Error ? error.message : 'commit unavailable'}`.slice(0, 1024) } }
    }
    if (decision.kind === 'hold') {
      job.timer = setTimeout(() => { job.timer = null; void run(key, job, true) }, retryMs)
      job.timer.unref()
      if (job.reason !== decision.reason) {
        job.reason = decision.reason
        notified(job.request.held(decision.reason))
      }
      return
    }
    if (decision.kind === 'accept') {
      order.accept(key, conversation(job), job.request.order)
      discard(key, job)
      notified(job.request.accept(decision.value))
    } else {
      discard(key, job)
      notified(job.request.reject(decision.reason))
    }
  }
  return {
    /** False means backpressure: nothing was queued or evicted, so the sender must retry. */
    submit<T>(key: string, id: string, request: PendingAdmission<T>): boolean {
      if (closed) return false
      const queue = jobs.get(key) ?? []
      const duplicate = queue.findIndex(job => job.id === id)
      if (duplicate === -1 && queue.length >= capacity) return false
      if (duplicate !== -1 && queue[duplicate]!.request.order.scope === request.order.scope) {
        const previous = queue[duplicate]!
        const known = previous.request.order.firedAt
        if (known !== undefined && (request.order.firedAt === undefined || request.order.firedAt < known)) return true
        if (known === request.order.firedAt) {
          if (previous.request.current()) return true
          // Same delivery, freshly verified after its old binding/route became stale.
          request = { ...request, order: { ...request.order, arrival: previous.request.order.arrival } }
        }
      }
      if (duplicate !== -1) { clearTimer(queue[duplicate]!); queue.splice(duplicate, 1) }
      const previous = queue.at(-1)
      if (previous) clearTimer(previous)
      const job: Job = { id, request: request as PendingAdmission<unknown>, timer: null }
      queue.push(job)
      queue.sort((a, b) => compareAdmissionOrder(a.request.order, b.request.order))
      jobs.set(key, queue)
      if (!running.has(key)) void run(key, selected(key)!)
      return true
    },
    close(): void {
      closed = true
      for (const queue of jobs.values()) for (const job of queue) clearTimer(job)
      jobs.clear()
      order.close()
    },
  }
}
