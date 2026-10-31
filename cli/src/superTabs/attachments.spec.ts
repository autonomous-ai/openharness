import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { PASTE_DROPS_DIR } from '../lib/pasteDropFiles.js'
import { attachedFiles, attachmentsOf, diskName, formatSize, MAX_ATTACHMENT_BYTES, servedFrom } from './attachments.js'

const base = 'https://cdn.example.test'
const file = (over: Record<string, unknown> = {}) => ({ id: 'a1', name: 'screen.png', mime: 'image/png', size: 5, url: `${base}/super-tabs/tab/abc/screen.png`, ...over })
const replying = (bytes: Uint8Array, status = 200) => vi.fn(async () => new Response(bytes, { status }))
/** The files in paste-drops written under [name]: a failed download must leave none, not even part of one. */
const dropped = (name: string) => { try { return readdirSync(PASTE_DROPS_DIR).filter(f => f.endsWith(`-${name}`)) } catch { return [] } }
/** A body of [chunks] chunks of 64 KiB of zeros, made as it is read (no large buffer), that then waits on [hold], if any. As fetch
 * does, it errors once the request's signal aborts. */
function streamed(chunks: number, hold?: Promise<void>) {
  const chunk = new Uint8Array(64 * 1024)
  return vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    let sent = 0
    const body = new ReadableStream<Uint8Array>({
      start(controller) { init?.signal?.addEventListener('abort', () => controller.error(init.signal!.reason)) },
      async pull(controller) {
        if (sent < chunks) { sent++; controller.enqueue(chunk); return }
        if (hold) await hold
        controller.close()
      },
    })
    return new Response(body)
  })
}

