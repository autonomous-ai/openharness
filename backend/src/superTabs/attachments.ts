import { createHmac, randomBytes } from 'node:crypto'
import { Readable, Transform, Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { z } from 'zod'

/** Metadata as a message stores and returns it. The bytes stay in the bucket. */
export interface Attachment { id: string; name: string; mime: string; size: number; url: string }

/** One chat file, whichever way it comes. Every client checks the same number before it sends (attachments.limits.test.ts). */
export const MAX_ATTACHMENT_BYTES = 256 * 1024 * 1024
/** The most a file sent in a multipart form to this server may be. Production sits behind Cloudflare, whose plans below
 *  Business refuse a request body over 100 MB, and an ingress whose body limit the repo does not set; 10 MB is what that
 *  path has carried since #1490. A bigger file goes straight to the bucket on an upload link (uploadLink below). */
export const MAX_FORM_ATTACHMENT_BYTES = 10 * 1024 * 1024
export const MAX_ATTACHMENTS = 10
/** How long an upload link may be started: storage checks it when a request begins, so a long transfer that started in time finishes. */
export const UPLOAD_LINK_MS = 10 * 60_000
/** The `purpose` of an upload whose link was handed out and whose bytes the server has not yet checked. Servers before this
 *  one refuse a row with any purpose as a message's file, so a rollout never sends a file that has not arrived. */
export const PENDING_UPLOAD_PURPOSE = 'pending-upload'
/** An unfinished upload the sweep has claimed (lib/pendingUploadSweep.ts): its stored file is being removed, so it can no
 *  longer be finished or sent. */
export const REMOVING_UPLOAD_PURPOSE = 'removing-upload'
export const TOO_LARGE_MESSAGE = 'Files can be up to 256 MB.'
/** Uploads a sender may start in a Swarm in an hour, and their bytes: bucket space for files that may never be sent. */
export const HOURLY_UPLOADS = 200
export const HOURLY_UPLOAD_BYTES = 4 * 1024 * 1024 * 1024
/** A link's upload never finished is removed, with what it stored, this long after the link was made: an hour after it expired. */
export const PENDING_UPLOAD_LIFE_MS = UPLOAD_LINK_MS + 3_600_000
/** The form route's own refusal, seen only by a client from before upload links. */
export const FORM_TOO_LARGE_MESSAGE = 'Update Harness to send files over 10 MB. Files can be up to 256 MB.'
/** An avatar is a small picture: Desktop resizes it before upload, and the backend still holds it to this. */
export const MAX_AVATAR_BYTES = 1024 * 1024
export const AVATAR_TYPES: ReadonlySet<string> = new Set(['image/png', 'image/jpeg', 'image/webp'])
/** The `purpose` of an avatar upload (schema.prisma SuperTabAttachment): never sendable as a chat file. */
export const AVATAR_PURPOSE = 'avatar'

// Control, format (bidi overrides, zero-width) and line/paragraph separators: a name that hides its real shape.
export const attachmentName = z.string().trim().min(1).max(255).refine(value => !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value), 'Use a printable file name.')
export const attachmentMime = z.string().trim().toLowerCase().max(200).regex(/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/)

export class AttachmentTooLarge extends Error {
  constructor(cap = MAX_ATTACHMENT_BYTES) {
    super(cap === MAX_ATTACHMENT_BYTES ? TOO_LARGE_MESSAGE : cap === MAX_FORM_ATTACHMENT_BYTES ? FORM_TOO_LARGE_MESSAGE : `A file can be at most ${cap / 1024 / 1024} MB.`)
  }
}

/** A link that writes one object once, straight to storage, and the headers its request must carry unchanged. */
export interface UploadLink { url: string; headers: Record<string, string> }

/** A bucket the client can write to directly. Each link names one object, which must not exist yet, of exactly `size` bytes,
 *  served as a download; storage itself refuses any other size, a second write, a changed header, or a start after `expiresAt`. */
export interface DirectUploads {
  uploadLink(objectKey: string, file: { name: string }, size: number, expiresAt: number): Promise<UploadLink>
  /** The stored object's size, or null while nothing is there. */
  stored(objectKey: string): Promise<{ size: number } | null>
  /** Its first `bytes` bytes. */
  head(objectKey: string, bytes: number): Promise<Buffer>
  /** Removes it; an object already gone counts as removed. */
  delete(objectKey: string): Promise<void>
}
export const directUploads = (store: AttachmentStore): DirectUploads | null =>
  'uploadLink' in store && typeof (store as Partial<DirectUploads>).uploadLink === 'function' ? store as AttachmentStore & DirectUploads : null

/** The headers an upload link signs. The bytes are not seen before they are served, so they are always a download, whatever
 *  type is declared; the message keeps the declared type (an image's checked from its first bytes) for clients to show. */
