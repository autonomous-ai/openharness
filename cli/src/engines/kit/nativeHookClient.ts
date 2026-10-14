/** The native client retains every phase before its first send. This boundary
 * owns no Registry state and cannot fall back to a daemon-side mutation. */
import { inspectNativeHookOrigin, type NativeHookOrigin } from './nativeHookOrigin.js'
import { nativeHookOutboxShard, type NativeHookClientInput, type NativeHookClientDelivery } from './nativeHookOutbox.js'
import type { NativeHookStorage } from './nativeHookStorage.js'
import { nativeHookMutationRoute, readNativeHookAcknowledgement, type NativeHookClientPhase } from './nativeHookClientProtocol.js'

export interface NativeHookClientRequest {
  readonly port: number
  readonly path: string
  readonly id: string
  readonly firedAt: number
  readonly body: string
}
export interface NativeHookClientResult {
  owned: boolean
  /** Only fresh terminal receipts from this invocation, never cached ACK flags. */
  completed: readonly NativeHookClientPhase['name'][]
  reason?: string
}
interface NativeHookClientDeps {
  /** Capture the entry caller under a paired, still-live self/parent proof. */
  captureOrigin(): Promise<NativeHookOrigin>
  openStorage(): Promise<NativeHookStorage>
  /** Send exact retained bytes to the versioned path; return the receipt object
   * only from a complete bounded response. Ambiguous/legacy replies return none. */
  send(request: NativeHookClientRequest, current: () => boolean): Promise<unknown>
  timeoutMs: number
  retryDelayMs?: number
}

/** The deadline bounds the caller's wait. Real disk work and its cleanup retain
 * their own resources until completion, even after this reply expires. */
export async function deliverNativeHookClient(input: NativeHookClientInput, deps: NativeHookClientDeps): Promise<NativeHookClientResult> {
  // Freeze before the first await, including every linked phase and its route.
  const original = structuredClone(input)
  const deadline = performance.now() + Math.max(0, deps.timeoutMs)
  let expired = false, storage: NativeHookStorage | undefined, timer: ReturnType<typeof setTimeout> | undefined
  const current = () => !expired && performance.now() < deadline
  const check = () => { if (!current()) throw Error('the native hook delivery deadline was reached') }
  const hold = (reason: string): NativeHookClientResult => ({ owned: false, completed: [], reason: reason.slice(0, 1024) })
  const actual = (async (): Promise<NativeHookClientResult> => {
    try {
      check()
      const origin = inspectNativeHookOrigin(await deps.captureOrigin())
      check()
      for (const phase of original.phases) {
        if (phase.body.callerPid !== origin.callerPid) throw Error('the original native hook caller changed')
        phase.body.nativeOrigin = origin
      }
      storage = await deps.openStorage()
      check()
      const outbox = await storage.outbox(nativeHookOutboxShard(original.id), current)
      check()
      const retained = await outbox.retain(original)
      const owned = new Set(retained.phases.filter(phase => phase.acknowledged).map(phase => phase.name))
      const completed: NativeHookClientPhase['name'][] = []
      // One short-lived client takes a bounded share. The core's fair recovery
      // loop owns later attempts; neither path changes the original bytes.
      for (let attempt = 0; attempt < 4; attempt++) {
        check()
        for (const phase of retained.phases) {
          if (owned.has(phase.name)) continue
          check(); retained.verify(); check()
          const request = nativeHookClientRequest(retained, phase)
          const reply = await deps.send(request, current)
          check(); retained.verify(); check()
          const ack = readNativeHookAcknowledgement(reply, retained, phase)
          if (!ack) break
          await outbox.acknowledge(retained, phase.name)
          check(); retained.verify(); check()
          owned.add(phase.name)
          if (ack.outcome === 'complete') completed.push(phase.name)
        }
        if (owned.size === retained.phases.length) return { owned: true, completed }
        if (attempt < 3) await new Promise<void>(done => setTimeout(done, Math.min(deps.retryDelayMs ?? 250, Math.max(0, deadline - performance.now()))))
      }
      return hold('the original native hook is retained, waiting for confirmed core ownership')
    } finally {
      // Opening may finish after the deadline. Remember it before checking the
      // deadline so it still belongs to this cleanup path.
      await storage?.close()
    }
  })().catch(error => hold(error instanceof Error ? error.message : 'native hook storage is unavailable'))
  try {
    return await Promise.race([actual, new Promise<NativeHookClientResult>(done => {
      timer = setTimeout(() => { expired = true; done(hold('the native hook delivery deadline was reached')) }, Math.max(0, deps.timeoutMs))
    })])
  } finally { expired = true; clearTimeout(timer) }
}

export function nativeHookClientRequest(delivery: NativeHookClientDelivery, phase: NativeHookClientPhase): NativeHookClientRequest {
  return Object.freeze({ port: delivery.port, path: nativeHookMutationRoute(phase.path), id: delivery.id,
    firedAt: delivery.firedAt, body: phase.body })
}
