/** Core owns pending hook admission. A late lookup cannot replace a newer hook or binding. */
export type AdmissionDecision<T> =
  | { kind: 'accept'; value: T }
  | { kind: 'reject'; reason: string }
  | { kind: 'hold'; reason: string }

export interface PendingAdmission<T> {
  current: () => boolean
  inspect: () => Promise<AdmissionDecision<T>>
  accept: (value: T) => void | Promise<void>
  reject: (reason: string) => void | Promise<void>
  held: (reason: string) => void | Promise<void>
}

export function createPendingAdmissions({ retryMs = 1_000, capacity = 64 }: { retryMs?: number; capacity?: number } = {}) {
  type Job = { id: string; request: PendingAdmission<unknown>; timer: ReturnType<typeof setTimeout> | null; reason?: string }
  const jobs = new Map<string, Job[]>()
  const running = new Set<string>()
  let closed = false
  const current = (key: string, job: Job) => !closed && !!jobs.get(key)?.includes(job) && job.request.current()
  const selected = (key: string) => jobs.get(key)?.at(-1)
  const clearTimer = (job: Job) => { if (job.timer) { clearTimeout(job.timer); job.timer = null } }
  const discard = (key: string, job: Job) => {
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
  const run = async (key: string, job: Job): Promise<void> => {
    running.add(key)
    try { await inspect(key, job) } catch (error) {
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
    if (!current(key, job)) { discard(key, job); return }
    let decision: AdmissionDecision<unknown>
    try { decision = await job.request.inspect() } catch {
      decision = { kind: 'hold', reason: 'The session source could not be read.' }
    }
    if (!current(key, job)) { discard(key, job); return }
    // A newer unverified hook pauses this candidate; it does not erase it. Hermes
    // children use their parent's process, and a rejected child must leave the parent pending.
    if (selected(key) !== job) return
    if (decision.kind === 'hold') {
      job.timer = setTimeout(() => { job.timer = null; void run(key, job) }, retryMs)
      job.timer.unref()
      if (job.reason !== decision.reason) {
        job.reason = decision.reason
        notified(job.request.held(decision.reason))
      }
      return
    }
    if (decision.kind === 'accept') {
      jobs.delete(key)
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
      if (duplicate !== -1) { clearTimer(queue[duplicate]!); queue.splice(duplicate, 1) }
      const previous = queue.at(-1)
      if (previous) clearTimer(previous)
      const job: Job = { id, request: request as PendingAdmission<unknown>, timer: null }
      queue.push(job)
      jobs.set(key, queue)
      if (!running.has(key)) void run(key, job)
      return true
    },
    close(): void {
      closed = true
      for (const queue of jobs.values()) for (const job of queue) clearTimer(job)
      jobs.clear()
    },
  }
}
