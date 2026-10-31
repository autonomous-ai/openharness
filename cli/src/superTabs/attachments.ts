import { mkdir, statfs as fsStatfs } from 'node:fs/promises'
import { env } from '../config/env.js'
import { copyPasteDropFile, PASTE_DROPS_DIR, writePasteDropStream } from '../lib/pasteDropFiles.js'
import { object } from './wire.js'

/** The most a file sent by the multipart route may be (lib/superTabAttachmentProxy.ts); a larger one goes by a link. */
export { MAX_FORM_ATTACHMENT_BYTES } from '../lib/superTabAttachmentProxy.js'

/** As the backend hands it with a message (backend/src/superTabs/attachments.ts): `link` is a signed link of that read, which
 *  opens until `expiresAt` (epoch ms); `url` is the file's public address, which an older backend sends alone and which stops
 *  opening once the bucket is private. The link is used whenever there is one. */
export interface MessageAttachment { id: string; name: string; mime: string; size: number; url: string; link?: string; expiresAt?: number }
/** A fresh link to [file], from the backend, for whoever this host delivers to (superTabs/host.ts): the read checks that they
 *  may still read the message. It throws when they may not, or the file is gone. */
export type Relink = (file: MessageAttachment) => Promise<MessageAttachment>
/** A link this close to its end is fetched afresh before a try starts: storage checks it when a request starts, and a
 *  download that starts in time finishes however long it takes. */
const RELINK_MARGIN_MS = 30_000

/** The backend's per-file limit. A download never reads past it, whatever a message declares. */
export const MAX_ATTACHMENT_BYTES = 256 * 1024 * 1024
/** No bytes for this long ends a download: a slow link keeps going, a stalled one does not hold the host's loop. */
const IDLE_MS = 30_000
/** The slowest steady pace a download is given time for: 256 KB/s, so 256 MB in about 17 minutes. */
const FLOOR_BYTES_PER_MS = 256 * 1024 / 1000
/** One download's ceiling however steadily it moves: half a minute, and its bytes at the slowest pace. */
const downloadMs = (bytes: number) => 30_000 + Math.ceil(bytes / FLOOR_BYTES_PER_MS)
/** A message's time for all its files, which download together and share the link: at least 45 s, and their bytes at the
 *  slowest pace, so a 256 MB file can finish. */
const BUDGET_MS = 45_000
const budgetMs = (files: MessageAttachment[]) =>
  BUDGET_MS + Math.ceil(files.reduce((sum, file) => sum + Math.min(file.size, MAX_ATTACHMENT_BYTES), 0) / FLOOR_BYTES_PER_MS)
const megabytes = (bytes: number) => `${bytes / 1024 / 1024} MB`
/** Kept free beside a download: a 256 MB file must not fill the disk this computer's agents work on. */
const FREE_MARGIN_BYTES = 512 * 1024 * 1024
/** What `fs.statfs` tells of the disk: free blocks for this user, and their size. */
export type Statfs = (path: string) => Promise<{ bavail: number | bigint; bsize: number | bigint }>

/** Whether the paste-drops disk has room for [bytes] and the margin. A disk that cannot say (statfs unsupported) is not refused. */
async function roomFor(bytes: number, statfs: Statfs): Promise<boolean> {
  let free: number
  try {
    await mkdir(PASTE_DROPS_DIR, { recursive: true })
    const disk = await statfs(PASTE_DROPS_DIR)
    free = Number(disk.bavail) * Number(disk.bsize)
  } catch { return true }
  return free >= bytes + FREE_MARGIN_BYTES
}

export function attachmentsOf(message: Record<string, unknown>): MessageAttachment[] {
  if (!Array.isArray(message.attachments)) return []
  return message.attachments.slice(0, 10).map(object).filter((a): a is Record<string, unknown> & MessageAttachment =>
    typeof a.name === 'string' && typeof a.url === 'string' && typeof a.mime === 'string'
    && Number.isSafeInteger(a.size) && (a.size as number) >= 0)
    .map(a => ({ id: typeof a.id === 'string' ? a.id : '', name: a.name, mime: a.mime, size: a.size, url: a.url,
      ...typeof a.link === 'string' && a.link ? { link: a.link,
        ...typeof a.expiresAt === 'number' && Number.isFinite(a.expiresAt) ? { expiresAt: a.expiresAt } : {} } : {} }))
}

