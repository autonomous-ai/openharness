import { mkdtempSync, rmSync, symlinkSync, truncateSync, unlinkSync, writeFileSync } from 'node:fs'
import { execFile, execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, expect, it, vi } from 'vitest'

/** A name swapped while it is checked: right after it was opened, before its real path is read. */
const swap = vi.hoisted(() => ({ at: '', to: '', move: '' }))
vi.mock('node:fs', async original => {
  const fs = await original<typeof import('node:fs')>()
  const native = (path: Parameters<typeof fs.realpathSync.native>[0]) => {
    if (swap.at && path === swap.at) {
      if (swap.move) fs.renameSync(swap.at, swap.move)
      else fs.unlinkSync(swap.at)
      fs.symlinkSync(swap.to, swap.at)
      swap.at = ''
    }
    return fs.realpathSync.native(path)
  }
  const realpathSync = Object.assign((...args: Parameters<typeof fs.realpathSync>) => fs.realpathSync(...args), { native })
  return { ...fs, default: { ...fs, realpathSync }, realpathSync }
})
const { readInsideFolder, uploadAttachments } = await import('./attach.js')
const { loadOrCreateHookCredential } = await import('../lib/hookAuth.js')

const made: string[] = []
afterEach(() => { for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true }) })
const dir = (prefix: string) => { const path = mkdtempSync(join(tmpdir(), prefix)); made.push(path); return path }

it('reads a file inside the folder whole, by its own name and type', () => {
  const folder = dir('buddy-folder-')
  writeFileSync(join(folder, 'plan.md'), '# Plan\n')
  expect(readInsideFolder([join(folder, 'plan.md')], folder)).toEqual([{ name: 'plan.md', type: 'text/markdown', bytes: Buffer.from('# Plan\n') }])
})

it('refuses a name swapped for a link out of the folder between opening it and checking where it is', () => {
  const folder = dir('buddy-folder-'), outside = dir('buddy-outside-')
  writeFileSync(join(folder, 'plan.md'), '# Plan\n')
  writeFileSync(join(outside, 'secret.txt'), 'outside bytes')
  Object.assign(swap, { at: join(folder, 'plan.md'), to: join(outside, 'secret.txt') })
  expect(() => readInsideFolder([join(folder, 'plan.md')], folder)).toThrow('is outside your folder')
  // The opened file moved out with its one name, and the name now leads to another file inside: the file opened is not
  // the one named.
  unlinkSync(join(folder, 'plan.md'))
  writeFileSync(join(folder, 'plan.md'), '# Plan\n')
  writeFileSync(join(folder, 'other.md'), '# Other\n')
  Object.assign(swap, { at: join(folder, 'plan.md'), to: join(folder, 'other.md'), move: join(outside, 'moved.md') })
  expect(() => readInsideFolder([join(folder, 'plan.md')], folder)).toThrow('is outside your folder')
})

it('refuses a link as the last name, a folder inside, and a file over the limit', () => {
  const folder = dir('buddy-folder-')
  writeFileSync(join(folder, 'plan.md'), '# Plan\n')
  symlinkSync(join(folder, 'plan.md'), join(folder, 'alias.md'))
  expect(() => readInsideFolder([join(folder, 'alias.md')], folder)).toThrow('is outside your folder')
  expect(() => readInsideFolder([folder.concat('/')], folder)).toThrow('is outside your folder')
  // A Buddy's files are read whole, so they keep the 10 MB of the form upload they go by, whatever a chat file may be.
  writeFileSync(join(folder, 'big.bin'), '')
  truncateSync(join(folder, 'big.bin'), 10 * 1024 * 1024 + 1)
  expect(() => readInsideFolder([join(folder, 'big.bin')], folder)).toThrow('over the 10.0 MB limit')
})

const MiB = 1024 * 1024
/** A file of [size] bytes that takes no room: sparse, never a buffer that large. */
const sparse = (folder: string, name: string, size: number) => { const path = join(folder, name); writeFileSync(path, ''); truncateSync(path, size); return path }
const sent = () => vi.fn(async (_payload: Record<string, unknown>) => ({ ok: true, value: { agentId: 'agent-1', attachmentIds: null } }))
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const SIGNED = { 'content-type': 'application/octet-stream', 'content-disposition': 'attachment; filename="big.bin"', 'cache-control': 'private, max-age=0',
  'x-goog-content-length-range': `${10 * MiB + 1},${10 * MiB + 1}`, 'x-goog-if-generation-match': '0' }
