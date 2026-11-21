import { randomUUID } from 'node:crypto'
import type { ClientSocket, Connect, Where } from './daemon.js'

export interface RequestBudget { reserve(payload: unknown): (() => void) | null }

/** One correlated owner request; capacity remains held until the socket physically closes. */
export function requestOnce(where: Where, type: 'cancel' | 'grid_launch_context' | 'harness_device_step', payload: Record<string, unknown>,
  current: () => boolean, signal: AbortSignal, budget: RequestBudget, timeoutMs: number,
  diagnostic: (code: string) => void, connect: Connect): Promise<Record<string, unknown> | null> {
  if (!current() || signal.aborted || !where.machineId || where.machineId.length > 200) return Promise.resolve(null)
  const requestId = randomUUID(), request = { type, payload: { ...payload, requestId } }
  const release = budget.reserve({ machineId: where.machineId, request })
  if (!release) { diagnostic('BACKPRESSURE'); return Promise.resolve(null) }
  return new Promise(resolve => {
    let socket: ClientSocket | undefined
    let settled = false, closing = false, closed = false, selected = false, opened = false
    const close = (): void => {
      if (!socket || closing || closed) return
      closing = true
      try { socket.close() } catch { diagnostic('CLOSE_UNAVAILABLE') }
    }
    const settle = (answer: Record<string, unknown> | null, code?: string): void => {
      if (settled) return
      settled = true; clearTimeout(timer); signal.removeEventListener('abort', aborted)
      if (code) diagnostic(code)
      resolve(current() && !signal.aborted ? answer : null)
      // Only physical close releases the charge, even after a correlated reply.
      close()
    }
    const aborted = (): void => settle(null)
    const timer = setTimeout(() => settle(null, 'TIMEOUT'), timeoutMs)
    timer.unref?.()
    signal.addEventListener('abort', aborted, { once: true })
    void (async () => {
      try {
        socket = await connect(where)
        socket.on('close', () => { closed = true; release(); settle(null, 'UNAVAILABLE') })
        socket.on('error', () => settle(null, 'UNAVAILABLE'))
        socket.on('open', () => {
          if (settled || opened) return
          opened = true
          if (!current() || signal.aborted) { settle(null); return }
          try {
            // Negotiate questions without observing them: a one-shot caller needs no legacy replay.
            socket!.send(JSON.stringify({ type: 'machine_select', payload: {
              machineId: where.machineId, localProtocolVersion: 1, tool: true, questionProtocol: 1,
            } }))
          } catch { settle(null, 'UNAVAILABLE') }
        })
        socket.on('message', (raw, binary) => {
          if (settled) return
          if (!current() || signal.aborted) { settle(null); return }
          if (binary) { settle(null, 'PROTOCOL'); return }
          let frame: { type?: unknown; payload?: unknown }
          try {
            const text = raw.toString()
            if (Buffer.byteLength(text) > (type === 'grid_launch_context' ? 32 * 1024 : 4096)) throw new Error('oversize')
            frame = JSON.parse(text)
            if (!frame || typeof frame !== 'object' || Array.isArray(frame)) throw new Error('frame')
          } catch { settle(null, 'PROTOCOL'); return }
          const value = frame.payload
          if (!value || typeof value !== 'object' || Array.isArray(value)) { settle(null, 'PROTOCOL'); return }
          const payload = value as Record<string, unknown>
          if (!selected && frame.type === 'connected') {
            if (!opened || payload.machineId !== where.machineId || payload.transport !== 'local' || payload.localProtocolVersion !== 1) {
              settle(null, 'PROTOCOL'); return
            }
            selected = true
            try { socket!.send(JSON.stringify(request)) } catch { settle(null, 'UNAVAILABLE') }
          } else if (selected && frame.type === `${type}_result` && payload.requestId === requestId) {
            settle(payload)
          } else { settle(null, 'PROTOCOL') }
        })
        // A late connect still owns its charge until its newly observed socket physically closes.
        if (settled) close()
        else if (!current() || signal.aborted) settle(null)
      } catch {
        if (!socket) release()
        settle(null, 'UNAVAILABLE')
      }
    })()
  })
}
