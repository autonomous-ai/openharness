import { createHash } from 'node:crypto'
import { openAsBlob, realpathSync } from 'node:fs'
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
async function uploadOne(path: string, target: UploadTarget, agentId: string, fetcher: typeof fetch): Promise<string> {
  const info = await stat(path)
  if (!info.isFile()) throw new Error(`${path} is not a file.`)
  if (info.size > MAX_ATTACHMENT_BYTES) throw new Error(`${basename(path)} is over the ${formatSize(MAX_ATTACHMENT_BYTES)} limit (${info.size} bytes).`)
  const form = new FormData()
  form.append('conversationId', target.conversationId)
  // Read from disk as it is sent, never whole.
  form.append('file', await openAsBlob(path, { type: mimeOf(path) }), basename(path))
  const response = await fetcher(`http://127.0.0.1:${target.port}/api/super-tabs/${target.tabId}/attachments?asAgentId=${agentId}`, {
    method: 'POST', body: form, signal: AbortSignal.timeout(UPLOAD_MS),
    // The local API's write gate, and its credential over TCP.
    headers: { 'x-adapter-local': '1', ...localCredentialHeaders(target.dataDir) },
  })
  const body = object(await response.json().catch(() => ({})))
  const attachment = object(object(body.data).attachment)
  if (!response.ok || typeof attachment.id !== 'string') {
    throw new Error(String(object(body.error).message ?? body.message ?? `Could not upload ${basename(path)} (HTTP ${response.status}).`))
  }
  return attachment.id
}

/** `sentIn`: where the message these files go with is written, when not where they are uploaded (a Buddy's proposal is
 *  uploaded to its chat and posted in the project chat). */
export interface UploadTarget { tabId: string; conversationId: string; sentIn?: string; port: number; dataDir: string }

/** Folders in a Buddy's folder that are not the project's files: its repository's records, its remote's credentials among
 *  them, and Harness's own. */
const RECORDS = new Set(['.git', '.harness'])

/** A Buddy's proposal files, each as the real file it names: only what lies inside its own folder, the one place it may
 *  read (lib/buddyGuard.ts), never under its repository's or Harness's records, and never through a link out of it. */
export function insideFolder(paths: string[], folder: string): string[] {
  const root = realpathSync(folder)
  return paths.map(path => {
    let real: string
    try { real = realpathSync(path) } catch { throw new Error(`${path} is not a file.`) }
    const inside = relative(root, real)
    if (!inside || inside.startsWith('..') || isAbsolute(inside) || RECORDS.has(inside.split(sep)[0]!)) {
      throw new Error(`${path} is outside your folder. Attach only files inside your folder; name a file your owner sent in your chat by its id.`)
    }
    return real
  })
}

/** Uploads each file of `post --attach` and answers the ids `message.send` names. Repeating a post whose message already
 * went out uploads nothing and names that message's files, so the send returns its receipt. */
export async function uploadAttachments(paths: string[], operationId: string, target: UploadTarget, request: Request,
  fetcher: typeof fetch = fetch): Promise<string[]> {
  const earlier = value(await request({ action: 'attachment', step: 'sent', conversationId: target.sentIn ?? target.conversationId, operationId }))
  if (Array.isArray(earlier.attachmentIds)) return earlier.attachmentIds.map(String)
  if (typeof earlier.agentId !== 'string') throw new Error('Update Harness on this computer to attach files.')
  const ids: string[] = []
  for (const path of paths) ids.push(await uploadOne(path, target, earlier.agentId, fetcher))
  return ids
}
