/** Native hooks identify generations, not the request that typed their prompt.
 * Keep terminal delivery separate from execution: never match by text, clear the
 * composer on a hook, or repeat an Enter whose dispatch is uncertain. */
import type { RegisteredSession } from '../../lib/registry.js'
import type { NativeSessionInputPort, SessionInputDelivery } from '../../lib/sessionInput.js'
import { TerminalWriteHeld, type TerminalActionResult, type TerminalWrite } from '../../lib/terminalTypes.js'
import { outsideConsumers } from './funnel.js'

export interface NativeInputAdmission {
  owns(id: string): boolean
  /** A short-lived, original-owner and complete-frontier proof. It is checked
   * again inside every actual paste/key dispatch after optional screen reads. */
  prepare(original: RegisteredSession, purpose?: 'control' | 'answer'): Promise<{ verify(): void }>
  blocksControl(id: string, forAnswer: boolean): boolean
  held(id: string, reason: string | undefined): void
}
export interface NativeInputDeps {
  admission: NativeInputAdmission
  resolve(id: string): RegisteredSession | undefined
  /** This ticket retains the shared writer epoch, not a temporary read hold.
   * The terminal adapter captures fresh pane evidence for each actual attempt. */
  reserve(id: string): { write: TerminalWrite; release(): void } | undefined
  run<T>(id: string, write: TerminalWrite, operation: (write: TerminalWrite) => Promise<T>, signal: AbortSignal): Promise<T>
  write(id: string, content: string, write: TerminalWrite, deliveryId?: string): Promise<TerminalActionResult>
  /** A service may withdraw its own delivery while a native/screen read waits.
   * An unavailable service holds it; only explicit cancellation removes it. */
  canWrite?(deliveryId: string): boolean
  delivery(event: SessionInputDelivery): void
  retryMs?: number
  maxAgents?: number
  maxQueued?: number
  maxBytes?: number
}

