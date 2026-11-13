import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Writable } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { UploadAnswer } from '../core/api.js'
import { forwardAttachmentUpload, type AttachmentProxyDeps } from './superTabAttachmentProxy.js'

const servers: http.Server[] = []
const dirs: string[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map(s => new Promise(resolve => s.close(resolve))))
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
const fresh = () => {
  const dir = mkdtempSync(join(tmpdir(), 'attachments-'))
  dirs.push(dir)
  return dir
}

const BOUNDARY = 'harness-test'
const TYPE = `multipart/form-data; boundary=${BOUNDARY}`
const PATH = '/api/super-tabs/tab-1/attachments'
const ANSWERED = { status: 200, body: JSON.stringify({ success: true, data: { attachment: { id: 'f1' } } }), contentType: 'application/json; charset=utf-8' }

/** The gateway's send, standing in: what it was handed, and the file's bytes as they were when it was. */
function gateway(answer: UploadAnswer = ANSWERED) {
  const sent: Array<{ request: { file: string; path: string; contentType: string }; bytes: Buffer }> = []
  const upload = vi.fn(async (request: { file: string; path: string; contentType: string }) => {
    sent.push({ request, bytes: readFileSync(request.file) })
    return answer
  })
  return { upload, sent }
}

/** A daemon route that hands every request to the door's side, and the URL to reach it. */
async function daemon(deps: Partial<AttachmentProxyDeps> & Pick<AttachmentProxyDeps, 'upload'>) {
  const folder = deps.folder ?? join(fresh(), 'uploads')
  const server = http.createServer((req, res) => { void forwardAttachmentUpload(req, res, PATH, { folder, ...deps }) })
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/`, folder }
}

/** Sends `parts` one write at a time, waiting on `between` after each but the last. */
function upload(url: string, parts: Buffer[], headers: Record<string, string> = { 'content-type': TYPE }, between?: () => Promise<void>) {
  return new Promise<{ status: number; body: string; type?: string }>((resolve, reject) => {
    const req = http.request(url, { method: 'POST', headers }, res => {
      let body = ''
      res.setEncoding('utf8').on('data', chunk => { body += chunk }).on('end', () => resolve({ status: res.statusCode!, body, type: res.headers['content-type'] }))
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

describe('a Swarm chat file, taken in by the core', () => {
  // The core audit of 2026-11-12: the core calls no other host. Until then this streamed the file to the backend itself.
  it('keeps the whole file in its private folder, has the gateway send it, hands back the answer as it came, and keeps nothing', async () => {
    const g = gateway()
    const { url, folder } = await daemon({ upload: g.upload })
    const parts = [Buffer.from(`--${BOUNDARY}\r\n`), Buffer.alloc(512 * 1024, 7), Buffer.from(`\r\n--${BOUNDARY}--\r\n`)]
    const answer = await upload(url, parts)
    expect(answer).toEqual({ status: 200, body: ANSWERED.body, type: ANSWERED.contentType })
    expect(g.sent).toHaveLength(1)
    expect(g.sent[0]!.request).toMatchObject({ path: PATH, contentType: TYPE })
    expect(g.sent[0]!.request.file.startsWith(`${folder}/`)).toBe(true)
    expect(g.sent[0]!.bytes.equals(Buffer.concat(parts))).toBe(true)
    // This account's alone, and the file gone with the answer.
    expect(statSync(folder).mode & 0o777).toBe(0o700)
    expect(readdirSync(folder)).toEqual([])
  })

  it('passes the backend\'s refusal through with its status and body', async () => {
    const refused = { status: 403, body: JSON.stringify({ success: false, error: { code: 'FORBIDDEN', message: 'Not in this conversation.' } }), contentType: 'application/json' }
    const { url } = await daemon({ upload: gateway(refused).upload })
    expect(await upload(url, [Buffer.from('--x--')])).toEqual({ status: 403, body: refused.body, type: 'application/json' })
  })

  it('says, as the core said it when it sent the file itself, why the gateway sent nothing', async () => {
    for (const [error, status, code] of [['NOT_SIGNED_IN', 401, 'NOT_SIGNED_IN'], ['BACKEND_UNREACHABLE', 502, 'BACKEND_UNREACHABLE'],
      ['BACKEND_TIMEOUT', 504, 'BACKEND_TIMEOUT'], ['INVALID_UPLOAD', 500, 'ATTACHMENT_NOT_SENT'], ['GATEWAY_UNAVAILABLE', 503, 'GATEWAY_UNAVAILABLE']] as const) {
      const { url, folder } = await daemon({ upload: gateway({ error }).upload })
      const answer = await upload(url, [Buffer.from('--x--')])
      expect([answer.status, JSON.parse(answer.body).error.code], error).toEqual([status, code])
      expect(readdirSync(folder)).toEqual([])
    }
  })

  it('refuses a body over the cap, declared or streamed, and sends nothing on', async () => {
    const declared = gateway()
    const { url } = await daemon({ upload: declared.upload, maxBytes: 1024 })
    const big = await upload(url, [Buffer.alloc(2048)], { 'content-type': TYPE, 'content-length': '2048' })
    expect([big.status, JSON.parse(big.body).error.code]).toEqual([413, 'ATTACHMENT_TOO_LARGE'])
    expect(declared.upload).not.toHaveBeenCalled()

    const streamed = gateway()
    const chunked = await daemon({ upload: streamed.upload, maxBytes: 1024 })
    const over = await upload(chunked.url, [Buffer.alloc(600), Buffer.alloc(600)], { 'content-type': TYPE, 'transfer-encoding': 'chunked' })
    expect(over.status).toBe(413)
    expect(streamed.upload).not.toHaveBeenCalled()
    expect(readdirSync(chunked.folder)).toEqual([])

    const fits = gateway()
    expect((await upload((await daemon({ upload: fits.upload, maxBytes: 1024 })).url, [Buffer.alloc(1024)])).status).toBe(200)
  })

  it('keeps a slow upload going while bytes move, and ends one that stalls', async () => {
    const steady = gateway()
    const { url } = await daemon({ upload: steady.upload, idleMs: 200 })
    // Four pauses of 120 ms: longer than the idle window in all, never quiet for 200 ms at once.
    let pauses = 0
    const parts = Array.from({ length: 5 }, () => Buffer.alloc(1024, 1))
    const slow = await upload(url, parts, { 'content-type': TYPE }, () => new Promise(resolve => { pauses++; setTimeout(resolve, 120) }))
    expect([slow.status, pauses]).toEqual([200, 4])
    expect(steady.sent[0]!.bytes.byteLength).toBe(5 * 1024)

    const stalled = gateway()
    const quiet = await daemon({ upload: stalled.upload, idleMs: 100 })
    const answer = await upload(quiet.url, [Buffer.alloc(10), Buffer.alloc(10)], { 'content-type': TYPE }, () => new Promise(resolve => setTimeout(resolve, 400)))
    // The sender stalled, not the backend (review, 2026-11-13): said so.
    expect([answer.status, JSON.parse(answer.body).error.code]).toEqual([408, 'ATTACHMENT_STALLED'])
    expect(stalled.upload).not.toHaveBeenCalled()
    expect(readdirSync(quiet.folder)).toEqual([])
  })

  it('takes multipart only', async () => {
    const g = gateway()
    const json = await upload((await daemon({ upload: g.upload })).url, [Buffer.from('{}')], { 'content-type': 'application/json' })
    expect([json.status, JSON.parse(json.body).error.code]).toEqual([400, 'INVALID_ATTACHMENT'])
    expect(g.upload).not.toHaveBeenCalled()
  })

  // Another account's folder, or a link in its place, would have its file read or written elsewhere.
  it('keeps no file in a folder that is not this account\'s alone', async () => {
    const root = fresh()
    const elsewhere = join(root, 'elsewhere')
    mkdirSync(elsewhere)
    const folder = join(root, 'uploads')
    symlinkSync(elsewhere, folder)
    const g = gateway()
    const answer = await upload((await daemon({ upload: g.upload, folder })).url, [Buffer.from('--x--')])
    expect([answer.status, JSON.parse(answer.body).error.code]).toEqual([500, 'ATTACHMENT_FOLDER'])
    expect(g.upload).not.toHaveBeenCalled()
    expect(readdirSync(elsewhere)).toEqual([])
    expect(lstatSync(folder).isSymbolicLink()).toBe(true)
  })

  // A process cut off mid-upload leaves its file: the next one to take an upload deletes it first, once.
  it('deletes what a process before it left in the folder, once', async () => {
    const folder = join(fresh(), 'uploads')
    mkdirSync(folder, { mode: 0o700 })
    writeFileSync(join(folder, 'left-by-a-crash'), 'x')
    const g = gateway()
    const { url } = await daemon({ upload: g.upload, folder })
    expect((await upload(url, [Buffer.from('--x--')])).status).toBe(200)
    expect(existsSync(join(folder, 'left-by-a-crash'))).toBe(false)
    // Once: a file there afterwards is this process's own (another upload under way), never swept.
    writeFileSync(join(folder, 'under-way'), 'y')
    expect((await upload(url, [Buffer.from('--x--')])).status).toBe(200)
    expect(existsSync(join(folder, 'under-way'))).toBe(true)
  })

  // The review of 2026-11-13: a body past the cap was torn down under the sender, which heard a broken pipe, not the 413.
  it('reads a body past the cap to its end, so the sender hears why, and keeps none of it', async () => {
    const g = gateway()
    const { url, folder } = await daemon({ upload: g.upload, maxBytes: 64 * 1024 })
    const parts = Array.from({ length: 8 }, () => Buffer.alloc(32 * 1024, 3))
    const answer = await upload(url, parts, { 'content-type': TYPE, 'transfer-encoding': 'chunked' }, () => new Promise(resolve => setImmediate(resolve)))
    expect([answer.status, JSON.parse(answer.body).error.code]).toEqual([413, 'ATTACHMENT_TOO_LARGE'])
    expect(g.upload).not.toHaveBeenCalled()
    expect(readdirSync(folder)).toEqual([])
  })

  // Every upload under way keeps its file until the gateway has sent it: together they are held to a budget on disk.
  it('tells an upload past what may be kept on disk at once to try again, and keeps the others going', async () => {
    let release: () => void = () => {}
    const held = new Promise<void>(resolve => { release = resolve })
    const upload1 = vi.fn(async (_request: { file: string; path: string; contentType: string }) => { await held; return ANSWERED })
    const { url } = await daemon({ upload: upload1, keptMaxBytes: 1500 })
    const first = upload(url, [Buffer.alloc(1000)])
    await vi.waitFor(() => expect(upload1).toHaveBeenCalledOnce())
    // 1000 kept for the first while the gateway sends it: 1000 more is past 1500.
    const second = await upload(url, [Buffer.alloc(1000)])
    expect([second.status, JSON.parse(second.body).error.code]).toEqual([429, 'ATTACHMENTS_BUSY'])
    release()
    expect((await first).status).toBe(200)
    // Sent and gone: there is room again.
    expect((await upload(url, [Buffer.alloc(1000)])).status).toBe(200)
  })

  it('says a disk that would not keep the file, and logs why', async () => {
    const log = vi.fn()
    const full = () => new Writable({ write(_chunk, _encoding, done) { done(Object.assign(new Error('no space left on device'), { code: 'ENOSPC' })) } })
    const g = gateway()
    const answer = await upload((await daemon({ upload: g.upload, keep: full, log })).url, [Buffer.from('--x--')])
    expect([answer.status, JSON.parse(answer.body).error.code]).toEqual([507, 'ATTACHMENT_NOT_KEPT'])
    expect(log.mock.calls.some(([line]) => String(line).includes('ENOSPC'))).toBe(true)
    expect(g.upload).not.toHaveBeenCalled()
  })

  it('answers nobody whose sender went away, sends nothing, and keeps nothing', async () => {
    const g = gateway()
    const { url, folder } = await daemon({ upload: g.upload })
    await new Promise<void>((resolve) => {
      const req = http.request(url, { method: 'POST', headers: { 'content-type': TYPE, 'content-length': '4096' } })
      req.on('error', () => resolve())
      req.write(Buffer.alloc(1024))
      setTimeout(() => { req.destroy(); resolve() }, 50)
    })
    await vi.waitFor(() => expect(readdirSync(folder)).toEqual([]))
    expect(g.upload).not.toHaveBeenCalled()
  })

  // A leftover the sweep cannot remove is said, once, and the upload goes on.
  it('logs a leftover it cannot remove, and takes the upload all the same', { skip: process.geteuid?.() === 0 }, async () => {
    const folder = join(fresh(), 'uploads')
    mkdirSync(join(folder, 'stuck'), { recursive: true, mode: 0o700 })
    writeFileSync(join(folder, 'stuck', 'inside'), 'x')
    chmodSync(join(folder, 'stuck'), 0o500)
    try {
      const log = vi.fn()
      const g = gateway()
      expect((await upload((await daemon({ upload: g.upload, folder, log })).url, [Buffer.from('--x--')])).status).toBe(200)
      expect(log.mock.calls.some(([line]) => String(line).includes('could not be removed'))).toBe(true)
    } finally {
      chmodSync(join(folder, 'stuck'), 0o700)
    }
  })

  it('logs to the console when it is given no log', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const full = () => new Writable({ write(_chunk, _encoding, done) { done(new Error('broken disk')) } })
      const answer = await upload((await daemon({ upload: gateway().upload, keep: full })).url, [Buffer.from('--x--')])
      expect(answer.status).toBe(507)
      expect(warn).toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })
})