export const formatSize = (bytes: number) => bytes < 1024 ? `${bytes} B`
  : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`

/** Only files on Harness's own file storage, under the backend's public base (an older backend) or on the signed-link host:
 *  a message's URL must not make this computer fetch another address. */
export function servedFrom(base: string, address: string, signedBase = env.SUPER_TAB_FILES_BASE): boolean {
  return under(base, address) || under(signedBase, address)
}
function under(base: string, address: string): boolean {
  try {
    const root = new URL(base), target = new URL(address)
    const prefix = root.pathname.endsWith('/') ? root.pathname : `${root.pathname}/`
    return target.origin === root.origin && target.pathname.startsWith(prefix) && !target.username && !target.password
  } catch { return false }
}

/** A failure that another try cannot fix. */
class Refused extends Error {}

/** The name on disk: the prompt lists this path for an agent that may paste it into a shell, so it carries nothing a
 * shell reads as syntax ($(...), quotes, spaces, ;). The original name stays in the label beside it. */
export const diskName = (name: string) => name.replaceAll(/[^A-Za-z0-9._-]+/g, '_').replace(/^[.-]+/, '').slice(-120) || 'file'

/** Storage's answer to a signed link that is over: the next try asks for a fresh one (attachedFiles). */
class Expired extends Error {}

async function download(file: MessageAttachment, base: string, signedBase: string, fetcher: typeof fetch, ms: number, idleMs: number,
  stop: AbortSignal | undefined, statfs: Statfs): Promise<string> {
  const address = file.link ?? file.url
  if (!address) throw new Refused('no longer available')
  if (!servedFrom(base, address, signedBase)) throw new Refused('not a Harness file address')
  if (file.size > MAX_ATTACHMENT_BYTES) throw new Refused(`over the ${megabytes(MAX_ATTACHMENT_BYTES)} limit`)
  // Another try would find the same disk: refused, not tried again.
  if (!await roomFor(file.size, statfs)) throw new Refused('not enough free disk space')
  const limit = file.size
  // No bytes for idleMs ends it, from the request on: waiting for the answer counts too.
  const idle = new AbortController()
  let quiet: NodeJS.Timeout | undefined
  const moved = () => {
    clearTimeout(quiet)
    quiet = setTimeout(() => idle.abort(new Error(`no bytes came for ${Math.round(idleMs / 1000)} s`)), idleMs)
  }
  moved()
  try {
    // A redirect could leave the public base, so it is a failure, not followed.
    const response = await fetcher(address, { redirect: 'error', signal: AbortSignal.any([idle.signal, AbortSignal.timeout(ms), ...stop ? [stop] : []]) })
    if (!response.ok || !response.body) {
      await response.body?.cancel().catch(() => {})
      // A signed link that is over, or whose file is no longer readable through it: a fresh link may still open it.
      if ((response.status === 400 || response.status === 403) && file.link) throw new Expired(`HTTP ${response.status}`)
      const Failure = response.status >= 400 && response.status < 500 && ![408, 429].includes(response.status) ? Refused : Error
      throw new Failure(`HTTP ${response.status}`)
    }
    // A length it declares past the size is refused before a byte is read. Compressed, the length is not the file's.
    const length = response.headers.get('content-length')
    if (length !== null && !response.headers.get('content-encoding') && Number(length) > limit) {
      await response.body.cancel().catch(() => {})
      throw new Refused('larger than declared')
    }
    const body = response.body
    // Counted as it goes to disk: one byte past the size ends it, and so does a body that ends short. Either way the file
    // written so far is removed (lib/pasteDropFiles.ts).
    async function* counted(): AsyncGenerator<Uint8Array> {
      let total = 0
      for await (const chunk of body) {
        moved()
        total += chunk.byteLength
        if (total > limit) throw new Refused('larger than declared')
        yield chunk
      }
      if (total !== file.size) throw new Error('incomplete download')
    }
    return await writePasteDropStream(diskName(file.name), counted())
  } catch (error) {
    // Ended for want of bytes: said so, rather than as the abort the fetch or the body threw.
    throw idle.signal.aborted && !(error instanceof Refused) ? idle.signal.reason : error
  } finally { clearTimeout(quiet) }
}

/** The prompt's list of a message's files, downloaded into this computer's paste-drops folder (kept 24 h), so an
 * agent on any machine can read them. Each file is streamed to disk, and gets up to three tries within one time budget for
 * the message, which grows with its bytes; the host's single poll loop waits on it. A try whose link is over or about to be
 * starts with a fresh one from [relink]. A file that could not be downloaded is named by its name and size alone (a signed
 * link carries a credential, and is never written into a prompt), and `complete` is false, so the host tries again, with a
 * fresh claim and fresh links, before it next delivers the same message. `paths` are the files written, which a Buddy's
 * guard may list when its own person sent them (lib/buddyGuard.ts). */
/** A file being downloaded, by its address and size: a second delivery of the same file waits on the first's download
 *  rather than start its own (superTabs/host.ts keeps one such map). [wanting]: the deliveries still waiting for it; the last
 *  to leave stops it. */
export type FilesInFlight = Map<string, SharedDownload>
interface SharedDownload { result: Promise<{ line: string; path: string | null }>; wanting: number; stop: AbortController }

export async function attachedFiles(message: Record<string, unknown>,
  options: { base?: string; signedBase?: string; fetch?: typeof fetch; budgetMs?: number; idleMs?: number; now?: () => number
    inFlight?: FilesInFlight; signal?: AbortSignal; statfs?: Statfs; relink?: Relink } = {}):
  Promise<{ text: string; complete: boolean; paths: string[] }> {
  const files = attachmentsOf(message)
  if (!files.length) return { text: '', complete: true, paths: [] }
  const base = options.base ?? env.SUPER_TAB_ATTACHMENTS_PUBLIC_BASE, signedBase = options.signedBase ?? env.SUPER_TAB_FILES_BASE
  const now = options.now ?? Date.now, deadline = now() + (options.budgetMs ?? budgetMs(files))
  // The sender's name, quoted so it reads as a name and is never taken for the path, which is the shell-safe one.
  const labelOf = (file: MessageAttachment) => `sent as ${JSON.stringify(file.name)}, ${formatSize(file.size)}`
  const failed = (file: MessageAttachment, why: string) => ({ path: null, line: `- Could not download a file (${labelOf(file)}): ${why}` })
  const one = async (sent: MessageAttachment, signal: AbortSignal | undefined) => {
    const label = labelOf(sent)
    let file = sent, failure: unknown, stale = false
    for (let attempt = 0; attempt < 3 && deadline - now() > 0 && !signal?.aborted; attempt++) {
      try {
        if (options.relink && (stale || (file.expiresAt !== undefined && file.expiresAt - now() < RELINK_MARGIN_MS))) {
          try { file = await options.relink(file) } catch (error) {
            // Refused (404) or forbidden (403): its reader may no longer read the message, or the file is gone.
            const status = error && typeof error === 'object' && 'status' in error ? error.status : null
            throw new Refused(status === 404 || status === 403 ? 'no longer available' : 'could not get a fresh link')
          }
          stale = false
        }
        const path = await download(file, base, signedBase, options.fetch ?? fetch, Math.min(downloadMs(file.size), deadline - now()),
          options.idleMs ?? IDLE_MS, signal, options.statfs ?? fsStatfs)
        return { line: `- ${path} (${label})`, path }
      } catch (error) {
        failure = error
        if (error instanceof Refused) break
        if (error instanceof Expired) { if (!options.relink) break; stale = true }
      }
    }
    return failed(file, signal?.aborted ? 'stopped' : failure instanceof Error ? failure.message : 'out of time')
  }
  const lines = await Promise.all(files.map(async file => {
    const inFlight = options.inFlight
    if (!inFlight) return one(file, options.signal)
    // By the file, not its link: each read signs a link of its own.
    const key = `${file.size} ${file.id || file.url.split('?')[0]}`
    let shared = inFlight.get(key)
    const joined = !!shared
    if (!shared) {
      const stop = new AbortController()
      const started: SharedDownload = { wanting: 0, stop,
        result: one(file, stop.signal).finally(() => { if (inFlight.get(key) === started) inFlight.delete(key) }) }
      inFlight.set(key, shared = started)
    }
    const download = shared
    // This delivery wants it until it is in or the delivery leaves; the last one to leave stops it, and its part file goes.
    download.wanting++
    let left = false
    const leave = () => { if (left) return; left = true; if (--download.wanting === 0) download.stop.abort() }
    if (options.signal?.aborted) leave()
    else options.signal?.addEventListener('abort', leave, { once: true })
    const result = await download.result
    options.signal?.removeEventListener('abort', leave)
    if (!joined || result.path === null) return result
    // Downloaded once, but each delivery's own file: copied as soon as the download is in, before either is delivered.
    try {
      const path = await copyPasteDropFile(result.path, diskName(file.name))
      return { line: `- ${path} (${labelOf(file)})`, path }
    } catch (error) { return failed(file, error instanceof Error ? error.message : 'could not copy') }
  }))
  const paths = lines.flatMap(l => l.path === null ? [] : [l.path])
  return { text: `Attached files:\n${lines.map(l => l.line).join('\n')}`, complete: paths.length === lines.length, paths }
}
