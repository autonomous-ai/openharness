import { createHash } from 'node:crypto'
import { closeSync, constants, fstatSync, lstatSync, openAsBlob, openSync, readSync, realpathSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { basename, extname, isAbsolute, relative, sep } from 'node:path'
import { localCredentialHeaders } from '../lib/localCredential.js'
import { ATTACHMENT_TOTAL_MS } from '../lib/superTabAttachmentProxy.js'
import { object } from './wire.js'
import { formatSize, MAX_ATTACHMENT_BYTES, MAX_FORM_ATTACHMENT_BYTES } from './attachments.js'

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
async function uploadForm(file: { path: string; size: number } | CheckedFile, target: UploadTarget, agentId: string, fetcher: typeof fetch): Promise<string> {
  const form = new FormData()
  form.append('conversationId', target.conversationId)
  // Read from disk as it is sent, never whole.
  if ('path' in file) form.append('file', await openAsBlob(file.path, { type: mimeOf(file.path) }), basename(file.path))
  else form.append('file', new Blob([file.bytes], { type: file.type }), file.name)
  const name = 'path' in file ? basename(file.path) : file.name
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

/** `sentIn`: where the message these files go with is written, when not where they are uploaded (a Buddy's proposal is
 *  uploaded to its chat and posted in the project chat). */
export interface UploadTarget { tabId: string; conversationId: string; sentIn?: string; port: number; dataDir: string }

/** Folders in a Buddy's folder that are not the project's files: its repository's records, its remote's credentials among
 *  them, and Harness's own. Compared in lower case: on a case-insensitive Mac `.GIT` is the same folder. */
const RECORDS = new Set(['.git', '.harness'])

/** A file read once, after its checks, and sent as those bytes. */
export interface CheckedFile { name: string; type: string; bytes: Buffer }

/**
 * A Buddy's proposal files, each read from the one descriptor its checks were made on (security review of #2103): only a
 * regular file inside its own folder, the one place it may read (lib/buddyGuard.ts), never under its repository's or
 * Harness's records. The last name is opened without following a link or waiting; the file must have that one name (a hard link
 * would give a file outside a second name inside), and the real path's file must be the one opened, so a name swapped
 * for a link after the check is refused or never read. Each is read whole, so each stays at the 10 MB of the form upload it
 * then goes by, not the 256 MB a chat file may be: a larger one would be held in memory, and its bytes read again from a
 * path to go by a link would no longer be the ones checked.
 */
export function readInsideFolder(paths: string[], folder: string): CheckedFile[] {
  const root = realpathSync.native(folder)
  return paths.map(path => {
    const outside = () => new Error(`${path} is outside your folder. Attach only files inside your folder; name a file your owner sent in your chat by its id.`)
    let fd: number
    // Never waiting on the open: a named pipe with no writer held the proposal forever (re-check of #2103). A regular
    // file reads the same without blocking, and anything else is refused below before a byte is read.
    try { fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)) } catch (error) {
      throw (error as NodeJS.ErrnoException).code === 'ELOOP' ? outside() : new Error(`${path} is not a file.`)
    }
    try {
      const opened = fstatSync(fd), real = realpathSync.native(path), inside = relative(root, real), named = lstatSync(real)
      if (!inside || inside.startsWith('..') || isAbsolute(inside) || RECORDS.has(inside.split(sep)[0]!.toLowerCase())) throw outside()
      if (!opened.isFile()) throw new Error(`${path} is not a file.`)
      if (opened.nlink !== 1 || named.ino !== opened.ino || named.dev !== opened.dev) throw outside()
      if (opened.size > MAX_FORM_ATTACHMENT_BYTES) throw new Error(`${basename(path)} is over the ${formatSize(MAX_FORM_ATTACHMENT_BYTES)} limit (${opened.size} bytes).`)
      const bytes = Buffer.alloc(opened.size)
      let read = 0
      for (let got = -1; read < bytes.length && got !== 0; read += got) got = readSync(fd, bytes, read, bytes.length - read, read)
      return { name: basename(real), type: mimeOf(real), bytes: bytes.subarray(0, read) }
    } finally { closeSync(fd) }
  })
}

/** Uploads each file of `post --attach` and answers the ids `message.send` names. Repeating a post whose message already
 * went out uploads nothing and names that message's files, so the send returns its receipt. */
export async function uploadAttachments(paths: Array<string | CheckedFile>, operationId: string, target: UploadTarget, request: Request,
  fetcher: typeof fetch = fetch): Promise<string[]> {
  // A file too large is refused before any request, and so uploads none of the others. One not there is left to the check
  // below, after the answer whether the post already went out: a repeat of one that did still names its files.
  for (const path of paths) {
    const refused = typeof path === 'string' ? tooLarge(path, await stat(path).then(info => info.size, () => 0)) : null
    if (refused) throw refused
  }
  const earlier = value(await request({ action: 'attachment', step: 'sent', conversationId: target.sentIn ?? target.conversationId, operationId }))
  if (Array.isArray(earlier.attachmentIds)) return earlier.attachmentIds.map(String)
  if (typeof earlier.agentId !== 'string') throw new Error('Update Harness on this computer to attach files.')
  // Every file checked before the first upload.
  const files: Array<{ path: string; size: number } | CheckedFile> = []
  for (const path of paths) files.push(typeof path === 'string' ? await checkedPath(path) : path)
  const ids: string[] = []
  // Up to 10 MB by the form, as before; larger, straight to storage. A Buddy's checked files are at most 10 MB (readInsideFolder).
  for (const file of files) {
    ids.push('path' in file && file.size > MAX_FORM_ATTACHMENT_BYTES
      ? await uploadDirect(file.path, target, earlier.agentId, fetcher)
      : await uploadForm(file, target, earlier.agentId, fetcher))
  }
  return ids
}
