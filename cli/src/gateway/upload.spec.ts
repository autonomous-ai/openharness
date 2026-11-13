import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { UPLOAD_ANSWER_MAX_BYTES, uploadToBackend, type UploadDeps } from './upload.js'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

const TYPE = 'multipart/form-data; boundary=harness-test'
const PATH = '/api/super-tabs/tab-1/attachments'

/** The uploads folder with one file in it, as the core leaves it (lib/superTabAttachmentProxy.ts). */
function kept(bytes: Buffer = Buffer.from('--harness-test--')) {
  const root = mkdtempSync(join(tmpdir(), 'gateway-upload-'))
  dirs.push(root)
  const folder = join(root, 'uploads')
  mkdirSync(folder, { mode: 0o700 })
  const file = join(folder, 'f1')
  writeFileSync(file, bytes)
  return { root, folder, file }
}

/** A backend that reads the whole body it is sent and answers `status` with `body`. */
function backend(status = 200, body: unknown = { success: true, data: { attachment: { id: 'f1' } } }) {
  const received: Buffer[] = []
  const seen: Array<{ url: string; init: RequestInit }> = []
  const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    seen.push({ url: String(url), init: init! })
    // As real fetch does: an abort ends the upload with the signal's reason.
    const aborted = new Promise<never>((_, reject) => init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true }))
    await Promise.race([aborted, (async () => {
      for await (const chunk of init!.body as unknown as AsyncIterable<Uint8Array>) received.push(Buffer.from(chunk))
    })()])
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8' } })
  })
  return { fetch: fetch as unknown as typeof globalThis.fetch, calls: fetch, received, seen }
}

const deps = (over: Partial<UploadDeps> & Pick<UploadDeps, 'folder'>): UploadDeps =>
  ({ tokens: { accessToken: async () => 'token' }, environment: 'prod', base: 'https://backend.test', ...over })

