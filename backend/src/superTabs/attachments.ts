import { randomBytes } from 'node:crypto'
import { Transform, Writable, type Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { z } from 'zod'

/** Metadata as a message stores and returns it. The bytes stay in the bucket. */
export interface Attachment { id: string; name: string; mime: string; size: number; url: string }

export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024
export const MAX_ATTACHMENTS = 10

// Control, format (bidi overrides, zero-width) and line/paragraph separators: a name that hides its real shape.
export const attachmentName = z.string().trim().min(1).max(255).refine(value => !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value), 'Use a printable file name.')
export const attachmentMime = z.string().trim().toLowerCase().max(200).regex(/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/)

export class AttachmentTooLarge extends Error {
  constructor() { super(`A file can be at most ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB.`) }
}

/** The bucket behind the CDN. Tests and the local rig use the in-memory store below. */
export interface AttachmentStore {
  /** Streams `body` into the object and answers its size. Past `cap` bytes it throws AttachmentTooLarge and leaves no object. */
  put(objectKey: string, file: { name: string; mime: string }, body: Readable, cap: number): Promise<number>
}
export interface Attachments { store: AttachmentStore; prefix: string; publicBase: string }

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

/** Counts what passes and fails the stream past `cap`, so a writer never commits more. */
async function capped(body: Readable, cap: number, sink: Writable): Promise<number> {
  let size = 0
  await pipeline(body, new Transform({ transform(chunk: Buffer, _encoding, done) {
    size += chunk.byteLength
    done(size > cap ? new AttachmentTooLarge() : null, chunk)
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
  constructor(private readonly name: string, private readonly account: ServiceAccount | null = null) {}
  // Loaded on first use, so a backend without a bucket never loads the client.
  private files() {
    this.bucket ??= import('@google-cloud/storage').then(({ Storage }) => new Storage(this.account ?? undefined).bucket(this.name))
    return this.bucket
  }
  async put(objectKey: string, file: { name: string; mime: string }, body: Readable, cap: number) {
    const { contentType, contentDisposition } = served(file.name, file.mime)
    // One request, not a resumable session: a failed or refused stream aborts it and no object is written.
    const sink = (await this.files()).file(objectKey).createWriteStream({ resumable: false, contentType,
      metadata: { contentDisposition, cacheControl: 'public, max-age=31536000, immutable' } })
    return capped(body, cap, sink)
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

export function attachmentsFromEnv(env: { NODE_ENV: string; SUPER_TAB_ATTACHMENTS_BUCKET: string; SUPER_TAB_ATTACHMENTS_CREDENTIALS: string;
  SUPER_TAB_ATTACHMENTS_PREFIX: string; SUPER_TAB_ATTACHMENTS_PUBLIC_BASE: string }): Attachments | null {
  // Every message carries these links and every agent's computer downloads from them: in production only over HTTPS.
  // A local or test run may serve them from a plain loopback server.
  if (env.NODE_ENV === 'production' && new URL(env.SUPER_TAB_ATTACHMENTS_PUBLIC_BASE).protocol !== 'https:') {
    throw new Error('SUPER_TAB_ATTACHMENTS_PUBLIC_BASE must be an https:// address in production.')
  }
  // Read even without a bucket, so a broken key fails the deploy that set it rather than the one that adds the bucket.
  const account = serviceAccountFrom(env.SUPER_TAB_ATTACHMENTS_CREDENTIALS)
  if (!env.SUPER_TAB_ATTACHMENTS_BUCKET) return null
  return { store: new GcsAttachmentStore(env.SUPER_TAB_ATTACHMENTS_BUCKET, account), prefix: env.SUPER_TAB_ATTACHMENTS_PREFIX,
    publicBase: env.SUPER_TAB_ATTACHMENTS_PUBLIC_BASE }
}
