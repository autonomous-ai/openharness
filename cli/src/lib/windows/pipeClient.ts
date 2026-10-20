/**
 * One HTTP request to the daemon's Windows pipe (lib/localSocket.ts `listenAuthenticated`). It sends a fresh auth,
 * and takes the answer only when it proves the token. The request has reached whatever listens by then. That is
 * why callers first check that the daemon in the record is not proven gone (daemonPipe.ts `daemonPipe`).
 */
import http, { type IncomingHttpHeaders } from 'node:http'
import net from 'node:net'
import { WebSocket } from 'ws'
import { newPipeNonce, PIPE_AUTH_HEADER, pipeAuthValue, pipeProven } from './pipeAuth.js'

export interface PipeTarget { pipe: string; token: Buffer }
export interface PipeRequest {
  method: string
  path: string
  headers?: Record<string, string>
  body?: string
  /** 30 s by default. */
  timeoutMs?: number
  /** 4 MiB by default. */
  maxBytes?: number
}
export interface PipeReply { status: number; headers: IncomingHttpHeaders; body: string }

/** Something answered on the pipe without the daemon's proof: it is not this user's daemon. */
export class PipeUnproven extends Error {
  readonly code = 'PIPE_UNPROVEN'
  constructor(pipe: string) {
    super(`Something other than Harness answered on its local pipe (${pipe}). Restart Harness: harness stop && harness start`)
  }
}

/** Whether [error] is nothing listening at the endpoint, so the request never reached anything. */
export function pipeAbsent(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code
  return code === 'ENOENT' || code === 'ECONNREFUSED'
}

export function pipeRequest(target: PipeTarget, request: PipeRequest): Promise<PipeReply> {
  const nonce = newPipeNonce(target.pipe)
  const maxBytes = request.maxBytes ?? 4 * 1024 * 1024
  return new Promise((resolve, reject) => {
    const outgoing = http.request({
      socketPath: target.pipe,
      method: request.method,
      path: request.path,
      agent: false,
      headers: { ...request.headers, [PIPE_AUTH_HEADER]: pipeAuthValue(target.token, nonce) },
      signal: AbortSignal.timeout(request.timeoutMs ?? 30_000),
    }, (response) => {
      // Before the body is read: an answer that is not the daemon's is never taken. Each reject comes before its
      // destroy, so the error the caller sees is this one, not the aborted response's.
      if (!pipeProven(response.headers, target.token, nonce)) {
        reject(new PipeUnproven(target.pipe))
        outgoing.destroy()
        return
      }
      let body = ''
      let bytes = 0
      response.setEncoding('utf8')
      response.on('data', (chunk: string) => {
        bytes += Buffer.byteLength(chunk)
        if (bytes <= maxBytes) { body += chunk; return }
        reject(new Error(`the daemon's answer is too large (over ${maxBytes} bytes)`))
        outgoing.destroy()
      })
      response.on('error', reject)
      response.on('end', () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body }))
    })
    outgoing.on('error', reject)
    outgoing.end(request.body)
  })
}

/**
 * The daemon's local WebSocket over its Windows pipe, for every client that talks frames to it (the agent verbs'
 * agentClient/daemon.ts `connectSocket`, `harness send`'s messages/rpc.ts). It carries the pipe auth and no local
 * credential: on Windows that credential never goes to a port, whose listener may be another OS user's or a stale
 * daemon's.
 */
export function pipeWebSocket(target: PipeTarget, path = '/api/local-ws'): WebSocket {
  const nonce = newPipeNonce(target.pipe)
  const socket = new WebSocket(`ws://localhost${path}`, {
    createConnection: () => net.connect(target.pipe),
    headers: { [PIPE_AUTH_HEADER]: pipeAuthValue(target.token, nonce) },
  })
  // A squatter can accept the upgrade after the recorded daemon died. Its 101 is rejected before WebSocket's
  // `open`, so a caller that sends its first frame on `open` sends it nothing.
  socket.on('upgrade', (response) => {
    if (!pipeProven(response.headers, target.token, nonce)) socket.terminate()
  })
  return socket
}
