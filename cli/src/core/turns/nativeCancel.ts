/** Cancel retains its original target before any wait. Storage recovery can
 * finish that request, but cannot select a new owner or repeat an interrupt. */
import { randomUUID } from 'node:crypto'
import type { NativeCancellationResult } from '../../hookServer.js'
import type { registry, RegisteredSession } from '../../lib/registry.js'
import { nativeTurnTarget, parseNativeTurnIntent, type NativeTurnIntent } from '../../lib/nativeTurnIntent.js'
import type { NativeGenerationCancellation, NativeGenerationFrontier } from '../../engines/kit/nativeGenerationCancellation.js'
import type { TerminalActionResult, TerminalWrite } from '../../lib/terminalTypes.js'
import type { TerminalWriter } from '../terminals/writer.js'
import type { NativeGenerationOwner } from './nativeGenerations.js'

export interface NativeCancelDeps {
  registry: Pick<typeof registry, 'byAgent' | 'commitNativeControl' | 'readNativeControl'>
  /** Previously confirmed identity only. Physical authority is renewed by the
   * journal port against this exact key after persistence. */
  capture(row: RegisteredSession): { owner: NativeGenerationOwner; frontier: NativeGenerationFrontier; namespace?: string } | undefined
  revoke(row: RegisteredSession): void
  revokeRearm(requestId: string): void
  journal(owner: NativeGenerationOwner, request: NativeGenerationCancellation): Promise<NativeCancellationResult>
  writer: Pick<TerminalWriter, 'revoke' | 'interrupt'>
  interrupt(agentId: string, allowed: () => boolean, write: TerminalWrite): Promise<TerminalActionResult>
  held(agentId: string, reason: string): void
  now?(): number
  maxJobs?: number
  maxRunning?: number
}

