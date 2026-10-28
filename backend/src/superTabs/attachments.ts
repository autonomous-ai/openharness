import { createHmac, randomBytes } from 'node:crypto'
import { Readable, Transform, Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { z } from 'zod'

/** Metadata as a message stores and returns it. The bytes stay in the bucket. */
export interface Attachment { id: string; name: string; mime: string; size: number; url: string }

export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024
export const MAX_ATTACHMENTS = 10
/** An avatar is a small picture: Desktop resizes it before upload, and the backend still holds it to this. */
export const MAX_AVATAR_BYTES = 1024 * 1024
export const AVATAR_TYPES: ReadonlySet<string> = new Set(['image/png', 'image/jpeg', 'image/webp'])
/** The `purpose` of an avatar upload (schema.prisma SuperTabAttachment): never sendable as a chat file. */
export const AVATAR_PURPOSE = 'avatar'

// Control, format (bidi overrides, zero-width) and line/paragraph separators: a name that hides its real shape.
export const attachmentName = z.string().trim().min(1).max(255).refine(value => !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value), 'Use a printable file name.')
export const attachmentMime = z.string().trim().toLowerCase().max(200).regex(/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/)

export class AttachmentTooLarge extends Error {
  constructor(cap = MAX_ATTACHMENT_BYTES) { super(`A file can be at most ${cap / 1024 / 1024} MB.`) }
}

/** The bucket behind the CDN. Tests and the local rig use the in-memory store below. */
export interface AttachmentStore {
  /** Streams `body` into the object and answers its size. Past `cap` bytes it throws AttachmentTooLarge and leaves no object. */
  put(objectKey: string, file: { name: string; mime: string }, body: Readable, cap: number): Promise<number>
}
/** The private bucket avatars are kept in: nobody reads an object without a link the server signed (avatarLinks.ts). */
export interface AvatarStore extends AttachmentStore {
  /** A link that opens [objectKey] until [expiresAt] (epoch ms), and never after. */
  signedUrl(objectKey: string, expiresAt: number): Promise<string>
}
/** `avatars`: the private avatar bucket; without one, avatar uploads are refused and presets still work. */
export interface Attachments { store: AttachmentStore; prefix: string; publicBase: string; avatars?: AvatarStore | null }

/** Anyone holding a link can open the file, so the key carries 128 random bits; the name segment is for people. */
export function objectKeyFor(prefix: string, tabId: string, name: string): string {
  const safe = name.replaceAll(/[^A-Za-z0-9._-]+/g, '_').replace(/^[._]+/, '').slice(-120) || 'file'
  return [prefix.replace(/^\/+|\/+$/g, ''), tabId, randomBytes(16).toString('hex'), safe].filter(Boolean).join('/')
}
export const publicUrl = (base: string, objectKey: string) => `${base.replace(/\/+$/, '')}/${objectKey}`

/** How the bucket serves a file. The CDN shares a parent domain with the apps, so only raster images keep their type
 * and open in the browser. Anything else, HTML and SVG included, is stored as bytes to download, never run as a page.
 * The message keeps the declared type for clients to show. */
const INLINE = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])
export function served(name: string, mime: string): { contentType: string; contentDisposition: string } {
  const inline = INLINE.has(mime)
  return { contentType: inline ? mime : 'application/octet-stream',
    contentDisposition: `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(name)}` }
}

