import { generateKeyPairSync } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { Readable } from 'node:stream'
import { AttachmentTooLarge, attachmentName, attachmentsFromEnv, checkedType, imageTypeOf, GcsAttachmentStore, GcsAvatarStore, MemoryAttachmentStore, objectKeyFor, served, serviceAccountFrom } from './attachments.js'

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const key = { type: 'service_account', project_id: 'harness-test', client_email: 'uploads@harness-test.iam.gserviceaccount.com',
  private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() }
const encoded = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64')
const env = (credentials: string, bucket = 'attachments', avatars = '') => ({ NODE_ENV: 'test', SUPER_TAB_ATTACHMENTS_BUCKET: bucket, SUPER_TAB_ATTACHMENTS_CREDENTIALS: credentials,
  SUPER_TAB_ATTACHMENTS_PREFIX: 'super-tabs', SUPER_TAB_ATTACHMENTS_PUBLIC_BASE: 'https://cdn.example.test', SUPER_TAB_AVATARS_BUCKET: avatars })

describe('attachment bucket credentials', () => {
  it('decodes a base64 service account key, also wrapped over lines', () => {
    const wrapped = encoded(key).replace(/(.{76})/g, '$1\n')
    expect(serviceAccountFrom(wrapped)).toEqual({ projectId: 'harness-test',
      credentials: { client_email: key.client_email, private_key: key.private_key } })
  })

  it('falls back to application default credentials when empty', () => {
    expect(serviceAccountFrom('')).toBeNull()
    expect(serviceAccountFrom(' \n')).toBeNull()
    expect(attachmentsFromEnv(env(''))?.store).toBeInstanceOf(GcsAttachmentStore)
    expect(attachmentsFromEnv(env('', ''))).toBeNull()
  })

  it('refuses a bad value at startup without repeating it, even with no bucket set', () => {
    const secret = 'not-base64-secret!'
    const cases: Array<[string, RegExp]> = [
      [secret, /is not base64/],
      [Buffer.from('{"private_key": "secret-material", oops').toString('base64'), /does not decode to JSON/],
      [encoded({ ...key, private_key: undefined }), /client_email and private_key/],
      [encoded({ ...key, client_email: '' }), /client_email and private_key/],
      [encoded('a string'), /client_email and private_key/],
    ]
    for (const [value, message] of cases) {
      let error: unknown
      try { attachmentsFromEnv(env(value, '')) } catch (thrown) { error = thrown }
      expect((error as Error).message).toMatch(message)
      expect((error as Error).message).not.toContain(secret)
      expect((error as Error).message).not.toContain('secret-material')
    }
  })

  it('takes a plain http file address only outside production', () => {
    const local = { ...env(''), SUPER_TAB_ATTACHMENTS_PUBLIC_BASE: 'http://127.0.0.1:9000' }
    expect(attachmentsFromEnv(local)?.publicBase).toBe('http://127.0.0.1:9000')
    expect(attachmentsFromEnv({ ...local, NODE_ENV: 'development' })).not.toBeNull()
    expect(() => attachmentsFromEnv({ ...local, NODE_ENV: 'production' })).toThrow('must be an https:// address in production')
    expect(attachmentsFromEnv({ ...env(''), NODE_ENV: 'production' })?.publicBase).toBe('https://cdn.example.test')
  })

  it('keeps avatars off without a private bucket, and never in the public one', () => {
    expect(attachmentsFromEnv(env(encoded(key)))?.avatars).toBeNull()
    expect(attachmentsFromEnv(env(encoded(key), 'attachments', 'avatars'))?.avatars).toBeInstanceOf(GcsAvatarStore)
  })

  it('signs an avatar link with the configured key, for a limited time, without a network call', async () => {
    const avatars = attachmentsFromEnv(env(encoded(key), 'attachments', 'avatars'))!.avatars!
    const expires = Date.now() + 3_600_000
    const link = new URL(await avatars.signedUrl('super-tabs/tab/0123/avatar', expires))
    expect(link.host).toBe('storage.googleapis.com')
    expect(link.pathname).toBe('/avatars/super-tabs/tab/0123/avatar')
    expect(link.searchParams.get('X-Goog-Credential')).toContain(key.client_email)
    expect(Number(link.searchParams.get('X-Goog-Expires'))).toBeLessThanOrEqual(3600)
  })

  it('builds the storage client from the configured key, without a network call', async () => {
    const store = attachmentsFromEnv(env(encoded(key)))!.store as GcsAttachmentStore
    const bucket = await (store as unknown as { files(): Promise<import('@google-cloud/storage').Bucket> }).files()
    expect(bucket.name).toBe('attachments')
    expect(bucket.storage.projectId).toBe('harness-test')
    expect((await bucket.storage.authClient.getCredentials()).client_email).toBe(key.client_email)
  })
})

