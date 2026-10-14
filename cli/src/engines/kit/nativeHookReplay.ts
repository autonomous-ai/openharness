/** Fair retries of retained client bytes. This owns transport and acknowledgement,
 * never caller identity, registration, turn effects or offline Registry writes. */
import { nativeHookClientRequest, type NativeHookClientRequest } from './nativeHookClient.js'
import { readNativeHookAcknowledgement } from './nativeHookClientProtocol.js'
import { NATIVE_HOOK_OUTBOX_SHARDS } from './nativeHookOutbox.js'
import type { NativeHookStorage } from './nativeHookStorage.js'

interface NativeHookReplayDeps {
  readOutbox: NativeHookStorage['readOutbox']
  send(request: NativeHookClientRequest, current: () => boolean, remainingMs: number): Promise<unknown>
  onHeld(shard: number, id: string | undefined, reason: string | undefined): void
  timeoutMs?: number
  intervalMs?: number
}

/** Construction does no work; core calls start only after announcing readiness.
 * A deadline revokes the attempt, but its slot belongs to actual I/O and cleanup. */
export function createNativeHookReplay(deps: NativeHookReplayDeps) {
  const active = new Map<number, Promise<void>>(), lastIds = new Map<number, string>()
  type Attempt = { deadline: number; expired: boolean }
  let progressing: Attempt | undefined
  let closed = false, started = false, cursor = 0, timer: ReturnType<typeof setTimeout> | undefined
  const alive = (attempt: Attempt) => !closed && !attempt.expired && performance.now() < attempt.deadline
  const report = (shard: number, id: string | undefined, reason: string | undefined) => {
    if (closed) return
    try { deps.onHeld(shard, id, reason?.slice(0, 1024)) } catch { /* A display callback cannot orphan cleanup. */ }
  }
  const attempt = async (shard: number, owner: Attempt) => {
    const deadline = owner.deadline
    let id: string | undefined, outbox: Awaited<ReturnType<NativeHookStorage['readOutbox']>>
    const current = () => alive(owner)
    const check = () => { if (!current()) throw Error('the retained native hook retry deadline was reached') }
    const expiry = setTimeout(() => {
      owner.expired = true; report(shard, id, 'Waiting for the retained native hook retry to finish its actual I/O.')
    }, Math.max(0, deadline - performance.now()))
    try {
      check()
      outbox = await deps.readOutbox(shard, current)
      check()
      if (!outbox) { report(shard, undefined, undefined); return }
      const snapshot = await outbox.snapshot()
      check(); snapshot.verify(); check()
      const pending = [...snapshot.deliveries.values()].filter(delivery => delivery.phases.some(phase => !phase.acknowledged))
        .sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
      const delivery = pending.find(item => item.id > (lastIds.get(shard) ?? '')) ?? pending[0]
      if (!delivery) { report(shard, undefined, undefined); return }
      id = delivery.id
      // Advance before transport. One held ID cannot hide later IDs in its shard.
      lastIds.set(shard, id)
      for (const phase of delivery.phases) {
        if (phase.acknowledged) continue
        check(); delivery.verify(); check()
        const reply = await deps.send(nativeHookClientRequest(delivery, phase), current, Math.max(1, deadline - performance.now()))
        check(); delivery.verify(); check()
        if (!readNativeHookAcknowledgement(reply, delivery, phase)) {
          report(shard, id, 'Waiting for confirmed core ownership of the retained native hook.'); return
        }
        await outbox.acknowledge(delivery, phase.name)
        check(); delivery.verify(); check()
      }
      report(shard, id, undefined)
    } catch (error) {
      if (!owner.expired) report(shard, id, error instanceof Error ? error.message : 'Retained native hook storage is unavailable.')
    } finally {
      owner.expired = true
      // A late opener is still owned here. Revocation cannot leak its handle.
      try { await outbox?.close() } finally { clearTimeout(expiry) }
    }
  }
  const pass = () => {
    if (closed) return
    // Four simultaneous productive retries spent each other's deadlines doing
    // synchronous authority checks and invalidated each other's catalog scans.
    // Serialize live attempts. Expired I/O still owns its slot, but cannot keep
    // the next shard from progressing; four actual operations remain the cap.
    for (let visited = 0; visited < NATIVE_HOOK_OUTBOX_SHARDS && active.size < 4 && (!progressing || !alive(progressing)); visited++) {
      const shard = cursor++ % NATIVE_HOOK_OUTBOX_SHARDS
      if (active.has(shard)) continue
      // Defer invocation until its capacity reservation is visible, including to
      // synchronously reentrant dependencies. Release only after actual cleanup.
      const owner = { deadline: performance.now() + (deps.timeoutMs ?? 4500), expired: false }
      progressing = owner
      const actual = Promise.resolve().then(() => attempt(shard, owner)).finally(() => { active.delete(shard) })
      active.set(shard, actual)
      void actual.catch(error => report(shard, undefined, error instanceof Error ? error.message : 'Native hook cleanup is unavailable.'))
    }
    timer = setTimeout(pass, deps.intervalMs ?? 500); timer.unref()
  }
  return {
    start() {
      if (started || closed) return
      started = true
      timer = setTimeout(pass, 0); timer.unref()
    },
    async close() {
      closed = true; clearTimeout(timer)
      await Promise.allSettled([...active.values()])
    },
  }
}
