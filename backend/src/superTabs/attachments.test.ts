import { generateKeyPairSync } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { Readable } from 'node:stream'
import { gzipSync } from 'node:zlib'
import { AttachmentTooLarge, attachmentName, attachmentsFromEnv, checkedType, directUploads, formFileBody, imageTypeOf, GcsAttachmentStore, MAX_ATTACHMENT_BYTES, MAX_FORM_ATTACHMENT_BYTES, MemoryAttachmentStore,
  objectKeyFor, served, serviceAccountFrom, typeFromHead, unpackFailed, UPLOAD_LINK_MS } from './attachments.js'

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const key = { type: 'service_account', project_id: 'harness-test', client_email: 'uploads@harness-test.iam.gserviceaccount.com',
  private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() }
const encoded = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64')
const env = (credentials: string, bucket = 'attachments') => ({ NODE_ENV: 'test', SUPER_TAB_ATTACHMENTS_BUCKET: bucket, SUPER_TAB_ATTACHMENTS_CREDENTIALS: credentials,
  SUPER_TAB_ATTACHMENTS_PREFIX: 'super-tabs', SUPER_TAB_ATTACHMENTS_PUBLIC_BASE: 'https://cdn.example.test' })

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

  it('signs an upload link for one new object of one exact size, as a download, for minutes, without a network call', async () => {
    const store = attachmentsFromEnv(env(encoded(key)))!.store as GcsAttachmentStore
    const expires = Date.now() + UPLOAD_LINK_MS
    const { url, headers } = await store.uploadLink('super-tabs/tab/0123/AC4.step', { name: 'AC4 - 26 Oct v2.step' }, 150 * 1024 * 1024, expires)
    const link = new URL(url)
    expect(link.host).toBe('storage.googleapis.com')
    expect(link.pathname).toBe('/attachments/super-tabs/tab/0123/AC4.step')
    expect(link.searchParams.get('X-Goog-Credential')).toContain(key.client_email)
    expect(Number(link.searchParams.get('X-Goog-Expires'))).toBeLessThanOrEqual(600)
    // Every rule is a signed header: storage refuses a request that drops or changes one.
    expect(link.searchParams.get('X-Goog-SignedHeaders')!.split(';')).toEqual(['cache-control', 'content-disposition', 'content-type', 'host',
      'x-goog-content-length-range', 'x-goog-if-generation-match'])
    expect(headers).toEqual({ 'content-type': 'application/octet-stream', 'content-disposition': "attachment; filename*=UTF-8''AC4%20-%2026%20Oct%20v2.step",
      'cache-control': 'private, max-age=600', 'x-goog-content-length-range': '157286400,157286400', 'x-goog-if-generation-match': '0' })
    expect(directUploads(store)).toBe(store)
  })

  // Each read of a chat file hands one of these (fileLinks.ts): a GET of one object, for minutes, opening whether or not the
  // bucket is public.
  it('signs a chat file read link with the configured key, for minutes, without a network call', async () => {
    const store = attachmentsFromEnv(env(encoded(key)))!.store
    const link = new URL(await store.signedUrl('super-tabs/tab/0123/notes.txt', Date.now() + 600_000))
    expect(link.host).toBe('storage.googleapis.com')
    expect(link.pathname).toBe('/attachments/super-tabs/tab/0123/notes.txt')
    expect(link.searchParams.get('X-Goog-Credential')).toContain(key.client_email)
    expect(Number(link.searchParams.get('X-Goog-Expires'))).toBeLessThanOrEqual(600)
    expect(link.searchParams.get('X-Goog-SignedHeaders')).toBe('host')
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
  it('deletes an object, and counts one already gone as deleted', async () => {
    const store = new MemoryAttachmentStore()
    await store.put('tab/k', { name: 'a.txt', mime: 'text/plain' }, Readable.from([Buffer.from('a')]), 5)
    await store.put('tab/other', { name: 'b.txt', mime: 'text/plain' }, Readable.from([Buffer.from('b')]), 5)
    await store.delete('tab/k')
    expect([store.objects.has('tab/k'), store.objects.has('tab/other')]).toEqual([false, true])
    await expect(store.delete('tab/k')).resolves.toBeUndefined()
  })
})

// A voice message's read and an upload's read-back give up on a silent bucket (store.ts): the download itself stops then, so it
// holds no memory and no connection after its caller gave up.
describe('reading from the bucket', () => {
  class Bucket extends GcsAttachmentStore {
    constructor(private readonly stream: () => Readable) { super('bucket') }
    protected override files() { return Promise.resolve({ file: () => ({ createReadStream: this.stream }) }) as never }
  }

  it('reads a whole object, or its first bytes, from its stream', async () => {
    const bucket = new Bucket(() => Readable.from([Buffer.from('RIFF'), Buffer.from('WAVE')]))
    expect((await bucket.read('k')).toString()).toBe('RIFFWAVE')
    expect((await bucket.head('k', 8)).toString()).toBe('RIFFWAVE')
  })

  it('stops the download when its caller gives up', async () => {
    const stream = new Readable({ read() {} })
    const control = new AbortController()
    const reading = new Bucket(() => stream).head('k', 16, control.signal)
    stream.push(Buffer.from('RIFF'))
    control.abort(new Error('timeout'))
    await expect(reading).rejects.toThrow()
    expect(stream.destroyed).toBe(true)
  })
})