const STORAGE = 'https://storage.googleapis.com/harness-attachments/super-tabs/tab/u1?X-Goog-Signature=abc'
/** The daemon's two upload routes and storage, as `post --attach` meets them. */
function direct(put = () => new Response(null, { status: 200 })) {
  return vi.fn(async (url: string, init?: RequestInit) => {
    if (url === 'http://127.0.0.1:14001/api/super-tabs/tab/attachments?asAgentId=agent-1') return json({ success: true, data: { attachment: { id: 'form-1' } } })
    if (url === 'http://127.0.0.1:14001/api/super-tabs/tab/attachments/uploads?asAgentId=agent-1') {
      return json({ success: true, data: { upload: { id: 'u1', url: STORAGE, method: 'PUT', headers: SIGNED, expiresAt: Date.now() + 600_000 } } })
    }
    if (url === STORAGE) return put()
    if (url === 'http://127.0.0.1:14001/api/super-tabs/tab/attachments/uploads/u1/complete?asAgentId=agent-1') return json({ success: true, data: { attachment: { id: 'att-1' } } })
    return json({ success: false, error: { code: 'NOT_FOUND', message: `unexpected ${init?.method} ${url}` } }, 404)
  })
}

it('sends a file of up to 10 MB by the form, and a larger one by a link: straight to storage, then complete', async () => {
  const folder = dir('attach-direct-')
  const credential = loadOrCreateHookCredential(folder)
  const target = { tabId: 'tab', conversationId: 'c1', port: 14001, dataDir: folder }
  const small = sparse(folder, 'small.bin', 10 * MiB), big = sparse(folder, 'big.bin', 10 * MiB + 1)
  const fetcher = direct()
  expect(await uploadAttachments([small, big], 'op', target, sent(), fetcher as unknown as typeof fetch)).toEqual(['form-1', 'att-1'])
  expect(fetcher.mock.calls.map(([url, init]) => `${init?.method} ${url.replace(/\?.*/, '')}`)).toEqual([
    'POST http://127.0.0.1:14001/api/super-tabs/tab/attachments',
    'POST http://127.0.0.1:14001/api/super-tabs/tab/attachments/uploads',
    `PUT ${STORAGE.replace(/\?.*/, '')}`,
    'POST http://127.0.0.1:14001/api/super-tabs/tab/attachments/uploads/u1/complete',
  ])
  const [form, link, put, complete] = fetcher.mock.calls.map(([, init]) => init!)
  // 10 MB exactly still goes by the form, as before.
  expect((form!.body as FormData).get('file')).toMatchObject({ name: 'small.bin', size: 10 * MiB })
  // The daemon's calls carry its write gate and local credential, and only those.
  for (const local of [link!, complete!]) expect(local.headers).toEqual({ 'x-adapter-local': '1', 'X-Harness-Local': credential, 'content-type': 'application/json' })
  expect(JSON.parse(String(link!.body))).toEqual({ conversationId: 'c1', name: 'big.bin', mime: 'application/octet-stream', size: 10 * MiB + 1 })
  expect(JSON.parse(String(complete!.body))).toEqual({})
  // Storage gets exactly the signed headers and the length, never a credential: the link is the credential.
  expect(put!.headers).toEqual({ ...SIGNED, 'content-length': String(10 * MiB + 1) })
  expect(put!.body).toBeInstanceOf(Blob)
  expect((put!.body as Blob).size).toBe(10 * MiB + 1)
})

it('says the upload failed when storage refuses it, and completes nothing', async () => {
  const folder = dir('attach-direct-')
  const fetcher = direct(() => new Response('<Error>PreconditionFailed</Error>', { status: 412 }))
  await expect(uploadAttachments([sparse(folder, 'big.bin', 20 * MiB)], 'op', { tabId: 'tab', conversationId: 'c1', port: 14001, dataDir: folder }, sent(),
    fetcher as unknown as typeof fetch)).rejects.toThrow('Could not upload big.bin. Try again.')
  expect(fetcher.mock.calls.map(([url]) => url)).not.toContain('http://127.0.0.1:14001/api/super-tabs/tab/attachments/uploads/u1/complete?asAgentId=agent-1')
})

