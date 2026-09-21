import type { IncomingMessage, ServerResponse } from 'node:http'
import { CommandBarError, type CommandBarService } from './commandBar.js'

/** Shared by the daemon and the isolated experiment server. Returns false for other routes. */
export async function handleCommandBarHttp(
  req: IncomingMessage, res: ServerResponse, service?: Pick<CommandBarService, 'status' | 'decide'>,
): Promise<boolean> {
  const path = (req.url ?? '').split('?')[0]
  if (path !== '/api/command-bar/status' && path !== '/api/command-bar/resolve') return false
  const json = (status: number, body: unknown) => {
    if (res.destroyed) return
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
    res.end(JSON.stringify(body))
  }
  const fail = (status: number, code: string, message: string) => json(status, { success: false, error: { code, message } })
  const peer = req.socket.remoteAddress
  const loopback = peer === '127.0.0.1' || peer === '::1' || peer === '::ffff:127.0.0.1'
  if (req.headers['x-adapter-local'] !== '1' || !loopback || req.headers.origin) {
    fail(403, 'FORBIDDEN', 'Native local client required.'); return true
  }
  if (!service) { fail(503, 'UNAVAILABLE', 'Start the command bar experiment server or updated daemon.'); return true }
  const isStatus = path.endsWith('/status')
  if (req.method !== (isStatus ? 'GET' : 'POST')) { fail(405, 'METHOD', 'Unsupported method.'); return true }
  const abort = new AbortController()
  let uploadTimer: ReturnType<typeof setTimeout> | undefined
  const onClose = () => { if (!res.writableEnded) abort.abort() }
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
    const data = isStatus ? await service.status() : await service.decide(body, abort.signal)
    json(200, { success: true, data })
  } catch (error) {
    if (error instanceof CommandBarError) fail(error.status, error.code, error.message)
    else fail(502, 'UNAVAILABLE', 'Command bar unavailable.')
  } finally { clearTimeout(uploadTimer); res.off('close', onClose) }
  return true
}
