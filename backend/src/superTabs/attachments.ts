import { randomBytes } from 'node:crypto'
import type { Prisma, SuperTab, SuperTabAttachment } from '@prisma/client'
import { z } from 'zod'
import type { AuthUser } from '../lib/ssoAuth.js'
import { actorKey, author, fail, stableId, type Actor, type AttachmentMeta, type SuperTabState } from './model.js'
import { readConversation } from './projects.js'

export const ATTACHMENT_MAX_BYTES = 5 * 1024 * 1024
export const ATTACHMENTS_PER_MESSAGE = 4
/** The apps reach this backend through a machine's relay (cli/src/superTabs/service.ts `backend`), and a browser's relay
 * frame is 1 MiB (wsServer.ts `WS_LIMITS.web`) before E2EE sealing grows it. One 256 KiB part is about 342 KB of base64,
 * so a 5 MB image travels as up to 20 small requests instead of one that no relay carries. */
export const ATTACHMENT_PART_BYTES = 256 * 1024
const PART_CHARS = Math.ceil(ATTACHMENT_PART_BYTES / 3) * 4
export const ATTACHMENT_BODY_LIMIT = PART_CHARS + 4096
/** Uploads never sent are drafts someone abandoned: an unfinished one goes after an hour, a finished one after a day,
 * and one person keeps at most this many. The app deletes its own leftovers at once (`remove`); these bound the rest. */
const UNSENT_LIMIT = 24
const UNSENT_MS = 86_400_000
const INCOMPLETE_MS = 3_600_000

const id = z.string().min(1).max(160).regex(/^[A-Za-z0-9_-]+$/)
const data = z.string().min(1).max(PART_CHARS).regex(/^[A-Za-z0-9+/]+={0,2}$/, 'Send the bytes as base64.')
export const uploadAttachmentSchema = z.object({
  name: z.string().trim().min(1).max(200).refine(value => !/[\x00-\x1f\x7f]/.test(value)),
  size: z.number().int().min(1).max(ATTACHMENT_MAX_BYTES),
  data,
}).strict()
export const attachmentPartSchema = z.object({ data }).strict()
export const attachmentIdsSchema = z.array(id).min(1).max(ATTACHMENTS_PER_MESSAGE)

type Transaction = Prisma.TransactionClient
type ImageInfo = { mime: 'image/png' | 'image/jpeg' | 'image/webp'; width: number | null; height: number | null }
interface Deps {
  transaction<T>(body: (tx: Transaction) => Promise<T>): Promise<T>
  row(tx: Transaction, user: AuthUser, tabId: string): Promise<{ row: SuperTab; state: SuperTabState }>
  actor(tx: Transaction, user: AuthUser, state: SuperTabState, asAgentId?: string): Promise<Actor>
  now(): number
}

const u16le = (bytes: Uint8Array, i: number) => (bytes[i] ?? 0) | ((bytes[i + 1] ?? 0) << 8)

/** The type the bytes are, read from their own header: a name or a client's word is not trusted. Width and height
 * come along when the header holds them; a JPEG whose frame header is past the first part has none. */
export function imageInfo(bytes: Uint8Array): ImageInfo | null {
  const at = (i: number) => bytes[i] ?? 0
  const u16 = (i: number) => (at(i) << 8) | at(i + 1)
  const u32 = (i: number) => ((at(i) << 24) >>> 0) + (at(i + 1) << 16) + (at(i + 2) << 8) + at(i + 3)
  const le24 = (i: number) => at(i) | (at(i + 1) << 8) | (at(i + 2) << 16)
  const ascii = (i: number, text: string) => [...text].every((c, n) => at(i + n) === c.charCodeAt(0))
  if (bytes.length >= 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((b, i) => at(i) === b)) {
    return ascii(12, 'IHDR') && bytes.length >= 24 ? { mime: 'image/png', width: u32(16), height: u32(20) } : { mime: 'image/png', width: null, height: null }
  }
  if (bytes.length >= 3 && at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) {
    for (let i = 2; i + 9 < bytes.length;) {
      if (at(i) !== 0xff) break
      const marker = at(i + 1)
      if (marker === 0xff) { i++; continue }
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { mime: 'image/jpeg', width: u16(i + 7), height: u16(i + 5) }
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) { i += 2; continue }
      i += 2 + u16(i + 2)
    }
    return { mime: 'image/jpeg', width: null, height: null }
  }
  if (bytes.length >= 16 && ascii(0, 'RIFF') && ascii(8, 'WEBP')) {
    if (ascii(12, 'VP8 ') && bytes.length >= 30) return { mime: 'image/webp', width: u16le(bytes, 26) & 0x3fff, height: u16le(bytes, 28) & 0x3fff }
    if (ascii(12, 'VP8L') && bytes.length >= 25) {
      const [b0, b1, b2, b3] = [at(21), at(22), at(23), at(24)]
      return { mime: 'image/webp', width: 1 + (((b1 & 0x3f) << 8) | b0), height: 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6)) }
    }
    if (ascii(12, 'VP8X') && bytes.length >= 30) return { mime: 'image/webp', width: 1 + le24(24), height: 1 + le24(27) }
    return { mime: 'image/webp', width: null, height: null }
  }
  return null
}
const partId = (attachmentId: string, index: number) => stableId('attachment-part', attachmentId, String(index))
const partBytes = (record: SuperTabAttachment, index: number) =>
  index === record.parts - 1 ? record.size - ATTACHMENT_PART_BYTES * (record.parts - 1) : ATTACHMENT_PART_BYTES
