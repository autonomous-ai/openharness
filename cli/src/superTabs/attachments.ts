import { env } from '../config/env.js'
import { copyPasteDropFile, writePasteDropStream } from '../lib/pasteDropFiles.js'
import { object } from './wire.js'

/** The most a file sent by the multipart route may be (lib/superTabAttachmentProxy.ts); a larger one goes by a link. */
export { MAX_FORM_ATTACHMENT_BYTES } from '../lib/superTabAttachmentProxy.js'

/** As the backend stores it on a message (backend/src/superTabs/attachments.ts). */
export interface MessageAttachment { id: string; name: string; mime: string; size: number; url: string }

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

export function attachmentsOf(message: Record<string, unknown>): MessageAttachment[] {
  if (!Array.isArray(message.attachments)) return []
  return message.attachments.slice(0, 10).map(object).filter((a): a is Record<string, unknown> & MessageAttachment =>
    typeof a.name === 'string' && typeof a.url === 'string' && typeof a.mime === 'string'
    && Number.isSafeInteger(a.size) && (a.size as number) >= 0)
}

export const formatSize = (bytes: number) => bytes < 1024 ? `${bytes} B`
  : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`

/** Only files under the configured public base: a message's URL must not make this computer fetch another address. */
export function servedFrom(base: string, address: string): boolean {
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

async function download(file: MessageAttachment, base: string, fetcher: typeof fetch, ms: number, idleMs: number, stop?: AbortSignal): Promise<string> {
  if (!servedFrom(base, file.url)) throw new Refused('not a Harness file address')
  if (file.size > MAX_ATTACHMENT_BYTES) throw new Refused(`over the ${megabytes(MAX_ATTACHMENT_BYTES)} limit`)
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
    const response = await fetcher(file.url, { redirect: 'error', signal: AbortSignal.any([idle.signal, AbortSignal.timeout(ms), ...stop ? [stop] : []]) })
    if (!response.ok || !response.body) {
      await response.body?.cancel().catch(() => {})
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
 * the message, which grows with its bytes; the host's single poll loop waits on it. A file that could not be downloaded is named by its URL instead, and
 * `complete` is false, so the host tries again before it next delivers the same message. `paths` are the files written,
 * which a Buddy's guard may list when its own person sent them (lib/buddyGuard.ts). */
/** A file being downloaded, by its address and size: a second delivery of the same file waits on the first's download
 *  rather than start its own (superTabs/host.ts keeps one such map). */
export type FilesInFlight = Map<string, Promise<{ line: string; path: string | null }>>

export async function attachedFiles(message: Record<string, unknown>,
  options: { base?: string; fetch?: typeof fetch; budgetMs?: number; idleMs?: number; now?: () => number
    inFlight?: FilesInFlight; signal?: AbortSignal } = {}):
  Promise<{ text: string; complete: boolean; paths: string[] }> {
  const files = attachmentsOf(message)
  if (!files.length) return { text: '', complete: true, paths: [] }
  const base = options.base ?? env.SUPER_TAB_ATTACHMENTS_PUBLIC_BASE
  const now = options.now ?? Date.now, deadline = now() + (options.budgetMs ?? budgetMs(files))
  // The sender's name, quoted so it reads as a name and is never taken for the path, which is the shell-safe one.
  const labelOf = (file: MessageAttachment) => `sent as ${JSON.stringify(file.name)}, ${formatSize(file.size)}`
  const failed = (file: MessageAttachment, why: string) => ({ path: null, line: servedFrom(base, file.url)
    ? `- Could not download ${file.url} (${labelOf(file)}): ${why}` : `- Could not download a file (${labelOf(file)}): ${why}` })
  const one = async (file: MessageAttachment) => {
    const label = labelOf(file)
    let failure: unknown
    for (let attempt = 0; attempt < 3 && deadline - now() > 0 && !options.signal?.aborted; attempt++) {
      try {
        const path = await download(file, base, options.fetch ?? fetch, Math.min(downloadMs(file.size), deadline - now()), options.idleMs ?? IDLE_MS,
          options.signal)
        return { line: `- ${path} (${label})`, path }
      } catch (error) {
        failure = error
        if (error instanceof Refused) break
      }
    }
    return failed(file, options.signal?.aborted ? 'stopped' : failure instanceof Error ? failure.message : 'out of time')
  }
  const lines = await Promise.all(files.map(file => {
    const inFlight = options.inFlight
    if (!inFlight) return one(file)
    const key = `${file.size} ${file.url}`
    const running = inFlight.get(key)
    // Downloaded once, but each delivery's own file: copied as soon as the download is in, before either is delivered.
    if (running) return running.then(async shared => {
      if (shared.path === null) return shared
      try {
        const path = await copyPasteDropFile(shared.path, diskName(file.name))
        return { line: `- ${path} (${labelOf(file)})`, path }
      } catch (error) { return failed(file, error instanceof Error ? error.message : 'could not copy') }
    })
    const started: Promise<{ line: string; path: string | null }> = one(file).finally(() => { if (inFlight.get(key) === started) inFlight.delete(key) })
    inFlight.set(key, started)
    return started
  }))
  const paths = lines.flatMap(l => l.path === null ? [] : [l.path])
  return { text: `Attached files:\n${lines.map(l => l.line).join('\n')}`, complete: paths.length === lines.length, paths }
}
