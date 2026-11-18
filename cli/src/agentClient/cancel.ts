import { randomUUID } from 'node:crypto'
import { connectSocket, type ClientSocket, type Connect, type Where } from './daemon.js'

export interface CancelBudget { reserve(payload: unknown): (() => void) | null }

/** One confirmed interrupt on an owner socket. A lost answer is never retried. */
export function cancelTurn(where: Where, agentId: string, current: () => boolean, signal: AbortSignal,
  budget: CancelBudget, connect: Connect = connectSocket): Promise<boolean> {
  if (!current() || signal.aborted || !where.machineId || where.machineId.length > 200 || !agentId || agentId.length > 200) return Promise.resolve(false)
  const requestId = randomUUID(), request = { type: 'cancel', payload: { agentId, requestId } }
  const release = budget.reserve({ machineId: where.machineId, request })
  if (!release) { console.warn('[wifi] CANCEL_BACKPRESSURE'); return Promise.resolve(false) }
  return new Promise(resolve => {
    let socket: ClientSocket | undefined
    let settled = false, closing = false, closed = false, selected = false, opened = false
    const close = (): void => {
      if (!socket || closing || closed) return
      closing = true
      try { socket.close() } catch { console.warn('[wifi] CANCEL_CLOSE_UNAVAILABLE') }
    }
    const settle = (ok: boolean, code?: string): void => {
      if (settled) return
      settled = true; clearTimeout(timer); signal.removeEventListener('abort', aborted)
      if (code) console.warn(`[wifi] ${code}`)
      resolve(ok && current() && !signal.aborted)
      // Only physical close releases the charge, even after a correlated reply.
      close()
    }
    const aborted = (): void => settle(false)
    const timer = setTimeout(() => settle(false, 'CANCEL_TIMEOUT'), 15_000)
    timer.unref?.()
    signal.addEventListener('abort', aborted, { once: true })
    void (async () => {
      try {
        socket = await connect(where)
        socket.on('close', () => { closed = true; release(); settle(false, 'CANCEL_UNAVAILABLE') })
        socket.on('error', () => settle(false, 'CANCEL_UNAVAILABLE'))
        socket.on('open', () => {
          if (settled || opened) return
          opened = true
          if (!current() || signal.aborted) { settle(false); return }
          try {
            // Negotiate questions without observing them: this one-shot caller needs no legacy replay.
            socket!.send(JSON.stringify({ type: 'machine_select', payload: {
              machineId: where.machineId, localProtocolVersion: 1, tool: true, questionProtocol: 1,
            } }))
          } catch { settle(false, 'CANCEL_UNAVAILABLE') }
        })
        socket.on('message', (raw, binary) => {
          if (settled) return
          if (!current() || signal.aborted) { settle(false); return }
          if (binary) { settle(false, 'CANCEL_PROTOCOL'); return }
          let frame: { type?: unknown; payload?: unknown }
          try {
            const text = raw.toString()
            if (Buffer.byteLength(text) > 4096) throw new Error('oversize')
            frame = JSON.parse(text)
            if (!frame || typeof frame !== 'object' || Array.isArray(frame)) throw new Error('frame')
          } catch { settle(false, 'CANCEL_PROTOCOL'); return }
          const value = frame.payload
          if (!value || typeof value !== 'object' || Array.isArray(value)) { settle(false, 'CANCEL_PROTOCOL'); return }
          const payload = value as Record<string, unknown>
          if (!selected && frame.type === 'connected') {
            if (!opened || payload.machineId !== where.machineId || payload.transport !== 'local' || payload.localProtocolVersion !== 1) {
              settle(false, 'CANCEL_PROTOCOL'); return
            }
            selected = true
            try { socket!.send(JSON.stringify(request)) } catch { settle(false, 'CANCEL_UNAVAILABLE') }
          } else if (selected && frame.type === 'cancel_result' && payload.requestId === requestId) {
            settle(payload.ok === true, payload.ok === true ? undefined : 'CANCEL_UNAVAILABLE')
          } else { settle(false, 'CANCEL_PROTOCOL') }
        })
        // A late connect still owns its charge until its newly observed socket physically closes.
        if (settled) close()
        else if (!current() || signal.aborted) settle(false)
      } catch {
        if (!socket) release()
        settle(false, 'CANCEL_UNAVAILABLE')
      }
    })()
  })
}
