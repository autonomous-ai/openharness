/**
 * A session's follow-up hooks wait behind its admission instead of being refused. Claude Code on Windows sends
 * SessionStart 2-3 s before its transcript exists, so the admission is held while the session's Stop, tool and wait
 * hooks arrive; each was refused `UNBOUND_HOOK`, and its client never sends a hook twice, so the turn never ended. Behind
 * a resumed row the same refusal went on for hours of Stops in the user's log
 * (docs/plans/2026-11-25-win-hook-admission-design.md, C). Kept per session, in memory and bounded: the admissions the
 * hook server has read and not settled, and the hooks waiting behind them.
 */
import { errorKind, sid } from '../../lib/log.js'

export type WaitingRoute = 'turn-stop' | 'wait' | 'subagent' | 'tool-start' | 'turn-start' | 'session-end'
export interface SessionHookWaitBounds { perSession: number; total: number; totalBytes: number; maxWaitMs: number }

/** 32, 256, 4 MiB, 120 s. A normal wait is under 3 s; the longest designed one is the 20 s process-record wait plus
 *  1 s retries, six times over. 32 is above the hooks one turn sends while a tool asks. A tool-start body can be
 *  128 KiB, so the bytes, not the count, cap the memory. */
export const SESSION_HOOK_WAIT_BOUNDS: SessionHookWaitBounds = { perSession: 32, total: 256, totalBytes: 4 * 1024 * 1024, maxWaitMs: 120_000 }

/** One key per engine and session; no two pairs share one (JSON of the pair). */
export function sessionKey(engine: string, sessionId: string): string {
  return JSON.stringify([engine, sessionId])
}

export interface AdmissionTicket {
  /** This request of the delivery left its route handler. Idempotent. */
  requestDone(): void
  /** The delivery's admission job is about to be queued; the returned call says it ended. Idempotent; only the
   *  latest job of the delivery decides. */
  queued(): () => void
}

export interface WaitingHook { route: WaitingRoute; sessionId: string; bytes: number; run: () => Promise<void> }
type UnheldReason = 'session_full' | 'core_full' | 'timed_out'

