import { logger } from '../utils/logger.js'
import { errorCode, trimPrefix, type Attachment, type AttachmentStore } from './attachments.js'

/**
 * Chat files are opened only through short-lived signed links, made on each read for whoever can read the message now
 * (security review of Delete Swarm, 10-31): a member removed from a project or a Swarm, or anyone once the Swarm is deleted,
 * gets no new link, and a link already handed out stops opening within FILE_LINK_TTL_MS. Reads still carry each file's
 * public address too (`url`), which apps from before this open: it keeps working only until the release step makes the
 * bucket private (docs/swarms.md, "Chat file links"), and from then only a signed link opens a file.
 *
 * A link is the same through each five minutes, so a picture is fetched once in that window rather than on every poll, and
 * signing (a network call when the cloud signs it) happens at most once per file and window on a server. It opens for ten
 * minutes from the window's start: between five and ten after it is read.
 */
export const FILE_LINK_WINDOW_MS = 5 * 60_000
export const FILE_LINK_TTL_MS = 10 * 60_000
export const fileLinkExpiry = (now: number) => Math.floor(now / FILE_LINK_WINDOW_MS) * FILE_LINK_WINDOW_MS + FILE_LINK_TTL_MS
/** Links kept for the current window; past it the cache starts again, which costs one more signature per file shown. */
export const MAX_CACHED_LINKS = 20_000
/** Signatures one read waits on at once: a page of 100 messages may carry hundreds of files. */
const SIGN_AT_ONCE = 8

type Signer = Pick<AttachmentStore, 'signedUrl'>

export class FileLinks {
  private readonly signed = new Map<string, Promise<string>>()
  private window = 0

  /** [publicBase] and [prefix]: where stored addresses point and the folder chat files are in (attachments.ts). */
  constructor(private readonly bucket: Signer, private readonly publicBase: string, private readonly prefix: string) {}

  /** The object a stored address names, only inside [tabId]'s own folder: a row of one Swarm never gets a link to another
   *  Swarm's file, an avatar, or anything else in the bucket, whatever the row says. */
  keyOf(tabId: string, url: unknown): string | null {
    if (typeof url !== 'string') return null
    const base = `${this.publicBase.replace(/\/+$/, '')}/`
    if (!url.startsWith(base)) return null
    const key = url.slice(base.length)
    const folder = `${[trimPrefix(this.prefix), tabId].filter(Boolean).join('/')}/`
    const parts = key.split('/')
    return key.startsWith(folder) && !/[?#\\%]/.test(key) && parts.every(part => part && part !== '.' && part !== '..') ? key : null
  }

  /** [rows] with each file's signed link and its expiry added. A file that cannot be linked (its signature failed, or its row
   *  names nothing in this Swarm's folder) is marked `unlinked`: apps that know links then ask for a fresh one or say to try
   *  again, and never fall back to the public address. Only the fields a message stores for a file are kept. */
  async forRows<T extends { attachments?: unknown }>(tabId: string, rows: T[], now: number): Promise<T[]> {
    if (!rows.some(row => Array.isArray(row.attachments) && row.attachments.length)) return rows
    const expiresAt = fileLinkExpiry(now)
    if (expiresAt !== this.window || this.signed.size >= MAX_CACHED_LINKS) { this.signed.clear(); this.window = expiresAt }
    const keys = new Set<string>()
    for (const row of rows) for (const file of files(row)) { const key = this.keyOf(tabId, file.url); if (key) keys.add(key) }
    const links = await this.signAll([...keys], expiresAt)
    return rows.map(row => !Array.isArray(row.attachments) ? row : { ...row, attachments: files(row).map(file => {
      const key = this.keyOf(tabId, file.url), url = key ? links.get(key) : undefined
      return { id: file.id, name: file.name, mime: file.mime, size: file.size, url: typeof file.url === 'string' ? file.url : '',
        ...url ? { link: url, expiresAt } : { unlinked: true as const } } satisfies Attachment
    }) })
  }

  /** One file's link, as forRows hands it. */
  async forFile(tabId: string, file: Attachment, now: number): Promise<Attachment> {
    return (await this.forRows(tabId, [{ attachments: [file] }], now))[0]!.attachments[0] as Attachment
  }

  private async signAll(keys: string[], expiresAt: number): Promise<Map<string, string>> {
    const links = new Map<string, string>()
    let next = 0
    const worker = async () => {
      while (next < keys.length) {
        const key = keys[next++]!
        const url = await this.link(key, expiresAt)
        if (url) links.set(key, url)
      }
    }
    await Promise.all(Array.from({ length: Math.min(SIGN_AT_ONCE, keys.length) }, worker))
    return links
  }

  /** The window's link to [key], signed once however many reads ask at the same moment. A failure is not kept, so the next
   *  read tries again, and is logged by its code alone: storage's message may quote the key. */
  private async link(key: string, expiresAt: number): Promise<string | null> {
    const cacheKey = `${expiresAt} ${key}`
    let pending = this.signed.get(cacheKey)
    if (!pending) {
      pending = this.bucket.signedUrl(key, expiresAt)
      this.signed.set(cacheKey, pending)
    }
    try { return await pending } catch (error) {
      if (this.signed.get(cacheKey) === pending) this.signed.delete(cacheKey)
      logger.warn('[file-links] could not sign a chat file link', { code: errorCode(error) })
      return null
    }
  }
}

function files(row: { attachments?: unknown }): Attachment[] {
  if (!Array.isArray(row.attachments)) return []
  return row.attachments.filter((file): file is Attachment => !!file && typeof file === 'object' && typeof (file as Attachment).id === 'string')
}
