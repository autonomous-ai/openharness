import { createHash } from 'node:crypto'
import { openAsBlob } from 'node:fs'
import { stat } from 'node:fs/promises'
import { basename, extname } from 'node:path'
import { localCredentialHeaders } from '../lib/localCredential.js'
import { daemonFetch } from '../lib/localTransport.js'
import { ATTACHMENT_TOTAL_MS } from '../lib/superTabAttachmentProxy.js'
import { object } from './wire.js'
import { MAX_ATTACHMENT_BYTES, MAX_FORM_ATTACHMENT_BYTES } from './attachments.js'

const TYPES: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf', '.json': 'application/json', '.zip': 'application/zip', '.gz': 'application/gzip',
  '.txt': 'text/plain', '.log': 'text/plain', '.md': 'text/markdown', '.csv': 'text/csv', '.html': 'text/html',
  '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm',
}
export const mimeOf = (path: string) => TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream'
/** A little past the daemon's own ceiling, so the daemon's answer, not this one, says why a slow upload ended. */
const UPLOAD_MS = ATTACHMENT_TOTAL_MS + 30_000

/** The id the backend gives the message `message.send` writes for this agent and operation (backend `stableId`). */
export const messageIdOf = (tabId: string, agentId: string, operationId: string) =>
  createHash('sha256').update(JSON.stringify([tabId, `agent:${agentId}`, operationId])).digest('hex').slice(0, 24)

type Request = (payload: Record<string, unknown>) => Promise<Record<string, unknown>>
const value = (answer: Record<string, unknown>) => {
  if (answer.error) throw Object.assign(new Error(String(answer.detail ?? answer.error)), { code: answer.error, status: answer.status })
  return object(answer.value)
}

/** What a daemon answered, or why not, in its own words (the backend's envelope) when it gave them. */
async function answered(response: Response, name: string): Promise<Record<string, unknown>> {
  const body = object(await response.json().catch(() => ({})))
  if (!response.ok || body.success === false) {
    throw new Error(String(object(body.error).message ?? body.message ?? `Could not upload ${name} (HTTP ${response.status}).`))
  }
  return object(body.data)
}

/** One file of `post --attach` up to 10 MB, multipart to this computer's daemon, which streams it on to the backend with the
 * account's token (lib/superTabAttachmentProxy.ts). Its own deadline, not a service answer's half minute: on a slow uplink
 * 10 MB takes longer, and the daemon ends it once no bytes move. */
async function uploadForm(file: { path: string; size: number }, target: UploadTarget, agentId: string, fetcher: typeof fetch): Promise<string> {
  const form = new FormData()
  form.append('conversationId', target.conversationId)
  // Read from disk as it is sent, never whole.
  form.append('file', await openAsBlob(file.path, { type: mimeOf(file.path) }), basename(file.path))
  const name = basename(file.path)
  const response = await fetcher(`http://127.0.0.1:${target.port}/api/super-tabs/${target.tabId}/attachments?asAgentId=${agentId}`, {
    method: 'POST', body: form, signal: AbortSignal.timeout(UPLOAD_MS),
    // The local API's write gate, and its credential over TCP.
    headers: { 'x-adapter-local': '1', ...localCredentialHeaders(target.dataDir) },
  })
  const attachment = object((await answered(response, name)).attachment)
  if (typeof attachment.id !== 'string') throw new Error(`Could not upload ${name} (HTTP ${response.status}).`)
  return attachment.id
}

/** The slowest steady uplink a file going straight to storage is given time for: 128 KB/s, 256 MB in about 35 minutes. */
const DIRECT_FLOOR_BYTES_PER_MS = 128 * 1024 / 1000
/** A daemon's answer to a link or a completion: small, through the backend. */
const DAEMON_MS = 60_000

/** Where the bytes may go: storage over HTTPS, or a test's or a local stack's own on this computer. */
const storageUrl = (url: unknown): url is string => {
  try {
    const parsed = new URL(String(url))
    return parsed.protocol === 'https:' || (parsed.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname))
  } catch { return false }
}

/**
 * One file of `post --attach` over 10 MB (contract of group 1604): production sits behind Cloudflare, which may refuse a
 * request body over 100 MB, so its bytes go straight to the storage bucket. The daemon asks the backend for a short-lived
 * signed link with the account's token; the file goes to that link with exactly the headers it came with and its length,
 * read from disk as it is sent and with no credential of ours (the link is the credential); then the daemon says it is
 * complete, and the backend answers the attachment, as the form route does. A link writes once: a failed upload is
 * started again from the link, by posting again.
 */
