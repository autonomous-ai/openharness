/** Core owns pending hook admission. A late lookup cannot replace a newer hook or binding. */
export type AdmissionDecision<T> =
  | { kind: 'accept'; value: T }
  | { kind: 'reject'; reason: string }
  | { kind: 'hold'; reason: string }

export interface PendingAdmission<T> {
  current: () => boolean
  inspect: () => Promise<AdmissionDecision<T>>
  accept: (value: T) => void
  reject: (reason: string) => void
  held: (reason: string) => void
}

export function createPendingAdmissions({ retryMs = 1_000 }: { retryMs?: number } = {}) {
  type Job = { request: PendingAdmission<unknown>; timer: ReturnType<typeof setTimeout> | null; reason?: string }
  const jobs = new Map<string, Job>()
  const running = new Set<string>()
  let closed = false
  const current = (key: string, job: Job) => !closed && jobs.get(key) === job && job.request.current()
  const discard = (key: string, job: Job) => {
    if (jobs.get(key) === job) jobs.delete(key)
  }
  const run = async (key: string, job: Job): Promise<void> => {
    running.add(key)
    try { await inspect(key, job) } catch (error) {
      // A notification may throw after publication. Never retry that publication or
      // let its exception take down the daemon; a held read already has its retry.
      if (!job.timer) discard(key, job)
      console.warn('[hooks] pending admission callback failed', error)
    } finally {
      running.delete(key)
      const next = jobs.get(key)
      if (next && next !== job) void run(key, next)
    }
  }
  const inspect = async (key: string, job: Job): Promise<void> => {
    if (!current(key, job)) { discard(key, job); return }
    let decision: AdmissionDecision<unknown>
    try { decision = await job.request.inspect() } catch {
      decision = { kind: 'hold', reason: 'The session source could not be read.' }
    }
    if (!current(key, job)) { discard(key, job); return }
    if (decision.kind === 'hold') {
      job.timer = setTimeout(() => { job.timer = null; void run(key, job) }, retryMs)
      job.timer.unref()
      if (job.reason !== decision.reason) {
        job.reason = decision.reason
        job.request.held(decision.reason)
      }
      return
    }
    jobs.delete(key)
    if (decision.kind === 'accept') job.request.accept(decision.value)
    else job.request.reject(decision.reason)
  }
  return {
    submit<T>(key: string, request: PendingAdmission<T>): void {
      if (closed) return
      const previous = jobs.get(key)
      if (previous?.timer) clearTimeout(previous.timer)
      const job: Job = { request: request as PendingAdmission<unknown>, timer: null }
      jobs.set(key, job)
      if (!running.has(key)) void run(key, job)
    },
    close(): void {
      closed = true
      for (const job of jobs.values()) if (job.timer) clearTimeout(job.timer)
      jobs.clear()
    },
  }
}