describe('upload links on the memory bucket, with storage\'s rules', () => {
  const at = 1_800_000_000_000
  it('writes the linked object once, of exactly its size, before it expires, with its headers unchanged', async () => {
    let now = at
    const store = new MemoryAttachmentStore(() => now)
    const link = await store.uploadLink('k/big.bin', { name: 'big.bin' }, 5, at + UPLOAD_LINK_MS)
    expect(await store.receive(link.url, link.headers, Buffer.alloc(6))).toBe(400)
    expect(await store.receive(link.url, link.headers, Buffer.alloc(4))).toBe(400)
    expect(await store.receive(link.url, { ...link.headers, 'content-type': 'text/html' }, Buffer.alloc(5))).toBe(403)
    const { 'x-goog-if-generation-match': _, ...overwriting } = link.headers
    expect(await store.receive(link.url, overwriting, Buffer.alloc(5))).toBe(403)
    expect(await store.receive(link.url.replace('k%2Fbig.bin', 'k%2Fother.bin'), link.headers, Buffer.alloc(5))).toBe(403)
    expect(await store.stored('k/big.bin')).toBeNull()
    expect(await store.receive(link.url, link.headers, Buffer.from('hello'))).toBe(200)
    expect(store.objects.get('k/big.bin')).toMatchObject({ contentType: 'application/octet-stream', contentDisposition: "attachment; filename*=UTF-8''big.bin" })
    expect(await store.receive(link.url, link.headers, Buffer.from('HELLO'))).toBe(412)
    expect((await store.head('k/big.bin', 16)).toString()).toBe('hello')
    now = at + UPLOAD_LINK_MS
    const late = await store.uploadLink('k/late.bin', { name: 'late.bin' }, 1, at + UPLOAD_LINK_MS)
    expect(await store.receive(late.url, late.headers, Buffer.alloc(1))).toBe(403)
    await store.delete('k/big.bin')
    expect(await store.stored('k/big.bin')).toBeNull()
  })
  it('keeps a declared image only when its first bytes are one', () => {
    expect(typeFromHead('image/png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe('image/png')
    expect(typeFromHead('image/png', Buffer.from('<html>'))).toBe('application/octet-stream')
    expect(typeFromHead('model/step', Buffer.from('ISO-10303-21;'))).toBe('model/step')
  })
  it('caps a file at 256 MB, and a form at 10 MB, with the message that names the limit', () => {
    expect(MAX_ATTACHMENT_BYTES).toBe(256 * 1024 * 1024)
    expect(MAX_FORM_ATTACHMENT_BYTES).toBe(10 * 1024 * 1024)
    expect(new AttachmentTooLarge().message).toBe('Files can be up to 256 MB.')
  })
})

// A form file may come gzipped, so a gateway's content filter in front of the backend never reads a transcript's shell
// lines as an attack (task #2737). The store gets the original bytes.
describe('a form file sent gzipped', () => {
  const read = async (body: Readable) => { const parts: Buffer[] = []; for await (const part of body) parts.push(Buffer.from(part)); return Buffer.concat(parts) }
  const text = Buffer.from('$ rm -rf build && curl https://example.test/install.sh | sh\n'.repeat(200))

  it('unpacks gzip as it streams, and leaves a plain file as it is', async () => {
    expect((await read(formFileBody(Readable.from([gzipSync(text)]), 'gzip'))).equals(text)).toBe(true)
    const plain = Readable.from([text])
    expect(formFileBody(plain, null)).toBe(plain)
  })

  it('fails corrupt gzip with a zlib error, which reads as the client\'s', async () => {
    const body = formFileBody(Readable.from([Buffer.from('not gzip at all')]), 'gzip')
    await expect(read(body)).rejects.toMatchObject({ code: expect.stringMatching(/^Z_/) })
    expect(unpackFailed(body)).toBe(true)
    expect(unpackFailed(Readable.from([text]))).toBe(false)
  })

  it('passes the request stream\'s own failure on, so a cut form never hangs', async () => {
    const source = new Readable({ read() {} })
    const body = formFileBody(source, 'gzip')
    source.destroy(Object.assign(new Error('cut'), { code: 'FST_REQ_FILE_TOO_LARGE' }))
    await expect(read(body)).rejects.toMatchObject({ code: 'FST_REQ_FILE_TOO_LARGE' })
    expect(unpackFailed(body)).toBe(false)
  })
})