describe('attachment files', () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52])
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1])
  const read = async (body: Readable) => { const parts: Buffer[] = []; for await (const chunk of body) parts.push(Buffer.from(chunk)); return Buffer.concat(parts) }

  it('tells raster images by their first bytes', () => {
    expect(imageTypeOf(png)).toBe('image/png')
    expect(imageTypeOf(jpeg)).toBe('image/jpeg')
    expect(imageTypeOf(Buffer.from('GIF89a......'))).toBe('image/gif')
    expect(imageTypeOf(Buffer.from('RIFF\0\0\0\0WEBPVP8 '))).toBe('image/webp')
    expect(imageTypeOf(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg">'))).toBeNull()
    expect(imageTypeOf(Buffer.alloc(0))).toBeNull()
  })

  it('serves a claimed image as what its bytes are, and hands the whole file on', async () => {
    const rest = Buffer.alloc(100_000, 7)
    // Small chunks, so the check has to gather the head across several and keep every byte.
    const chunks = [jpeg.subarray(0, 5), jpeg.subarray(5), rest]
    const renamed = await checkedType('image/png', Readable.from(chunks))
    expect(renamed.mime).toBe('image/jpeg')
    expect((await read(renamed.body)).equals(Buffer.concat([jpeg, rest]))).toBe(true)
    const page = Buffer.from('<html><script>alert(1)</script></html>')
    const disguised = await checkedType('image/png', Readable.from([page]))
    expect(disguised.mime).toBe('application/octet-stream')
    expect((await read(disguised.body)).equals(page)).toBe(true)
    const tiny = await checkedType('image/gif', Readable.from([Buffer.from('GI')]))
    expect(tiny.mime).toBe('application/octet-stream')
    expect((await read(tiny.body)).toString()).toBe('GI')
  })

  it('leaves files that do not claim to be images as they are', async () => {
    const body = Readable.from([Buffer.from('a,b\n')])
    const checked = await checkedType('text/csv', body)
    expect(checked).toEqual({ mime: 'text/csv', body })
  })

  it('serves only raster images as themselves; everything else downloads as bytes', () => {
    expect(served('a.png', 'image/png')).toEqual({ contentType: 'image/png', contentDisposition: "inline; filename*=UTF-8''a.png" })
    expect(served('page.html', 'text/html')).toEqual({ contentType: 'application/octet-stream', contentDisposition: "attachment; filename*=UTF-8''page.html" })
    expect(served('icon.svg', 'image/svg+xml').contentType).toBe('application/octet-stream')
    expect(served('ảnh 1.jpg', 'image/jpeg').contentDisposition).toBe("inline; filename*=UTF-8''%E1%BA%A3nh%201.jpg")
  })
  it('refuses names with control, format or separator characters', () => {
    for (const name of ['a\u0001.png', 'evil‮gnp.exe', 'zero​width.png', 'line .png', 'para .png']) {
      expect(attachmentName.safeParse(name).success).toBe(false)
    }
    expect(attachmentName.safeParse('Ảnh chụp màn hình 1.png').success).toBe(true)
  })
  it('keys each object under the tab with 128 random bits and a safe name', () => {
    expect(objectKeyFor('/super-tabs/', 'tab', '../Screen Shot.png')).toMatch(/^super-tabs\/tab\/[0-9a-f]{32}\/Screen_Shot\.png$/)
    expect(objectKeyFor('', 'tab', '...')).toMatch(/^tab\/[0-9a-f]{32}\/file$/)
  })
  it('stores up to the cap and refuses one byte more, keeping nothing', async () => {
    const store = new MemoryAttachmentStore()
    expect(await store.put('k1', { name: 'x.html', mime: 'text/html' }, Readable.from([Buffer.alloc(3), Buffer.alloc(2)]), 5)).toBe(5)
    expect(store.objects.get('k1')).toMatchObject({ contentType: 'application/octet-stream', contentDisposition: "attachment; filename*=UTF-8''x.html" })
    await expect(store.put('k2', { name: 'b.bin', mime: 'application/octet-stream' }, Readable.from([Buffer.alloc(6)]), 5)).rejects.toBeInstanceOf(AttachmentTooLarge)
    expect(store.objects.has('k2')).toBe(false)
  })
})