export const attachmentMeta = (record: SuperTabAttachment): AttachmentMeta => ({ id: record.id, name: record.name, mime: record.mime,
  size: record.size, width: record.width ?? null, height: record.height ?? null, parts: record.parts })

/** What a message.send names, checked in its transaction: the sender's own finished uploads in this tab, each unsent.
 * An id from another tab, another person or an earlier message is refused rather than shared. */
export async function attachmentsForSend(tx: Transaction, tabId: string, actor: Actor, ids: string[]): Promise<AttachmentMeta[]> {
  if (new Set(ids).size !== ids.length) fail('INVALID_ATTACHMENT', 'Attach each image once.', 400)
  const rows = await tx.superTabAttachment.findMany({ where: { id: { in: ids }, tabId } })
  return ids.map(attachmentId => {
    const record = rows.find(r => r.id === attachmentId)
    if (!record || record.actorKey !== actorKey(actor) || record.messageId) fail('INVALID_ATTACHMENT', 'This image is no longer available. Attach it again.', 400)
    if (!record.complete) fail('ATTACHMENT_INCOMPLETE', 'Wait for the image to finish uploading.')
    return attachmentMeta(record)
  })
}

/** Sent, an attachment is read with its message: whoever can read that conversation. */
export async function attachToMessage(tx: Transaction, tabId: string, ids: string[], conversationId: string, messageId: string) {
  const { count } = await tx.superTabAttachment.updateMany({ where: { id: { in: ids }, tabId, messageId: null }, data: { messageId, conversationId } })
  // attachmentsForSend read them unsent in this transaction; anything else is a concurrent send, which must not commit.
  if (count !== ids.length) fail('INVALID_ATTACHMENT', 'This image is no longer available. Attach it again.', 400)
}

/** The text stored for a message of images alone, so a client that shows no images still shows something. Clients
 * that draw the images hide it (desktop model.dart `SuperTabMessage.shownText`). */
export const imagesPlaceholder = (count: number) => count === 1 ? '[image]' : `[${count} images]`

/** Images people attach to messages. Bytes never ride a message read; they are read part by part here. */
export class SuperTabAttachmentStore {
  constructor(private readonly deps: Deps) {}

  private async writer(tx: Transaction, user: AuthUser, tabId: string, asAgentId?: string) {
    const { state } = await this.deps.row(tx, user, tabId)
    const actor = await this.deps.actor(tx, user, state, asAgentId)
    author(state, actor, true)
    return actor
  }

  /** Before it is sent only its uploader sees an attachment; after, whoever can read its conversation. Both fail alike. */
  private async readable(tx: Transaction, user: AuthUser, tabId: string, attachmentId: string, asAgentId?: string) {
    const { state } = await this.deps.row(tx, user, tabId)
    const actor = await this.deps.actor(tx, user, state, asAgentId)
    author(state, actor)
    const record = await tx.superTabAttachment.findFirst({ where: { id: attachmentId, tabId } })
    if (record?.conversationId) readConversation(state, actor, record.conversationId)
    else if (!record || record.actorKey !== actorKey(actor)) fail('NOT_FOUND', 'This image is unavailable.', 404)
    return record!
  }

