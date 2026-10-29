import { createHash } from 'node:crypto'
import { closeSync, constants, fstatSync, lstatSync, openAsBlob, openSync, readSync, realpathSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { basename, extname, isAbsolute, relative, sep } from 'node:path'
import { localCredentialHeaders } from '../lib/localCredential.js'
import { ATTACHMENT_TOTAL_MS } from '../lib/superTabAttachmentProxy.js'
import { object } from './wire.js'
import { formatSize, MAX_ATTACHMENT_BYTES } from './attachments.js'

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

/** One file of `post --attach`, multipart to this computer's daemon, which streams it on to the backend with the account's
 * token (lib/superTabAttachmentProxy.ts). Its own deadline, not a service answer's half minute: on a slow uplink 10 MB
 * takes longer, and the daemon ends it once no bytes move. */
async function uploadOne(file: string | CheckedFile, target: UploadTarget, agentId: string, fetcher: typeof fetch): Promise<string> {
  const form = new FormData()
  form.append('conversationId', target.conversationId)
  if (typeof file === 'string') {
    const info = await stat(file)
    if (!info.isFile()) throw new Error(`${file} is not a file.`)
    if (info.size > MAX_ATTACHMENT_BYTES) throw new Error(`${basename(file)} is over the ${formatSize(MAX_ATTACHMENT_BYTES)} limit (${info.size} bytes).`)
    // Read from disk as it is sent, never whole.
    form.append('file', await openAsBlob(file, { type: mimeOf(file) }), basename(file))
  } else form.append('file', new Blob([file.bytes], { type: file.type }), file.name)
  const name = typeof file === 'string' ? basename(file) : file.name
  const response = await fetcher(`http://127.0.0.1:${target.port}/api/super-tabs/${target.tabId}/attachments?asAgentId=${agentId}`, {
    method: 'POST', body: form, signal: AbortSignal.timeout(UPLOAD_MS),
    // The local API's write gate, and its credential over TCP.
    headers: { 'x-adapter-local': '1', ...localCredentialHeaders(target.dataDir) },
  })
  const body = object(await response.json().catch(() => ({})))
  const attachment = object(object(body.data).attachment)
  if (!response.ok || typeof attachment.id !== 'string') {
    throw new Error(String(object(body.error).message ?? body.message ?? `Could not upload ${name} (HTTP ${response.status}).`))
  }
  return attachment.id
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
 * Harness's records. The last name is opened without following a link; the file must have that one name (a hard link
 * would give a file outside a second name inside), and the real path's file must be the one opened, so a name swapped
 * for a link after the check is refused or never read. Each is at most a chat file's size, so read whole.
 */
export function readInsideFolder(paths: string[], folder: string): CheckedFile[] {
  const root = realpathSync.native(folder)
  return paths.map(path => {
    const outside = () => new Error(`${path} is outside your folder. Attach only files inside your folder; name a file your owner sent in your chat by its id.`)
    let fd: number
    try { fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)) } catch (error) {
      throw (error as NodeJS.ErrnoException).code === 'ELOOP' ? outside() : new Error(`${path} is not a file.`)
    }
    try {
      const opened = fstatSync(fd), real = realpathSync.native(path), inside = relative(root, real), named = lstatSync(real)
      if (!inside || inside.startsWith('..') || isAbsolute(inside) || RECORDS.has(inside.split(sep)[0]!.toLowerCase())) throw outside()
      if (!opened.isFile()) throw new Error(`${path} is not a file.`)
      if (opened.nlink !== 1 || named.ino !== opened.ino || named.dev !== opened.dev) throw outside()
      if (opened.size > MAX_ATTACHMENT_BYTES) throw new Error(`${basename(path)} is over the ${formatSize(MAX_ATTACHMENT_BYTES)} limit (${opened.size} bytes).`)
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
  const earlier = value(await request({ action: 'attachment', step: 'sent', conversationId: target.sentIn ?? target.conversationId, operationId }))
  if (Array.isArray(earlier.attachmentIds)) return earlier.attachmentIds.map(String)
  if (typeof earlier.agentId !== 'string') throw new Error('Update Harness on this computer to attach files.')
  const ids: string[] = []
  for (const path of paths) ids.push(await uploadOne(path, target, earlier.agentId, fetcher))
  return ids
}