export function createSessionHookWait(bounds: Partial<SessionHookWaitBounds> = {}) {
  const { perSession, total, totalBytes, maxWaitMs } = { ...SESSION_HOOK_WAIT_BOUNDS, ...bounds }
  // Unsettled while a request of it is in its handler or its latest job is queued; settled, it is gone.
  type Admission = { arrival: number; requests: number; job?: object; announced: boolean }
  type Waiter = { arrival: number; hook: WaitingHook; timer: ReturnType<typeof setTimeout> }
  type Session = { admissions: Map<string, Admission>; waiting: Waiter[]; draining: boolean }
  const sessions = new Map<string, Session>()
  // One arrival count for admissions and hooks: a hook waits only behind the admissions that arrived before it.
  let arrival = 0, waitingCount = 0, waitingBytes = 0, closed = false
  // Per reason, when its line was last said and the hooks run unheld for it since: a session over its bound would say
  // it for every hook it sends, and a stuck admission for every hook behind it.
  const unheldSaid = new Map<UnheldReason, { at: number; hooks: number }>()
  const unheld = ({ route, sessionId }: WaitingHook, reason: UnheldReason) => {
    const said = unheldSaid.get(reason)
    if (said && Date.now() - said.at < 60_000) { said.hooks++; return }
    console.warn(`[hooks] ${sid(sessionId)} ${route} runs unheld · ${reason} · ${(said?.hooks ?? 0) + 1}`)
    unheldSaid.set(reason, { at: Date.now(), hooks: 0 })
  }

  const behind = (session: Session, waiter: Waiter) =>
    [...session.admissions.values()].some(admission => admission.arrival < waiter.arrival)
  // Never while a drain runs: a new state for the key would start a second drain beside the running hook.
  const prune = (key: string, session: Session) => {
    if (!session.admissions.size && !session.waiting.length && !session.draining) sessions.delete(key)
  }
  const leave = (session: Session, waiter: Waiter) => {
    session.waiting.splice(session.waiting.indexOf(waiter), 1)
    clearTimeout(waiter.timer)
    waitingCount--
    waitingBytes -= waiter.hook.bytes
  }
  // Its client left on `pending`: a failure has no one to answer but the log.
  const runOne = async ({ route, sessionId, run }: WaitingHook) => {
    try { await run() } catch (error) { console.warn(`[hooks] ${sid(sessionId)} ${route} waiting hook failed · ${errorKind(error)}`) }
  }
  // The key is looked up again: a state dropped since this was scheduled, or by close, runs nothing.
  const drain = async (key: string) => {
    const session = sessions.get(key)
    if (!session || session.draining) return
    session.draining = true
    let ran = 0, last: WaitingHook | undefined
    // A hook ready means every hook before it is ready: it has every admission they wait behind ahead of it too.
    for (let head = session.waiting[0]; !closed && head && !behind(session, head); head = session.waiting[0]) {
      leave(session, head)
      ran++
      last = head.hook
      await runOne(head.hook)
    }
    session.draining = false
    if (last) console.log(`[hooks] ${sid(last.sessionId)} waiting hooks ran · ${ran}`)
    prune(key, session)
  }

  return {
    /** An admission of [key] read its delivery [deliveryId]. The same id while it is unsettled is the same admission. */
    admission(key: string, deliveryId: string): AdmissionTicket {
      // Close dropped the map: a ticket of a closed wait reaches nothing.
      if (closed) return { requestDone() {}, queued: () => () => {} }
      const session = sessions.get(key) ?? { admissions: new Map(), waiting: [], draining: false }
      sessions.set(key, session)
      const admission = session.admissions.get(deliveryId) ?? { arrival: ++arrival, requests: 0, announced: false }
      session.admissions.set(deliveryId, admission)
      admission.requests++
      let done = false
      const settle = () => {
        if (admission.requests || admission.job) return
        session.admissions.delete(deliveryId)
        // On a later turn: the accept that settled this announces the bind synchronously (onPromptSubmitted, the start
        // of onRegistered), and a replayed hook must find it announced.
        if (session.waiting.length) setImmediate(() => { void drain(key) })
        else prune(key, session)
      }
      return {
        requestDone() {
          if (done) return
          done = true
          admission.requests--
          settle()
        },
        queued() {
          // A settled admission's ticket: the same id is another admission now.
          if (session.admissions.get(deliveryId) !== admission) return () => {}
          const job = {}
          admission.job = job
          return () => {
            // Only the delivery's latest job decides: an older one ending late, or a second end, changes nothing.
            if (admission.job !== job) return
            admission.job = undefined
            settle()
          }
        },
      }
    },
    /** True: [hook] waits, its caller answers `200 {pending: true}` and [hook.run] is called once, later. False: run it
     *  now (nothing unsettled ahead of it, or over a bound, which is logged at most once a minute per reason). */
    hold(key: string, hook: WaitingHook): boolean {
      const session = sessions.get(key)
      if (!session?.admissions.size) return false
      // Every admission still here is unsettled and arrived before this hook.
      const ahead = [...session.admissions.values()]
      if (session.waiting.length >= perSession) { unheld(hook, 'session_full'); return false }
      if (waitingCount >= total || waitingBytes + hook.bytes > totalBytes) { unheld(hook, 'core_full'); return false }
      if (ahead.some(admission => !admission.announced)) {
        console.log(`[hooks] ${sid(hook.sessionId)} ${hook.route} waits for its session's admission`)
        for (const admission of ahead) admission.announced = true
      }
      const waiter: Waiter = { arrival: ++arrival, hook, timer: setTimeout(() => {
        leave(session, waiter)
        unheld(hook, 'timed_out')
        void runOne(hook)
      }, maxWaitMs) }
      waiter.timer.unref()
      session.waiting.push(waiter)
      waitingCount++
      waitingBytes += hook.bytes
      return true
    },
    /** Drops every admission, waiting hook and timer; runs nothing. Afterwards `hold` is false and tickets do nothing. */
    close(): void {
      closed = true
      // A ticket or drain of a dropped state reaches nothing: a drain looks its key up again.
      for (const session of sessions.values()) for (const waiter of session.waiting) clearTimeout(waiter.timer)
      sessions.clear()
    },
  }
}
