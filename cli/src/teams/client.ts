import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { WebSocket } from 'ws'
import { localSocketPath } from '../lib/localSocket.js'
import { TeamError } from './model.js'

/** All operations, including cross-machine ones, use the daemon's existing authenticated relay. */
export function teamRpc(options: { port: number; machineId: string; dataDir?: string; signal?: AbortSignal }, type: 'team' | 'team_delivery', payload: Record<string, unknown>, timeoutMs = 25_000): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const socketPath = options.dataDir ? localSocketPath(options.dataDir, options.port) : null
    const ws = socketPath && existsSync(socketPath)
      ? new WebSocket(`ws+unix://${socketPath}:/api/local-ws`)
      : new WebSocket(`ws://127.0.0.1:${options.port}/api/local-ws`)
    const requestId = randomBytes(16).toString('hex')
    let finished = false, selected = false
    const finish = (error: Error | null, value?: Record<string, unknown>): void => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', abort)
      if (ws.readyState === WebSocket.CONNECTING) ws.terminate(); else ws.close()
      if (error) reject(error); else resolve(value!)
    }
    const timer = setTimeout(() => finish(new TeamError('UNCONFIRMED', 'The daemon did not confirm this request. Check status or retry with the same operation ID.')), timeoutMs)
    const abort = () => finish(new TeamError('READ_CANCELLED', 'The view was closed. Daemon work is unchanged.'))
    ws.on('error', () => finish(new TeamError('DAEMON_UNREACHABLE', 'The local Harness daemon is unavailable.')))
    ws.on('close', (code) => finish(new TeamError(code === 4404 ? 'NO_PEER_LINK' : 'DISCONNECTED', code === 4404
      ? 'Pair this machine in Harness before connecting its agents.' : 'The daemon connection closed. Reconcile the same operation ID.')))
    ws.on('open', () => ws.send(JSON.stringify({ type: 'machine_select', payload: { machineId: options.machineId, localProtocolVersion: 1 } })))
    ws.on('message', (raw, binary) => {
      if (binary || finished) return
      try {
        const frame = JSON.parse(raw.toString())
        if (frame.type === 'machine_select_error') { finish(new TeamError(frame.payload?.error ?? 'MACHINE_UNAVAILABLE', 'The team machine is unavailable.')); return }
        if (frame.type === 'connected' && !selected) {
          selected = true
          ws.send(JSON.stringify({ type, payload: { ...payload, requestId } }))
        }
        if (frame.type === `${type}_result` && frame.payload?.requestId === requestId) {
          if (frame.payload.error) finish(new TeamError(String(frame.payload.error), String(frame.payload.detail ?? frame.payload.error)))
          else finish(null, frame.payload)
        }
      } catch { finish(new TeamError('INVALID_RESPONSE', 'The daemon returned an invalid team response.')) }
    })
    options.signal?.addEventListener('abort', abort, { once: true })
    if (options.signal?.aborted) abort()
  })
}