describe('Super Tab attachment downloads', () => {
  it('downloads each file into paste-drops and lists its path for the prompt', async () => {
    const fetcher = replying(new Uint8Array([1, 2, 3, 4, 5]))
    const listed = await attachedFiles({ attachments: [file()] }, { base, fetch: fetcher })
    expect(listed.complete).toBe(true)
    const [, path] = listed.text.match(/^Attached files:\n- (\/\S+-screen\.png) \(sent as "screen\.png", 5 B\)$/) ?? []
    expect([...readFileSync(path!)]).toEqual([1, 2, 3, 4, 5])
    expect(fetcher).toHaveBeenCalledWith(file().url, expect.objectContaining({ redirect: 'error' }))
    // The paths it wrote, so a Buddy's guard may list them for its own person's files (lib/buddyGuard.ts).
    expect(listed.paths).toEqual([path])
  })
  it('names only the files it wrote among those of a message', async () => {
    const fetcher = vi.fn(async (url: string) => url.endsWith('gone.png') ? new Response(null, { status: 404 }) : new Response(new Uint8Array(5)))
    const listed = await attachedFiles({ attachments: [file(), file({ name: 'gone.png', url: `${base}/super-tabs/tab/abc/gone.png` })] }, { base, fetch: fetcher as typeof fetch })
    expect(listed.complete).toBe(false)
    const [, path] = listed.text.match(/- (\/\S+-screen\.png) /) ?? []
    expect(listed.paths).toEqual([path])
    expect(await attachedFiles({ text: 'no files' }, { base, fetch: fetcher as typeof fetch })).toEqual({ text: '', complete: true, paths: [] })
  })
  it('keeps shell syntax out of the path and the original name in the label', async () => {
    const name = '$(curl x|sh) "a b";.png'
    const listed = await attachedFiles({ attachments: [file({ name })] }, { base, fetch: replying(new Uint8Array(5)) })
    const [, path] = listed.text.match(/^Attached files:\n- (\S+) \(sent as (.+), 5 B\)$/) ?? []
    expect(basename(path!)).toMatch(/^[0-9a-f]{8}-_curl_x_sh_a_b_\.png$/)
    expect(listed.text).toContain(`(sent as ${JSON.stringify(name)}, 5 B)`)
    expect([diskName('..'), diskName('-rf.txt'), diskName('ảnh.png')]).toEqual(['file', 'rf.txt', '_nh.png'])
  })
  it('tries a failing file again, up to three times, and says when it never arrived', async () => {
    const flaky = vi.fn().mockResolvedValueOnce(new Response(null, { status: 503 })).mockResolvedValueOnce(new Response(new Uint8Array(5)))
    expect(await attachedFiles({ attachments: [file()] }, { base, fetch: flaky })).toMatchObject({ complete: true })
    expect(flaky).toHaveBeenCalledTimes(2)
    const down = replying(new Uint8Array(0), 503)
    expect(await attachedFiles({ attachments: [file()] }, { base, fetch: down }))
      .toEqual({ text: `Attached files:\n- Could not download a file (sent as "screen.png", 5 B): HTTP 503`, complete: false, paths: [] })
    expect(down).toHaveBeenCalledTimes(3)
    const short = replying(new Uint8Array(2))
    expect((await attachedFiles({ attachments: [file()] }, { base, fetch: short })).text).toContain('incomplete download')
  })
  it('stops trying when the message’s time budget is spent', async () => {
    let clock = 0
    const slow = vi.fn(async () => { clock += 30_000; return new Response(null, { status: 503 }) })
    expect(await attachedFiles({ attachments: [file()] }, { base, fetch: slow, now: () => clock, budgetMs: 45_000 })).toMatchObject({ complete: false })
    expect(slow).toHaveBeenCalledTimes(2)
    expect(await attachedFiles({ attachments: [file()] }, { base, fetch: slow, now: () => clock, budgetMs: 0 }))
      .toEqual({ text: `Attached files:\n- Could not download a file (sent as "screen.png", 5 B): out of time`, complete: false, paths: [] })
  })
  it('fetches only from the public base, and never retries a refusal', async () => {
    const fetcher = replying(new Uint8Array(5))
    const listed = await attachedFiles({ attachments: [file({ url: 'https://evil.example.test/x.png' }), file({ url: 'https://cdn.example.test.evil/x' }),
      file({ url: `${base}/y.png`, size: 3 })] }, { base: `${base}/`, fetch: fetcher })
    expect(listed.text).toContain('- Could not download a file (sent as "screen.png", 5 B): not a Harness file address')
    expect(listed.text).not.toContain('evil')
    expect(listed.text).toContain(`- Could not download a file (sent as "screen.png", 3 B): larger than declared`)
    expect(fetcher).toHaveBeenCalledTimes(1)
    const missing = replying(new Uint8Array(0), 404)
    expect((await attachedFiles({ attachments: [file()] }, { base, fetch: missing })).text).toContain('HTTP 404')
    expect(missing).toHaveBeenCalledTimes(1)
  })
  it('refuses a file declared over the 256 MB limit before fetching it', async () => {
    const fetcher = replying(new Uint8Array(5))
    const listed = await attachedFiles({ attachments: [file({ size: 256 * 1024 * 1024 + 1 })] }, { base, fetch: fetcher })
    expect(listed).toMatchObject({ complete: false, paths: [] })
    expect(listed.text).toContain('over the 256 MB limit')
    expect(fetcher).not.toHaveBeenCalled()
    expect(MAX_ATTACHMENT_BYTES).toBe(256 * 1024 * 1024)
  })
  it('downloads a file past the old 10 MB form limit, streamed to disk as it arrives', async () => {
    let release!: () => void
    const hold = new Promise<void>(resolve => { release = resolve })
    const name = 'twelve-mb-streamed.bin', size = 12 * 1024 * 1024
    const pending = attachedFiles({ attachments: [file({ name, size })] }, { base, fetch: streamed(size / (64 * 1024), hold) })
    // On disk before the last byte came: the bytes are written as they arrive, never collected in memory first.
    await vi.waitFor(() => { expect(dropped(name).map(f => statSync(join(PASTE_DROPS_DIR, f)).size)).toEqual([size]) })
    release()
    const listed = await pending
    expect(listed.complete).toBe(true)
    expect(statSync(listed.paths[0]!).size).toBe(size)
  })
  it('refuses a body past its declared size or short of it, and keeps no part of it', async () => {
    const over = 'over-declared.bin', short = 'short-of-declared.bin'
    const too = await attachedFiles({ attachments: [file({ name: over, size: 3 * 64 * 1024 })] }, { base, fetch: streamed(4) })
    expect(too.text).toContain('larger than declared')
    expect(dropped(over)).toEqual([])
    const few = await attachedFiles({ attachments: [file({ name: short, size: 3 * 64 * 1024 })] }, { base, fetch: streamed(2) })
    expect(few).toMatchObject({ complete: false, paths: [] })
    expect(few.text).toContain('incomplete download')
    expect(dropped(short)).toEqual([])
    // A declared length past the size is refused before a byte is read.
    const declared = vi.fn(async () => new Response(new Uint8Array(5), { headers: { 'content-length': '6' } }))
    expect((await attachedFiles({ attachments: [file()] }, { base, fetch: declared })).text).toContain('larger than declared')
    expect(declared).toHaveBeenCalledTimes(1)
  })
  it('ends a download once no bytes come for the idle time, tries again, and keeps no part of it', async () => {
    const name = 'stalls.bin'
    const stalled = streamed(1, new Promise<void>(() => {}))
    const listed = await attachedFiles({ attachments: [file({ name, size: 2 * 64 * 1024 })] }, { base, fetch: stalled, idleMs: 50 })
    expect(listed).toMatchObject({ complete: false, paths: [] })
    expect(listed.text).toContain('no bytes came for')
    expect(stalled).toHaveBeenCalledTimes(3)
    expect(dropped(name)).toEqual([])
  })
  it('downloads a file two deliveries share once at a time, and gives each its own copy', async () => {
    let release!: () => void
    const hold = new Promise<void>(resolve => { release = resolve })
    const fetcher = streamed(2, hold), inFlight = new Map()
    const shared = file({ name: 'shared-once.bin', size: 2 * 64 * 1024 })
    const both = Promise.all([attachedFiles({ attachments: [shared] }, { base, fetch: fetcher, inFlight }),
      attachedFiles({ attachments: [shared] }, { base, fetch: fetcher, inFlight })])
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalled())
    release()
    const [first, second] = await both
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect([first.complete, second.complete]).toEqual([true, true])
    const [mine, theirs] = [first.paths[0]!, second.paths[0]!]
    // Each delivery's own file in paste-drops, named as any download is, with the same bytes.
    expect(mine).not.toBe(theirs)
    expect(dirname(theirs)).toBe(PASTE_DROPS_DIR)
    expect(basename(theirs)).toMatch(/^[0-9a-f]{8}-shared-once\.bin$/)
    expect(statSync(theirs).mode).toBe(statSync(mine).mode)
    expect(readFileSync(theirs).equals(readFileSync(mine))).toBe(true)
    // One agent editing its copy leaves the other's as it was, so a Buddy guard's hash of it still matches.
    writeFileSync(mine, 'edited')
    expect(readFileSync(theirs).byteLength).toBe(2 * 64 * 1024)
    expect(second.text).toContain(theirs)
    // Done, it is no longer in flight: a later delivery downloads it again.
    expect(inFlight.size).toBe(0)
  })
  it('stops a download when told to, and keeps no part of it', async () => {
    const name = 'told-to-stop.bin', stop = new AbortController()
    const pending = attachedFiles({ attachments: [file({ name, size: 3 * 64 * 1024 })] }, { base, fetch: streamed(1, new Promise<void>(() => {})), signal: stop.signal })
    await vi.waitFor(() => expect(dropped(name)).toHaveLength(1))
    stop.abort()
    expect(await pending).toMatchObject({ complete: false, paths: [] })
    expect(dropped(name)).toEqual([])
  })
  it('refuses a file the disk has no room for, before fetching it and without trying again', async () => {
    const fetcher = replying(new Uint8Array(5))
    const size = 100 * 1024 * 1024
    // Room for the file but not the 512 MB kept free beside it.
    const statfs = vi.fn(async () => ({ bavail: (size + 256 * 1024 * 1024) / 4096, bsize: 4096 }))
    const listed = await attachedFiles({ attachments: [file({ size })] }, { base, fetch: fetcher, statfs })
    expect(listed).toEqual({ text: `Attached files:\n- Could not download a file (sent as "screen.png", 100.0 MB): not enough free disk space`,
      complete: false, paths: [] })
    expect(fetcher).not.toHaveBeenCalled()
    expect(statfs).toHaveBeenCalledWith(PASTE_DROPS_DIR)
    // With the room, it goes ahead.
    const roomy = vi.fn(async () => ({ bavail: 2 * 1024 * 1024 * 1024 / 4096, bsize: 4096 }))
    expect(await attachedFiles({ attachments: [file()] }, { base, fetch: fetcher, statfs: roomy })).toMatchObject({ complete: true })
  })
  it('keeps a shared download going while one delivery still wants it, and stops it, keeping nothing, once none does', async () => {
    const name = 'wanted-by-two.bin', inFlight = new Map()
    let release!: () => void
    const hold = new Promise<void>(resolve => { release = resolve })
    const fetcher = streamed(1, hold)
    const shared = file({ name, size: 64 * 1024 })
    const [one, two] = [new AbortController(), new AbortController()]
    const first = attachedFiles({ attachments: [shared] }, { base, fetch: fetcher, inFlight, signal: one.signal })
    const second = attachedFiles({ attachments: [shared] }, { base, fetch: fetcher, inFlight, signal: two.signal })
    await vi.waitFor(() => expect(dropped(name)).toHaveLength(1))
    // The first delivery left: the second still gets the file.
    one.abort()
    release()
    expect((await second).complete).toBe(true)
    await first
    // Both leave a download still under way: it stops, and its part file goes.
    const name2 = 'wanted-by-none.bin'
    const again = streamed(1, new Promise<void>(() => {}))
    const [three, four] = [new AbortController(), new AbortController()]
    const lone = file({ name: name2, size: 2 * 64 * 1024, url: `${base}/super-tabs/tab/abc/${name2}` })
    const third = attachedFiles({ attachments: [lone] }, { base, fetch: again, inFlight, signal: three.signal })
    const fourth = attachedFiles({ attachments: [lone] }, { base, fetch: again, inFlight, signal: four.signal })
    await vi.waitFor(() => expect(dropped(name2)).toHaveLength(1))
    three.abort(); four.abort()
    expect(await third).toMatchObject({ complete: false })
    expect(await fourth).toMatchObject({ complete: false })
    expect(dropped(name2)).toEqual([])
    expect(inFlight.size).toBe(0)
  })
  it('gives a large message time to finish: its budget grows with the bytes it declares', async () => {
    let clock = 0
    const slow = vi.fn(async () => { clock += 30_000; return new Response(null, { status: 503 }) })
    // 45 s would allow two tries of 30 s; 256 MB at the slowest steady pace allows all three.
    expect(await attachedFiles({ attachments: [file({ size: MAX_ATTACHMENT_BYTES })] }, { base, fetch: slow, now: () => clock })).toMatchObject({ complete: false })
    expect(slow).toHaveBeenCalledTimes(3)
  })
  it('reads only well-formed attachment rows and formats sizes', async () => {
    expect(attachmentsOf({})).toEqual([])
    expect(attachmentsOf({ attachments: [file(), { name: 'x' }, file({ size: -1 }), 'junk'] })).toEqual([file()])
    expect(await attachedFiles({ text: 'no files' })).toEqual({ text: '', complete: true, paths: [] })
    expect([formatSize(12), formatSize(2048), formatSize(3 * 1024 * 1024)]).toEqual(['12 B', '2.0 KB', '3.0 MB'])
    expect([servedFrom(base, `${base}/a`), servedFrom(`${base}/files`, `${base}/filesx/a`), servedFrom(base, 'not a url'),
      servedFrom(base, `https://user:pw@cdn.example.test/a`)]).toEqual([true, false, false, false])
  })

  // Chat files open through short-lived signed links (backend superTabs/fileLinks.ts, security review of Delete Swarm 10-31).
  describe('signed links', () => {
    const signedBase = 'https://storage.example.test'
    const signed = (over: Record<string, unknown> = {}) => file({ url: `${signedBase}/bucket/super-tabs/tab/abc/screen.png?X-Goog-Signature=secret`,
      expiresAt: 600_000, ...over })
    const fresh = (url = `${signedBase}/bucket/super-tabs/tab/abc/screen.png?X-Goog-Signature=fresh`) =>
      vi.fn(async (sent: { id: string }) => ({ ...signed(), id: sent.id, url, expiresAt: 1_200_000 }))

    it('downloads from the signed-link host, and from nowhere that only looks like it', async () => {
      const fetcher = replying(new Uint8Array(5))
      expect((await attachedFiles({ attachments: [signed()] }, { base, signedBase, fetch: fetcher, now: () => 0 })).complete).toBe(true)
      expect([servedFrom(base, `${signedBase}/b/k`, signedBase), servedFrom(base, 'https://storage.example.test.evil/b/k', signedBase),
        servedFrom(base, 'http://storage.example.test/b/k', signedBase), servedFrom(base, 'https://u:p@storage.example.test/b/k', signedBase)])
        .toEqual([true, false, false, false])
    })

    it('never writes a link into the prompt, only the file\'s name and size', async () => {
      const listed = await attachedFiles({ attachments: [signed()] }, { base, signedBase, fetch: replying(new Uint8Array(0), 503), now: () => 0 })
      expect(listed.complete).toBe(false)
      expect(listed.text).toBe('Attached files:\n- Could not download a file (sent as "screen.png", 5 B): HTTP 503')
      expect(listed.text).not.toContain('Signature')
    })

    it('starts with a fresh link when its own is about to end, and takes a fresh one when storage says it is over', async () => {
      const ending = fresh(), fetcher = replying(new Uint8Array(5))
      expect((await attachedFiles({ attachments: [signed({ expiresAt: 10_000 })] }, { base, signedBase, fetch: fetcher, now: () => 0, relink: ending })).complete).toBe(true)
      expect(ending).toHaveBeenCalledTimes(1)
      expect(fetcher).toHaveBeenCalledWith(expect.stringContaining('Signature=fresh'), expect.anything())
      // A link that was over by the time the request started (403): one fresh link, then the bytes.
      const over = vi.fn().mockResolvedValueOnce(new Response(null, { status: 403 })).mockResolvedValue(new Response(new Uint8Array(5)))
      const relink = fresh()
      expect((await attachedFiles({ attachments: [signed()] }, { base, signedBase, fetch: over, now: () => 0, relink })).complete).toBe(true)
      expect(relink).toHaveBeenCalledTimes(1)
      expect(over.mock.calls.map(c => String(c[0]).split('=').at(-1))).toEqual(['secret', 'fresh'])
    })

    it('stops at once when the reader may no longer read the file, and never retries without a way to relink', async () => {
      const over = vi.fn(async () => new Response(null, { status: 403 }))
      const refused = vi.fn(async () => { throw Object.assign(new Error('This file is no longer available.'), { status: 404 }) })
      const listed = await attachedFiles({ attachments: [signed()] }, { base, signedBase, fetch: over, now: () => 0, relink: refused })
      expect(listed).toEqual({ text: 'Attached files:\n- Could not download a file (sent as "screen.png", 5 B): no longer available', complete: false, paths: [] })
      expect([over.mock.calls.length, refused.mock.calls.length]).toEqual([1, 1])
      // The backend could not answer just now: said so, not as access lost.
      const down = vi.fn(async () => { throw Object.assign(new Error('Could not reach this Super Tab.'), { status: 503 }) })
      expect((await attachedFiles({ attachments: [signed()] }, { base, signedBase, fetch: vi.fn(async () => new Response(null, { status: 403 })), now: () => 0,
        relink: down })).text).toContain('could not get a fresh link')
      // No relink: one try, the expired link is not fetched again.
      const alone = vi.fn(async () => new Response(null, { status: 403 }))
      expect((await attachedFiles({ attachments: [signed()] }, { base, signedBase, fetch: alone, now: () => 0 })).complete).toBe(false)
      expect(alone).toHaveBeenCalledTimes(1)
      // A file the server could not link reads as not available, and is never fetched.
      const none = vi.fn()
      expect((await attachedFiles({ attachments: [signed({ url: '' })] }, { base, signedBase, fetch: none, now: () => 0 })).text).toContain('no longer available')
      expect(none).not.toHaveBeenCalled()
    })

    it('lets a slow download that started in time finish after its link ends', async () => {
      // Storage checks a signed link when the request starts (fileLinks.ts): the bytes keep coming after expiresAt.
      let clock = 0
      const chunk = new Uint8Array(64 * 1024)
      const slow = vi.fn(async () => new Response(new ReadableStream<Uint8Array>({ async pull(controller) {
        clock += 60_000
        await new Promise(resolve => setTimeout(resolve, 1))
        if (clock > 16 * 60_000) { controller.close(); return }
        controller.enqueue(chunk)
      } })))
      const relink = fresh()
      const big = signed({ size: 16 * chunk.byteLength, expiresAt: 5 * 60_000 })
      const listed = await attachedFiles({ attachments: [big] }, { base, signedBase, fetch: slow, now: () => clock, relink, idleMs: 60_000 })
      expect(listed.complete).toBe(true)
      expect(clock).toBeGreaterThan(big.expiresAt as number)
      expect([slow.mock.calls.length, relink.mock.calls.length]).toEqual([1, 0])
    })

    it('shares one download of a file between deliveries whose links differ', async () => {
      const inFlight = new Map()
      const fetcher = replying(new Uint8Array(5))
      const [one, two] = await Promise.all([
        attachedFiles({ attachments: [signed()] }, { base, signedBase, fetch: fetcher, now: () => 0, inFlight }),
        attachedFiles({ attachments: [signed({ url: `${signedBase}/bucket/super-tabs/tab/abc/screen.png?X-Goog-Signature=other` })] },
          { base, signedBase, fetch: fetcher, now: () => 0, inFlight })])
      expect([one.complete, two.complete]).toEqual([true, true])
      expect(fetcher).toHaveBeenCalledTimes(1)
    })

    it('reads a file\'s link expiry, and nothing else it does not know', () => {
      expect(attachmentsOf({ attachments: [{ ...signed(), extra: 'x' }, { ...file(), expiresAt: 'soon' }] }))
        .toEqual([signed(), file()])
    })
  })
})
