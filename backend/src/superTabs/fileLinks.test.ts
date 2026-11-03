import { describe, expect, it } from 'vitest'
import { MemoryAttachmentStore, type Attachment } from './attachments.js'
import { FILE_LINK_TTL_MS, FILE_LINK_WINDOW_MS, FileLinks, fileLinkExpiry, MAX_CACHED_LINKS } from './fileLinks.js'

const base = 'https://cdn.example.test'
const now = Date.UTC(2026, 9, 31, 17, 2)
const file = (key: string, id = 'f1'): Attachment => ({ id, name: 'notes.txt', mime: 'text/plain', size: 5, url: `${base}/${key}` })
const row = (...files: Attachment[]) => ({ id: 'm1', attachments: files })

describe('chat file links', () => {
  it('adds a signed link that opens until it expires, beside the public address older apps open', async () => {
    const bucket = new MemoryAttachmentStore(() => now)
    bucket.objects.set('super-tabs/tab1/abc/notes.txt', { bytes: Buffer.from('hello'), contentType: 'text/plain', contentDisposition: 'attachment' })
    const [read] = await new FileLinks(bucket, base, 'super-tabs').forRows('tab1', [row(file('super-tabs/tab1/abc/notes.txt'))], now)
    const [linked] = read!.attachments
    expect(linked!.url).toBe(`${base}/super-tabs/tab1/abc/notes.txt`)
    expect(linked!.link!.startsWith('https://storage.memory.test/')).toBe(true)
    expect(linked!.expiresAt).toBe(fileLinkExpiry(now))
    expect(linked!.expiresAt! - now).toBeGreaterThan(FILE_LINK_TTL_MS - FILE_LINK_WINDOW_MS)
    expect(linked!.expiresAt! - now).toBeLessThanOrEqual(FILE_LINK_TTL_MS)
    expect(bucket.open(linked!.link!, now)?.toString()).toBe('hello')
    // A copied link stops opening once its time is over: the removed member's case.
    expect(bucket.open(linked!.link!, linked!.expiresAt!)).toBeNull()
    // Only the fields a message stores for a file go out, and the link.
    expect(Object.keys(linked!).sort()).toEqual(['expiresAt', 'id', 'link', 'mime', 'name', 'size', 'url'])
  })

  it('links only files in the reading Swarm\'s own folder', async () => {
    const links = new FileLinks(new MemoryAttachmentStore(() => now), base, 'super-tabs')
    const [read] = await links.forRows('tab1', [row(
      file('super-tabs/tab1/abc/ok.txt', 'ok'),
      file('super-tabs/tab2/abc/other-swarm.txt', 'other'),
      file('avatars/tab1/abc/avatar', 'avatar'),
      file('super-tabs/tab1x/abc/prefix-lookalike.txt', 'lookalike'),
      file('super-tabs/tab1/../tab2/abc/escape.txt', 'escape'),
      file('super-tabs/tab1/abc/x.txt?y=1', 'query'),
      { ...file('super-tabs/tab1/abc/elsewhere.txt', 'elsewhere'), url: 'https://evil.example.test/super-tabs/tab1/abc/elsewhere.txt' },
    )], now)
    expect(Object.fromEntries(read!.attachments.map(a => [a.id, !!a.link]))).toEqual(
      { ok: true, other: false, avatar: false, lookalike: false, escape: false, query: false, elsewhere: false })
    expect(read!.attachments.filter(a => !a.link).every(a => a.expiresAt === undefined && a.unlinked === true)).toBe(true)
    expect(read!.attachments.find(a => a.link)!.unlinked).toBeUndefined()
  })

  it('signs each file once per window however many reads ask at once, and afresh in the next window', async () => {
    const signed: string[] = []
    const bucket = { signedUrl: async (key: string, expiresAt: number) => { signed.push(key); await new Promise(r => setTimeout(r, 5)); return `https://storage.example.test/${key}?e=${expiresAt}` } }
    const links = new FileLinks(bucket, base, 'super-tabs')
    const page = [row(file('super-tabs/tab1/a/one.txt', 'one')), row(file('super-tabs/tab1/a/one.txt', 'one'), file('super-tabs/tab1/b/two.txt', 'two'))]
    const reads = await Promise.all([links.forRows('tab1', page, now), links.forRows('tab1', page, now + 1000)])
    expect(signed.sort()).toEqual(['super-tabs/tab1/a/one.txt', 'super-tabs/tab1/b/two.txt'])
    expect(reads[0]![0]!.attachments[0]!.link).toBe(reads[1]![1]!.attachments[0]!.link)
    await links.forRows('tab1', page, now + FILE_LINK_WINDOW_MS)
    expect(signed).toHaveLength(4)
  })

  it('signs at most eight at once for one read', async () => {
    let running = 0, most = 0
    const bucket = { signedUrl: async (key: string) => { running++; most = Math.max(most, running); await new Promise(r => setTimeout(r, 2)); running--; return `https://s.test/${key}` } }
    const page = Array.from({ length: 40 }, (_, i) => row(file(`super-tabs/tab1/k${i}/f.txt`, `f${i}`)))
    const read = await new FileLinks(bucket, base, 'super-tabs').forRows('tab1', page, now)
    expect(read.every(r => r.attachments[0]!.link!.startsWith('https://s.test/'))).toBe(true)
    expect(most).toBe(8)
  })

  it('a signature that fails reads as not available and is tried again on the next read', async () => {
    let fail = true
    const bucket = { signedUrl: async (key: string) => { if (fail) throw Object.assign(new Error(`denied ${key}`), { code: 403 }); return `https://s.test/${key}` } }
    const links = new FileLinks(bucket, base, 'super-tabs')
    const first = await links.forRows('tab1', [row(file('super-tabs/tab1/a/one.txt'))], now)
    expect(first[0]!.attachments[0]!.link).toBeUndefined()
    expect(first[0]!.attachments[0]!.expiresAt).toBeUndefined()
    // Marked, so an app asks again or says to try again rather than open the public address (review 1 of #2460).
    expect(first[0]!.attachments[0]!.unlinked).toBe(true)
    fail = false
    const second = await links.forRows('tab1', [row(file('super-tabs/tab1/a/one.txt'))], now)
    expect(second[0]!.attachments[0]!.link).toBe('https://s.test/super-tabs/tab1/a/one.txt')
  })

  it('keeps no more than its cap of links', async () => {
    let count = 0
    const links = new FileLinks({ signedUrl: async key => { count++; return `https://s.test/${key}` } }, base, 'super-tabs')
    const page = (from: number, n: number) => Array.from({ length: n }, (_, i) => row(file(`super-tabs/tab1/k${from + i}/f.txt`, `f${i}`)))
    await links.forRows('tab1', page(0, MAX_CACHED_LINKS), now)
    expect((links as unknown as { signed: Map<string, unknown> }).signed.size).toBe(MAX_CACHED_LINKS)
    await links.forRows('tab1', page(MAX_CACHED_LINKS, 1), now)
    expect((links as unknown as { signed: Map<string, unknown> }).signed.size).toBe(1)
    expect(count).toBe(MAX_CACHED_LINKS + 1)
  })

  it('leaves rows without files as they are', async () => {
    const rows = [{ id: 'a' }, { id: 'b', attachments: null }, { id: 'c', attachments: [] }]
    expect(await new FileLinks({ signedUrl: async () => { throw new Error('never') } }, base, 'super-tabs').forRows('tab1', rows, now)).toBe(rows)
  })
})
