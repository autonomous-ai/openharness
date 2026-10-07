import { randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Asker } from '../core/api.js'
import { isTrustedLocal } from './localSocket.js'

/**
 * Where the HTTP door sends what it was asked: the command bar's `command_bar_http` request
 * (services/commandBar.ts), asked on `connection`, which `closed` says ended before its answer.
 */
export interface CommandBarDoor {
  ask(payload: Record<string, unknown>, connection: string): Promise<Record<string, unknown>>
  closed(connection: string): void
}

/** The daemon's door: through the core's service router, as a process on this computer, so that the
 *  command bar is reached wherever it runs, and refused SERVICE_UNAVAILABLE while it is off or down. */
export function routedCommandBar(socket: {
  serviceRouter: ((type: string, payload: Record<string, unknown>, asker: Asker, reply: (result: Record<string, unknown>) => void) => boolean) | null
  onConnectionClosed: ((connId: string) => void) | null
}): CommandBarDoor {
  return {
    ask: (payload, connection) => new Promise((resolve) => {
      if (!socket.serviceRouter?.('command_bar_http', payload, { local: true, owner: true, connection }, resolve)) resolve({ error: 'SERVICE_UNAVAILABLE' })
    }),
    closed: (connection) => { socket.onConnectionClosed?.(connection) },
  }
}

/** Shared by the daemon and the isolated experiment server. Returns false for other routes. */
export async function handleCommandBarHttp(req: IncomingMessage, res: ServerResponse, door?: CommandBarDoor): Promise<boolean> {
  const path = (req.url ?? '').split('?')[0]
  if (path !== '/api/command-bar/status' && path !== '/api/command-bar/resolve') return false
  const json = (status: number, body: unknown) => {
    if (res.destroyed) return
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
    res.end(JSON.stringify(body))
  }
  const fail = (status: number, code: string, message: string) => json(status, { success: false, error: { code, message } })
  const peer = req.socket.remoteAddress
  const loopback = isTrustedLocal(req) || peer === '127.0.0.1' || peer === '::1' || peer === '::ffff:127.0.0.1'
  if (req.headers['x-adapter-local'] !== '1' || !loopback || req.headers.origin) {
    fail(403, 'FORBIDDEN', 'Native local client required.'); return true
  }
  if (!door) { fail(503, 'UNAVAILABLE', 'Start the command bar experiment server or updated daemon.'); return true }
  const isStatus = path.endsWith('/status')
  if (req.method !== (isStatus ? 'GET' : 'POST')) { fail(405, 'METHOD', 'Unsupported method.'); return true }
  // Each request is a connection of its own to the command bar: a client that goes before its answer
  // has its decision aborted, as when the decision ran in this process.
  const connection = `http:${randomUUID()}`
  let uploadTimer: ReturnType<typeof setTimeout> | undefined
  const onClose = () => { if (!res.writableEnded) door.closed(connection) }
  res.on('close', onClose)
  try {
    let body: unknown
    if (!isStatus) {
      const chunks: Buffer[] = []
      let length = 0
      // Bound upload time and bytes too; an incomplete body must not keep a request alive forever.
      uploadTimer = setTimeout(() => req.destroy(), 10_000)
      for await (const chunk of req.iterator({ destroyOnReturn: false })) {
        length += Buffer.byteLength(chunk)
        if (length > 128_000) { fail(413, 'INVALID_REQUEST', 'Command context is too large.'); req.resume(); return true }
        chunks.push(Buffer.from(chunk))
      }
      clearTimeout(uploadTimer)
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')) }
      catch { fail(400, 'INVALID_REQUEST', 'Invalid command request.'); return true }
    }
    const answer = await door.ask(isStatus ? { route: 'status' } : { route: 'resolve', body }, connection)
    if (typeof answer.status === 'number' && answer.body && typeof answer.body === 'object') json(answer.status, answer.body)
    // The command bar is an experiment, off or restarting: said plainly, never as a failure of the request.
    else if (answer.error === 'SERVICE_UNAVAILABLE') fail(503, 'UNAVAILABLE', 'The command bar is off or restarting. Choose an action below, or try again in a moment.')
    else fail(502, 'UNAVAILABLE', 'Command bar unavailable.')
  } catch {
    fail(502, 'UNAVAILABLE', 'Command bar unavailable.')
  } finally { clearTimeout(uploadTimer); res.off('close', onClose) }
  return true
}