export function createNativeInput({ admission, resolve, reserve, run, write, delivery, canWrite = () => true,
  retryMs = 1000, maxAgents = 256, maxQueued = 64, maxBytes = 1024 * 1024,
}: NativeInputDeps): NativeSessionInputPort & { close(): void; wake(id: string): void } {
  type Item = { original: RegisteredSession; content: string; bytes: number; deliveryId?: string;
    authority?: { write: TerminalWrite; release(): void }; abort: AbortController; alive: boolean; dispatched: boolean }
  type Lane = { items: Item[]; running: boolean; timer?: ReturnType<typeof setTimeout> }
  const lanes = new Map<string, Lane>()
  const notify = outsideConsumers({ prefix: 'native-input' })
  const hold = (id: string, reason: string | undefined) => notify('hold', () => admission.held(id, reason))
  let closed = false
  const tell = (id: string, item: Item, state: SessionInputDelivery['state'], reason?: string) => {
    if (item.deliveryId) notify('delivery', () => delivery({ sessionId: id, deliveryId: item.deliveryId!, state, ...(reason ? { reason } : {}) }))
  }
  const later = (id: string, lane: Lane) => {
    if (closed || lanes.get(id) !== lane || lane.timer || !lane.items.length) return
    lane.timer = setTimeout(() => { lane.timer = undefined; void pump(id, lane) }, retryMs)
  }
  const pump = async (id: string, lane: Lane): Promise<void> => {
    if (closed || lanes.get(id) !== lane || lane.running || !lane.items.length) return
    const item = lane.items[0]
    lane.running = true
    const current = () => !closed && lanes.get(id) === lane && item.alive && item.authority!.write.allowed()
    let outcome: 'delivered' | 'unknown' | undefined, reason: string | undefined
    const caller = () => {
      if (item.deliveryId && !canWrite(item.deliveryId)) throw new TerminalWriteHeld('Waiting for the sender to confirm this queued message.')
    }
    try {
      caller()
      item.authority ??= reserve(id)
      if (!item.authority) throw new TerminalWriteHeld('Waiting for terminal writer capacity.')
      if (!current()) throw new TerminalWriteHeld('Waiting for the original native input owner. Restart explicitly to continue.')
      const result = await run(id, item.authority.write, async owned => {
        const permit = await admission.prepare(item.original)
        const verify = () => {
          permit.verify()
          caller()
          if (!current() || !owned.allowed()) throw new TerminalWriteHeld('Waiting for the original native input owner.')
        }
        const dispatch: TerminalWrite = {
          allowed: () => { try { verify(); return true } catch { return false } },
          dispatch: operation => owned.dispatch(() => { verify(); item.dispatched = true; return operation() }),
        }
        verify()
        return write(id, item.content, dispatch, item.deliveryId)
      }, item.abort.signal)
      if (result.dispatch === 'executed') outcome = 'delivered'
      else if (item.dispatched || result.dispatch === 'possibly_executed') {
        outcome = 'unknown'; reason = 'dispatch_ambiguous'
      } else reason = result.reason
    } catch (error) {
      if (item.dispatched) { outcome = 'unknown'; reason = 'dispatch_ambiguous' }
      else reason = error instanceof Error ? error.message : String(error)
    } finally {
      lane.running = false
      if (item.alive && lanes.get(id) === lane) {
        if (outcome) {
          item.alive = false
          item.authority?.release()
          lane.items.shift()
          tell(id, item, outcome, reason)
          hold(id, outcome === 'unknown' ? 'The input may have been sent. It will not be sent again automatically.' : undefined)
        } else hold(id, reason)
      }
      // An unavailable reader or exhausted writer keeps the original item. It
      // has no expiry that could silently turn an outage into a failed message.
      if (!lane.items.length && lanes.get(id) === lane) lanes.delete(id)
      else later(id, lane)
    }
  }
  const forget = (id: string): void => {
    const lane = lanes.get(id)
    if (!lane) return
    lanes.delete(id)
    if (lane.timer) clearTimeout(lane.timer)
    for (const item of lane.items) {
      item.alive = false
      item.authority?.release()
      item.abort.abort()
      tell(id, item, item.dispatched ? 'unknown' : 'rejected', 'agent_gone')
    }
  }
  return {
    owns: id => admission.owns(id),
    submit(id, content, deliveryId) {
      const found = resolve(id)
      if (closed || !found) return
      id = found.agentId
      const bytes = Buffer.byteLength(content), previous = lanes.get(id)
      if ((!previous && lanes.size >= maxAgents) || (previous?.items.length ?? 0) >= maxQueued
        || (previous?.items.reduce((sum, item) => sum + item.bytes, 0) ?? 0) + bytes > maxBytes) {
        hold(id, 'Native input capacity is full. This new message has not been queued; keep it and retry.')
        if (deliveryId) notify('delivery', () => delivery({ sessionId: id, deliveryId, state: 'rejected', reason: 'queue_full' }))
        return
      }
      const lane = previous ?? { items: [], running: false }
      const item: Item = { original: structuredClone(found), content, bytes, deliveryId,
        authority: reserve(id), abort: new AbortController(), alive: true, dispatched: false }
      lanes.set(id, lane)
      lane.items.push(item)
      tell(id, item, 'queued')
      void pump(id, lane)
    },
    blocksControl: (id, forAnswer) => {
      const lane = lanes.get(resolve(id)?.agentId ?? id)
      return !!(lane?.running || (!forAnswer && lane?.items.length)) || admission.blocksControl(id, forAnswer)
    },
    cancelDelivery(deliveryId) {
      for (const [id, lane] of lanes) {
        const index = lane.items.findIndex(item => item.deliveryId === deliveryId && !item.dispatched)
        if (index < 0) continue
        const [item] = lane.items.splice(index, 1)
        item.alive = false
        item.authority?.release()
        item.abort.abort()
        tell(id, item, 'rejected', 'cancelled')
        if (!lane.running) { if (!lane.items.length) forget(id); else later(id, lane) }
        return true
      }
      return false
    },
    forget,
    wake(id) { const lane = lanes.get(id); if (lane) void pump(id, lane) },
    close() { closed = true; for (const id of lanes.keys()) forget(id) },
  }
}
