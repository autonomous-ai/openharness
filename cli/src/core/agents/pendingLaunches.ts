import type { AgentCreationOutcome, AgentCreationReceipts, CreationHold, PendingCreationIntent } from '../../lib/agentCreationReceipt.js'

export type PreparedCreation = (() => Promise<AgentCreationOutcome>) | null
export type IntentReceipts = Pick<AgentCreationReceipts, 'runIntent' | 'pendingIntents' | 'pendingIntent' | 'cancelIntent'>

/** Core owns dependency retries. It opens after readiness, bounds stalled
 * service calls and never replays an effect whose durable claim already exists. */
export function createPendingLaunches({ receipts, prepare }: {
  receipts: IntentReceipts
  prepare: (request: Record<string, unknown>) => Promise<PreparedCreation>
}) {
  let stopped = false
  let opened = false
  let active = 0
  let timer: ReturnType<typeof setInterval> | undefined
  let continuation: ReturnType<typeof setImmediate> | undefined
  let recovering: Promise<void> | undefined
  let scan: AsyncGenerator<PendingCreationIntent | null> | undefined
  let scanAt = 0
  let crowded = false
  let startAfter = 0
  const windowSize = 128
  // Only IDs and retry times live here. Every attempt reads its private intent
  // afresh; resolved models, credentials and completed outcomes are not cached.
  const pending = new Map<string, number>()
  let turn = pending.entries()
  const preparing = new Map<string, Promise<PreparedCreation>>()
  const remember = (id: string, at: number) => {
    if (pending.has(id) || pending.size < windowSize) pending.set(id, at)
    else crowded = true // The complete request is already durable on disk.
  }

  const prepareOne = async (id: string, request: Record<string, unknown>): Promise<PreparedCreation> => {
    active++
    let deadline: ReturnType<typeof setTimeout> | undefined
    try {
      const ready = await Promise.race([
        // Retain a timed-out service's slot until its promise settles instead
        // of accumulating unlimited abandoned preparations during an outage.
        Promise.resolve().then(() => prepare(request)).catch(() => null).finally(() => { active--; preparing.delete(id) }),
        // launchTarget permits three minutes for credential preparation. The
        // receipt answers pending after five seconds without ending this work.
        new Promise<null>(resolve => { deadline = setTimeout(() => resolve(null), 185_000); deadline.unref?.() }),
      ])
      return stopped || !ready ? null : () => stopped ? Promise.resolve({ state: 'unconfirmed' }) : ready()
    } finally { clearTimeout(deadline) }
  }
  const bounded = (id: string, request: Record<string, unknown>): Promise<PreparedCreation> => {
    if (stopped) return Promise.resolve(null)
    const existing = preparing.get(id)
    if (existing) return existing
    if (active >= 4) return Promise.resolve(null)
    const result = prepareOne(id, request)
    preparing.set(id, result)
    return result
  }
  const start = (id: string, fingerprint: string, request: Record<string, unknown>, held: CreationHold) => {
    const result = receipts.runIntent(id, fingerprint, request, held, saved => bounded(id, saved))
    remember(id, Date.now() + 2_000)
    // Under backlog pressure, a settled hold gives its window slot to the next
    // disk entry. The cursor finishes that pass before revisiting earlier IDs;
    // permanently unavailable choices cannot starve the tail of the directory.
    const release = () => { if (crowded) pending.delete(id) }
    void result.then(status => { if (status.state !== 'pending') pending.delete(id); else release() }, release)
    return result
  }

  const recover = (): Promise<void> => {
    if (!opened || stopped) return Promise.resolve()
    if (recovering) return recovering
    recovering = (async () => {
      const began = performance.now()
      let started = 0
      // Include synchronous receipt reads in the SAME event-loop work budget
      // as the directory scan. Background dispatch is at most four per tick.
      if (Date.now() >= startAfter) {
        for (let inspected = 0; inspected < 64 && started < 4 && !stopped && performance.now() - began < 20; inspected++) {
          const next = turn.next()
          if (next.done) { turn = pending.entries(); break }
          const [id, at] = next.value
          if (Date.now() < at) continue
          pending.set(id, Date.now() + 2_000)
          started++
          try {
            const intent = receipts.pendingIntent(id)
            if (!intent) { pending.delete(id); continue }
            void start(id, intent.fingerprint, intent.request, intent.held).catch(() => {})
          } catch { if (crowded) pending.delete(id) /* Uncertain storage never blocks sibling IDs. */ }
        }
        if (started) startAfter = Date.now() + 250
      }
      // A cursor yields for EVERY directory entry, including old receipts and
      // corrupt records. Bound work per pass; a large history cannot monopolize
      // session control. A background rescan finds intents another core saved.
      try {
        if (!scan && Date.now() >= scanAt) scan = receipts.pendingIntents()
        if (scan) {
          for (let n = 0; n < 64 && !stopped && performance.now() - began < 20; n++) {
            if (pending.size >= windowSize) { crowded = true; break }
            const entry = await scan.next()
            if (entry.done) { scan = undefined; crowded = false; scanAt = Date.now() + 60_000; break }
            if (entry.value && !pending.has(entry.value.id)) remember(entry.value.id, 0)
          }
        }
      } catch { scan = undefined; scanAt = Date.now() + 2_000 }
      // Receipt replies have their own deadline. Neither they nor a stalled
      // dependency delay the next bounded scan or another session's retry.
    })().finally(() => {
      recovering = undefined
      if (scan && !stopped && pending.size < windowSize) continuation = setImmediate(() => { void recover() })
    })
    return recovering
  }

  return {
    start, recover,
    open: () => {
      if (opened || stopped) return
      opened = true
      timer = setInterval(() => { void recover() }, 250)
      timer.unref?.()
      void recover()
    },
    stop: () => {
      stopped = true
      clearInterval(timer); clearImmediate(continuation)
      void scan?.return(null).catch(() => {})
    },
  }
}