/** The raster type the first bytes really are, or null. */
export function imageTypeOf(head: Buffer): string | null {
  const ascii = (at: number, text: string) => head.subarray(at, at + text.length).toString('latin1') === text
  if (head.length >= 8 && head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png'
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'image/jpeg'
  if (ascii(0, 'GIF87a') || ascii(0, 'GIF89a')) return 'image/gif'
  if (head.length >= 12 && ascii(0, 'RIFF') && ascii(8, 'WEBP')) return 'image/webp'
  return null
}

/** The raster type `body`'s first bytes are, or null, and `body` handed back with those bytes in front, so the store
 * still reads the whole file as a stream. */
export async function peekType(body: Readable): Promise<{ type: string | null; body: Readable }> {
  // One iterator for the whole read: leaving a `for await` early would destroy the request stream.
  const source = body[Symbol.asyncIterator]()
  const parts: Buffer[] = []
  let length = 0, done = false
  while (length < 16) {
    const next = await source.next()
    if (next.done) { done = true; break }
    parts.push(Buffer.from(next.value)); length += next.value.length
  }
  const head = Buffer.concat(parts)
  const rest = async function* () {
    if (head.length) yield head
    while (!done) {
      const next = await source.next()
      if (next.done) return
      yield Buffer.from(next.value)
    }
  }
  return { type: imageTypeOf(head), body: Readable.from(rest()) }
}

/** A file that claims to be an image is served as one only when its first bytes agree, and then as what they say: a
 * renamed page or script never opens inline, and a .png that is really a JPEG still shows. */
export async function checkedType(mime: string, body: Readable): Promise<{ mime: string; body: Readable }> {
  if (!INLINE.has(mime)) return { mime, body }
  const peeked = await peekType(body)
  return { mime: peeked.type ?? 'application/octet-stream', body: peeked.body }
}

/** Counts what passes and fails the stream past `cap`, so a writer never commits more. */
async function capped(body: Readable, cap: number, sink: Writable): Promise<number> {
  let size = 0
  await pipeline(body, new Transform({ transform(chunk: Buffer, _encoding, done) {
    size += chunk.byteLength
    done(size > cap ? new AttachmentTooLarge(cap) : null, chunk)
  } }), sink)
  return size
}

/** A service account key the bucket is written with. */
export interface ServiceAccount { projectId?: string; credentials: { client_email: string; private_key: string } }

/** SUPER_TAB_ATTACHMENTS_CREDENTIALS: the base64 of a service account JSON key, or empty for application default
 * credentials. A bad value stops the backend at startup. No message repeats any of the value: JSON.parse's own
 * message quotes the text it failed on, so it is never passed on. */
export function serviceAccountFrom(raw: string): ServiceAccount | null {
  const value = raw.replaceAll(/\s+/g, '')
  if (!value) return null
  const invalid = (why: string): never => { throw new Error(`SUPER_TAB_ATTACHMENTS_CREDENTIALS ${why}. Set the base64 of the service account JSON key, or leave it empty to use application default credentials.`) }
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length % 4 === 1) invalid('is not base64')
  let key: Record<string, unknown> = {}
  try { key = JSON.parse(Buffer.from(value, 'base64').toString('utf8')) } catch { invalid('does not decode to JSON') }
  if (!key || typeof key !== 'object' || typeof key.client_email !== 'string' || !key.client_email
    || typeof key.private_key !== 'string' || !key.private_key.includes('PRIVATE KEY')) invalid('is not a service account key with client_email and private_key')
  return { ...(typeof key.project_id === 'string' ? { projectId: key.project_id } : {}),
    credentials: { client_email: key.client_email as string, private_key: key.private_key as string } }
}

export class GcsAttachmentStore implements AttachmentStore {
  private bucket: Promise<import('@google-cloud/storage').Bucket> | null = null
  constructor(private readonly name: string, private readonly account: ServiceAccount | null = null,
    private readonly cacheControl = 'public, max-age=31536000, immutable') {}
  // Loaded on first use, so a backend without a bucket never loads the client.
  protected files() {
    this.bucket ??= import('@google-cloud/storage').then(({ Storage }) => new Storage(this.account ?? undefined).bucket(this.name))
    return this.bucket
  }
  async put(objectKey: string, file: { name: string; mime: string }, body: Readable, cap: number) {
    const { contentType, contentDisposition } = served(file.name, file.mime)
    // One request, not a resumable session: a failed or refused stream aborts it and no object is written.
    const sink = (await this.files()).file(objectKey).createWriteStream({ resumable: false, contentType,
      metadata: { contentDisposition, cacheControl: this.cacheControl } })
    return capped(body, cap, sink)
  }
}

