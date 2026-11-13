/**
 * A file the core wrote to its uploads folder, sent on to the backend with the account's token: a Swarm chat file from
 * the native desktop (lib/superTabAttachmentProxy.ts takes it in). Here, in the gateway's process, because the gateway is
 * the part of the daemon that meets the backend: the core calls no other host (the core audit of 2026-11-12). Until then
 * the core streamed the upload to the backend itself.
 *
 * The file is read as a stream, never held whole, and sent as it is. Only the Swarm's attachment route takes one, and
 * only a file in the uploads folder is read, never through a link. The backend's answer (its status and its small JSON
 * body) is handed back as it came. The whole of it, the wait for a token too, ends by `UPLOAD_TOTAL_MS` from the moment
 * the core asks, which waits a little longer: the core never answers the desktop while this may still be sending, which
 * let a retry post the file twice (review, 2026-11-13).
 */
import { createReadStream, lstatSync, realpathSync } from 'node:fs'
import { dirname } from 'node:path'
import { Readable, Transform } from 'node:stream'
import type { UploadAnswer } from '../core/api.js'
import type { AuthSessionManager } from '../lib/authRefresh.js'
import { ATTACHMENT_AGENT, ATTACHMENT_ROUTE, MULTIPART_TYPE, UPLOAD_IDLE_MS, UPLOAD_TOTAL_MS } from '../lib/gatewayWire.js'

const INVALID: UploadAnswer = { error: 'INVALID_UPLOAD' }
/** The most of the backend's answer read: a small JSON body. More is a backend answering something else. */
export const UPLOAD_ANSWER_MAX_BYTES = 1024 * 1024

export interface UploadDeps {
  tokens: Pick<AuthSessionManager, 'accessToken'>
  environment: string
  /** The backend's REST base (lib/backendHttpBase.ts). */
  base: string
  /** The uploads folder (lib/gatewayWire.ts `uploadsFolder`): the one folder a file is read from. */
  folder: string
  fetch?: typeof fetch
  idleMs?: number
  totalMs?: number
  log?: (line: string) => void
}

/** The attachment route, with at most the agent an agent's own `post --attach` names. */
function attachmentPath(path: string): boolean {
  const [route = '', query, ...more] = path.split('?')
  if (!ATTACHMENT_ROUTE.test(route) || more.length) return false
  if (query === undefined) return true
  const agent = /^asAgentId=(.*)$/.exec(query)?.[1]
  return agent !== undefined && ATTACHMENT_AGENT.test(agent)
}

/** Whether [file] is a plain file directly in [folder], and not a link: anything else is no upload. */
function inFolder(file: string, folder: string): boolean {
  try {
    return !lstatSync(file).isSymbolicLink() && lstatSync(file).isFile() && dirname(realpathSync(file)) === realpathSync(folder)
  } catch { return false }
}

/** [answer]'s body as text, refused past [max] bytes. */
async function boundedText(answer: Response, max: number): Promise<string | null> {
  if (!answer.body) return ''
  const parts: Uint8Array[] = []
  let size = 0
  for await (const chunk of answer.body as unknown as AsyncIterable<Uint8Array>) {
    size += chunk.byteLength
    if (size > max) return null
    parts.push(chunk)
  }
  return Buffer.concat(parts).toString('utf8')
}

export async function uploadToBackend(request: { file: string; path: string; contentType: string }, deps: UploadDeps): Promise<UploadAnswer> {
  if (!attachmentPath(request.path) || !MULTIPART_TYPE.test(request.contentType) || !inFolder(request.file, deps.folder)) return INVALID
  const log = deps.log ?? ((line: string) => console.warn(line))
  // From the moment the core asks: the token's wait counts against it.
  const total = AbortSignal.timeout(deps.totalMs ?? UPLOAD_TOTAL_MS)
  const ended = new Promise<never>((_, reject) => { total.addEventListener('abort', () => reject(total.reason), { once: true }) })
  ended.catch(() => {})
  let token: string
  try {
    token = await Promise.race([deps.tokens.accessToken(), ended])
  } catch (error) {
    if (total.aborted) return { error: 'BACKEND_TIMEOUT' }
    log(`[gateway] a Swarm chat file was not sent: no token (${error instanceof Error ? error.message : String(error)})`)
    return { error: 'NOT_SIGNED_IN' }
  }
  const idle = new AbortController()
  const idleMs = deps.idleMs ?? UPLOAD_IDLE_MS
  let quiet: NodeJS.Timeout | undefined
  const moved = () => {
    clearTimeout(quiet)
    quiet = setTimeout(() => idle.abort(new DOMException('No bytes moved', 'TimeoutError')), idleMs)
  }
  moved()
  const read = createReadStream(request.file)
  const counted = read.pipe(new Transform({ transform(chunk: Buffer, _encoding, done) { moved(); done(null, chunk) } }))
  // The last byte sent starts the wait for the answer.
  counted.on('end', moved)
  read.on('error', (error) => counted.destroy(error))
  try {
    const answer = await (deps.fetch ?? fetch)(`${deps.base}${request.path}`, {
      method: 'POST', body: Readable.toWeb(counted) as ReadableStream, duplex: 'half',
      headers: { authorization: `Bearer ${token}`, 'x-autonomous-env': deps.environment, 'content-type': request.contentType },
      signal: AbortSignal.any([idle.signal, total]),
    } as RequestInit)
    const body = await boundedText(answer, UPLOAD_ANSWER_MAX_BYTES)
    if (body === null) {
      log(`[gateway] a Swarm chat file's answer from the backend was over ${UPLOAD_ANSWER_MAX_BYTES} bytes: not passed on`)
      return { error: 'BACKEND_UNREACHABLE' }
    }
    return { status: answer.status, body, contentType: answer.headers.get('content-type') ?? 'application/json' }
  } catch (error) {
    const timedOut = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')
    log(`[gateway] a Swarm chat file was not sent: ${timedOut ? 'it took too long' : `the backend was not reached (${error instanceof Error ? error.message : String(error)})`}`)
    return { error: timedOut ? 'BACKEND_TIMEOUT' : 'BACKEND_UNREACHABLE' }
  } finally {
    clearTimeout(quiet)
    read.destroy()
  }
}
