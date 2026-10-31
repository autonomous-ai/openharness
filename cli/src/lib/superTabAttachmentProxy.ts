/**
 * A Super Tab chat file from the native desktop, on its way to the backend. The app's REST client talks only to this
 * daemon over localhost and holds no account token (the browser build holds its own), so the daemon passes this one
 * upload on with the account's token: localhost in, HTTPS straight to the backend out, never the relay.
 *
 * The body is streamed, never held whole, and stops one byte past the cap. The backend's answer (its status and its
 * small JSON body) is handed back as it came.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable, Transform } from 'node:stream'

/** The most one file sent by this multipart route may be. A larger one, up to 256 MB, goes straight to storage by a signed
 *  link (superTabs/attach.ts): production sits behind Cloudflare, which may refuse a request body over 100 MB. */
export const MAX_FORM_ATTACHMENT_BYTES = 10 * 1024 * 1024
/** The form's file and its multipart framing, a few hundred bytes. */
export const ATTACHMENT_UPLOAD_MAX_BYTES = MAX_FORM_ATTACHMENT_BYTES + 1024 * 1024
/** Said of a form past that cap. Every client sends a file over 10 MB by the link, and an older one refused it before
 *  sending, so only a client in error meets this. */
const TOO_LARGE = 'A file can be at most 10 MB.'
/** No bytes moving for this long ends an upload: a slow uplink keeps going, a stalled one does not hold the request. */
export const ATTACHMENT_IDLE_MS = 30_000
/** The ceiling however steadily it moves: 11 MB at about 100 kbit/s. */
export const ATTACHMENT_TOTAL_MS = 15 * 60_000

class TooLarge extends Error {}

export interface AttachmentProxyDeps {
  /** The account's token, refreshed by the core's session manager as it does for every backend call. */
  accessToken: () => Promise<string>
  environment: string
  base: string
  fetch?: typeof fetch
  maxBytes?: number
  idleMs?: number
  totalMs?: number
}

export async function forwardAttachmentUpload(req: IncomingMessage, res: ServerResponse, path: string, deps: AttachmentProxyDeps): Promise<void> {
  const answer = (status: number, code: string, message: string) => {
    if (res.headersSent) { res.destroy(); return }
    res.writeHead(status, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ success: false, error: { code, message } }))
  }
  const max = deps.maxBytes ?? ATTACHMENT_UPLOAD_MAX_BYTES
  const type = req.headers['content-type'] ?? ''
  if (!/^multipart\/form-data;\s*boundary=/i.test(type)) {
    req.resume()
    return answer(400, 'INVALID_ATTACHMENT', 'Send the file as multipart/form-data.')
  }
  // A declared length already over the cap is refused before a byte is read or sent on.
  if (Number(req.headers['content-length'] ?? 0) > max) {
    req.resume()
    return answer(413, 'ATTACHMENT_TOO_LARGE', TOO_LARGE)
  }
  let token: string
  try { token = await deps.accessToken() } catch {
    req.resume()
    return answer(401, 'NOT_SIGNED_IN', 'Sign in on this computer to attach files.')
  }
  const idle = new AbortController()
  const idleMs = deps.idleMs ?? ATTACHMENT_IDLE_MS
  let quiet: NodeJS.Timeout | undefined
  const moved = () => {
    clearTimeout(quiet)
    quiet = setTimeout(() => idle.abort(new DOMException('No bytes moved', 'TimeoutError')), idleMs)
  }
  moved()
  let seen = 0
  const counted = req.pipe(new Transform({ transform(chunk: Buffer, _encoding, done) {
    seen += chunk.byteLength
    moved()
    done(seen > max ? new TooLarge() : null, chunk)
  } }))
  // The last byte sent starts the wait for the answer.
  counted.on('end', moved)
  // A body that stops early (the cap, or the app going away) must also stop the upload.
  counted.on('error', () => req.unpipe(counted))
  let response: Response
  try {
    response = await (deps.fetch ?? fetch)(`${deps.base}${path}`, {
      method: 'POST', body: Readable.toWeb(counted) as ReadableStream, duplex: 'half',
      headers: { authorization: `Bearer ${token}`, 'x-autonomous-env': deps.environment, 'content-type': type },
      signal: AbortSignal.any([idle.signal, AbortSignal.timeout(deps.totalMs ?? ATTACHMENT_TOTAL_MS)]),
    } as RequestInit)
  } catch (error) {
    clearTimeout(quiet)
    req.resume()
    if (seen > max) return answer(413, 'ATTACHMENT_TOO_LARGE', TOO_LARGE)
    const timedOut = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')
    return answer(timedOut ? 504 : 502, timedOut ? 'BACKEND_TIMEOUT' : 'BACKEND_UNREACHABLE',
      timedOut ? 'The Harness backend did not finish taking the file. Try again.' : 'Could not reach the Harness backend. Check the connection and try again.')
  }
  let body: Buffer
  try { body = Buffer.from(await response.arrayBuffer()) } catch {
    return answer(504, 'BACKEND_TIMEOUT', 'The Harness backend did not finish answering. Try again.')
  } finally { clearTimeout(quiet) }
  res.writeHead(response.status, { 'Content-Type': response.headers.get('content-type') ?? 'application/json' })
  res.end(body)
}
