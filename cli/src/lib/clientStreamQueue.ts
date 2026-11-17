import { CLIENT_STREAMS, CLIENT_STREAM_QUEUE_BYTES, CLIENT_STREAM_QUEUE_FRAMES } from './clientStreamContract.js'

/** Selected by the core's relay, never by a service frame or a client's payload. */
export interface ClientStreamQuota { service: string; direction: 'client' | 'service'; final?: boolean }

/** Counts bytes retained by transports, not bytes already delivered but awaiting stream credit. */
export function createClientStreamQueue() {
  const totals = new Map<string, { bytes: number; frames: number }>()
  for (const spec of CLIENT_STREAMS) for (const direction of ['client', 'service']) totals.set(`${spec.service}:${direction}`, { bytes: 0, frames: 0 })
  return {
    connection() {
      const charges = new Map<string, { bytes: number; frames: number }>()
      let closed = false
      return {
        reserve(quota: ClientStreamQuota, bytes: number): (() => void) | null {
          const key = `${quota.service}:${quota.direction}`, total = totals.get(key)
          if (closed || total === undefined || !Number.isSafeInteger(bytes) || bytes < 0
            || total.bytes + bytes > CLIENT_STREAM_QUEUE_BYTES || total.frames >= CLIENT_STREAM_QUEUE_FRAMES) return null
          let charged = charges.get(key)
          if (!charged) { charged = { bytes: 0, frames: 0 }; charges.set(key, charged) }
          total.bytes += bytes; total.frames++
          charged.bytes += bytes; charged.frames++
          let released = false
          return () => {
            if (released || closed) return
            released = true
            total.bytes -= bytes; total.frames--
            charged.bytes -= bytes; charged.frames--
          }
        },
        close(): void {
          if (closed) return
          closed = true
          for (const [key, charged] of charges) {
            const total = totals.get(key)!
            total.bytes -= charged.bytes; total.frames -= charged.frames
          }
          charges.clear()
        },
      }
    },
  }
}
