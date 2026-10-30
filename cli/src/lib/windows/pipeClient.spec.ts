import { randomBytes } from 'node:crypto'
import http from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { listenLocalSocket } from '../localSocket.js'
import { newPipePath } from './pipeAuth.js'
import { pipeAbsent, pipeRequest, PipeUnproven } from './pipeClient.js'

const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })

function endpoint(): string {
  if (process.platform === 'win32') return newPipePath()
  const dir = mkdtempSync('/tmp/hpipe-')
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
  return join(dir, `harness-${randomBytes(16).toString('hex')}`)
}

describe('pipeRequest', () => {
  it('sends the request with its auth and returns the answer once the daemon has proven itself', async () => {
    const pipe = endpoint(), token = randomBytes(32)
    let got = ''
    const server = await listenLocalSocket((req, res) => {
      let body = ''
      req.setEncoding('utf8')
      req.on('data', (chunk: string) => { body += chunk })
      req.on('end', () => { got = `${req.method} ${req.url} ${req.headers['content-type']} ${body}`; res.writeHead(201, { 'content-type': 'application/json' }); res.end('{"ok":true}') })
    }, pipe, { token })
    cleanup.push(server.close)
    const reply = await pipeRequest({ pipe, token }, { method: 'POST', path: '/api/pair', headers: { 'content-type': 'application/json' }, body: '{"code":"x"}' })
    expect(reply.status).toBe(201)
    expect(reply.body).toBe('{"ok":true}')
    expect(reply.headers['content-type']).toBe('application/json')
    expect(got).toBe('POST /api/pair application/json {"code":"x"}')
  })

  it('rejects an answer without the proof: another token\'s daemon, or whatever took the name', async () => {
    const pipe = endpoint(), token = randomBytes(32)
    const daemon = await listenLocalSocket((_req, res) => res.end('{}'), pipe, { token: randomBytes(32) })
    cleanup.push(daemon.close)
    await expect(pipeRequest({ pipe, token }, { method: 'GET', path: '/api/status' })).rejects.toBeInstanceOf(PipeUnproven)
    const squatted = endpoint()
    const squatter = http.createServer((_req, res) => res.end('{"pid":1}'))
    await new Promise<void>((resolve) => squatter.listen(squatted, resolve))
    cleanup.push(() => new Promise<void>((resolve) => squatter.close(() => resolve())))
    const error = await pipeRequest({ pipe: squatted, token }, { method: 'GET', path: '/api/status' }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(PipeUnproven)
    expect((error as PipeUnproven).code).toBe('PIPE_UNPROVEN')
    expect(pipeAbsent(error)).toBe(false)
  })

  it('says when nothing listens there, and refuses an answer past its size', async () => {
    const error = await pipeRequest({ pipe: endpoint(), token: randomBytes(32) }, { method: 'GET', path: '/' }).catch((e: unknown) => e)
    expect(pipeAbsent(error)).toBe(true)
    const pipe = endpoint(), token = randomBytes(32)
    const server = await listenLocalSocket((_req, res) => res.end('x'.repeat(2048)), pipe, { token })
    cleanup.push(server.close)
    await expect(pipeRequest({ pipe, token }, { method: 'GET', path: '/', maxBytes: 1024 })).rejects.toThrow(/too large/)
  })
})
