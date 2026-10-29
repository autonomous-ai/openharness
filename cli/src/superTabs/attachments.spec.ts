import { readFileSync } from 'node:fs'
import { basename } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { attachedFiles, attachmentsOf, diskName, formatSize, servedFrom } from './attachments.js'

const base = 'https://cdn.example.test'
const file = (over: Record<string, unknown> = {}) => ({ id: 'a1', name: 'screen.png', mime: 'image/png', size: 5, url: `${base}/super-tabs/tab/abc/screen.png`, ...over })
const replying = (bytes: Uint8Array, status = 200) => vi.fn(async () => new Response(bytes, { status }))

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
      .toEqual({ text: `Attached files:\n- Could not download ${file().url} (sent as "screen.png", 5 B): HTTP 503`, complete: false, paths: [] })
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
      .toEqual({ text: `Attached files:\n- Could not download ${file().url} (sent as "screen.png", 5 B): out of time`, complete: false, paths: [] })
  })
  it('fetches only from the public base, and never retries a refusal', async () => {
    const fetcher = replying(new Uint8Array(5))
    const listed = await attachedFiles({ attachments: [file({ url: 'https://evil.example.test/x.png' }), file({ url: 'https://cdn.example.test.evil/x' }),
      file({ url: `${base}/y.png`, size: 3 })] }, { base: `${base}/`, fetch: fetcher })
    expect(listed.text).toContain('- Could not download a file (sent as "screen.png", 5 B): not a Harness file address')
    expect(listed.text).not.toContain('evil')
    expect(listed.text).toContain(`- Could not download ${base}/y.png (sent as "screen.png", 3 B): larger than declared`)
    expect(fetcher).toHaveBeenCalledTimes(1)
    const missing = replying(new Uint8Array(0), 404)
    expect((await attachedFiles({ attachments: [file()] }, { base, fetch: missing })).text).toContain('HTTP 404')
    expect(missing).toHaveBeenCalledTimes(1)
  })
  it('never reads past the 10 MB limit, whatever the message declares', async () => {
    const big = new Uint8Array(10 * 1024 * 1024 + 1)
    expect((await attachedFiles({ attachments: [file({ size: big.byteLength })] }, { base, fetch: replying(big) })).text).toContain('larger than declared')
  })
  it('reads only well-formed attachment rows and formats sizes', async () => {
    expect(attachmentsOf({})).toEqual([])
    expect(attachmentsOf({ attachments: [file(), { name: 'x' }, file({ size: -1 }), 'junk'] })).toEqual([file()])
    expect(await attachedFiles({ text: 'no files' })).toEqual({ text: '', complete: true, paths: [] })
    expect([formatSize(12), formatSize(2048), formatSize(3 * 1024 * 1024)]).toEqual(['12 B', '2.0 KB', '3.0 MB'])
    expect([servedFrom(base, `${base}/a`), servedFrom(`${base}/files`, `${base}/filesx/a`), servedFrom(base, 'not a url'),
      servedFrom(base, `https://user:pw@cdn.example.test/a`)]).toEqual([true, false, false, false])
  })
})