// The core audit of 2026-11-12: the gateway sends a Swarm chat file to the backend, and the core calls no other host.
describe('a file the core kept, sent to the backend by the gateway', () => {
  it('streams it on with the account\'s token and hands back the backend\'s answer as it came', async () => {
    const bytes = Buffer.concat([Buffer.from('--harness-test\r\n'), Buffer.alloc(512 * 1024, 7), Buffer.from('\r\n--harness-test--\r\n')])
    const { folder, file } = kept(bytes)
    const b = backend()
    expect(await uploadToBackend({ file, path: `${PATH}?asAgentId=agent-1`, contentType: TYPE }, deps({ folder, fetch: b.fetch }))).toEqual({
      status: 200, body: JSON.stringify({ success: true, data: { attachment: { id: 'f1' } } }), contentType: 'application/json; charset=utf-8',
    })
    expect(Buffer.concat(b.received).equals(bytes)).toBe(true)
    expect(b.seen[0]).toMatchObject({ url: `https://backend.test${PATH}?asAgentId=agent-1`, init: { method: 'POST', duplex: 'half',
      headers: { authorization: 'Bearer token', 'x-autonomous-env': 'prod', 'content-type': TYPE } } })
  })

  it('passes a refusal through with its status and body', async () => {
    const { folder, file } = kept()
    const refused = { success: false, error: { code: 'FORBIDDEN', message: 'Not in this conversation.' } }
    expect(await uploadToBackend({ file, path: PATH, contentType: TYPE }, deps({ folder, fetch: backend(403, refused).fetch })))
      .toMatchObject({ status: 403, body: JSON.stringify(refused) })
  })

  // Only the Swarm's attachment route, as multipart, of a file in the uploads folder, never through a link.
  it('sends nothing to another route, of another type, or of a file outside its folder', async () => {
    const { root, folder, file } = kept()
    const outside = join(root, 'outside')
    writeFileSync(outside, 'not an upload')
    const linked = join(folder, 'linked')
    symlinkSync(outside, linked)
    const b = backend()
    for (const request of [
      { file, path: '/api/agent-messages', contentType: TYPE },
      { file, path: `${PATH}/../../../auth/me`, contentType: TYPE },
      { file, path: `${PATH}?asAgentId=a&x=1`, contentType: TYPE },
      { file, path: PATH, contentType: 'application/json' },
      { file: outside, path: PATH, contentType: TYPE },
      { file: linked, path: PATH, contentType: TYPE },
      { file: join(folder, 'missing'), path: PATH, contentType: TYPE },
      { file: folder, path: PATH, contentType: TYPE },
    ]) expect(await uploadToBackend(request, deps({ folder, fetch: b.fetch })), JSON.stringify(request)).toEqual({ error: 'INVALID_UPLOAD' })
    expect(b.calls).not.toHaveBeenCalled()
  })

  it('says when the account or the backend cannot be reached, or the backend does not finish', async () => {
    const { folder, file } = kept()
    const request = { file, path: PATH, contentType: TYPE }
    expect(await uploadToBackend(request, deps({ folder, fetch: backend().fetch, tokens: { accessToken: async () => { throw new Error('signed out') } } })))
      .toEqual({ error: 'NOT_SIGNED_IN' })
    expect(await uploadToBackend(request, deps({ folder, fetch: (async () => { throw new TypeError('fetch failed') }) as unknown as typeof fetch })))
      .toEqual({ error: 'BACKEND_UNREACHABLE' })
    expect(await uploadToBackend(request, deps({ folder, fetch: (async () => { throw Object.assign(new Error('timed out'), { name: 'TimeoutError' }) }) as unknown as typeof fetch })))
      .toEqual({ error: 'BACKEND_TIMEOUT' })
  })

  it('ends an upload whose bytes stop moving, or that takes longer than an upload may', async () => {
    const { folder, file } = kept()
    // A backend that takes the request and never reads its body: no byte moves after the first.
    const stuck = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => new Promise<Response>((_, reject) => {
      init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true })
    }))
    expect(await uploadToBackend({ file, path: PATH, contentType: TYPE }, deps({ folder, fetch: stuck as unknown as typeof fetch, idleMs: 50 })))
      .toEqual({ error: 'BACKEND_TIMEOUT' })
    expect(await uploadToBackend({ file, path: PATH, contentType: TYPE }, deps({ folder, fetch: stuck as unknown as typeof fetch, totalMs: 50 })))
      .toEqual({ error: 'BACKEND_TIMEOUT' })
  })

  it('answers JSON when the backend names no type', async () => {
    const { folder, file } = kept()
    // Bytes, so nothing gives the answer a type of its own.
    const bare = vi.fn(async () => new Response(new TextEncoder().encode('{}'), { status: 200 }))
    const answer = await uploadToBackend({ file, path: PATH, contentType: TYPE }, deps({ folder, fetch: bare as unknown as typeof fetch }))
    expect(answer).toEqual({ status: 200, body: '{}', contentType: 'application/json' })
  })

  // The review of 2026-11-13: a token's wait came before the upload's own limit, so the gateway could still be sending
  // after the core had told the desktop it failed, and a retry posted the file twice.
  it('counts the wait for a token against the whole upload\'s limit', async () => {
    const { folder, file } = kept()
    const b = backend()
    const slowToken = { accessToken: () => new Promise<string>(() => {}) }
    expect(await uploadToBackend({ file, path: PATH, contentType: TYPE }, deps({ folder, fetch: b.fetch, tokens: slowToken, totalMs: 50 })))
      .toEqual({ error: 'BACKEND_TIMEOUT' })
    expect(b.calls).not.toHaveBeenCalled()
  })

  it('takes the agent an agent names, and nothing else after the route', async () => {
    const { folder, file } = kept()
    const b = backend()
    expect(await uploadToBackend({ file, path: `${PATH}?asAgentId=agent_1-x`, contentType: TYPE }, deps({ folder, fetch: b.fetch }))).toMatchObject({ status: 200 })
    for (const path of [`${PATH}?asAgentId=`, `${PATH}?asAgentId=a b`, `${PATH}?other=1`, `${PATH}?asAgentId=a?b`])
      expect(await uploadToBackend({ file, path, contentType: TYPE }, deps({ folder, fetch: b.fetch })), path).toEqual({ error: 'INVALID_UPLOAD' })
  })

  it('passes on no answer past what a small JSON body can be, and says why', async () => {
    const { folder, file } = kept()
    const log = vi.fn()
    const huge = vi.fn(async () => new Response(new Uint8Array(UPLOAD_ANSWER_MAX_BYTES + 1), { status: 200 }))
    expect(await uploadToBackend({ file, path: PATH, contentType: TYPE }, deps({ folder, fetch: huge as unknown as typeof fetch, log })))
      .toEqual({ error: 'BACKEND_UNREACHABLE' })
    expect(log.mock.calls[0]![0]).toContain('over')
    // One with no body at all is an empty one.
    const empty = vi.fn(async () => new Response(null, { status: 204 }))
    expect(await uploadToBackend({ file, path: PATH, contentType: TYPE }, deps({ folder, fetch: empty as unknown as typeof fetch, log })))
      .toEqual({ status: 204, body: '', contentType: 'application/json' })
  })

  it('logs to the console when it is given no log', async () => {
    const { folder, file } = kept()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      expect(await uploadToBackend({ file, path: PATH, contentType: TYPE }, deps({ folder, fetch: (async () => { throw new TypeError('fetch failed') }) as unknown as typeof fetch })))
        .toEqual({ error: 'BACKEND_UNREACHABLE' })
      expect(warn).toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })
})