// Security review of the PR: the link is the credential, and a redirect would send the file somewhere else with its headers.
it('never follows a redirect from storage: the upload fails and the other address is never asked', async () => {
  const folder = dir('attach-direct-')
  const elsewhere = 'https://elsewhere.example.test/take'
  const base = direct(() => new Response(null, { status: 307, headers: { location: elsewhere } }))
  // As fetch does: a redirect refused when told so, else followed.
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    const answer = await base(url, init)
    if (answer.status < 300 || answer.status >= 400) return answer
    if (init?.redirect === 'error') throw new TypeError('fetch failed: unexpected redirect')
    return base(answer.headers.get('location')!, init).then(() => new Response(null, { status: 200 }))
  })
  await expect(uploadAttachments([sparse(folder, 'big.bin', 20 * MiB)], 'op', { tabId: 'tab', conversationId: 'c1', port: 14001, dataDir: folder }, sent(),
    fetcher as unknown as typeof fetch)).rejects.toThrow('Could not upload big.bin. Try again.')
  expect(base.mock.calls.map(([url]) => url)).not.toContain(elsewhere)
  expect(base.mock.calls.map(([url]) => url)).not.toContain('http://127.0.0.1:14001/api/super-tabs/tab/attachments/uploads/u1/complete?asAgentId=agent-1')
})

it('names the daemon\'s refusal of a link, as the backend said it', async () => {
  const folder = dir('attach-direct-')
  const fetcher = vi.fn(async () => json({ success: false, error: { code: 'ATTACHMENTS_UNAVAILABLE', message: 'Files over 10 MB cannot be sent right now.' } }, 503))
  await expect(uploadAttachments([sparse(folder, 'big.bin', 20 * MiB)], 'op', { tabId: 'tab', conversationId: 'c1', port: 14001, dataDir: folder }, sent(),
    fetcher as unknown as typeof fetch)).rejects.toThrow('Files over 10 MB cannot be sent right now.')
  expect(fetcher).toHaveBeenCalledTimes(1)
})

it('says to restart Harness when its daemon is older than the link route', async () => {
  const folder = dir('attach-direct-')
  const fetcher = vi.fn(async () => json({ error: 'not found' }, 404))
  await expect(uploadAttachments([sparse(folder, 'big.bin', 20 * MiB)], 'op', { tabId: 'tab', conversationId: 'c1', port: 14001, dataDir: folder }, sent(),
    fetcher as unknown as typeof fetch)).rejects.toThrow('big.bin is over 10 MB, which this computer\'s Harness cannot send yet. Restart Harness and try again.')
})

it('refuses a file over 256 MB before any request', async () => {
  const folder = dir('attach-direct-')
  const request = sent(), fetcher = direct()
  await expect(uploadAttachments([sparse(folder, 'small.bin', 5), sparse(folder, 'huge.bin', 256 * MiB + 1)], 'op',
    { tabId: 'tab', conversationId: 'c1', port: 14001, dataDir: folder }, request, fetcher as unknown as typeof fetch))
    .rejects.toThrow(`huge.bin is over the 256 MB limit (${256 * MiB + 1} bytes).`)
  expect(request).not.toHaveBeenCalled()
  expect(fetcher).not.toHaveBeenCalled()
})

// Run apart: a blocking open stops the whole process, which no test timeout in it can end (re-check of #2103).
it.skipIf(process.platform === 'win32')('refuses a named pipe and the terminal\'s input without waiting on them', async () => {
  const folder = dir('buddy-folder-')
  execFileSync('mkfifo', [join(folder, 'pipe.md')])
  const script = `
    const { readInsideFolder } = await import(${JSON.stringify(new URL('./attach.ts', import.meta.url).pathname)})
    const tried = (path) => { try { readInsideFolder([path], process.argv[1]); return 'read' } catch (error) { return error.message } }
    console.log(JSON.stringify([tried(process.argv[2]), tried('/dev/stdin')]))
  `
  const { stdout } = await promisify(execFile)(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script, folder, join(folder, 'pipe.md')],
    { timeout: 15_000 })
  expect(JSON.parse(stdout.trim())).toEqual([`${join(folder, 'pipe.md')} is not a file.`, expect.stringContaining('/dev/stdin is outside your folder')])
}, 20_000)