export function createNativeCancel({ registry, capture, revoke, revokeRearm, journal, writer, interrupt, held,
  now = () => performance.now(), maxJobs = 256, maxRunning = 8,
}: NativeCancelDeps) {
  type Job = { original: RegisteredSession; intent: NativeTurnIntent; target: string; deadline: number;
    saved?: RegisteredSession; confirmed?: boolean; running: boolean; nextAttempt: number; answer: Promise<boolean>; resolve(value: boolean): void;
    timer: ReturnType<typeof setTimeout> }
  const jobs = new Map<string, Job>()
  let closed = false, running = 0, retry: ReturnType<typeof setTimeout> | undefined
  const hold = (agentId: string, reason: string) => held(agentId, `Waiting for native cancellation: ${reason}.`)
  const current = (job: Job) => {
    const row = registry.byAgent(job.original.agentId)
    if (closed || jobs.get(job.original.agentId) !== job || !row || nativeTurnTarget(row) !== job.target
      || JSON.stringify(row.nativeControl) !== JSON.stringify((job.saved ?? job.original).nativeControl)) {
      throw Error('the original cancellation target changed')
    }
  }
  const finish = (job: Job, value: boolean) => {
    if (jobs.get(job.original.agentId) === job) jobs.delete(job.original.agentId)
    clearTimeout(job.timer); job.resolve(value)
  }
  const schedule = () => {
    if (closed || retry || running >= maxRunning || ![...jobs.values()].some(job => !job.running)) return
    const delay = Math.min(1000, ...[...jobs.values()].filter(job => !job.running).map(job => Math.max(1, job.nextAttempt - now())))
    retry = setTimeout(() => { retry = undefined; pump() }, delay)
    retry.unref?.()
  }
  const run = async (job: Job) => {
    const id = job.original.agentId
    job.running = true; running++
    let dispatched = false
    try {
      current(job)
      if (!job.saved) {
        job.saved = structuredClone(registry.commitNativeControl(job.original, job.intent, () => current(job)))
        current(job)
      }
      registry.readNativeControl(job.saved).verify()
      current(job); job.confirmed = true
      if (job.intent.rearm?.revoked) revokeRearm(job.intent.rearm.requestId)
      const { processKey, request } = job.intent.cancel
      if (processKey === null) {
        hold(id, 'Cancel is saved; no original native owner was proven, so interruption is unconfirmed')
        finish(job, false); return
      }
      const result = await journal({ agentId: request.agentId, sessionId: request.conversationId, processKey }, request)
      current(job)
      if (!result.recorded) {
        hold(id, 'Cancel is saved; its earlier interrupt outcome is unconfirmed')
        finish(job, false); return
      }
      // One-use journal authority is consumed even if a later proof or physical
      // result is unavailable. Such an attempt must never become a retry.
      dispatched = true
      const outcome = await result.dispatch(async verifyNative => {
        const saved = registry.readNativeControl(job.saved!)
        const verify = () => {
          saved.verify(); verifyNative(); current(job)
          if (now() >= job.deadline) throw Error('the original interrupt deadline expired')
        }
        verify()
        return writer.interrupt(id, async write => {
          verify()
          const allowed = () => { try { verify(); return write.allowed() } catch { return false } }
          return interrupt(id, allowed, write)
        })
      })
      current(job)
      if (now() >= job.deadline) throw Error('the original interrupt deadline expired before confirmation')
      const confirmed = outcome.state === 'succeeded'
      hold(id, confirmed ? 'Cancel is saved and interruption was confirmed; Restart is required before more input'
        : 'Cancel is saved; interruption is unconfirmed')
      finish(job, confirmed)
    } catch (error) {
      // A successful publication can be followed by a failed proof read. Adopt
      // only our exact proposed image on the frozen target, then retry its fresh
      // confirmation. This observation alone grants no journal/interrupt power.
      const visible = registry.byAgent(id)
      if (!job.saved && jobs.get(id) === job && visible && nativeTurnTarget(visible) === job.target
        && JSON.stringify(job.original.nativeControl) !== JSON.stringify(job.intent)
        && JSON.stringify(visible.nativeControl) === JSON.stringify(job.intent)) job.saved = structuredClone(visible)
      let original = true
      try { current(job) } catch { original = false }
      if (original) hold(id, error instanceof Error ? error.message : String(error))
      if (dispatched || !original) finish(job, false)
      // Before a capability is acquired, retry only this frozen association and
      // journal request. The caller deadline cannot be renewed by persistence.
    } finally {
      job.running = false; running--; job.nextAttempt = now() + 1000
      if (jobs.get(id) === job) { jobs.delete(id); jobs.set(id, job) }
      schedule()
    }
  }
  const pump = () => {
    let attempts = 0
    for (const job of [...jobs.values()]) {
      if (closed || running >= maxRunning || attempts >= maxRunning) break
      if (!job.running && now() >= job.nextAttempt) { attempts++; void run(job) }
    }
    schedule()
  }
  return {
    cancel(input: RegisteredSession): Promise<boolean> {
      if (closed) return Promise.resolve(false)
      const deadline = now() + 5000
      const original = structuredClone(input), id = original.agentId, target = nativeTurnTarget(original)
      const pending = jobs.get(id)
      if (pending && pending.target === target && JSON.stringify(original.nativeControl)
        === JSON.stringify((pending.saved ?? pending.original).nativeControl)) return pending.answer
      // Capture before revocation. A pending rearm has no known replacement;
      // preserve its obligation while revoking it with a distinct null Cancel.
      const reserved = original.nativeControl?.rearm
      let known: ReturnType<NativeCancelDeps['capture']>
      try { if (!reserved || reserved.replacement) known = capture(original) } catch { /* Retain an unknown owner. */ }
      const owner = known?.owner.agentId === id && known.owner.sessionId === original.sessionId ? known : undefined
      const intent = original.nativeControl && !reserved ? original.nativeControl : parseNativeTurnIntent({ version: 1,
        cancel: { processKey: owner?.owner.processKey ?? null, target,
          ...(owner?.namespace === undefined ? {} : { namespace: owner.namespace }), request: {
          requestId: randomUUID(), nonce: randomUUID(), agentId: id, conversationId: original.sessionId,
          frontier: owner?.frontier ?? { index: -1, digest: null },
        } }, ...(reserved && !reserved.replacement ? { rearm: { ...reserved, revoked: true } } : {}),
      })!
      revoke(original); writer.revoke(id)
      if (pending) finish(pending, false)
      if (!intent || jobs.size >= maxJobs) {
        hold(id, !intent ? 'the original cancellation evidence is invalid; input remains revoked'
          : 'the cancellation queue is full; input remains revoked')
        return Promise.resolve(false)
      }
      let resolve!: (value: boolean) => void
      const answer = new Promise<boolean>(done => { resolve = done })
      const job: Job = { original, intent, target, running: false, nextAttempt: now(), deadline, answer, resolve,
        timer: setTimeout(() => {
          try { current(job) } catch { finish(job, false); return }
          hold(id, job.confirmed ? 'the interrupt deadline expired; Cancel is saved and interruption is unconfirmed'
            : 'the interrupt deadline expired; the original request is retained locally, awaiting a confirmed save')
          resolve(false)
        }, Math.max(0, deadline - now())) }
      jobs.set(id, job); pump()
      return answer
    },
    close() {
      closed = true; clearTimeout(retry)
      for (const job of jobs.values()) { writer.revoke(job.original.agentId); finish(job, false) }
    },
  }
}