async function uploadDirect(path: string, target: UploadTarget, agentId: string, fetcher: typeof fetch): Promise<string> {
  const name = basename(path)
  const blob = await openAsBlob(path)
  const route = `http://127.0.0.1:${target.port}/api/super-tabs/${target.tabId}/attachments/uploads`
  // The local API's write gate, and its credential over TCP.
  const local = { 'x-adapter-local': '1', ...localCredentialHeaders(target.dataDir), 'content-type': 'application/json' }
  const asked = await fetcher(`${route}?asAgentId=${agentId}`, {
    method: 'POST', headers: local, signal: AbortSignal.timeout(DAEMON_MS),
    body: JSON.stringify({ conversationId: target.conversationId, name, mime: mimeOf(path), size: blob.size }),
  })
  // A daemon from before this route answers its bare 404: it runs an older Harness than this command.
  if (asked.status === 404 && object(await asked.clone().json().catch(() => ({}))).error === 'not found') {
    throw new Error(`${name} is over 10 MB, which this computer's Harness cannot send yet. Restart Harness and try again.`)
  }
  const upload = object((await answered(asked, name)).upload)
  const headers = object(upload.headers)
  if (typeof upload.id !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/.test(upload.id) || !storageUrl(upload.url)
    || !Object.values(headers).every(value => typeof value === 'string')) throw new Error(`Could not upload ${name}. Update Harness and try again.`)
  let stored: Response
  try {
    stored = await fetcher(upload.url, {
      // A redirect would carry the file and its signed headers to another address: a failure, never followed.
      method: 'PUT', body: blob, redirect: 'error',
      headers: { ...headers as Record<string, string>, 'content-length': String(blob.size) },
      signal: AbortSignal.timeout(60_000 + Math.ceil(blob.size / DIRECT_FLOOR_BYTES_PER_MS)),
    })
    await stored.body?.cancel().catch(() => {})
  } catch { throw new Error(`Could not upload ${name}. Try again.`) }
  if (!stored.ok) throw new Error(`Could not upload ${name}. Try again.`)
  const completed = await fetcher(`${route}/${upload.id}/complete?asAgentId=${agentId}`, {
    method: 'POST', headers: local, body: '{}', signal: AbortSignal.timeout(DAEMON_MS),
  })
  const attachment = object((await answered(completed, name)).attachment)
  if (typeof attachment.id !== 'string') throw new Error(`Could not upload ${name} (HTTP ${completed.status}).`)
  return attachment.id
}

const tooLarge = (path: string, size: number) => size > MAX_ATTACHMENT_BYTES
  ? new Error(`${basename(path)} is over the ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB limit (${size} bytes).`) : null

/** A file named on the command line: a regular file, at most 256 MB. */
async function checkedPath(path: string): Promise<{ path: string; size: number }> {
  const info = await stat(path)
  if (!info.isFile()) throw new Error(`${path} is not a file.`)
  const refused = tooLarge(path, info.size)
  if (refused) throw refused
  return { path, size: info.size }
}

interface UploadTarget { tabId: string; conversationId: string; port: number; dataDir: string }

/** Uploads each file of `post --attach` and answers the ids `message.send` names. Repeating a post whose message already
 * went out uploads nothing and names that message's files, so the send returns its receipt. */
export async function uploadAttachments(paths: string[], operationId: string, target: UploadTarget, request: Request,
  // Through the daemon's private socket: a file, and any credential, must not reach whoever holds its port (audit H1).
  fetcher: typeof fetch = daemonFetch(target.dataDir, target.port)): Promise<string[]> {
  // A file too large is refused before any request, and so uploads none of the others. One not there is left to the check
  // below, after the answer whether the post already went out: a repeat of one that did still names its files.
  for (const path of paths) {
    const refused = tooLarge(path, await stat(path).then(info => info.size, () => 0))
    if (refused) throw refused
  }
  const earlier = value(await request({ action: 'attachment', step: 'sent', conversationId: target.conversationId, operationId }))
  if (Array.isArray(earlier.attachmentIds)) return earlier.attachmentIds.map(String)
  if (typeof earlier.agentId !== 'string') throw new Error('Update Harness on this computer to attach files.')
  // Every file checked before the first upload.
  const files: Array<{ path: string; size: number }> = []
  for (const path of paths) files.push(await checkedPath(path))
  const ids: string[] = []
  // Up to 10 MB by the form, as before; larger, straight to storage.
  for (const file of files) {
    ids.push(file.size > MAX_FORM_ATTACHMENT_BYTES
      ? await uploadDirect(file.path, target, earlier.agentId, fetcher)
      : await uploadForm(file, target, earlier.agentId, fetcher))
  }
  return ids
}