  /** Creates the attachment with its first part, which carries the header that proves the image's type. */
  async upload(user: AuthUser, tabId: string, input: z.infer<typeof uploadAttachmentSchema>, asAgentId?: string) {
    const request = uploadAttachmentSchema.parse(input)
    const first = Buffer.from(request.data, 'base64')
    const parts = Math.ceil(request.size / ATTACHMENT_PART_BYTES)
    if (first.length !== Math.min(request.size, ATTACHMENT_PART_BYTES)) fail('INVALID_ATTACHMENT', 'The image arrived incomplete. Attach it again.', 400)
    const info = imageInfo(first) ?? fail('UNSUPPORTED_ATTACHMENT', 'Attach a PNG, JPEG, or WebP image.', 400)
    return this.deps.transaction(async tx => {
      const actor = await this.writer(tx, user, tabId, asAgentId)
      const key = actorKey(actor)
      const stale = await tx.superTabAttachment.findMany({ where: { tabId, actorKey: key, messageId: null, OR: [
        { createdAt: { lt: new Date(this.deps.now() - UNSENT_MS) } },
        { complete: false, createdAt: { lt: new Date(this.deps.now() - INCOMPLETE_MS) } },
      ] }, select: { id: true }, take: 100 })
      if (stale.length) {
        await tx.superTabAttachmentPart.deleteMany({ where: { attachmentId: { in: stale.map(s => s.id) } } })
        await tx.superTabAttachment.deleteMany({ where: { id: { in: stale.map(s => s.id) } } })
      }
      if (await tx.superTabAttachment.count({ where: { tabId, actorKey: key, messageId: null } }) >= UNSENT_LIMIT) {
        fail('ATTACHMENT_LIMIT', 'Too many images are waiting to be sent. Send or remove the ones in your messages, or try again in an hour.', 429)
      }
      const attachmentId = randomBytes(12).toString('hex')
      // Unsent is an explicit null: MongoDB's `messageId: null` filter does not match a field that was never written.
      const record = await tx.superTabAttachment.create({ data: { id: attachmentId, tabId, actorKey: key, conversationId: null, messageId: null,
        name: request.name, mime: info.mime, size: request.size, width: info.width, height: info.height, parts, complete: parts === 1 } })
      await tx.superTabAttachmentPart.create({ data: { id: partId(attachmentId, 0), attachmentId, index: 0, data: first } })
      return { ...attachmentMeta(record), complete: record.complete }
    })
  }

  /** Repeating a part replaces it, so a retry after a lost reply is safe. A finished attachment no longer changes. */
  async uploadPart(user: AuthUser, tabId: string, attachmentId: string, index: number, input: z.infer<typeof attachmentPartSchema>, asAgentId?: string) {
    const bytes = Buffer.from(attachmentPartSchema.parse(input).data, 'base64')
    return this.deps.transaction(async tx => {
      const actor = await this.writer(tx, user, tabId, asAgentId)
      const record = await tx.superTabAttachment.findFirst({ where: { id: attachmentId, tabId } })
      if (!record || record.actorKey !== actorKey(actor)) fail('NOT_FOUND', 'This image is unavailable.', 404)
      if (record.complete) return { id: record.id, complete: true }
      if (index < 1 || index >= record.parts || bytes.length !== partBytes(record, index)) {
        fail('INVALID_ATTACHMENT', 'The image arrived incomplete. Attach it again.', 400)
      }
      await tx.superTabAttachmentPart.upsert({ where: { attachmentId_index: { attachmentId, index } },
        create: { id: partId(attachmentId, index), attachmentId, index, data: bytes }, update: { data: bytes } })
      const complete = await tx.superTabAttachmentPart.count({ where: { attachmentId } }) === record.parts
      // Always written: two final parts in parallel then conflict on this document and one retries, seeing both parts.
      await tx.superTabAttachment.update({ where: { id: attachmentId }, data: { complete } })
      return { id: record.id, complete }
    })
  }

  /** Its uploader takes back an image not yet sent: removed from the composer, replaced, or left over from a failed send. */
  async remove(user: AuthUser, tabId: string, attachmentId: string, asAgentId?: string) {
    return this.deps.transaction(async tx => {
      const actor = await this.writer(tx, user, tabId, asAgentId)
      const record = await tx.superTabAttachment.findFirst({ where: { id: attachmentId, tabId } })
      if (!record || record.actorKey !== actorKey(actor)) fail('NOT_FOUND', 'This image is unavailable.', 404)
      if (record.messageId) fail('ATTACHMENT_SENT', 'This image was already sent.')
      await tx.superTabAttachmentPart.deleteMany({ where: { attachmentId } })
      await tx.superTabAttachment.delete({ where: { id: attachmentId } })
      return { id: attachmentId, deleted: true }
    })
  }

  async read(user: AuthUser, tabId: string, attachmentId: string, asAgentId?: string) {
    return this.deps.transaction(async tx => {
      const record = await this.readable(tx, user, tabId, attachmentId, asAgentId)
      // An unfinished upload is its uploader's alone: which parts it still needs lets an interrupted upload resume.
      const missing = record.complete ? [] : await tx.superTabAttachmentPart.findMany({ where: { attachmentId }, select: { index: true } })
        .then(have => Array.from({ length: record.parts }, (_, i) => i).filter(i => !have.some(p => p.index === i)))
      return { ...attachmentMeta(record), complete: record.complete, ...(record.complete ? {} : { missing }) }
    })
  }

  /** One part's bytes, base64 in the JSON reply like every relayed answer. */
  async readPart(user: AuthUser, tabId: string, attachmentId: string, index: number, asAgentId?: string) {
    return this.deps.transaction(async tx => {
      const record = await this.readable(tx, user, tabId, attachmentId, asAgentId)
      const part = await tx.superTabAttachmentPart.findUnique({ where: { attachmentId_index: { attachmentId, index } } })
      if (!part || part.index >= record.parts) fail('NOT_FOUND', 'This part of the image is unavailable.', 404)
      return { id: record.id, index, parts: record.parts, data: Buffer.from(part.data).toString('base64') }
    })
  }
}
