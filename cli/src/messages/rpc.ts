/**
 * One `agent_messages` request to a machine's daemon, through this daemon's own local socket: to another of the
 * owner's machines the daemon carries it over the paired E2EE relay (localWsServer `machine_select`). `harness
 * send` reaches its own daemon the same way.
 */
import { randomBytes } from 'node:crypto'
import { env } from '../config/env.js'
import { localCredentialHeaders } from '../lib/localCredential.js'
import { existsSync } from 'node:fs'
import { WebSocket } from 'ws'
import { localSocketPath } from '../lib/localSocket.js'
import { NOT_RUNNING, pidIn, unreachableText } from '../lib/unreachable.js'
import { MessageError } from './model.js'

/** The machine answered, and its answer was a refusal: told apart from a machine that could not be asked, so that a
 *  forwarded request's refusal (sharedTabs.ts `addHarness`) reaches the person as that machine said it rather than as
 *  a machine away. */
export class RefusedError extends MessageError {}

export interface RpcTarget { port: number; machineId: string; dataDir?: string; signal?: AbortSignal }
export type Rpc = (target: RpcTarget, payload: Record<string, unknown>, timeoutMs?: number) => Promise<Record<string, unknown>>

export const messagesRpc: Rpc = (target, payload, timeoutMs = 20_000) => new Promise((resolve, reject) => {
  const socketPath = target.dataDir ? localSocketPath(target.dataDir, target.port) : null
  const ws = socketPath && existsSync(socketPath)
    ? new WebSocket(`ws+unix://${socketPath}:/api/local-ws`)
    : new WebSocket(`ws://127.0.0.1:${target.port}/api/local-ws`, { headers: localCredentialHeaders(target.dataDir ?? env.ADAPTER_DATA_DIR) })
  const requestId = randomBytes(16).toString('hex')
  let finished = false, selected = false
  const finish = (error: Error | null, value?: Record<string, unknown>): void => {
    if (finished) return
    finished = true
    clearTimeout(timer)
    target.signal?.removeEventListener('abort', abort)
    if (ws.readyState === WebSocket.CONNECTING) ws.terminate(); else ws.close()
    if (error) reject(error); else resolve(value!)
  }
  const timer = setTimeout(() => finish(new MessageError('UNCONFIRMED', 'The daemon did not answer in time.')), timeoutMs)
  const abort = () => finish(new MessageError('CANCELLED', 'Cancelled.'))
  ws.on('error', (error) => finish(new MessageError('DAEMON_UNREACHABLE', target.dataDir ? unreachableText({ error, pid: pidIn(target.dataDir) }) : NOT_RUNNING)))
  ws.on('close', (code) => finish(new MessageError(code === 4404 ? 'NO_PEER_LINK' : 'DISCONNECTED', code === 4404
    ? 'That machine is not paired with this one.' : 'The daemon connection closed.')))
  ws.on('open', () => ws.send(JSON.stringify({ type: 'machine_select', payload: { machineId: target.machineId, localProtocolVersion: 1 } })))
  ws.on('message', (raw, binary) => {
    if (binary || finished) return
    try {
      const frame = JSON.parse(raw.toString())
      if (frame.type === 'machine_select_error') { finish(new MessageError(String(frame.payload?.error ?? 'MACHINE_UNAVAILABLE'), 'That machine is unavailable.')); return }
      if (frame.type === 'connected' && !selected) {
        selected = true
        ws.send(JSON.stringify({ type: 'agent_messages', payload: { ...payload, requestId } }))
      }
      if (frame.type === 'agent_messages_result' && frame.payload?.requestId === requestId) {
        if (frame.payload.error) finish(new RefusedError(String(frame.payload.error), String(frame.payload.detail ?? frame.payload.error)))
        else finish(null, frame.payload)
      }
    } catch { finish(new MessageError('INVALID_RESPONSE', 'The daemon answered something that is not a message reply.')) }
  })
  target.signal?.addEventListener('abort', abort, { once: true })
  if (target.signal?.aborted) abort()
})