export function linkHeaders(name: string, size: number, cacheControl: string): Record<string, string> {
  return { 'content-type': 'application/octet-stream', 'content-disposition': served(name, 'application/octet-stream').contentDisposition,
    'cache-control': cacheControl, 'x-goog-content-length-range': `${size},${size}`, 'x-goog-if-generation-match': '0' }
}
/** A storage error's code or HTTP status, for a log line: its text can quote the object's key, which is the file's link. */
export const errorCode = (error: unknown): string | number | null =>
  error && typeof error === 'object' && 'code' in error && (typeof error.code === 'string' || typeof error.code === 'number') ? error.code : null
export const CHAT_CACHE_CONTROL = 'public, max-age=31536000, immutable'

/** The bucket behind the CDN. Tests and the local rig use the in-memory store below. */
export interface AttachmentStore {
  /** Streams `body` into the object and answers its size. Past `cap` bytes it throws AttachmentTooLarge and leaves no object. */
  put(objectKey: string, file: { name: string; mime: string }, body: Readable, cap: number): Promise<number>
}
/** Where avatars are kept, and the link a member read carries for one (avatarLinks.ts). */
export interface AvatarStore extends AttachmentStore {
  /** A link that opens [objectKey]: in a private bucket until [expiresAt] (epoch ms) and never after; on the CDN, for good. */
  signedUrl(objectKey: string, expiresAt: number): Promise<string>
}
/** `avatars`: where avatars are kept and how they are linked (AvatarStore); without it, avatar uploads are refused and presets
 *  still work. `avatarPrefix`: the folder avatar keys start with, and the only one a link is signed for (avatarLinks.ts);
 *  `prefix` when unset. */
export interface Attachments { store: AttachmentStore; prefix: string; publicBase: string; avatars?: AvatarStore | null; avatarPrefix?: string }
/** Avatars' folder in the attachments bucket, when they have no bucket of their own. */
export const SHARED_AVATAR_PREFIX = 'avatars'
export const trimPrefix = (prefix: string) => prefix.replace(/^\/+|\/+$/g, '')

