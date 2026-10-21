import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { forwardAttachmentUpload, type AttachmentProxyDeps } from './superTabAttachmentProxy.js'

const servers: http.Server[] = []
afterEach(async () => { await Promise.all(servers.splice(0).map(s => new Promise(resolve => s.close(resolve)))) })

const BOUNDARY = 'harness-test'
const TYPE = `multipart/form-data; boundary=${BOUNDARY}`

/** A daemon route that hands every request to the pass-through, and the URL to reach it. */
async function daemon(deps: Partial<AttachmentProxyDeps> & Pick<AttachmentProxyDeps, 'fetch'>) {
  const server = http.createServer((req, res) => {
    void forwardAttachmentUpload(req, res, '/api/super-tabs/tab-1/attachments',
      { accessToken: async () => 'token', environment: 'prod', base: 'https://backend.test', ...deps })
  })
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/`
}

/** Sends `parts` one write at a time, waiting on `between` after each but the last. */
function upload(url: string, parts: Buffer[], headers: Record<string, string> = { 'content-type': TYPE }, between?: () => Promise<void>) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = http.request(url, { method: 'POST', headers }, res => {
      let body = ''
      res.setEncoding('utf8').on('data', chunk => { body += chunk }).on('end', () => resolve({ status: res.statusCode!, body }))
    })
    req.on('error', reject)
    void (async () => {
      for (const [index, part] of parts.entries()) {
        req.write(part)
        if (index < parts.length - 1) await between?.()
      }
      req.end()
    })()
  })
}

/** A backend that reads the whole forwarded body and answers `status` with `body`. */
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

describe('Super Tab attachment pass-through', () => {
  it('streams the body on with the account token and hands back the backend answer as it came', async () => {
    let firstArrived: () => void = () => {}
    const arrived = new Promise<void>(resolve => { firstArrived = resolve })
    const received: Buffer[] = []
    let init: RequestInit | undefined
    const fetch = vi.fn(async (_url: string | URL | Request, options?: RequestInit) => {
      init = options
      for await (const chunk of options!.body as unknown as AsyncIterable<Uint8Array>) { received.push(Buffer.from(chunk)); firstArrived() }
      return new Response(JSON.stringify({ success: true, data: { attachment: { id: 'f1' } } }), { status: 200, headers: { 'content-type': 'application/json' } })
    })
    const url = await daemon({ fetch: fetch as unknown as typeof globalThis.fetch })
    const parts = [Buffer.from(`--${BOUNDARY}\r\n`), Buffer.alloc(512 * 1024, 7), Buffer.from(`\r\n--${BOUNDARY}--\r\n`)]
    // The second part is written only after the backend has read the first: the body is not held whole.
    const answer = await upload(url, parts, { 'content-type': TYPE }, () => arrived)
    expect(answer).toEqual({ status: 200, body: JSON.stringify({ success: true, data: { attachment: { id: 'f1' } } }) })
    expect(Buffer.concat(received).equals(Buffer.concat(parts))).toBe(true)
    expect(fetch).toHaveBeenCalledWith('https://backend.test/api/super-tabs/tab-1/attachments', expect.anything())
    expect(init).toMatchObject({ method: 'POST', duplex: 'half',
      headers: { authorization: 'Bearer token', 'x-autonomous-env': 'prod', 'content-type': TYPE } })
  })

  it('passes a refusal through with its status and body', async () => {
    const refused = { success: false, error: { code: 'FORBIDDEN', message: 'Not in this conversation.' } }
    const b = backend(403, refused)
    const answer = await upload(await daemon({ fetch: b.fetch }), [Buffer.from('--x--')])
    expect(answer).toEqual({ status: 403, body: JSON.stringify(refused) })
  })

  it('refuses a body over the cap, declared or streamed, without passing on more than the cap', async () => {
    const declared = backend()
    const url = await daemon({ fetch: declared.fetch, maxBytes: 1024 })
    const big = await upload(url, [Buffer.alloc(2048)], { 'content-type': TYPE, 'content-length': '2048' })
    expect(big.status).toBe(413)
    expect(JSON.parse(big.body).error.code).toBe('ATTACHMENT_TOO_LARGE')
    expect(declared.calls).not.toHaveBeenCalled()

    const streamed = backend()
    const chunked = await upload(await daemon({ fetch: streamed.fetch, maxBytes: 1024 }), [Buffer.alloc(600), Buffer.alloc(600)],
      { 'content-type': TYPE, 'transfer-encoding': 'chunked' })
    expect(chunked.status).toBe(413)
    expect(Buffer.concat(streamed.received).byteLength).toBeLessThanOrEqual(1024)

    const fits = backend()
    expect((await upload(await daemon({ fetch: fits.fetch, maxBytes: 1024 }), [Buffer.alloc(1024)])).status).toBe(200)
  })

  it('keeps a slow upload going while bytes move, and ends one that stalls', async () => {
    const steady = backend()
    const url = await daemon({ fetch: steady.fetch, idleMs: 200 })
    // Four pauses of 120 ms: longer than the idle window in all, never quiet for 200 ms at once.
    let pauses = 0
    const parts = Array.from({ length: 5 }, () => Buffer.alloc(1024, 1))
    const slow = await upload(url, parts, { 'content-type': TYPE }, () => new Promise(resolve => { pauses++; setTimeout(resolve, 120) }))
    expect([slow.status, pauses]).toEqual([200, 4])
    expect(Buffer.concat(steady.received).byteLength).toBe(5 * 1024)

    const stalled = backend()
    const quiet = await upload(await daemon({ fetch: stalled.fetch, idleMs: 100 }), [Buffer.alloc(10), Buffer.alloc(10)],
      { 'content-type': TYPE }, () => new Promise(resolve => setTimeout(resolve, 400)))
    expect([quiet.status, JSON.parse(quiet.body).error.code]).toEqual([504, 'BACKEND_TIMEOUT'])
  })

  it('takes multipart only, and says so when the account or the backend cannot be reached', async () => {
    const b = backend()
    const url = await daemon({ fetch: b.fetch })
    const json = await upload(url, [Buffer.from('{}')], { 'content-type': 'application/json' })
    expect([json.status, JSON.parse(json.body).error.code]).toEqual([400, 'INVALID_ATTACHMENT'])
    expect(b.calls).not.toHaveBeenCalled()

    const signedOut = await upload(await daemon({ fetch: b.fetch, accessToken: async () => { throw new Error('signed out') } }), [Buffer.from('--x--')])
    expect([signedOut.status, JSON.parse(signedOut.body).error.code]).toEqual([401, 'NOT_SIGNED_IN'])

    const down = await upload(await daemon({ fetch: (async () => { throw new TypeError('fetch failed') }) as unknown as typeof fetch }), [Buffer.from('--x--')])
    expect([down.status, JSON.parse(down.body).error.code]).toEqual([502, 'BACKEND_UNREACHABLE'])

    const slow = await upload(await daemon({ fetch: (async () => { throw Object.assign(new Error('timed out'), { name: 'TimeoutError' }) }) as unknown as typeof fetch }), [Buffer.from('--x--')])
    expect([slow.status, JSON.parse(slow.body).error.code]).toEqual([504, 'BACKEND_TIMEOUT'])
  })
})
