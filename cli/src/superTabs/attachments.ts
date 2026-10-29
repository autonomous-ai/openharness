import { env } from '../config/env.js'
import { writePasteDropFile } from '../lib/pasteDropFiles.js'
import { object } from './wire.js'

/** As the backend stores it on a message (backend/src/superTabs/attachments.ts). */
export interface MessageAttachment { id: string; name: string; mime: string; size: number; url: string }

/** The backend's per-file limit. A download never reads past it, whatever a message declares. */
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024
const DOWNLOAD_MS = 30_000
const BUDGET_MS = 45_000

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

async function download(file: MessageAttachment, base: string, fetcher: typeof fetch, ms: number): Promise<string> {
  if (!servedFrom(base, file.url)) throw new Refused('not a Harness file address')
  const limit = Math.min(file.size, MAX_ATTACHMENT_BYTES)
  // A redirect could leave the public base, so it is a failure, not followed.
  const response = await fetcher(file.url, { redirect: 'error', signal: AbortSignal.timeout(ms) })
  if (!response.ok || !response.body) {
    const Failure = response.status >= 400 && response.status < 500 && ![408, 429].includes(response.status) ? Refused : Error
    throw new Failure(`HTTP ${response.status}`)
  }
  const chunks: Uint8Array[] = []
  let total = 0
  for await (const chunk of response.body) {
    total += chunk.byteLength
    if (total > limit) { await response.body.cancel().catch(() => {}); throw new Refused('larger than declared') }
    chunks.push(chunk)
  }
  if (total !== file.size) throw new Error('incomplete download')
  return writePasteDropFile(diskName(file.name), Buffer.concat(chunks))
}

/** The prompt's list of a message's files, downloaded into this computer's paste-drops folder (kept 24 h), so an
 * agent on any machine can read them. Each file gets up to three tries within one time budget for the message, since
 * the host's single poll loop waits on it. A file that could not be downloaded is named by its URL instead, and
 * `complete` is false, so the host tries again before it next delivers the same message. `paths` are the files written,
 * which a Buddy's guard may list when its own person sent them (lib/buddyGuard.ts). */
export async function attachedFiles(message: Record<string, unknown>, options: { base?: string; fetch?: typeof fetch; budgetMs?: number; now?: () => number } = {}):
  Promise<{ text: string; complete: boolean; paths: string[] }> {
  const files = attachmentsOf(message)
  if (!files.length) return { text: '', complete: true, paths: [] }
  const base = options.base ?? env.SUPER_TAB_ATTACHMENTS_PUBLIC_BASE
  const now = options.now ?? Date.now, deadline = now() + (options.budgetMs ?? BUDGET_MS)
  const lines = await Promise.all(files.map(async file => {
    // The sender's name, quoted so it reads as a name and is never taken for the path, which is the shell-safe one.
    const label = `sent as ${JSON.stringify(file.name)}, ${formatSize(file.size)}`
    let failure: unknown
    for (let attempt = 0; attempt < 3 && deadline - now() > 0; attempt++) {
      try {
        const path = await download(file, base, options.fetch ?? fetch, Math.min(DOWNLOAD_MS, deadline - now()))
        return { line: `- ${path} (${label})`, path }
      } catch (error) {
        failure = error
        if (error instanceof Refused) break
      }
    }
    const why = failure instanceof Error ? failure.message : 'out of time'
    return { line: servedFrom(base, file.url) ? `- Could not download ${file.url} (${label}): ${why}` : `- Could not download a file (${label}): ${why}`, path: null }
  }))
  const paths = lines.flatMap(l => l.path === null ? [] : [l.path])
  return { text: `Attached files:\n${lines.map(l => l.line).join('\n')}`, complete: paths.length === lines.length, paths }
}