/** Avatars in a bucket that grants nobody read access: each read hands out V4 signed links instead (avatarLinks.ts). */
export class GcsAvatarStore extends GcsAttachmentStore implements AvatarStore {
  constructor(name: string, account: ServiceAccount | null = null) { super(name, account, 'private, max-age=3600') }
  async signedUrl(objectKey: string, expiresAt: number) {
    const [url] = await (await this.files()).file(objectKey).getSignedUrl({ version: 'v4', action: 'read', expires: expiresAt })
    return url
  }
}

export class MemoryAttachmentStore implements AttachmentStore {
  readonly objects = new Map<string, { bytes: Buffer; contentType: string; contentDisposition: string }>()
  async put(objectKey: string, file: { name: string; mime: string }, body: Readable, cap: number) {
    const chunks: Buffer[] = []
    const size = await capped(body, cap, new Writable({ write(chunk: Buffer, _encoding, done) { chunks.push(chunk); done() } }))
    this.objects.set(objectKey, { bytes: Buffer.concat(chunks), ...served(file.name, file.mime) })
    return size
  }
}

/** Avatars for tests and the local rig: links carry their expiry and an HMAC of it, and `open` honours both as the bucket would. */
export class MemoryAvatarStore extends MemoryAttachmentStore implements AvatarStore {
  private readonly secret = randomBytes(32)
  constructor(private readonly base: string) { super() }
  private sign(objectKey: string, expiresAt: number) {
    return createHmac('sha256', this.secret).update(`${objectKey}\n${expiresAt}`).digest('hex')
  }
  async signedUrl(objectKey: string, expiresAt: number) {
    return `${this.base}/${objectKey}?expires=${expiresAt}&signature=${this.sign(objectKey, expiresAt)}`
  }
  /** What the bucket answers [url] at [now]: the bytes, or null once the link is over or was not signed here. */
  open(url: string, now: number): Buffer | null {
    const link = new URL(url), objectKey = decodeURIComponent(link.pathname.slice(1)), expiresAt = Number(link.searchParams.get('expires'))
    if (!(expiresAt > now) || link.searchParams.get('signature') !== this.sign(objectKey, expiresAt)) return null
    return this.objects.get(objectKey)?.bytes ?? null
  }
}

export function attachmentsFromEnv(env: { NODE_ENV: string; SUPER_TAB_ATTACHMENTS_BUCKET: string; SUPER_TAB_ATTACHMENTS_CREDENTIALS: string;
  SUPER_TAB_ATTACHMENTS_PREFIX: string; SUPER_TAB_ATTACHMENTS_PUBLIC_BASE: string; SUPER_TAB_AVATARS_BUCKET: string }): Attachments | null {
  // Every message carries these links and every agent's computer downloads from them: in production only over HTTPS.
  // A local or test run may serve them from a plain loopback server.
  if (env.NODE_ENV === 'production' && new URL(env.SUPER_TAB_ATTACHMENTS_PUBLIC_BASE).protocol !== 'https:') {
    throw new Error('SUPER_TAB_ATTACHMENTS_PUBLIC_BASE must be an https:// address in production.')
  }
  // Read even without a bucket, so a broken key fails the deploy that set it rather than the one that adds the bucket.
  const account = serviceAccountFrom(env.SUPER_TAB_ATTACHMENTS_CREDENTIALS)
  if (!env.SUPER_TAB_ATTACHMENTS_BUCKET) return null
  // Avatars are member-only, so never the public attachments bucket: without a private one, uploads stay off.
  return { store: new GcsAttachmentStore(env.SUPER_TAB_ATTACHMENTS_BUCKET, account), prefix: env.SUPER_TAB_ATTACHMENTS_PREFIX,
    publicBase: env.SUPER_TAB_ATTACHMENTS_PUBLIC_BASE,
    avatars: env.SUPER_TAB_AVATARS_BUCKET ? new GcsAvatarStore(env.SUPER_TAB_AVATARS_BUCKET, account) : null }
}