/** Anyone holding a link can open the file, so the key carries 128 random bits; the name segment is for people. */
export function objectKeyFor(prefix: string, tabId: string, name: string): string {
  const safe = name.replaceAll(/[^A-Za-z0-9._-]+/g, '_').replace(/^[._]+/, '').slice(-120) || 'file'
  return [trimPrefix(prefix), tabId, randomBytes(16).toString('hex'), safe].filter(Boolean).join('/')
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

/** The type a checked upload keeps: a declared raster image only when its first bytes agree, as checkedType decides for a form. */
export const typeFromHead = (mime: string, head: Buffer) => INLINE.has(mime) ? imageTypeOf(head) ?? 'application/octet-stream' : mime

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

export class GcsAttachmentStore implements AttachmentStore, DirectUploads {
  private bucket: Promise<import('@google-cloud/storage').Bucket> | null = null
  constructor(private readonly name: string, private readonly account: ServiceAccount | null = null,
    private readonly cacheControl = CHAT_CACHE_CONTROL) {}
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
  /** A V4 signed PUT: the signature covers every header below, so storage refuses a request that drops or changes one. */
  async uploadLink(objectKey: string, file: { name: string }, size: number, expiresAt: number): Promise<UploadLink> {
    const { 'content-type': contentType, ...extensionHeaders } = linkHeaders(file.name, size, this.cacheControl)
    const [url] = await (await this.files()).file(objectKey).getSignedUrl({ version: 'v4', action: 'write', expires: expiresAt, contentType, extensionHeaders })
    return { url, headers: { 'content-type': contentType!, ...extensionHeaders } }
  }
  async stored(objectKey: string) {
    try {
      const [metadata] = await (await this.files()).file(objectKey).getMetadata()
      return { size: Number(metadata.size) }
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 404) return null
      throw error
    }
  }
  async head(objectKey: string, bytes: number) {
    const [content] = await (await this.files()).file(objectKey).download({ start: 0, end: bytes - 1 })
    return content
  }
  async delete(objectKey: string) {
    await (await this.files()).file(objectKey).delete({ ignoreNotFound: true })
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

/** Avatars in the attachments bucket, linked on its CDN as chat files are: permanent public links, so nothing is signed. */
export class CdnAvatarStore implements AvatarStore {
  constructor(readonly store: AttachmentStore, private readonly publicBase: string) {}
  put(objectKey: string, file: { name: string; mime: string }, body: Readable, cap: number) { return this.store.put(objectKey, file, body, cap) }
  async signedUrl(objectKey: string) { return publicUrl(this.publicBase, objectKey) }
}

export class MemoryAttachmentStore implements AttachmentStore, DirectUploads {
  readonly objects = new Map<string, { bytes: Buffer; contentType: string; contentDisposition: string; cacheControl?: string }>()
  private readonly linkSecret = randomBytes(32)
  constructor(private readonly now: () => number = Date.now) {}
  async put(objectKey: string, file: { name: string; mime: string }, body: Readable, cap: number) {
    const chunks: Buffer[] = []
    const size = await capped(body, cap, new Writable({ write(chunk: Buffer, _encoding, done) { chunks.push(chunk); done() } }))
    this.objects.set(objectKey, { bytes: Buffer.concat(chunks), ...served(file.name, file.mime) })
    return size
  }
  private linkSignature(objectKey: string, expiresAt: number, headers: Record<string, string>) {
    return createHmac('sha256', this.linkSecret).update(JSON.stringify([objectKey, expiresAt, Object.entries(headers).sort()])).digest('hex')
  }
  async uploadLink(objectKey: string, file: { name: string }, size: number, expiresAt: number): Promise<UploadLink> {
    const headers = linkHeaders(file.name, size, CHAT_CACHE_CONTROL)
    const url = `https://storage.memory.test/${encodeURIComponent(objectKey)}?expires=${expiresAt}&signature=${this.linkSignature(objectKey, expiresAt, headers)}`
    return { url, headers }
  }
  /** What the bucket answers a PUT to `url`, with storage's rules: the status, and the object written only on 200. */
  async receive(url: string, headers: Record<string, string>, body: Readable | Buffer): Promise<number> {
    const link = new URL(url), objectKey = decodeURIComponent(link.pathname.slice(1)), expiresAt = Number(link.searchParams.get('expires'))
    const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]))
    const signed = Object.fromEntries(['content-type', 'content-disposition', 'cache-control', 'x-goog-content-length-range', 'x-goog-if-generation-match']
      .flatMap(k => lower[k] === undefined ? [] : [[k, lower[k]!]]))
    const drain = async () => { if (!Buffer.isBuffer(body)) body.resume() }
    if (!(expiresAt > this.now()) || link.searchParams.get('signature') !== this.linkSignature(objectKey, expiresAt, signed) || lower.authorization) { await drain(); return 403 }
    if (signed['x-goog-if-generation-match'] === '0' && this.objects.has(objectKey)) { await drain(); return 412 }
    const [min, max] = (signed['x-goog-content-length-range'] ?? '').split(',').map(Number)
    const chunks: Buffer[] = []
    let size = 0
    try {
      size = await capped(Buffer.isBuffer(body) ? Readable.from([body]) : body, max ?? Infinity, new Writable({ write(chunk: Buffer, _encoding, done) { chunks.push(chunk); done() } }))
    } catch (error) { if (error instanceof AttachmentTooLarge) return 400; throw error }
    if (min !== undefined && size < min) return 400
    this.objects.set(objectKey, { bytes: Buffer.concat(chunks), contentType: signed['content-type']!, contentDisposition: signed['content-disposition']!,
      cacheControl: signed['cache-control'] })
    return 200
  }
  async stored(objectKey: string) { const object = this.objects.get(objectKey); return object ? { size: object.bytes.byteLength } : null }
  async head(objectKey: string, bytes: number) { return (this.objects.get(objectKey)?.bytes ?? Buffer.alloc(0)).subarray(0, bytes) }
  async delete(objectKey: string) { this.objects.delete(objectKey) }
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
  const base = { store: new GcsAttachmentStore(env.SUPER_TAB_ATTACHMENTS_BUCKET, account), prefix: env.SUPER_TAB_ATTACHMENTS_PREFIX,
    publicBase: env.SUPER_TAB_ATTACHMENTS_PUBLIC_BASE }
  // A bucket of their own wins: nobody reads it without a signed link.
  if (env.SUPER_TAB_AVATARS_BUCKET) return { ...base, avatars: new GcsAvatarStore(env.SUPER_TAB_AVATARS_BUCKET, account), avatarPrefix: trimPrefix(base.prefix) }
  // Prod has only the attachments bucket (Ken, 2026-10-28, option B1): avatars live there in their own folder and are linked
  // on its CDN like chat files, so anyone who once had a picture's link keeps it (docs/swarms.md). Chat files never go in
  // the avatar folder, and avatar links are made for that folder alone.
  const chat = trimPrefix(base.prefix)
  if (chat === SHARED_AVATAR_PREFIX || chat.startsWith(`${SHARED_AVATAR_PREFIX}/`)) {
    throw new Error(`SUPER_TAB_ATTACHMENTS_PREFIX must not be ${SHARED_AVATAR_PREFIX}/ or inside it while avatars share the attachments bucket. Pick another prefix, or set SUPER_TAB_AVATARS_BUCKET.`)
  }
  return { ...base, avatars: new CdnAvatarStore(base.store, base.publicBase), avatarPrefix: SHARED_AVATAR_PREFIX }
}
